# Build on testnet, run the final demo on mainnet with real money

The hackathon allows testnet-only entries, but we want the demo to move real money. All development and testing happens on testnets. Only the final build is deployed to mainnet: the bounty contract on NEAR once, a bounty funded with a few dollars of real USDC, and the demo protocol on two low-cost EVM mainnets. The README's evidence is those mainnet transactions, which Verifiers can check on public explorers without faucets, keys or funds. We don't iterate on mainnet because each deploy of a keyless NEAR contract permanently locks about $12–20 of storage deposit.

## Consequences

- Expected mainnet spend is about $25–35 of the $50 budget, leaving room for one redeploy.
- The demo protocol is deliberately vulnerable and holds real funds, so its balance stays at a few dollars and the window between funding it and the demo run stays short.
- Every mainnet transaction still needs Liam's explicit yes.

Amended by ADR-0018: one mainnet demo bounty, won by an AI agent; the expected spend is about $30 of the $50.

Amended by ADR-0020: a second mainnet deployment takes the spend past the $50.
