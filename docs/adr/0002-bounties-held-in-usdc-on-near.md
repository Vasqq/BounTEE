# Bounties are held in USDC by the bounty contract on NEAR

Covered contracts live on EVM chains, so a Protocol would naturally expect to fund its bounty there. We hold the bounty in USDC on NEAR instead, inside the same keyless bounty contract that holds the pause rights through Chain Signatures. Pausing every covered chain and then paying the Whitehat must be one decision under one rule that nobody controls; splitting the money across EVM chains would split that decision and need cross-chain coordination. USDC rather than NEAR because both Protocols and Whitehats think in dollars, and a volatile token they don't otherwise use is friction for both.

## Considered Options

- **NEAR tokens:** simplest to build, but forces a Base-native Protocol to hold a volatile token and makes the reward move with the price.
- **Escrow on each EVM chain:** familiar to Protocols, but separates paying from pausing and breaks "one rule pauses everything, then pays".
