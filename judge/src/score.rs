//! The one payout rule (R3.8, ADR-0006): score = min(gain, loss), valued over the listed
//! tokens at posting prices, in exact integer arithmetic.

use bountee_formats::{Reason, Rules};
use revm::primitives::ruint::Uint;
use revm::primitives::{Address, U256};

use crate::replay::Values;

/// Wide enough for any sum of amount × price: each product is below 2^512, and 2^512
/// such products still fit.
type Value = Uint<1024, 16>;

/// The covered contracts on the proof chain, each once.
pub fn covered(rules: &Rules) -> Result<Vec<Address>, Reason> {
    let mut out: Vec<Address> = Vec::new();
    for c in &rules.covered_contracts {
        if c.chain_id == rules.proof_chain {
            let a: Address = c
                .address
                .as_str()
                .parse()
                .map_err(|_| Reason::MalformedExploit)?;
            if !out.contains(&a) {
                out.push(a);
            }
        }
    }
    Ok(out)
}

/// PAYS when the score reaches the minimum theft, ZERO otherwise (R3.8).
///
/// Gain is the attacker holdings' value at the end minus at the start, and the start is
/// the seed (R4.7): fresh accounts hold exactly the seed, created contracts nothing. (Any
/// listed token a fresh address already held at the claim's block is in the start value
/// too, so it can't count as gain.) Loss is the covered contracts' value at the claim's
/// block minus at the end.
pub fn verdict(rules: &Rules, start: &Values, end: &Values) -> Result<Reason, Reason> {
    let prices = rules
        .listed_tokens
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
