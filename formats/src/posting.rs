use serde::{Deserialize, Serialize};

use crate::rules::{BountyId, Rules};

/// The gas limit of every signed pause (spec, "The contract builds each pause itself").
pub const PAUSE_GAS_LIMIT: u64 = 200_000;
/// The fee limit (max fee per gas, wei) of every signed pause: 1 gwei.
pub const PAUSE_MAX_FEE_PER_GAS: u128 = 1_000_000_000;
/// What a pause-role address must hold for each pause beyond gas limit × fee limit: the L1
/// data fee an OP-stack chain such as Base charges on top (0.00001 ETH). Base Sepolia's pool
/// refused a pause whose sender held exactly 0.0002 ETH, "want 200000000001544" (Day-3 run,
/// Nov 5); this covers that fee thousands of times over. Arbitrum folds its L1 cost into the
/// gas used instead, so there it is headroom.
pub const PAUSE_L1_DATA_FEE_ALLOWANCE: u128 = 10_000_000_000_000;

/// The pause gas a pause-role address must hold for each pause on a chain (R7.6): its gas
/// limit at its fee limit, plus the L1 data fee allowance. 0.00021 ETH.
pub const fn pause_gas_per_pause() -> u128 {
    PAUSE_GAS_LIMIT as u128 * PAUSE_MAX_FEE_PER_GAS + PAUSE_L1_DATA_FEE_ALLOWANCE
}

/// The enclave's posting check, as the bounty contract requests it (#17): on every covered
/// chain, simulate `pause()` from the bounty's pause-role address and check that address
/// holds enough pause gas, reading each chain through the RPCs pinned in the judge's build
/// (R7.6, R12.1, R12.2, R12.5). No RPC address is part of this job and unknown fields are
/// refused, so neither a Protocol nor anyone else can name one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostingCheck {
    pub bounty: BountyId,
    pub rules: Rules,
}

/// The posting check's answer, the judge's stdout for a `posting_check` job:
/// `{"failures":[]}` passes; any failure fails the posting, and so does anything else the
/// bounty contract receives (a failed job's `null`, or output that isn't this).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostingCheckResult {
    /// One per covered contract that failed, in rules order, with the first reason found.
    pub failures: Vec<PostingFailure>,
}

impl PostingCheckResult {
    pub fn passed(&self) -> bool {
        self.failures.is_empty()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PostingFailure {
    /// The failing contract's place in the rules' `covered_contracts` (from 0). An index,
    /// not the contract, so the answer for all 8 a bounty may cover fits OutLayer's output.
    pub index: u32,
    pub reason: PostingFailureReason,
}

/// Why a covered contract fails the posting check.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PostingFailureReason {
    /// R12.5: fewer than two of the chain's pinned RPCs answered, their answers disagree,
    /// or the judge's build pins no RPCs for the chain.
    ChainUnconfirmed,
    /// R12.1, R12.2: `pause()` from the pause-role address reverts (the role isn't granted,
    /// or the contract can't be paused), or there is no contract at the address.
    CannotPause,
    /// R7.6: the pause-role address holds less than its pauses on that chain need.
    PauseGasShort,
}
