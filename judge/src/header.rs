//! The claim's block header: its hash check (R2.9) and the few fields the replay needs.

use alloy_rlp::Header as RlpHeader;
use revm::primitives::{keccak256, Address, B256};

/// The fields of an RLP-encoded Ethereum (or OP Stack) block header the judge uses.
#[derive(Debug, Clone)]
pub struct Header {
    pub parent_hash: B256,
    pub beneficiary: Address,
    pub state_root: B256,
    pub number: u64,
    pub gas_limit: u64,
    pub timestamp: u64,
    pub mix_hash: B256,
    /// Whether the header carries EIP-7685's `requests_hash` (Prague and later).
    pub has_requests_hash: bool,
}

/// The header's index of each field we read, in the yellow paper's order.
const PARENT_HASH: usize = 0;
const BENEFICIARY: usize = 2;
const STATE_ROOT: usize = 3;
const NUMBER: usize = 8;
const GAS_LIMIT: usize = 9;
const TIMESTAMP: usize = 11;
const MIX_HASH: usize = 13;
/// Fields up to `parent_beacon_block_root` (Cancun); one more is `requests_hash`.
const CANCUN_FIELDS: usize = 20;

/// Decode `rlp` and check it hashes to `hash`; `None` if it doesn't or isn't a header.
pub fn verified(rlp: &[u8], hash: B256) -> Option<Header> {
    if keccak256(rlp) != hash {
        return None;
    }
    let mut buf = rlp;
    let list = RlpHeader::decode(&mut buf).ok()?;
    if !list.list || list.payload_length != buf.len() {
        return None;
    }
    let mut fields = Vec::new();
    while !buf.is_empty() {
        let item = RlpHeader::decode(&mut buf).ok()?;
        if item.list || item.payload_length > buf.len() {
            return None;
        }
        fields.push(&buf[..item.payload_length]);
        buf = &buf[item.payload_length..];
    }
    if fields.len() < CANCUN_FIELDS {
        return None;
    }
    Some(Header {
        parent_hash: word(fields[PARENT_HASH])?,
        beneficiary: (fields[BENEFICIARY].len() == 20)
            .then(|| Address::from_slice(fields[BENEFICIARY]))?,
        state_root: word(fields[STATE_ROOT])?,
        number: int(fields[NUMBER])?,
        gas_limit: int(fields[GAS_LIMIT])?,
        timestamp: int(fields[TIMESTAMP])?,
        mix_hash: word(fields[MIX_HASH])?,
        has_requests_hash: fields.len() > CANCUN_FIELDS,
    })
}

fn word(bytes: &[u8]) -> Option<B256> {
    (bytes.len() == 32).then(|| B256::from_slice(bytes))
}

fn int(bytes: &[u8]) -> Option<u64> {
    if bytes.len() > 8 || bytes.first() == Some(&0) {
        return None;
    }
    Some(bytes.iter().fold(0, |n, b| (n << 8) | u64::from(*b)))
}
