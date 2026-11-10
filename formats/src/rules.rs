use serde::{Deserialize, Serialize};

use crate::primitives::{
    AccountId, BountyName, EvmAddress, FormatError, PublicKey, SafeU64, Uint, B256, U64,
};

/// The recency limit BounTEE fixes for every bounty (R1.1, R2.8): 5 minutes.
pub const RECENCY_LIMIT_SECS: u32 = 300;

/// Names a bounty: the Protocol's NEAR account and a name it hasn't used before (D25).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
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
pub struct BountyId {
    pub protocol: AccountId,
    pub name: BountyName,
}

/// A bounty's rules, fixed at posting (R1.1). Field order is the JSON order.
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
pub struct Rules {
    /// Every contract the bounty covers, on every chain; each one is paused on a win.
    pub covered_contracts: Vec<CoveredContract>,
    /// Seconds a claim's block may be older than its submission; BounTEE sets
    /// [`RECENCY_LIMIT_SECS`], not the Protocol.
    pub recency_limit_secs: u32,
    /// Tokens that count as value, each on its chain, with their posting prices. A claim is
    /// valued only in the listed tokens on its proof chain (R3.8, ADR-0020).
    pub listed_tokens: Vec<ListedToken>,
    /// What each fresh account starts the replay holding; set by BounTEE (R4.7).
    pub seed: Seed,
    /// The bounty, in USDC's smallest unit on NEAR.
    pub bounty_amount: Uint,
    /// The smallest score that pays, in value units (amount × price, R3.8).
    pub minimum_theft: Uint,
    /// When the bounty stops taking claims, as NEAR block time in nanoseconds.
    pub end_date_ns: U64,
    /// Days between payout and publication of the winning exploit (1–90, ADR-0008).
    pub disclosure_delay_days: u16,
    /// The Protocol's exploit public key; the winning exploit is re-encrypted to it (D20).
    pub exploit_public_key: PublicKey,
    /// The judge build pinned in the bounty contract at deployment (R1.3).
    pub judge_build_hash: B256,
}

/// A covered contract: an EVM chain ID and an address on it.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
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
pub struct CoveredContract {
    pub chain_id: SafeU64,
    pub address: EvmAddress,
}

/// A listed token: its chain, the token on it, and its posting price, in value units per
/// smallest unit of the token (ADR-0020).
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
pub struct ListedToken {
    /// The EVM chain ID the token is on.
    pub chain_id: SafeU64,
    pub token: Token,
    pub price: Uint,
}

/// A token on a chain: the chain's native coin (valued by account balance,
/// R3.8), or an ERC-20 at an address. JSON: `"native"` or `"0x…"`.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
#[cfg_attr(
    feature = "near",
    derive(
        borsh::BorshSerialize,
        borsh::BorshDeserialize,
        borsh::BorshSchema,
        schemars::JsonSchema
    )
)]
pub enum Token {
    Native,
    Erc20(EvmAddress),
}

impl TryFrom<String> for Token {
    type Error = FormatError;
    fn try_from(value: String) -> Result<Self, FormatError> {
        if value == "native" {
            Ok(Token::Native)
        } else {
            EvmAddress::parse(&value).map(Token::Erc20)
        }
    }
}

impl From<Token> for String {
    fn from(value: Token) -> String {
        match value {
            Token::Native => "native".to_owned(),
            Token::Erc20(address) => address.into(),
        }
    }
}

/// What each fresh account holds when the replay starts.
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
pub struct Seed {
    /// Native coin, in the chain's smallest unit (wei).
    pub native: Uint,
    /// ERC-20 balances, if any.
    pub tokens: Vec<TokenAmount>,
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
pub struct TokenAmount {
    pub token: EvmAddress,
    pub amount: Uint,
}
