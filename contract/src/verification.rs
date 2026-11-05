//! Verifying that a chain's pause landed (ADR-0015, R7.10, R7.11).
//!
//! Anyone may ask the contract to verify a chain's pause once its bounty has signed pauses.
//! For each signed pause stored for that chain, the contract asks NEAR's MPC network
//! (`verify_foreign_transaction`) about the transaction hash of the pause it stored, never
//! one a caller supplies, at `Safe` finality, fixed here so nobody can pick a weaker one. It
//! pins the answer to the payload hash it expects, and records the chain's pause as verified
//! only when every pause on that chain came back with that hash. A transaction that
//! reverted, is unknown or isn't yet safe gets no answer from the network, so its request
//! times out and nothing is recorded.
//!
//! The posting fee pays the first [`PREPAID_ATTEMPTS`] attempts per chain; later ones are
//! paid by the caller's deposit, so the keyless contract never pays (R11.4). Nothing here
//! touches a bounty's state or its payout (R7.11).

use bountee_formats::{BountyId, B256};
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{env, near, require, NearToken, Promise, PromiseResult};

use crate::pauses::{hex, hex_array};
use crate::{emit, fees, gas, Contract, ContractExt};

/// Attempts per chain the posting fee pays for.
pub const PREPAID_ATTEMPTS: u32 = 3;
/// Blocks after which a verification request counts as over even if its callback never
/// cleared it: the MPC network's requests time out after about 200 blocks.
pub const VERIFYING_STALE_BLOCKS: u64 = 300;
/// The MPC network's domain for foreign-chain transaction verification (testnet and mainnet).
const FOREIGN_TX_DOMAIN: u64 = 3;
/// `Safe` in the MPC network's finality enum (Latest 0, Safe 1, Finalized 2).
const SAFE: u8 = 1;

/// A chain's verification record for one bounty.
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct ChainVerification {
    pub chain_id: u64,
    /// Requests made for this chain so far.
    pub attempts: u32,
    /// The block height the request under way started at.
    pub since: Option<u64>,
    /// The hashes of this chain's pauses the MPC network has verified.
    pub verified: Vec<B256>,
}

/// A chain's pause verification as the view returns it.
#[near(serializers = [json])]
pub struct PauseVerification {
    pub chain_id: u64,
    /// Whether every pause stored for this chain is verified.
    pub verified: bool,
    /// The hashes of this chain's pauses verified so far.
    pub verified_pauses: Vec<B256>,
    pub attempts: u32,
    /// Attempts the posting fee still pays for; later ones need `verify_pause_fee_per_pause`
    /// from `fees()` for each pause not yet verified.
    pub prepaid_attempts_left: u32,
    /// Whether a request is under way.
    pub verifying: bool,
}

impl ChainVerification {
    fn in_flight(&self) -> bool {
        self.since
            .is_some_and(|h| env::block_height() < h.saturating_add(VERIFYING_STALE_BLOCKS))
    }
}

/// The MPC network's name for an EVM chain and its byte in the signed payload, for the chains
/// it verifies (Base and Arbitrum, ADR-0015). Testnet's MPC contract checks the Sepolia chains.
fn foreign_chain(chain_id: u64) -> Option<(&'static str, u8)> {
    match chain_id {
        8453 | 84532 => Some(("Base", 6)),
        42161 | 421614 => Some(("Arbitrum", 7)),
        _ => None,
    }
}

/// sha256 of the payload the MPC network signs for a request with no extractors:
/// `00 (V1) | chain byte | tx_id | 00000000 (no extractors) | 01 (Safe) | 00000000 (no values)`.
fn expected_payload_hash(chain_byte: u8, tx_id: &[u8; 32]) -> [u8; 32] {
    let mut bytes = Vec::with_capacity(43);
    bytes.push(0);
    bytes.push(chain_byte);
    bytes.extend_from_slice(tx_id);
    bytes.extend_from_slice(&[0, 0, 0, 0, SAFE, 0, 0, 0, 0]);
    env::sha256_array(&bytes)
}

fn tx_id(hash: &B256) -> [u8; 32] {
    hex_array(hash.as_str()).expect("a stored hash is 32 bytes")
}

/// Whether an MPC answer is a verification of exactly `expected`.
fn answers(bytes: &[u8], expected: &[u8; 32]) -> bool {
    serde_json::from_slice::<Value>(bytes)
        .ok()
        .and_then(|v| v.get("payload_hash")?.as_str().map(str::to_owned))
        .and_then(|h| hex_array::<32>(&h))
        .is_some_and(|h| &h == expected)
}

#[near]
impl Contract {
    /// Ask NEAR's MPC network to verify `chain_id`'s pause of bounty `id` (R7.10). Anyone may
    /// call, once the bounty's pauses are signed; the hashes are those of the pauses it stored.
    /// Attach the gas `fees()` names (`min_verify_pause_gas_base` plus
    /// `min_verify_pause_gas_per_pause` for each pause on the chain). The first three attempts
    /// per chain are prepaid; after that attach `verify_pause_fee_per_pause` for each pause
    /// not yet verified. Any deposit beyond what is taken is refunded.
    #[payable]
    pub fn verify_pause(&mut self, id: BountyId, chain_id: u64) -> Promise {
        let (chain_name, chain_byte) = foreign_chain(chain_id)
            .unwrap_or_else(|| env::panic_str("NEAR's MPC network can't verify this chain"));
        let bounty = self
            .bounties
            .get_mut(&id)
            .unwrap_or_else(|| env::panic_str("no such bounty"));
        let hashes: Vec<B256> = bounty
            .signed_pauses
            .iter()
            .filter(|p| p.chain_id == chain_id)
            .map(|p| p.tx_hash.clone())
            .collect();
        require!(!hashes.is_empty(), "this bounty has no signed pause on this chain");
        let mut records = self.pause_verifications.get(&id).cloned().unwrap_or_default();
        let at = match records.iter().position(|r| r.chain_id == chain_id) {
            Some(i) => i,
            None => {
                records.push(ChainVerification {
                    chain_id,
                    attempts: 0,
                    since: None,
                    verified: Vec::new(),
                });
                records.len() - 1
            }
        };
        let record = &mut records[at];
        require!(!record.in_flight(), "a verification of this chain is already under way");
        let pending: Vec<B256> = hashes
            .into_iter()
            .filter(|h| !record.verified.contains(h))
            .collect();
        require!(!pending.is_empty(), "this chain's pause is already verified");
        let needed = gas::pause_verifying(pending.len());
        require!(
            Self::gas_left(gas::TAIL) >= needed,
            "attach more gas: see min_verify_pause_gas in fees()"
        );

        let cost = fees::VERIFY_PAUSE.saturating_mul(pending.len() as u128);
        let deposit = env::attached_deposit();
        let taken = if record.attempts < PREPAID_ATTEMPTS && bounty.fee_reserve >= cost {
            bounty.fee_reserve = bounty.fee_reserve.saturating_sub(cost);
            NearToken::from_yoctonear(0)
        } else {
            require!(
                deposit >= cost,
                "the prepaid attempts are used: attach verify_pause_fee_per_pause from fees() for each pause"
            );
            cost
        };
        let started_at = env::block_height();
        record.attempts += 1;
        record.since = Some(started_at);
        let attempt = record.attempts;
        self.pause_verifications.insert(id.clone(), records);
        let refund = deposit.saturating_sub(taken);
        if !refund.is_zero() {
            Promise::new(env::predecessor_account_id())
                .transfer(refund)
                .detach();
        }

        let mpc = self.config.mpc.clone();
        let one_yocto = NearToken::from_yoctonear(1);
        let mut joined: Option<Promise> = None;
        for hash in &pending {
            let tx = tx_id(hash);
            let args = json!({ "request": {
                "request": { chain_name: {
                    "tx_id": &hex(&tx)[2..],
                    "extractors": [],
                    "finality": "Safe",
                } },
                "domain_id": FOREIGN_TX_DOMAIN,
                "payload_version": 1,
                "expected_payload_hash": &hex(&expected_payload_hash(chain_byte, &tx))[2..],
            } });
            let call = Promise::new(mpc.clone()).function_call_weight(
                "verify_foreign_transaction".to_owned(),
                args.to_string().into_bytes(),
                one_yocto,
                gas::VERIFY_PAUSE,
                near_sdk::GasWeight(0),
            );
            joined = Some(match joined {
                None => call,
                Some(p) => p.and(call),
            });
        }
        emit(
            "pause_verification_requested",
            json!({ "bounty": id, "chain_id": chain_id, "attempt": attempt, "tx_hashes": pending }),
        );
        joined.expect("at least one pause").then(
            Self::ext(env::current_account_id())
                .with_static_gas(gas::ON_PAUSE_VERIFIED)
                .with_unused_gas_weight(0)
                .on_pause_verified(id, chain_id, started_at, pending),
        )
    }

    /// After every `verify_foreign_transaction` of one request: record each pause the network
    /// verified with the expected payload hash. A failed promise (a timeout) or any other
    /// answer records nothing. Never panics, so the in-flight mark is always cleared; a
    /// callback for an older, stale request does nothing. Returns whether the chain's pause is
    /// now verified.
    #[private]
    pub fn on_pause_verified(
        &mut self,
        id: BountyId,
        chain_id: u64,
        started_at: u64,
        tx_hashes: Vec<B256>,
    ) -> bool {
        let Some((_, chain_byte)) = foreign_chain(chain_id) else {
            return false;
        };
        let all: Vec<B256> = self
            .bounties
            .get(&id)
            .map(|b| {
                b.signed_pauses
                    .iter()
                    .filter(|p| p.chain_id == chain_id)
                    .map(|p| p.tx_hash.clone())
                    .collect()
            })
            .unwrap_or_default();
        let Some(mut records) = self.pause_verifications.get(&id).cloned() else {
            return false;
        };
        let Some(record) = records.iter_mut().find(|r| r.chain_id == chain_id) else {
            return false;
        };
        if record.since != Some(started_at) {
            return false;
        }
        record.since = None;
        for (i, hash) in tx_hashes.iter().enumerate() {
            #[allow(deprecated)]
            let ok = match env::promise_result(i as u64) {
                PromiseResult::Successful(bytes) => {
                    answers(&bytes, &expected_payload_hash(chain_byte, &tx_id(hash)))
                }
                PromiseResult::Failed => false,
            };
            if ok && all.contains(hash) && !record.verified.contains(hash) {
                record.verified.push(hash.clone());
            }
        }
        let verified = !all.is_empty() && all.iter().all(|h| record.verified.contains(h));
        let done = record.verified.clone();
        self.pause_verifications.insert(id.clone(), records);
        emit(
            if verified { "pause_verified" } else { "pause_verification_failed" },
            json!({ "bounty": id, "chain_id": chain_id, "verified_pauses": done }),
        );
        verified
    }

    /// Each chain's pause verification for a bounty, for every chain it has signed pauses on.
    pub fn pause_verifications(&self, id: BountyId) -> Vec<PauseVerification> {
        let Some(bounty) = self.bounties.get(&id) else {
            return Vec::new();
        };
        let records = self.pause_verifications.get(&id);
        let mut chains: Vec<u64> = Vec::new();
        for p in &bounty.signed_pauses {
            if !chains.contains(&p.chain_id) {
                chains.push(p.chain_id);
            }
        }
        chains
            .into_iter()
            .map(|chain_id| {
                let record = records.and_then(|rs| rs.iter().find(|r| r.chain_id == chain_id));
                let verified_pauses = record.map(|r| r.verified.clone()).unwrap_or_default();
                let attempts = record.map_or(0, |r| r.attempts);
                PauseVerification {
                    chain_id,
                    verified: bounty
                        .signed_pauses
                        .iter()
                        .filter(|p| p.chain_id == chain_id)
                        .all(|p| verified_pauses.contains(&p.tx_hash)),
                    verified_pauses,
                    attempts,
                    prepaid_attempts_left: PREPAID_ATTEMPTS.saturating_sub(attempts),
                    verifying: record.is_some_and(ChainVerification::in_flight),
                }
            })
            .collect()
    }
}
