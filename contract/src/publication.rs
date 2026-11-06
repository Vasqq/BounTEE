//! The publication (#23): once a bounty's disclosure delay (1–90 days, fixed at posting) has
//! passed since its payout, anyone can have the winning exploit published, so anyone can
//! re-run it to the enclave's verdict without trusting anyone (D7, D7.1, ADR-0008).
//!
//! [`Contract::publish_exploit`] is refused before the payout and before the delay. The
//! caller passes the winning claim's proofs, the ones its `submit_claim` carried (the
//! contract kept only their sha256, so it checks them against it), so the publication's own
//! transaction carries them too; the contract requests a job running the pinned judge with
//! the winning claim's own secret, and the judge writes the exploit in the clear. The
//! contract keeps that output; with the claim's block, header, verdict, proofs sha256 and
//! submission block, already recorded, [`Contract::published_exploit`] returns everything a
//! re-run needs but the proofs themselves, which `bountee rerun` fetches from the claim's
//! `submit_claim` transaction and checks against the sha256 (D7.1). Nothing else ever
//! requests a job with a claim's secret after its verdict but the release, so a losing
//! exploit is never published (R5.6).
//!
//! The proofs are kept nowhere and not put in the job (the judge's publication needs none,
//! and OutLayer would hold storage for a live claim's 120 KB of input), so the job's deposit
//! and the small record are all the publication costs: the bounty's posting fee pays them
//! (R11.4). NEAR attached to the call joins the posting fee. A publication that fails keeps
//! nothing and can be asked again.

use bountee_formats::{BlockRef, BountyId, Bytes, Verdict, B256};
use near_sdk::json_types::U64;
use near_sdk::serde_json::json;
use near_sdk::{env, near, require, Promise};

use crate::exploit_job::ExploitJob;
use crate::{sha256_hex, BountyState, Contract, ContractExt};

/// A day of NEAR block time.
const DAY_NS: u64 = 86_400_000_000_000;

/// Where a paid bounty's publication is.
#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
#[derive(PartialEq)]
pub enum PublicationState {
    /// The disclosure delay hasn't passed since the payout.
    Delayed,
    /// Anyone may ask for it.
    Publishable,
    /// The job is under way.
    Requested,
    /// Published, for anyone to re-run.
    Published,
}

/// A paid bounty's publication as its view returns it: once published, everything a re-run
/// needs beside the bounty's rules (D7.1).
#[near(serializers = [json])]
pub struct PublicationView {
    pub claim_id: u64,
    pub state: PublicationState,
    /// From when anyone may trigger the publication: the payout plus the disclosure delay.
    pub publishable_from_ns: U64,
    pub block: BlockRef,
    /// The claim's block header, RLP-encoded.
    pub header: Bytes,
    /// sha256 of the claim's proofs, recorded when it was filed. The proofs themselves are in
    /// the claim's `submit_claim` transaction (and in the publication's own).
    pub proofs_sha256: B256,
    /// The NEAR block the claim's submission ran in, where its `submit_claim` transaction is
    /// found (an archival RPC serves old blocks).
    pub submitted_at_block: U64,
    /// The verdict the enclave gave.
    pub verdict: Option<Verdict>,
    /// The judge's publication (base64 of raw DEFLATE of a `ReleasedExploit`); once published.
    pub published: Option<String>,
}

#[near]
impl Contract {
    /// Request the publication of a paid bounty's winning exploit (D7). Anyone may call, once
    /// the bounty's disclosure delay has passed since its payout; it is refused before that,
    /// while a publication is under way and once published. `proofs` are the winning claim's
    /// proofs exactly as filed (public in its `submit_claim` transaction), checked against the
    /// claim's sha256 and not kept. The bounty's posting fee pays for the job and the
    /// record's storage, and any NEAR attached joins it; `fees()` names the gas
    /// (`min_publish_gas`) and the hold (`publish_hold`).
    #[payable]
    pub fn publish_exploit(&mut self, id: BountyId, proofs: String) -> Promise {
        let bounty = self
            .bounties
            .get(&id)
            .unwrap_or_else(|| env::panic_str("no such bounty"));
        require!(
            bounty.state == BountyState::Paid,
            "this bounty has not been paid, so nothing is published"
        );
        let claim_id = bounty
            .winning_claim
            .unwrap_or_else(|| env::panic_str("this bounty has no winning claim"));
        let from = publishable_from(bounty.paid_at_ns, bounty.rules.disclosure_delay_days);
        require!(
            env::block_timestamp() >= from,
            &format!("the disclosure delay hasn't passed: publication opens at {from} ns")
        );
        let claim = self.claims.get(&claim_id).expect("the winning claim");
        require!(
            sha256_hex(proofs.as_bytes()) == claim.proofs_sha256,
            "these aren't the proofs the winning claim was filed with"
        );
        let input = json!({ "publish": {
            "bounty": id,
            "claim_id": claim_id,
            "whitehat": crate::to_formats_account(&claim.whitehat),
        } })
        .to_string();
        self.request_exploit_job(ExploitJob::Publication, id, claim_id, input)
    }

    /// A paid bounty's publication: when it opens, and once published, the winning exploit
    /// with the claim's block, header, verdict, proofs sha256 and submission block, for anyone
    /// to re-run with the proofs from the claim's transaction (D7.1).
    /// `null` until the bounty is paid.
    pub fn published_exploit(&self, id: BountyId) -> Option<PublicationView> {
        let bounty = self.bounties.get(&id)?;
        if bounty.state != BountyState::Paid {
            return None;
        }
        let claim_id = bounty.winning_claim?;
        let claim = self.claims.get(&claim_id)?;
        let from = publishable_from(bounty.paid_at_ns, bounty.rules.disclosure_delay_days);
        let record = self.publications.get(&id);
        let state = match record {
            Some(r) if r.output.is_some() => PublicationState::Published,
            Some(r) if r.in_flight() => PublicationState::Requested,
            _ if env::block_timestamp() < from => PublicationState::Delayed,
            _ => PublicationState::Publishable,
        };
        Some(PublicationView {
            claim_id,
            state,
            publishable_from_ns: U64(from),
            block: claim.block.clone(),
            header: claim.header.clone(),
            proofs_sha256: claim.proofs_sha256.clone(),
            submitted_at_block: claim.submitted_at_block,
            verdict: claim.verdict.clone(),
            published: record.and_then(|r| r.output.clone()),
        })
    }
}

/// When a bounty paid at `paid_at_ns` may be published: `days` after it. A paid bounty
/// always has its payout time; were it missing, publication would never open.
fn publishable_from(paid_at_ns: Option<u64>, days: u16) -> u64 {
    paid_at_ns.map_or(u64::MAX, |paid| {
        paid.saturating_add(u64::from(days).saturating_mul(DAY_NS))
    })
}
