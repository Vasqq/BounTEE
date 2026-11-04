//! Seam J: the judge as the enclave runs it — the one WebAssembly build, run under a
//! WebAssembly runtime (wasmtime), JSON in on stdin, a verdict out on stdout.
//!
//! Add a J test by calling `run_judge(input)` with a committed fixture from
//! `judge/tests/fixtures/` and asserting on the parsed `Verdict`. Never call the judge's
//! Rust functions directly: that would test the host build, not the one that is attested.

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use bountee_formats::{from_json, Outcome, Reason, Verdict};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

/// The judge's WebAssembly target: the single setting in `judge/wasm-target`.
fn wasm_target() -> String {
    std::fs::read_to_string(repo_root().join("judge/wasm-target"))
        .unwrap()
        .trim()
        .to_owned()
}

/// Build the judge for its WebAssembly target once per test run and return the module.
fn judge_wasm() -> &'static PathBuf {
    static WASM: OnceLock<PathBuf> = OnceLock::new();
    WASM.get_or_init(|| {
        let target = wasm_target();
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let status = Command::new(cargo)
            .current_dir(repo_root())
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

/// Run the compiled judge under wasmtime with `input` on stdin; return its stdout.
fn run_judge(input: &str) -> String {
    let mut child = Command::new("wasmtime")
        .args(["run", "-S", "http", "--"])
        .arg(judge_wasm())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .expect("wasmtime is installed (see findings/layout.md)");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(input.as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "the judge exits cleanly");
    String::from_utf8(out.stdout).unwrap()
}

/// Ticket #6 smoke: the compiled judge runs under the WebAssembly runtime and answers in
/// the shared verdict format, within OutLayer's 900-byte output limit.
#[test]
fn smoke_compiled_judge_answers_with_a_verdict() {
    let stdout = run_judge("not a job");
    assert!(
        stdout.len() <= 900,
        "OutLayer truncates output over 900 bytes"
    );
    let verdict: Verdict = from_json(stdout.trim()).expect("stdout is a verdict");
    assert_eq!(verdict.outcome(), Outcome::Invalid);
    assert_eq!(verdict.reason(), Reason::MalformedExploit);
}
