//! TEST STAND-IN for NEAR Chain Signatures' MPC contract (`v1.signer-prod.testnet`).
//! Lives only in the test folder and is deployed only to the local sandbox. That the real
//! MPC network behaves this way is proven at seam T.
//!
//! What it copies from the real contract (`near/mpc`, `crates/contract/src/api/sign.rs`,
//! read Nov 4): `sign({request: {path, payload_v2: {Ecdsa: <hex>}, domain_id}})` needs at
//! least 1 yoctoNEAR and 15 Tgas, and yields; the network's answer reaches the caller as the
//! yield callback's return value, `{"scheme":"Secp256k1","big_r":{"affine_point":<hex>},
//! "s":{"scalar":<hex>},"recovery_id":<u8>}`; a request nobody answers times out and the
//! caller's promise fails.
//!
//! How a test drives it:
//! - `sign_requests()` reads back every request exactly as received, with its caller.
//! - `respond(index, response)` answers a pending request with any JSON (a test signs the
//!   payload with its own key, the wrong key, or sends garbage). Unanswered, it times out.
//! - `fail_next_sign()` makes the next `sign` call itself fail.

use near_sdk::json_types::U128;
use near_sdk::serde_json::{self, Value};
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, AccountId, Gas, GasWeight, Promise, PromiseResult, YieldId};

/// The real contract's `sign_call_gas_attachment_requirement_tera_gas` on testnet.
const MIN_SIGN_GAS: Gas = Gas::from_tgas(15);

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct SignRequest {
    pub predecessor: AccountId,
    /// The `request` argument as received, as JSON text.
    pub request: String,
    pub deposit: U128,
    pub answered: bool,
}

#[near(contract_state)]
pub struct TestMpc {
    sign_requests: Vector<SignRequest>,
    yields: LookupMap<u32, YieldId>,
    fail_next: bool,
}

impl Default for TestMpc {
    fn default() -> Self {
        Self {
            sign_requests: Vector::new(b"s"),
            yields: LookupMap::new(b"y"),
            fail_next: false,
        }
    }
}

#[near]
impl TestMpc {
    /// Names this contract as a test stand-in, so a test can't mistake it for the real one.
    pub fn stand_in_for(&self) -> String {
        "NEAR Chain Signatures MPC".to_owned()
    }

    /// Make the next `sign` call fail outright.
    pub fn fail_next_sign(&mut self) {
        self.fail_next = true;
    }

    #[payable]
    pub fn sign(&mut self, request: Value) {
        if self.fail_next {
            // Fail the caller's promise, keeping this call's state (a panic here would
            // undo clearing the flag).
            self.fail_next = false;
            let _ = Promise::new(env::current_account_id())
                .function_call(
                    "fail_sign".to_owned(),
                    vec![],
                    near_sdk::NearToken::from_yoctonear(0),
                    Gas::from_tgas(3),
                )
                .as_return();
            return;
        }
        if env::attached_deposit().as_yoctonear() < 1 {
            env::panic_str("attach at least 1 yoctoNEAR");
        }
        if env::prepaid_gas() < MIN_SIGN_GAS {
            env::panic_str("attach at least 15 Tgas");
        }
        let index = self.sign_requests.len();
        self.sign_requests.push(SignRequest {
            predecessor: env::predecessor_account_id(),
            request: serde_json::to_string(&request).unwrap(),
            deposit: U128(env::attached_deposit().as_yoctonear()),
            answered: false,
        });
        let args = serde_json::json!({ "index": index }).to_string();
        let (promise, yield_id) =
            Promise::new_yield("on_sign_response", args, Gas::from_tgas(7), GasWeight(0));
        self.yields.insert(index, yield_id);
        let _ = promise.as_return();
    }

    /// Answer a pending request with `response`, as the MPC network's `respond` does.
    pub fn respond(&mut self, index: u32, response: Value) {
        let yield_id = self.yields.remove(&index).expect("no pending request");
        yield_id
            .resume(serde_json::to_vec(&response).unwrap())
            .expect("yield already resumed or timed out");
        if let Some(r) = self.sign_requests.get_mut(index) {
            r.answered = true;
        }
    }

    /// The yield callback: hands the answer back; a timeout fails the caller's promise.
    #[private]
    pub fn on_sign_response(&mut self, index: u32) {
        #[allow(deprecated)]
        match env::promise_result(0) {
            PromiseResult::Successful(bytes) => env::value_return(&bytes),
            PromiseResult::Failed => {
                self.yields.remove(&index);
                env::panic_str("Signature request has timed out.")
            }
        }
    }

    /// What a scripted failure calls: it always fails.
    #[private]
    pub fn fail_sign(&self) {
        env::panic_str("test stand-in: sign failed as scripted");
    }

    /// Every `sign` request received.
    pub fn sign_requests(&self) -> Vec<SignRequest> {
        self.sign_requests.iter().cloned().collect()
    }
}
