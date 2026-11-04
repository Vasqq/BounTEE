//! Seam J, ticket #15: the compiled judge running the enclave's `judge_claim` action as
//! OutLayer runs it — the job on stdin, the caller in `NEAR_PREDECESSOR_ID` and the sealed
//! exploit in the secret `BOUNTEE_SEALED_EXPLOIT` (env vars), the verdict on stdout.
//!
//! Seams, written down before the first test:
//! - J (this file): the attested wasm build under wasmtime, fed sealed bundles written by
//!   the command-line tool's own sealing code (`fixtures/sealed/*.txt`, remade by
//!   `fixtures/make-sealed.ts`). Catches: R5.4 (the account bound in the sealed exploit
//!   must be the claimant), refusing a job with no secret or another caller (no verdict),
//!   and R5.5 at the judge (nothing but the verdict leaves it on ZERO or INVALID).
//!   The claim's block is confirmed by #14's local test stand-in RPCs, through the
//!   judge's test build (`test-stand-in-rpcs`, which differs from the attested build only
//!   in where its RPC list comes from); the sealed-exploit path is the same in both.
//!   Misses: OutLayer's decryption and access rule, which decide whether the secret
//!   reaches the judge at all (seam T, `cli/test/sealing-testnet.test.ts`).
//!
//! R15.3: every test reads only committed fixtures; no keys, funds or network.

mod common;
#[path = "stand-ins/test_rpc.rs"]
#[allow(dead_code)]
mod test_rpc;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use bountee_formats::{from_json, Outcome, Reason, Verdict};
use common::{repo_root, wasm_target};
use proptest::prelude::*;
use serde_json::{json, Value};
use test_rpc::{Answer, TestRpc};

/// The bounty contract a default build of the judge is pinned to (`judge/src/sealed.rs`).
const BOUNTY_CONTRACT: &str = "bounty.bountee.testnet";
/// The account the fixture bundles are sealed for.
const SEALED_FOR: &str = "alice.testnet";

/// Where the judge's test build goes (shared with `seam_j_block_confirmation.rs`).
const TEST_BUILD_DIR: &str = "target/judge-test-stand-in-rpcs";

/// The judge's test build: the attested build plus `test-stand-in-rpcs`.
fn judge_wasm() -> &'static PathBuf {
    static WASM: OnceLock<PathBuf> = OnceLock::new();
    WASM.get_or_init(|| {
        let target = wasm_target();
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let status = Command::new(cargo)
            .current_dir(repo_root())
            .env_remove("BOUNTEE_BOUNTY_CONTRACT")
            .args([
                "build",
                "--release",
                "-p",
                "bountee-judge",
                "--target",
                &target,
            ])
            .args(["--features", "test-stand-in-rpcs", "--target-dir"])
            .arg(repo_root().join(TEST_BUILD_DIR))
            .status()
            .expect("cargo runs");
        assert!(status.success(), "the judge builds for {target}");
        repo_root().join(format!(
            "{TEST_BUILD_DIR}/{target}/release/bountee-judge.wasm"
        ))
    })
}

struct Run {
    success: bool,
    stdout: String,
    stderr: String,
}

/// Run the compiled judge as an OutLayer job: `env` are the variables OutLayer sets. Three
/// stand-in RPCs confirm the claim's block.
fn run_job(job: &Value, env: &[(&str, &str)]) -> Run {
    let hash = job["judge_claim"]["block"]["hash"]
        .as_str()
        .unwrap()
        .to_owned();
    let rpcs = [0, 1, 2].map(|_| TestRpc::answering(Answer::Hash(hash.clone())));
    let urls: Vec<&str> = rpcs.iter().map(|r| r.url.as_str()).collect();
    let mut cmd = Command::new("wasmtime");
    cmd.args(["run", "-S", "http"])
        .arg("--env")
        .arg(format!("BOUNTEE_TEST_RPCS={}", urls.join(",")));
    for (k, v) in env {
        cmd.arg("--env").arg(format!("{k}={v}"));
    }
    let mut child = cmd
        .arg("--")
        .arg(judge_wasm())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("wasmtime is installed");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(job.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    Run {
        success: out.status.success(),
        stdout: String::from_utf8(out.stdout).unwrap(),
        stderr: String::from_utf8(out.stderr).unwrap(),
    }
}

fn fixture(path: &str) -> String {
    std::fs::read_to_string(repo_root().join("judge/tests/fixtures").join(path)).unwrap()
}

fn sealed(name: &str) -> String {
    fixture(&format!("sealed/{name}.txt")).trim().to_owned()
}

/// The fixture header's timestamp, in seconds, read from its RLP (field 11).
fn block_timestamp(header: &str) -> u64 {
    let rlp: Vec<u8> = (2..header.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&header[i..i + 2], 16).unwrap())
        .collect();
    let mut buf = &rlp[..];
    alloy_rlp::Header::decode(&mut buf).unwrap();
    for _ in 0..11 {
        let item = alloy_rlp::Header::decode(&mut buf).unwrap();
        buf = &buf[item.payload_length..];
    }
    let item = alloy_rlp::Header::decode(&mut buf).unwrap();
    buf[..item.payload_length]
        .iter()
        .fold(0, |n, b| (n << 8) | u64::from(*b))
}

/// A `judge_claim` job for the fixture block, as the bounty contract writes it, submitted
/// ten seconds after the block.
fn judge_claim(whitehat: &str) -> Value {
    let state: Value = serde_json::from_str(&fixture("state.json")).unwrap();
    let submitted = (block_timestamp(state["header"].as_str().unwrap()) + 10) * 1_000_000_000;
    let rules: Value = serde_json::from_str(&fixture("rules.json")).unwrap();
    json!({ "judge_claim": {
        "rules": rules,
        "bounty": { "protocol": "protocol.testnet", "name": "vault" },
        "whitehat": whitehat,
        "block": state["block"],
        "header": state["header"],
        "proofs_json": state["proofs"].to_string(),
        "submitted_at_ns": submitted.to_string(),
    }})
}

/// The job OutLayer runs when the bounty contract requested it and the secret opened.
fn as_contract_job(job: &Value, secret: &str) -> Run {
    run_job(
        job,
        &[
            ("NEAR_PREDECESSOR_ID", BOUNTY_CONTRACT),
            ("NEAR_SENDER_ID", SEALED_FOR),
            ("BOUNTEE_SEALED_EXPLOIT", secret),
        ],
    )
}

/// A verdict, and nothing else on stdout or stderr (R5.5).
fn only_verdict(run: &Run) -> Verdict {
    assert!(run.success, "the judge exits cleanly");
    assert_eq!(run.stderr, "", "nothing on stderr in the enclave");
    let verdict: Verdict = from_json(&run.stdout).expect("stdout is exactly one verdict");
    assert_eq!(
        run.stdout,
        format!(
            "{{\"outcome\":\"{}\",\"reason\":\"{}\"}}",
            serde_json::to_value(verdict.outcome())
                .unwrap()
                .as_str()
                .unwrap(),
            serde_json::to_value(verdict.reason())
                .unwrap()
                .as_str()
                .unwrap()
        ),
        "stdout is the verdict alone"
    );
    verdict
}

/// No verdict: OutLayer's job fails, so the bounty contract's callback gets `null` (R2.6),
/// and nothing at all is written.
fn refused(run: &Run) {
    assert!(!run.success, "the job fails");
    assert_eq!(run.stdout, "", "no verdict");
    assert_eq!(run.stderr, "", "nothing about the job is written");
}

/// Positive control for every test below: the claimant the exploit was sealed for, in a job
/// the bounty contract requested, is judged on the exploit (seedOnly scores ZERO, drain PAYS).
#[test]
fn r5_4_the_claimant_sealed_inside_is_judged_on_the_exploit() {
    let zero = only_verdict(&as_contract_job(
        &judge_claim(SEALED_FOR),
        &sealed("alice-seedOnly"),
    ));
    assert_eq!(zero.reason(), Reason::BelowMinimumTheft);
    let pays = as_contract_job(&judge_claim(SEALED_FOR), &sealed("alice-drain"));
    assert_eq!(only_verdict(&pays).outcome(), Outcome::Pays);
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 8, ..ProptestConfig::default() })]

    /// R5.4, R5.5: a claim filed by any account other than the one sealed inside is INVALID
    /// with the one coarse reason `account_mismatch`, even when the exploit would pay.
    #[test]
    fn r5_4_r5_5_another_claimant_is_invalid(
        whitehat in prop_oneof![
            "[a-z0-9]{2,20}\\.testnet",
            Just("alice.testnet.evil".to_owned()),
            Just("alice".to_owned()),
            Just("evil.alice.testnet".to_owned()),
        ].prop_filter("not the sealed account", |w| w != SEALED_FOR)
    ) {
        let run = as_contract_job(&judge_claim(&whitehat), &sealed("alice-drain"));
        let verdict = only_verdict(&run);
        prop_assert_eq!(verdict.reason(), Reason::AccountMismatch);
        prop_assert_eq!(verdict.outcome(), Outcome::Invalid);
    }
}

/// R2.6 (ADR-0012): OutLayer runs a job whose build finds no secret without it; the judge
/// fails that job with no verdict, so the claim stays pending with nothing moved.
#[test]
fn r2_6_a_job_with_no_secret_ends_with_no_verdict() {
    refused(&run_job(
        &judge_claim(SEALED_FOR),
        &[("NEAR_PREDECESSOR_ID", BOUNTY_CONTRACT)],
    ));
    refused(&run_job(
        &judge_claim(SEALED_FOR),
        &[
            ("NEAR_PREDECESSOR_ID", BOUNTY_CONTRACT),
            ("BOUNTEE_SEALED_EXPLOIT", ""),
        ],
    ));
}

/// R5.2 (defence in depth): a job anyone but the bounty contract requested is refused, even
/// holding the sealed exploit.
#[test]
fn r5_2_a_job_not_requested_by_the_bounty_contract_is_refused() {
    let secret = sealed("alice-drain");
    for caller in [
        SEALED_FOR,
        "mallory.testnet",
        "bounty.bountee.testnet.evil",
        "",
    ] {
        refused(&run_job(
            &judge_claim(SEALED_FOR),
            &[
                ("NEAR_PREDECESSOR_ID", caller),
                ("NEAR_SENDER_ID", BOUNTY_CONTRACT),
                ("BOUNTEE_SEALED_EXPLOIT", &secret),
            ],
        ));
    }
    refused(&run_job(
        &judge_claim(SEALED_FOR),
        &[("BOUNTEE_SEALED_EXPLOIT", &secret)],
    ));
}

/// R3.11, R5.5: a secret that isn't a sealed bundle is a malformed exploit, and only that.
#[test]
fn r3_11_r5_5_an_unreadable_sealed_exploit_is_malformed() {
    // Not base64; base64 but not DEFLATE; a deflated bundle with no exploit.
    for secret in [
        "not base64!",
        "AAAA",
        "Q1Yqz8gsSc1ILFGyUkrMyUxO1StJLS7JSy1RqgUA",
    ] {
        let verdict = only_verdict(&as_contract_job(&judge_claim(SEALED_FOR), secret));
        assert_eq!(verdict.reason(), Reason::MalformedExploit, "{secret}");
    }
}

/// R5.5: an INVALID replay (a read the claim doesn't prove) says only `unproven_state`:
/// the enclave never names the read, which would leak what the exploit touches.
#[test]
fn r5_5_an_unproven_read_in_the_enclave_names_nothing() {
    let mut job = judge_claim(SEALED_FOR);
    let mut proofs: Vec<Value> =
        serde_json::from_str(job["judge_claim"]["proofs_json"].as_str().unwrap()).unwrap();
    proofs.retain(|p| p["storage"].as_array().is_none_or(|s| s.is_empty()));
    job["judge_claim"]["proofs_json"] = Value::String(Value::Array(proofs).to_string());
    let verdict = only_verdict(&as_contract_job(&job, &sealed("alice-drain")));
    assert_eq!(verdict.reason(), Reason::UnprovenState);
}
