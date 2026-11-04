//! TEST STAND-IN for OutLayer (`outlayer.testnet`). Lives only in the test folder and is
//! deployed only to the local sandbox. Seam C tests grow it to answer the bounty
//! contract's job requests with success or failure on demand, including failures testnet
//! can't trigger at will. That the real OutLayer behaves this way is proven at seam T.

use near_sdk::near;

#[near(contract_state)]
#[derive(Default)]
pub struct TestOutlayer {}

#[near]
impl TestOutlayer {
    /// Names this contract as a test stand-in, so a test can't mistake it for the real one.
    pub fn stand_in_for(&self) -> String {
        "OutLayer".to_owned()
    }
}
