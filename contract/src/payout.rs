//! The payout of a PAYS verdict: once every pause is signed and stored (`pauses`), the whole
//! bounty is paid to the Whitehat (ADR-0001, R7.1, R3.2) by [`Contract::pay_out`]. If the
//! token refuses the transfer, the bounty stays `paying` with its USDC held, and anyone can
//! [`Contract::retry_payout`] the same transfer to the same Whitehat (R2.4).
//!
//! USDC leaves the contract only here, as the payout (R2.3); the Protocol's withdrawal
//! after the end date is the only other path, in its own ticket.

use bountee_formats::BountyId;
use near_sdk::json_types::U128;
use near_sdk::serde_json::json;
use near_sdk::{env, ext_contract, near, require, AccountId, NearToken, Promise, PromiseResult};

use crate::{emit, fees, gas, BountyState, Contract, ContractExt};

#[ext_contract(ext_ft)]
#[allow(dead_code)]
pub trait FungibleToken {
    fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>);
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[near]
impl Contract {
    /// Retry the payout of a bounty whose transfer failed (R2.4). Anyone may call; it sends
    /// the same whole amount to the winning claim's Whitehat and no one else, and is refused
    /// while a transfer is under way or once the bounty is paid, so it never pays twice.
    /// Attach the gas `fees()` names as `min_retry_payout_gas`.
    pub fn retry_payout(&mut self, id: BountyId) -> Promise {
        let bounty = self
            .bounties
            .get(&id)
            .unwrap_or_else(|| env::panic_str("no such bounty"));
        require!(
            bounty.state == BountyState::Paying && !bounty.paying_out,
            "this bounty has no payout waiting for a retry"
        );
        let claim_id = bounty
            .winning_claim
            .unwrap_or_else(|| env::panic_str("this bounty has no winning claim"));
        require!(
            Self::gas_left(gas::TAIL) >= gas::payout(),
            "attach more gas: see min_retry_payout_gas in fees()"
        );
        self.pay_out(claim_id)
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
    /// Pay the whole bounty amount to the claim's Whitehat, registering them with USDC
    /// first if needed (R3.2, R2.7). No allowlist and no identity check (D9). The NEAR it
    /// attaches comes from the bounty's posting fee. The caller has checked the bounty is
    /// `paying` this claim with no transfer under way.
    pub(crate) fn pay_out(&mut self, claim_id: u64) -> Promise {
        let claim = self.claims.get(&claim_id).expect("a judged claim").clone();
        let bounty = self
            .bounties
            .get_mut(&claim.bounty)
            .expect("the claim's bounty");
        bounty.paying_out = true;
        let amount = bounty
            .rules
            .bounty_amount
            .to_u128()
            .expect("checked at posting");
        let one_yocto = NearToken::from_yoctonear(1);
        bounty.fee_reserve = bounty
            .fee_reserve
            .saturating_sub(fees::USDC_REGISTRATION)
            .saturating_sub(one_yocto);
        let usdc = self.config.usdc.clone();
        ext_ft::ext(usdc.clone())
            .with_attached_deposit(fees::USDC_REGISTRATION)
            .with_static_gas(gas::USDC_STORAGE_DEPOSIT)
            .with_unused_gas_weight(0)
            .storage_deposit(Some(claim.whitehat.clone()), Some(true))
            .then(
                ext_ft::ext(usdc)
                    .with_attached_deposit(one_yocto)
                    .with_static_gas(gas::USDC_TRANSFER)
                    .with_unused_gas_weight(0)
                    .ft_transfer(
                        claim.whitehat.clone(),
                        U128(amount),
                        Some(format!("BounTEE payout, claim {claim_id}")),
                    ),
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(gas::ON_PAID)
                    .with_unused_gas_weight(0)
                    .on_paid(claim_id),
            )
    }
}
