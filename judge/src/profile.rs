//! How a chain executes (D29): one table of chain profiles, keyed by chain ID, compiled into
//! every build, so a local replay and the enclave judge a chain the same way (D2).
//!
//! The header's hash, confirmed through the chain's pinned RPCs, says the block is real; the
//! profile says how to replay it. It is deliberately separate from the pinned RPC table in
//! `confirm.rs`, which is per network: the mainnet and testnet builds hold the same profiles.
//!
//! A chain with no profile replays exactly as before D29: at least 17 header fields
//! (Shanghai's), Prague when the header carries `requests_hash` and Cancun otherwise, no
//! per-transaction gas cap, and the header's mix hash as randomness. Base, Ethereum and anvil
//! are such chains.

use revm::primitives::hardfork::SpecId;
use revm::primitives::B256;

use crate::header::Header;

/// How one chain is replayed.
pub struct Profile {
    /// The fewest header fields a block of this chain has.
    pub min_header_fields: usize,
    /// The EVM rules; `None` picks them from the header (Prague or Cancun).
    spec: Option<SpecId>,
    /// The chain's per-transaction gas cap; `None` for no cap.
    tx_gas_cap: Option<u64>,
    /// The chain's `PREVRANDAO`; `None` takes the header's mix hash.
    randomness: Option<B256>,
}

/// Fields up to `withdrawals_root` (Shanghai, EIP-4895): the oldest header era a chain with
/// no profile may have. From the Merge on, `mix_hash` carries `prevRandao`; accepting
/// pre-Cancun headers lets a replay run against a historical pre-hack block (ticket #28).
const SHANGHAI_FIELDS: usize = 17;
/// Fields up to `parent_beacon_block_root` (Cancun); one more is Prague's `requests_hash`.
const CANCUN_FIELDS: usize = 20;

/// Every chain with no profile.
const ETHEREUM_SHAPED: Profile = Profile {
    min_header_fields: SHANGHAI_FIELDS,
    spec: None,
    tx_gas_cap: None,
    randomness: None,
};

/// Arbitrum One and Arbitrum Sepolia, both ArbOS 61 (read Nov 8 and Nov 9; ArbOS 51 brought
/// Osaka's EIPs). Their headers stop at the base fee (16 fields), and their EVM upgrades
/// don't add fields. The per-transaction gas cap is `ArbGasInfo.getMaxTxGasLimit()`,
/// 32,000,000 on both; revm under Osaka would otherwise apply Ethereum's 16,777,216.
/// `PREVRANDAO` is the constant 1: Arbitrum's mix hash packs the send count, the L1 block
/// number and the ArbOS version, not randomness.
const ARBITRUM: Profile = Profile {
    min_header_fields: 16,
    spec: Some(SpecId::OSAKA),
    tx_gas_cap: Some(32_000_000),
    randomness: Some(B256::with_last_byte(1)),
};

/// The profiles, by chain ID. Adding a chain is an entry here, its pinned RPCs and a test on
/// a recorded real block, for any chain whose headers hash the Ethereum way and whose state
/// `eth_getProof` proves.
const PROFILES: &[(u64, Profile)] = &[
    (42161, ARBITRUM),  // Arbitrum One
    (421614, ARBITRUM), // Arbitrum Sepolia
];

impl Profile {
    /// The profile of `chain_id`, or the Ethereum-shaped default.
    pub fn of(chain_id: u64) -> &'static Profile {
        PROFILES
            .iter()
            .find(|(id, _)| *id == chain_id)
            .map_or(&ETHEREUM_SHAPED, |(_, profile)| profile)
    }

    /// The EVM rules to replay `header` under.
    pub fn spec(&self, header: &Header) -> SpecId {
        self.spec.unwrap_or(if header.fields > CANCUN_FIELDS {
            SpecId::PRAGUE
        } else {
            SpecId::CANCUN
        })
    }

    /// The chain's per-transaction gas cap, if it has one.
    pub fn tx_gas_cap(&self) -> Option<u64> {
        self.tx_gas_cap
    }

    /// `gas` clamped to the chain's per-transaction cap. A transaction asking for more is
    /// still run, with the cap: at gas price 0 the clamp costs nothing, and one that needs
    /// more would fail on the chain too.
    pub fn clamp_gas(&self, gas: u64) -> u64 {
        self.tx_gas_cap.map_or(gas, |cap| gas.min(cap))
    }

    /// The randomness (`PREVRANDAO`) the replay's block carries.
    pub fn randomness(&self, header: &Header) -> B256 {
        self.randomness.unwrap_or(header.mix_hash)
    }
}
