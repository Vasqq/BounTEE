//! Claims. A Whitehat tops up a claim balance once (ADR-0007; a claim key can't attach
//! NEAR), then files claims that draw their replay fee and storage from it (R11.1), and may
//! withdraw what remains (R11.3).
//!
//! `submit_claim` records the claim and its submission time, stores the sealed exploit as
//! this contract's OutLayer secret under the claim's own profile, and as soon as that is
//! stored requests the claim's job (R11.2). The verdict arrives only as the result of that
//! job's promise to OutLayer's contract, read in a private callback (R2.2).
//!
//! Fairness between claims on one bounty:
//! - A job that ends with no verdict leaves the claim `no_verdict`; its Whitehat may
//!   `retry_claim` it, which requests a new job on the same secret with the original
//!   submission time (R2.6). A claim gets at most one verdict, and a sealed exploit is filed
//!   as one claim only, unless its secret could never be stored (R3.5).
//! - Claims are ordered by ID, which is submission order. A PAYS verdict closes the bounty
//!   and its pauses are signed at once, but the payout waits while any earlier claim has no
//!   verdict yet; an earlier PAYS takes the win from a later one until the payout starts
//!   (R3.6). So that a claim no one retries can't hold a winner's payout forever, a claim
//!   holds its place for [`CLAIM_PLACE_HOLD_NS`] from its submission; after that a later
//!   winner is paid and the lapsed claim can't win.

use bountee_formats::{BlockRef, BountyId, Bytes, Outcome, Rules, Verdict, B256};
use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, Promise, PromiseOrValue, PromiseResult,
};

use crate::{
    emit, fees, gas, outlayer, to_formats_account, Bounty, BountyState, ClaimRecord, ClaimState,
    Contract, ContractExt,
};

/// How long a claim with no verdict holds its place against a later PAYS, from its
/// submission: one hour, time to retry a job that failed (R2.6, R3.6).
pub const CLAIM_PLACE_HOLD_NS: u64 = 3_600_000_000_000;

/// For the withdrawal's callback.
const ON_CLAIM_BALANCE_WITHDRAWN: Gas = Gas::from_tgas(5);

fn storage_cost(bytes: u64) -> NearToken {
    NearToken::from_yoctonear(bytes as u128 * fees::STORAGE_PRICE_PER_BYTE)
}

/// The claim's job input (see `outlayer`).
fn judge_input(
    rules: &Rules,
    bounty: &BountyId,
    whitehat: &AccountId,
    block: &BlockRef,
    header: &Bytes,
    proofs: &str,
    submitted_at_ns: u64,
) -> String {
    json!({ "judge_claim": {
        "rules": rules,
        "bounty": bounty,
        "whitehat": to_formats_account(whitehat),
        "block": block,
        "header": header,
        "proofs_json": proofs,
        "submitted_at_ns": U64(submitted_at_ns),
    } })
    .to_string()
}

/// The job deposit for `input`: the fixed deposit plus OutLayer's hold on large input.
fn job_deposit(input: &str) -> NearToken {
    fees::JOB_DEPOSIT.saturating_add(storage_cost(
        (input.len() as u64).saturating_sub(fees::JOB_INPUT_FREE_BYTES),
    ))
}

#[near]
impl Contract {
    /// Add the attached NEAR to the caller's claim balance.
    #[payable]
    pub fn top_up_claim_balance(&mut self) -> NearToken {
        let amount = env::attached_deposit();
        require!(!amount.is_zero(), "attach NEAR to top up");
        let who = env::predecessor_account_id();
        Self::credit_deposit(&mut self.claim_balances, &who, amount);
        self.claim_balance(who)
    }

    /// Send `amount` (all of it if omitted) of the caller's claim balance back to the caller
    /// (R11.3). Attach exactly one yoctoNEAR, so only a full-access key can withdraw, never
    /// a claim key; it is sent back with the withdrawal.
    #[payable]
    pub fn withdraw_claim_balance(&mut self, amount: Option<NearToken>) -> Promise {
        let one_yocto = NearToken::from_yoctonear(1);
        require!(
            env::attached_deposit() == one_yocto,
            "attach exactly one yoctoNEAR to withdraw"
        );
        let who = env::predecessor_account_id();
        let have = self.claim_balance(who.clone());
        let amount = amount.unwrap_or(have);
        require!(!amount.is_zero(), "nothing to withdraw");
        require!(amount <= have, "that is more than the claim balance");
        self.claim_balances
            .insert(who.clone(), have.saturating_sub(amount));
        Promise::new(who.clone())
            .transfer(amount.saturating_add(one_yocto))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(ON_CLAIM_BALANCE_WITHDRAWN)
                    .with_unused_gas_weight(0)
                    .on_claim_balance_withdrawn(who, amount),
            )
    }

    /// After a withdrawal's transfer: if it failed, the NEAR came back here, so it goes back
    /// to the claim balance.
    #[private]
    pub fn on_claim_balance_withdrawn(&mut self, who: AccountId, amount: NearToken) {
        #[allow(deprecated)]
        match env::promise_result(0) {
            PromiseResult::Successful(_) => emit(
                "claim_balance_withdrawn",
                json!({ "account_id": who, "amount": amount }),
            ),
            PromiseResult::Failed => {
                Self::credit(&mut self.claim_balances, &who, amount);
                emit(
                    "claim_balance_withdraw_failed",
                    json!({ "account_id": who, "amount": amount }),
                );
            }
        }
    }

    /// File a claim as the calling account. `proofs` is the claim's proofs array as JSON
    /// text; the contract hashes and forwards it, never parses it. `sealed_exploit` is the
    /// OutLayer ciphertext the Whitehat sealed on their machine. Returns the claim's ID.
    pub fn submit_claim(
        &mut self,
        bounty: BountyId,
        block: BlockRef,
        header: Bytes,
        proofs: String,
        sealed_exploit: bountee_formats::Base64,
    ) -> u64 {
        require!(
            env::prepaid_gas() >= gas::MIN_CLAIM,
            "attach at least 200 Tgas to a claim"
        );
        let record = self
            .bounties
            .get(&bounty)
            .unwrap_or_else(|| env::panic_str("no such bounty"));
        match record.state {
            BountyState::Live => {}
            BountyState::Checking | BountyState::CheckFailed => {
                env::panic_str("this bounty's posting check hasn't passed")
            }
            BountyState::Signing | BountyState::Paying | BountyState::Paid => {
                env::panic_str("this bounty is closed: it has been paid")
            }
            BountyState::Withdrawn => env::panic_str("this bounty has ended: it was withdrawn"),
        }
        let now = env::block_timestamp();
        require!(
            now < record.rules.end_date_ns.get(),
            "this bounty has ended"
        );
        // R3.5: a sealed exploit is filed once. One whose secret was never stored was never
        // judged, so it may be filed again.
        let sealed_hash = sha256_hex(sealed_exploit.as_str().as_bytes());
        if let Some(earlier) = self.sealed_exploits.get(&sealed_hash).copied() {
            let unstored = self
                .claims
                .get(&earlier)
                .is_some_and(|c| c.state == ClaimState::StoreFailed);
            if !unstored {
                env::panic_str(&format!(
                    "this sealed exploit has already been filed, as claim {earlier}"
                ));
            }
        }
        let whitehat = env::predecessor_account_id();
        let claim_id = self.next_claim_id;
        self.next_claim_id += 1;
        // One profile per claim, never reused: OutLayer overwrites a row silently.
        let secret_profile = format!("c{claim_id}");
        let input = judge_input(
            &record.rules,
            &bounty,
            &whitehat,
            &block,
            &header,
            &proofs,
            now,
        );

        let storage_before = env::storage_usage();
        self.claims.insert(
            claim_id,
            ClaimRecord {
                bounty: bounty.clone(),
                whitehat: whitehat.clone(),
                block,
                header,
                proofs_sha256: sha256_hex(proofs.as_bytes()),
                submitted_at_ns: U64(now),
                secret_profile: secret_profile.clone(),
                state: ClaimState::Storing,
                verdict: None,
            },
        );
        self.sealed_exploits.insert(sealed_hash, claim_id);
        let record = self.bounties.get_mut(&bounty).expect("checked above");
        record.prune_lapsed(now);
        record.open_claims.push((claim_id, now));
        self.claims.flush();
        self.sealed_exploits.flush();
        self.bounties.flush();
        let record_cost = storage_cost(env::storage_usage().saturating_sub(storage_before));

        let job_deposit = job_deposit(&input);
        let secret_deposit =
            storage_cost(sealed_exploit.as_str().len() as u64 + fees::SECRET_ROW_OVERHEAD_BYTES);
        let cost = job_deposit
            .saturating_add(secret_deposit)
            .saturating_add(record_cost);
        self.draw_claim_balance(&whitehat, cost);

        emit(
            "claim_submitted",
            json!({ "claim_id": claim_id, "bounty": bounty, "whitehat": whitehat }),
        );
        outlayer::store_sealed_exploit(
            &self.config.outlayer,
            &self.config.judge_build_hash,
            &secret_profile,
            sealed_exploit.as_str(),
            secret_deposit,
            gas::STORE_SECRET,
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(gas::ON_CLAIM_JUDGED.saturating_add(gas::TAIL))
                .with_unused_gas_weight(1)
                .on_exploit_stored(claim_id, input, job_deposit, secret_deposit),
        )
        .detach();
        claim_id
    }

    /// Retry a claim whose job ended with no verdict (R2.6). Only the claim's Whitehat may,
    /// with the proofs the claim was filed with (the contract keeps only their hash). The new
    /// job runs on the claim's own secret, never stored again, with the original submission
    /// time; its deposit is drawn from the claim balance. Refused once the claim can no
    /// longer win: the bounty is paid or paying out, an earlier claim has won, or the claim's
    /// place has lapsed behind a later winner. Attach at least 200 Tgas.
    pub fn retry_claim(&mut self, claim_id: u64, proofs: String) -> PromiseOrValue<()> {
        require!(
            env::prepaid_gas() >= gas::MIN_CLAIM,
            "attach at least 200 Tgas to a claim"
        );
        let claim = self
            .claims
            .get(&claim_id)
            .unwrap_or_else(|| env::panic_str("no such claim"))
            .clone();
        require!(
            env::predecessor_account_id() == claim.whitehat,
            "only the claim's Whitehat may retry it"
        );
        require!(
            claim.state == ClaimState::NoVerdict,
            "only a claim left with no verdict can be retried"
        );
        require!(
            sha256_hex(proofs.as_bytes()) == claim.proofs_sha256,
            "these aren't the proofs the claim was filed with"
        );
        let now = env::block_timestamp();
        let submitted = claim.submitted_at_ns.0;
        let bounty = self
            .bounties
            .get(&claim.bounty)
            .unwrap_or_else(|| env::panic_str("no such bounty"));
        require!(
            bounty.claim_can_still_win(claim_id, submitted, now),
            "this claim can no longer win: the bounty has been won"
        );
        let input = judge_input(
            &bounty.rules,
            &claim.bounty,
            &claim.whitehat,
            &claim.block,
            &claim.header,
            &proofs,
            submitted,
        );
        let job_deposit = job_deposit(&input);
        self.draw_claim_balance(&claim.whitehat, job_deposit);
        self.claims.get_mut(&claim_id).expect("read above").state = ClaimState::Judging;
        emit(
            "claim_retried",
            json!({ "claim_id": claim_id, "bounty": claim.bounty }),
        );
        self.request_claim_job(claim_id, &input, job_deposit).into()
    }

    /// After `store_secrets`: request the claim's job, or give its costs back if the
    /// secret couldn't be stored (nothing was judged).
    #[private]
    pub fn on_exploit_stored(
        &mut self,
        claim_id: u64,
        input: String,
        job_deposit: NearToken,
        secret_deposit: NearToken,
    ) -> PromiseOrValue<()> {
        let Some(claim) = self.claims.get_mut(&claim_id) else {
            return PromiseOrValue::Value(());
        };
        #[allow(deprecated)]
        if let PromiseResult::Failed = env::promise_result(0) {
            claim.state = ClaimState::StoreFailed;
            let who = claim.whitehat.clone();
            let bounty_id = claim.bounty.clone();
            // A failed call's deposit came back to this contract.
            Self::credit(
                &mut self.claim_balances,
                &who,
                job_deposit.saturating_add(secret_deposit),
            );
            emit("claim_store_failed", json!({ "claim_id": claim_id }));
            // Nothing was judged: it no longer holds a place.
            if let Some(bounty) = self.bounties.get_mut(&bounty_id) {
                bounty.close_claim(claim_id);
            }
            return self.pay_if_settled(&bounty_id);
        }
        claim.state = ClaimState::Judging;
        self.request_claim_job(claim_id, &input, job_deposit).into()
    }

    /// A claim's job result: the only way a verdict is recorded. Private, so only this
    /// contract's own callback runs it, and the result it reads is that of the job promise
    /// to OutLayer's contract (R2.2). It acts only on a claim that is `judging`, so no claim
    /// gets a second verdict (R3.5). A failed promise, `null` (a refused or failed job) or
    /// anything that isn't a verdict leaves the claim with no verdict, in its place (R2.6).
    #[private]
    pub fn on_claim_judged(&mut self, claim_id: u64, job_deposit: NearToken) -> PromiseOrValue<()> {
        let Some(claim) = self.claims.get_mut(&claim_id) else {
            return PromiseOrValue::Value(());
        };
        if claim.state != ClaimState::Judging {
            return PromiseOrValue::Value(());
        }
        #[allow(deprecated)]
        let verdict = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => serde_json::from_slice::<Option<Verdict>>(&bytes)
                .ok()
                .flatten(),
            PromiseResult::Failed => {
                // OutLayer refused the request outright; its deposit came back here.
                let who = claim.whitehat.clone();
                claim.state = ClaimState::NoVerdict;
                Self::credit(&mut self.claim_balances, &who, job_deposit);
                emit("claim_no_verdict", json!({ "claim_id": claim_id }));
                return PromiseOrValue::Value(());
            }
        };
        let Some(verdict) = verdict else {
            claim.state = ClaimState::NoVerdict;
            emit("claim_no_verdict", json!({ "claim_id": claim_id }));
            return PromiseOrValue::Value(());
        };
        claim.state = ClaimState::Judged;
        claim.verdict = Some(verdict);
        let bounty_id = claim.bounty.clone();
        let submitted = claim.submitted_at_ns.0;
        emit(
            "claim_judged",
            json!({ "claim_id": claim_id, "verdict": verdict }),
        );
        let Some(bounty) = self.bounties.get_mut(&bounty_id) else {
            return PromiseOrValue::Value(());
        };
        let now = env::block_timestamp();
        let could_win = bounty.claim_can_still_win(claim_id, submitted, now);
        bounty.close_claim(claim_id);
        bounty.prune_lapsed(now);
        // ZERO and INVALID move nothing and request no signature (R3.3); a later winner
        // this claim held back may now be paid (R3.6).
        if verdict.outcome() != Outcome::Pays {
            return self.pay_if_settled(&bounty_id);
        }
        if !could_win {
            // An earlier claim won, or the payout is under way or done (R3.4, R3.6).
            emit(
                "claim_refused",
                json!({ "bounty": bounty_id, "claim_id": claim_id }),
            );
            return PromiseOrValue::Value(());
        }
        if let Some(later) = bounty.winning_claim {
            // An earlier PAYS takes the win from a later one before its payout (R3.6).
            bounty.winning_claim = Some(claim_id);
            emit(
                "claim_refused",
                json!({ "bounty": bounty_id, "claim_id": later, "earlier_claim": claim_id }),
            );
            return self.pay_if_settled(&bounty_id);
        }
        bounty.state = BountyState::Signing;
        bounty.winning_claim = Some(claim_id);
        let needed = gas::pause_signing(bounty.rules.covered_contracts.len());
        if Self::gas_left(Gas::from_gas(0)) < needed {
            emit(
                "pause_signing_waiting",
                json!({ "bounty": bounty_id, "claim_id": claim_id }),
            );
            return PromiseOrValue::Value(());
        }
        match self.start_pause_signing(&bounty_id) {
            Some(p) => p.into(),
            None => PromiseOrValue::Value(()),
        }
    }
}

impl Contract {
    /// Take `cost` from the Whitehat's claim balance, or refuse the call (R11.1).
    fn draw_claim_balance(&mut self, whitehat: &AccountId, cost: NearToken) {
        let balance = self.claim_balance(whitehat.clone());
        if balance < cost {
            env::panic_str(&format!(
                "the claim balance can't cover this claim: it needs {} yoctoNEAR",
                cost.as_yoctonear()
            ));
        }
        self.claim_balances
            .insert(whitehat.clone(), balance.saturating_sub(cost));
    }

    /// Request a `judging` claim's job on its own secret, then [`Contract::on_claim_judged`].
    fn request_claim_job(&mut self, claim_id: u64, input: &str, job_deposit: NearToken) -> Promise {
        let claim = self.claims.get(&claim_id).expect("a claim");
        let profile = claim.secret_profile.clone();
        let whitehat = claim.whitehat.clone();
        // Keep back the gas to sign every pause on PAYS in the same transaction, if the job
        // still gets enough; otherwise a PAYS waits for `sign_pauses`.
        let covered = self
            .bounties
            .get(&claim.bounty)
            .map_or(0, |b| b.rules.covered_contracts.len());
        let with_pauses = gas::ON_CLAIM_JUDGED.saturating_add(gas::pause_signing(covered));
        let judged_gas = if Self::gas_left(with_pauses.saturating_add(gas::TAIL)) >= gas::MIN_JOB {
            with_pauses
        } else {
            gas::ON_CLAIM_JUDGED
        };
        outlayer::request_job(
            &self.config,
            input,
            Some(&profile),
            &whitehat,
            job_deposit,
            || Self::gas_left(judged_gas.saturating_add(gas::TAIL)),
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(judged_gas)
                .with_unused_gas_weight(0)
                .on_claim_judged(claim_id, job_deposit),
        )
    }
}

impl Bounty {
    /// While an earlier claim with no verdict still holds its place, the latest time any
    /// such claim holds `winner`'s payout; `None` once the winner may be paid (R3.6).
    pub(crate) fn payout_held_until(&self, winner: u64, now: u64) -> Option<u64> {
        self.open_claims
            .iter()
            .filter(|(id, _)| *id < winner)
            .map(|(_, submitted)| submitted.saturating_add(CLAIM_PLACE_HOLD_NS))
            .filter(|until| now < *until)
            .max()
    }

    /// Whether a PAYS for this claim would still win: the bounty is live, or its current
    /// winner is a later claim whose payout hasn't started and this claim's place hasn't
    /// lapsed (R3.6).
    pub(crate) fn claim_can_still_win(&self, claim_id: u64, submitted: u64, now: u64) -> bool {
        match self.state {
            BountyState::Live => true,
            BountyState::Signing | BountyState::Paying => {
                !self.paying_out
                    && self.winning_claim.is_some_and(|w| claim_id < w)
                    && now < submitted.saturating_add(CLAIM_PLACE_HOLD_NS)
            }
            _ => false,
        }
    }

    /// The claim has a verdict, or never will: it holds no place.
    fn close_claim(&mut self, claim_id: u64) {
        self.open_claims.retain(|(id, _)| *id != claim_id);
    }

    /// Drop the claims whose place has lapsed; they can't hold a payout any more.
    fn prune_lapsed(&mut self, now: u64) {
        self.open_claims
            .retain(|(_, submitted)| now < submitted.saturating_add(CLAIM_PLACE_HOLD_NS));
    }
}

fn sha256_hex(bytes: &[u8]) -> B256 {
    let hash = env::sha256_array(bytes);
    let mut hex = String::with_capacity(66);
    hex.push_str("0x");
    for b in hash {
        hex.push_str(&format!("{b:02x}"));
    }
    B256::parse(&hex).expect("64 lowercase hex digits")
}
