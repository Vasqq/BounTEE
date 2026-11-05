//! Signing the pauses of a PAYS verdict (ADR-0001, R7.1, R7.2, R8.1, R8.3).
//!
//! The contract builds every pause itself: an EIP-1559 transaction (type 2) to one covered
//! contract whose calldata is the fixed selector of `pause()` and nothing else, with value
//! 0, an empty access list, and nonce, gas and fee limits BounTEE fixes here. The chain ID
//! is part of the signed payload, so a pause can't be replayed on another chain, and one
//! pause-role address serves every chain (D25).
//!
//! It asks NEAR Chain Signatures to sign each one under the bounty's path
//! `"<protocol>/<name>"`, checks each signature recovers to the bounty's pause-role address,
//! stores the signed transactions for anyone to broadcast (R7.3), and only then pays. If any
//! signature fails, times out or recovers to another address, nothing is stored or paid; the
//! bounty stays closed with this claim as its winner, and anyone can retry with
//! [`Contract::sign_pauses`] (R2.5). Nothing about the payout waits for a pause to land or be
//! verified (R7.11).
//!
//! This module is the contract's only path to the MPC network, and the only payload it ever
//! sends is the hash of a transaction [`pause_tx`] built from the bounty's recorded rules
//! (R8.3). No method takes a payload, a calldata, a destination or a path from a caller.

use bountee_formats::{BountyId, Bytes, EvmAddress, B256};
use k256::elliptic_curve::scalar::IsHigh;
use k256::elliptic_curve::PrimeField;
use k256::Scalar;
use near_sdk::serde_json::{self, json, Value};
use near_sdk::{
    env, near, require, AccountId, CurveType, NearToken, Promise, PromiseOrValue, PromiseResult,
    PublicKey,
};
use sha3::{Digest, Sha3_256};

use crate::{emit, gas, BountyState, Contract, ContractExt};

/// The 4-byte selector of `pause()`: keccak256("pause()")[..4].
pub const PAUSE_SELECTOR: [u8; 4] = [0x84, 0x56, 0xcb, 0x59];
/// Gas limit of every signed pause. OpenZeppelin-style `pause()` uses about 30k; the rest
/// leaves room for chains (Arbitrum) that count L1 data in L2 gas.
pub const PAUSE_GAS_LIMIT: u64 = 200_000;
/// The fee limit of every signed pause, in wei per gas: what the pause-role address must
/// hold enough for (R7.6), at most `PAUSE_GAS_LIMIT × PAUSE_MAX_FEE_PER_GAS` = 0.0002 ETH.
/// Base Sepolia's base fee was 0.005 gwei on Nov 4; a pause stays valid until it lands.
pub const PAUSE_MAX_FEE_PER_GAS: u128 = 1_000_000_000;
pub const PAUSE_MAX_PRIORITY_FEE_PER_GAS: u128 = 10_000_000;

/// Blocks after which a pause-signing request counts as over even if its callback never
/// cleared it (say it ran out of gas): MPC yields time out after 200 blocks. A late callback
/// can't pay twice, since it pays only a bounty still `signing`.
pub const SIGNING_STALE_BLOCKS: u64 = 300;

/// NEAR Chain Signatures' domain 0: secp256k1, the one that signs EVM transactions.
const SECP256K1_DOMAIN: u64 = 0;
const TWEAK_DERIVATION_PREFIX: &str = "near-mpc-recovery v0.1.0 epsilon derivation:";

/// A signed pause, stored for anyone to broadcast.
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct SignedPause {
    pub chain_id: u64,
    /// The covered contract it pauses.
    pub contract: EvmAddress,
    pub nonce: u64,
    /// The signed transaction, ready for `eth_sendRawTransaction`.
    pub tx: Bytes,
    /// Its transaction hash on that chain.
    pub tx_hash: B256,
}

/// A bounty's pause-role address and the Chain Signatures path it is derived from.
#[near(serializers = [json])]
pub struct PauseRole {
    pub path: String,
    pub address: EvmAddress,
}

/// The Chain Signatures path of a bounty's pauses (D25).
pub fn path(bounty: &BountyId) -> String {
    format!("{}/{}", bounty.protocol, bounty.name)
}

/// An unsigned pause of one covered contract.
pub(crate) struct PauseTx {
    pub chain_id: u64,
    pub to: [u8; 20],
    pub nonce: u64,
}

/// The pauses for a bounty's covered contracts, in rules order. Pauses on the same chain
/// come from the same address, so they take nonces 0, 1, … in that order; the pause-role
/// address is used for nothing else, since only this contract signs for it and a bounty
/// name is never reused (D25).
pub(crate) fn pause_txs(rules: &bountee_formats::Rules) -> Vec<PauseTx> {
    let covered = &rules.covered_contracts;
    covered
        .iter()
        .enumerate()
        .map(|(i, c)| PauseTx {
            chain_id: c.chain_id.get(),
            to: hex_array(&c.address.as_str()[2..]).expect("a valid address"),
            nonce: covered[..i]
                .iter()
                .filter(|d| d.chain_id == c.chain_id)
                .count() as u64,
        })
        .collect()
}

impl PauseTx {
    /// The type-2 fields in order: chain ID, nonce, priority fee, fee limit, gas limit, to,
    /// value 0, calldata `pause()`, empty access list.
    fn fields(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(64);
        rlp_uint(&mut out, self.chain_id as u128);
        rlp_uint(&mut out, self.nonce as u128);
        rlp_uint(&mut out, PAUSE_MAX_PRIORITY_FEE_PER_GAS);
        rlp_uint(&mut out, PAUSE_MAX_FEE_PER_GAS);
        rlp_uint(&mut out, PAUSE_GAS_LIMIT as u128);
        rlp_bytes(&mut out, &self.to);
        rlp_uint(&mut out, 0);
        rlp_bytes(&mut out, &PAUSE_SELECTOR);
        out.push(0xc0);
        out
    }

    /// The hash Chain Signatures signs: keccak256(0x02 ‖ rlp(fields)).
    pub fn signing_hash(&self) -> [u8; 32] {
        let mut payload = vec![0x02];
        payload.extend(rlp_list(&self.fields()));
        env::keccak256_array(&payload)
    }

    fn signed(&self, y_parity: u8, r: &[u8; 32], s: &[u8; 32]) -> Vec<u8> {
        let mut fields = self.fields();
        rlp_uint(&mut fields, y_parity as u128);
        rlp_bytes(&mut fields, strip_zeros(r));
        rlp_bytes(&mut fields, strip_zeros(s));
        let mut tx = vec![0x02];
        tx.extend(rlp_list(&fields));
        tx
    }
}

/// The key Chain Signatures signs with for (`contract`, `path`): root + tweak·G, where
/// tweak = sha3_256(prefix ‖ contract ‖ "," ‖ path), as `near/mpc`'s kdf does.
///
/// The point arithmetic is done by NEAR's `ecrecover` host function instead of in wasm:
/// recovering a signature (r, s) = (x, x) over hash z from R = root, where x is the root's
/// x-coordinate, gives x⁻¹·(x·root − z·G); with z = −tweak·x that is root + tweak·G.
pub(crate) fn derived_key(root: &PublicKey, contract: &AccountId, path: &str) -> Option<[u8; 64]> {
    if root.curve_type() != CurveType::SECP256K1 {
        return None;
    }
    let raw = &root.as_bytes()[1..];
    let x: [u8; 32] = raw[..32].try_into().ok()?;
    let y_parity = raw[63] & 1;
    let digest: [u8; 32] =
        Sha3_256::digest(format!("{TWEAK_DERIVATION_PREFIX}{contract},{path}")).into();
    let tweak = Option::<Scalar>::from(Scalar::from_repr(digest.into()))?;
    let r = Option::<Scalar>::from(Scalar::from_repr(x.into()))?;
    let z: [u8; 32] = (-(tweak * r)).to_repr().into();
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&x);
    sig[32..].copy_from_slice(&x);
    env::ecrecover(&z, &sig, y_parity, false)
}

/// The EVM address of a 64-byte public key.
pub(crate) fn address_of(key: &[u8; 64]) -> [u8; 20] {
    env::keccak256_array(key)[12..]
        .try_into()
        .expect("20 bytes")
}

/// The signature in an MPC answer, with s made low (EIP-2), or `None` if it isn't one.
fn parse_signature(bytes: &[u8]) -> Option<([u8; 32], [u8; 32])> {
    let v: Value = serde_json::from_slice(bytes).ok()?;
    if v.get("scheme").and_then(Value::as_str) != Some("Secp256k1") {
        return None;
    }
    let big_r: [u8; 33] = hex_array(v["big_r"]["affine_point"].as_str()?)?;
    if big_r[0] != 0x02 && big_r[0] != 0x03 {
        return None;
    }
    let r: [u8; 32] = big_r[1..].try_into().ok()?;
    let s_bytes: [u8; 32] = hex_array(v["s"]["scalar"].as_str()?)?;
    let r_scalar = Option::<Scalar>::from(Scalar::from_repr(r.into()))?;
    let s = Option::<Scalar>::from(Scalar::from_repr(s_bytes.into()))?;
    if bool::from(r_scalar.is_zero()) || bool::from(s.is_zero()) {
        return None;
    }
    let s = if bool::from(s.is_high()) { -s } else { s };
    Some((r, s.to_repr().into()))
}

/// Check an MPC answer signs `tx` from `expected`, and build the signed pause.
fn verify(tx: &PauseTx, answer: &[u8], expected: &[u8; 20]) -> Option<SignedPause> {
    let (r, s) = parse_signature(answer)?;
    let hash = tx.signing_hash();
    let mut sig = [0u8; 64];
    sig[..32].copy_from_slice(&r);
    sig[32..].copy_from_slice(&s);
    let y_parity = (0..=1u8).find(|&v| {
        env::ecrecover(&hash, &sig, v, true).is_some_and(|key| &address_of(&key) == expected)
    })?;
    let raw = tx.signed(y_parity, &r, &s);
    Some(SignedPause {
        chain_id: tx.chain_id,
        contract: EvmAddress::parse(&hex(&tx.to)).expect("20 bytes"),
        nonce: tx.nonce,
        tx_hash: B256::parse(&hex(&env::keccak256_array(&raw))).expect("32 bytes"),
        tx: Bytes::parse(&hex(&raw)).expect("hex"),
    })
}

#[near]
impl Contract {
    /// A bounty's pause-role address: the address every one of its pauses is signed from,
    /// on every chain (D25).
    pub fn pause_role(&self, id: BountyId) -> PauseRole {
        let path = path(&id);
        let key = derived_key(
            &self.config.mpc_root_public_key,
            &env::current_account_id(),
            &path,
        )
        .unwrap_or_else(|| env::panic_str("the MPC root key can't derive this path"));
        PauseRole {
            path,
            address: EvmAddress::parse(&hex(&address_of(&key))).expect("20 bytes"),
        }
    }

    /// Retry signing the pauses of a bounty whose winning claim isn't paid yet because
    /// signing failed or timed out (R2.5). Anyone may call; attach the gas `fees()` names
    /// as `min_sign_pauses_gas`. The MPC deposits come from the bounty's posting fee.
    pub fn sign_pauses(&mut self, id: BountyId) -> Promise {
        let bounty = self
            .bounties
            .get(&id)
            .unwrap_or_else(|| env::panic_str("no such bounty"));
        require!(
            bounty.state == BountyState::Signing,
            "this bounty has no pauses waiting to be signed"
        );
        require!(
            !bounty.signing_in_flight(),
            "pause signing is already under way"
        );
        let needed = gas::pause_signing(bounty.rules.covered_contracts.len());
        require!(
            Self::gas_left(gas::TAIL) >= needed,
            "attach more gas: see min_sign_pauses_gas in fees()"
        );
        self.start_pause_signing(&id)
            .unwrap_or_else(|| env::panic_str("this bounty has no winning claim"))
    }

    /// After every pause's `sign`: store them all and pay if each one recovers to the
    /// bounty's pause-role address; otherwise store and pay nothing, and leave the bounty
    /// waiting for a retry. Never panics, so the in-flight flag is always cleared. A
    /// callback for a request other than the current one (`started_at` names the request:
    /// the block it started at) is stale and does nothing, so it can't clear a retry's flag.
    #[private]
    pub fn on_pauses_signed(&mut self, id: BountyId, started_at: u64) -> PromiseOrValue<()> {
        let me = env::current_account_id();
        let expected =
            derived_key(&self.config.mpc_root_public_key, &me, &path(&id)).map(|k| address_of(&k));
        let Some(bounty) = self.bounties.get_mut(&id) else {
            return PromiseOrValue::Value(());
        };
        if bounty.signing_since != Some(started_at) {
            return PromiseOrValue::Value(());
        }
        bounty.signing_since = None;
        let Some(claim_id) = bounty.winning_claim else {
            return PromiseOrValue::Value(());
        };
        if bounty.state != BountyState::Signing {
            return PromiseOrValue::Value(());
        }
        let txs = pause_txs(&bounty.rules);
        let mut signed = Vec::with_capacity(txs.len());
        for (i, tx) in txs.iter().enumerate() {
            #[allow(deprecated)]
            let pause = match env::promise_result(i as u64) {
                PromiseResult::Successful(answer) => {
                    expected.and_then(|addr| verify(tx, &answer, &addr))
                }
                PromiseResult::Failed => None,
            };
            match pause {
                Some(p) => signed.push(p),
                None => {
                    emit(
                        "pause_signing_failed",
                        json!({ "bounty": id, "claim_id": claim_id, "chain_id": tx.chain_id,
                                "contract": hex(&tx.to) }),
                    );
                    return PromiseOrValue::Value(());
                }
            }
        }
        let before = env::storage_usage();
        bounty.signed_pauses = signed;
        bounty.state = BountyState::Paying;
        let summary: Vec<Value> = bounty
            .signed_pauses
            .iter()
            .map(
                |p| json!({ "chain_id": p.chain_id, "contract": p.contract, "tx_hash": p.tx_hash }),
            )
            .collect();
        self.bounties.flush();
        let stored = env::storage_usage().saturating_sub(before) as u128;
        let bounty = self.bounties.get_mut(&id).expect("still here");
        bounty.fee_reserve = bounty.fee_reserve.saturating_sub(NearToken::from_yoctonear(
            stored * crate::fees::STORAGE_PRICE_PER_BYTE,
        ));
        emit(
            "pauses_signed",
            json!({ "bounty": id, "claim_id": claim_id, "pauses": summary }),
        );
        // Paid at once unless an earlier claim still holds its place (R3.6).
        self.pay_if_settled(&id)
    }
}

impl crate::Bounty {
    pub(crate) fn signing_in_flight(&self) -> bool {
        self.signing_since
            .is_some_and(|h| env::block_height() < h.saturating_add(SIGNING_STALE_BLOCKS))
    }
}

impl Contract {
    /// Request a signature for every pause of a bounty whose PAYS claim is waiting, then
    /// [`Contract::on_pauses_signed`]. `None` if it has no winning claim or is already
    /// signing. The caller makes sure enough gas is left.
    pub(crate) fn start_pause_signing(&mut self, id: &BountyId) -> Option<Promise> {
        let mpc = self.config.mpc.clone();
        let bounty = self.bounties.get_mut(id)?;
        if bounty.state != BountyState::Signing || bounty.signing_in_flight() {
            return None;
        }
        bounty.winning_claim?;
        let path = path(id);
        let txs = pause_txs(&bounty.rules);
        let one_yocto = NearToken::from_yoctonear(1);
        bounty.fee_reserve = bounty
            .fee_reserve
            .saturating_sub(one_yocto.saturating_mul(txs.len() as u128));
        let started_at = env::block_height();
        bounty.signing_since = Some(started_at);
        let mut joined: Option<Promise> = None;
        for tx in &txs {
            let args = json!({ "request": {
                "path": path,
                "payload_v2": { "Ecdsa": hex(&tx.signing_hash())[2..] },
                "domain_id": SECP256K1_DOMAIN,
            } });
            let sign = Promise::new(mpc.clone()).function_call_weight(
                "sign".to_owned(),
                args.to_string().into_bytes(),
                one_yocto,
                gas::SIGN_PAUSE,
                near_sdk::GasWeight(0),
            );
            joined = Some(match joined {
                None => sign,
                Some(p) => p.and(sign),
            });
        }
        Some(
            joined?.then(
                Self::ext(env::current_account_id())
                    .with_static_gas(gas::ON_PAUSES_SIGNED)
                    .with_unused_gas_weight(0)
                    .on_pauses_signed(id.clone(), started_at),
            ),
        )
    }
}

// ---- RLP and hex ----

fn strip_zeros(b: &[u8]) -> &[u8] {
    let first = b.iter().position(|&x| x != 0).unwrap_or(b.len());
    &b[first..]
}

fn rlp_len(out: &mut Vec<u8>, len: usize, offset: u8) {
    if len < 56 {
        out.push(offset + len as u8);
    } else {
        let be = (len as u64).to_be_bytes();
        let be = strip_zeros(&be);
        out.push(offset + 55 + be.len() as u8);
        out.extend_from_slice(be);
    }
}

fn rlp_bytes(out: &mut Vec<u8>, b: &[u8]) {
    if b.len() == 1 && b[0] < 0x80 {
        out.push(b[0]);
    } else {
        rlp_len(out, b.len(), 0x80);
        out.extend_from_slice(b);
    }
}

fn rlp_uint(out: &mut Vec<u8>, v: u128) {
    rlp_bytes(out, strip_zeros(&v.to_be_bytes()));
}

fn rlp_list(items: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(items.len() + 3);
    rlp_len(&mut out, items.len(), 0xc0);
    out.extend_from_slice(items);
    out
}

pub(crate) fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(2 + 2 * b.len());
    s.push_str("0x");
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

/// Hex digits (either case, optional `0x`) into exactly `N` bytes.
pub(crate) fn hex_array<const N: usize>(s: &str) -> Option<[u8; N]> {
    let s = s.strip_prefix("0x").unwrap_or(s);
    if s.len() != 2 * N {
        return None;
    }
    let mut out = [0u8; N];
    for (i, o) in out.iter_mut().enumerate() {
        *o = u8::from_str_radix(s.get(2 * i..2 * i + 2)?, 16).ok()?;
    }
    Some(out)
}
