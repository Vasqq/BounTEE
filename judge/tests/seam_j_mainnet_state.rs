//! Seam J, ticket #58: the enclave's posting check, run before any mainnet spend on a local
//! copy of the demo's mainnet state, the vaults as `demo/script/Deploy.s.sol` deploys them on
//! Base and Arbitrum One (R7.6, R12.1, R12.2, R12.5).
//!
//! Seams, written down before the first test:
//! - J (this file): the judge's mainnet test build (pinned to `bounty.bountee.near`, under the
//!   mainnet MPC root key, with its test stand-in RPCs) fed the demo bounty's `posting_check`
//!   job, its RPCs for 8453 and 42161 pointed at plain anvils loaded with
//!   `cli/test/mainnet-state/build.ts`'s state files (Circle's USDC, the vault deployed and
//!   seeded by the deploy script, the pause-role address funded with the pause gas).
//!   Catches: the posting check passing on the real vault code, Circle's real USDC and the
//!   pause-role address the mainnet derivation gives, on both chains, before the mainnet
//!   posting spends anything. Misses: the pinned mainnet RPCs themselves and OutLayer (the
//!   mainnet posting), and agreement between different RPCs (one local chain answers as all
//!   three). A recorded analysis on a local copy, not mainnet evidence.
//!
//! Runs only with BOUNTEE_MAINNET_STATE set to the harness's `manifest.json`; needs anvil and
//! wasmtime.

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
    // The posting check reads one block below the head.
    let mine = json!({ "jsonrpc": "2.0", "id": 1, "method": "anvil_mine", "params": ["0x3"] });
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

/// R12.1, R12.2, R12.5, R7.6: the demo bounty's posting check passes on the local copy of
/// mainnet: on Base and on Arbitrum One the pause-role address can pause the deployed vault and
/// holds its pause gas.
#[test]
fn r12_1_r12_5_the_demo_posting_check_passes_on_the_mainnet_state_copy() {
    let Ok(manifest) = std::env::var("BOUNTEE_MAINNET_STATE") else {
        eprintln!("skipped: BOUNTEE_MAINNET_STATE is unset (build it with cli/test/mainnet-state/build.ts)");
        return;
    };
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
    let base = chains.iter().find(|c| c["chain_id"] == 8453).unwrap();
    // The demo bounty's mainnet rules (ADR-0018): 10 USDC, a 1 USDC minimum theft, both vaults.
    let rules = json!({
        "covered_contracts": chains.iter().map(|c| json!({ "chain_id": c["chain_id"], "address": c["vault"] })).collect::<Vec<_>>(),
        "proof_chain": 8453,
        "recency_limit_secs": 300,
        "listed_tokens": [{ "token": base["usdc"], "price": "1" }, { "token": "native", "price": "0" }],
        "seed": { "native": "1000000000000000000", "tokens": [] },
        "bounty_amount": "10000000",
        "minimum_theft": "1000000",
        "end_date_ns": "1794268800000000000",
        "disclosure_delay_days": 1,
        "exploit_public_key": "x25519:6W7B3sSYk1p2DZ7FXyRbJWDNiaRfVTj1hm6k8Cqnq6wA",
        "judge_build_hash": "0x5b3ba1891e81419a5fc398364e36c699a40c2ec7bce675588f06cad72171002d"
    });
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
