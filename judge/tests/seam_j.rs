//! Seam J: the judge as the enclave runs it — the one WebAssembly build, run under a
//! WebAssembly runtime (wasmtime), JSON in on stdin, a verdict out on stdout.
//!
//! Add a J test by calling `run_judge(input)` with a committed fixture from
//! `judge/tests/fixtures/` and asserting on the parsed `Verdict`. Never call the judge's
//! Rust functions directly: that would test the host build, not the one that is attested.
//!
//! Ticket #8 (local replay). Seams, written down before the first test:
//! - J (this file): the compiled wasm32-wasip2 judge under wasmtime, fed committed jobs
//!   built from `fixtures/state.json` (anvil block header + EIP-1186 proofs),
//!   `fixtures/exploits/*.json` (Foundry dry-run broadcasts) and `fixtures/rules.json`.
//!   Catches: header hash check, proof verification, unproven reads, fresh-account and
//!   seed handling, the score arithmetic and the verdict format, all in the attested
//!   build. Misses: RPC confirmation and the sealed exploit (enclave mode, #14/#15),
//!   OP-Stack-specific execution (fixtures come from anvil, not Base), and whether
//!   `cli/src/proofs.ts` fetches proofs right from a real RPC (#11's T tests).
//! - Formats public interface (`formats/`, outside the five seams on purpose): the exploit
//!   and job formats round-trip between Rust and TypeScript. Catches drift between the
//!   judge's input and what the CLI writes; misses how either side uses them.
//!
//! R15.3: every test here reads only the committed files under `judge/tests/fixtures/`;
//! none needs keys, funds or a network (the fixtures are remade, rarely, by
//! `fixtures/make-fixtures.ts`).

use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use bountee_formats::{from_json, Outcome, Reason, Verdict};
use proptest::prelude::*;
use revm::primitives::keccak256;
use revm::primitives::ruint::Uint;
use serde_json::{json, Value};

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
        .stderr(Stdio::null())
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

fn verdict_of(job: &Value) -> Verdict {
    let stdout = run_judge(&job.to_string());
    assert!(
        stdout.len() <= 900,
        "OutLayer truncates output over 900 bytes"
    );
    from_json(stdout.trim()).expect("stdout is a verdict")
}

fn assert_verdict(job: &Value, reason: Reason) {
    let verdict = verdict_of(job);
    assert_eq!(verdict.reason(), reason, "{verdict:?}");
    assert_eq!(verdict.outcome(), reason.outcome());
}

// ---- Fixtures ----------------------------------------------------------------------------

fn fixture(path: &str) -> Value {
    let file = repo_root().join("judge/tests/fixtures").join(path);
    serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap()
}

/// The fixture chain's addresses (deployed by `fixtures/chain/script/Fixture.s.sol`).
fn address(name: &str) -> String {
    fixture("state.json")["addresses"][name]
        .as_str()
        .unwrap()
        .to_owned()
}

/// A replay job of the named fixture exploit under `fixtures/rules.json`: vaults 1 and 2
/// covered, the token listed at 1000 and native coin at 1, minimum theft 100000, a seed
/// of 1 ether.
fn job(exploit: &str) -> Value {
    let state = fixture("state.json");
    json!({ "replay": {
        "rules": fixture("rules.json"),
        "block": state["block"],
        "header": state["header"],
        "proofs": state["proofs"],
        "exploit": fixture(&format!("exploits/{exploit}.json")),
    }})
}

fn rules(job: &mut Value) -> &mut Value {
    &mut job["replay"]["rules"]
}

fn proofs(job: &mut Value) -> &mut Vec<Value> {
    job["replay"]["proofs"].as_array_mut().unwrap()
}

fn proof_of<'a>(job: &'a mut Value, address: &str) -> &'a mut Value {
    proofs(job)
        .iter_mut()
        .find(|p| p["address"] == address)
        .unwrap_or_else(|| panic!("a proof of {address}"))
}

fn set_prices(job: &mut Value, token: &str, native: &str) {
    rules(job)["listed_tokens"] = json!([
        { "token": address("token"), "price": token },
        { "token": "native", "price": native },
    ]);
}

fn cover(job: &mut Value, vaults: &[&str]) {
    rules(job)["covered_contracts"] = vaults
        .iter()
        .map(|v| json!({ "chain_id": 31337, "address": address(v) }))
        .collect();
}

fn hex(bytes: &[u8]) -> String {
    format!(
        "0x{}",
        bytes.iter().map(|b| format!("{b:02x}")).collect::<String>()
    )
}

fn unhex(s: &str) -> Vec<u8> {
    (2..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap())
        .collect()
}

// ---- Ticket #6 ---------------------------------------------------------------------------

/// Ticket #6 smoke, and R3.11: input that isn't a job is a malformed exploit, answered in
/// the shared verdict format within OutLayer's 900-byte output limit.
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

// ---- R3.8: the score and its threshold ---------------------------------------------------

/// The `drain` exploit, by its script: the fresh account takes 300 tokens and 2 ether from
/// vault 1 and 500 tokens from vault 2, and sends 200 of vault 1's tokens to the treasury.
/// So gain = 800 tokens + 2 ether; vault 1 loses 500 tokens + 2 ether, vault 2 500 tokens.
const ETHER: u128 = 1_000_000_000_000_000_000;

/// R3.8, R2.9: a proven theft at or above the minimum theft PAYS, replayed offline from
/// the recorded header and proofs.
#[test]
fn r3_8_r2_9_proven_theft_at_the_minimum_pays() {
    assert_verdict(&job("drain"), Reason::MinimumTheftReached);
}

/// R3.8: exactly at the minimum theft pays; one value unit short is ZERO. Both vaults
/// covered at token price 1000, native 1: score = min(800·1000 + 2e18, 1000·1000 + 2e18).
#[test]
fn r3_8_score_equal_to_minimum_pays_one_below_is_zero() {
    let score = 800 * 1000 + 2 * ETHER;
    let mut at = job("drain");
    rules(&mut at)["minimum_theft"] = json!(score.to_string());
    assert_verdict(&at, Reason::MinimumTheftReached);
    let mut above = job("drain");
    rules(&mut above)["minimum_theft"] = json!((score + 1).to_string());
    assert_verdict(&above, Reason::BelowMinimumTheft);
}

/// R3.8: the score is the smaller of gain and loss. With only vault 2 covered the loss
/// (500 tokens) is below the gain; with native unpriced and both covered, the gain (800
/// tokens) is below the loss (1000 tokens).
#[test]
fn r3_8_score_is_the_smaller_of_gain_and_loss() {
    let mut loss_smaller = job("drain");
    cover(&mut loss_smaller, &["vault2"]);
    rules(&mut loss_smaller)["minimum_theft"] = json!("500000");
    assert_verdict(&loss_smaller, Reason::MinimumTheftReached);
    rules(&mut loss_smaller)["minimum_theft"] = json!("500001");
    assert_verdict(&loss_smaller, Reason::BelowMinimumTheft);

    let mut gain_smaller = job("drain");
    set_prices(&mut gain_smaller, "1000", "0");
    rules(&mut gain_smaller)["minimum_theft"] = json!("800000");
    assert_verdict(&gain_smaller, Reason::MinimumTheftReached);
    rules(&mut gain_smaller)["minimum_theft"] = json!("800001");
    assert_verdict(&gain_smaller, Reason::BelowMinimumTheft);
}

/// R3.8: no covered contract on the proof chain means no loss, so the score is zero.
#[test]
fn r3_8_no_loss_scores_zero() {
    let mut j = job("drain");
    rules(&mut j)["covered_contracts"] =
        json!([{ "chain_id": 421614, "address": address("vault1") }]);
    rules(&mut j)["minimum_theft"] = json!("1");
    assert_verdict(&j, Reason::BelowMinimumTheft);
}

type Wide = Uint<1024, 16>;

/// Any value below 2^256, drawn so small values (where the minimum can sit near a score)
/// and the extremes (where narrow arithmetic would overflow) both come up often.
fn u256() -> impl Strategy<Value = Wide> {
    prop_oneof![
        Just(Wide::ZERO),
        (0u64..1_000_000).prop_map(Wide::from),
        any::<u64>().prop_map(Wide::from),
        proptest::collection::vec(any::<u64>(), 4).prop_map(|l| Wide::from_limbs_slice(&l)),
        Just((Wide::from(1u8) << 256) - Wide::from(1u8)),
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 128, failure_persistence: None, ..ProptestConfig::default() })]

    /// R3.8 and R3.9, over any posting prices, minimum theft and choice of covered vaults:
    /// the verdict follows min(gain, loss) in exact integer arithmetic, from the `drain`
    /// script's known amounts (not from the judge's own reads), and running the same job
    /// twice gives the same bytes.
    #[test]
    fn r3_8_r3_9_verdict_follows_exact_min_of_gain_and_loss(
        token_price in u256(),
        native_price in u256(),
        minimum in u256(),
        near_score in 0u8..3,
        covered in 0usize..4,
    ) {
        let vaults: &[&[&str]] = &[&[], &["vault1"], &["vault2"], &["vault1", "vault2"]];
        let ether = Wide::from(2 * ETHER);
        let gain = Wide::from(800u64) * token_price + ether * native_price;
        let loss_1 = Wide::from(500u64) * token_price + ether * native_price;
        let loss_2 = Wide::from(500u64) * token_price;
        let loss = match covered { 0 => Wide::ZERO, 1 => loss_1, 2 => loss_2, _ => loss_1 + loss_2 };
        let score = gain.min(loss);
        // Most cases put the minimum at the score or just above, where an off-by-one, or a
        // seed counted as gain, would show.
        let max_u256 = (Wide::from(1u8) << 256) - Wide::from(1u8);
        let minimum = match near_score {
            0 if score <= max_u256 => score,
            1 if score < max_u256 => score + Wide::from(1u8),
            _ => minimum,
        };

        let mut j = job("drain");
        set_prices(&mut j, &token_price.to_string(), &native_price.to_string());
        cover(&mut j, vaults[covered]);
        rules(&mut j)["minimum_theft"] = json!(minimum.to_string());
        let expected = if score >= minimum { Reason::MinimumTheftReached } else { Reason::BelowMinimumTheft };

        let first = run_judge(&j.to_string());
        let second = run_judge(&j.to_string());
        prop_assert_eq!(&first, &second, "R3.9: same job, same output");
        let verdict: Verdict = from_json(first.trim()).unwrap();
        prop_assert_eq!(verdict.reason(), expected);
    }
}

// ---- R3.9: determinism -------------------------------------------------------------------

/// R3.9: the same header, proofs, exploit and rules give the same verdict and output, for
/// each kind of verdict.
#[test]
fn r3_9_same_inputs_same_output() {
    for exploit in ["drain", "seedOnly", "existingSender"] {
        let input = job(exploit).to_string();
        let outputs: Vec<String> = (0..3).map(|_| run_judge(&input)).collect();
        assert!(
            outputs.windows(2).all(|w| w[0] == w[1]),
            "{exploit}: {outputs:?}"
        );
    }
}

// ---- R2.9: the recorded header -----------------------------------------------------------

/// R2.9: a header that doesn't hash to the claim's block hash is rejected.
#[test]
fn r2_9_tampered_header_is_invalid() {
    let mut j = job("drain");
    let header = j["replay"]["header"].as_str().unwrap().to_owned();
    // Change the timestamp's last byte; the block hash in the job stays the original.
    let mut bytes = unhex(&header);
    let last = bytes.len() - 150;
    bytes[last] ^= 1;
    j["replay"]["header"] = json!(hex(&bytes));
    assert_verdict(&j, Reason::UnprovenState);
}

/// R2.9: a header whose state root was swapped, with the block hash recomputed to match,
/// no longer proves the state: its proofs fail against the new root.
#[test]
fn r2_9_header_with_another_state_root_proves_nothing() {
    let mut j = job("drain");
    let root = keccak256(unhex(
        proofs(&mut j)[0]["account_proof"][0].as_str().unwrap(),
    ));
    let header = j["replay"]["header"].as_str().unwrap().to_owned();
    let swapped = header.replace(&hex(root.as_slice())[2..], &"11".repeat(32));
    assert_ne!(swapped, header, "the header holds the proofs' state root");
    j["replay"]["header"] = json!(swapped);
    j["replay"]["block"]["hash"] = json!(hex(keccak256(unhex(&swapped)).as_slice()));
    assert_verdict(&j, Reason::UnprovenState);
}

/// R2.9: the header must be of the claim's block number, too.
#[test]
fn r2_9_header_of_another_block_number_is_invalid() {
    let mut j = job("drain");
    j["replay"]["block"]["number"] = json!(7);
    assert_verdict(&j, Reason::UnprovenState);
}

// ---- R4.5: only proven state -------------------------------------------------------------

/// R4.5: an account the replay reads with no proof (the token) makes the claim INVALID.
#[test]
fn r4_5_unproven_account_is_invalid() {
    let mut j = job("drain");
    let token = address("token");
    proofs(&mut j).retain(|p| p["address"] != token);
    assert_verdict(&j, Reason::UnprovenState);
}

/// R4.5: a storage slot the replay reads with no proof makes the claim INVALID: here the
/// one slot of vault 1 the replay reads (where it keeps the token's address).
#[test]
fn r4_5_unproven_slot_is_invalid() {
    let mut j = job("drain");
    let vault = proof_of(&mut j, &address("vault1"));
    assert_eq!(vault["storage"].as_array().unwrap().len(), 1);
    vault["storage"] = json!([]);
    assert_verdict(&j, Reason::UnprovenState);
}

/// R4.5: a proof that doesn't hold against the state root (a slot's value or an account's
/// balance edited) makes the claim INVALID.
#[test]
fn r4_5_proof_mismatching_the_state_root_is_invalid() {
    let mut slot = job("drain");
    let token = proof_of(&mut slot, &address("token"));
    token["storage"][0]["value"] = json!(format!("0x{:064x}", 9999));
    assert_verdict(&slot, Reason::UnprovenState);

    let mut balance = job("drain");
    proof_of(&mut balance, &address("vault1"))["balance"] = json!("6000000000000000000");
    assert_verdict(&balance, Reason::UnprovenState);
}

/// R4.5: an account is absent only on a proof of absence. Claiming a present account
/// (vault 1) is absent, with its real trie path, fails against the state root.
#[test]
fn r4_5_false_absence_is_invalid() {
    let mut j = job("drain");
    let vault = proof_of(&mut j, &address("vault1"));
    vault["nonce"] = json!("0");
    vault["balance"] = json!("0");
    vault["code_hash"] =
        json!("0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
    vault["storage_hash"] =
        json!("0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421");
    vault["storage"] = json!([]);
    vault["code"] = json!("0x");
    assert_verdict(&j, Reason::UnprovenState);
}

/// R4.5, R4.8: a contract the replay creates needs no proof, and what it ends holding is
/// attacker holdings: the `viaContract` exploit's helper takes 400 tokens for itself, so
/// the score is 400 · 1000, with no proof of the helper's address in the job.
#[test]
fn r4_5_r4_8_created_contract_needs_no_proof_and_its_holdings_count() {
    let mut j = job("viaContract");
    let ours = [
        address("token"),
        address("vault1"),
        address("vault2"),
        "0x0000000000000000000000000000000000000000".to_owned(),
        "0x0376aac07ad725e01357b1725b5cec61ae10473c".to_owned(),
    ];
    proofs(&mut j).retain(|p| ours.iter().any(|a| p["address"] == *a.as_str()));
    rules(&mut j)["minimum_theft"] = json!("400000");
    assert_verdict(&j, Reason::MinimumTheftReached);
    rules(&mut j)["minimum_theft"] = json!("400001");
    assert_verdict(&j, Reason::BelowMinimumTheft);
}

// ---- R4.1, R4.7, R4.9: fresh accounts, the seed, listed tokens -----------------------------

/// R4.1: a transaction sent by an account that exists at the claim's block is INVALID,
/// even though it takes value from a covered vault.
#[test]
fn r4_1_existing_sender_is_invalid() {
    assert_verdict(&job("existingSender"), Reason::ExistingSender);
}

/// R4.1, R4.5: a sender is fresh only on a proof of its absence.
#[test]
fn r4_1_sender_without_absence_proof_is_unproven() {
    let mut j = job("seedOnly");
    let sender = j["replay"]["exploit"]["transactions"][0]["from"].clone();
    proofs(&mut j).retain(|p| p["address"] != sender);
    assert_verdict(&j, Reason::UnprovenState);
}

/// R4.7: fresh accounts holding only their seed score zero, however high native coin is
/// priced and whatever the seed, because the seed is subtracted before scoring.
#[test]
fn r4_7_seed_alone_scores_zero() {
    for seed in ["1000000000000000000", "50000000000000000000"] {
        let mut j = job("seedOnly");
        set_prices(&mut j, "1000", "1000000000000000000000000");
        rules(&mut j)["seed"]["native"] = json!(seed);
        rules(&mut j)["minimum_theft"] = json!("1");
        assert_verdict(&j, Reason::BelowMinimumTheft);
    }
}

/// R4.7: the seed is subtracted from the gain. Token at 10^16, native at 1, both vaults
/// covered: gain = 800·10^16 + 2·10^18 = 10^19 (the 1-ether seed not counted), loss =
/// 1.2·10^19, so the score is exactly 10^19.
#[test]
fn r4_7_seed_is_subtracted_from_gain() {
    let mut j = job("drain");
    set_prices(&mut j, "10000000000000000", "1");
    rules(&mut j)["minimum_theft"] = json!("10000000000000000000");
    assert_verdict(&j, Reason::MinimumTheftReached);
    rules(&mut j)["minimum_theft"] = json!("10000000000000000001");
    assert_verdict(&j, Reason::BelowMinimumTheft);
}

/// R4.9: only listed tokens count. The `viaContract` theft is all in the token; with only
/// native coin listed it is worth nothing.
#[test]
fn r4_9_unlisted_token_is_worth_nothing() {
    let mut j = job("viaContract");
    rules(&mut j)["listed_tokens"] = json!([{ "token": "native", "price": "1000000" }]);
    rules(&mut j)["minimum_theft"] = json!("1");
    assert_verdict(&j, Reason::BelowMinimumTheft);
}

// ---- R3.11: malformed exploits -----------------------------------------------------------

/// R3.11: an exploit with no transactions is malformed.
#[test]
fn r3_11_empty_exploit_is_malformed() {
    let mut j = job("drain");
    j["replay"]["exploit"]["transactions"] = json!([]);
    assert_verdict(&j, Reason::MalformedExploit);
}

/// R3.11: an exploit whose transaction can't be included is malformed: sending more native
/// coin than the seed, or asking for more gas than the block allows.
#[test]
fn r3_11_unrunnable_transaction_is_malformed() {
    let mut value = job("seedOnly");
    value["replay"]["exploit"]["transactions"][0]["value"] = json!("2000000000000000000");
    assert_verdict(&value, Reason::MalformedExploit);

    let mut gas = job("seedOnly");
    gas["replay"]["exploit"]["transactions"][0]["gas"] = json!(1_000_000_000u64);
    assert_verdict(&gas, Reason::MalformedExploit);
}

/// R3.11: an exploit that isn't in the exploit format is malformed.
#[test]
fn r3_11_exploit_not_in_the_format_is_malformed() {
    let mut j = job("drain");
    j["replay"]["exploit"]["transactions"][0]["from"] = json!("not an address");
    assert_verdict(&j, Reason::MalformedExploit);
}
