//! Seam J, ticket #23: the compiled judge running the enclave's `publish` action as OutLayer
//! runs it — the job on stdin, the caller in `NEAR_PREDECESSOR_ID` and the winning claim's
//! sealed exploit in the secret `BOUNTEE_SEALED_EXPLOIT`, the publication on stdout.
//!
//! Seams, written down before the first test (also in the ticket's findings):
//! - J (this file): the wasm judge under wasmtime, fed a sealed bundle written by the
//!   command-line tool's own sealing code (`fixtures/sealed/alice-drain.txt`). Catches D7 at
//!   the judge (only the pinned bounty contract's job, with the secret, publishes anything;
//!   R5.6: a bundle sealed for another account than the winner's is never published) and
//!   D7.1 (the publication is the exact exploit the Whitehat sealed, in the clear, naming
//!   the claim it won). Misses: when the contract asks for it (seam C).
//! - The publication is a format the Rust judge writes and the TypeScript tool reads, a seam
//!   outside the five: this file reads it with the standard primitives the format names;
//!   `cli/test/publish.test.ts` re-runs the judge's real output with the tool.
//!
//! R15.3: every test reads only committed fixtures; no keys, funds or network.

mod common;

use std::io::Write;
use std::process::{Command, Stdio};

use base64::Engine;
use bountee_formats::{from_json, Exploit, PublishOutput, ReleasedExploit};
use common::{attested_build, repo_root};
use serde_json::{json, Value};

/// The bounty contract a default build of the judge is pinned to (`judge/src/sealed.rs`).
const BOUNTY_CONTRACT: &str = "bounty.bountee.testnet";
/// The account the fixture bundle is sealed for.
const SEALED_FOR: &str = "alice.testnet";

struct Run {
    success: bool,
    stdout: String,
    stderr: String,
}

fn run_job(job: &Value, env: &[(&str, &str)]) -> Run {
    let mut cmd = Command::new("wasmtime");
    cmd.args(["run", "-S", "http"]);
    for (k, v) in env {
        cmd.arg("--env").arg(format!("{k}={v}"));
    }
    let mut child = cmd
        .arg("--")
        .arg(attested_build())
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

fn sealed() -> String {
    fixture("sealed/alice-drain.txt").trim().to_owned()
}

/// The publication job the bounty contract requests for claim 7 by `whitehat`.
fn publish_job(whitehat: &str) -> Value {
    json!({ "publish": {
        "bounty": { "protocol": "protocol.testnet", "name": "vault" },
        "claim_id": 7,
        "whitehat": whitehat,
    }})
}

fn as_contract(job: &Value, secret: &str) -> Run {
    run_job(
        job,
        &[
            ("NEAR_PREDECESSOR_ID", BOUNTY_CONTRACT),
            ("NEAR_SENDER_ID", "anyone.testnet"),
            ("BOUNTEE_SEALED_EXPLOIT", secret),
        ],
    )
}

/// Read a publication as `formats/src/job.rs` names it: base64 of raw DEFLATE of JSON.
fn read(published: &str) -> ReleasedExploit {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(published)
        .expect("base64");
    let json = miniz_oxide::inflate::decompress_to_vec(&bytes).expect("raw DEFLATE");
    from_json(std::str::from_utf8(&json).unwrap()).expect("a released exploit")
}

/// Nothing at all: the job fails, so the contract's callback gets `null`.
fn refused(run: &Run) {
    assert!(!run.success, "the job fails");
    assert_eq!(run.stdout, "", "nothing published");
    assert_eq!(run.stderr, "", "nothing about the job is written");
}

/// D7.1: the bounty contract's publication job writes the winning exploit in the clear, the
/// exact one the Whitehat sealed, naming the claim it won, for anyone to re-run.
#[test]
fn d7_1_the_publication_is_the_sealed_exploit_in_the_clear() {
    let run = as_contract(&publish_job(SEALED_FOR), &sealed());
    assert!(run.success, "the publication job succeeds: {}", run.stderr);
    assert_eq!(run.stderr, "", "nothing on stderr in the enclave");
    let out: PublishOutput = from_json(&run.stdout).expect("stdout is one publish output");
    let published = read(out.published.as_str());
    let drain: Exploit = from_json(&fixture("exploits/drain.json")).unwrap();
    assert_eq!(published.exploit, drain, "the exploit the Whitehat sealed");
    assert_eq!(published.whitehat.as_str(), SEALED_FOR);
    assert_eq!(u64::from(published.claim_id), 7);
    assert_eq!(published.bounty.protocol.as_str(), "protocol.testnet");
    assert_eq!(published.bounty.name.as_str(), "vault");
}

/// D7, R5.6 at the judge: a publication job requested by anyone but the pinned bounty
/// contract, with no secret, or for a bundle sealed for another account than the winning
/// claim's, publishes nothing.
#[test]
fn d7_only_the_bounty_contracts_job_for_the_winner_publishes() {
    let job = publish_job(SEALED_FOR);
    refused(&run_job(
        &job,
        &[
            ("NEAR_PREDECESSOR_ID", "anyone.testnet"),
            ("BOUNTEE_SEALED_EXPLOIT", &sealed()),
        ],
    ));
    refused(&run_job(&job, &[("NEAR_PREDECESSOR_ID", BOUNTY_CONTRACT)]));
    refused(&as_contract(&job, "not a sealed bundle"));
    refused(&as_contract(&publish_job("mallory.testnet"), &sealed()));
}
