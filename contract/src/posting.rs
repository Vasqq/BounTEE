//! Posting: the posting fee in NEAR (`prepay_posting_fee`), then the bounty amount as one
//! USDC `ft_transfer_call` whose `msg` carries the bounty's name and rules. `ft_on_transfer`
//! records the bounty, requests its posting check and returns the check's promise to the
//! token; the callback answers the amount to refund, so the token's own resolve gives the
//! USDC back on a failed check (R1.6). Any refusal panics, so the token refunds in full.

use bountee_formats::{BountyId, BountyName, PostingCheckResult, Rules, RECENCY_LIMIT_SECS};
use near_sdk::json_types::U128;
use near_sdk::serde::Deserialize;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, AccountId, NearToken, PromiseOrValue, PromiseResult};

use crate::{
    emit, fees, gas, outlayer, to_formats_account, Bounty, BountyState, Contract, ContractExt,
};

/// The most covered contracts and listed tokens a bounty may name, which bounds its storage
/// and the pause verifications its posting fee funds.
pub const MAX_COVERED_CONTRACTS: usize = 8;
pub const MAX_LISTED_TOKENS: usize = 16;

/// What a posting's `ft_transfer_call` carries in `msg`.
#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct PostingMsg {
    name: BountyName,
    rules: Rules,
}

#[near]
impl Contract {
    /// Prepay posting fees in NEAR (the first of the two posting prompts). Each posting
    /// takes `fees::POSTING_FEE` from this balance and it is never paid back (R11.4); a
    /// posting refused before it is recorded takes nothing.
    #[payable]
    pub fn prepay_posting_fee(&mut self) -> NearToken {
        let amount = env::attached_deposit();
        require!(!amount.is_zero(), "attach the posting fee");
        let who = env::predecessor_account_id();
        Self::credit_deposit(&mut self.posting_fees, &who, amount);
        self.posting_fee_balance(who)
    }

    /// NEP-141 receiver: a posting. Only USDC is accepted, only as a new bounty's full
    /// amount, and only with the posting fee prepaid (R1.5, R11.4).
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.config.usdc,
            "only USDC is accepted"
        );
        require!(
            Self::gas_left(near_sdk::Gas::from_gas(0)) >= gas::MIN_POSTING,
            "attach more gas: the posting check needs at least 100 Tgas left"
        );
        let posting: PostingMsg = serde_json::from_str(&msg)
            .unwrap_or_else(|e| env::panic_str(&format!("invalid posting: {e}")));
        let id = BountyId {
            protocol: to_formats_account(&sender_id),
            name: posting.name,
        };
        require!(
            !self.bounties.contains_key(&id),
            "this bounty name is already used; a bounty takes no funds after it is posted"
        );
        self.check_rules(&posting.rules, amount.0);
        self.check_not_covered(&posting.rules);

        let fee = self.posting_fee_balance(sender_id.clone());
        require!(
            fee >= fees::POSTING_FEE,
            "prepay the posting fee with prepay_posting_fee first"
        );
        self.posting_fees
            .insert(sender_id.clone(), fee.saturating_sub(fees::POSTING_FEE));

        let covered = posting.rules.covered_contracts.clone();
        let storage_before = env::storage_usage();
        self.bounties.insert(
            id.clone(),
            Bounty {
                rules: posting.rules,
                state: BountyState::Checking,
                winning_claim: None,
                fee_reserve: NearToken::from_yoctonear(0),
                signed_pauses: Vec::new(),
                signing_since: None,
                paying_out: false,
                open_claims: Vec::new(),
                paid_at_ns: None,
            },
        );
        // R12.3: these contracts are now covered by a pending bounty.
        for contract in covered {
            self.covered_by.insert(contract, id.clone());
        }
        self.bounties.flush();
        self.covered_by.flush();
        let used = env::storage_usage().saturating_sub(storage_before);
        require!(
            used <= fees::BOUNTY_STORAGE_BYTES,
            "these rules need more storage than the posting fee covers"
        );
        let reserve = fees::POSTING_FEE
            .saturating_sub(fees::JOB_DEPOSIT)
            .saturating_sub(fees::storage_cost(used));
        let bounty = self.bounties.get_mut(&id).expect("just inserted");
        bounty.fee_reserve = reserve;
        let input = json!({ "posting_check": { "bounty": id, "rules": bounty.rules } }).to_string();

        emit("bounty_posted", json!({ "bounty": id, "amount": amount }));
        let job = outlayer::request_job(
            &self.config,
            &input,
            None,
            &sender_id,
            fees::JOB_DEPOSIT,
            || Self::gas_left(gas::ON_POSTING_CHECKED.saturating_add(gas::TAIL)),
        );
        job.then(
            Self::ext(env::current_account_id())
                .with_static_gas(gas::ON_POSTING_CHECKED)
                .with_unused_gas_weight(0)
                .on_posting_checked(id, amount),
        )
        .into()
    }

    /// The posting check's result: answers the token with the USDC to refund, none when the
    /// check passed, all of it otherwise (R1.6).
    #[private]
    pub fn on_posting_checked(&mut self, id: BountyId, amount: U128) -> U128 {
        let result = posting_check_result();
        let Some(bounty) = self.bounties.get_mut(&id) else {
            return amount;
        };
        if result.as_ref().is_some_and(PostingCheckResult::passed) {
            bounty.state = BountyState::Live;
            emit("bounty_live", json!({ "bounty": id }));
            U128(0)
        } else {
            bounty.state = BountyState::CheckFailed;
            // The judge's reasons, so the Protocol sees what to fix; null for a failed job.
            let failures = result.map(|r| r.failures);
            emit(
                "bounty_check_failed",
                json!({ "bounty": id, "failures": failures }),
            );
            amount
        }
    }
}

/// The posting check job's answer, if it gave one. The check passes only on an answer with
/// no failures: on every covered chain the pause role can pause each covered contract and
/// holds its pause gas, read through at least two agreeing pinned RPCs (R7.6, R12.1, R12.2,
/// R12.5). A failed or refused job (`null`, or a failed promise) or any other output is
/// `None`, and fails the check.
fn posting_check_result() -> Option<PostingCheckResult> {
    #[allow(deprecated)]
    match env::promise_result(0) {
        PromiseResult::Successful(bytes) => {
            serde_json::from_slice::<Option<PostingCheckResult>>(&bytes)
                .ok()
                .flatten()
        }
        PromiseResult::Failed => None,
    }
}

impl Contract {
    /// R12.3: refuse a contract another bounty covers while that bounty's posting check is
    /// pending, or while it is live and hasn't ended.
    fn check_not_covered(&self, rules: &Rules) {
        let now = env::block_timestamp();
        for contract in &rules.covered_contracts {
            let covering = self
                .covered_by
                .get(contract)
                .and_then(|id| self.bounties.get(id))
                .is_some_and(|other| match other.state {
                    BountyState::Checking => true,
                    BountyState::Live => other.rules.end_date_ns.get() > now,
                    _ => false,
                });
            require!(
                !covering,
                "a covered contract is already covered by a live or pending bounty"
            );
        }
    }

    /// Refuse missing or invalid rules (R1.3, R1.4, R1.5). The format already checked
    /// every value's shape; this checks what BounTEE fixes and what must hold at posting.
    fn check_rules(&self, rules: &Rules, amount: u128) {
        require!(
            rules.judge_build_hash == self.config.judge_build_hash,
            "the posting names another judge build"
        );
        require!(
            rules.recency_limit_secs == RECENCY_LIMIT_SECS,
            "the recency limit is fixed at 300 seconds"
        );
        require!(rules.seed == self.config.seed, "the seed is set by BounTEE");
        require!(
            rules.bounty_amount.to_u128() == Some(amount) && amount > 0,
            "the full bounty amount must arrive with the posting"
        );
        require!(
            rules.minimum_theft.as_str() != "0",
            "the minimum theft must be above zero"
        );
        require!(
            rules.end_date_ns.get() > env::block_timestamp(),
            "the end date must be in the future"
        );
        require!(
            (1..=90).contains(&rules.disclosure_delay_days),
            "the disclosure delay must be 1 to 90 days"
        );
        require!(
            !rules.covered_contracts.is_empty(),
            "a bounty must cover at least one contract"
        );
        require!(
            !rules.listed_tokens.is_empty(),
            "a bounty must list at least one token"
        );
        // The release encrypts the winning exploit to this key (R6.2, R12.4): a key no
        // release can use would leave the paid Protocol unable to open it.
        require!(
            crate::release::is_exploit_key(rules.exploit_public_key.as_str()),
            "the exploit key must be an X25519 key: x25519:<32 bytes in base58>"
        );
        require!(
            rules.covered_contracts.len() <= MAX_COVERED_CONTRACTS
                && rules.listed_tokens.len() <= MAX_LISTED_TOKENS,
            "too many covered contracts or listed tokens"
        );
        for (i, c) in rules.covered_contracts.iter().enumerate() {
            require!(
                !rules.covered_contracts[..i].contains(c),
                "a covered contract is named twice"
            );
        }
        for (i, t) in rules.listed_tokens.iter().enumerate() {
            require!(
                !rules.listed_tokens[..i].iter().any(|u| u.token == t.token),
                "a listed token is named twice"
            );
        }
    }
}
