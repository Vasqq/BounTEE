# One payout rule for every bounty: theft from the covered contracts

A Protocol doesn't know its bugs in advance, so BounTEE judges the outcome of an exploit, never its mechanism. Every bounty uses the same rule: the exploit runs from fresh accounts against the proven snapshot, and its score is the smaller of what those accounts gained and what the covered contracts lost, each totalled across the listed tokens at posting prices. If the score reaches the minimum theft, the Whitehat wins the whole bounty amount and the bounty closes. The Protocol writes no code and no invariants; it only lists covered contracts, listed tokens with their posting prices, the bounty amount and the minimum theft. This automates Immunefi's critical "direct theft of funds" class, judged by impact, and handles R4's cheats by construction rather than by special cases. The full rule and its scenarios are requirements R3.8 and R4 in [docs/requirements.md](../requirements.md).

## Considered Options

- **Attacker profit alone** (how SCONE-bench scores): pays for arbitrage and other value taken from outside the covered contracts.
- **Protocol loss alone:** pays for a public sweep to the treasury, which R4 forbids.
- **Protocol-written invariants** (HoneyPause): covers more bug classes, but puts the work and the risk of a weak rule on the Protocol, and a pass/fail rule has no amount to compare with the minimum theft. Future work.
- **Percentage tiers as the only guard against by-design payouts:** lowers the odds of a false payout without removing it; a false payout also pauses every chain. Replaced by limiting what may be covered.
- **Payout tiers** (from the brief): the rule pays one bug class, direct theft, so tiers would only slice it by amount. They add settings, tests and explanation without adding to what judges score. One amount and one minimum theft instead; the minimum keeps rounding-dust thefts from winning the bounty.

## Consequences

- Only contracts that pay nothing to callers by design (vaults, escrows, treasuries, bridge lockers) may be covered. AMM pools, lending markets with liquidations and contracts with caller rewards can appear in the snapshot only as dependencies.
- Any read of state the claim doesn't prove makes the verdict INVALID, never zero. (Since ADR-0014, the snapshot is the proof chain's recent state at the claim's block, not a copy committed at posting.)
- Bugs where nobody walks away with value (freezing, denial of service, unsold unbacked minting) and multi-block or victim-dependent attacks are out of scope and listed as future work.
- The judging code contains nothing specific to any demo exploit.
