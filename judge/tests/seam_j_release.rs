//! Seam J, ticket #22: the compiled judge running the enclave's `release` action as OutLayer
//! runs it — the job on stdin, the caller in `NEAR_PREDECESSOR_ID` and the winning claim's
//! sealed exploit in the secret `BOUNTEE_SEALED_EXPLOIT`, the release on stdout.
//!
//! Seams, written down before the first test (also in the ticket's findings):
//! - J (this file): the wasm judge under wasmtime, fed sealed bundles written by the
//!   command-line tool's own sealing code (`fixtures/sealed/*.txt`). Catches: R12.4 at the
//!   judge (the exploit comes out encrypted only to the exploit key the job names, and only
//!   that key opens it); R6.1 at the judge (a release job from any caller but the pinned
//!   bounty contract, or with no secret, writes nothing); R5.6 at the judge (a bundle sealed
//!   for another account than the winning claim's is never released). Misses: whether
//!   OutLayer gives the secret only to the contract's jobs (seam T, #15/#16), and which
//!   claims the contract asks to release (seam C).
//! - The release ciphertext is a format the Rust judge writes and the TypeScript tool reads,
//!   a seam outside the five: this file opens it with the standard primitives the format
//!   names; `cli/test/open-exploit.test.ts` opens the judge's real output with the tool.
//!
//! R15.3: every test reads only committed fixtures; no keys, funds or network.

mod common;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use base64::Engine;
use bountee_formats::{from_json, Exploit, ReleaseOutput, ReleasedExploit};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Nonce};
use common::{repo_root, wasm_target};
use serde_json::{json, Value};

/// The bounty contract a default build of the judge is pinned to (`judge/src/sealed.rs`).
const BOUNTY_CONTRACT: &str = "bounty.bountee.testnet";
/// The account the fixture bundles are sealed for.
const SEALED_FOR: &str = "alice.testnet";
/// The posting Protocol's exploit key (its X25519 secret), and another key.
const PROTOCOL_SECRET: [u8; 32] = [0x42; 32];
const OTHER_SECRET: [u8; 32] = [0x17; 32];

/// The attested build: no features.
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
            .status()
            .expect("cargo runs");
        assert!(status.success(), "the judge builds for {target}");
        repo_root().join(format!("target/{target}/release/bountee-judge.wasm"))
    })
}

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

fn public_key(secret: [u8; 32]) -> [u8; 32] {
    x25519_dalek::x25519(secret, x25519_dalek::X25519_BASEPOINT_BYTES)
}

fn key_text(secret: [u8; 32]) -> String {
    format!("x25519:{}", bs58::encode(public_key(secret)).into_string())
}

/// The release job the bounty contract requests for claim 7 by `whitehat`.
fn release_job(whitehat: &str, exploit_public_key: &str) -> Value {
    json!({ "release": {
        "bounty": { "protocol": "protocol.testnet", "name": "vault" },
        "claim_id": 7,
        "whitehat": whitehat,
        "exploit_public_key": exploit_public_key,
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

/// Open a release with an X25519 secret, as the format in `formats/src/job.rs` names it.
fn open(released: &str, secret: [u8; 32]) -> Option<ReleasedExploit> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(released)
        .ok()?;
    if bytes.len() < 1 + 32 + 12 + 16 || bytes[0] != 1 {
        return None;
    }
    let eph: [u8; 32] = bytes[1..33].try_into().unwrap();
    let shared = x25519_dalek::x25519(secret, eph);
    let mut key = [0u8; 32];
    hkdf::Hkdf::<sha2::Sha256>::new(None, &shared)
        .expand(b"bountee-release-v1", &mut key)
        .unwrap();
    let nonce: [u8; 12] = bytes[33..45].try_into().unwrap();
    let plain = ChaCha20Poly1305::new(&key.into())
        .decrypt(&Nonce::from(nonce), &bytes[45..])
        .ok()?;
    let json = miniz_oxide::inflate::decompress_to_vec(&plain).ok()?;
    Some(from_json(std::str::from_utf8(&json).ok()?).expect("a released exploit"))
}

/// Nothing at all: the job fails, so the contract's callback gets `null`.
fn refused(run: &Run) {
    assert!(!run.success, "the job fails");
    assert_eq!(run.stdout, "", "nothing released");
    assert_eq!(run.stderr, "", "nothing about the job is written");
}

/// R12.4, R6.2: the bounty contract's release job writes the winning exploit encrypted to the
/// exploit key it names, and only that key opens it, to the exploit the Whitehat sealed and
/// the claim it won.
#[test]
fn r12_4_the_release_opens_only_with_the_named_exploit_key() {
    let run = as_contract(
        &release_job(SEALED_FOR, &key_text(PROTOCOL_SECRET)),
        &sealed("alice-drain"),
    );
    assert!(run.success, "the release job succeeds: {}", run.stderr);
    assert_eq!(run.stderr, "", "nothing on stderr in the enclave");
    let out: ReleaseOutput = from_json(&run.stdout).expect("stdout is one release output");

    let released = open(out.released.as_str(), PROTOCOL_SECRET).expect("the exploit key opens it");
    let drain: Exploit = from_json(&fixture("exploits/drain.json")).unwrap();
    assert_eq!(released.exploit, drain, "the exploit the Whitehat sealed");
    assert_eq!(released.whitehat.as_str(), SEALED_FOR);
    assert_eq!(u64::from(released.claim_id), 7);
    assert_eq!(released.bounty.protocol.as_str(), "protocol.testnet");
    assert_eq!(released.bounty.name.as_str(), "vault");

    assert!(
        open(out.released.as_str(), OTHER_SECRET).is_none(),
        "no other key opens it"
    );
    // Each release is encrypted afresh, so two releases of one exploit don't match.
    let again = as_contract(
        &release_job(SEALED_FOR, &key_text(PROTOCOL_SECRET)),
        &sealed("alice-drain"),
    );
    assert_ne!(again.stdout, run.stdout);
}

/// R6.1 at the judge: a release job requested by anyone but the pinned bounty contract, or
/// with no secret, releases nothing.
#[test]
fn r6_1_only_the_bounty_contracts_job_with_the_secret_releases() {
    let job = release_job(SEALED_FOR, &key_text(PROTOCOL_SECRET));
    refused(&run_job(
        &job,
        &[
            ("NEAR_PREDECESSOR_ID", "protocol.testnet"),
            ("BOUNTEE_SEALED_EXPLOIT", &sealed("alice-drain")),
        ],
    ));
    refused(&run_job(&job, &[("NEAR_PREDECESSOR_ID", BOUNTY_CONTRACT)]));
    refused(&run_job(
        &job,
        &[
            ("NEAR_PREDECESSOR_ID", BOUNTY_CONTRACT),
            ("BOUNTEE_SEALED_EXPLOIT", "not a sealed bundle"),
        ],
    ));
}

/// R5.6, R12.4 at the judge: a bundle sealed for another account than the winning claim's is
/// never released, and a key that isn't an X25519 key gets nothing.
#[test]
fn r5_6_a_bundle_sealed_for_another_account_is_never_released() {
    refused(&as_contract(
        &release_job("mallory.testnet", &key_text(PROTOCOL_SECRET)),
        &sealed("alice-drain"),
    ));
    refused(&as_contract(
        &release_job(
            SEALED_FOR,
            "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8f",
        ),
        &sealed("alice-drain"),
    ));
    refused(&as_contract(
        &release_job(SEALED_FOR, "x25519:6W7B3sSYk1p2DZ7"),
        &sealed("alice-drain"),
    ));
}
