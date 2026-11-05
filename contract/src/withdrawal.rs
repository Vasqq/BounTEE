//! The Protocol's withdrawal of an unclaimed bounty (R9, R10): after the end date, if no
//! payout was made, the posting Protocol takes back the whole bounty amount.
//!
//! With the payout (`payout`), this is the only way USDC leaves the contract (R2.3). The
//! bounty reads `withdrawn` before the transfer is sent, so no second withdrawal, claim or
//! payout can run beside it; if the token refuses the transfer, the bounty goes back to
//! `live` (ended) with its USDC held, and the Protocol may withdraw again.

use bountee_formats::BountyId;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, NearToken, Promise, PromiseResult};

use crate::claims::CLAIM_PLACE_HOLD_NS;
use crate::payout::ext_ft;
use crate::{emit, fees, gas, BountyState, Contract, ContractExt};

#[near]
impl Contract {
    /// Withdraw the whole amount of the caller's own bounty after its end date. Refused
    /// before the end date (R10.1), once a PAYS verdict has closed the bounty, and while
    /// any claim on it is unresolved (R10.2). Attach the gas `fees()` names as
    /// `min_withdraw_bounty_gas`. The transfer's NEAR comes from the bounty's posting fee;
    /// once that can't cover it, attach the shortfall, which joins the posting fee (R11.4).
    #[payable]
    pub fn withdraw_bounty(&mut self, id: BountyId) -> Promise {
        // The bounty's ID names the account that posted it (R9.2).
        let protocol = env::predecessor_account_id();
        require!(
            protocol.as_str() == id.protocol.as_str(),
            "only the posting Protocol can withdraw its bounty"
        );
        let bounty = self
            .bounties
            .get(&id)
            .unwrap_or_else(|| env::panic_str("no such bounty"));
        match bounty.state {
            BountyState::Live => {}
            BountyState::Withdrawn => env::panic_str("this bounty has already been withdrawn"),
            BountyState::Checking | BountyState::CheckFailed => {
                env::panic_str("this bounty's posting check hasn't passed")
            }
            BountyState::Signing | BountyState::Paying | BountyState::Paid => {
                env::panic_str("this bounty is closed: a claim has won it")
            }
        }
        let now = env::block_timestamp();
        require!(
            now >= bounty.rules.end_date_ns.get(),
            "this bounty hasn't ended"
        );
        // R10.2: a claim whose job is under way may still win, and a claim with no verdict
        // may be retried while it holds its place. A PAYS waiting for its pause signatures
        // has already closed the bounty (`signing`), refused above. A claim whose callback
        // hasn't landed within the stale rule never will: it no longer blocks, and should it
        // land after the withdrawal its verdict can't win (`claim_can_still_win`), so it
        // moves nothing.
        let height = env::block_height();
        let unresolved = bounty.open_claims.iter().any(|(claim_id, submitted)| {
            let running = self.claims.get(claim_id).is_some_and(|c| c.running(height));
            running || now < submitted.saturating_add(CLAIM_PLACE_HOLD_NS)
        });
        require!(
            !unresolved,
            "a claim on this bounty is unresolved: wait for its verdict or for its place to lapse"
        );
        require!(
            Self::gas_left(gas::TAIL) >= gas::payout(),
            "attach more gas: see min_withdraw_bounty_gas in fees()"
        );
        let amount = bounty
            .rules
            .bounty_amount
            .to_u128()
            .expect("checked at posting");

        let bounty = self.bounties.get_mut(&id).expect("read above");
        let one_yocto = NearToken::from_yoctonear(1);
        // The Protocol may have left USDC since posting; its registration and the
        // transfer's yoctoNEAR come from the posting fee, as the payout's would.
        bounty.draw_fee_or_refuse(
            fees::USDC_REGISTRATION.saturating_add(one_yocto),
            "the withdrawal",
        );
        bounty.state = BountyState::Withdrawn;
        let usdc = self.config.usdc.clone();
        ext_ft::ext(usdc.clone())
            .with_attached_deposit(fees::USDC_REGISTRATION)
            .with_static_gas(gas::USDC_STORAGE_DEPOSIT)
            .with_unused_gas_weight(0)
            .storage_deposit(Some(protocol.clone()), Some(true))
            .then(
                ext_ft::ext(usdc)
                    .with_attached_deposit(one_yocto)
                    .with_static_gas(gas::USDC_TRANSFER)
                    .with_unused_gas_weight(0)
                    .ft_transfer(
                        protocol,
                        U128(amount),
                        Some(format!("BounTEE withdrawal, bounty {}", id.name.as_str())),
                    ),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(gas::ON_PAID)
                    .with_unused_gas_weight(0)
                    .on_bounty_withdrawn(id),
            )
    }

    /// After the withdrawal's transfer: done, or, if the token refused it, the bounty is
    /// live again (and ended) with its USDC held, so the Protocol can withdraw again.
    /// Never panics.
    #[private]
    pub fn on_bounty_withdrawn(&mut self, id: BountyId) {
        let Some(bounty) = self.bounties.get_mut(&id) else {
            return;
        };
        if bounty.state != BountyState::Withdrawn {
            return;
        }
        #[allow(deprecated)]
        match env::promise_result(0) {
            PromiseResult::Successful(_) => emit(
                "bounty_withdrawn",
                json!({ "bounty": id, "amount": bounty.rules.bounty_amount }),
            ),
            PromiseResult::Failed => {
                bounty.state = BountyState::Live;
                emit("withdrawal_failed", json!({ "bounty": id }));
            }
        }
    }
}
