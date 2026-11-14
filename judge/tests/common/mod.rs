//! Helpers the seam J test files share.

use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

/// The repository's root.
pub fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

/// The judge's WebAssembly target: the single setting in `judge/wasm-target`.
pub fn wasm_target() -> String {
    std::fs::read_to_string(repo_root().join("judge/wasm-target"))
        .unwrap()
        .trim()
        .to_owned()
}

/// Build the judge for its WebAssembly target, with `features`, into its own target
/// directory so the test build never overwrites the attested one.
#[allow(dead_code)]
fn build(features: &[&str], target_dir: &str) -> PathBuf {
    build_for(None, features, target_dir)
}

/// [`build`], pinned to `contract` (`BOUNTEE_BOUNTY_CONTRACT`) when given, else to the
/// default build's bounty contract.
fn build_for(contract: Option<&str>, features: &[&str], target_dir: &str) -> PathBuf {
    let target = wasm_target();
    let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
    let mut args = vec![
        "build",
        "--release",
        "-p",
        "bountee-judge",
        "--target",
        &target,
    ];
    let joined = features.join(",");
    if !features.is_empty() {
        args.extend(["--features", &joined]);
    }
    let dir = repo_root().join(target_dir);
    let mut command = Command::new(cargo);
    match contract {
        Some(contract) => command.env("BOUNTEE_BOUNTY_CONTRACT", contract),
        None => command.env_remove("BOUNTEE_BOUNTY_CONTRACT"),
    };
    let status = command
        .current_dir(repo_root())
        .args(&args)
        .arg("--target-dir")
        .arg(&dir)
        .status()
        .expect("cargo runs");
    assert!(status.success(), "the judge builds for {target}");
    dir.join(format!("{target}/release/bountee-judge.wasm"))
}

/// The judge's test build: the attested build plus `test-stand-in-rpcs`.
#[allow(dead_code)]
pub fn test_build() -> &'static PathBuf {
    static WASM: OnceLock<PathBuf> = OnceLock::new();
    WASM.get_or_init(|| build(&["test-stand-in-rpcs"], "target/judge-test-stand-in-rpcs"))
}

/// The attested build, exactly as `seam_j.rs` and the enclave run it.
#[allow(dead_code)]
pub fn attested_build() -> &'static PathBuf {
    static WASM: OnceLock<PathBuf> = OnceLock::new();
    WASM.get_or_init(|| build(&[], "target"))
}

/// The mainnet chains a mainnet build pins (`src/confirm.rs`).
#[allow(dead_code)]
pub const BASE: u64 = 8453;
#[allow(dead_code)]
pub const ARBITRUM_ONE: u64 = 42161;

/// The bounty contract the mainnet build answers to (spec, ADR-0017, ADR-0020).
#[allow(dead_code)]
pub const MAINNET_BOUNTY_CONTRACT: &str = "bounty2.bountee.near";

/// The test build pinned to the mainnet bounty contract: its network's chains are Base and
/// Arbitrum One.
#[allow(dead_code)]
pub fn mainnet_test_build() -> &'static PathBuf {
    static WASM: OnceLock<PathBuf> = OnceLock::new();
    WASM.get_or_init(|| {
        build_for(
            Some(MAINNET_BOUNTY_CONTRACT),
            &["test-stand-in-rpcs"],
            "target/judge-mainnet-test-stand-in-rpcs",
        )
    })
}
