//! Seam C: the bounty contract's public actions in a local NEAR sandbox, with test
//! stand-ins for OutLayer and the MPC network (`tests/stand-ins/`).
//!
//! Add a C test with `Sandbox::start()`, then drive the contract through
//! `sandbox.contract` calls and read back only what its public views return.

use near_workspaces::{network::Sandbox as SandboxNet, Account, Contract, Worker};
use serde_json::json;

const JUDGE_BUILD_HASH: &str = "0x1111111111111111111111111111111111111111111111111111111111111111";

struct Sandbox {
    #[allow(dead_code)]
    worker: Worker<SandboxNet>,
    contract: Contract,
    test_outlayer: Contract,
    test_mpc: Contract,
    #[allow(dead_code)]
    root: Account,
}

impl Sandbox {
    /// A sandbox with the bounty contract deployed and initialised against the stand-ins.
    async fn start() -> anyhow::Result<Self> {
        let worker = near_workspaces::sandbox().await?;
        let root = worker.root_account()?;
        let deploy = |name: &'static str, path: &'static str| {
            let root = root.clone();
            async move {
                let wasm = near_workspaces::compile_project(path).await?;
                let account = root
                    .create_subaccount(name)
                    .initial_balance(near_workspaces::types::NearToken::from_near(20))
                    .transact()
                    .await?
                    .into_result()?;
                anyhow::Ok(account.deploy(&wasm).await?.into_result()?)
            }
        };
        let test_outlayer = deploy("test-outlayer", "./tests/stand-ins/test-outlayer").await?;
        let test_mpc = deploy("test-mpc", "./tests/stand-ins/test-mpc").await?;
        let contract = deploy("bounty", "./").await?;
        contract
            .call("new")
            .args_json(json!({ "config": {
                "outlayer": test_outlayer.id(),
                "mpc": test_mpc.id(),
                "judge_build_hash": JUDGE_BUILD_HASH,
            }}))
            .transact()
            .await?
            .into_result()?;
        Ok(Self {
            worker,
            contract,
            test_outlayer,
            test_mpc,
            root,
        })
    }
}

/// Ticket #6 smoke: the bounty contract and both named test stand-ins deploy to the
/// sandbox, and the contract reports what it was pinned to.
#[tokio::test]
async fn smoke_contract_runs_in_the_sandbox_against_the_stand_ins() -> anyhow::Result<()> {
    let s = Sandbox::start().await?;

    let outlayer_is: String = s.test_outlayer.view("stand_in_for").await?.json()?;
    let mpc_is: String = s.test_mpc.view("stand_in_for").await?.json()?;
    assert_eq!(outlayer_is, "OutLayer");
    assert_eq!(mpc_is, "NEAR Chain Signatures MPC");

    let config: serde_json::Value = s.contract.view("config").await?.json()?;
    assert_eq!(
        config,
        json!({
            "outlayer": s.test_outlayer.id(),
            "mpc": s.test_mpc.id(),
            "judge_build_hash": JUDGE_BUILD_HASH,
        })
    );
    Ok(())
}
