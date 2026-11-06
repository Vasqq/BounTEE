//! Validated string and integer types shared by every format.
//!
//! Each type has exactly one accepted spelling (lowercase hex, decimal without leading
//! zeros), so a value round-trips byte for byte between Rust and TypeScript. The
//! TypeScript twins live in `formats/ts/src/primitives.ts` and must accept and refuse the
//! same strings; `formats/ts/test/roundtrip.test.ts` checks that against this crate.

// The bounty contract compiles this crate on rustc 1.86, before `is_multiple_of` (1.87).
#![allow(unknown_lints, clippy::manual_is_multiple_of)]

use core::fmt;
use serde::{Deserialize, Serialize};

/// Why a value was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FormatError(pub String);

impl fmt::Display for FormatError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for FormatError {}

fn err<T>(what: &str, value: &str) -> Result<T, FormatError> {
    Err(FormatError(format!("invalid {what}: {value:?}")))
}

macro_rules! string_type {
    ($(#[$doc:meta])* $name:ident, $what:literal, $check:expr) => {
        $(#[$doc])*
        #[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
        #[serde(try_from = "String", into = "String")]
        #[cfg_attr(feature = "near", derive(borsh::BorshSerialize, borsh::BorshDeserialize, borsh::BorshSchema, schemars::JsonSchema))]
        #[cfg_attr(feature = "near", schemars(transparent))]
        pub struct $name(String);

        impl $name {
            pub fn parse(value: &str) -> Result<Self, FormatError> {
                let check: fn(&str) -> bool = $check;
                if check(value) { Ok(Self(value.to_owned())) } else { err($what, value) }
            }
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl TryFrom<String> for $name {
            type Error = FormatError;
            fn try_from(value: String) -> Result<Self, FormatError> {
                Self::parse(&value)
            }
        }

        impl From<$name> for String {
            fn from(value: $name) -> String {
                value.0
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                f.write_str(&self.0)
            }
        }
    };
}

fn is_lower_hex(s: &str) -> bool {
    s.bytes()
        .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn is_hex_of_len(s: &str, hex_chars: usize) -> bool {
    s.len() == 2 + hex_chars && s.starts_with("0x") && is_lower_hex(&s[2..])
}

/// A NEAR account ID, by NEAR's own rules: 2–64 characters of `a-z`, `0-9` and the
/// separators `-`, `_`, `.`, with no separator first, last, or next to another.
pub fn is_account_id(s: &str) -> bool {
    if !(2..=64).contains(&s.len()) {
        return false;
    }
    let mut last_was_separator = true; // no separator may come first
    for b in s.bytes() {
        match b {
            b'a'..=b'z' | b'0'..=b'9' => last_was_separator = false,
            b'-' | b'_' | b'.' => {
                if last_was_separator {
                    return false;
                }
                last_was_separator = true;
            }
            _ => return false,
        }
    }
    !last_was_separator
}

/// A bounty's name: 1–64 characters of `a-z`, `0-9` and `-`, not starting or ending with `-`.
/// It never contains `/`, and a NEAR account ID never does either, so the D25 path
/// `<protocol>/<name>` splits only one way.
pub fn is_bounty_name(s: &str) -> bool {
    (1..=64).contains(&s.len())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
        && !s.starts_with('-')
        && !s.ends_with('-')
}

const U256_MAX: &str =
    "115792089237316195423570985008687907853269984665640564039457584007913129639935";

/// Decimal digits with no leading zeros, at most `max` (compared as a number).
fn is_decimal_at_most(s: &str, max: &str) -> bool {
    !s.is_empty()
        && s.bytes().all(|b| b.is_ascii_digit())
        && (s == "0" || !s.starts_with('0'))
        && (s.len() < max.len() || (s.len() == max.len() && s <= max))
}

fn is_base64(s: &str) -> bool {
    !s.is_empty() && s.len() % 4 == 0 && {
        let body = s.trim_end_matches('=');
        s.len() - body.len() <= 2
            && body
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
    }
}

/// `<scheme>:<base58>`, NEAR's key spelling, e.g. `secp256k1:…` or `x25519:…`.
fn is_public_key(s: &str) -> bool {
    match s.split_once(':') {
        Some((scheme, data)) => {
            !scheme.is_empty()
                && scheme
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                && !data.is_empty()
                && data
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() && !matches!(b, b'0' | b'O' | b'I' | b'l'))
        }
        None => false,
    }
}

string_type!(
    /// A NEAR account ID (see [`is_account_id`]).
    AccountId, "NEAR account ID", is_account_id
);
string_type!(
    /// A bounty's name, unique per Protocol (D25; see [`is_bounty_name`]).
    BountyName, "bounty name", is_bounty_name
);
string_type!(
    /// An EVM address: `0x` and 40 lowercase hex digits.
    EvmAddress, "EVM address", |s| is_hex_of_len(s, 40)
);
string_type!(
    /// A 32-byte value (hash, storage key or word): `0x` and 64 lowercase hex digits.
    B256, "32-byte hex value", |s| is_hex_of_len(s, 64)
);
string_type!(
    /// Arbitrary bytes: `0x` and an even number of lowercase hex digits (`0x` is empty).
    Bytes, "hex bytes", |s| s.starts_with("0x") && s.len() % 2 == 0 && is_lower_hex(&s[2..])
);
string_type!(
    /// An unsigned integer up to 2^256 − 1, as a decimal string.
    Uint, "unsigned integer", |s| is_decimal_at_most(s, U256_MAX)
);
string_type!(
    /// An unsigned integer up to 2^64 − 1, as a decimal string (NEAR's `U64` spelling).
    U64, "64-bit unsigned integer", |s| is_decimal_at_most(s, "18446744073709551615")
);
string_type!(
    /// Standard padded base64, not empty.
    Base64, "base64", is_base64
);
string_type!(
    /// A public key as `<scheme>:<base58>`.
    PublicKey, "public key", is_public_key
);

impl U64 {
    pub fn get(&self) -> u64 {
        self.0.parse().expect("validated on construction")
    }
}

impl From<u64> for U64 {
    fn from(value: u64) -> Self {
        Self(value.to_string())
    }
}

impl From<u128> for Uint {
    fn from(value: u128) -> Self {
        Self(value.to_string())
    }
}

impl Uint {
    /// The value, if it fits in a `u128`.
    pub fn to_u128(&self) -> Option<u128> {
        self.0.parse().ok()
    }
}

/// The largest integer JSON numbers carry exactly in JavaScript (2^53 − 1).
pub const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// A small integer written as a JSON number (chain IDs, block numbers), at most
/// [`MAX_SAFE_INTEGER`] so JavaScript reads it exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(try_from = "u64", into = "u64")]
#[cfg_attr(
    feature = "near",
    derive(
        borsh::BorshSerialize,
        borsh::BorshDeserialize,
        borsh::BorshSchema,
        schemars::JsonSchema
    )
)]
#[cfg_attr(feature = "near", schemars(transparent))]
pub struct SafeU64(u64);

impl SafeU64 {
    pub fn new(value: u64) -> Result<Self, FormatError> {
        if value <= MAX_SAFE_INTEGER {
            Ok(Self(value))
        } else {
            err("safe integer", &value.to_string())
        }
    }
    pub fn get(self) -> u64 {
        self.0
    }
}

impl TryFrom<u64> for SafeU64 {
    type Error = FormatError;
    fn try_from(value: u64) -> Result<Self, FormatError> {
        Self::new(value)
    }
}

impl From<SafeU64> for u64 {
    fn from(value: SafeU64) -> u64 {
        value.0
    }
}
