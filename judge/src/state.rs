//! The replay's view of the chain: only proven state (R4.5).
//!
//! An account no proof mentions reads as absent, and is noted: once the replay ends, each
//! noted account must be one the replay created, which needs no proof; any other makes
//! the claim INVALID. A slot of a present account reads only if proven (or if the account
//! has no storage at all); anything else ends the transaction at once as unproven.

use std::cell::RefCell;
use std::collections::BTreeSet;
use std::fmt;
use std::rc::Rc;

use alloy_trie::EMPTY_ROOT_HASH;
use revm::bytecode::Bytecode;
use revm::database_interface::{DBErrorMarker, DatabaseRef};
use revm::primitives::{Address, StorageKey, StorageValue, B256, U256};
use revm::state::AccountInfo;

use crate::proofs::{Proven, ProvenState};

/// A read the claim doesn't prove.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Unproven {
    Account(Address),
    Slot(Address, U256),
    Code(B256),
    BlockHash(u64),
}

impl fmt::Display for Unproven {
    /// One line on stderr per unproven read, read by the proof-fetching script
    /// (`cli/src/proofs.ts`) to fetch the missing proofs.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Unproven::Account(a) => write!(f, "unproven account {a:#x}"),
            Unproven::Slot(a, k) => write!(f, "unproven slot {a:#x} {:#x}", B256::from(*k)),
            Unproven::Code(h) => write!(f, "unproven code {h:#x}"),
            Unproven::BlockHash(n) => write!(f, "unproven blockhash {n}"),
        }
    }
}

impl std::error::Error for Unproven {}
impl DBErrorMarker for Unproven {}

/// The proven state, plus the claim's own block hash and its parent's for BLOCKHASH.
#[derive(Clone)]
pub struct ProvenDb {
    proven: Rc<ProvenState>,
    /// `(number, hash)` of the claim's block and of its parent.
    block_hashes: [(u64, B256); 2],
    /// Accounts read with no proof, answered as absent; shared between clones.
    pub unproven_accounts: Rc<RefCell<BTreeSet<Address>>>,
}

impl ProvenDb {
    pub fn new(proven: ProvenState, block_hashes: [(u64, B256); 2]) -> Self {
        Self {
            proven: Rc::new(proven),
            block_hashes,
            unproven_accounts: Rc::default(),
        }
    }

    pub fn proven(&self, address: &Address) -> Option<&Proven> {
        self.proven.accounts.get(address)
    }
}

impl DatabaseRef for ProvenDb {
    type Error = Unproven;

    fn basic_ref(&self, address: Address) -> Result<Option<AccountInfo>, Unproven> {
        match self.proven.accounts.get(&address) {
            Some(Proven::Present { info, .. }) => Ok(Some(info.clone())),
            Some(Proven::Absent) => Ok(None),
            None => {
                self.unproven_accounts.borrow_mut().insert(address);
                Ok(None)
            }
        }
    }

    fn code_by_hash_ref(&self, code_hash: B256) -> Result<Bytecode, Unproven> {
        self.proven
            .codes
            .get(&code_hash)
            .cloned()
            .ok_or(Unproven::Code(code_hash))
    }

    fn storage_ref(&self, address: Address, index: StorageKey) -> Result<StorageValue, Unproven> {
        match self.proven.accounts.get(&address) {
            Some(Proven::Present {
                storage,
                storage_root,
                ..
            }) => match storage.get(&index) {
                Some(value) => Ok(*value),
                None if *storage_root == EMPTY_ROOT_HASH => Ok(U256::ZERO),
                None => Err(Unproven::Slot(address, index)),
            },
            // An absent account has no storage; an unproven one reads as absent (above).
            _ => Ok(U256::ZERO),
        }
    }

    fn block_hash_ref(&self, number: u64) -> Result<B256, Unproven> {
        self.block_hashes
            .iter()
            .find(|(n, _)| *n == number)
            .map(|(_, h)| *h)
            .ok_or(Unproven::BlockHash(number))
    }
}
