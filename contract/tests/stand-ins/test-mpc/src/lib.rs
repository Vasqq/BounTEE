//! TEST STAND-IN for NEAR Chain Signatures' MPC contract (`v1.signer-prod.testnet`):
//! signing and foreign-chain transaction verification. Lives only in the test folder and
//! is deployed only to the local sandbox. Seam C tests grow it to sign with a known test
//! key and to answer verification with success or failure on demand. That the real MPC
//! network behaves this way is proven at seam T.

use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct TestMpc {}

#[near]
impl TestMpc {
    /// Names this contract as a test stand-in, so a test can't mistake it for the real one.
    pub fn stand_in_for(&self) -> String {
        "NEAR Chain Signatures MPC".to_owned()
    }
}
