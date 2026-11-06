//! The enclave's claim job (`judge_claim`, #14): check the claim's header against its
//! hash, check the block is recent (R2.8), confirm it through the pinned RPCs
//! (`confirm.rs`), then run #8's replay against the state root of that confirmed header.
//!
//! Nothing here writes to stderr: in the enclave a diagnostic would tell what the sealed
//! exploit does. A job that ends without a verdict returns [`NoVerdict`]; `main` turns it
//! into a failed job (exit status 2, nothing on stdout), which OutLayer reports as a
//! failure and the bounty contract's callback receives as `null`: the claim stays pending
//! with no verdict (R2.6).

use bountee_formats::{from_json, AccountProof, Exploit, JudgeClaim, Reason, Verdict};
use revm::primitives::B256;

use crate::confirm::{self, Unconfirmed};
use crate::header;
use crate::replay::{self, hex};

/// Why a claim job ended with no verdict (R2.6). Every cause ends the job the same way
/// and none is printed in the enclave; the cause is kept for readers of the code.
#[derive(Debug)]
#[allow(dead_code)]
pub enum NoVerdict {
    /// The block could be neither confirmed nor contradicted (R2.8).
    Unconfirmed(Unconfirmed),
    /// The sealed exploit isn't there (OutLayer runs a job whose secret doesn't match
    /// without it, rather than failing it).
    NoSealedExploit,
    /// The replay itself refused the job.
    Replay(replay::NoVerdict),
}

/// Judge `job`, reading the exploit with `sealed_exploit` once the block is confirmed.
/// `sealed_exploit` answers `None` when there is no exploit to read, and
/// `Some(Err(reason))` for one that can't be judged.
pub fn judge(
    job: &JudgeClaim,
    sealed_exploit: impl FnOnce() -> Option<Result<Exploit, Reason>>,
) -> Result<Verdict, NoVerdict> {
    match run(job, sealed_exploit) {
        Ok(verdict) => Ok(verdict),
        Err(Ended::Reason(reason)) => Ok(Verdict::new(reason)),
        Err(Ended::NoVerdict(why)) => Err(why),
    }
}

enum Ended {
    Reason(Reason),
    NoVerdict(NoVerdict),
}

impl From<Reason> for Ended {
    fn from(reason: Reason) -> Self {
        Ended::Reason(reason)
    }
}

fn run(
    job: &JudgeClaim,
    sealed_exploit: impl FnOnce() -> Option<Result<Exploit, Reason>>,
) -> Result<Verdict, Ended> {
    // The header must hash to the claim's block hash and carry its number, as in a
    // local replay (R2.9); its timestamp is the block's.
    let hash: B256 = job
        .block
        .hash
        .as_str()
        .parse()
        .map_err(|_| Reason::UnprovenState)?;
    let header = hex(job.header.as_str())
        .and_then(|rlp| header::verified(&rlp, hash))
        .filter(|h| h.number == job.block.number.get())
        .ok_or(Reason::UnprovenState)?;

    // R2.8: recent against the submission time the bounty contract recorded.
    confirm::recent(header.timestamp, job.submitted_at_ns.get())?;

    // R2.8: the pinned RPCs confirm the hash, so the header's state root is the chain's.
    confirm::confirm(job.rules.proof_chain.get(), header.number, hash)
        .map_err(|why| Ended::NoVerdict(NoVerdict::Unconfirmed(why)))??;

    // R4.5: proofs that don't parse prove nothing.
    let proofs: Vec<AccountProof> =
        from_json(&job.proofs_json).map_err(|_| Reason::UnprovenState)?;

    let exploit = sealed_exploit().ok_or(Ended::NoVerdict(NoVerdict::NoSealedExploit))??;

    // No diagnostics in the enclave: they would leak what the sealed exploit does.
    let mut silent = |_: &dyn std::fmt::Display| {};
    replay::judge(
        &job.rules,
        &job.block,
        &job.header,
        &proofs,
        &exploit,
        &mut silent,
    )
    .map_err(|why| Ended::NoVerdict(NoVerdict::Replay(why)))
}
