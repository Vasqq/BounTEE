//! D25: a bounty's pause-role address.
//!
//! The bounty contract asks NEAR Chain Signatures to sign each pause with
//! `path = "<protocol account>/<bounty name>"`, so the MPC network signs with the key it
//! derives for (predecessor = the bounty contract's account, that path). Anyone can
//! compute that key, and its EVM address, before the bounty is posted:
//!
//! 1. tweak = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" ‖ predecessor ‖ "," ‖ path),
//!    read as a big-endian secp256k1 scalar;
//! 2. derived key = root public key + tweak·G;
//! 3. address = the last 20 bytes of keccak256 of the derived key's 64 uncompressed bytes.
//!
//! Source: `crates/near-mpc-crypto-types/src/kdf.rs` and
//! `crates/contract/src/crypto_shared/kdf.rs` in github.com/near/mpc (read Nov 4 2026);
//! checked against `v1.signer-prod.testnet`'s own `derived_public_key` view by
//! `formats/fixtures/pause-role.json`.
//!
//! The same address serves every covered EVM chain: pauses are EIP-155 transactions, so
//! the chain ID inside each signed pause stops it being replayed on another chain.

use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::elliptic_curve::PrimeField;
use k256::{AffinePoint, ProjectivePoint, PublicKey, Scalar};
use sha3::{Digest, Keccak256, Sha3_256};

use crate::primitives::{AccountId, EvmAddress, FormatError};
use crate::rules::BountyId;

/// `v1.signer-prod.testnet`'s root secp256k1 key (domain 0), read from its `public_key` view.
pub const TESTNET_ROOT_PUBLIC_KEY: &str =
    "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";

/// `v1.signer`'s (mainnet) root secp256k1 key (domain 0), read from its `public_key` view.
pub const MAINNET_ROOT_PUBLIC_KEY: &str =
    "secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya";

const TWEAK_DERIVATION_PREFIX: &str = "near-mpc-recovery v0.1.0 epsilon derivation:";

/// The Chain Signatures path for a bounty's pause signatures: `<protocol>/<name>`.
pub fn path(bounty: &BountyId) -> String {
    format!("{}/{}", bounty.protocol, bounty.name)
}

/// The key the MPC network signs with for `predecessor` and `path`, spelled as its
/// `derived_public_key` view returns it (`secp256k1:<base58 of 64 bytes>`).
pub fn derive_public_key(
    root: &str,
    predecessor: &AccountId,
    path: &str,
) -> Result<String, FormatError> {
    let point = derive_point(root, predecessor, path)?;
    let encoded = point.to_encoded_point(false);
    Ok(format!(
        "secp256k1:{}",
        bs58::encode(&encoded.as_bytes()[1..]).into_string()
    ))
}

/// The EVM address of `bounty`'s pause role, signed for by `bounty_contract`.
pub fn address(
    root: &str,
    bounty_contract: &AccountId,
    bounty: &BountyId,
) -> Result<EvmAddress, FormatError> {
    let point = derive_point(root, bounty_contract, &path(bounty))?;
    let encoded = point.to_encoded_point(false);
    let hash = Keccak256::digest(&encoded.as_bytes()[1..]);
    let mut hex = String::with_capacity(42);
    hex.push_str("0x");
    for b in &hash[12..] {
        hex.push_str(&format!("{b:02x}"));
    }
    EvmAddress::parse(&hex)
}

fn derive_point(
    root: &str,
    predecessor: &AccountId,
    path: &str,
) -> Result<AffinePoint, FormatError> {
    let root = parse_root(root)?;
    let digest: [u8; 32] =
        Sha3_256::digest(format!("{TWEAK_DERIVATION_PREFIX}{predecessor},{path}")).into();
    let tweak = Option::<Scalar>::from(Scalar::from_repr(digest.into()))
        .ok_or_else(|| FormatError("derivation tweak is not a valid scalar".into()))?;
    let derived = (ProjectivePoint::GENERATOR * tweak + ProjectivePoint::from(root)).to_affine();
    PublicKey::from_affine(derived)
        .map_err(|_| FormatError("derived key is the identity".into()))?;
    Ok(derived)
}

fn parse_root(root: &str) -> Result<AffinePoint, FormatError> {
    let bad = || FormatError(format!("invalid secp256k1 root key: {root:?}"));
    let data = root.strip_prefix("secp256k1:").ok_or_else(bad)?;
    let raw = bs58::decode(data).into_vec().map_err(|_| bad())?;
    if raw.len() != 64 {
        return Err(bad());
    }
    let mut sec1 = [0u8; 65];
    sec1[0] = 0x04;
    sec1[1..].copy_from_slice(&raw);
    let key = PublicKey::from_sec1_bytes(&sec1).map_err(|_| bad())?;
    Ok(*key.as_affine())
}
