# NEAR Intents only at the edges, and only on mainnet

Protocols live on Base or Arbitrum and have never used NEAR; Whitehats want their winnings on the chain they use. NEAR Intents' 1Click API moves USDC between NEAR and about 38 chains through a deposit address and a plain transfer, with no API key (0.25% fee, 0.15 USDC minimum, about 30 s), but it has no testnet and no plans for one, and it doesn't support Flare. So Intents is used only at the edges, never in the payout path: Whitehats are always paid in USDC on NEAR, and a `withdraw` command later sends winnings to any supported chain; Protocols may fund their own NEAR account from Base before posting. Both are mainnet-only extras, tested with small real amounts under Liam's yes, and the README says so. Choosing the payout chain at claim time was rejected: 1Click deposit addresses expire and the payout can be delayed by earlier claims or the MPC network, and an expired address "may lose funds", which would put a bridge inside the most security-critical step. Funding goes to the Protocol's own NEAR account, not straight to the bounty contract, which avoids 1Click's experimental `customRecipientMsg`.

## Consequences

- Protocols sign in with MetaMask: NEAR's Ethereum-wallet support (NEP-518) names their NEAR account after their 0x address and works on testnet and mainnet, so one wallet grants pause roles and posts. MetaMask can't bundle transactions, so posting takes two prompts. Safe multisigs can't sign in to NEAR, so pause grants also offer "copy for your multisig".
- A MetaMask-only Protocol still needs a little native NEAR for gas and the posting fee.
- An AI agent's claim key can't withdraw (R14.3): an agent can earn but never move winnings.
- Supersedes the "NEAR Intents" line in the spec's out-of-scope list.
