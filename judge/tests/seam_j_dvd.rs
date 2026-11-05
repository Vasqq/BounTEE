//! Seam J, ticket #27: R4.10 rows 22–24, the Damn Vulnerable DeFi v4 levels Truster, Side
//! Entrance and Puppet, UNMODIFIED (demo/dvd/src/v4), judged by the attested build under
//! wasmtime.
//!
//! Seams, written down before the first test:
//! - J (this file): replay jobs in `fixtures/dvd/`, each the exact judge input `bountee test`
//!   wrote when it ran the level's exploit script (demo/dvd/script) as a fresh account against
//!   one local anvil block holding the levels with DVD v4's balances (made by
//!   demo/dvd/make-fixtures.ts). Each test sets the bounty's rules over that job. Catches: each
//!   row's verdict, with the score checked exactly against the level's known amounts where the
//!   theft is exact, and Puppet paying with only its lending pool covered and its Uniswap pool
//!   a dependency. Misses: execution on Base itself (the block is anvil's) and the judge's RPC
//!   confirmation (#14).
//! - D11 is an inspection (findings/ticket-27.md): nothing here needed a judge change.
//!
//! R15.3: reads only committed files; no keys, funds or network.

mod common;

use std::io::Write;
use std::process::{Command, Stdio};

use bountee_formats::{from_json, Reason, Verdict};
use common::{attested_build, repo_root};
use serde_json::{json, Value};

fn reason_of(job: &Value) -> Reason {
    let mut child = Command::new("wasmtime")
        .args(["run", "-S", "http", "--"])
        .arg(attested_build())
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
    let verdict: Verdict =
        from_json(String::from_utf8(out.stdout).unwrap().trim()).expect("stdout is a verdict");
    verdict.reason()
}

fn job(level: &str) -> Value {
    let file = repo_root().join(format!("judge/tests/fixtures/dvd/{level}.json"));
    serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap()
}

fn with_minimum(mut job: Value, minimum: u128) -> Value {
    job["replay"]["rules"]["minimum_theft"] = json!(minimum.to_string());
    job
}

/// The level's deployed addresses, by contract name (`fixtures/dvd/addresses.json`).
fn address(name: &str) -> String {
    let file = repo_root().join("judge/tests/fixtures/dvd/addresses.json");
    let made: Value = serde_json::from_str(&std::fs::read_to_string(file).unwrap()).unwrap();
    made["unmodified"][name]
        .as_str()
        .unwrap_or_else(|| panic!("no address {name}"))
        .to_owned()
}

fn covered(job: &Value) -> Vec<String> {
    job["replay"]["rules"]["covered_contracts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c["address"].as_str().unwrap().to_owned())
        .collect()
}

/// Posting prices, per smallest unit, in units of 10^-18 USD: DVT (18 decimals) at $1 and
/// the native coin at $3,000 an ether (the jobs' rules).
const DVT: u128 = 1;
const NATIVE: u128 = 3_000;
const E18: u128 = 1_000_000_000_000_000_000;

/// The score is exactly `score`: PAYS at that minimum theft, ZERO one unit above it.
fn assert_score(job: Value, score: u128) {
    assert_eq!(
        reason_of(&with_minimum(job.clone(), score)),
        Reason::MinimumTheftReached
    );
    assert_eq!(
        reason_of(&with_minimum(job, score + 1)),
        Reason::BelowMinimumTheft
    );
}

/// R4.10 row 22: Truster, unmodified, its pool covered. A fresh account takes the pool's
/// 1,000,000 DVT, so the score is exactly $1,000,000.
#[test]
fn r4_10_row_22_dvd_truster_unmodified_pays() {
    let job = job("truster");
    assert_eq!(covered(&job), [address("TrusterLenderPool")]);
    assert_eq!(reason_of(&job), Reason::MinimumTheftReached);
    assert_score(job, 1_000_000 * E18 * DVT);
}

/// R4.10 row 23: Side Entrance, unmodified, its pool covered. The pool's 1,000 ETH ends with
/// the fresh account, so the score is exactly $3,000,000.
#[test]
fn r4_10_row_23_dvd_side_entrance_unmodified_pays() {
    let job = job("side-entrance");
    assert_eq!(covered(&job), [address("SideEntranceLenderPool")]);
    assert_eq!(reason_of(&job), Reason::MinimumTheftReached);
    assert_score(job, 1_000 * E18 * NATIVE);
}

/// R4.10 row 24: Puppet, unmodified, its lending pool covered and its Uniswap V1 pool a
/// dependency. The lending pool loses its 100,000 DVT for under 1 ETH of collateral; the fresh
/// account ends with over 99,500 DVT for at most its 0.99 ETH spent, so the score is above
/// $96,000 (99,500 − 3,000 − rounding), and ZERO only once the minimum passes the loss.
#[test]
fn r4_10_row_24_dvd_puppet_unmodified_lending_pool_covered_uniswap_a_dependency_pays() {
    let job = job("puppet");
    assert_eq!(covered(&job), [address("PuppetPool")]);
    assert!(!covered(&job).contains(&address("UniswapV1Exchange")));
    assert_eq!(reason_of(&job), Reason::MinimumTheftReached);
    assert_eq!(
        reason_of(&with_minimum(job.clone(), 96_000 * E18 * DVT)),
        Reason::MinimumTheftReached
    );
    assert_eq!(
        reason_of(&with_minimum(job, 100_000 * E18 * DVT)),
        Reason::BelowMinimumTheft,
        "the loss is the pool's 100,000 DVT less the collateral it gained"
    );
}
