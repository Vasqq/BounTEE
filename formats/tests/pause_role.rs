//! D25: a bounty's pause-role address is derived from the bounty contract's account and a
//! path built from the Protocol's account and the bounty's name, exactly as NEAR Chain
//! Signatures (`v1.signer-prod.testnet`) derives it. The expected keys in the fixture came
//! from the MPC contract's own `derived_public_key` view, not from this code.

use bountee_formats::pause_role::{self, TESTNET_ROOT_PUBLIC_KEY};
use bountee_formats::{AccountId, BountyId, BountyName};
use serde::Deserialize;

#[derive(Deserialize)]
struct Fixture {
    root_public_key: String,
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
struct Vector {
    bounty_contract: String,
    protocol: String,
    name: String,
    path: String,
    derived_public_key: String,
    evm_address: String,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!("../fixtures/pause-role.json")).unwrap()
}

#[test]
fn d25_the_testnet_root_key_is_the_one_the_mpc_contract_publishes() {
    assert_eq!(TESTNET_ROOT_PUBLIC_KEY, fixture().root_public_key);
}

#[test]
fn d25_the_path_is_the_protocol_account_then_the_bounty_name() {
    for v in fixture().vectors {
        let id = BountyId {
            protocol: AccountId::parse(&v.protocol).unwrap(),
            name: BountyName::parse(&v.name).unwrap(),
        };
        assert_eq!(pause_role::path(&id), v.path);
    }
}

#[test]
fn d25_derived_key_matches_what_the_mpc_contract_derives() {
    for v in fixture().vectors {
        let contract = AccountId::parse(&v.bounty_contract).unwrap();
        let key =
            pause_role::derive_public_key(TESTNET_ROOT_PUBLIC_KEY, &contract, &v.path).unwrap();
        assert_eq!(key, v.derived_public_key, "vector {}", v.path);
    }
}

#[test]
fn d25_pause_role_address_matches_the_mpc_derived_key() {
    for v in fixture().vectors {
        let contract = AccountId::parse(&v.bounty_contract).unwrap();
        let id = BountyId {
            protocol: AccountId::parse(&v.protocol).unwrap(),
            name: BountyName::parse(&v.name).unwrap(),
        };
        let address = pause_role::address(TESTNET_ROOT_PUBLIC_KEY, &contract, &id).unwrap();
        assert_eq!(address.as_str(), v.evm_address, "vector {}", v.path);
    }
}

#[test]
fn d25_a_malformed_root_key_is_refused() {
    let contract = AccountId::parse("bountee.testnet").unwrap();
    assert!(pause_role::derive_public_key("ed25519:abc", &contract, "a/b").is_err());
    assert!(pause_role::derive_public_key("secp256k1:111", &contract, "a/b").is_err());
}
