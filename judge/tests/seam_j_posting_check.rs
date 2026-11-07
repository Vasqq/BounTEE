//! Seam J, ticket #17: the enclave's posting check. On every covered chain the judge
//! simulates `pause()` from the bounty's pause-role address and checks that address holds
//! enough pause gas, reading each chain through the RPCs pinned in its build (R7.6, R12.1,
//! R12.2, R12.5).
//!
//! Seams, written down before the first test:
//! - J (this file): the compiled wasm32-wasip2 judge under `wasmtime run -S http`, fed the
//!   bounty contract's `posting_check` job. The pinned RPCs are outside the system, so
//!   three local test stand-ins (`stand-ins/test_chain_rpc.rs`) answer for them, each with
//!   its own scripted chain (contracts, who may pause them, balances), or an error, or
//!   nothing. The judge reaches them only in its test build (feature `test-stand-in-rpcs`).
//!   Catches: the pass/fail decision and its reason per covered contract; the pause-role
//!   address the judge derives (the stand-ins let only that address pause); the pause-gas
//!   figure including the L1 data fee and one pause per covered contract on a chain; the
//!   2-of-3 agreement rule; that every read names one fixed block, not `latest`; nothing on
//!   stderr; and, on the attested build, that it never reads the test override. Misses:
//!   real RPCs, real contracts' access control and a real revert's error shape (seam T,
//!   `bountee post` on testnet), and how the bounty contract acts on the answer (seam C).
//!   Ticket #43 adds a test build pinned to the mainnet bounty contract (`.near`): it
//!   catches that the posting check reads Base and Arbitrum One, derives the pause-role
//!   address under the mainnet MPC root key, and refuses the other network's chains (each
//!   build's own network only), asking no RPC. It misses the mainnet RPCs themselves.
//! - C (`contract/tests/seam_c.rs`): the contract goes live only on a passing answer, and
//!   refunds the USDC in full otherwise (R1.6, R7.6, R12.1, R12.2), and refuses a contract
//!   another live or pending bounty covers (R12.3).
//! - T (`cli/test/post-testnet.test.ts`): `bountee post` on testnet against the attested
//!   judge in OutLayer and a real demo vault on Base Sepolia.

mod common;
#[path = "stand-ins/test_chain_rpc.rs"]
mod test_chain_rpc;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

use bountee_formats::{
    from_json, pause_gas_per_pause, pause_role, AccountId, BountyId, PostingCheckResult,
    PostingFailureReason, PAUSE_GAS_LIMIT, PAUSE_MAX_FEE_PER_GAS,
};
use common::{
    attested_build, mainnet_test_build, test_build, ARBITRUM_ONE, BASE, MAINNET_BOUNTY_CONTRACT,
};
use serde_json::{json, Value};
use test_chain_rpc::{Answer, Chain, TestChainRpc};

/// The bounty contract a default build of the judge is pinned to (`src/sealed.rs`).
const BOUNTY_CONTRACT: &str = "bounty.bountee.testnet";
const CHAIN: u64 = 84532;
const VAULT: &str = "0x00000000000000000000000000000000000000aa";
const POOL: &str = "0x00000000000000000000000000000000000000bb";
const SOMEONE_ELSE: &str = "0x00000000000000000000000000000000000000ee";
const HEAD: u64 = 1_000;

fn bounty() -> Value {
    json!({ "protocol": "protocol.testnet", "name": "demo-vault-1" })
}

/// The bounty's pause-role address (D25), from the formats' own derivation.
fn pause_role() -> String {
    pause_role_under(pause_role::TESTNET_ROOT_PUBLIC_KEY, BOUNTY_CONTRACT)
}

/// The bounty's pause-role address under the MPC root key `root`, for `contract`.
fn pause_role_under(root: &str, contract: &str) -> String {
    let id: BountyId = from_json(&bounty().to_string()).unwrap();
    let contract = AccountId::parse(contract).unwrap();
    pause_role::address(root, &contract, &id)
        .unwrap()
        .as_str()
        .to_owned()
}

/// The pause gas `n` pauses need on one chain, worked out from the spec: 200,000 gas at
/// 1 gwei is 0.0002 ETH, plus 0.00001 ETH of L1 data fee allowance, per pause.
fn needed(n: u128) -> u128 {
    n * 210_000_000_000_000
}

fn job(covered: &[(u64, &str)]) -> Value {
    let mut rules: Value = serde_json::from_str(
        &std::fs::read_to_string(common::repo_root().join("judge/tests/fixtures/rules.json"))
            .unwrap(),
    )
    .unwrap();
    rules["covered_contracts"] = covered
        .iter()
        .map(|(chain, address)| json!({ "chain_id": chain, "address": address }))
        .collect();
    json!({ "posting_check": { "bounty": bounty(), "rules": rules } })
}

/// A chain where `VAULT` can be paused by the pause role, which holds `balance`.
fn granted(balance: u128) -> Chain {
    Chain::at(HEAD)
        .contract(VAULT, Some(&pause_role()))
        .balance(&pause_role(), balance)
}

fn run(wasm: &PathBuf, job: &Value, rpcs: &[TestChainRpc]) -> Output {
    run_per_chain(wasm, job, rpcs, &[])
}

fn urls(rpcs: &[TestChainRpc]) -> String {
    rpcs.iter().map(|r| r.url.as_str()).collect::<Vec<_>>().join(",")
}

/// Run `wasm` on `job` with `rpcs` as every chain's stand-ins, except the chains named in
/// `per_chain`, which get their own (`BOUNTEE_TEST_RPCS_<chain id>`).
fn run_per_chain(
    wasm: &PathBuf,
    job: &Value,
    rpcs: &[TestChainRpc],
    per_chain: &[(u64, &[TestChainRpc])],
) -> Output {
    run_as(BOUNTY_CONTRACT, wasm, job, rpcs, per_chain)
}

/// [`run_per_chain`] for a build pinned to `contract`, in a job that contract requested.
fn run_as(
    contract: &str,
    wasm: &PathBuf,
    job: &Value,
    rpcs: &[TestChainRpc],
    per_chain: &[(u64, &[TestChainRpc])],
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
    let mut child = command
        .arg("--env")
        .arg(format!("NEAR_PREDECESSOR_ID={contract}"))
        .arg("--")
        .arg(wasm)
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
        out.stderr.is_empty(),
        "nothing goes to stderr in enclave mode: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    out
}

fn check(job: &Value, answers: [Answer; 3]) -> (PostingCheckResult, [TestChainRpc; 3]) {
    let rpcs = answers.map(TestChainRpc::answering);
    let out = run(test_build(), job, &rpcs);
    (result(&out), rpcs)
}

fn result(out: &Output) -> PostingCheckResult {
    assert!(out.status.success(), "a posting check always answers");
    let stdout = String::from_utf8(out.stdout.clone()).unwrap();
    assert!(stdout.len() <= 900, "OutLayer truncates output over 900 bytes");
    from_json(stdout.trim()).expect("stdout is a posting check result")
}

/// Each failure as (the failing contract's index in the rules, its reason).
fn reasons(result: &PostingCheckResult) -> Vec<(u32, PostingFailureReason)> {
    result.failures.iter().map(|f| (f.index, f.reason)).collect()
}

fn all(chain: Chain) -> [Answer; 3] {
    [
        Answer::Chain(chain.clone()),
        Answer::Chain(chain.clone()),
        Answer::Chain(chain),
    ]
}

// ---- Passing ------------------------------------------------------------------------------

/// R12.1, R12.2, R7.6: a covered contract the pause role can pause, with the pause gas
/// its pause needs, passes; every read names one block below the head, never `latest`.
#[test]
fn r12_1_r7_6_a_granted_pausable_contract_with_its_pause_gas_passes() {
    let (result, rpcs) = check(&job(&[(CHAIN, VAULT)]), all(granted(needed(1))));
    assert!(result.passed(), "{result:?}");
    for rpc in &rpcs {
        for request in rpc.requests() {
            if request["method"] == "eth_blockNumber" {
                continue;
            }
            let params = request["params"].as_array().unwrap();
            let block = params.last().unwrap().as_str().unwrap();
            assert_eq!(block, format!("{HEAD:#x}"), "{request}");
        }
    }
}

/// The figure the judge checks is the formats' own, and it is the spec's 0.00021 ETH.
#[test]
fn r7_6_the_pause_gas_per_pause_is_gas_limit_at_fee_limit_plus_l1_fee() {
    assert_eq!(pause_gas_per_pause(), needed(1));
    assert_eq!(
        u128::from(PAUSE_GAS_LIMIT) * PAUSE_MAX_FEE_PER_GAS,
        200_000_000_000_000
    );
}

// ---- R7.6: pause gas ----------------------------------------------------------------------

/// R7.6: exactly gas limit × fee limit (0.0002 ETH), what the Day-3 run funded and Base's
/// pool refused for its L1 data fee, is too little.
#[test]
fn r7_6_gas_limit_at_fee_limit_without_the_l1_fee_is_too_little() {
    let (result, _) = check(&job(&[(CHAIN, VAULT)]), all(granted(200_000_000_000_000)));
    assert_eq!(
        reasons(&result),
        vec![(0, PostingFailureReason::PauseGasShort)]
    );
}

/// R7.6: two covered contracts on one chain are two pauses (nonce 0 and 1), so the pause
/// role needs gas for both.
#[test]
fn r7_6_two_contracts_on_a_chain_need_gas_for_two_pauses() {
    let chain = |balance| {
        granted(balance).contract(POOL, Some(&pause_role()))
    };
    let (short, _) = check(
        &job(&[(CHAIN, VAULT), (CHAIN, POOL)]),
        all(chain(needed(2) - 1)),
    );
    assert_eq!(
        reasons(&short),
        vec![
            (0, PostingFailureReason::PauseGasShort),
            (1, PostingFailureReason::PauseGasShort),
        ]
    );
    let (enough, _) = check(&job(&[(CHAIN, VAULT), (CHAIN, POOL)]), all(chain(needed(2))));
    assert!(enough.passed(), "{enough:?}");
}

// ---- R12.1, R12.2: the simulated pause ------------------------------------------------------

/// R12.1: a covered contract that granted the pause role to another address, not to this
/// bounty's, fails.
#[test]
fn r12_1_a_contract_that_has_not_granted_the_pause_role_fails() {
    let chain = Chain::at(HEAD)
        .contract(VAULT, Some(SOMEONE_ELSE))
        .balance(&pause_role(), needed(1));
    let (result, _) = check(&job(&[(CHAIN, VAULT)]), all(chain));
    assert_eq!(
        reasons(&result),
        vec![(0, PostingFailureReason::CannotPause)]
    );
}

/// R12.2: a contract whose `pause()` reverts from every address (no pause, or already
/// paused) fails, and so does an address with no code, where a call "succeeds" doing
/// nothing; the other covered contract still passes.
#[test]
fn r12_2_a_contract_that_cannot_be_paused_fails() {
    let chain = granted(needed(3))
        .contract(POOL, None);
    let no_code = "0x00000000000000000000000000000000000000cc";
    let (result, _) = check(
        &job(&[(CHAIN, VAULT), (CHAIN, POOL), (CHAIN, no_code)]),
        all(chain),
    );
    assert_eq!(
        reasons(&result),
        vec![
            (1, PostingFailureReason::CannotPause),
            (2, PostingFailureReason::CannotPause),
        ]
    );
}

// ---- D1, R12.5: a bounty covering two chains ------------------------------------------------

/// D1, R12.5, R7.6: a bounty covering Base Sepolia and Arbitrum Sepolia is checked on each
/// chain through that chain's own RPCs, at that chain's own block, and one chain's failure
/// fails only its own contract: here Arbitrum's pause role is one wei short of its pause gas.
#[test]
fn d1_r12_5_each_covered_chain_is_read_through_its_own_rpcs() {
    const ARBITRUM: u64 = 421614;
    const ARB_VAULT: &str = "0x00000000000000000000000000000000000000ab";
    let arbitrum = Chain::at(HEAD + 400)
        .contract(ARB_VAULT, Some(&pause_role()))
        .balance(&pause_role(), needed(1) - 1);
    let base_rpcs = all(granted(needed(1))).map(TestChainRpc::answering);
    let arb_rpcs = all(arbitrum).map(TestChainRpc::answering);
    let out = run_per_chain(
        test_build(),
        &job(&[(CHAIN, VAULT), (ARBITRUM, ARB_VAULT)]),
        &base_rpcs,
        &[(ARBITRUM, &arb_rpcs)],
    );
    assert_eq!(
        reasons(&result(&out)),
        vec![(1, PostingFailureReason::PauseGasShort)]
    );
    let asked = |rpcs: &[TestChainRpc]| -> Vec<Value> {
        rpcs.iter()
            .flat_map(|r| r.requests())
            .filter(|r| r["method"] == "eth_getCode")
            .map(|r| r["params"].clone())
            .collect()
    };
    let (base, arb) = (asked(&base_rpcs), asked(&arb_rpcs));
    assert_eq!((base.len(), arb.len()), (3, 3), "{base:?} {arb:?}");
    assert!(
        base.iter().all(|p| p[0] == VAULT && p[1] == format!("{HEAD:#x}")),
        "{base:?}"
    );
    assert!(
        arb.iter()
            .all(|p| p[0] == ARB_VAULT && p[1] == format!("{:#x}", HEAD + 400)),
        "{arb:?}"
    );
}

// ---- R12.5: at least two pinned RPCs answer and agree ------------------------------------

/// R12.5: two answering and agreeing is enough when the third is down or errs.
#[test]
fn r12_5_two_agreeing_answers_are_enough() {
    let chain = Answer::Chain(granted(needed(1)));
    let (down, _) = check(&job(&[(CHAIN, VAULT)]), [chain.clone(), Answer::Down, chain.clone()]);
    assert!(down.passed(), "{down:?}");
    let (error, _) = check(&job(&[(CHAIN, VAULT)]), [Answer::Error, chain.clone(), chain]);
    assert!(error.passed(), "{error:?}");
}

/// R12.5: one answer is not enough, however good it is.
#[test]
fn r12_5_one_answer_fails() {
    let (result, _) = check(
        &job(&[(CHAIN, VAULT)]),
        [Answer::Down, Answer::Chain(granted(needed(1))), Answer::Error],
    );
    assert_eq!(
        reasons(&result),
        vec![(0, PostingFailureReason::ChainUnconfirmed)]
    );
}

/// R12.5: three answers that don't all agree fail, even when two of them pass: on the
/// pause-role balance, or on whether the pause goes through.
#[test]
fn r12_5_disagreeing_answers_fail() {
    let good = Answer::Chain(granted(needed(1)));
    let poorer = Answer::Chain(granted(needed(1) - 1));
    let (balance, _) = check(&job(&[(CHAIN, VAULT)]), [good.clone(), poorer, good.clone()]);
    assert_eq!(
        reasons(&balance),
        vec![(0, PostingFailureReason::ChainUnconfirmed)]
    );
    let revoked = Answer::Chain(
        Chain::at(HEAD)
            .contract(VAULT, Some(SOMEONE_ELSE))
            .balance(&pause_role(), needed(1)),
    );
    let (pause, _) = check(&job(&[(CHAIN, VAULT)]), [good.clone(), good, revoked]);
    assert_eq!(
        reasons(&pause),
        vec![(0, PostingFailureReason::ChainUnconfirmed)]
    );
}

/// R12.5: RPCs at different heads are read at one block every answering RPC has: the
/// second-highest head, so at least two can answer for it.
#[test]
fn r12_5_reads_are_pinned_to_a_block_two_rpcs_have() {
    let at = |head| Answer::Chain(Chain { head, ..granted(needed(1)) });
    let (result, rpcs) = check(&job(&[(CHAIN, VAULT)]), [at(HEAD + 5), at(HEAD), at(HEAD + 2)]);
    assert!(result.passed(), "{result:?}");
    let blocks: Vec<String> = rpcs
        .iter()
        .flat_map(|r| r.requests())
        .filter(|r| r["method"] == "eth_getBalance")
        .map(|r| r["params"][1].as_str().unwrap().to_owned())
        .collect();
    assert!(!blocks.is_empty());
    assert!(blocks.iter().all(|b| *b == format!("{:#x}", HEAD + 2)), "{blocks:?}");
}

/// R12.5: the attested build reads RPC addresses only from the table compiled into it.
/// Pointed at three good stand-ins through `BOUNTEE_TEST_RPCS`, it asks none of them; it
/// pins no RPCs for a local chain (31337), so the contract there fails unconfirmed.
#[test]
fn r12_5_attested_build_ignores_the_test_rpc_override() {
    let rpcs = all(granted(needed(1))).map(TestChainRpc::answering);
    let out = run(attested_build(), &job(&[(31337, VAULT)]), &rpcs);
    assert_eq!(
        reasons(&result(&out)),
        vec![(0, PostingFailureReason::ChainUnconfirmed)]
    );
    assert_eq!(rpcs.iter().map(|r| r.requests().len()).sum::<usize>(), 0);
}

/// R12.5: a posting check job can't carry RPC addresses: one naming any is refused before
/// anything is asked, and the job gives no passing answer.
#[test]
fn r12_5_a_job_naming_rpcs_asks_nothing_and_does_not_pass() {
    let rpcs = all(granted(needed(1))).map(TestChainRpc::answering);
    let mut job = job(&[(CHAIN, VAULT)]);
    job["posting_check"]["rpcs"] = json!([rpcs[0].url]);
    let out = run(test_build(), &job, &rpcs);
    let passed = from_json::<PostingCheckResult>(String::from_utf8_lossy(&out.stdout).trim())
        .map(|r| r.passed())
        .unwrap_or(false);
    assert!(!passed);
    assert_eq!(rpcs.iter().map(|r| r.requests().len()).sum::<usize>(), 0);
}

/// R12.1, R12.2, R7.6: the answer for the most contracts a bounty may cover, all failing,
/// still fits OutLayer's 900-byte output.
#[test]
fn r12_1_eight_failures_fit_in_the_output() {
    let addresses: Vec<String> = (0..8).map(|i| format!("0x{:040x}", 0xa0 + i)).collect();
    let covered: Vec<(u64, &str)> = addresses.iter().map(|a| (CHAIN, a.as_str())).collect();
    let (result, _) = check(&job(&covered), all(Chain::at(HEAD)));
    assert_eq!(result.failures.len(), 8);
}

// ---- R12.5: each build reads only its own network's chains (#43) ------------------------

const ARBITRUM_SEPOLIA: u64 = 421614;

fn asked(rpcs: &[TestChainRpc]) -> usize {
    rpcs.iter().map(|r| r.requests().len()).sum()
}

/// R12.5, R12.1, R7.6: a build for the mainnet bounty contract checks a vault on Base and
/// one on Arbitrum One through each chain's own RPCs, from the pause-role address under
/// the mainnet MPC root key (the only address the stand-ins let pause), and both pass.
#[test]
fn r12_5_mainnet_build_checks_base_and_arbitrum_one() {
    let role = pause_role_under(pause_role::MAINNET_ROOT_PUBLIC_KEY, MAINNET_BOUNTY_CONTRACT);
    let chain = Chain::at(HEAD)
        .contract(VAULT, Some(&role))
        .balance(&role, needed(1));
    let base = all(chain.clone()).map(TestChainRpc::answering);
    let arbitrum = all(chain).map(TestChainRpc::answering);
    let out = run_as(
        MAINNET_BOUNTY_CONTRACT,
        mainnet_test_build(),
        &job(&[(BASE, VAULT), (ARBITRUM_ONE, VAULT)]),
        &[],
        &[(BASE, &base), (ARBITRUM_ONE, &arbitrum)],
    );
    let result = result(&out);
    assert!(result.passed(), "{result:?}");
    assert!(asked(&base) > 0 && asked(&arbitrum) > 0);
}

/// R12.5: a mainnet build refuses a Sepolia chain: the contract there is unconfirmed and
/// no RPC is asked, even though the stand-ins would pass it.
#[test]
fn r12_5_mainnet_build_refuses_a_sepolia_chain() {
    let role = pause_role_under(pause_role::MAINNET_ROOT_PUBLIC_KEY, MAINNET_BOUNTY_CONTRACT);
    let chain = Chain::at(HEAD)
        .contract(VAULT, Some(&role))
        .balance(&role, needed(2));
    let rpcs = all(chain).map(TestChainRpc::answering);
    let out = run_as(
        MAINNET_BOUNTY_CONTRACT,
        mainnet_test_build(),
        &job(&[(CHAIN, VAULT), (ARBITRUM_SEPOLIA, VAULT)]),
        &rpcs,
        &[],
    );
    assert_eq!(
        reasons(&result(&out)),
        vec![
            (0, PostingFailureReason::ChainUnconfirmed),
            (1, PostingFailureReason::ChainUnconfirmed),
        ]
    );
    assert_eq!(asked(&rpcs), 0);
}

/// R12.5: the reverse: a testnet build refuses Base and Arbitrum One.
#[test]
fn r12_5_testnet_build_refuses_a_mainnet_chain() {
    let rpcs = all(granted(needed(2))).map(TestChainRpc::answering);
    let out = run(
        test_build(),
        &job(&[(BASE, VAULT), (ARBITRUM_ONE, VAULT)]),
        &rpcs,
    );
    assert_eq!(
        reasons(&result(&out)),
        vec![
            (0, PostingFailureReason::ChainUnconfirmed),
            (1, PostingFailureReason::ChainUnconfirmed),
        ]
    );
    assert_eq!(asked(&rpcs), 0);
}
