//! Ticket #58: the enclave's posting check, run before any mainnet spend on a local copy of the
//! demo's mainnet state, the vaults as `demo/script/Deploy.s.sol` deploys them on Base and
//! Arbitrum One (R7.6, R12.1, R12.2).
//!
//! Where this sits (outside the five seams, so recorded here, as CLAUDE.md asks): seam J's
//! interface, the compiled judge fed a job, driven as `seam_j_posting_check.rs` drives it, but
//! against a local copy of mainnet built from live chains rather than committed fixtures,
//! because what it checks (Circle's USDC and the deploy script's vault on Base and Arbitrum One,
//! under the mainnet derivation) exists only on mainnet, where nothing may be spent before #35's
//! run. The result is a recorded analysis (requirements.md's method A), not mainnet evidence.
//!
//! Seams, written down before the first test:
//! - The judge's mainnet test build (pinned to `bounty.bountee.near`, under the
//!   mainnet MPC root key, with its test stand-in RPCs) fed the demo bounty's `posting_check`
//!   job, its RPCs for 8453 and 42161 pointed at plain anvils loaded with
//!   `cli/test/mainnet-state/build.ts`'s state files (Circle's USDC, the vault deployed and
//!   seeded by the deploy script, the pause-role address funded with the pause gas).
//!   Catches: the posting check passing on the real vault code, Circle's real USDC and the
//!   pause-role address the mainnet derivation gives, on both chains, before the mainnet
//!   posting spends anything. Misses: the pinned mainnet RPCs themselves and OutLayer (the
//!   mainnet posting), and agreement between different RPCs (R12.5: one local chain answers as
//!   all three; `seam_j_posting_check.rs` covers it).
//!
//! Ignored by default: run with BOUNTEE_MAINNET_STATE set to the harness's `manifest.json` and
//! `cargo test --test seam_j_mainnet_state -- --ignored`; needs anvil and wasmtime.

mod common;

use std::io::Write;
use std::net::TcpListener;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use bountee_formats::{from_json, PostingCheckResult};
use common::{mainnet_test_build, MAINNET_BOUNTY_CONTRACT};
use serde_json::{json, Value};

/// A plain anvil serving one of the harness's state files, killed when dropped.
struct LoadedChain {
    url: String,
    process: Child,
}

impl Drop for LoadedChain {
    fn drop(&mut self) {
        let _ = self.process.kill();
    }
}

fn load(state: &str, chain_id: u64) -> LoadedChain {
    let port = TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port();
    let process = Command::new("anvil")
        .args([
            "--load-state",
            state,
            "--chain-id",
            &chain_id.to_string(),
            "--hardfork",
            "prague",
            "--port",
            &port.to_string(),
            "--silent",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("anvil is installed");
    let url = format!("http://127.0.0.1:{port}");
    let started = Instant::now();
    while TcpListener::bind(("127.0.0.1", port)).is_ok() {
        assert!(
            started.elapsed() < Duration::from_secs(30),
            "anvil didn't start on {state}"
        );
        std::thread::sleep(Duration::from_millis(100));
    }
    // The posting check reads below the head, and the loaded state's first block (the dumped
    // fork's) has no state root: mine past it, as the harness does.
    let mine = json!({ "jsonrpc": "2.0", "id": 1, "method": "anvil_mine", "params": ["0x5"] });
    let status = Command::new("curl")
        .args([
            "-sf",
            "-H",
            "content-type: application/json",
            "-d",
            &mine.to_string(),
            &url,
        ])
        .stdout(Stdio::null())
        .status()
        .unwrap();
    assert!(status.success(), "anvil mines on {url}");
    LoadedChain { url, process }
}

/// R7.6, R12.1, R12.2: the demo bounty's posting check passes on the local copy of mainnet: on
/// Base and on Arbitrum One the pause-role address can pause the deployed vault and holds its
/// pause gas.
#[test]
#[ignore = "needs BOUNTEE_MAINNET_STATE, the copy cli/test/mainnet-state/build.ts builds"]
fn r7_6_r12_1_r12_2_the_demo_posting_check_passes_on_the_mainnet_state_copy() {
    let manifest = std::env::var("BOUNTEE_MAINNET_STATE")
        .expect("BOUNTEE_MAINNET_STATE names the harness's manifest.json");
    let manifest: Value =
        serde_json::from_str(&std::fs::read_to_string(&manifest).unwrap()).unwrap();
    assert_eq!(manifest["contract"], MAINNET_BOUNTY_CONTRACT);
    let chains = manifest["chains"].as_array().unwrap();
    let loaded: Vec<(u64, LoadedChain)> = chains
        .iter()
        .map(|c| {
            let id = c["chain_id"].as_u64().unwrap();
            (id, load(c["state"].as_str().unwrap(), id))
        })
        .collect();
    // The demo bounty's mainnet rules (ADR-0018), as the harness wrote them.
    let rules = &manifest["rules"];
    let check = |bounty: &Value| -> PostingCheckResult {
        let job = json!({ "posting_check": { "bounty": bounty, "rules": rules } });
        let mut command = Command::new("wasmtime");
        command.args(["run", "-S", "http"]);
        for (id, chain) in &loaded {
            command
                .arg("--env")
                .arg(format!("BOUNTEE_TEST_RPCS_{id}={0},{0},{0}", chain.url));
        }
        let mut child = command
            .arg("--env")
            .arg(format!("NEAR_PREDECESSOR_ID={MAINNET_BOUNTY_CONTRACT}"))
            .arg("--")
            .arg(mainnet_test_build())
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
        assert!(
            out.status.success(),
            "a posting check always answers: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        from_json(String::from_utf8(out.stdout).unwrap().trim()).expect("a posting check result")
    };
    let passed = check(&manifest["bounty"]);
    assert!(passed.passed(), "{passed:?}");
    println!("posting check on the mainnet-state copy: {passed:?}");
    // Not a pass by default: another name derives another pause-role address, which the vaults
    // never granted and which holds no pause gas, and both covered contracts fail.
    let other = json!({ "protocol": manifest["bounty"]["protocol"], "name": "not-this-bounty" });
    let failed = check(&other);
    assert_eq!(failed.failures.len(), chains.len(), "{failed:?}");
}
