//! The claim's state proofs (EIP-1186), verified against the header's state root (R4.5).
//! Only what a proof shows is known; everything else is unproven.

use std::collections::HashMap;

use alloy_rlp::Encodable;
use alloy_trie::{proof::verify_proof, Nibbles, TrieAccount, EMPTY_ROOT_HASH, KECCAK_EMPTY};
use bountee_formats::AccountProof;
use revm::bytecode::Bytecode;
use revm::primitives::{keccak256, Address, Bytes, B256, U256};
use revm::state::AccountInfo;

/// What the proofs show about one account at the claim's block.
#[derive(Debug, Clone)]
pub enum Proven {
    /// A proof of absence: the account isn't in the state trie.
    Absent,
    Present {
        info: AccountInfo,
        storage_root: B256,
        /// The slots proven, by key. When `storage_root` is the empty trie's root, every
        /// slot is proven zero.
        storage: HashMap<U256, U256>,
    },
}

/// Every account the claim proves, keyed by address.
#[derive(Debug, Clone, Default)]
pub struct ProvenState {
    pub accounts: HashMap<Address, Proven>,
    pub codes: HashMap<B256, Bytecode>,
}

impl ProvenState {
    /// Verify every proof against `state_root`; `None` if any one fails.
    pub fn verify(state_root: B256, proofs: &[AccountProof]) -> Option<Self> {
        let mut state = ProvenState::default();
        for proof in proofs {
            let address: Address = proof.address.as_str().parse().ok()?;
            let nonce = proof.nonce.get();
            let balance: U256 = proof.balance.as_str().parse().ok()?;
            let code_hash: B256 = proof.code_hash.as_str().parse().ok()?;
            let storage_root: B256 = proof.storage_hash.as_str().parse().ok()?;
            let nodes = proof
                .account_proof
                .iter()
                .map(|n| hex(n.as_str()).map(Bytes::from))
                .collect::<Option<Vec<_>>>()?;
            let key = Nibbles::unpack(keccak256(address));
            let account = TrieAccount {
                nonce,
                balance,
                storage_root,
                code_hash,
            };
            let mut encoded = Vec::new();
            account.encode(&mut encoded);

            let empty = nonce == 0
                && balance.is_zero()
                && code_hash == KECCAK_EMPTY
                && storage_root == EMPTY_ROOT_HASH;
            let absent = empty && verify_proof(state_root, key, None, &nodes).is_ok();
            if absent {
                if !proof.storage.iter().all(|s| is_zero_word(s.value.as_str())) {
                    return None;
                }
                merge(&mut state, address, Proven::Absent)?;
                continue;
            }
            verify_proof(state_root, key, Some(encoded), &nodes).ok()?;

            let code = Bytes::from(hex(proof.code.as_str())?);
            if keccak256(&code) != code_hash {
                return None;
            }
            let bytecode = Bytecode::new_raw(code);
            state.codes.insert(code_hash, bytecode.clone());

            let mut storage = HashMap::new();
            for slot in &proof.storage {
                let key: B256 = slot.key.as_str().parse().ok()?;
                let value: U256 = U256::from_be_bytes(slot.value.as_str().parse::<B256>().ok()?.0);
                let nodes = slot
                    .proof
                    .iter()
                    .map(|n| hex(n.as_str()).map(Bytes::from))
                    .collect::<Option<Vec<_>>>()?;
                let expected = (!value.is_zero()).then(|| alloy_rlp::encode(value));
                verify_proof(
                    storage_root,
                    Nibbles::unpack(keccak256(key)),
                    expected,
                    &nodes,
                )
                .ok()?;
                storage.insert(U256::from_be_bytes(key.0), value);
            }
            let info = AccountInfo {
                balance,
                nonce,
                code_hash,
                code: Some(bytecode),
                ..Default::default()
            };
            merge(
                &mut state,
                address,
                Proven::Present {
                    info,
                    storage_root,
                    storage,
                },
            )?;
        }
        Some(state)
    }
}

/// Add one account's proof; two proofs of the same account are merged (both are true).
fn merge(state: &mut ProvenState, address: Address, proven: Proven) -> Option<()> {
    match (state.accounts.get_mut(&address), proven) {
        (None, proven) => {
            state.accounts.insert(address, proven);
        }
        (Some(Proven::Absent), Proven::Absent) => {}
        (Some(Proven::Present { storage, .. }), Proven::Present { storage: more, .. }) => {
            storage.extend(more);
        }
        // Both verified against one root, so this can't happen; refuse rather than guess.
        _ => return None,
    }
    Some(())
}

fn is_zero_word(hex_word: &str) -> bool {
    hex_word[2..].bytes().all(|b| b == b'0')
}

/// `0x`-prefixed lowercase hex (already validated by the formats crate) to bytes.
fn hex(s: &str) -> Option<Vec<u8>> {
    let digits = s.strip_prefix("0x")?.as_bytes();
    digits
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}
