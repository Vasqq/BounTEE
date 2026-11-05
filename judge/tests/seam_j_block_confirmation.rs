//! Seam J, ticket #14: in the enclave the judge confirms the claim's block through the
//! RPCs pinned in its build before it replays the claim (R2.8), and a job that can't be
//! confirmed ends with no verdict (R2.6).
//!
//! Seams, written down before the first test:
//! - J (this file): the compiled wasm32-wasip2 judge under `wasmtime run -S http`, fed a
//!   `judge_claim` job (the bounty contract's shape, #12) built from the #8 fixtures, with
//!   the exploit in `BOUNTEE_SEALED_EXPLOIT`. The pinned RPCs are outside the system, so
//!   three local test stand-ins (`stand-ins/test_rpc.rs`) answer for them: matching,
//!   disagreeing, erroring or down. The judge reaches them only in its test build, made
//!   with the feature `test-stand-in-rpcs`, which reads their addresses from
//!   `BOUNTEE_TEST_RPCS`; the attested build compiles that feature out.
//!   Catches: the 2-of-3 rule and its INVALID and no-verdict outcomes, the 5-minute
//!   recency bounds against the submission time, the confirmed header feeding #8's
//!   replay, how a no-verdict job ends (exit status, empty stdout), and that nothing goes
//!   to stderr in enclave mode; and, on the attested build, that it never reads the test
//!   override. Misses: the real pinned RPCs and OutLayer's network (proved once on
//!   testnet, recorded in the spec), the attested build's own confirmation path (the test
//!   build differs from it only in where the RPC list comes from), and the sealed
//!   exploit and account binding (#15, `seam_j_sealing.rs`).
//! - Inspection (R2.8, recorded in the judge's `confirm.rs`): no RPC address is read from
//!   the job input, a claim or a Protocol.

mod common;
#[path = "stand-ins/test_rpc.rs"]
mod test_rpc;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

use bountee_formats::{from_json, Reason, Verdict};
use common::{attested_build, repo_root, test_build};
use serde_json::{json, Value};
use test_rpc::{Answer, TestRpc};

/// The bounty contract a default build of the judge is pinned to (`src/sealed.rs`).
const BOUNTY_CONTRACT: &str = "bounty.bountee.testnet";

/// `exploit` sealed for the job's Whitehat as `bountee claim` seals it (#15): base64 of the
/// raw DEFLATE of the sealed bundle's JSON.
fn sealed(job: &Value, exploit: &Value) -> String {
    use base64::Engine;
    let bundle = json!({ "whitehat": job["judge_claim"]["whitehat"], "exploit": exploit });
    let compressed = miniz_oxide::deflate::compress_to_vec(bundle.to_string().as_bytes(), 9);
    base64::engine::general_purpose::STANDARD.encode(compressed)
}

/// Run `wasm` on `job` with the test stand-ins' addresses in `BOUNTEE_TEST_RPCS` and, when
/// given, `exploit` sealed as the job's secret, in a job the bounty contract requested.
fn run(wasm: &PathBuf, job: &Value, rpcs: &[&TestRpc], exploit: Option<&Value>) -> Output {
    let urls: Vec<&str> = rpcs.iter().map(|r| r.url.as_str()).collect();
    let mut command = Command::new("wasmtime");
    command
        .args(["run", "-S", "http"])
        .arg("--env")
        .arg(format!("BOUNTEE_TEST_RPCS={}", urls.join(",")))
        .arg("--env")
        .arg(format!("NEAR_PREDECESSOR_ID={BOUNTY_CONTRACT}"));
    if let Some(exploit) = exploit {
        command
            .arg("--env")
            .arg(format!("BOUNTEE_SEALED_EXPLOIT={}", sealed(job, exploit)));
    }
    let mut child = command
        .arg("--")
        .arg(wasm)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("wasmtime is installed (see findings/layout.md)");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(job.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(
        out.stderr.is_empty(),
        "nothing goes to stderr in enclave mode: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

/// The verdict of a job that ended with one.
fn verdict(out: &Output) -> Verdict {
    assert!(out.status.success(), "a job with a verdict exits cleanly");
    let stdout = String::from_utf8(out.stdout.clone()).unwrap();
    assert!(
        stdout.len() <= 900,
        "OutLayer truncates output over 900 bytes"
    );
    from_json(stdout.trim()).expect("stdout is a verdict")
}

fn assert_verdict(out: &Output, reason: Reason) {
    let verdict = verdict(out);
    assert_eq!(verdict.reason(), reason, "{verdict:?}");
    assert_eq!(verdict.outcome(), reason.outcome());
}

/// R2.6: a job with no verdict fails (non-zero exit) with nothing on stdout, so OutLayer
/// reports the job failed and the bounty contract's callback sees no verdict.
fn assert_no_verdict(out: &Output) {
    assert!(!out.status.success(), "a job with no verdict fails");
    assert!(
        out.stdout.is_empty(),
        "a job with no verdict prints nothing"
    );
}

// ---- Fixtures ----------------------------------------------------------------------------

fn fixture(path: &str) -> Value {
    let file = repo_root().join("judge/tests/fixtures").join(path);
    serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap()
}

/// The fixture block's hash, as the claim names it.
fn claim_hash() -> String {
    fixture("state.json")["block"]["hash"]
        .as_str()
        .unwrap()
        .to_owned()
}

const OTHER_HASH: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

/// The fixture header's timestamp, in seconds, read from its RLP (field 11).
fn block_timestamp() -> u64 {
    let header = fixture("state.json")["header"].as_str().unwrap().to_owned();
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

const SECOND_NS: u64 = 1_000_000_000;

/// The bounty contract's `judge_claim` job for the fixture claim, submitted
/// `delay_ns` after its block's timestamp.
fn claim_job(delay_ns: i64) -> Value {
    let state = fixture("state.json");
    let submitted = (block_timestamp() * SECOND_NS) as i64 + delay_ns;
    json!({ "judge_claim": {
        "rules": fixture("rules.json"),
        "bounty": { "protocol": "protocol.testnet", "name": "demo-vault-1" },
        "whitehat": "whitehat.testnet",
        "block": state["block"],
        "header": state["header"],
        "proofs_json": state["proofs"].to_string(),
        "submitted_at_ns": submitted.to_string(),
    }})
}

/// Ten seconds after the block: well inside the recency limit.
fn recent_claim() -> Value {
    claim_job(10 * SECOND_NS as i64)
}

fn rpcs(answers: [Answer; 3]) -> [TestRpc; 3] {
    answers.map(TestRpc::answering)
}

/// The fixture exploit every claim here carries: `drain`, which PAYS under `rules.json`.
fn drain() -> Value {
    fixture("exploits/drain.json")
}

fn run_with(job: &Value, answers: [Answer; 3]) -> Output {
    let rpcs = rpcs(answers);
    run(
        test_build(),
        job,
        &rpcs.iter().collect::<Vec<_>>(),
        Some(&drain()),
    )
}

fn ours() -> Answer {
    Answer::Hash(claim_hash())
}

fn other() -> Answer {
    Answer::Hash(OTHER_HASH.into())
}

// ---- R2.8: two or three matching answers accept the block ------------------------------

/// R2.8: three RPCs answering the claim's hash accept the block, and the replay runs
/// against the state root in its header: the fixture `drain` exploit PAYS.
#[test]
fn r2_8_three_matching_answers_accept_the_block() {
    let out = run_with(&recent_claim(), [ours(), ours(), ours()]);
    assert_verdict(&out, Reason::MinimumTheftReached);
}

/// R2.8: two matching answers are enough when the third RPC is down.
#[test]
fn r2_8_two_matching_answers_and_one_down_accept_the_block() {
    let out = run_with(&recent_claim(), [ours(), Answer::Down, ours()]);
    assert_verdict(&out, Reason::MinimumTheftReached);
}

/// R2.8: two matching answers are enough when the third RPC answers with an error.
#[test]
fn r2_8_two_matching_answers_and_one_error_accept_the_block() {
    let out = run_with(&recent_claim(), [Answer::Error, ours(), ours()]);
    assert_verdict(&out, Reason::MinimumTheftReached);
}

// ---- R2.8: at least two agreeing on a different hash is INVALID -------------------------

/// R2.8: three RPCs agreeing on another hash: the claim's block isn't the chain's.
#[test]
fn r2_8_three_agreeing_on_another_hash_is_invalid() {
    let out = run_with(&recent_claim(), [other(), other(), other()]);
    assert_verdict(&out, Reason::BlockNotConfirmed);
}

/// R2.8: two agreeing on another hash outweigh one matching answer.
#[test]
fn r2_8_two_agreeing_on_another_hash_against_one_match_is_invalid() {
    let out = run_with(&recent_claim(), [other(), ours(), other()]);
    assert_verdict(&out, Reason::BlockNotConfirmed);
}

/// R2.8: two agreeing on another hash, the third down, is INVALID.
#[test]
fn r2_8_two_agreeing_on_another_hash_and_one_down_is_invalid() {
    let out = run_with(&recent_claim(), [other(), other(), Answer::Down]);
    assert_verdict(&out, Reason::BlockNotConfirmed);
}

// ---- R2.6: too few answers, or answers that disagree: no verdict ------------------------

/// R2.6, R2.8: one answer is too few, even if it matches.
#[test]
fn r2_6_one_matching_answer_is_no_verdict() {
    let out = run_with(&recent_claim(), [ours(), Answer::Down, Answer::Error]);
    assert_no_verdict(&out);
}

/// R2.6, R2.8: no RPC answering is no verdict.
#[test]
fn r2_6_no_answers_is_no_verdict() {
    let out = run_with(&recent_claim(), [Answer::Down, Answer::Error, Answer::Down]);
    assert_no_verdict(&out);
}

/// R2.6, R2.8: two answers that disagree with each other, the third down: no verdict.
#[test]
fn r2_6_two_disagreeing_answers_is_no_verdict() {
    let out = run_with(&recent_claim(), [ours(), other(), Answer::Down]);
    assert_no_verdict(&out);
}

/// R2.6, R2.8: two matches and one other hash: not every answer matches, and no two
/// agree on another hash, so no verdict.
#[test]
fn r2_6_two_matches_and_one_other_hash_is_no_verdict() {
    let out = run_with(&recent_claim(), [ours(), ours(), other()]);
    assert_no_verdict(&out);
}

/// R2.6: OutLayer runs a job whose secret doesn't match without it; with no sealed
/// exploit there is nothing to judge, so no verdict.
#[test]
fn r2_6_missing_sealed_exploit_is_no_verdict() {
    let rpcs = rpcs([ours(), ours(), ours()]);
    let out = run(
        test_build(),
        &recent_claim(),
        &rpcs.iter().collect::<Vec<_>>(),
        None,
    );
    assert_no_verdict(&out);
}

// ---- R2.8: the 5-minute recency bounds --------------------------------------------------

/// R2.8: a block exactly 5 minutes before the submission time is recent enough.
#[test]
fn r2_8_block_exactly_5_minutes_old_is_accepted() {
    let out = run_with(&claim_job(300 * SECOND_NS as i64), [ours(), ours(), ours()]);
    assert_verdict(&out, Reason::MinimumTheftReached);
}

/// R2.8: a block more than 5 minutes (by one nanosecond) before the submission time is
/// INVALID, even though every RPC confirms it.
#[test]
fn r2_8_block_over_5_minutes_old_is_invalid() {
    let out = run_with(
        &claim_job(300 * SECOND_NS as i64 + 1),
        [ours(), ours(), ours()],
    );
    assert_verdict(&out, Reason::StaleBlock);
}

/// R2.8: a block stamped at the submission time itself is accepted.
#[test]
fn r2_8_block_at_the_submission_time_is_accepted() {
    let out = run_with(&claim_job(0), [ours(), ours(), ours()]);
    assert_verdict(&out, Reason::MinimumTheftReached);
}

/// R2.8: a block after the submission time is INVALID.
#[test]
fn r2_8_block_after_the_submission_time_is_invalid() {
    let out = run_with(&claim_job(-1), [ours(), ours(), ours()]);
    assert_verdict(&out, Reason::StaleBlock);
}

// ---- R2.8: RPC addresses come only from the build ---------------------------------------

/// R2.8: the attested build never reads the test override. Pointed at three matching
/// test stand-ins through `BOUNTEE_TEST_RPCS`, it asks none of them; it pins no RPCs for
/// the fixture chain (31337), so the job ends with no verdict.
#[test]
fn r2_8_attested_build_ignores_the_test_rpc_override() {
    let rpcs = rpcs([ours(), ours(), ours()]);
    let out = run(
        attested_build(),
        &recent_claim(),
        &rpcs.iter().collect::<Vec<_>>(),
        Some(&drain()),
    );
    assert_no_verdict(&out);
    assert_eq!(rpcs.iter().map(TestRpc::requests).sum::<usize>(), 0);
}

/// R2.8: a claim job can't carry RPC addresses: a job naming any is refused as malformed
/// before anything is asked, and still nothing reaches stderr.
#[test]
fn r2_8_job_naming_rpcs_is_refused() {
    let rpcs = rpcs([ours(), ours(), ours()]);
    let mut job = recent_claim();
    job["judge_claim"]["rpcs"] = json!([rpcs[0].url]);
    let out = run(
        test_build(),
        &job,
        &rpcs.iter().collect::<Vec<_>>(),
        Some(&drain()),
    );
    assert_verdict(&out, Reason::MalformedExploit);
    assert_eq!(rpcs.iter().map(TestRpc::requests).sum::<usize>(), 0);
}

// ---- R2.8: the state root comes from the confirmed header -------------------------------

/// R2.8, R4.5: the replay runs against the confirmed header's state root: an account
/// proof that doesn't hold under it proves nothing, so the confirmed claim is INVALID.
#[test]
fn r2_8_replay_uses_the_confirmed_headers_state_root() {
    let mut job = recent_claim();
    let mut proofs: Value =
        serde_json::from_str(job["judge_claim"]["proofs_json"].as_str().unwrap()).unwrap();
    // Swap two accounts' proofs: neither holds for its address under the state root.
    let first = proofs[0]["account_proof"].clone();
    proofs[0]["account_proof"] = proofs[1]["account_proof"].clone();
    proofs[1]["account_proof"] = first;
    job["judge_claim"]["proofs_json"] = json!(proofs.to_string());
    let out = run_with(&job, [ours(), ours(), ours()]);
    assert_verdict(&out, Reason::UnprovenState);
}

/// R2.8, R4.5: proofs that aren't valid JSON prove nothing.
#[test]
fn r2_8_unparseable_proofs_are_unproven() {
    let mut job = recent_claim();
    job["judge_claim"]["proofs_json"] = json!("not proofs");
    let out = run_with(&job, [ours(), ours(), ours()]);
    assert_verdict(&out, Reason::UnprovenState);
}
