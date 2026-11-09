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
//!   Ticket #43 adds a test build pinned to the mainnet bounty contract (`.near`): it
//!   catches that each build confirms only its own network's chains (Base and Arbitrum One
//!   on mainnet, the Sepolias on testnet) and refuses the other network's with no verdict,
//!   asking no RPC. It misses the mainnet RPCs themselves, which a testnet OutLayer job
//!   checks (recorded in the ticket's work).
//! - Inspection (R2.8, recorded in the judge's `confirm.rs`): no RPC address is read from
//!   the job input, a claim or a Protocol; the attested build's table is its network's.

mod common;
#[path = "stand-ins/test_rpc.rs"]
mod test_rpc;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

use bountee_formats::{from_json, Reason, Verdict};
use common::{
    attested_build, mainnet_test_build, repo_root, test_build, ARBITRUM_ONE, BASE,
    MAINNET_BOUNTY_CONTRACT,
};
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
    run_per_chain(wasm, job, rpcs, &[], exploit)
}

fn urls(rpcs: &[&TestRpc]) -> String {
    rpcs.iter().map(|r| r.url.as_str()).collect::<Vec<_>>().join(",")
}

/// [`run`], with the chains named in `per_chain` given their own stand-ins
/// (`BOUNTEE_TEST_RPCS_<chain id>`) instead of `rpcs`.
fn run_per_chain(
    wasm: &PathBuf,
    job: &Value,
    rpcs: &[&TestRpc],
    per_chain: &[(u64, &[&TestRpc])],
    exploit: Option<&Value>,
) -> Output {
    run_for_contract(BOUNTY_CONTRACT, wasm, job, rpcs, per_chain, exploit)
}

/// [`run_per_chain`] for a build pinned to `contract`, in a job that contract requested.
fn run_for_contract(
    contract: &str,
    wasm: &PathBuf,
    job: &Value,
    rpcs: &[&TestRpc],
    per_chain: &[(u64, &[&TestRpc])],
    exploit: Option<&Value>,
) -> Output {
    let mut command = Command::new("wasmtime");
    command
        .args(["run", "-S", "http"])
        .arg("--env")
        .arg(format!("BOUNTEE_TEST_RPCS={}", urls(rpcs)));
    for (chain, rpcs) in per_chain {
        command
            .arg("--env")
            .arg(format!("BOUNTEE_TEST_RPCS_{chain}={}", urls(rpcs)));
    }
    command
        .arg("--env")
        .arg(format!("NEAR_PREDECESSOR_ID={contract}"));
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

// ---- D1, R2.8: the claim's chain ----------------------------------------------------------

/// R2.8, D1: on a bounty covering its vaults on Base Sepolia first and Arbitrum Sepolia
/// second, a claim proven on Arbitrum Sepolia, the second chain, is confirmed through
/// Arbitrum Sepolia's RPCs only: Base Sepolia's are asked nothing (here they would
/// contradict the claim), and the replay PAYS. (The fixture block is anvil's, relabelled
/// as Arbitrum Sepolia's: what is under test is which chain's RPCs are asked.)
#[test]
fn r2_8_d1_a_claim_proven_on_the_second_chain_is_confirmed_by_that_chains_rpcs() {
    let mut job = claim_on(BASE_SEPOLIA);
    job["judge_claim"]["block"]["chain_id"] = json!(ARBITRUM_SEPOLIA);
    let rules = &mut job["judge_claim"]["rules"];
    for list in ["covered_contracts", "listed_tokens"] {
        let mut items = rules[list].as_array().unwrap().clone();
        for item in items.clone() {
            let mut on_arbitrum = item.clone();
            on_arbitrum["chain_id"] = json!(ARBITRUM_SEPOLIA);
            items.push(on_arbitrum);
        }
        rules[list] = json!(items);
    }
    let arbitrum = rpcs([ours(), ours(), ours()]);
    let base = rpcs([other(), other(), other()]);
    let any = rpcs([other(), other(), other()]);
    let out = run_per_chain(
        test_build(),
        &job,
        &any.iter().collect::<Vec<_>>(),
        &[
            (ARBITRUM_SEPOLIA, &arbitrum.iter().collect::<Vec<_>>()),
            (BASE_SEPOLIA, &base.iter().collect::<Vec<_>>()),
        ],
        Some(&drain()),
    );
    assert_verdict(&out, Reason::MinimumTheftReached);
    assert_eq!(arbitrum.iter().map(TestRpc::requests).sum::<usize>(), 3);
    assert_eq!(base.iter().map(TestRpc::requests).sum::<usize>(), 0);
    assert_eq!(any.iter().map(TestRpc::requests).sum::<usize>(), 0);
}

/// D1: a claim job whose block is on a chain no covered contract is on is INVALID
/// `chain_not_covered`, before any RPC is asked, though every stand-in would confirm it.
#[test]
fn d1_a_claim_on_a_chain_no_covered_contract_is_on_is_invalid_before_any_rpc() {
    let mut job = claim_on(BASE_SEPOLIA);
    job["judge_claim"]["block"]["chain_id"] = json!(ARBITRUM_SEPOLIA);
    let rpcs = rpcs([ours(), ours(), ours()]);
    let out = run(
        test_build(),
        &job,
        &rpcs.iter().collect::<Vec<_>>(),
        Some(&drain()),
    );
    assert_verdict(&out, Reason::ChainNotCovered);
    assert_eq!(rpcs.iter().map(TestRpc::requests).sum::<usize>(), 0);
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

// ---- R2.8: each build confirms only its own network's chains (#43) ----------------------

const BASE_SEPOLIA: u64 = 84532;
const ARBITRUM_SEPOLIA: u64 = 421614;

/// The fixture claim with its block, every covered contract and every listed token on
/// `chain`.
fn claim_on(chain: u64) -> Value {
    let mut job = recent_claim();
    job["judge_claim"]["block"]["chain_id"] = json!(chain);
    let rules = &mut job["judge_claim"]["rules"];
    for c in rules["covered_contracts"].as_array_mut().unwrap() {
        c["chain_id"] = json!(chain);
    }
    for t in rules["listed_tokens"].as_array_mut().unwrap() {
        t["chain_id"] = json!(chain);
    }
    job
}

/// Run `claim_on(chain)` on `wasm`, pinned to `contract`, with three matching stand-ins
/// for `chain` and three for every other chain; the verdict and how many requests reached
/// each set.
fn judge_on(contract: &str, wasm: &PathBuf, chain: u64) -> (Output, usize, usize) {
    let own = rpcs([ours(), ours(), ours()]);
    let any = rpcs([ours(), ours(), ours()]);
    let out = run_for_contract(
        contract,
        wasm,
        &claim_on(chain),
        &any.iter().collect::<Vec<_>>(),
        &[(chain, &own.iter().collect::<Vec<_>>())],
        Some(&drain()),
    );
    let asked = |set: &[TestRpc; 3]| set.iter().map(TestRpc::requests).sum::<usize>();
    (out, asked(&own), asked(&any))
}

/// R2.8: a build for the mainnet bounty contract confirms a Base block through Base's
/// RPCs, and the replay runs: the fixture `drain` PAYS.
#[test]
fn r2_8_mainnet_build_confirms_a_base_block() {
    let (out, own, _) = judge_on(MAINNET_BOUNTY_CONTRACT, mainnet_test_build(), BASE);
    assert_verdict(&out, Reason::MinimumTheftReached);
    assert_eq!(own, 3);
}

/// R2.8: a build for the mainnet bounty contract confirms an Arbitrum One block.
#[test]
fn r2_8_mainnet_build_confirms_an_arbitrum_one_block() {
    let (out, own, _) = judge_on(MAINNET_BOUNTY_CONTRACT, mainnet_test_build(), ARBITRUM_ONE);
    assert_verdict(&out, Reason::MinimumTheftReached);
    assert_eq!(own, 3);
}

/// R2.8, R2.6: a mainnet build refuses a Sepolia proof chain: no verdict, and no RPC is
/// asked, even though every stand-in would confirm the block.
#[test]
fn r2_8_mainnet_build_refuses_a_sepolia_chain_with_no_verdict() {
    for chain in [BASE_SEPOLIA, ARBITRUM_SEPOLIA] {
        let (out, own, any) = judge_on(MAINNET_BOUNTY_CONTRACT, mainnet_test_build(), chain);
        assert_no_verdict(&out);
        assert_eq!((own, any), (0, 0), "chain {chain}");
    }
}

/// R2.8, R2.6: the reverse: a testnet build refuses a mainnet proof chain with no verdict.
#[test]
fn r2_8_testnet_build_refuses_a_mainnet_chain_with_no_verdict() {
    for chain in [BASE, ARBITRUM_ONE] {
        let (out, own, any) = judge_on(BOUNTY_CONTRACT, test_build(), chain);
        assert_no_verdict(&out);
        assert_eq!((own, any), (0, 0), "chain {chain}");
    }
}

/// R2.8: the testnet build still confirms its own network's chains.
#[test]
fn r2_8_testnet_build_confirms_a_sepolia_block() {
    for chain in [BASE_SEPOLIA, ARBITRUM_SEPOLIA] {
        let (out, own, _) = judge_on(BOUNTY_CONTRACT, test_build(), chain);
        assert_verdict(&out, Reason::MinimumTheftReached);
        assert_eq!(own, 3, "chain {chain}");
    }
}
