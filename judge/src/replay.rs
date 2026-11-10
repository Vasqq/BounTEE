//! A local replay (R2.9): check the header, verify the proofs, run the exploit from fresh
//! accounts holding exactly the seed, and score it by the one payout rule (R3.8, R4).
//!
//! Nothing here knows about any exploit, contract or bounty (D11): every address and
//! amount comes from the job.
//!
//! Seams for the enclave mode: #14 confirms the claim's block through the pinned RPCs and
//! then calls [`judge`] with the header it confirmed; #15 reads the sealed exploit from
//! OutLayer's secrets, checks the account bound inside it, and calls [`judge`] with the
//! exploit it unsealed. Neither may print the diagnostics: they are for local runs only,
//! and in the enclave they would leak what the sealed exploit does.

use std::cell::RefCell;
use std::rc::Rc;

use bountee_formats::{
    AccountProof, BlockRef, Bytes, Exploit, ListedToken, Reason, Rules, Token, Verdict,
};
use revm::context::result::{EVMError, ExecutionResult, Output};
use revm::context::{BlockEnv, CfgEnv, Context, ContextTr, JournalTr, TxEnv};
use revm::database::CacheDB;
use revm::database_interface::Database;
use revm::inspector::Inspector;
use revm::interpreter::{CreateInputs, CreateOutcome, CreateScheme};
use revm::primitives::{Address, TxKind, B256, U256};
use revm::state::AccountInfo;
use revm::{ExecuteEvm, InspectCommitEvm, MainBuilder, MainContext};

use crate::header::{self, Header};
use crate::profile::Profile;
use crate::proofs::{Proven, ProvenState};
use crate::score;
use crate::state::{ProvenDb, Unproven};

/// Why a job ended without a verdict (the enclave job fails; R2.6).
#[derive(Debug)]
pub enum NoVerdict {
    /// The rules seed ERC-20s. BounTEE sets the seed (R1.1) and seeds only native coin:
    /// crediting a token balance would mean knowing the token's storage layout (D11).
    SeedTokens,
}

/// Judge a local replay job.
pub fn judge(
    rules: &Rules,
    block: &BlockRef,
    header_rlp: &Bytes,
    proofs: &[AccountProof],
    exploit: &Exploit,
    diagnostics: &mut dyn FnMut(&dyn std::fmt::Display),
) -> Result<Verdict, NoVerdict> {
    let reason = match run(rules, block, header_rlp, proofs, exploit, diagnostics) {
        Ok(reason) => reason,
        Err(Ended::Reason(reason)) => reason,
        Err(Ended::NoVerdict(why)) => return Err(why),
    };
    Ok(Verdict::new(reason))
}

enum Ended {
    Reason(Reason),
    NoVerdict(NoVerdict),
}

impl From<Reason> for Ended {
    fn from(reason: Reason) -> Self {
        Ended::Reason(reason)
    }
}

type Db = CacheDB<ProvenDb>;

fn run(
    rules: &Rules,
    block: &BlockRef,
    header_rlp: &Bytes,
    proofs: &[AccountProof],
    exploit: &Exploit,
    diagnostics: &mut dyn FnMut(&dyn std::fmt::Display),
) -> Result<Reason, Ended> {
    // D1: the block names the claim's proof chain, which must be a covered contract's
    // chain; checked before anything else.
    let counted = score::on_proof_chain(rules, block.chain_id.get())?;
    // D29: the proof chain's profile says how its blocks are read and replayed.
    let chain = ProofChain::of(block.chain_id.get());

    // R2.9: the header must hash to the claim's block hash and carry its number.
    let block_hash: B256 = block
        .hash
        .as_str()
        .parse()
        .map_err(|_| Reason::UnprovenState)?;
    let header_bytes = hex(header_rlp.as_str()).ok_or(Reason::UnprovenState)?;
    let header = header::verified(&header_bytes, block_hash, chain.profile)
        .filter(|h| h.number == block.number.get())
        .ok_or(Reason::UnprovenState)?;

    // R4.5: every proof must hold against the header's state root.
    let proven = ProvenState::verify(header.state_root, proofs).ok_or(Reason::UnprovenState)?;

    // R3.11: an exploit is one or more transactions.
    let n = exploit.transactions.len();
    if n == 0 || n > Exploit::MAX_TRANSACTIONS {
        return Err(Reason::MalformedExploit.into());
    }
    if !rules.seed.tokens.is_empty() {
        return Err(Ended::NoVerdict(NoVerdict::SeedTokens));
    }
    let seed_native: U256 = parse_u256(rules.seed.native.as_str())?;

    let db = ProvenDb::new(
        proven,
        [
            (header.number, block_hash),
            (header.number.saturating_sub(1), header.parent_hash),
        ],
    );

    // R4.1: every sender must be proven absent at the claim's block.
    let mut senders: Vec<Address> = Vec::new();
    for tx in &exploit.transactions {
        let from = parse_address(tx.from.as_str())?;
        if !senders.contains(&from) {
            senders.push(from);
        }
    }
    for sender in &senders {
        match db.proven(sender) {
            Some(Proven::Absent) => {}
            Some(Proven::Present { .. }) => return Err(Reason::ExistingSender.into()),
            None => {
                diagnostics(&Unproven::Account(*sender));
                return Err(Reason::UnprovenState.into());
            }
        }
    }

    let creations = Creations {
        holdings: Rc::new(RefCell::new(senders.clone())),
        created: Rc::default(),
    };
    let outcome = execute(
        rules,
        chain,
        &counted,
        &header,
        &db,
        &senders,
        seed_native,
        exploit,
        &creations,
        diagnostics,
    );

    // R4.5: an account no proof mentions read as absent; that holds only if the replay
    // created it at an address with no prior state ([`Creations`]), whoever deployed it.
    // Checked first, whatever the replay did after such a read.
    let created = creations.created.borrow();
    let stray: Vec<Address> = db
        .unproven_accounts
        .borrow()
        .iter()
        .filter(|a| !created.contains(a))
        .copied()
        .collect();
    if !stray.is_empty() {
        for a in stray {
            diagnostics(&Unproven::Account(a));
        }
        return Err(Reason::UnprovenState.into());
    }
    outcome
}

/// Run the exploit from the seeded fresh accounts and score it.
#[allow(clippy::too_many_arguments)]
fn execute(
    rules: &Rules,
    chain: ProofChain,
    counted: &score::OnProofChain,
    header: &Header,
    db: &ProvenDb,
    senders: &[Address],
    seed_native: U256,
    exploit: &Exploit,
    creations: &Creations,
    diagnostics: &mut dyn FnMut(&dyn std::fmt::Display),
) -> Result<Reason, Ended> {
    // R4.7: the fresh accounts start holding exactly the seed.
    let mut cache = CacheDB::new(db.clone());
    for sender in senders {
        cache.insert_account_info(
            *sender,
            AccountInfo {
                balance: seed_native,
                ..Default::default()
            },
        );
    }
    let start = cache.clone();

    let mut evm = Context::mainnet()
        .with_db(cache)
        .with_block(block_env(chain, header))
        .with_cfg(cfg(chain, header))
        .build_mainnet_with_inspector(creations.clone());

    let mut nonces: Vec<(Address, u64)> = senders.iter().map(|s| (*s, 0)).collect();
    for (i, tx) in exploit.transactions.iter().enumerate() {
        let from = parse_address(tx.from.as_str())?;
        let nonce = nonces
            .iter_mut()
            .find(|(a, _)| *a == from)
            .expect("a sender");
        let kind = match &tx.to {
            Some(to) => TxKind::Call(parse_address(to.as_str())?),
            None => TxKind::Create,
        };
        let env = TxEnv::builder()
            .caller(from)
            .kind(kind)
            .value(parse_u256(tx.value.as_str())?)
            .data(
                hex(tx.input.as_str())
                    .ok_or(Reason::MalformedExploit)?
                    .into(),
            )
            // D29: within the chain's per-transaction cap (the CLI asks for the block's
            // whole gas limit, which on Arbitrum is far above it).
            .gas_limit(chain.profile.clamp_gas(tx.gas.get()))
            .gas_price(0)
            .nonce(nonce.1)
            .chain_id(Some(chain.id))
            .build()
            .map_err(|_| Reason::MalformedExploit)?;
        match evm.inspect_tx_commit(env) {
            Ok(_) => nonce.1 += 1,
            Err(EVMError::Database(unproven)) => {
                diagnostics(&unproven);
                return Err(Reason::UnprovenState.into());
            }
            // The transaction can't be included (funds, gas, nonce): not a runnable exploit.
            Err(e) => {
                diagnostics(&format!("malformed: transaction {i} can't run: {e:?}"));
                return Err(Reason::MalformedExploit.into());
            }
        }
    }
    let end = evm.ctx.journaled_state.database.clone();
    drop(evm);

    let holdings = creations.holdings.borrow().clone();
    let (listed, covered) = (&counted.listed, &counted.covered);
    let start_value = value(listed, chain, header, start, &holdings, covered, diagnostics)?;
    let end_value = value(listed, chain, header, end, &holdings, covered, diagnostics)?;
    Ok(score::verdict(rules, counted, &start_value, &end_value)?)
}

/// The proof chain: its ID and how it executes (D29).
#[derive(Clone, Copy)]
struct ProofChain {
    id: u64,
    profile: &'static Profile,
}

impl ProofChain {
    fn of(id: u64) -> Self {
        ProofChain {
            id,
            profile: Profile::of(id),
        }
    }
}

/// The replay runs in the block after the claim's: number + 1, timestamp + 1, the claim
/// block's beneficiary and gas limit, the chain's randomness, and a base fee of 0 (every
/// transaction pays gas price 0, so fees never move value, R4.9).
fn block_env(chain: ProofChain, header: &Header) -> BlockEnv {
    BlockEnv {
        number: U256::from(header.number + 1),
        beneficiary: header.beneficiary,
        timestamp: U256::from(header.timestamp + 1),
        gas_limit: header.gas_limit,
        basefee: 0,
        difficulty: U256::ZERO,
        prevrandao: Some(chain.profile.randomness(header)),
        ..Default::default()
    }
}

/// The chain's EVM rules and per-transaction gas cap (D29).
fn cfg(chain: ProofChain, header: &Header) -> CfgEnv {
    let mut cfg = CfgEnv::new_with_spec(chain.profile.spec(header));
    cfg.chain_id = chain.id;
    cfg.tx_gas_limit_cap = chain.profile.tx_gas_cap();
    cfg
}

/// Holdings at one point of the replay, per listed token on the proof chain, for the
/// attacker and the covered contracts on it.
pub struct Values {
    pub attacker: Vec<U256>,
    pub covered: Vec<U256>,
}

/// Read the proof chain's `listed` tokens' holdings in `db`: native coin by account balance,
/// an ERC-20 by calling its `balanceOf` (never by knowing its storage layout, D11).
fn value(
    listed: &[&ListedToken],
    chain: ProofChain,
    header: &Header,
    mut db: Db,
    attacker: &[Address],
    covered: &[Address],
    diagnostics: &mut dyn FnMut(&dyn std::fmt::Display),
) -> Result<Values, Ended> {
    // The caller of the balanceOf calls; a synthetic account that only this copy has.
    let reader = Address::with_last_byte(0xbb).create(u64::MAX);
    db.insert_account_info(reader, AccountInfo::default());
    let mut cfg = cfg(chain, header);
    cfg.disable_nonce_check = true;
    let mut evm = Context::mainnet()
        .with_db(db)
        .with_block(block_env(chain, header))
        .with_cfg(cfg)
        .build_mainnet();

    let mut read = |holders: &[Address]| -> Result<Vec<U256>, Ended> {
        let mut per_token = Vec::new();
        for listed in listed {
            let mut total = U256::ZERO;
            for holder in holders {
                let amount = match &listed.token {
                    Token::Native => match evm.ctx.journaled_state.database.basic(*holder) {
                        Ok(info) => info.map(|i| i.balance).unwrap_or_default(),
                        Err(unproven) => {
                            diagnostics(&unproven);
                            return Err(Reason::UnprovenState.into());
                        }
                    },
                    Token::Erc20(token) => {
                        let mut data = vec![0x70, 0xa0, 0x82, 0x31]; // balanceOf(address)
                        data.extend_from_slice(
                            B256::left_padding_from(holder.as_slice()).as_slice(),
                        );
                        let tx = TxEnv::builder()
                            .caller(reader)
                            .kind(TxKind::Call(parse_address(token.as_str())?))
                            .data(data.into())
                            .gas_limit(chain.profile.clamp_gas(header.gas_limit.min(30_000_000)))
                            .gas_price(0)
                            .chain_id(Some(chain.id))
                            .build()
                            .map_err(|_| Reason::MalformedExploit)?;
                        match evm.transact(tx) {
                            Ok(r) => {
                                match r.result {
                                    ExecutionResult::Success {
                                        output: Output::Call(out),
                                        ..
                                    } if out.len() >= 32 => U256::from_be_slice(&out[..32]),
                                    // A listed token that can't say a balance can't be scored.
                                    _ => {
                                        diagnostics(&format!("malformed: {token}.balanceOf({holder:#x}) gave no balance"));
                                        return Err(Reason::MalformedExploit.into());
                                    }
                                }
                            }
                            Err(EVMError::Database(unproven)) => {
                                diagnostics(&unproven);
                                return Err(Reason::UnprovenState.into());
                            }
                            Err(_) => return Err(Reason::MalformedExploit.into()),
                        }
                    }
                };
                total = total.checked_add(amount).ok_or(Reason::MalformedExploit)?;
            }
            per_token.push(total);
        }
        Ok(per_token)
    };
    let attacker = read(attacker)?;
    let covered = read(covered)?;
    Ok(Values { attacker, covered })
}

/// Tracks the contracts the replay creates.
#[derive(Clone)]
struct Creations {
    /// Attacker holdings (R4.8): the fresh accounts, plus every contract an attacker
    /// holding creates during the replay, and nothing else.
    holdings: Rc<RefCell<Vec<Address>>>,
    /// Every contract the replay created, whoever deployed it, at an address that can't
    /// have held an account before (R4.5): its prior state is empty and needs no proof.
    /// That is any CREATE (its address comes from the deployer's proven nonce, used now
    /// for the first time), and a CREATE2 by a fresh account or a contract created in
    /// this replay. A CREATE2 by a contract that existed at the claim's block can land
    /// on an address it already deployed to (a reused salt), where the chain refuses the
    /// creation; so that address needs a proof of its absence, as any other read does.
    created: Rc<RefCell<Vec<Address>>>,
}

impl<CTX: ContextTr> Inspector<CTX> for Creations
where
    CTX::Journal: JournalTr,
{
    fn create_end(&mut self, _: &mut CTX, inputs: &CreateInputs, outcome: &mut CreateOutcome) {
        // Only a creation that succeeded; a reverted one's address stays unproven.
        if let (Some(address), true) = (outcome.address, outcome.result.result.is_ok()) {
            let deployer = inputs.caller();
            let mut holdings = self.holdings.borrow_mut();
            let mut created = self.created.borrow_mut();
            let new_deployer = holdings.contains(&deployer) || created.contains(&deployer);
            let by_nonce = matches!(inputs.scheme(), CreateScheme::Create);
            if (new_deployer || by_nonce) && !created.contains(&address) {
                created.push(address);
            }
            if holdings.contains(&deployer) && !holdings.contains(&address) {
                holdings.push(address);
            }
        }
    }
}

fn parse_address(s: &str) -> Result<Address, Ended> {
    s.parse().map_err(|_| Reason::MalformedExploit.into())
}

fn parse_u256(s: &str) -> Result<U256, Ended> {
    s.parse().map_err(|_| Reason::MalformedExploit.into())
}

pub(crate) fn hex(s: &str) -> Option<Vec<u8>> {
    let digits = s.strip_prefix("0x")?.as_bytes();
    digits
        .chunks(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).ok()?, 16).ok())
        .collect()
}
