//! Opening the sealed exploit in an enclave job (R5.2, R5.4, ADR-0012).
//!
//! OutLayer decrypts the claim's secret only for the pinned judge build in a job the bounty
//! contract requested, and hands it over as the environment variable
//! `BOUNTEE_SEALED_EXPLOIT`. Its value is what `bountee claim` sealed: base64 of the raw
//! DEFLATE of a [`SealedBundle`] (the Whitehat's account and the exploit). There is no
//! other way in: the judge never reads an exploit from the job input or as plain JSON.
//!
//! [`exploit`] is the one entry point, called by the `judge_claim` action. It checks, in
//! order:
//! 1. the job's caller (`NEAR_PREDECESSOR_ID`, the account that called `request_execution`)
//!    is the bounty contract pinned in this build; otherwise no verdict;
//! 2. a secret is present: OutLayer runs a job whose build finds no secret without it, so
//!    a missing secret means no verdict;
//! 3. the secret decodes to a bundle (else INVALID `malformed_exploit`, R3.11) whose
//!    account is the claimant the contract recorded (else INVALID `account_mismatch`,
//!    R5.4), checked before the exploit is read.
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

/// The claim's exploit, opened for a claim filed by `whitehat`: `None` when the job must
/// end with no verdict (not requested by the bounty contract, or no secret), `Some(Err)`
/// when the claim is INVALID for that reason.
pub fn exploit(whitehat: &AccountId) -> Option<Result<Exploit, Reason>> {
    let caller = std::env::var("NEAR_PREDECESSOR_ID").unwrap_or_default();
    if caller != BOUNTY_CONTRACT {
        return None;
    }
    let secret = std::env::var(SECRET_NAME).unwrap_or_default();
    if secret.is_empty() {
        return None;
    }
    Some(open(&secret, whitehat))
}

fn open(secret: &str, whitehat: &AccountId) -> Result<Exploit, Reason> {
    let malformed = Reason::MalformedExploit;
    let compressed = base64::engine::general_purpose::STANDARD
        .decode(secret.trim())
        .map_err(|_| malformed)?;
    let json = miniz_oxide::inflate::decompress_to_vec_with_limit(&compressed, MAX_BUNDLE_BYTES)
        .map_err(|_| malformed)?;
    // The account first: a copy filed by anyone else is INVALID for that alone, whatever
    // the exploit holds.
    let value: Value = serde_json::from_slice(&json).map_err(|_| malformed)?;
    match value.get("whitehat").and_then(Value::as_str) {
        Some(sealed_for) if sealed_for == whitehat.as_str() => {}
        Some(_) => return Err(Reason::AccountMismatch),
        None => return Err(malformed),
    }
    let bundle: SealedBundle = serde_json::from_value(value).map_err(|_| malformed)?;
    Ok(bundle.exploit)
}
