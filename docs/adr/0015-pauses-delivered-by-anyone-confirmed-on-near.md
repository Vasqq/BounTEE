# Pauses are delivered by anyone and confirmed on NEAR; no hosted watcher

Signed pauses need someone to send them to each EVM chain. The Whitehat's command-line tool sends them automatically, but it can't be the only path: once paid, a Whitehat has no reason to deliver, and a dishonest one could exploit the live contract instead. A hosted watcher would add a server we run. Instead, the bounty page shows every signed pause that hasn't landed with a "Send pause" button anyone can press, with no wallet, because sending an already-signed transaction needs no key.

Landing is then confirmed on NEAR. NEAR's MPC network offers foreign-chain transaction verification (`verify_foreign_transaction`): MPC nodes check a transaction through their own RPC providers and threshold-sign what they saw, so a NEAR contract can act on it without a trusted relayer. After a pause lands, anyone can ask the bounty contract to verify it, and the contract records "paused on <chain>, verified". That turns "paused ✓" into a fact proven on NEAR. It is off the money path: if verification fails or is slow, the page shows "landed, not yet verified" with an explorer link, and the payout never waits for landing or verification (R2.4).

The live MPC contracts (`v1.signer-prod.testnet`, `v1.signer`) list Base and Arbitrum among their foreign chains, but not Flare or Ethereum, so the demo chains become Base and Arbitrum, our core user's chains, and Flare drops out.

The bounty contract fixes the finality it requests at `Safe`, so nobody can pick a weaker one. MPC nodes sign only once the chain's head at the requested finality has passed the transaction's block, and they don't wait for it. On Base Sepolia on Nov 4 the `finalized` head lagged about 3 hours, longer than a demo can wait, and the `safe` head 11–27 minutes. `Latest` verifies in seconds but doesn't guard against an L2 reorg, so a "verified" pause could later vanish.

## Consequences

- The hosted watcher is removed.
- "Verified" waits for the safe head on Base and Arbitrum, so it can take minutes; the page shows "landed" first, then "verified", and the time is measured.
- The posting fee also covers up to three verification attempts per chain, so the keyless contract never pays for it (R11.4); further requests pay their own cost. The contract computes the pause's transaction hash from the signed pause it stored, so nobody can waste the prepaid attempts on junk hashes.
- A failed verification gives no reason: a reverted transaction, an unknown hash and one not yet safe all time out alike after about 200 NEAR blocks. So the command-line tool requests verification only once the chain's safe head has passed the pause's block, or the prepaid attempts are wasted.
- Proven on testnet, Nov 4: a contract's `verify_foreign_transaction` call came back verified 7 times out of 7 for a successful Base Sepolia transaction, in 7–38 s from the request, for about 0.00125 NEAR; a reverted and an unknown transaction both timed out. Arbitrum Sepolia's safe-head lag and test-ETH access are still to check.
- Liam's Flare audience on X is no longer served by the demo chains.
- Supersedes the demo-chain choice (Base and Flare) and the hosted watcher in earlier docs.
