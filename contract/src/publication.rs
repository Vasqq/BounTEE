//! The publication (#23): once a bounty's disclosure delay (1–90 days, fixed at posting) has
//! passed since its payout, anyone can have the winning exploit published, so anyone can
//! re-run it to the enclave's verdict without trusting anyone (D7, D7.1, ADR-0008).
//!
//! [`Contract::publish_exploit`] is refused before the payout and before the delay. The
//! caller passes the winning claim's proofs, the ones its `submit_claim` carried (the
//! contract kept only their sha256, so it checks them against it); the contract requests a
//! job running the pinned judge with the winning claim's own secret, and the judge writes
//! the exploit in the clear. The contract keeps that output beside the claim's proofs; with
//! the claim's block, header and verdict, already recorded, [`Contract::published_exploit`]
//! returns everything a re-run needs (`bountee rerun`). Nothing else ever requests a job
//! with a claim's secret after its verdict but the release, so a losing exploit is never
//! published (R5.6).
//!
//! The job's deposit and the publication's storage come from the bounty's posting fee, or
//! from NEAR attached to the call, which joins it (R11.4); the proofs of a live claim (about
//! 120 KB) cost more storage than the posting fee leaves, so the caller attaches it. A
//! publication that fails keeps nothing and can be asked again.

use bountee_formats::{BlockRef, BountyId, Bytes, PublishOutput, Verdict, B256};
use near_sdk::json_types::U64;
use near_sdk::serde_json::{self, json};
use near_sdk::{env, near, require, NearToken, Promise, PromiseResult};

use crate::{emit, fees, gas, outlayer, BountyState, Contract, ContractExt};

/// The most bytes a publication's output may take (as base64). A demo exploit's is about
/// 300 bytes.
pub const MAX_PUBLISHED_BYTES: u64 = 16 * 1024;
/// Storage a publication record takes beyond its output and proofs.
const PUBLICATION_RECORD_BYTES: u64 = 200;
/// A publication request older than this many blocks is treated as over (OutLayer's own
/// timeout is about 200 blocks), so a lost callback never blocks a new one.
pub const PUBLICATION_STALE_BLOCKS: u64 = 300;
/// A day of NEAR block time.
const DAY_NS: u64 = 86_400_000_000_000;

/// A bounty's publication: requested, then published.
#[near(serializers = [borsh])]
pub struct PublicationRecord {
    pub claim_id: u64,
    /// The block height the job under way was requested at.
    pub requested_at: Option<u64>,
    /// The winning claim's proofs, as its `submit_claim` carried them.
    pub proofs: String,
    /// The publication job's output: the winning exploit in the clear.
    pub published: Option<String>,
}

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
    /// sha256 of the claim's proofs, recorded when it was filed.
    pub proofs_sha256: B256,
    /// The claim's proofs, as it was filed with them; once requested.
    pub proofs: Option<String>,
    /// The verdict the enclave gave.
    pub verdict: Option<Verdict>,
    /// The judge's publication (base64 of raw DEFLATE of a `ReleasedExploit`); once published.
    pub published: Option<String>,
}

impl PublicationRecord {
    fn in_flight(&self) -> bool {
        self.requested_at
            .is_some_and(|h| env::block_height() < h.saturating_add(PUBLICATION_STALE_BLOCKS))
    }
}

fn storage_cost(bytes: u64) -> NearToken {
    NearToken::from_yoctonear(bytes as u128 * fees::STORAGE_PRICE_PER_BYTE)
}

/// What a publication request with `proofs_len` bytes of proofs holds from the posting fee:
/// the job's deposit and the most the publication's storage can cost. The unused part goes
/// back.
pub fn publish_hold(proofs_len: u64) -> NearToken {
    fees::JOB_DEPOSIT.saturating_add(storage_cost(
        MAX_PUBLISHED_BYTES + PUBLICATION_RECORD_BYTES + proofs_len,
    ))
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("0x{}", hex_lower(&env::sha256_array(bytes)))
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[near]
impl Contract {
    /// Request the publication of a paid bounty's winning exploit (D7). Anyone may call, once
    /// the bounty's disclosure delay has passed since its payout; it is refused before that,
    /// while a publication is under way and once published. `proofs` are the winning claim's
    /// proofs exactly as filed (public in its `submit_claim` transaction), kept with the
    /// publication so anyone can re-run it (D7.1). Any NEAR attached joins the bounty's
    /// posting fee, which pays for the job and the storage; `fees()` names the gas
    /// (`min_publish_gas`) and the hold (`publish_hold`, plus `publish_hold_per_proof_byte`).
    #[payable]
    pub fn publish_exploit(&mut self, id: BountyId, proofs: String) -> Promise {
        let bounty = self
            .bounties
            .get_mut(&id)
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
        if let Some(record) = self.publications.get(&id) {
            require!(
                record.published.is_none(),
                "this exploit is already published"
            );
            require!(!record.in_flight(), "a publication is already under way");
        }
        let claim = self
            .claims
            .get(&claim_id)
            .expect("the winning claim")
            .clone();
        require!(
            sha256_hex(proofs.as_bytes()) == claim.proofs_sha256.as_str(),
            "these aren't the proofs the winning claim was filed with"
        );
        require!(
            Self::gas_left(gas::TAIL) >= gas::release(),
            "attach more gas: see min_publish_gas in fees()"
        );
        let hold = publish_hold(proofs.len() as u64);
        bounty.draw_fee_or_refuse(hold, "the publication");
        let input = json!({ "publish": {
            "bounty": id,
            "claim_id": claim_id,
            "whitehat": crate::to_formats_account(&claim.whitehat),
        } })
        .to_string();
        let requested_at = env::block_height();
        self.publications.insert(
            id.clone(),
            PublicationRecord {
                claim_id,
                requested_at: Some(requested_at),
                proofs,
                published: None,
            },
        );
        emit(
            "publication_requested",
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
                .on_exploit_published(id, requested_at, hold),
        )
    }

    /// The publication job's result: its output is kept only if it is a publication. A
    /// failed, refused or malformed job keeps nothing and leaves the publication to be asked
    /// again. Whatever of `hold` isn't spent goes back to the bounty's posting fee. A
    /// callback for a request that is no longer the one in flight changes nothing but that
    /// refund.
    #[private]
    pub fn on_exploit_published(&mut self, id: BountyId, requested_at: u64, hold: NearToken) {
        #[allow(deprecated)]
        let (output, job_spent) = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => (
                serde_json::from_slice::<Option<PublishOutput>>(&bytes)
                    .ok()
                    .flatten()
                    .filter(|o| o.published.as_str().len() as u64 <= MAX_PUBLISHED_BYTES),
                fees::JOB_DEPOSIT,
            ),
            // OutLayer refused the request; its deposit came back here.
            PromiseResult::Failed => (None, NearToken::from_yoctonear(0)),
        };
        if self
            .publications
            .get(&id)
            .is_none_or(|r| r.requested_at != Some(requested_at))
        {
            self.refund_publish_hold(&id, hold.saturating_sub(job_spent));
            return;
        }
        let mut record = self.publications.remove(&id).expect("checked above");
        let mut storage = NearToken::from_yoctonear(0);
        match output {
            Some(output) => {
                let published = output.published.as_str().to_owned();
                storage = storage_cost(
                    published.len() as u64 + record.proofs.len() as u64 + PUBLICATION_RECORD_BYTES,
                );
                record.requested_at = None;
                record.published = Some(published);
                let claim_id = record.claim_id;
                self.publications.insert(id.clone(), record);
                emit(
                    "exploit_published",
                    json!({ "bounty": id, "claim_id": claim_id }),
                );
            }
            None => {
                // Nothing kept: the record goes, so the publication can be asked again.
                emit(
                    "publication_failed",
                    json!({ "bounty": id, "claim_id": record.claim_id }),
                );
            }
        }
        self.refund_publish_hold(&id, hold.saturating_sub(job_spent).saturating_sub(storage));
    }

    /// A paid bounty's publication: when it opens, and once published, the winning exploit
    /// with the claim's block, header, proofs and verdict, for anyone to re-run (D7.1).
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
            Some(r) if r.published.is_some() => PublicationState::Published,
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
            proofs: record.map(|r| r.proofs.clone()),
            verdict: claim.verdict.clone(),
            published: record.and_then(|r| r.published.clone()),
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

impl Contract {
    /// Give the unspent part of a publication's hold back to the bounty's posting fee.
    fn refund_publish_hold(&mut self, id: &BountyId, back: NearToken) {
        if let Some(bounty) = self.bounties.get_mut(id) {
            bounty.fee_reserve = bounty.fee_reserve.saturating_add(back);
        }
    }
}
