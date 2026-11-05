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
//! asked again. The request, its hold and its callback are shared with the publication
//! (`exploit_job`).

use bountee_formats::BountyId;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, Promise};

use crate::exploit_job::ExploitJob;
use crate::{BountyState, Contract, ContractExt};

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
            .get(&id)
            .unwrap_or_else(|| env::panic_str("no such bounty"));
        require!(
            bounty.state == BountyState::Paid,
            "this bounty has not been paid, so nothing is released"
        );
        let claim_id = bounty
            .winning_claim
            .unwrap_or_else(|| env::panic_str("this bounty has no winning claim"));
        let claim = self.claims.get(&claim_id).expect("the winning claim");
        let input = json!({ "release": {
            "bounty": id,
            "claim_id": claim_id,
            "whitehat": crate::to_formats_account(&claim.whitehat),
            "exploit_public_key": bounty.rules.exploit_public_key,
        } })
        .to_string();
        self.request_exploit_job(ExploitJob::Release, id, claim_id, input)
    }

    /// A bounty's release, once requested: the winning exploit encrypted to the Protocol's
    /// exploit key, for `bountee open-exploit` to open. `null` before any release.
    pub fn released_exploit(&self, id: BountyId) -> Option<ReleaseView> {
        self.releases.get(&id).map(|r| ReleaseView {
            claim_id: r.claim_id,
            state: if r.output.is_some() {
                ReleaseState::Released
            } else {
                ReleaseState::Requested
            },
            released: r.output.clone(),
        })
    }
}
