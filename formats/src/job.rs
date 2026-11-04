use serde::{Deserialize, Serialize};

use crate::claim::{AccountProof, BlockRef};
use crate::primitives::{AccountId, Bytes, EvmAddress, SafeU64, Uint, U64};
use crate::rules::{BountyId, Rules};

/// The exploit the judge replays: the transactions a Foundry script broadcasts, in order.
///
/// `bountee test` and `bountee claim` (#11) build it from the script's broadcast log
/// (`broadcast/<script>/<chain>/[dry-run/]run-latest.json`, each entry's `transaction`
/// `from`, `to`, `value`, `input`, `gas`). Signatures, nonces and fee fields are not part
/// of it: the senders are fresh accounts the judge creates holding exactly the seed
/// (R4.7), it numbers each sender's transactions from nonce 0, and it runs every
/// transaction at gas price 0, so fees never count as value (R4.9).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Exploit {
    /// At least one, at most [`Exploit::MAX_TRANSACTIONS`]; the judge refuses others as
    /// malformed (R3.11).
    pub transactions: Vec<ExploitTransaction>,
}

impl Exploit {
    /// The most transactions one exploit may hold.
    pub const MAX_TRANSACTIONS: usize = 256;
}

/// One transaction of an exploit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExploitTransaction {
    /// The sender; it must not exist at the claim's block (R4.1).
    pub from: EvmAddress,
    /// The callee, or `null` to create a contract. Always written, never left out.
    #[serde(deserialize_with = "Option::deserialize")]
    pub to: Option<EvmAddress>,
    /// Native coin sent with the call, in wei.
    pub value: Uint,
    /// Calldata, or the init code for a creation.
    pub input: Bytes,
    /// The transaction's gas limit.
    pub gas: SafeU64,
}

/// A local replay (R2.9): the judge checks `header` hashes to `block.hash`, verifies every
/// proof against its state root, replays `exploit` and scores it by `rules`. Run by
/// `bountee test`, `verify`, a published exploit's re-run and the offline judge tests;
/// the bounty contract never requests it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Replay {
    pub rules: Rules,
    pub block: BlockRef,
    /// The block's RLP-encoded header.
    pub header: Bytes,
    /// Proofs (and absence proofs) of every account and slot the replay reads (R4.5).
    pub proofs: Vec<AccountProof>,
    pub exploit: Exploit,
}

/// The enclave's claim-judging job, as the bounty contract requests it (#12, #14): the
/// judge confirms `block` through the RPCs pinned in its build (R2.8), checks its
/// timestamp against `submitted_at_ns`, then replays the claim. The sealed exploit is not
/// here: it reaches the judge through OutLayer's secrets (#15). No RPC address is part of
/// this job and unknown fields are refused, so neither a claim nor a Protocol can name
/// one (R2.8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JudgeClaim {
    pub rules: Rules,
    pub bounty: BountyId,
    /// The claimant; #15 checks it against the account sealed inside the exploit (R5.4).
    pub whitehat: AccountId,
    pub block: BlockRef,
    /// The block's RLP-encoded header.
    pub header: Bytes,
    /// The claim's proofs array, as the JSON text the Whitehat submitted. The contract
    /// never parses it; the judge does, and proofs that don't parse prove nothing.
    pub proofs_json: String,
    /// When the bounty contract recorded the claim, in NEAR nanoseconds (R2.8). A retry
    /// keeps it (R2.6).
    pub submitted_at_ns: U64,
}

/// A job for the judge, its whole stdin: `{"replay": {...}}` (local runs) or
/// `{"judge_claim": {...}}` (the enclave). The posting check joins this enum in #17.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Job {
    Replay(Replay),
    JudgeClaim(JudgeClaim),
}
