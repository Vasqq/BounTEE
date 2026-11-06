# Every demonstrated proof is a mainnet transaction

ADR-0004 already put the final demo on mainnet, but ADR-0011 still listed mainnet as the last thing to cut, and several requirements named testnet as their proof. Testnet evidence for some claims and mainnet evidence for others would read as a red flag to judges. So BounTEE is mainnet-final. Everything the README, the landing page, the video or a Verifier is shown is a mainnet deployment or a mainnet transaction. That covers the deployed contract and judge, the agent's claim, the payout, the pauses and their verification, publication, `withdraw`, "Fund from Base" and the rebuilt hashes. Testnet is where we build and rehearse. Every live run happens there first, but no testnet transaction is cited as evidence.

## Consequences

- This replaces ADR-0011's last cut ("mainnet: fall back to testnet"). Mainnet is never cut. If time runs short, cut features, not the network.
- The judge pins RPCs for Base and Arbitrum One beside the Sepolia chains, and the mainnet build is the one the README's hashes name.
- Live-run requirements (method T at seam T, or A from a recorded run) are verified by a mainnet run. A passing testnet run is a rehearsal, recorded in the ticket's work but not in the README.
- Every mainnet transaction still needs Liam's explicit yes (ADR-0004). The budget grows past ADR-0004's estimate because the agent run and both chains' pauses now happen on mainnet too.
