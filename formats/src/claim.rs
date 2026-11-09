use serde::{Deserialize, Serialize};

use crate::primitives::{AccountId, Base64, Bytes, EvmAddress, SafeU64, Uint, B256, U64};
use crate::rules::BountyId;

/// A claim as the Whitehat submits it. The bounty contract adds the submission time
/// itself (R2.8); it is not part of the claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(
    feature = "near",
    derive(
        borsh::BorshSerialize,
        borsh::BorshDeserialize,
        borsh::BorshSchema,
        schemars::JsonSchema
    )
)]
pub struct Claim {
    pub bounty: BountyId,
    /// The NEAR account claiming; must match the account sealed inside the exploit (R5.4).
    pub whitehat: AccountId,
    /// The block the exploit is judged against, naming its chain: the claim's proof chain.
    pub block: BlockRef,
    /// That block's RLP-encoded header; its keccak256 must equal `block.hash`.
    pub header: Bytes,
    /// Proofs (and absence proofs) for every account and storage slot the replay reads,
    /// against the header's state root (R4.5).
    pub proofs: Vec<AccountProof>,
    /// The sealed exploit, opaque outside the judge (R5.1).
    pub sealed_exploit: Base64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(
    feature = "near",
    derive(
        borsh::BorshSerialize,
        borsh::BorshDeserialize,
        borsh::BorshSchema,
        schemars::JsonSchema
    )
)]
pub struct BlockRef {
    /// The block's EVM chain ID: the claim's proof chain, which may be any covered chain
    /// (D1, ADR-0020).
    pub chain_id: SafeU64,
    pub number: SafeU64,
    pub hash: B256,
}

/// One account's EIP-1186 proof (`eth_getProof`), plus its code. An absent account is
/// proven by an `account_proof` that ends without it, with zero nonce and balance and
/// the empty code and storage hashes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(
    feature = "near",
    derive(
        borsh::BorshSerialize,
        borsh::BorshDeserialize,
        borsh::BorshSchema,
        schemars::JsonSchema
    )
)]
pub struct AccountProof {
    pub address: EvmAddress,
    pub nonce: U64,
    pub balance: Uint,
    pub code_hash: B256,
    pub storage_hash: B256,
    /// Trie nodes from the state root to the account, each RLP-encoded.
    pub account_proof: Vec<Bytes>,
    pub storage: Vec<StorageProof>,
    /// The account's bytecode, checked against `code_hash`; `0x` when it has none.
    pub code: Bytes,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
#[cfg_attr(
    feature = "near",
    derive(
        borsh::BorshSerialize,
        borsh::BorshDeserialize,
        borsh::BorshSchema,
        schemars::JsonSchema
    )
)]
pub struct StorageProof {
    pub key: B256,
    /// The slot's 32-byte word; all zeros with a proof of absence for an empty slot.
    pub value: B256,
    pub proof: Vec<Bytes>,
}
