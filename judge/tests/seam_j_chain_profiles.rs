//! Seam J, ticket #61: how a chain is judged comes from the chain (D29). A real Arbitrum
//! header has 16 fields, and Arbitrum runs Osaka's rules with its own per-transaction gas
//! cap and a randomness of 1; every other chain replays as before.
//!
//! Seams, written down before the first test:
//! - J (this file): the compiled wasm32-wasip2 judge under wasmtime, fed the job that a live
//!   `bountee test --out` saved from a real recent Arbitrum Sepolia block (its 16-field
//!   header, its proofs, the public missing-access-check vault's drain and its rules),
//!   committed under `fixtures/arbitrum-sepolia/`. Every transaction in it carries the CLI's
//!   gas, the block's gas limit (0x4000000000000 on Arbitrum), so the job only pays if the
//!   judge clamps each transaction to the chain's cap rather than refusing it.
//!   Catches: a real Arbitrum header refused or misread, the cap not applied, either
//!   Arbitrum profile missing from the default or the mainnet build, a header with fewer
//!   fields than its chain's profile accepted, a chain without a profile judged otherwise
//!   than before, and the attested build outgrowing NEAR's transaction limit with Osaka on.
//!   Misses: the real RPCs (the live run, recorded in the ticket's work, is seam T) and the
//!   Arbitrum differences the replay doesn't emulate (its block-number opcode, system and
//!   Stylus contracts; R15.7). Every existing scenario keeping its verdict is the rest of
//!   seam J's suite, unchanged.
//!
//! R15.3: offline, from committed fixtures only.

mod common;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

use alloy_rlp::Header as RlpHeader;
use bountee_formats::{from_json, Outcome, Reason, Verdict};
use common::{attested_build, mainnet_test_build, repo_root};
use revm::primitives::{hex, keccak256};
use serde_json::Value;

/// NEAR's transaction size limit: the judge uploads to FastFS in one transaction (spec).
const NEAR_TRANSACTION_LIMIT: u64 = 1_572_864;

fn run(wasm: &PathBuf, job: &Value) -> Verdict {
    let mut child = Command::new("wasmtime")
        .args(["run", "-S", "http", "--"])
        .arg(wasm)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("wasmtime is installed");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(job.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.status.success(),
        "the judge exits cleanly, never a trap"
    );
    from_json(String::from_utf8(out.stdout).unwrap().trim()).expect("stdout is a verdict")
}

/// The job a live `bountee test demo/script/DrainStrategy.s.sol --out …` saved on Nov 9
/// against Arbitrum Sepolia block 327577406: a public DemoVault (the missing access check,
/// R4.10 row 21) deployed there for this test at 0x3c7d…0857 holding 1,000,000 MockUSDC,
/// drained by one transaction from a fresh account; MockUSDC listed at 1, native at 0,
/// minimum theft 1,000 USDC.
fn arbitrum_sepolia_drain() -> Value {
    let file = repo_root().join("judge/tests/fixtures/arbitrum-sepolia/drain.json");
    serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
}

/// The job relabelled to `chain`: its block's chain (its proof chain), its covered
/// contract's and its listed tokens'. A replay job asks no RPC, so only the profile the
/// judge picks for `chain` changes.
fn on_chain(mut job: Value, chain: u64) -> Value {
    job["replay"]["block"]["chain_id"] = chain.into();
    let rules = &mut job["replay"]["rules"];
    for list in ["covered_contracts", "listed_tokens"] {
        for item in rules[list].as_array_mut().unwrap() {
            item["chain_id"] = chain.into();
        }
    }
    job
}

#[test]
fn d29_r4_10_row_21_a_drain_on_a_real_arbitrum_sepolia_block_pays() {
    let verdict = run(attested_build(), &arbitrum_sepolia_drain());
    assert_eq!(verdict.outcome(), Outcome::Pays, "{verdict:?}");
}

#[test]
fn d29_the_default_and_mainnet_builds_both_judge_an_arbitrum_one_job() {
    // Arbitrum One's profile, in both networks' builds: its 16-field header would be
    // refused under the default every chain without a profile gets.
    let job = on_chain(arbitrum_sepolia_drain(), 42161);
    for wasm in [attested_build(), mainnet_test_build()] {
        let verdict = run(wasm, &job);
        assert_eq!(verdict.outcome(), Outcome::Pays, "{wasm:?}: {verdict:?}");
    }
}

/// The job with its header cut to its first `fields` fields, and its block hash set to the
/// cut header's, so only the field count is wrong.
fn with_header_fields(mut job: Value, fields: usize) -> Value {
    let rlp = hex::decode(job["replay"]["header"].as_str().unwrap()).unwrap();
    let mut buf = rlp.as_slice();
    RlpHeader::decode(&mut buf).unwrap();
    let mut items: Vec<&[u8]> = Vec::new();
    while !buf.is_empty() {
        let item = RlpHeader::decode(&mut &buf[..]).unwrap();
        let len = item.length() + item.payload_length;
        items.push(&buf[..len]);
        buf = &buf[len..];
    }
    let body: Vec<u8> = items[..fields].concat();
    let mut cut = Vec::new();
    RlpHeader {
        list: true,
        payload_length: body.len(),
    }
    .encode(&mut cut);
    cut.extend_from_slice(&body);
    job["replay"]["block"]["hash"] = format!("{:#x}", keccak256(&cut)).into();
    job["replay"]["header"] = hex::encode_prefixed(&cut).into();
    job
}

#[test]
fn d29_an_arbitrum_header_with_too_few_fields_is_invalid() {
    let job = with_header_fields(arbitrum_sepolia_drain(), 15);
    let verdict = run(attested_build(), &job);
    assert_eq!(verdict.reason(), Reason::UnprovenState, "{verdict:?}");
}

#[test]
fn d29_a_chain_with_no_profile_still_wants_seventeen_header_fields() {
    // Relabelled to Base Sepolia, which has no profile: the real 16-field header is
    // refused, as every chain without a profile refused it before D29.
    let job = on_chain(arbitrum_sepolia_drain(), 84532);
    let verdict = run(attested_build(), &job);
    assert_eq!(verdict.reason(), Reason::UnprovenState, "{verdict:?}");
}

#[test]
fn d29_the_attested_build_fits_in_one_near_transaction() {
    let size = std::fs::metadata(attested_build()).unwrap().len();
    assert!(
        size < NEAR_TRANSACTION_LIMIT,
        "the judge is {size} bytes, over NEAR's {NEAR_TRANSACTION_LIMIT}"
    );
}
