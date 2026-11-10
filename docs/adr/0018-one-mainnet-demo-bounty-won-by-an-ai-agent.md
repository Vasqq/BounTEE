# One mainnet demo bounty, won by an AI agent with a claim key

ADR-0017 makes every demonstrated proof a mainnet transaction. A bounty pays once and pauses its vault, so each winning run costs a fresh bounty. We first planned two mainnet bounties: one won by a person through the command-line tool, one by an AI agent. But a Whitehat is a person, an AI agent, or a person using AI, and all of them run the same commands to the same outcome (ADR-0007); only their authority differs. The security track asks for AI with money but without the keys to everything, and its hints include function-call keys. A person's claim with a full-access key shows none of that. So there is one demo bounty and one story: an independent AI agent finds the bug and wins with a claim key. The cheat claim that scores zero is filed on the same bounty before the win. One run proves R3.10, R4.11 and R14.6, and the landing page, the video and the README tell that one story, adding only that a person runs the same commands with their own key.

## Considered Options

- **Two bounties, a person's and an agent's:** two stories competing on the landing page, twice the mainnet runs before the deadline, and the person's run proves nothing the agent's doesn't.
- **A reserve bounty kept for a failed agent run:** a second path to explain. A failed run is a bug: find its cause, fix it and rerun on a fresh instance.
- **Live Damn Vulnerable DeFi bounties:** they show the judge isn't tuned to our demo, which `bountee test` on each level already shows offline with no keys or funds; posting them would add stories and spend for a pause the demo bounty already proves. They stay offline judge scenarios.
- **A live "try to break it" bounty for judges:** on mainnet it needs a funded NEAR account, which breaks the no-keys, no-funds path. The cheat claim is a mainnet transaction on the demo bounty and re-runs offline.

## Consequences

- The demo bounty must be won by Tue Nov 10: publication follows a disclosure delay of at least a day, so the landing story reaches "published" by feature freeze on Nov 11, before the video on Nov 12.
- The video records the mainnet run itself; there is no second winning take.
- The demo vault holds real USDC on mainnet (2 on Base, the proof chain; 1 on Arbitrum), funded minutes before the claims, since anyone can drain it. The bounty is 10 USDC and the minimum theft 1 USDC. The asset named on screen is the asset the replay measures.
- Spend stays within ADR-0004's $50: about $23 for the deployment (the contract's locked storage and the judge's upload), about $6 for the bounty and about $1 for the NEAR Intents extras. The bounty amount and claim balance return to our own accounts. A redeployment costs another $23, so mainnet is deployed only from a commit whose full run, the agent's included, has passed on testnet.
- Every mainnet transaction is listed and costed in one plan Liam approves before any of it runs (ADR-0004).
- Amends ADR-0004 (one bounty, the spend above) and ADR-0011 (no Damn Vulnerable DeFi level is posted live).

Amended by ADR-0019: the demo vault's bug is the Visor Finance class, which needs a purpose-built contract, after a drain bot emptied the first mainnet vaults seconds after funding.

Amended by ADR-0020: on a second mainnet deployment, the cheat claim is proven on Base, the winning claim on either chain, and the vault holds 2 USDC on each.
