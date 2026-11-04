# Pauses are delivered by anyone and confirmed on NEAR; no hosted watcher

Signed pauses need someone to send them to each EVM chain. The Whitehat's command-line tool sends them automatically, but it can't be the only path: once paid, a Whitehat has no reason to deliver, and a dishonest one could exploit the live contract instead. A hosted watcher would add a server we run. Instead, the bounty page shows every signed pause that hasn't landed with a "Send pause" button anyone can press, with no wallet, because sending an already-signed transaction needs no key.

Landing is then confirmed on NEAR. NEAR's MPC network offers foreign-chain transaction verification (`verify_foreign_transaction`): MPC nodes check a transaction through their own RPC providers and threshold-sign what they saw, so a NEAR contract can act on it without a trusted relayer. After a pause lands, anyone can ask the bounty contract to verify it, and the contract records "paused on <chain>, verified". That turns "paused ✓" into a fact proven on NEAR. It is off the money path: if verification fails or is slow, the page shows "landed, not yet verified" with an explorer link, and the payout never waits for landing or verification (R2.4).

The live MPC contracts (`v1.signer-prod.testnet`, `v1.signer`) list Base and Arbitrum among their foreign chains, but not Flare or Ethereum, so the demo chains become Base and Arbitrum, our core user's chains, and Flare drops out.

## Consequences

- The hosted watcher is removed.
- "Verified" waits for finality on Base and Arbitrum, so it can take minutes; the page shows "landed" first, then "verified", and the time is measured.
- The posting fee also covers up to three verification attempts per chain, so the keyless contract never pays for it (R11.4); further requests pay their own cost. The contract computes the pause's transaction hash from the signed pause it stored, so nobody can waste the prepaid attempts on junk hashes.
- To prove in the first spike: calling `verify_foreign_transaction` from the bounty contract on testnet, its request format, cost and time to "verified". Arbitrum Sepolia test-ETH access is checked early.
- Liam's Flare audience on X is no longer served by the demo chains.
- Supersedes the demo-chain choice (Base and Flare) and the hosted watcher in earlier docs.
