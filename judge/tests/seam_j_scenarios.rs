//! Seam J, ticket #10: the payout rule against the R4.10 scenario table, and randomized
//! sequences of the demo protocol's honest actions (R4.6). The judge as the enclave runs
//! it: the one WebAssembly build under wasmtime, a replay job on stdin, a verdict out.
//!
//! Seams, written down before the first test:
//! - J (this file): the compiled wasm32-wasip2 judge under wasmtime, fed replay jobs built
//!   from `fixtures/scenarios/`: one anvil block (`state.json`) holding the demo protocol
//!   (demo/src, unchanged: the old vault, and the position vault deployed last) beside one
//!   small contract per scenario
//!   (`scenarios/chain/src/Scenarios.sol`), the exploits as Foundry dry runs
//!   (`scenarios/exploits/*.json`), and a later block after an owner's patch
//!   (`state-later.json`). Each test picks the bounty's rules (covered contracts, listed
//!   tokens and prices, minimum theft), so the same chain is judged under different
//!   bounties. Catches: every R4.10 row's verdict through the attested build, scores
//!   checked exactly against the scripts' known amounts (not the judge's own reads), and
//!   R4.6 over generated action sequences. Misses: rows verified elsewhere (12 can't be
//!   one exploit; 17 R3.6/R5.6 at seam C; 18 R7.1; 19 R2.8 in #14; 22–24 the Damn
//!   Vulnerable DeFi levels in #27), execution on Base itself (fixtures come from anvil),
//!   and whether the command-line tool fetches these proofs from a real RPC (#11, seam T).
//!
//! R15.3: every test reads only committed files; no keys, funds or network. Remake the
//! fixtures with `node judge/tests/fixtures/scenarios/make-scenarios.ts`.

mod common;

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use bountee_formats::{from_json, Reason, Verdict};
use common::{repo_root, wasm_target};
use proptest::prelude::*;
use revm::primitives::keccak256;
use serde_json::{json, Value};

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

fn verdict_of(job: &Value) -> Verdict {
    let mut child = Command::new("wasmtime")
        .args(["run", "-S", "http", "--"])
        .arg(judge_wasm())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("wasmtime is installed");
    child
        .stdin
        .take()
        .unwrap()
        .write_all(job.to_string().as_bytes())
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success(), "the judge exits cleanly");
    from_json(String::from_utf8(out.stdout).unwrap().trim()).expect("stdout is a verdict")
}

fn reason_of(job: &Value) -> Reason {
    let verdict = verdict_of(job);
    assert_eq!(verdict.outcome(), verdict.reason().outcome());
    verdict.reason()
}

// ---- Fixtures ----------------------------------------------------------------------------

fn fixture(path: &str) -> Value {
    static CACHE: OnceLock<std::sync::Mutex<std::collections::HashMap<String, Value>>> =
        OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    let mut cache = cache.lock().unwrap();
    cache
        .entry(path.to_owned())
        .or_insert_with(|| {
            let file = repo_root()
                .join("judge/tests/fixtures/scenarios")
                .join(path);
            serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap()
        })
        .clone()
}

/// A scenario chain address by name (`state.json`'s `addresses`).
fn address(name: &str) -> String {
    fixture("state.json")["addresses"][name]
        .as_str()
        .unwrap_or_else(|| panic!("no address {name}"))
        .to_owned()
}

/// Posting prices, per smallest unit, in units of 10^-18 USD: test USDC (6 decimals) at
/// $1, native coin at $3,000 an ether.
const USDC: u128 = 1_000_000_000_000;
const NATIVE: u128 = 3_000;
const ETHER: u128 = 1_000_000_000_000_000_000;
/// One whole test USDC, in its smallest unit.
const DOLLAR: u128 = 1_000_000;

/// A bounty over the scenario chain: these contracts covered, these tokens (`"native"` or
/// an address name) listed at these prices, and a minimum theft of one value unit, so any
/// score above zero PAYS.
struct Bounty<'a> {
    covered: &'a [&'a str],
    listed: &'a [(&'a str, u128)],
}

const USDC_AND_NATIVE: &[(&str, u128)] = &[("usdc", USDC), ("native", NATIVE)];

fn job_at(state: &str, exploit: Value, bounty: &Bounty) -> Value {
    let state = fixture(state);
    let mut rules = fixture("rules.json");
    rules["covered_contracts"] = bounty
        .covered
        .iter()
        .map(|c| json!({ "chain_id": 31337, "address": address(c) }))
        .collect();
    rules["listed_tokens"] = bounty
        .listed
        .iter()
        .map(|(t, p)| {
            let token = if *t == "native" {
                "native".to_owned()
            } else {
                address(t)
            };
            json!({ "token": token, "price": p.to_string() })
        })
        .collect();
    json!({ "replay": {
        "rules": rules,
        "block": state["block"],
        "header": state["header"],
        "proofs": state["proofs"],
        "exploit": exploit,
    }})
}

fn job(exploit: &str, bounty: &Bounty) -> Value {
    job_at(
        "state.json",
        fixture(&format!("exploits/{exploit}.json")),
        bounty,
    )
}

fn with_minimum(mut job: Value, minimum: u128) -> Value {
    job["replay"]["rules"]["minimum_theft"] = json!(minimum.to_string());
    job
}

/// The verdict at minimum theft 1: PAYS for any score above zero.
fn verdict(exploit: &str, bounty: &Bounty) -> Reason {
    reason_of(&job(exploit, bounty))
}

/// The score is exactly `score`: PAYS at that minimum theft, ZERO one unit above it.
fn assert_score(job: Value, score: u128) {
    assert_eq!(
        reason_of(&with_minimum(job.clone(), score)),
        Reason::MinimumTheftReached,
        "score reaches {score}"
    );
    assert_eq!(
        reason_of(&with_minimum(job, score + 1)),
        Reason::BelowMinimumTheft,
        "score is below {}",
        score + 1
    );
}

const ZERO: Reason = Reason::BelowMinimumTheft;
const PAYS: Reason = Reason::MinimumTheftReached;

// ---- R4.10 rows 1–7: no theft from a covered contract --------------------------------------

/// R4.10 row 1, R4.2: a fresh account deposits 500 USDC in the demo vault and withdraws it.
#[test]
fn r4_10_row_1_r4_2_deposit_then_withdraw_scores_zero() {
    let bounty = Bounty {
        covered: &["demo"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("honest", &bounty), ZERO);
}

/// R4.10 row 2a: a fresh account calls the guarded vault's owner-only rescue. It reverts
/// (fresh accounts hold no roles), which is a ZERO, not an INVALID.
#[test]
fn r4_10_row_2a_owner_rescue_by_a_fresh_account_scores_zero() {
    let bounty = Bounty {
        covered: &["guarded"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("ownerRescue", &bounty), ZERO);
}

/// R4.10 row 2b, R4.1: the same rescue sent from the owner's own account, which exists at
/// the claim's block (it would take the vault's 5,000 USDC), is INVALID.
#[test]
fn r4_10_row_2b_r4_1_bundle_from_the_owner_is_invalid() {
    let bounty = Bounty {
        covered: &["guarded"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(
        verdict("ownerImpersonation", &bounty),
        Reason::ExistingSender
    );
}

/// R4.10 row 3, R4.3: a fresh account sweeps the guarded vault's 5,000 USDC to the
/// treasury. The covered contract loses it all, but the attacker gains nothing.
#[test]
fn r4_10_row_3_r4_3_sweep_to_the_treasury_scores_zero() {
    let bounty = Bounty {
        covered: &["guarded"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("sweep", &bounty), ZERO);
}

/// R4.10 row 4, R4.4: half an ether buys about 1,492 USDC in a dependency pool. At a
/// posting price of $2 a USDC that is a gain of about $1,485, but no covered contract
/// loses anything, so it scores zero, even with the pool's own numbers on the chain.
#[test]
fn r4_10_row_4_r4_4_swap_in_a_dependency_pool_scores_zero() {
    let dear_usdc = Bounty {
        covered: &["demo"],
        listed: &[("usdc", 2 * USDC), ("native", NATIVE)],
    };
    assert_eq!(verdict("swap", &dear_usdc), ZERO);
    // The gain is real: covering the pool as well (where it loses that USDC) pays.
    let pool_covered = Bounty {
        covered: &["demo", "usdcPool"],
        listed: &[("usdc", 2 * USDC)],
    };
    assert_eq!(verdict("swap", &pool_covered), PAYS);
}

/// R4.10 row 5: repaying a dependency lender's 0.5-ether debt takes 1,650 USDC of
/// collateral, a $150 liquidation bonus. A lender pays callers by design (out of scope as
/// a covered contract, R4.12); as a dependency it scores zero.
#[test]
fn r4_10_row_5_liquidation_bonus_from_a_dependency_scores_zero() {
    let bounty = Bounty {
        covered: &["demo"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("liquidate", &bounty), ZERO);
}

/// R4.10 row 6: half an ether buys USDC where it is cheap and sells it where it is dear,
/// ending with more ether. Dependencies only (R4.12): zero.
#[test]
fn r4_10_row_6_arbitrage_of_mispriced_dependency_pools_scores_zero() {
    let bounty = Bounty {
        covered: &["demo"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("arbitrage", &bounty), ZERO);
}

/// R4.10 row 7: a contract of the fresh account's flash-borrows 50,000 USDC, deposits and
/// withdraws it in the covered demo vault, and repays in the same bundle: zero.
#[test]
fn r4_10_row_7_flash_loan_repaid_in_the_bundle_scores_zero() {
    let bounty = Bounty {
        covered: &["demo"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("flashLoan", &bounty), ZERO);
}

// ---- R4.10 rows 8–9: a drain of a covered contract, and R4.8 -------------------------------

/// The bank's 10 ether, taken by reentrancy with a 0.5-ether stake: gain = loss = 10
/// ether, at $3,000.
const BANK_DRAIN: u128 = 10 * ETHER * NATIVE;

/// R4.10 row 8: a reentrancy drain of the covered bank, the proceeds swept on to the fresh
/// account, PAYS, with the score exactly the 10 ether drained.
#[test]
fn r4_10_row_8_reentrancy_drain_swept_to_a_fresh_account_pays() {
    let bounty = Bounty {
        covered: &["bank"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("reentrancySwept", &bounty), PAYS);
    assert_score(job("reentrancySwept", &bounty), BANK_DRAIN);
}

/// R4.10 row 9, R4.8: the same drain with the proceeds left in the drainer contract the
/// fresh account created: they count as gain, the same score.
#[test]
fn r4_10_row_9_r4_8_proceeds_kept_in_an_attacker_created_contract_pay() {
    let bounty = Bounty {
        covered: &["bank"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("reentrancyKept", &bounty), PAYS);
    assert_score(job("reentrancyKept", &bounty), BANK_DRAIN);
}

// ---- R4.10 rows 10 and 20: unproven state ------------------------------------------------

fn drop_proof(job: &mut Value, name: &str) {
    let address = address(name);
    let proofs = job["replay"]["proofs"].as_array_mut().unwrap();
    let before = proofs.len();
    proofs.retain(|p| p["address"] != address.as_str());
    assert_eq!(proofs.len() + 1, before, "the fixture proves {name}");
}

/// R4.10 row 10, R4.5: the bank drain with no proof of the bank account, or with none of
/// the bank's storage slots proven, is INVALID.
#[test]
fn r4_10_row_10_r4_5_unproven_account_or_slot_is_invalid() {
    let bounty = Bounty {
        covered: &["bank"],
        listed: USDC_AND_NATIVE,
    };
    let mut account = job("reentrancySwept", &bounty);
    drop_proof(&mut account, "bank");
    assert_eq!(reason_of(&account), Reason::UnprovenState);

    let mut slot = job("reentrancySwept", &bounty);
    let bank = address("bank");
    let proofs = slot["replay"]["proofs"].as_array_mut().unwrap();
    let proof = proofs
        .iter_mut()
        .find(|p| p["address"] == bank.as_str())
        .unwrap();
    assert!(!proof["storage"].as_array().unwrap().is_empty());
    proof["storage"] = json!([]);
    assert_eq!(reason_of(&slot), Reason::UnprovenState);
}

/// R4.10 row 20, R4.5: proofs from another block (the one after the owner's patch) don't
/// hold against the claim block's state root: INVALID.
#[test]
fn r4_10_row_20_r4_5_proofs_of_another_block_are_invalid() {
    let bounty = Bounty {
        covered: &["late"],
        listed: USDC_AND_NATIVE,
    };
    let mut j = job("lateFix", &bounty);
    j["replay"]["proofs"] = fixture("state-later.json")["proofs"].clone();
    assert_eq!(reason_of(&j), Reason::UnprovenState);
}

/// R4.5: a slot is proven zero by a proof of its absence or by a leaf holding zero (anvil
/// keeps one for a slot a transaction only read: here the demo vault's `paused`, slot 0,
/// read by its deposit during setup). Both are proofs against the state root; refusing the
/// second made every demo vault claim INVALID until ticket #10 fixed it.
#[test]
fn r4_5_slot_proven_zero_by_a_zero_valued_leaf_is_proven() {
    let state = fixture("state.json");
    let demo = address("demo");
    let proof = state["proofs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["address"] == demo.as_str())
        .unwrap();
    let zero = format!("0x{}", "0".repeat(64));
    let slot0 = proof["storage"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["key"] == zero.as_str())
        .unwrap();
    assert_eq!(slot0["value"], zero.as_str());
    let leaf = slot0["proof"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .as_str()
        .unwrap();
    assert!(
        leaf.ends_with("8180"),
        "the last node is a leaf whose value is RLP zero: {leaf}"
    );
    let bounty = Bounty {
        covered: &["demo"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("demoExploit", &bounty), PAYS);
}

// ---- R4.10 rows 11a–11c: an unlimited mint -----------------------------------------------

/// R4.10 row 11a: a billion of the Protocol's buggy token, minted and kept, scores zero,
/// listed at $1 or not: no covered contract loses anything.
#[test]
fn r4_10_row_11a_unlimited_mint_not_sold_scores_zero() {
    let listed = Bounty {
        covered: &["demo", "swapVault"],
        listed: &[("pt", USDC), ("usdc", USDC)],
    };
    assert_eq!(verdict("mintOnly", &listed), ZERO);
    let unlisted = Bounty {
        covered: &["demo", "swapVault"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("mintOnly", &unlisted), ZERO);
}

/// R4.10 row 11b: 20,000 minted tokens swapped into the covered swap vault for its 20,000
/// USDC PAYS, scored exactly at the USDC taken (the minted token isn't listed).
#[test]
fn r4_10_row_11b_mint_swapped_into_a_covered_vault_pays() {
    let bounty = Bounty {
        covered: &["swapVault"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("mintSwapCovered", &bounty), PAYS);
    assert_score(job("mintSwapCovered", &bounty), 20_000 * DOLLAR * USDC);
}

/// R4.10 row 11c, R4.4: minted tokens sold into an uncovered pool for ether (a gain of
/// 5 ether) score zero: the value came from a dependency.
#[test]
fn r4_10_row_11c_r4_4_mint_sold_into_an_uncovered_pool_scores_zero() {
    let bounty = Bounty {
        covered: &["demo", "swapVault"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("mintSellPool", &bounty), ZERO);
}

// ---- R4.10 rows 13–16 --------------------------------------------------------------------

/// R4.10 row 13: 100,000 USDC taken from the owner's wallet through its approval to the
/// covered router scores zero: the router itself holds nothing and loses nothing.
#[test]
fn r4_10_row_13_theft_of_wallet_approvals_scores_zero() {
    let bounty = Bounty {
        covered: &["router", "demo"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("approvalTheft", &bounty), ZERO);
}

/// R4.10 row 14: a fresh account freezes the guarded vault for good; it still holds its
/// funds, so nothing is lost or gained: zero.
#[test]
fn r4_10_row_14_permanent_freeze_scores_zero() {
    let bounty = Bounty {
        covered: &["guarded"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("freeze", &bounty), ZERO);
}

/// R4.10 row 15: the first-depositor inflation setup on the covered share vault (deposit
/// one unit, donate 10,000 USDC) profits only from a victim's later deposit, which no
/// exploit can hold: zero.
#[test]
fn r4_10_row_15_attack_needing_a_victims_later_transaction_scores_zero() {
    let bounty = Bounty {
        covered: &["shareVault"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("inflation", &bounty), ZERO);
}

/// R4.10 row 16: the bug in a vault the owner patched before the claim's block reverts and
/// scores zero. The same bug in a vault patched only after the claim's block still PAYS,
/// for its 5,000 USDC, against the claim's block; a claim on the block after the patch is
/// zero.
#[test]
fn r4_10_row_16_a_fix_counts_only_before_the_claims_block() {
    let early = Bounty {
        covered: &["early"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("fixedBug", &early), ZERO);

    let late = Bounty {
        covered: &["late"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("lateFix", &late), PAYS);
    assert_score(job("lateFix", &late), 5_000 * DOLLAR * USDC);
    let after = job_at("state-later.json", fixture("exploits/lateFix.json"), &late);
    assert_eq!(reason_of(&after), ZERO);
}

// ---- R4.10 rows 21, 25, 26: the demo protocol --------------------------------------------

/// The demo vault's 10,000 USDC, all of it, through its missing access check.
const DEMO_DRAIN: u128 = 10_000 * DOLLAR * USDC;

/// R4.10 row 21: the demo protocol's missing access check PAYS.
#[test]
fn r4_10_row_21_demo_missing_access_check_pays() {
    let bounty = Bounty {
        covered: &["demo"],
        listed: USDC_AND_NATIVE,
    };
    assert_eq!(verdict("demoExploit", &bounty), PAYS);
}

/// R4.10 rows 25 and 26, R3.8: the demo drain scores exactly $10,000: at that minimum
/// theft it PAYS, one value unit above it is ZERO.
#[test]
fn r4_10_rows_25_26_r3_8_drain_at_and_just_below_the_minimum_theft() {
    let bounty = Bounty {
        covered: &["demo"],
        listed: USDC_AND_NATIVE,
    };
    assert_score(job("demoExploit", &bounty), DEMO_DRAIN);
}

// ---- R4.9: only listed tokens, at posting prices ------------------------------------------

/// R4.9: the demo drain followed by a trade that moves the USDC pool's spot price: 1 ether
/// buys floor(300,000e6 · 1e18 / 101e18) = 2,970,297,029 USDC units. The score is exactly
/// the gain at posting prices, (10,000e6 + 2,970,297,029)·USDC − 1 ether·NATIVE, below the
/// loss, whatever the pool now quotes.
#[test]
fn r4_9_score_uses_posting_prices_not_prices_read_in_the_replay() {
    let bounty = Bounty {
        covered: &["demo"],
        listed: USDC_AND_NATIVE,
    };
    let gain = (10_000 * DOLLAR + 2_970_297_029) * USDC - ETHER * NATIVE;
    assert!(gain < DEMO_DRAIN);
    assert_score(job("demoExploitAndPump", &bounty), gain);
}

/// R4.9: only listed tokens count. The 11b swap, with the minted token also listed at
/// USDC's price, leaves the covered vault with tokens worth what it lost: zero. With USDC
/// unlisted, the demo drain is worth nothing.
#[test]
fn r4_9_only_listed_tokens_count() {
    let both = Bounty {
        covered: &["swapVault"],
        listed: &[("usdc", USDC), ("pt", USDC)],
    };
    assert_eq!(verdict("mintSwapCovered", &both), ZERO);
    let native_only = Bounty {
        covered: &["demo"],
        listed: &[("native", NATIVE)],
    };
    assert_eq!(verdict("demoExploit", &native_only), ZERO);
}

// ---- R3.11: malformed exploits -----------------------------------------------------------

/// R3.11: an exploit of more transactions than the format allows, or whose input isn't
/// hex, is malformed.
#[test]
fn r3_11_malformed_scenario_exploits_are_invalid() {
    let bounty = Bounty {
        covered: &["demo"],
        listed: USDC_AND_NATIVE,
    };
    let tx = fixture("exploits/demoExploit.json")["transactions"][0].clone();
    let too_many = json!({ "transactions": vec![tx.clone(); 257] });
    assert_eq!(
        reason_of(&job_at("state.json", too_many, &bounty)),
        Reason::MalformedExploit
    );
    let mut bad_input = tx;
    bad_input["input"] = json!("0xzz");
    assert_eq!(
        reason_of(&job_at(
            "state.json",
            json!({ "transactions": [bad_input] }),
            &bounty
        )),
        Reason::MalformedExploit
    );
}

// ---- R4.6: randomized honest action sequences ---------------------------------------------

/// The demo protocol's honest actions, by one of three fresh accounts: the old vault
/// (`demo`, kept as scenario 21's) and the position vault (`positionVault`), which mints
/// shares at the vault's price and redeems them for their part of its USDC.
#[derive(Debug, Clone)]
enum Action {
    /// Mint test USDC to oneself (the demo's MockUSDC mint is open; HonestUser does this).
    Mint(u128),
    /// Approve the old vault.
    Approve(u128),
    /// Deposit in the old vault, at most the balance and the approval.
    Deposit(u128),
    /// Withdraw from the old vault, at most what one has deposited.
    Withdraw(u128),
    /// Send test USDC to another fresh account (or oneself).
    Transfer(usize, u128),
    /// Send native coin to another fresh account (or oneself).
    SendNative(usize, u128),
    /// Create one's own honest position for the position vault (the demo's HonestPosition),
    /// as one's first transaction.
    CreatePosition,
    /// Approve the position vault.
    VaultApprove(u128),
    /// Deposit in the position vault: within the balance and the approval, and enough for
    /// at least one share (the vault refuses a deposit that mints none).
    VaultDeposit(u128),
    /// Redeem at most the shares one holds.
    VaultRedeem(u128),
    /// Send test USDC to one's own position.
    FundPosition(u128),
    /// Deposit everything one's position holds, when that mints at least one share.
    DepositFrom,
}

/// The position vault at the claim's block, as `Scenarios.s.sol:Setup` leaves it: a
/// 10,000 USDC deposit for 10,000 USDC of shares, then 5,000 USDC more, so a share is
/// worth 1.5 USDC and deposits and redemptions round.
const VAULT_ASSETS: u128 = 15_000 * DOLLAR;
const VAULT_SHARES: u128 = 10_000 * DOLLAR;

/// What an honest sequence leaves in the two vaults, by the model's books.
struct Books {
    /// The old vault's USDC.
    demo: u128,
    /// The position vault's USDC.
    vault: u128,
    /// Which fresh accounts created a position.
    positions: [bool; 3],
}

/// One step as drawn: which action, by whom, to whom, and a number the amount is taken
/// from. The amount is clamped to what an honest account can do in [`honest_sequence`], so
/// every drawn sequence is honest and none is filtered out.
fn step() -> impl Strategy<Value = (u8, usize, usize, u128)> {
    (0u8..11, 0usize..3, 0usize..3, any::<u64>()).prop_map(|(k, i, j, n)| (k, i, j, n as u128))
}

/// Turn drawn steps into honest actions, tracking each account's USDC, approvals, deposit,
/// shares, position and native coin, and the position vault's USDC and shares, as the
/// demo contracts would, so no transaction reverts. An account whose flag in `positions`
/// is set creates its position as its first transaction (so at nonce 0, the address the
/// fixture proves). A step the account can't take honestly (a deposit too small for a
/// share, a position it doesn't have) becomes a mint of the drawn amount.
fn honest_sequence(
    steps: &[(u8, usize, usize, u128)],
    positions: [bool; 3],
    seed: u128,
) -> (Vec<(usize, Action)>, Books) {
    let mut usdc = [0u128; 3];
    let mut allowance = [0u128; 3];
    let mut deposit = [0u128; 3];
    let mut native = [seed; 3];
    let mut vault_allowance = [0u128; 3];
    let mut shares = [0u128; 3];
    let mut has_position = [false; 3];
    let mut in_position = [0u128; 3];
    let mut sent = [false; 3];
    let (mut assets, mut total_shares) = (VAULT_ASSETS, VAULT_SHARES);
    let up_to = |n: u128, max: u128| n % (max + 1);
    let mut out = Vec::new();
    for &(kind, i, j, n) in steps {
        if !sent[i] && positions[i] {
            has_position[i] = true;
            out.push((i, Action::CreatePosition));
        }
        sent[i] = true;
        let mint = |usdc: &mut [u128; 3]| {
            let a = up_to(n, 1_000_000 * DOLLAR);
            usdc[i] += a;
            Action::Mint(a)
        };
        // The least deposit that mints one share at the vault's price.
        let one_share = assets.div_ceil(total_shares);
        let action = match kind {
            1 => {
                let a = up_to(n, 2_000_000 * DOLLAR);
                allowance[i] = a;
                Action::Approve(a)
            }
            2 => {
                let a = up_to(n, usdc[i].min(allowance[i]));
                usdc[i] -= a;
                allowance[i] -= a;
                deposit[i] += a;
                Action::Deposit(a)
            }
            3 => {
                let a = up_to(n, deposit[i]);
                deposit[i] -= a;
                usdc[i] += a;
                Action::Withdraw(a)
            }
            4 => {
                let a = up_to(n, usdc[i]);
                usdc[i] -= a;
                usdc[j] += a;
                Action::Transfer(j, a)
            }
            5 => {
                let a = up_to(n, native[i]);
                native[i] -= a;
                native[j] += a;
                Action::SendNative(j, a)
            }
            6 => {
                let a = up_to(n, 2_000_000 * DOLLAR);
                vault_allowance[i] = a;
                Action::VaultApprove(a)
            }
            7 if usdc[i].min(vault_allowance[i]) >= one_share => {
                let a = one_share + up_to(n, usdc[i].min(vault_allowance[i]) - one_share);
                let minted = a * total_shares / assets;
                usdc[i] -= a;
                vault_allowance[i] -= a;
                shares[i] += minted;
                (assets, total_shares) = (assets + a, total_shares + minted);
                Action::VaultDeposit(a)
            }
            8 => {
                let s = up_to(n, shares[i]);
                let paid = s * assets / total_shares;
                shares[i] -= s;
                usdc[i] += paid;
                (assets, total_shares) = (assets - paid, total_shares - s);
                Action::VaultRedeem(s)
            }
            9 if has_position[i] => {
                let a = up_to(n, usdc[i]);
                usdc[i] -= a;
                in_position[i] += a;
                Action::FundPosition(a)
            }
            10 if has_position[i] && in_position[i] >= one_share => {
                let a = in_position[i];
                let minted = a * total_shares / assets;
                in_position[i] = 0;
                shares[i] += minted;
                (assets, total_shares) = (assets + a, total_shares + minted);
                Action::DepositFrom
            }
            _ => mint(&mut usdc),
        };
        out.push((i, action));
    }
    let books = Books {
        demo: 10_000 * DOLLAR + deposit.iter().sum::<u128>(),
        vault: assets,
        positions: has_position,
    };
    (out, books)
}

fn calldata(signature: &str, args: &[[u8; 32]]) -> String {
    let mut data = keccak256(signature.as_bytes())[..4].to_vec();
    for a in args {
        data.extend_from_slice(a);
    }
    format!(
        "0x{}",
        data.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

fn word_u(n: u128) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[16..].copy_from_slice(&n.to_be_bytes());
    w
}

fn word_a(address: &str) -> [u8; 32] {
    let mut w = [0u8; 32];
    for (k, byte) in w[12..].iter_mut().enumerate() {
        *byte = u8::from_str_radix(&address[2 + 2 * k..4 + 2 * k], 16).unwrap();
    }
    w
}

/// The three fresh accounts the fixture proves absent, with every slot their honest
/// actions read (`honestCoverAll`).
fn honest_accounts() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for tx in fixture("exploits/honestCoverAll.json")["transactions"]
        .as_array()
        .unwrap()
    {
        let from = tx["from"].as_str().unwrap().to_owned();
        if !out.contains(&from) {
            out.push(from);
        }
    }
    assert_eq!(out.len(), 3);
    out
}

/// Fresh account `i`'s honest position: the creation transaction `honestCoverAll` sends as
/// that account's first (the demo's HonestPosition, compiled by make-scenarios.ts, owned
/// by the account and attached to the position vault), and the address it lands at.
fn position_of(i: usize) -> (Value, String) {
    let who = &honest_accounts()[i];
    let create = fixture("exploits/honestCoverAll.json")["transactions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|tx| tx["from"] == json!(who) && tx["to"].is_null())
        .unwrap_or_else(|| panic!("{who} creates its position"))
        .clone();
    let address = format!("{:#x}", who.parse::<revm::primitives::Address>().unwrap().create(0));
    (create, address)
}

fn exploit_of(actions: &[(usize, Action)]) -> Value {
    let who = honest_accounts();
    let (usdc, demo, vault) = (address("usdc"), address("demo"), address("positionVault"));
    let txs: Vec<Value> = actions
        .iter()
        .map(|(i, action)| {
            let (position_create, position) = position_of(*i);
            let (to, value, input) = match action {
                Action::CreatePosition => return position_create,
                Action::Mint(a) => (&usdc, 0, calldata("mint(address,uint256)", &[word_a(&who[*i]), word_u(*a)])),
                Action::Approve(a) => (&usdc, 0, calldata("approve(address,uint256)", &[word_a(&demo), word_u(*a)])),
                Action::Deposit(a) => (&demo, 0, calldata("deposit(uint256)", &[word_u(*a)])),
                Action::Withdraw(a) => (&demo, 0, calldata("withdraw(uint256)", &[word_u(*a)])),
                Action::Transfer(j, a) => (&usdc, 0, calldata("transfer(address,uint256)", &[word_a(&who[*j]), word_u(*a)])),
                Action::SendNative(j, a) => (&who[*j], *a, "0x".to_owned()),
                Action::VaultApprove(a) => (&usdc, 0, calldata("approve(address,uint256)", &[word_a(&vault), word_u(*a)])),
                Action::VaultDeposit(a) => (&vault, 0, calldata("deposit(uint256)", &[word_u(*a)])),
                Action::VaultRedeem(s) => (&vault, 0, calldata("redeem(uint256)", &[word_u(*s)])),
                Action::FundPosition(a) => (&usdc, 0, calldata("transfer(address,uint256)", &[word_a(&position), word_u(*a)])),
                Action::DepositFrom => (&vault, 0, calldata("depositFrom(address)", &[word_a(&position)])),
            };
            json!({ "from": who[*i], "to": to, "value": value.to_string(), "input": input, "gas": 300000 })
        })
        .collect();
    json!({ "transactions": txs })
}

/// Which of the two vaults a generated bounty covers.
const COVERED: [&[&str]; 3] = [&["demo"], &["positionVault"], &["demo", "positionVault"]];

proptest! {
    #![proptest_config(ProptestConfig { cases: 64, failure_persistence: None, ..ProptestConfig::default() })]

    /// R4.6, R4.8: every sequence of the demo protocol's honest actions by fresh accounts —
    /// minting test USDC, approving, depositing in and withdrawing from the old vault,
    /// depositing in and redeeming from the position vault at its rounded share price,
    /// creating an honest position, funding it and depositing from it, passing USDC and
    /// native coin between themselves — scores zero, with either vault or both covered, at
    /// any posting prices, with the minimum theft at one value unit (so any score above
    /// zero would PAY). USDC left in a position counts as its creator's. An honest
    /// sequence never takes from a covered vault.
    #[test]
    fn r4_6_randomized_honest_action_sequences_score_zero(
        steps in proptest::collection::vec(step(), 1..24),
        positions in any::<[bool; 3]>(),
        covered in 0usize..3,
        usdc_price in 1u128..=u64::MAX as u128,
        native_price in 0u128..=u64::MAX as u128,
    ) {
        let seed: u128 = fixture("rules.json")["seed"]["native"].as_str().unwrap().parse().unwrap();
        let (actions, _) = honest_sequence(&steps, positions, seed);
        let bounty = Bounty { covered: COVERED[covered], listed: &[("usdc", usdc_price), ("native", native_price)] };
        let j = job_at("state.json", exploit_of(&actions), &bounty);
        prop_assert_eq!(reason_of(&j), ZERO, "{:?}", actions);
    }

    /// R4.6's generator makes runnable exploits, so its ZEROs aren't reverts: every
    /// generated sequence, followed by the old vault's drain of all it holds to one of the
    /// fresh accounts that sent a transaction or to a position one created (R4.8: an
    /// address that only receives is not the attacker's), scores exactly what the model's
    /// books say the two covered vaults lost: the old vault's 10,000 USDC less what the
    /// sequence left in the position vault. A transaction the model thinks succeeds but
    /// reverts, or a share amount it rounds differently, moves that score.
    #[test]
    fn r4_6_r4_8_generated_sequences_with_the_old_drain_appended_score_the_books(
        steps in proptest::collection::vec(step(), 1..24),
        positions in any::<[bool; 3]>(),
        by in 0usize..3,
        to in 0usize..6,
    ) {
        let seed: u128 = fixture("rules.json")["seed"]["native"].as_str().unwrap().parse().unwrap();
        let (actions, books) = honest_sequence(&steps, positions, seed);
        let who = honest_accounts();
        let sent = |k: usize| k == by || actions.iter().any(|(i, _)| *i == k);
        let to = if to >= 3 && books.positions[to - 3] {
            position_of(to - 3).1
        } else if sent(to % 3) {
            who[to % 3].clone()
        } else {
            who[by].clone()
        };
        let mut exploit = exploit_of(&actions);
        exploit["transactions"].as_array_mut().unwrap().push(old_vault_drain(by, &to, books.demo));
        let bounty = Bounty { covered: &["demo", "positionVault"], listed: &[("usdc", 1)] };
        let j = job_at("state.json", exploit, &bounty);
        // Every USDC the attacker gains comes from its own mints or the covered vaults, so
        // the gain is never below the loss, and the score is the loss.
        let loss = (10_000 * DOLLAR + VAULT_ASSETS).checked_sub(books.vault).unwrap_or(0);
        if loss == 0 {
            prop_assert_eq!(reason_of(&j), ZERO, "{:?}", actions);
        } else {
            prop_assert_eq!(reason_of(&with_minimum(j.clone(), loss)), PAYS, "{:?}", actions);
            prop_assert_eq!(reason_of(&with_minimum(j, loss + 1)), ZERO, "{:?}", actions);
        }
    }
}

// ---- Control: the generated exploits run ----------------------------------------------------

/// The old vault's drain (scenario 21) of `amount` USDC, sent by fresh account `by` to `to`.
fn old_vault_drain(by: usize, to: &str, amount: u128) -> Value {
    json!({
        "from": honest_accounts()[by],
        "to": address("demo"),
        "value": "0",
        "input": calldata("executeStrategy(address,uint256)", &[word_a(to), word_u(amount)]),
        "gas": 300000,
    })
}

/// R4.6's generator makes runnable exploits, so its ZEROs aren't reverts: an honest
/// sequence (mint 500, approve 1,000, deposit 400, withdraw 100, pass 50 on) followed by
/// the old vault's drain, from the same fresh accounts, scores exactly what the vault lost.
#[test]
fn r4_6_generated_sequence_with_the_drain_appended_pays() {
    let (actions, _) = honest_sequence(
        &[
            (0, 0, 0, 500 * DOLLAR),
            (1, 0, 0, 1_000 * DOLLAR),
            (2, 0, 0, 400 * DOLLAR),
            (3, 0, 0, 100 * DOLLAR),
            (4, 0, 1, 50 * DOLLAR),
        ],
        [false; 3],
        ETHER,
    );
    let mut exploit = exploit_of(&actions);
    let who = honest_accounts();
    exploit["transactions"]
        .as_array_mut()
        .unwrap()
        .push(old_vault_drain(1, &who[1], 10_000 * DOLLAR));
    let bounty = Bounty {
        covered: &["demo"],
        listed: USDC_AND_NATIVE,
    };
    // The vault ends 300 USDC up on the honest steps, so it loses 9,700 net; the
    // attacker holds 10,200 USDC more, so the score is the loss.
    let j = job_at("state.json", exploit, &bounty);
    assert_score(j, 9_700 * DOLLAR * USDC);
}

/// R4.6, R4.8: the generator's position-vault actions run too. A generated sequence by one
/// fresh account (create its position, mint 1,000 USDC, approve the position vault for
/// 1,000, deposit 300, redeem 50 shares, fund the position with 200, deposit from it, fund
/// it with 40 more), then the old vault's drain sent to that position, scores exactly the
/// two covered vaults' net loss. The proceeds count only because the position, created by
/// a fresh account, is the attacker's.
#[test]
fn r4_6_r4_8_position_vault_sequence_with_the_old_drain_appended_pays() {
    let (actions, _) = honest_sequence(
        &[
            (0, 0, 0, 1_000 * DOLLAR),
            (6, 0, 0, 1_000 * DOLLAR),
            (7, 0, 0, 300 * DOLLAR - 2), // the clamp starts at one share's worth, 2 micro-USDC
            (8, 0, 0, 50 * DOLLAR),
            (9, 0, 0, 200 * DOLLAR),
            (10, 0, 0, 0),
            (9, 0, 0, 40 * DOLLAR),
        ],
        [true, false, false],
        ETHER,
    );
    let mut exploit = exploit_of(&actions);
    let (_, position) = position_of(0);
    exploit["transactions"]
        .as_array_mut()
        .unwrap()
        .push(old_vault_drain(0, &position, 10_000 * DOLLAR));
    let bounty = Bounty {
        covered: &["demo", "positionVault"],
        listed: USDC_AND_NATIVE,
    };
    // Worked by hand, at 1.5 USDC a share: the deposit of 300 mints 200 shares; redeeming
    // 50 of them pays 50 × 15,300 / 10,200 = 75; the position's 200 go in. The position
    // vault ends 425 USDC up and the old vault 10,000 down, so the covered contracts lose
    // 9,575. The attacker ends with 575 of its 1,000 minted plus the 10,000 drained
    // (40 + 10,000 of it in the position), so the gain is 10,575 and the score the loss.
    let j = job_at("state.json", exploit, &bounty);
    assert_score(j, 9_575 * DOLLAR * USDC);
}
