//! BounTEE's bounty contract. Scaffold only (ticket #6): it is deployed with the accounts
//! of OutLayer and the MPC network and the judge's build hash, and reports them. Posting,
//! claims and payouts land in the contract tickets.

use bountee_formats::B256;
use near_sdk::{near, AccountId, PanicOnDefault};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    config: Config,
}

/// What the contract is pinned to at deployment (R1.3).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// OutLayer's contract: the only caller whose verdicts are accepted (R2.2).
    pub outlayer: AccountId,
    /// NEAR Chain Signatures' MPC contract (`v1.signer-prod.testnet` on testnet).
    pub mpc: AccountId,
    /// The judge build every bounty is judged by.
    pub judge_build_hash: B256,
}

#[near]
impl Contract {
    #[init]
    pub fn new(config: Config) -> Self {
        Self { config }
    }

    pub fn config(&self) -> Config {
        self.config.clone()
    }
}
