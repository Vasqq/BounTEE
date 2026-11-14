//! The one payout rule (R3.8, ADR-0006): score = min(gain, loss), valued over the listed
//! tokens at posting prices, in exact integer arithmetic.

use bountee_formats::{ListedToken, Reason, Rules};
use revm::primitives::ruint::Uint;
use revm::primitives::{Address, U256};

use crate::replay::Values;

/// Wide enough for any sum of amount × price: each product is below 2^512, and 2^512
/// such products still fit.
type Value = Uint<1024, 16>;

/// What the rules count on a claim's proof chain (D1, R3.8): the covered contracts on it,
/// each once, and the listed tokens on it, in the rules' order. Nothing on another chain
/// counts toward loss or value.
pub struct OnProofChain<'a> {
    pub covered: Vec<Address>,
    pub listed: Vec<&'a ListedToken>,
}

/// The rules as counted on `chain_id`, the claim block's chain: its proof chain. INVALID
/// `chain_not_covered` when no covered contract is on it (D1), which a claim or replay job
/// checks before anything else.
pub fn on_proof_chain(rules: &Rules, chain_id: u64) -> Result<OnProofChain<'_>, Reason> {
    let mut covered: Vec<Address> = Vec::new();
    for c in rules.covered_contracts.iter().filter(|c| c.chain_id.get() == chain_id) {
        let a: Address = c
            .address
            .as_str()
            .parse()
            .map_err(|_| Reason::MalformedExploit)?;
        if !covered.contains(&a) {
            covered.push(a);
        }
    }
    if covered.is_empty() {
        return Err(Reason::ChainNotCovered);
    }
    let listed = rules
        .listed_tokens
        .iter()
        .filter(|t| t.chain_id.get() == chain_id)
        .collect();
    Ok(OnProofChain { covered, listed })
}

/// PAYS when the score reaches the minimum theft, ZERO otherwise (R3.8).
///
/// Gain is the attacker holdings' value at the end minus at the start, and the start is
/// the seed (R4.7): fresh accounts hold exactly the seed, created contracts nothing. (Any
/// listed token a fresh address already held at the claim's block is in the start value
/// too, so it can't count as gain.) Loss is the covered contracts' value at the claim's
/// block minus at the end.
pub fn verdict(
    rules: &Rules,
    counted: &OnProofChain,
    start: &Values,
    end: &Values,
) -> Result<Reason, Reason> {
    // The prices of the proof chain's listed tokens, in the order [`Values`] holds them.
    let prices = counted
        .listed
        .iter()
        .map(|t| {
            t.price
                .as_str()
                .parse::<U256>()
                .map_err(|_| Reason::MalformedExploit)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let worth = |amounts: &[U256]| -> Value {
        amounts
            .iter()
            .zip(&prices)
            .map(|(a, p)| widen(*a) * widen(*p))
            .fold(Value::ZERO, |sum, v| sum + v)
    };
    let gain = worth(&end.attacker).saturating_sub(worth(&start.attacker));
    let loss = worth(&start.covered).saturating_sub(worth(&end.covered));
    let score = gain.min(loss);
    let minimum: U256 = rules
        .minimum_theft
        .as_str()
        .parse()
        .map_err(|_| Reason::MalformedExploit)?;
    Ok(if score >= widen(minimum) {
        Reason::MinimumTheftReached
    } else {
        Reason::BelowMinimumTheft
    })
}

fn widen(x: U256) -> Value {
    Value::from_limbs_slice(x.as_limbs())
}
