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

/// What a Whitehat seals on their machine (R5.1): the exploit with their own account bound
/// inside it, so a copy filed by anyone else is INVALID (R5.4).
///
/// `bountee claim` writes it as JSON, compresses it with raw DEFLATE (RFC 1951) and
/// base64-encodes it (padded); that text is the value of the OutLayer secret
/// `BOUNTEE_SEALED_EXPLOIT`, which only the pinned judge build, in a job the bounty
/// contract requests, can read (ADR-0012).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SealedBundle {
    /// The NEAR account the claim must be filed by: the payee.
    pub whitehat: AccountId,
    pub exploit: Exploit,
}

/// The enclave's claim-judging action, requested only by the bounty contract. The sealed
/// exploit is never in it: it reaches the judge as the secret `BOUNTEE_SEALED_EXPLOIT`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct JudgeClaim {
    pub rules: Rules,
    pub bounty: BountyId,
    /// The account that filed the claim, as the bounty contract recorded it.
    pub whitehat: AccountId,
    pub block: BlockRef,
    pub header: Bytes,
    /// The claim's proofs array, as the JSON text submitted (the contract never parses it).
    pub proofs_json: String,
    /// When the bounty contract recorded the claim, NEAR nanoseconds.
    pub submitted_at_ns: U64,
}

/// A job for the judge, its whole stdin. JSON: `{"replay": {...}}` (local) or
/// `{"judge_claim": {...}}` (enclave). The posting check joins this enum in a later ticket.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case", deny_unknown_fields)]
pub enum Job {
    Replay(Replay),
    JudgeClaim(JudgeClaim),
}
