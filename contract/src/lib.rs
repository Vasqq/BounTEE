//! BounTEE's bounty contract: a keyless NEAR contract holding many bounties.
//!
//! - [`posting`]: the posting fee in NEAR, then the bounty amount as one USDC
//!   transfer-and-call carrying the rules; the bounty goes live once its posting check passes.
//! - [`claims`]: a Whitehat's claim balance; a claim stores its sealed exploit as its own
//!   OutLayer secret and requests its job at once; only OutLayer's callback delivers a verdict.
//! - [`pauses`]: a PAYS verdict closes the bounty; a pause for every covered contract is
//!   signed by NEAR Chain Signatures, checked and stored, and only then is it paid.
//! - [`payout`]: the whole bounty is paid to the Whitehat.
//! - [`release`]: after the payout, the winning exploit is released to the Protocol's
//!   exploit key by a job the contract requests (R6).
//! - [`verification`]: anyone can have a chain's landed pause verified by NEAR's MPC network;
//!   off the money path.
//! - [`outlayer`]: the exact OutLayer requests (secret, access rule, job).
//!
//! Deployment (R2.1): one transaction deploys the code, calls [`Contract::new`] and deletes
//! the account's only key. Nothing in the contract adds a key, deploys code or changes the
//! configuration afterwards.

use bountee_formats::{BlockRef, BountyId, Bytes, CoveredContract, Rules, Seed, Verdict, B256};
use near_sdk::json_types::U128;
use near_sdk::store::LookupMap;
use near_sdk::{
    env, near, require, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, PublicKey,
};

mod claims;
mod outlayer;
mod pauses;
mod payout;
mod posting;
mod release;
mod verification;

/// What the contract is pinned to at deployment and never changes (R1.3).
#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Config {
    /// OutLayer's contract: the only account whose job results become verdicts (R2.2).
    pub outlayer: AccountId,
    /// NEAR Chain Signatures' MPC contract (`v1.signer-prod.testnet` on testnet).
    pub mpc: AccountId,
    /// That MPC contract's root secp256k1 key (its `public_key` view, domain 0), from which
    /// every bounty's pause-role address is derived (D25) and checked (R7.2).
    pub mpc_root_public_key: PublicKey,
    /// USDC's NEP-141 contract: the only token a bounty is posted and paid in.
    pub usdc: AccountId,
    /// The judge build every bounty is judged by; every posting must name it (R1.3).
    pub judge_build_hash: B256,
    /// Where OutLayer fetches the judge's wasm. What runs is chosen by the hash, never the URL.
    pub judge_wasm_url: String,
    /// The seed every bounty's replay starts fresh accounts with; set by BounTEE (R1.1, R4.7).
    /// Native coin only: the judge gives no verdict for a seed holding any ERC-20.
    pub seed: Seed,
}

/// Costs, all in yoctoNEAR. The contract never pays any of them from its own balance (R11.4).
pub mod fees {
    use near_sdk::NearToken;

    /// NEAR's storage price: 10^19 yoctoNEAR per byte.
    pub const STORAGE_PRICE_PER_BYTE: u128 = 10_000_000_000_000_000_000;
    /// Attached to every OutLayer job; covers the job's resource limits (0.00701 NEAR on
    /// testnet, Nov 4). OutLayer refunds what the job doesn't use to its payer.
    pub const JOB_DEPOSIT: NearToken = NearToken::from_millinear(20);
    /// Input bytes OutLayer takes with no deposit; above this it holds 1 storage price per
    /// byte while the job runs and refunds it to the payer at settlement.
    pub const JOB_INPUT_FREE_BYTES: u64 = 32 * 1024;
    /// Bytes allowed for a secret row beyond its ciphertext (accessor, profile, owner,
    /// access rule, indexes). OutLayer refunds the excess to the contract.
    pub const SECRET_ROW_OVERHEAD_BYTES: u64 = 1024;
    /// Storage a bounty's record may use; a posting needing more is refused.
    pub const BOUNTY_STORAGE_BYTES: u64 = 10_000;
    /// Registers a winning Whitehat with USDC if needed (R2.7); the token refunds the excess.
    pub const USDC_REGISTRATION: NearToken = NearToken::from_micronear(12_500);
    /// The posting fee: the posting check's job, the bounty's storage, the winner's USDC
    /// registration and the payout's yoctoNEAR, the release and publication jobs, and up to
    /// three pause verifications per covered chain. Not refunded if the posting is refused.
    pub const POSTING_FEE: NearToken = NearToken::from_millinear(500);
    /// What one pause's verification attempt costs the contract: the MPC call's 1 yoctoNEAR
    /// and up to 200 bytes of storage for the record. Taken from the posting fee for the
    /// first three attempts per chain, from the caller's deposit after that (R7.10).
    pub const VERIFY_PAUSE: NearToken = NearToken::from_millinear(2);
}

/// Gas floors and the gas kept for callbacks.
pub mod gas {
    use near_sdk::Gas;

    /// `ft_on_transfer` refuses a posting with less left than this, so the token refunds the
    /// USDC instead of keeping it with no check running (spike #4: OutLayer needs ~55 Tgas).
    pub const MIN_POSTING: Gas = Gas::from_tgas(100);
    /// `submit_claim` refuses a claim attached less than this.
    pub const MIN_CLAIM: Gas = Gas::from_tgas(200);
    /// For `store_secrets` on OutLayer.
    pub const STORE_SECRET: Gas = Gas::from_tgas(30);
    /// For the posting check's callback.
    pub const ON_POSTING_CHECKED: Gas = Gas::from_tgas(15);
    /// For a claim's verdict callback's own work; on PAYS, [`pause_signing`] more.
    pub const ON_CLAIM_JUDGED: Gas = Gas::from_tgas(20);
    /// Kept back by a method for its own work after it schedules a job.
    pub const TAIL: Gas = Gas::from_tgas(10);
    /// For each step of the payout.
    pub const USDC_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
    pub const USDC_TRANSFER: Gas = Gas::from_tgas(15);
    pub const ON_PAID: Gas = Gas::from_tgas(10);
    /// For each pause's `sign` on the MPC contract, which asks for at least 15 Tgas and
    /// keeps 7 for its own yield callback (testnet config, Nov 4).
    pub const SIGN_PAUSE: Gas = Gas::from_tgas(20);
    /// For a release job's callback (#22).
    pub const ON_RELEASED: Gas = Gas::from_tgas(15);
    /// What OutLayer's `request_execution` needs, most of it kept for its own callback
    /// (spike #4: about 55 Tgas).
    pub const REQUEST_JOB: Gas = Gas::from_tgas(60);
    /// For checking and storing the signed pauses, then the payout's three steps.
    pub const ON_PAUSES_SIGNED: Gas = Gas::from_tgas(50);
    /// What the claim's job is left at least, before gas is kept back to sign pauses.
    pub const MIN_JOB: Gas = Gas::from_tgas(60);
    /// For each pause's `verify_foreign_transaction` on the MPC contract, which asks for at
    /// least 15 Tgas (testnet config, Nov 4; about 13.4 Tgas burnt in all, spike #3).
    pub const VERIFY_PAUSE: Gas = Gas::from_tgas(20);
    /// For recording a verification's answers.
    pub const ON_PAUSE_VERIFIED: Gas = Gas::from_tgas(10);

    /// Gas for the payout's three steps, from the call that starts it.
    pub const fn payout() -> Gas {
        Gas::from_gas(
            USDC_STORAGE_DEPOSIT.as_gas()
                + USDC_TRANSFER.as_gas()
                + ON_PAID.as_gas()
                + TAIL.as_gas(),
        )
    }

    /// Gas to request a release job and keep its result, from the call that starts it.
    pub const fn release() -> Gas {
        Gas::from_gas(REQUEST_JOB.as_gas() + ON_RELEASED.as_gas() + TAIL.as_gas())
    }

    /// Gas to verify `n` pauses on one chain, from the call that starts it.
    pub const fn pause_verifying(n: usize) -> Gas {
        Gas::from_gas(VERIFY_PAUSE.as_gas() * n as u64 + ON_PAUSE_VERIFIED.as_gas() + TAIL.as_gas())
    }

    /// Gas to sign the pauses of `n` covered contracts and pay, from the call that starts it.
    pub const fn pause_signing(n: usize) -> Gas {
        Gas::from_gas(SIGN_PAUSE.as_gas() * n as u64 + ON_PAUSES_SIGNED.as_gas() + TAIL.as_gas())
    }
}

#[derive(BorshStorageKey)]
#[near]
enum Key {
    /// Stays first (prefix 0): `bountee list` finds every bounty by this prefix with NEAR
    /// RPC's `view_state`, since the map has no index (`cli/src/bounties.ts`).
    Bounties,
    Claims,
    PostingFees,
    ClaimBalances,
    PauseVerifications,
    CoveredBy,
    Releases,
    SealedExploits,
}

/// Where a bounty is in its life.
#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BountyState {
    /// Posted; its posting check hasn't passed yet, so it takes no claims (R3.12).
    Checking,
    /// Taking claims.
    Live,
    /// Its posting check failed; the USDC went back to the Protocol (R1.6).
    CheckFailed,
    /// A PAYS verdict closed it; its pauses are being signed, or wait for a retry, before
    /// the payout (R2.5). It takes no more claims (R3.4).
    Signing,
    /// Every pause is signed and stored; the payout is under way, or its transfer failed
    /// and waits for a retry ([`Contract::retry_payout`]).
    Paying,
    /// The whole bounty was paid to the winning claim (R3.2).
    Paid,
}

#[near(serializers = [borsh])]
pub struct Bounty {
    pub rules: Rules,
    pub state: BountyState,
    pub winning_claim: Option<u64>,
    /// What is left of the posting fee for this bounty's later costs.
    pub fee_reserve: NearToken,
    /// Every covered contract's signed pause, stored at once when all are signed (R7.3).
    pub signed_pauses: Vec<pauses::SignedPause>,
    /// The block height a pause-signing request started at, while it is under way, so a
    /// retry can't run beside it. A request older than [`pauses::SIGNING_STALE_BLOCKS`] is
    /// treated as over: its callback must have run (or died) by then.
    pub signing_since: Option<u64>,
    /// Set while a payout's transfer is under way and cleared only by its callback, so no
    /// retry can send a second transfer beside it.
    pub paying_out: bool,
    /// Claims on this bounty with no verdict yet (storing, judging, or waiting for a retry),
    /// as (claim ID, submission time). Each holds its place against a later PAYS for
    /// [`claims::CLAIM_PLACE_HOLD_NS`] from its submission (R2.6, R3.6).
    pub open_claims: Vec<(u64, u64)>,
}

/// A bounty as its view returns it: every rule exactly as posted (R1.2).
#[near(serializers = [json])]
pub struct BountyView {
    pub id: BountyId,
    pub rules: Rules,
    pub state: BountyState,
    pub winning_claim: Option<u64>,
    /// The signed pauses, for anyone to broadcast (R7.3); empty until all are signed.
    pub signed_pauses: Vec<pauses::SignedPause>,
    /// Whether pause signing is under way; a `signing` bounty that isn't waits for a retry.
    pub signing_pauses: bool,
    /// Whether a payout transfer is under way; a `paying` bounty that isn't waits for a retry.
    pub paying_out: bool,
    /// While an earlier claim still holds its place, the latest time it can hold the winning
    /// claim's payout (R3.6); after it, anyone's `retry_payout` pays.
    pub payout_waits_until_ns: Option<near_sdk::json_types::U64>,
}

/// Where a claim is in its life.
#[near(serializers = [json, borsh])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ClaimState {
    /// Its sealed exploit is being stored as an OutLayer secret.
    Storing,
    /// The secret couldn't be stored; nothing was judged and its costs went back to the
    /// claim balance.
    StoreFailed,
    /// Its job is requested and the verdict hasn't arrived.
    Judging,
    /// The job failed or was refused: no verdict, and nothing moved (R2.6).
    NoVerdict,
    /// The verdict is recorded.
    Judged,
}

#[near(serializers = [json, borsh])]
#[derive(Clone)]
pub struct ClaimRecord {
    pub bounty: BountyId,
    /// The claiming account: the one that filed the claim and is paid on PAYS.
    pub whitehat: AccountId,
    pub block: BlockRef,
    pub header: Bytes,
    /// sha256 of the proofs exactly as submitted; the contract forwards them unparsed.
    pub proofs_sha256: B256,
    /// NEAR block time the contract recorded at submission (R2.8).
    pub submitted_at_ns: near_sdk::json_types::U64,
    /// The OutLayer secret profile holding this claim's sealed exploit; stored once, read by
    /// the claim's job and, for a winning claim, its release job.
    pub secret_profile: String,
    pub state: ClaimState,
    pub verdict: Option<Verdict>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    config: Config,
    bounties: LookupMap<BountyId, Bounty>,
    claims: LookupMap<u64, ClaimRecord>,
    next_claim_id: u64,
    /// NEAR each Protocol has prepaid toward posting fees.
    posting_fees: LookupMap<AccountId, NearToken>,
    /// NEAR each Whitehat has prepaid toward claims (ADR-0007).
    claim_balances: LookupMap<AccountId, NearToken>,
    /// Each bounty's pause verifications, per chain (R7.10).
    pause_verifications: LookupMap<BountyId, Vec<verification::ChainVerification>>,
    /// The bounty that last covered each contract; it still covers it while its posting
    /// check is pending or it is live (R12.3).
    covered_by: LookupMap<CoveredContract, BountyId>,
    /// Each paid bounty's release of its winning exploit (#22).
    releases: LookupMap<BountyId, release::ReleaseRecord>,
    /// The claim each sealed exploit (by sha256 of its ciphertext) was filed as, so the
    /// same one is never judged twice (R3.5).
    sealed_exploits: LookupMap<B256, u64>,
}

#[near]
impl Contract {
    /// Pins the configuration. The attached deposit registers this contract with USDC, so
    /// it can receive bounty amounts; the deployer pays it, never the contract.
    #[init]
    #[payable]
    pub fn new(config: Config) -> Self {
        require!(
            env::attached_deposit() >= fees::USDC_REGISTRATION,
            "attach the USDC registration deposit"
        );
        require!(
            config.seed.tokens.is_empty(),
            "the seed is native coin only"
        );
        require!(
            pauses::derived_key(&config.mpc_root_public_key, &env::current_account_id(), "")
                .is_some(),
            "the MPC root key must be a secp256k1 key"
        );
        let me = env::current_account_id();
        payout::ext_ft::ext(config.usdc.clone())
            .with_attached_deposit(env::attached_deposit())
            .with_static_gas(gas::USDC_STORAGE_DEPOSIT)
            .storage_deposit(Some(me), Some(true))
            .detach();
        Self {
            config,
            bounties: LookupMap::new(Key::Bounties),
            claims: LookupMap::new(Key::Claims),
            next_claim_id: 0,
            posting_fees: LookupMap::new(Key::PostingFees),
            claim_balances: LookupMap::new(Key::ClaimBalances),
            pause_verifications: LookupMap::new(Key::PauseVerifications),
            covered_by: LookupMap::new(Key::CoveredBy),
            releases: LookupMap::new(Key::Releases),
            sealed_exploits: LookupMap::new(Key::SealedExploits),
        }
    }

    pub fn config(&self) -> Config {
        self.config.clone()
    }

    /// The fixed costs, in yoctoNEAR, and the gas floors, in gas units.
    pub fn fees(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({
            "posting_fee": fees::POSTING_FEE,
            "job_deposit": fees::JOB_DEPOSIT,
            "job_input_free_bytes": fees::JOB_INPUT_FREE_BYTES,
            "storage_price_per_byte": U128(fees::STORAGE_PRICE_PER_BYTE),
            "secret_row_overhead_bytes": fees::SECRET_ROW_OVERHEAD_BYTES,
            "min_posting_gas": gas::MIN_POSTING,
            "min_claim_gas": gas::MIN_CLAIM,
            "min_sign_pauses_gas_per_contract": gas::SIGN_PAUSE,
            "min_sign_pauses_gas_base": gas::pause_signing(0),
            "min_retry_payout_gas": gas::payout(),
            "min_release_gas": gas::release(),
            "release_hold": release::release_hold(),
            "claim_place_hold_ns": near_sdk::json_types::U64(claims::CLAIM_PLACE_HOLD_NS),
            "pause_gas_limit": pauses::PAUSE_GAS_LIMIT,
            "pause_max_fee_per_gas": U128(pauses::PAUSE_MAX_FEE_PER_GAS),
            "pause_max_priority_fee_per_gas": U128(pauses::PAUSE_MAX_PRIORITY_FEE_PER_GAS),
            "verify_pause_fee_per_pause": fees::VERIFY_PAUSE,
            "prepaid_verify_attempts": verification::PREPAID_ATTEMPTS,
            "min_verify_pause_gas_base": gas::pause_verifying(0),
            "min_verify_pause_gas_per_pause": gas::VERIFY_PAUSE,
            // What the posting check asks each pause-role address to hold per pause on a
            // chain: gas limit at fee limit, plus an OP-stack chain's L1 data fee (R7.6).
            "pause_l1_data_fee_allowance": U128(bountee_formats::PAUSE_L1_DATA_FEE_ALLOWANCE),
            "pause_gas_per_pause": U128(
                pauses::PAUSE_GAS_LIMIT as u128 * pauses::PAUSE_MAX_FEE_PER_GAS
                    + bountee_formats::PAUSE_L1_DATA_FEE_ALLOWANCE
            ),
        })
    }

    pub fn bounty(&self, id: BountyId) -> Option<BountyView> {
        self.bounties.get(&id).map(|b| BountyView {
            id: id.clone(),
            rules: b.rules.clone(),
            state: b.state,
            winning_claim: b.winning_claim,
            signed_pauses: b.signed_pauses.clone(),
            signing_pauses: b.signing_in_flight(),
            paying_out: b.paying_out,
            payout_waits_until_ns: b
                .winning_claim
                .and_then(|w| b.payout_held_until(w, env::block_timestamp()))
                .map(near_sdk::json_types::U64),
        })
    }

    pub fn claim(&self, claim_id: u64) -> Option<ClaimRecord> {
        self.claims.get(&claim_id).cloned()
    }

    pub fn posting_fee_balance(&self, account_id: AccountId) -> NearToken {
        self.posting_fees
            .get(&account_id)
            .copied()
            .unwrap_or(NearToken::from_yoctonear(0))
    }

    pub fn claim_balance(&self, account_id: AccountId) -> NearToken {
        self.claim_balances
            .get(&account_id)
            .copied()
            .unwrap_or(NearToken::from_yoctonear(0))
    }
}

impl Contract {
    /// Credit an attached deposit, less the storage a new balance entry takes, so a
    /// first deposit pays for its own entry and never the contract (R11.4).
    fn credit_deposit(
        map: &mut LookupMap<AccountId, NearToken>,
        who: &AccountId,
        amount: NearToken,
    ) {
        let before = env::storage_usage();
        Self::credit(map, who, amount);
        map.flush();
        let entry = NearToken::from_yoctonear(
            env::storage_usage().saturating_sub(before) as u128 * fees::STORAGE_PRICE_PER_BYTE,
        );
        require!(
            amount > entry,
            "the deposit doesn't cover the storage of its balance"
        );
        let have = map.get(who).copied().expect("just credited");
        map.insert(who.clone(), have.saturating_sub(entry));
    }

    fn credit(map: &mut LookupMap<AccountId, NearToken>, who: &AccountId, amount: NearToken) {
        let have = map
            .get(who)
            .copied()
            .unwrap_or(NearToken::from_yoctonear(0));
        map.insert(who.clone(), have.saturating_add(amount));
    }

    /// Gas left in this call after `keep` is set aside.
    fn gas_left(keep: Gas) -> Gas {
        env::prepaid_gas()
            .saturating_sub(env::used_gas())
            .saturating_sub(keep)
    }
}

/// NEP-297 events, so tools can follow a bounty and a claim live (D23).
pub(crate) fn emit(event: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({
            "standard": "bountee",
            "version": "1.0.0",
            "event": event,
            "data": [data],
        })
    ));
}

pub(crate) fn to_formats_account(id: &AccountId) -> bountee_formats::AccountId {
    bountee_formats::AccountId::parse(id.as_str())
        .unwrap_or_else(|_| env::panic_str("this account can't hold a bounty"))
}
