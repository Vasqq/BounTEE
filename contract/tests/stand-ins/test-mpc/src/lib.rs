//! TEST STAND-IN for NEAR Chain Signatures' MPC contract (`v1.signer-prod.testnet`):
//! signing and foreign-chain transaction verification. Lives only in the test folder and
//! is deployed only to the local sandbox. Seam C tests grow it to sign with a known test
//! key and to answer verification with success or failure on demand. That the real MPC
//! network behaves this way is proven at seam T.
//!
//! For now it records every `sign` request, so a test can check none was made (R3.3).

use near_sdk::near;
use near_sdk::serde_json::Value;
use near_sdk::store::Vector;

#[near(contract_state)]
pub struct TestMpc {
    sign_requests: Vector<String>,
}

impl Default for TestMpc {
    fn default() -> Self {
        Self {
            sign_requests: Vector::new(b"s"),
        }
    }
}

#[near]
impl TestMpc {
    /// Names this contract as a test stand-in, so a test can't mistake it for the real one.
    pub fn stand_in_for(&self) -> String {
        "NEAR Chain Signatures MPC".to_owned()
    }

    /// Records the request. Signing with a test key lands with ticket #13.
    #[payable]
    pub fn sign(&mut self, request: Value) {
        self.sign_requests.push(request.to_string());
    }

    /// Every `sign` request received, as JSON text.
    pub fn sign_requests(&self) -> Vec<String> {
        self.sign_requests.iter().cloned().collect()
    }
}
