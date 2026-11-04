//! Opening the sealed exploit in an enclave job (R5.2, R5.4, ADR-0012).
//!
//! OutLayer decrypts the claim's secret only for the pinned judge build in a job the bounty
//! contract requested, and hands it over as the environment variable
//! `BOUNTEE_SEALED_EXPLOIT`. Its value is what `bountee claim` sealed: base64 of the raw
//! DEFLATE of a [`SealedBundle`] (the Whitehat's account and the exploit).
//!
//! [`open`] is the one entry point, called by the `judge_claim` action before anything
//! else. It checks, in order:
//! 1. the job's caller (`NEAR_PREDECESSOR_ID`, the account that called `request_execution`)
//!    is the bounty contract pinned in this build; otherwise no verdict;
//! 2. a secret is present: OutLayer runs a job whose build finds no secret without it, so
//!    a missing secret means no verdict;
//! 3. the secret decodes to a bundle (else INVALID `malformed_exploit`, R3.11) whose
//!    account is the claimant the contract recorded (else INVALID `account_mismatch`, R5.4).
//!
//! Nothing here writes anything: what the sealed exploit holds must never reach a job's
//! output beyond the verdict's one coarse reason (R5.5).

use base64::Engine;
use bountee_formats::{AccountId, Exploit, Reason, SealedBundle};
use serde_json::Value;

/// The bounty contract this build is pinned to: the only caller whose jobs it judges. Set
/// at build time with `BOUNTEE_BOUNTY_CONTRACT`; the bounty contract in turn pins this
/// build's hash, so each deployment has its own build.
pub const BOUNTY_CONTRACT: &str = match option_env!("BOUNTEE_BOUNTY_CONTRACT") {
    Some(account) => account,
    None => "bounty.bountee.testnet",
};

/// The OutLayer secret holding the sealed exploit.
pub const SECRET_NAME: &str = "BOUNTEE_SEALED_EXPLOIT";

/// The most bytes a sealed bundle may inflate to (a NEAR transaction carries at most 1.5
/// MiB, so no real bundle comes near this).
const MAX_BUNDLE_BYTES: usize = 8 << 20;

/// Why the sealed exploit wasn't opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NotOpened {
    /// Not a job the bounty contract requested, or no secret: the job ends with no verdict.
    Refused,
    /// The claim is judged INVALID for this reason.
    Invalid(Reason),
}

/// Open the job's sealed exploit for a claim filed by `whitehat`, reading the job's
/// environment as OutLayer sets it.
pub fn open(whitehat: &AccountId) -> Result<Exploit, NotOpened> {
    let caller = std::env::var("NEAR_PREDECESSOR_ID").unwrap_or_default();
    if caller != BOUNTY_CONTRACT {
        return Err(NotOpened::Refused);
    }
    let secret = std::env::var(SECRET_NAME).unwrap_or_default();
    if secret.is_empty() {
        return Err(NotOpened::Refused);
    }
    let malformed = NotOpened::Invalid(Reason::MalformedExploit);
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(secret.trim())
        .map_err(|_| malformed)?;
    let json = miniz_oxide::inflate::decompress_to_vec_with_limit(&compressed, MAX_BUNDLE_BYTES)
        .map_err(|_| malformed)?;
    // The account is checked before the exploit is read: a copy filed by anyone else is
    // INVALID for that alone, whatever the exploit holds.
    let value: Value = serde_json::from_slice(&json).map_err(|_| malformed)?;
    match value.get("whitehat").and_then(Value::as_str) {
        Some(sealed_for) if sealed_for == whitehat.as_str() => {}
        Some(_) => return Err(NotOpened::Invalid(Reason::AccountMismatch)),
        None => return Err(malformed),
    }
    let bundle: SealedBundle = serde_json::from_value(value).map_err(|_| malformed)?;
    Ok(bundle.exploit)
}
