//! The exact requests the contract sends OutLayer (spec, "Sealed exploits are stored as
//! OutLayer secrets"; spike #1). The shapes follow `fastnear/near-outlayer`'s
//! `request_execution` and `store_secrets` as read on Nov 4.
//!
//! The judge's input on stdin is one JSON object with one key naming the action:
//! - `{"posting_check":{"bounty":BountyId,"rules":Rules}}`;
//! - `{"judge_claim":{"rules":Rules,"bounty":BountyId,"whitehat":"<account>","block":BlockRef,
//!   "header":"0x…","proofs_json":"<the claim's proofs array, as the JSON text submitted>",
//!   "submitted_at_ns":"<U64>"}}`.
//!
//! The sealed exploit is never in the input: it reaches the judge as the secret
//! `BOUNTEE_SEALED_EXPLOIT` of the claim's own profile. The judge's stdout is one
//! [`bountee_formats::Verdict`] in JSON, asked for with `response_format: "Json"`, so the
//! callback receives it unchanged; a refused or failed job arrives as `null`.

use bountee_formats::B256;
use near_sdk::serde_json::{json, Value};
use near_sdk::{env, AccountId, Gas, GasWeight, NearToken, Promise};

use crate::Config;

/// Resource limits for every job; `fees::JOB_DEPOSIT` covers them.
pub const MAX_INSTRUCTIONS: u64 = 100_000_000_000;
pub const MAX_MEMORY_MB: u32 = 512;
pub const MAX_EXECUTION_SECONDS: u64 = 60;

/// The judge hash as OutLayer spells it: 64 lowercase hex digits, no `0x`.
fn judge_hash(hash: &B256) -> &str {
    &hash.as_str()[2..]
}

/// The access rule fixed in code: only the pinned judge build, in a job this contract
/// requested, opens the secret (ADR-0012). No leaf names the signer, so any Whitehat claims.
pub fn access_rule(hash: &B256) -> Value {
    json!({ "Logic": { "operator": "And", "conditions": [
        { "WasmHash": { "hash": judge_hash(hash) } },
        { "Predecessor": { "condition": { "Whitelist": {
            "accounts": [env::current_account_id()]
        } } } },
    ] } })
}

/// Store a claim's sealed exploit as this contract's secret under `profile`. The caller
/// must use a profile never stored before: OutLayer overwrites an existing row silently.
pub fn store_sealed_exploit(
    outlayer: &AccountId,
    hash: &B256,
    profile: &str,
    sealed_exploit: &str,
    deposit: NearToken,
    gas: Gas,
) -> Promise {
    let args = json!({
        "accessor": { "WasmHash": { "hash": judge_hash(hash) } },
        "profile": profile,
        "encrypted_secrets_base64": sealed_exploit,
        "access": access_rule(hash),
        "vault_id": null,
    });
    Promise::new(outlayer.clone()).function_call(
        "store_secrets".to_owned(),
        args.to_string().into_bytes(),
        deposit,
        gas,
    )
}

/// Request a job running the pinned judge build on `input`, optionally with the claim's
/// secret profile. OutLayer refunds what the job doesn't use to `payer`.
///
/// The request gets `floor` as static gas plus, by weight, all the gas the calling method
/// leaves unused. near-sdk builds promises lazily, when the method returns, and that is when
/// a receipt's per-byte costs are charged; a static figure worked out earlier from the gas
/// left can't see them coming, and a mainnet claim's large input overran it (#35). Unused
/// gas is shared out after those costs are paid, so nothing has to be foreseen.
pub fn request_job(
    config: &Config,
    input: &str,
    secret_profile: Option<&str>,
    payer: &AccountId,
    deposit: NearToken,
    floor: Gas,
) -> Promise {
    let args = json!({
        "source": { "WasmUrl": {
            "url": config.judge_wasm_url,
            "hash": judge_hash(&config.judge_build_hash),
            "build_target": "wasm32-wasip2",
        } },
        "resource_limits": {
            "max_instructions": MAX_INSTRUCTIONS,
            "max_memory_mb": MAX_MEMORY_MB,
            "max_execution_seconds": MAX_EXECUTION_SECONDS,
        },
        "input_data": input,
        "secrets_ref": secret_profile.map(|p| json!({
            "profile": p,
            "account_id": env::current_account_id(),
        })),
        "response_format": "Json",
        "payer_account_id": payer,
        "params": null,
    });
    let args = args.to_string().into_bytes();
    Promise::new(config.outlayer.clone()).function_call_weight(
        "request_execution".to_owned(),
        args,
        deposit,
        floor,
        GasWeight(1),
    )
}
