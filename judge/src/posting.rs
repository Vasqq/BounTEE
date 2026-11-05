//! The enclave's posting check (`posting_check`, #17). On every covered chain the judge:
//!
//! 1. asks the chain's pinned RPCs for their head block and picks one block at least two of
//!    them have (the second-highest head), so every read names that block, never `latest`,
//!    whose answer differs between RPCs;
//! 2. reads at that block the pause-role address's balance, and for each covered contract
//!    its code and an `eth_call` of `pause()` from the pause-role address with the signed
//!    pause's gas limit;
//! 3. accepts a read only when at least two RPCs answer it and every answer agrees (R12.5).
//!
//! A covered contract passes when every read is accepted, it has code, the simulated pause
//! doesn't revert (the role is granted, R12.1, and the contract can be paused, R12.2), and
//! the pause-role address holds the pause gas of every pause on that chain (R7.6): one pause
//! per covered contract there, each its gas limit at its fee limit plus the L1 data fee an
//! OP-stack chain charges on top ([`bountee_formats::pause_gas_per_pause`]).
//!
//! The pause-role address is derived here (D25) from the bounty contract pinned in this
//! build and the bounty's ID; the job can't name it. The RPC addresses come only from
//! [`confirm::rpcs_for`], the table compiled into the build (R12.5); the job format
//! refuses unknown fields, so no RPC can be named in it. Nothing is written to stderr.

use bountee_formats::{
    pause_gas_per_pause, pause_role, AccountId, CoveredContract, EvmAddress, PostingCheck,
    PostingCheckResult, PostingFailure, PostingFailureReason, PAUSE_GAS_LIMIT,
};
use serde_json::{json, Value};

use crate::confirm;
use crate::rpc::{self, Reply};
use crate::sealed::BOUNTY_CONTRACT;

/// `pause()`'s selector, the whole calldata of every signed pause.
const PAUSE_CALLDATA: &str = "0x8456cb59";

/// Check every covered contract of `job`'s rules.
pub fn check(job: &PostingCheck) -> PostingCheckResult {
    let contracts = &job.rules.covered_contracts;
    let mut reasons: Vec<Option<PostingFailureReason>> = vec![None; contracts.len()];
    let Some(role) = pause_role_address(job) else {
        // Can't happen for a well-formed bounty ID; nothing can pass without the address.
        return failed(contracts, PostingFailureReason::CannotPause);
    };
    let mut chains: Vec<u64> = contracts.iter().map(|c| c.chain_id.get()).collect();
    chains.sort_unstable();
    chains.dedup();
    for chain in chains {
        let on_chain: Vec<usize> = (0..contracts.len())
            .filter(|&i| contracts[i].chain_id.get() == chain)
            .collect();
        let on_chain_contracts: Vec<&CoveredContract> =
            on_chain.iter().map(|&i| &contracts[i]).collect();
        let found = check_chain(chain, &role, &on_chain_contracts);
        for (i, reason) in on_chain.into_iter().zip(found) {
            reasons[i] = reason;
        }
    }
    PostingCheckResult {
        failures: contracts
            .iter()
            .zip(reasons)
            .enumerate()
            .filter_map(|(index, (_, reason))| {
                reason.map(|reason| PostingFailure {
                    index: index as u32,
                    reason,
                })
            })
            .collect(),
    }
}

fn failed(contracts: &[CoveredContract], reason: PostingFailureReason) -> PostingCheckResult {
    PostingCheckResult {
        failures: contracts
            .iter()
            .enumerate()
            .map(|(index, _)| PostingFailure {
                index: index as u32,
                reason,
            })
            .collect(),
    }
}

/// The bounty's pause-role address under the MPC root key of the bounty contract's network.
fn pause_role_address(job: &PostingCheck) -> Option<EvmAddress> {
    let contract = AccountId::parse(BOUNTY_CONTRACT).ok()?;
    let root = if BOUNTY_CONTRACT.ends_with(".testnet") {
        pause_role::TESTNET_ROOT_PUBLIC_KEY
    } else {
        pause_role::MAINNET_ROOT_PUBLIC_KEY
    };
    pause_role::address(root, &contract, &job.bounty).ok()
}

/// What one RPC said a simulated pause did.
#[derive(Debug, Clone, PartialEq)]
enum Call {
    Succeeded,
    Reverted,
}

/// Each covered contract on `chain`'s failure, if any, in order.
fn check_chain(
    chain: u64,
    role: &EvmAddress,
    contracts: &[&CoveredContract],
) -> Vec<Option<PostingFailureReason>> {
    let unconfirmed = vec![Some(PostingFailureReason::ChainUnconfirmed); contracts.len()];
    let Some(rpcs) = confirm::rpcs_for(chain) else {
        return unconfirmed;
    };
    let Some(block) = common_block(&rpcs) else {
        return unconfirmed;
    };
    let block = format!("{block:#x}");

    // Per RPC: the balance, then each contract's code and simulated pause.
    let mut bodies = vec![request("eth_getBalance", json!([role.as_str(), block]))];
    for contract in contracts {
        bodies.push(request(
            "eth_getCode",
            json!([contract.address.as_str(), block]),
        ));
        bodies.push(request(
            "eth_call",
            json!([{
                "from": role.as_str(),
                "to": contract.address.as_str(),
                "data": PAUSE_CALLDATA,
                "gas": format!("{PAUSE_GAS_LIMIT:#x}"),
            }, block]),
        ));
    }
    let requests: Vec<(String, String)> = rpcs
        .iter()
        .flat_map(|url| bodies.iter().map(move |body| (url.clone(), body.clone())))
        .collect();
    let replies = rpc::replies(&requests);
    // The answers to request `k` from every RPC.
    let column = |k: usize| -> Vec<Option<Reply>> {
        (0..rpcs.len())
            .map(|r| replies[r * bodies.len() + k].clone())
            .collect()
    };

    let balance = agreed(column(0).into_iter().map(|r| match r {
        Some(Reply::Result(v)) => quantity(&v),
        _ => None,
    }));
    let needed = pause_gas_per_pause().saturating_mul(contracts.len() as u128);

    (0..contracts.len())
        .map(|i| {
            let code = agreed(column(1 + 2 * i).into_iter().map(|r| match r {
                Some(Reply::Result(Value::String(code))) => Some(code),
                _ => None,
            }));
            let call = agreed(column(2 + 2 * i).into_iter().map(|r| match r {
                Some(Reply::Result(_)) => Some(Call::Succeeded),
                Some(Reply::Error(error)) if reverted(&error) => Some(Call::Reverted),
                _ => None,
            }));
            let (Some(balance), Some(code), Some(call)) = (balance, code, call) else {
                return Some(PostingFailureReason::ChainUnconfirmed);
            };
            if code == "0x" || call == Call::Reverted {
                Some(PostingFailureReason::CannotPause)
            } else if balance < needed {
                Some(PostingFailureReason::PauseGasShort)
            } else {
                None
            }
        })
        .collect()
}

/// A block at least two of `rpcs` have reached: the second-highest head they report.
fn common_block(rpcs: &[String]) -> Option<u64> {
    let body = request("eth_blockNumber", json!([]));
    let requests: Vec<(String, String)> = rpcs.iter().map(|u| (u.clone(), body.clone())).collect();
    let mut heads: Vec<u64> = rpc::replies(&requests)
        .into_iter()
        .filter_map(|r| match r {
            Some(Reply::Result(v)) => quantity(&v).and_then(|n| u64::try_from(n).ok()),
            _ => None,
        })
        .collect();
    heads.sort_unstable_by(|a, b| b.cmp(a));
    heads.get(1).copied()
}

/// The answer at least two RPCs gave, provided every RPC that answered gave it (R12.5).
fn agreed<T: PartialEq>(answers: impl Iterator<Item = Option<T>>) -> Option<T> {
    let mut answers = answers.flatten();
    let first = answers.next()?;
    let mut count = 1;
    for answer in answers {
        if answer != first {
            return None;
        }
        count += 1;
    }
    (count >= 2).then_some(first)
}

/// Whether a JSON-RPC error says the call itself failed (reverted, or ran out of the
/// pause's gas), rather than that the RPC couldn't answer.
fn reverted(error: &Value) -> bool {
    let message = error["message"].as_str().unwrap_or_default().to_lowercase();
    error["code"] == 3 || message.contains("revert") || message.contains("out of gas")
}

/// A JSON-RPC quantity (`0x…`).
fn quantity(value: &Value) -> Option<u128> {
    let hex = value.as_str()?.strip_prefix("0x")?;
    if hex.is_empty() {
        return None;
    }
    u128::from_str_radix(hex, 16).ok()
}

fn request(method: &str, params: Value) -> String {
    json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }).to_string()
}
