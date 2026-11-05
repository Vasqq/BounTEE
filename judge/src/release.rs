//! The release (#22, R6.1, R12.4): after a payout, the bounty contract requests a job with
//! the winning claim's secret, and the judge re-encrypts the sealed exploit to the Protocol's
//! exploit key, the one recorded in the bounty's rules.
//!
//! [`release`] checks, in order, that:
//! 1. the job's caller is the bounty contract pinned in this build, and the secret is there
//!    ([`sealed::exploit`]); otherwise nothing is released;
//! 2. the sealed bundle names the winning claim's Whitehat (a bundle sealed for anyone else
//!    is never released, R5.6);
//! 3. the exploit key is an `x25519:` key of 32 bytes.
//!
//! Then it writes a [`ReleaseOutput`]: the [`ReleasedExploit`] as JSON, raw DEFLATE,
//! encrypted to the exploit key as `formats/src/job.rs` describes (BounTEE release v1). Only
//! the exploit key's holder can open it; the job's output, which lands on chain, holds
//! nothing else.
//!
//! [`publish`] (#23) makes the same checks and writes the same [`ReleasedExploit`] in the
//! clear, once the bounty contract has let the disclosure delay pass (D7).

use base64::Engine;
use bountee_formats::{
    to_json, AccountId, Base64, BountyId, Publish, PublishOutput, Release, ReleaseOutput,
    ReleasedExploit, SafeU64,
};
use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::ChaCha20Poly1305;

use crate::sealed;

/// The format's version byte and HKDF info.
const VERSION: u8 = 1;
const INFO: &[u8] = b"bountee-release-v1";

/// The release's stdout, or `None` when nothing may be released.
pub fn release(job: &Release) -> Option<ReleaseOutput> {
    let compressed = winning_exploit(&job.bounty, job.claim_id, &job.whitehat)?;
    let recipient = x25519_key(job.exploit_public_key.as_str())?;
    let sealed = encrypt(&recipient, &compressed)?;
    let text = base64::engine::general_purpose::STANDARD.encode(sealed);
    Some(ReleaseOutput {
        released: Base64::parse(&text).ok()?,
    })
}

/// The publication's stdout (#23, D7, D7.1), or `None` when nothing may be published: the
/// same checks as [`release`] (the pinned contract's job, the secret, a bundle sealed for
/// `whitehat`), then the [`ReleasedExploit`] in the clear, as raw DEFLATE in base64. The
/// bounty contract asks for it only once the disclosure delay has passed.
pub fn publish(job: &Publish) -> Option<PublishOutput> {
    let compressed = winning_exploit(&job.bounty, job.claim_id, &job.whitehat)?;
    let text = base64::engine::general_purpose::STANDARD.encode(compressed);
    Some(PublishOutput {
        published: Base64::parse(&text).ok()?,
    })
}

/// The winning claim's sealed exploit as a [`ReleasedExploit`], JSON in raw DEFLATE, or
/// `None` unless this is the pinned contract's job with a secret sealed for `whitehat`.
fn winning_exploit(bounty: &BountyId, claim_id: SafeU64, whitehat: &AccountId) -> Option<Vec<u8>> {
    let exploit = sealed::exploit(whitehat)?.ok()?;
    let released = ReleasedExploit {
        bounty: bounty.clone(),
        claim_id,
        whitehat: whitehat.clone(),
        exploit,
    };
    Some(miniz_oxide::deflate::compress_to_vec(
        to_json(&released).as_bytes(),
        9,
    ))
}

/// The 32 bytes of an `x25519:<base58>` key.
fn x25519_key(text: &str) -> Option<[u8; 32]> {
    let data = text.strip_prefix("x25519:")?;
    bs58::decode(data).into_vec().ok()?.try_into().ok()
}

/// `0x01 | ephemeral public key | nonce | ciphertext and tag`.
fn encrypt(recipient: &[u8; 32], plaintext: &[u8]) -> Option<Vec<u8>> {
    let random = random_bytes(32 + 12);
    let ephemeral: [u8; 32] = random[..32].try_into().ok()?;
    let nonce: [u8; 12] = random[32..].try_into().ok()?;
    let ephemeral_public = x25519_dalek::x25519(ephemeral, x25519_dalek::X25519_BASEPOINT_BYTES);
    let shared = x25519_dalek::x25519(ephemeral, *recipient);
    // A low-order recipient key gives an all-zero secret: no key to encrypt to.
    if shared == [0u8; 32] {
        return None;
    }
    let mut key = [0u8; 32];
    hkdf::Hkdf::<sha2::Sha256>::new(None, &shared)
        .expand(INFO, &mut key)
        .ok()?;
    let ciphertext = ChaCha20Poly1305::new(&key.into())
        .encrypt(&nonce.into(), plaintext)
        .ok()?;
    let mut out = Vec::with_capacity(1 + 32 + 12 + ciphertext.len());
    out.push(VERSION);
    out.extend_from_slice(&ephemeral_public);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ciphertext);
    Some(out)
}

/// Fresh randomness: WASI's in the enclave, the OS's in a host build.
#[cfg(target_os = "wasi")]
fn random_bytes(n: usize) -> Vec<u8> {
    wasi::random::random::get_random_bytes(n as u64)
}

#[cfg(not(target_os = "wasi"))]
fn random_bytes(n: usize) -> Vec<u8> {
    use std::io::Read;
    let mut out = vec![0u8; n];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut out))
        .expect("the OS gives randomness");
    out
}
