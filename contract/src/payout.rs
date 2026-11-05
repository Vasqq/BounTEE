//! The payout of a PAYS verdict: once every pause is signed and stored (`pauses`), the whole
//! bounty is paid to the Whitehat (ADR-0001, R7.1, R3.2) by [`Contract::pay_out`]. If the
//! token refuses the transfer, the bounty stays `paying` with its USDC held, and anyone can
//! [`Contract::retry_payout`] the same transfer to the same Whitehat (R2.4).
//!
//! USDC leaves the contract only here, as the payout (R2.3); the Protocol's withdrawal
//! after the end date (`withdrawal`) is the only other path.

use bountee_formats::BountyId;
use near_sdk::json_types::{U128, U64};
use near_sdk::serde_json::json;
use near_sdk::{
    env, ext_contract, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue,
    PromiseResult,
};

use crate::{emit, fees, gas, BountyState, Contract, ContractExt};

#[ext_contract(ext_ft)]
#[allow(dead_code)]
pub trait FungibleToken {
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near]
impl Contract {
    /// Start the payout of a bounty whose transfer failed (R2.4), or that waited for earlier
    /// claims (R3.6). Anyone may call; it sends the same whole amount to the winning claim's
    /// Whitehat and no one else, and is refused while a transfer is under way, while an
    /// earlier claim still holds its place, or once the bounty is paid, so it never pays
    /// twice or out of order. Attach the gas `fees()` names as `min_retry_payout_gas`. The
    /// payout's NEAR comes from the bounty's posting fee; once that can't cover it, the call
    /// is refused unless it attaches the shortfall, which joins the posting fee (R11.4).
    #[payable]
    pub fn retry_payout(&mut self, id: BountyId) -> Promise {
        let bounty = self
            .bounties
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str("no such bounty"));
        require!(
            bounty.state == BountyState::Paying && !bounty.paying_out,
            "this bounty has no payout waiting for a retry"
        );
        let claim_id = bounty
            .winning_claim
            .unwrap_or_else(|| env::panic_str("this bounty has no winning claim"));
        if let Some(until) = bounty.payout_held_until(claim_id, env::block_timestamp()) {
            env::panic_str(&format!(
                "an earlier claim is still being judged or waiting for its retry; \
                 it holds its place until {until} ns"
            ));
        }
        require!(
            Self::gas_left(gas::TAIL) >= gas::payout(),
            "attach more gas: see min_retry_payout_gas in fees()"
        );
        bounty.add_attached_to_fee();
        self.pay_out(claim_id)
            .unwrap_or_else(|short| crate::refuse_shortfall("the payout", short))
    }

    /// After the winner's USDC registration: on success it is recorded, so no retry pays it
    /// again, and the transfer follows. If it failed, its deposit came back here and goes
    /// back to the posting fee, and the bounty waits for a retry. Never panics, so the
    /// in-flight flag is always cleared.
    #[private]
    pub fn on_winner_registered(&mut self, claim_id: u64) -> PromiseOrValue<()> {
        let Some(claim) = self.claims.get(&claim_id) else {
            return PromiseOrValue::Value(());
        };
        let bounty_id = claim.bounty.clone();
        let Some(bounty) = self.bounties.get_mut(&bounty_id) else {
            return PromiseOrValue::Value(());
        };
        if bounty.state != BountyState::Paying || bounty.winning_claim != Some(claim_id) {
            return PromiseOrValue::Value(());
        }
        #[allow(deprecated)]
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                bounty.registered_winner = Some(claim_id);
                self.transfer_payout(claim_id).into()
            }
            PromiseResult::Failed => {
                bounty.fee_reserve = bounty.fee_reserve.saturating_add(fees::USDC_REGISTRATION);
                bounty.paying_out = false;
                emit(
                    "payout_failed",
                    json!({ "bounty": bounty_id, "claim_id": claim_id }),
                );
                PromiseOrValue::Value(())
            }
        }
    }

    /// After the payout's transfer: the bounty is paid, or, if the transfer failed, stays
    /// `paying` with its USDC still held, waiting for a retry. Never panics, so the
    /// in-flight flag is always cleared.
    #[private]
    pub fn on_paid(&mut self, claim_id: u64) {
        let Some(claim) = self.claims.get(&claim_id) else {
            return;
        };
        let bounty_id = claim.bounty.clone();
        let Some(bounty) = self.bounties.get_mut(&bounty_id) else {
            return;
        };
        if bounty.state != BountyState::Paying || bounty.winning_claim != Some(claim_id) {
            return;
        }
        bounty.paying_out = false;
        #[allow(deprecated)]
        match env::promise_result(0) {
            PromiseResult::Successful(_) => {
                bounty.state = BountyState::Paid;
                // The disclosure delay counts from here (D7, #23).
                bounty.paid_at_ns = Some(env::block_timestamp());
                emit(
                    "bounty_paid",
                    json!({ "bounty": bounty_id, "claim_id": claim_id, "amount": bounty.rules.bounty_amount }),
                );
            }
            PromiseResult::Failed => {
                emit(
                    "payout_failed",
                    json!({ "bounty": bounty_id, "claim_id": claim_id }),
                );
            }
        }
    }
}

impl Contract {
    /// Start the payout of a `paying` bounty's winning claim if no earlier claim still holds
    /// its place (R3.6) and enough gas is left; otherwise it waits for an earlier claim's
    /// verdict (whose callback calls this again) or for anyone's `retry_payout`.
    pub(crate) fn pay_if_settled(&mut self, id: &BountyId) -> PromiseOrValue<()> {
        let Some(bounty) = self.bounties.get(id) else {
            return PromiseOrValue::Value(());
        };
        let Some(claim_id) = bounty.winning_claim else {
            return PromiseOrValue::Value(());
        };
        if bounty.state != BountyState::Paying || bounty.paying_out {
            return PromiseOrValue::Value(());
        }
        if let Some(until) = bounty.payout_held_until(claim_id, env::block_timestamp()) {
            emit(
                "payout_waiting",
                json!({ "bounty": id, "claim_id": claim_id, "until_ns": U64(until) }),
            );
            return PromiseOrValue::Value(());
        }
        if Self::gas_left(near_sdk::Gas::from_gas(0)) < gas::payout() {
            emit(
                "payout_waiting",
                json!({ "bounty": id, "claim_id": claim_id }),
            );
            return PromiseOrValue::Value(());
        }
        match self.pay_out(claim_id) {
            Ok(p) => p.into(),
            Err(short) => {
                // Waits for a `retry_payout` that attaches the shortfall (R11.4).
                emit(
                    "payout_waiting",
                    json!({ "bounty": id, "claim_id": claim_id, "posting_fee_short": short }),
                );
                PromiseOrValue::Value(())
            }
        }
    }

    /// Pay the whole bounty amount to the claim's Whitehat, registering them with USDC
    /// first, once per bounty (R3.2, R2.7). No allowlist and no identity check (D9). The NEAR
    /// it attaches comes from the bounty's posting fee; if that can't cover it, nothing starts
    /// and the shortfall comes back. Once the winner is registered, a retry draws only the
    /// transfer's yoctoNEAR, so retries can't drain the fee (R11.4). The caller has checked
    /// the bounty is `paying` this claim with no transfer under way.
    pub(crate) fn pay_out(&mut self, claim_id: u64) -> Result<Promise, NearToken> {
        let claim = self.claims.get(&claim_id).expect("a judged claim").clone();
        let bounty = self
            .bounties
            .get_mut(&claim.bounty)
            .expect("the claim's bounty");
        let one_yocto = NearToken::from_yoctonear(1);
        if bounty.registered_winner == Some(claim_id) {
            bounty.draw_fee(one_yocto)?;
            bounty.paying_out = true;
            return Ok(self.transfer_payout(claim_id));
        }
        bounty.draw_fee(fees::USDC_REGISTRATION.saturating_add(one_yocto))?;
        bounty.paying_out = true;
        Ok(ext_ft::ext(self.config.usdc.clone())
            .with_attached_deposit(fees::USDC_REGISTRATION)
            .with_static_gas(gas::USDC_STORAGE_DEPOSIT)
            .with_unused_gas_weight(0)
            .storage_deposit(Some(claim.whitehat.clone()), Some(true))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_gas(
                        gas::ON_REGISTERED.as_gas()
                            + gas::USDC_TRANSFER.as_gas()
                            + gas::ON_PAID.as_gas(),
                    ))
                    .with_unused_gas_weight(0)
                    .on_winner_registered(claim_id),
            ))
    }

    /// The payout's transfer of the whole amount to the claim's Whitehat, then
    /// [`Contract::on_paid`]. Its yoctoNEAR is already drawn from the posting fee.
    fn transfer_payout(&self, claim_id: u64) -> Promise {
        let claim = self.claims.get(&claim_id).expect("a judged claim");
        let amount = self
            .bounties
            .get(&claim.bounty)
            .and_then(|b| b.rules.bounty_amount.to_u128())
            .expect("checked at posting");
        ext_ft::ext(self.config.usdc.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(gas::USDC_TRANSFER)
            .with_unused_gas_weight(0)
            .ft_transfer(
                claim.whitehat.clone(),
                U128(amount),
                Some(format!("BounTEE payout, claim {claim_id}")),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(gas::ON_PAID)
                    .with_unused_gas_weight(0)
                    .on_paid(claim_id),
            )
    }
}
