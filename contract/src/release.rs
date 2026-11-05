//! The release (#22): the Protocol receives the winning exploit when, and only when, the
//! Whitehat is paid (R6).
//!
//! Once a bounty is `paid`, anyone may call [`Contract::release_exploit`]: the contract
//! requests a job running the pinned judge with the winning claim's own secret, naming the
//! exploit key recorded in the bounty's rules (R12.4). The judge re-encrypts the exploit to
//! that key; the callback keeps its output, which [`Contract::released_exploit`] returns for
//! the Protocol to open (`bountee open-exploit`). Nothing else ever requests a job with a
//! claim's secret after its verdict, so a failed, refused or losing exploit is never
//! released (R5.6); the access rule lets only this contract's jobs open a secret (ADR-0012).
//!
//! The job's deposit and the release's storage come from the bounty's posting fee (R11.4);
//! anyone may add to it by attaching NEAR. A release that fails keeps nothing and can be
//! asked again.

use bountee_formats::{BountyId, ReleaseOutput};
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, NearToken, Promise, PromiseResult};

use crate::{emit, fees, gas, outlayer, BountyState, Contract, ContractExt};

/// The most bytes a release's ciphertext may take (as base64); its storage is held from the
/// posting fee while the job runs. A demo exploit's release is about 400 bytes.
pub const MAX_RELEASE_BYTES: u64 = 16 * 1024;
/// Storage a release record takes beyond its ciphertext.
const RELEASE_RECORD_BYTES: u64 = 200;
/// A release request older than this many blocks is treated as over (OutLayer's own
/// timeout is about 200 blocks), so a lost callback never blocks a new one.
pub const RELEASE_STALE_BLOCKS: u64 = 300;

/// A bounty's release: requested, then released.
#[near(serializers = [borsh])]
pub struct ReleaseRecord {
    pub claim_id: u64,
    /// The block height the job under way was requested at.
    pub requested_at: Option<u64>,
    /// The release job's output: the winning exploit, encrypted to the exploit key.
    pub released: Option<String>,
}

/// Where a release is.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
pub enum ReleaseState {
    /// The job is under way.
    Requested,
    /// Its output is kept, for the Protocol to open.
    Released,
}

/// A release as its view returns it.
#[near(serializers = [json])]
pub struct ReleaseView {
    pub claim_id: u64,
    pub state: ReleaseState,
    pub released: Option<String>,
}

/// Whether `key` is an exploit key a release can encrypt to: `x25519:` and 32 bytes.
pub fn is_exploit_key(key: &str) -> bool {
    key.strip_prefix("x25519:")
        .and_then(|data| near_sdk::bs58::decode(data).into_vec().ok())
        .is_some_and(|bytes| bytes.len() == 32)
}

impl ReleaseRecord {
    fn in_flight(&self) -> bool {
        self.requested_at
            .is_some_and(|h| env::block_height() < h.saturating_add(RELEASE_STALE_BLOCKS))
    }
}

fn storage_cost(bytes: u64) -> NearToken {
    NearToken::from_yoctonear(bytes as u128 * fees::STORAGE_PRICE_PER_BYTE)
}

/// What a release request holds from the posting fee: the job's deposit and the most the
/// release's storage can cost. The unused part goes back.
pub fn release_hold() -> NearToken {
    fees::JOB_DEPOSIT.saturating_add(storage_cost(MAX_RELEASE_BYTES + RELEASE_RECORD_BYTES))
}

#[near]
impl Contract {
    /// Request the release of a paid bounty's winning exploit to the Protocol's exploit key
    /// (R6.1, R12.4). Anyone may call; it is refused before the payout has succeeded, while a
    /// release is under way and once released. Any NEAR attached joins the bounty's posting
    /// fee, which pays for the job and the release's storage. Attach the gas `fees()` names
    /// as `min_release_gas`.
    #[payable]
    pub fn release_exploit(&mut self, id: BountyId) -> Promise {
        let bounty = self
            .bounties
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str("no such bounty"));
        require!(
            bounty.state == BountyState::Paid,
            "this bounty has not been paid, so nothing is released"
        );
        let claim_id = bounty
            .winning_claim
            .unwrap_or_else(|| env::panic_str("this bounty has no winning claim"));
        if let Some(record) = self.releases.get(&id) {
            require!(
                record.released.is_none(),
                "this exploit is already released"
            );
            require!(!record.in_flight(), "a release is already under way");
        }
        require!(
            Self::gas_left(gas::TAIL) >= gas::release(),
            "attach more gas: see min_release_gas in fees()"
        );
        let hold = release_hold();
        bounty.draw_fee_or_refuse(hold, "a release");
        let rules = bounty.rules.clone();
        let claim = self
            .claims
            .get(&claim_id)
            .expect("the winning claim")
            .clone();
        let input = json!({ "release": {
            "bounty": id,
            "claim_id": claim_id,
            "whitehat": crate::to_formats_account(&claim.whitehat),
            "exploit_public_key": rules.exploit_public_key,
        } })
        .to_string();
        let requested_at = env::block_height();
        self.releases.insert(
            id.clone(),
            ReleaseRecord {
                claim_id,
                requested_at: Some(requested_at),
                released: None,
            },
        );
        emit(
            "release_requested",
            json!({ "bounty": id, "claim_id": claim_id }),
        );
        let protocol: near_sdk::AccountId = id
            .protocol
            .as_str()
            .parse()
            .expect("a bounty's protocol is a NEAR account");
        outlayer::request_job(
            &self.config,
            &input,
            Some(&claim.secret_profile),
            &protocol,
            fees::JOB_DEPOSIT,
            || Self::gas_left(gas::ON_RELEASED.saturating_add(gas::TAIL)),
        )
        .then(
            Self::ext(env::current_account_id())
                .with_static_gas(gas::ON_RELEASED)
                .with_unused_gas_weight(0)
                .on_exploit_released(id, requested_at, hold),
        )
    }

    /// The release job's result: its output is kept only if it is a release. A failed,
    /// refused or malformed job keeps nothing and leaves the release to be asked again.
    /// Whatever of `hold` isn't spent goes back to the bounty's posting fee. A callback for
    /// a request that is no longer the one in flight (it went stale and was asked again)
    /// changes nothing but that refund.
    #[private]
    pub fn on_exploit_released(&mut self, id: BountyId, requested_at: u64, hold: NearToken) {
        #[allow(deprecated)]
        let (output, job_spent) = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => (
                serde_json::from_slice::<Option<ReleaseOutput>>(&bytes)
                    .ok()
                    .flatten()
                    .filter(|o| o.released.as_str().len() as u64 <= MAX_RELEASE_BYTES),
                fees::JOB_DEPOSIT,
            ),
            // OutLayer refused the request; its deposit came back here.
            PromiseResult::Failed => (None, NearToken::from_yoctonear(0)),
        };
        if self
            .releases
            .get(&id)
            .is_none_or(|r| r.requested_at != Some(requested_at))
        {
            self.refund_hold(&id, hold.saturating_sub(job_spent));
            return;
        }
        let mut record = self.releases.remove(&id).expect("checked above");
        let mut storage = NearToken::from_yoctonear(0);
        match output {
            Some(output) => {
                let released = output.released.as_str().to_owned();
                // At least what the record takes; the hold allowed for this much.
                storage = storage_cost(released.len() as u64 + RELEASE_RECORD_BYTES);
                record.requested_at = None;
                record.released = Some(released);
                let claim_id = record.claim_id;
                self.releases.insert(id.clone(), record);
                emit(
                    "exploit_released",
                    json!({ "bounty": id, "claim_id": claim_id }),
                );
            }
            None => {
                // Nothing kept: the record goes, so the release can be asked again.
                emit(
                    "release_failed",
                    json!({ "bounty": id, "claim_id": record.claim_id }),
                );
            }
        }
        self.refund_hold(&id, hold.saturating_sub(job_spent).saturating_sub(storage));
    }

    /// A bounty's release, once requested: the winning exploit encrypted to the Protocol's
    /// exploit key, for `bountee open-exploit` to open. `null` before any release.
    pub fn released_exploit(&self, id: BountyId) -> Option<ReleaseView> {
        self.releases.get(&id).map(|r| ReleaseView {
            claim_id: r.claim_id,
            state: if r.released.is_some() {
                ReleaseState::Released
            } else {
                ReleaseState::Requested
            },
            released: r.released.clone(),
        })
    }
}

impl Contract {
    /// Give the unspent part of a release's hold back to the bounty's posting fee.
    fn refund_hold(&mut self, id: &BountyId, back: NearToken) {
        if let Some(bounty) = self.bounties.get_mut(id) {
            bounty.fee_reserve = bounty.fee_reserve.saturating_add(back);
        }
    }
}
