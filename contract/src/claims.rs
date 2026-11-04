//! Claims. A Whitehat tops up a claim balance once (ADR-0007; a claim key can't attach
//! NEAR), then files claims that draw their replay fee and storage from it (R11.1).
//!
//! `submit_claim` records the claim and its submission time, stores the sealed exploit as
//! this contract's OutLayer secret under the claim's own profile, and as soon as that is
//! stored requests the claim's job (R11.2). The verdict arrives only as the result of that
//! job's promise to OutLayer's contract, read in a private callback (R2.2).

use bountee_formats::{BlockRef, BountyId, Bytes, Outcome, Verdict, B256};
use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, NearToken, PromiseOrValue, PromiseResult};

use crate::{
    emit, fees, gas, outlayer, to_formats_account, BountyState, ClaimRecord, ClaimState, Contract,
    ContractExt,
};

fn storage_cost(bytes: u64) -> NearToken {
    NearToken::from_yoctonear(bytes as u128 * fees::STORAGE_PRICE_PER_BYTE)
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
        }
        let now = env::block_timestamp();
        require!(
            now < record.rules.end_date_ns.get(),
            "this bounty has ended"
        );
        let whitehat = env::predecessor_account_id();
        let claim_id = self.next_claim_id;
        self.next_claim_id += 1;
        // One profile per claim, never reused: OutLayer overwrites a row silently.
        let secret_profile = format!("c{claim_id}");

        let input = json!({ "judge_claim": {
            "rules": record.rules,
            "bounty": bounty,
            "whitehat": to_formats_account(&whitehat),
            "block": block,
            "header": header,
            "proofs_json": proofs,
            "submitted_at_ns": U64(now),
        } })
        .to_string();

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
        self.claims.flush();
        let record_cost = storage_cost(env::storage_usage().saturating_sub(storage_before));

        let input_hold =
            storage_cost((input.len() as u64).saturating_sub(fees::JOB_INPUT_FREE_BYTES));
        let job_deposit = fees::JOB_DEPOSIT.saturating_add(input_hold);
        let secret_deposit =
            storage_cost(sealed_exploit.as_str().len() as u64 + fees::SECRET_ROW_OVERHEAD_BYTES);
        let cost = job_deposit
            .saturating_add(secret_deposit)
            .saturating_add(record_cost);
        let balance = self.claim_balance(whitehat.clone());
        if balance < cost {
            env::panic_str(&format!(
                "the claim balance can't cover this claim: it needs {} yoctoNEAR",
                cost.as_yoctonear()
            ));
        }
        self.claim_balances
            .insert(whitehat.clone(), balance.saturating_sub(cost));

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
            // A failed call's deposit came back to this contract.
            Self::credit(
                &mut self.claim_balances,
                &who,
                job_deposit.saturating_add(secret_deposit),
            );
            emit("claim_store_failed", json!({ "claim_id": claim_id }));
            return PromiseOrValue::Value(());
        }
        claim.state = ClaimState::Judging;
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
            &input,
            Some(&profile),
            &whitehat,
            job_deposit,
            Self::gas_left(judged_gas.saturating_add(gas::TAIL)),
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(judged_gas)
                .with_unused_gas_weight(0)
                .on_claim_judged(claim_id, job_deposit),
        )
        .into()
    }

    /// A claim's job result: the only way a verdict is recorded. Private, so only this
    /// contract's own callback runs it, and the result it reads is that of the job promise
    /// to OutLayer's contract (R2.2). A failed promise, `null` (a refused or failed job) or
    /// anything that isn't a verdict leaves the claim with no verdict (R2.6).
    #[private]
    pub fn on_claim_judged(&mut self, claim_id: u64, job_deposit: NearToken) -> PromiseOrValue<()> {
        let Some(claim) = self.claims.get_mut(&claim_id) else {
            return PromiseOrValue::Value(());
        };
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
        emit(
            "claim_judged",
            json!({ "claim_id": claim_id, "verdict": verdict }),
        );
        // ZERO and INVALID move nothing and request no signature (R3.3).
        if verdict.outcome() != Outcome::Pays {
            return PromiseOrValue::Value(());
        }
        let Some(bounty) = self.bounties.get_mut(&bounty_id) else {
            return PromiseOrValue::Value(());
        };
        if bounty.state != BountyState::Live {
            // Already closed by an earlier payout: nothing more is paid (R3.4).
            return PromiseOrValue::Value(());
        }
        bounty.state = BountyState::Signing;
        bounty.winning_claim = Some(claim_id);
        let needed = gas::pause_signing(bounty.rules.covered_contracts.len());
        if Self::gas_left(near_sdk::Gas::from_gas(0)) < needed {
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

fn sha256_hex(bytes: &[u8]) -> B256 {
    let hash = env::sha256_array(bytes);
    let mut hex = String::with_capacity(66);
    hex.push_str("0x");
    for b in hash {
        hex.push_str(&format!("{b:02x}"));
    }
    B256::parse(&hex).expect("64 lowercase hex digits")
}
