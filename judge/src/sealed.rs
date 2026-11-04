//! The exploit of an enclave claim job, read from OutLayer's secrets.
//!
//! OutLayer hands the job its secrets as environment variables; the claim's is
//! `BOUNTEE_SEALED_EXPLOIT` (spec, judge "Caller and secret"). Until #15, the variable
//! holds the exploit's JSON as is. #15 replaces this module: it unpacks the sealed
//! bundle, checks the account bound inside it against the claim's Whitehat (R5.4) and
//! checks the job's caller.

use bountee_formats::{from_json, Exploit, Reason};

/// The claim's exploit: `None` when the secret is missing (OutLayer runs a job whose
/// secret doesn't match without it, so the judge must refuse it), `Some(Err)` for one
/// that isn't an exploit (R3.11).
pub fn exploit() -> Option<Result<Exploit, Reason>> {
    let secret = std::env::var("BOUNTEE_SEALED_EXPLOIT").ok()?;
    Some(from_json(&secret).map_err(|_| Reason::MalformedExploit))
}
