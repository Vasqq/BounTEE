//! Block confirmation (R2.8): in the enclave, before any replay, the judge asks the three
//! independent RPCs pinned in its build for the proof chain's hash at the claim's block
//! number, and checks the block is recent against the claim's submission time.
//!
//! - At least two answer and every answer is the claim's hash: confirmed.
//! - At least two agree on another hash: INVALID, `block_not_confirmed`.
//! - Anything else (fewer than two answers, or answers that disagree among themselves
//!   without two agreeing on another hash, or a chain with no pinned RPCs): no verdict;
//!   the job fails and the claim stays pending for a retry (R2.6).
//! - The block's timestamp more than [`RECENCY_LIMIT_SECS`] before the submission time,
//!   or after it: INVALID, `stale_block`.
//!
//! Where the RPC addresses come from (R2.8 inspection, ticket #14): only [`rpcs_for`],
//! which reads the constant [`PINNED`] table compiled into the build. Nothing in the job
//! input reaches it: [`confirm`] takes the chain ID and block, never a URL, and the job
//! format (`bountee_formats::JudgeClaim`, `deny_unknown_fields`) has no field that could
//! carry one. The test build (feature `test-stand-in-rpcs`, seam J only) swaps [`PINNED`]
//! for the `BOUNTEE_TEST_RPCS` environment variable; the attested build is made without
//! features, so that code is not in it, and an environment variable is never something a
//! claim or a Protocol sets.

use bountee_formats::{Reason, RECENCY_LIMIT_SECS};
use revm::primitives::B256;
use serde_json::json;

use crate::rpc;

/// The three independent RPCs pinned for each proof chain, by chain ID (spec, judge
/// RPCs; each answered from inside an OutLayer job, Nov 4). Arbitrum Sepolia's and the
/// mainnet chains' join here, picked the same way.
pub const PINNED: &[(u64, [&str; 3])] = &[(
    84532, // Base Sepolia
    [
        "https://sepolia.base.org",
        "https://base-sepolia-rpc.publicnode.com",
        "https://base-sepolia.gateway.tenderly.co",
    ],
)];

/// Why a block can't be confirmed either way: the job fails with no verdict (R2.6).
#[derive(Debug)]
pub enum Unconfirmed {
    /// The build pins no RPCs for the proof chain.
    NoPinnedRpcs,
    /// Fewer than two RPCs answered, or the answers disagree among themselves.
    TooFewOrDisagreeing,
}

const SECOND_NS: u128 = 1_000_000_000;

/// R2.8's recency bounds: the block's timestamp (seconds) must be no more than
/// [`RECENCY_LIMIT_SECS`] before the submission time (NEAR nanoseconds), and not after it.
pub fn recent(block_timestamp: u64, submitted_at_ns: u64) -> Result<(), Reason> {
    let block_ns = u128::from(block_timestamp) * SECOND_NS;
    let submitted = u128::from(submitted_at_ns);
    let limit = u128::from(RECENCY_LIMIT_SECS) * SECOND_NS;
    if block_ns > submitted || block_ns + limit < submitted {
        return Err(Reason::StaleBlock);
    }
    Ok(())
}

/// Ask the pinned RPCs for `chain_id`'s block `number` and judge their answers against
/// the claim's `hash`. `Ok(Ok(()))` is confirmed; `Ok(Err(reason))` is INVALID.
pub fn confirm(chain_id: u64, number: u64, hash: B256) -> Result<Result<(), Reason>, Unconfirmed> {
    let rpcs = rpcs_for(chain_id).ok_or(Unconfirmed::NoPinnedRpcs)?;
    let body = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_getBlockByNumber",
        "params": [format!("{number:#x}"), false],
    })
    .to_string();
    let requests: Vec<(String, String)> = rpcs.into_iter().map(|url| (url, body.clone())).collect();
    let answers: Vec<B256> = rpc::call_all(&requests)
        .into_iter()
        .flatten()
        .filter(|block| block["number"].as_str() == Some(format!("{number:#x}").as_str()))
        .filter_map(|block| block["hash"].as_str()?.parse().ok())
        .collect();
    decide(hash, &answers)
}

fn decide(claim: B256, answers: &[B256]) -> Result<Result<(), Reason>, Unconfirmed> {
    let contradicted = answers
        .iter()
        .any(|a| *a != claim && answers.iter().filter(|b| *b == a).count() >= 2);
    if contradicted {
        return Ok(Err(Reason::BlockNotConfirmed));
    }
    if answers.len() >= 2 && answers.iter().all(|a| *a == claim) {
        return Ok(Ok(()));
    }
    Err(Unconfirmed::TooFewOrDisagreeing)
}

/// The RPC addresses for `chain_id`: the pinned table, the only source in the attested
/// build.
#[cfg(not(feature = "test-stand-in-rpcs"))]
fn rpcs_for(chain_id: u64) -> Option<Vec<String>> {
    PINNED
        .iter()
        .find(|(id, _)| *id == chain_id)
        .map(|(_, urls)| urls.iter().map(|u| (*u).to_owned()).collect())
}

/// TEST BUILD ONLY (seam J): the test stand-ins' addresses from `BOUNTEE_TEST_RPCS`, for
/// any chain. Never compiled into the build OutLayer runs.
#[cfg(feature = "test-stand-in-rpcs")]
fn rpcs_for(_chain_id: u64) -> Option<Vec<String>> {
    let _ = PINNED;
    let urls = std::env::var("BOUNTEE_TEST_RPCS").ok()?;
    Some(
        urls.split(',')
            .filter(|u| !u.is_empty())
            .map(str::to_owned)
            .collect(),
    )
}
