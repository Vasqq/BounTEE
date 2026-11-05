//! BounTEE's shared formats, defined once.
//!
//! - [`Rules`]: a bounty's rules, every field R1.1 records.
//! - [`Claim`]: what a Whitehat submits: the bounty, their account, the claim's block, its
//!   header and state proofs, and the sealed exploit.
//! - [`Job`]: the judge's stdin; [`Replay`] is a local replay of an [`Exploit`], the
//!   transactions a Foundry script broadcasts; [`JudgeClaim`] is the enclave's claim job and
//!   [`Release`] its release job, whose output [`ReleaseOutput`] holds a [`ReleasedExploit`].
//! - [`Verdict`]: the judge's answer, PAYS, ZERO or INVALID with one coarse reason (R5.5).
//! - [`pause_role`]: D25, a bounty's pause-role address under NEAR Chain Signatures.
//!
//! The wire format is JSON. This crate is the definition; `formats/ts` is its TypeScript
//! twin, and the round-trip tests in `formats/ts/test` hold the two to the same bytes.
//! Shared fixtures live in `formats/fixtures`.
//!
//! Its tests sit at this public interface, a seam outside J, C, T, W and E on purpose: this
//! is a format both the Rust side (judge, contract) and the TypeScript side (command-line
//! tool, web app) must read, so drift between the two (shape, field order, validation,
//! the D25 derivation) shows only where one side's output meets the other's parser. The
//! five seams each drive one side, so none of them would catch it.

mod claim;
mod job;
mod primitives;
mod rules;
mod verdict;

#[cfg(feature = "pause-role")]
pub mod pause_role;

pub use claim::{AccountProof, BlockRef, Claim, StorageProof};
pub use job::{
    Exploit, ExploitTransaction, Job, JudgeClaim, Release, ReleaseOutput, ReleasedExploit, Replay,
    SealedBundle,
};
pub use primitives::{
    is_account_id, is_bounty_name, AccountId, Base64, BountyName, Bytes, EvmAddress, FormatError,
    PublicKey, SafeU64, Uint, B256, MAX_SAFE_INTEGER, U64,
};
pub use rules::{
    BountyId, CoveredContract, ListedToken, Rules, Seed, Token, TokenAmount, RECENCY_LIMIT_SECS,
};
pub use verdict::{Outcome, Reason, Verdict};

/// Parse one of the formats from its JSON spelling, refusing unknown fields.
pub fn from_json<T: serde::de::DeserializeOwned>(json: &str) -> Result<T, FormatError> {
    serde_json::from_str(json).map_err(|e| FormatError(e.to_string()))
}

/// Write one of the formats as JSON, fields in their defined order.
pub fn to_json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("formats always serialize")
}
