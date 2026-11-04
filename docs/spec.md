# Spec: BounTEE

Final spec, Nov 4, 2026. The requirements it delivers are in [requirements.md](requirements.md), referenced by ID throughout; the vocabulary is [GLOSSARY.md](../GLOSSARY.md); the decisions are [docs/adr/](adr/) (0001–0015). Where this spec and requirements.md differ, requirements.md wins.

## Problem Statement

**Protocols.** A Protocol's security lead running a bug bounty spends their time triaging reports, most of which don't reproduce, and AI now writes them for free. Meanwhile AI agents have made working exploits cheap to find (about $1.22 per agent run in Anthropic's SCONE-bench), for whitehats and attackers alike. When a real exploit does arrive, the Protocol's contracts on every chain stay exposed until someone reads the report and acts, and the report itself is a public pointer to the bug.

**Whitehats.** A whitehat, or the AI agent they run, who finds a working exploit has to hand it over before being paid. After that they have no leverage: severity can be downgraded and payment disputed or delayed. Immunefi calls its mediation "a strong recommendation and not a final verdict"; programmes allow up to 30 business days to pay; cases on record include $50k offered against a $500k maximum.

## Solution

A Protocol signs in with the MetaMask wallet it already uses, grants BounTEE the pause role on each covered contract (which proves it controls them), and posts a bounty on NEAR: a fixed amount of USDC, a minimum theft, an end date, and the covered contracts on Base and Arbitrum.

A Whitehat runs `bountee init` (on testnet it creates and funds a NEAR account with no sign-up), writes an exploit as a Foundry script, tests it locally against the contracts as they are now with the exact rule that will judge it, and claims from the terminal. The exploit is sealed on their machine. OutLayer replays it inside an Intel TDX enclave against the proof chain's state at a recent block, which the claim proves and the enclave confirms. If fresh accounts walk away with at least the minimum theft taken from the covered contracts, NEAR Chain Signatures signs a pause for every covered contract on every chain, the Whitehat is paid the whole bounty in seconds, and the Protocol can open the exploit. Anyone can deliver the signed pauses; NEAR's MPC network then confirms each one landed, and the bounty contract records it on NEAR. After a disclosure delay the exploit is published, so anyone can re-run it.

Nobody holds a key to the bounty: not the Protocol, not the Whitehat, not us. Junk claims cost the Protocol nothing. An AI agent can claim with a key that can only file claims. Everything is checkable from public data, with no keys and no funds.

## User Stories

**Protocol (security lead)**

1. As a security lead, I want to see a finished bounty before posting, so that I know what posting commits me to.
2. As a security lead, I want to sign in with the MetaMask wallet I already use, and use it both to grant pause roles and to post, so that I never need a separate NEAR wallet.
3. As a security lead, I want to see each pause-role grant I still need to make, chain by chain, and send it from MetaMask, so that setup is clear and I know when I'm done.
4. As a security lead whose contracts are administered by a multisig, I want to copy each pause-role grant into it, so that I can grant from where our admin rights actually live.
5. As a security lead, I want to be told in plain words why each chain needs a few cents of pause gas, that nobody can take it back, and that nobody presses the pause button, so that I fund it without worry.
6. As a security lead, I want to be told exactly how much NEAR my account needs for fees and where to send it, so that a chain I've never used doesn't stop me.
7. As a security lead on mainnet, I want to fund my bounty with USDC from Base, so that I don't have to acquire USDC on NEAR first.
8. As a security lead, I want to set the covered contracts, proof chain, listed tokens and prices, bounty amount, minimum theft, end date and disclosure delay, and see them read back in plain English, so that I know exactly what pays.
9. As a security lead, I want to be told plainly which contracts can and can't be covered, so that I don't post a bounty that pays out for by-design behaviour.
10. As a first-time security lead, I want a plain "what you're risking" panel before I sign, so that I know the worst case before committing funds.
11. As a security lead, I want my exploit key to come from a MetaMask signature, so that there's no file to lose.
12. As a security lead, I want to pay the posting fee and deposit the bounty in two clear prompts, so that posting is quick.
13. As a security lead, I want posting refused if a pause-role grant or pause gas is missing, so that I can't post a broken bounty by mistake.
14. As a security lead, I want to keep operating and upgrading my contracts normally while a bounty is live, so that the bounty doesn't freeze my roadmap.
15. As a security lead, I want a bug I fix myself to stop being claimable 5 minutes after the fix lands, so that I only pay for bugs that are live.
16. As a security lead, I want to see how many claims have been checked on my bounty, so that I know it's being hunted.
17. As a security lead, I want junk and AI-written claims to cost me nothing, so that I never triage again.
18. As a security lead, I want my contracts paused on every chain the moment an exploit is proven, so that nobody can use the bug while I fix it.
19. As a security lead, I want to see each chain's pause as landed and then verified on NEAR, so that I know it really happened.
20. As a security lead, I want to open the winning exploit with a MetaMask signature as soon as the Whitehat is paid, so that I can fix the bug.
21. As a security lead, I want a warning when pause gas runs low, so that I can top it up before it matters.
22. As a security lead, I want to withdraw an unclaimed bounty after its end date, so that my funds aren't stuck.
23. As a security lead, I want to be sure nobody, including BounTEE's builders, can take the bounty or pause my contracts without a proven exploit, so that granting the pause role is safe.
24. As a security lead, I want the pause role to be able to pause and nothing else, so that a false verdict can at worst pause.

**Whitehat**

25. As a Whitehat, I want `bountee init` to give me a working NEAR account with no sign-up, so that I can start in one command.
26. As a Whitehat, I want to list bounties and read each one's rules, covered contracts and trusted parties, so that I know what pays before I hunt.
27. As a Whitehat, I want to write my exploit as a Foundry script, so that I use the tool I already know.
28. As a Whitehat, I want to test my exploit locally against the contracts as they are now and see the exact verdict before paying anything, so that I never pay to learn it scores zero.
29. As a Whitehat, I want to need no paid data service, so that claiming works with ordinary public RPCs.
30. As a Whitehat, I want to top up a small claim balance once, so that claiming is quick.
31. As a Whitehat, I want my exploit sealed on my machine, so that nobody can read it, copy it or claim it before I'm paid.
32. As a Whitehat, I want to follow my claim live (sealed, checking, verdict, then pauses signed, paid, and each chain landed and verified), so that I'm not left staring at a spinner for half a minute.
33. As a Whitehat, I want my tool to deliver the signed pauses automatically after a win, so that I don't have to.
34. As a Whitehat, I want to be paid the whole bounty in USDC to my NEAR account within seconds of a verified exploit, so that there's nothing to negotiate.
35. As a Whitehat, I want a receipt with the payout, attestation and pause links, so that I can prove what happened.
36. As a Whitehat, I want a failed claim to show only a coarse reason publicly and leave my exploit unrevealed, so that a near-miss doesn't leak my work.
37. As a Whitehat, I want to be paid even if the Protocol revoked the pause role, the contract was already paused, or the pause gas ran out, so that a Protocol can't dodge a valid payout.
38. As a Whitehat, I want a Protocol fix made after my claim's block not to affect my claim, so that a Protocol can't dodge payment by racing a fix.
39. As a Whitehat, I want the first valid claim to win and a copied claim to be refused, so that nobody can steal my finding.
40. As a Whitehat, I want to never need an EVM wallet or EVM funds, so that I can win a Base Protocol's bounty without touching Base.
41. As a Whitehat, I want to withdraw what's left of my claim balance, so that unused funds come back.
42. As a Whitehat on mainnet, I want to send my winnings to an address on the chain I use, whenever I choose, so that I'm not stuck holding USDC on NEAR.

**AI agent**

43. As a Whitehat, I want to give my AI agent a claim key that can only file claims, so that it can work without holding my money keys.
44. As a Whitehat, I want to see exactly what a claim key can and can't do and revoke it with one command, so that I stay in control.
45. As an AI agent, I want `bountee init` and an instructions file that teaches me BounTEE, so that I can claim with no human help.
46. As an AI agent, I want every command to have machine-readable output, so that I can act on results.
47. As an AI agent, I want to claim exactly as a person does, so that there's no special path to get wrong.

**Verifier (judges, the AI screen, a Protocol's community)**

48. As a Verifier, I want the landing page to show a finished bounty as a story with real transaction links and no wallet, so that I see the product work in seconds.
49. As a Verifier, I want to run `bountee test` on a demo exploit offline, with no RPC, keys or funds, so that I can see the judge work in one command.
50. As a Verifier, I want a Verify section on every bounty with each check passing, failing or not yet published, so that I can trust BounTEE without trusting its builders.
51. As a Verifier, I want to check the enclave's attestation against Intel's certificates, so that I know the right program judged the claim.
52. As a Verifier, I want to rebuild the bounty contract and the judge from the repo and get the hashes that ran, so that I know the judge is the published code.
53. As a Verifier, I want to re-run a published exploit locally and get the same verdict, so that I trust nobody, not even Intel.
54. As a Verifier, I want "paused ✓" to be a fact recorded on NEAR, not just the page's word, so that the circuit breaker is provable.
55. As a Verifier, I want to press "Send pause" on any signed pause that hasn't landed, without a wallet, so that delivery never depends on one person.
56. As a Verifier, I want to run the judge's scenario tests offline with no keys or funds, so that I can check the payout rule myself.
57. As a Verifier, I want every README step to have a command and an expected output, so that I can follow it from a clean checkout.
58. As a Verifier, I want the README to name every trusted party and what each could do, so that the trust boundary is explicit.

**Depositor**

59. As a Depositor in a covered Protocol, I want a pause to be the worst a false verdict can do, so that my funds are never moved by BounTEE.

## Implementation Decisions

**Modules**

- **The judge.** One Rust program embedding revm, compiled once to WebAssembly and run unchanged by OutLayer in the enclave and locally under a WebAssembly runtime by the command-line tool. One build, so one attested hash. Three actions:
  - *judge a claim:* inputs are the bounty's rules, the claim's block, its state proofs (including absence proofs), the Whitehat's account and the sealed exploit (read through OutLayer's secrets). It checks the job's caller is the bounty contract and the account sealed inside the exploit matches the Whitehat's; asks the three independent RPCs pinned in its build for that chain (never from the claim or the Protocol) for the hash of the claim's block number, accepting it only when at least two answer and all match, and takes the state root from that block's header; returns INVALID if at least two agree on a different hash, or the block's timestamp is more than 5 minutes before the claim's submission time (which the bounty contract records and passes in) or after it (R2.8); fails the job with no verdict on any other outcome, such as too few answers or answers that disagree (R2.6); verifies every proof against that state root; replays the exploit from fresh accounts with the seed; scores it by the payout rule (R3.8, R4.1–R4.10); and returns PAYS, ZERO or INVALID with one coarse reason. Reads of unproven state end as INVALID.
  - *posting check:* on every covered chain, simulates `pause()` from the bounty's pause-role address, which proves the role is granted (R12.1) and the contract can be paused (R12.2), and checks the pause-role address holds enough gas for its signed pause (R7.6). It reads each chain through the same RPCs pinned in the judge's build, and fails unless at least two answer and agree (R12.5).
  - *release:* after a payout, re-encrypts the exploit to the Protocol's exploit key; after the disclosure delay, outputs it for publication together with the claim's block header and proofs, so anyone can re-run it to the same verdict at any time (R6.1, D7, D7.1).
  - Confirmation and replay are separate steps. In the enclave the judge always runs both; local runs (`test`, `verify`, a published exploit's re-run, the offline demo tests) replay against a recorded block header and its proofs, checking the header's hash, without RPC confirmation (R2.9). The bounty contract only ever requests the full enclave mode.
  - Contains nothing specific to any exploit, contract or bounty (D11).
- **The bounty contract.** A Rust NEAR contract with no access keys after deployment, holding many bounties. The judge's build hash is fixed at deployment, so no Protocol or claim can choose the program that opens sealed exploits or the RPCs it trusts (R1.3).
  - Post: two transactions signed in two wallet prompts: the posting fee in NEAR (posting check, storage, release and publication jobs, and each chain's pause verification; not refunded if the posting is refused), then the bounty amount as a USDC transfer-and-call carrying the rules. The rules include the Protocol's exploit public key. The bounty is live only once the posting check passes; if it fails, the USDC is refunded in full and the posting fee is not (R1.6, R11.4). A Protocol can't reuse a bounty name (D25).
  - Claim: the sealed exploit, the claim's block (number and hash), its header and proofs; the replay fee and the sealed exploit's storage deposit are drawn from the Whitehat's claim balance (R11.1), and the contract records the claim's submission time, which a retry keeps. It requests each claim's OutLayer job as soon as the claim is submitted, so judging never waits behind other claims (R11.2), and accepts verdicts only from OutLayer's contract. A job that fails or can't confirm the block leaves the claim pending in its place for a retry (R2.6).
  - On PAYS: wait for every earlier-submitted claim to resolve (R3.6); request a pause signature per covered contract from NEAR Chain Signatures and check each recovers to that chain's pause-role address; store them; pay the bounty (registering the recipient with USDC if needed); request the release job. The payout never depends on a pause landing or being verified (R7.11).
  - Verify a pause: anyone may ask; the contract computes the transaction hash from the signed pause it stored (never taking one from the caller), calls NEAR's MPC foreign-chain transaction verification, and records a verified pause only if that transaction succeeded. The posting fee funds up to three attempts per chain; further requests pay their own cost (R7.10).
  - Also: top up and withdraw claim balance; withdraw an unclaimed bounty; trigger publication; retry pause signing; read views for bounties, claims, stored signed pauses and verified pauses.
  - Each bounty's pause-role address per chain is derived from the contract's account and a per-bounty path built from the Protocol's account and the bounty's name, so it can be computed before posting.
  - Sealed exploits are stored as OutLayer secrets owned by the contract, readable only by the pinned build in jobs the contract requests (ADR-0012); the storage deposit comes from the claim balance.
  - It never spends its own balance on any bounty's or claim's costs. Only one live bounty per covered contract.
- **The command-line tool.** TypeScript on Node. Commands: `init`, list, show, test, claim, status, broadcast, verify, balance (top up, withdraw), key (add, revoke), open-exploit, withdraw (mainnet only, through NEAR Intents' 1Click), and post (the terminal fallback in the cut order). Every command has a machine-readable output mode.
  - `init` creates a local NEAR account; on testnet it is funded by NEAR's faucet service with no sign-up (D18); on mainnet it states how much NEAR to add and where.
  - `test` and `claim` run the Whitehat's Foundry script against a local fork of the proof chain at a recent block, record every account and storage slot the replay reads, fetch their proofs and absence proofs from an ordinary RPC, then run the judge locally. On a demo bounty, `test` uses the proofs committed in the repo and runs offline (D19).
  - `claim` seals the exploit, binding the Whitehat's account, submits it, shows its progress live (D23), and on PAYS broadcasts every signed pause together, requests each pause's verification once its chain reports it final (R7.3), and gives a receipt (D24).
  - `verify` runs the verification layers with no keys or funds.
- **The web app.** Next.js on Vercel. Pages: landing (the finished demo bounty as a story), bounty list, bounty page, posting flow, open-exploit. Everything shown is read live from the chains and OutLayer's attestation API; the public page never shows a claim in progress.
  - Bounty page: state; rules in plain English; what doesn't pay; the number of claims judged (D22); each chain's pause as signed, landed, then verified, with a "Send pause" button for any signed pause that hasn't landed, needing no wallet (R7.9); a warning when any chain's pause gas is below what its signed pause needs (D8); Verify. Public states after the live period read "Ended, unclaimed" and "Withdrawn". After a win, the open-exploit page notes that unpausing is up to the Protocol's own governance.
  - Landing story order: posted → sealed → checked → pauses signed → paid → landed per chain → verified per chain → published (D4).
  - Posting flow: sign in with MetaMask, which also signs NEAR transactions as the Protocol's `0x…` NEAR account through NEAR's Ethereum-wallet support; the grants checklist with "copy for your multisig"; pause gas, with the plain explanation in D5; "add a little NEAR"; on mainnet, "Fund from Base" through 1Click to the Protocol's own NEAR account; the rules; the "what you're risking" panel; one signature to derive the exploit key, whose public key goes into the rules (D20); then two prompts to post.
- **The demo contracts.** Solidity with Foundry, deployed on Base and Arbitrum. The main demo vault holds USDC and has a missing access check modelled on the DEPUSDT/LEVUSDC hack of June 2023. Damn Vulnerable DeFi v4's Truster, Side Entrance and Puppet (MIT) are adapted with a standard pause and each posted, exploited, paused and paid as an extra bounty on testnet; Puppet's lending pool is covered and its Uniswap pool is a dependency. The same levels, unmodified, are judge scenarios (R4.10). On all of them the pause role can only pause, and every function the exploit goes through refuses to run while paused. Each demo exploit ships with its block header and proofs committed at a fixed block. A script deploys a fresh demo instance (contracts on each chain, pause-role grants, pause gas) and posts its bounty, because each win closes its bounty and pauses its vault; every winning run (Day-3, demo-ready, the video, the recorded agent run, mainnet) uses a new instance (D21). Stretch (in the cut order): one real historical hack from DeFiHackLabs (Apache-2.0), replayed locally from the pre-hack block. Ethernaut levels (AGPL-3.0) are not used.
- **The instructions file** for coding agents, describing BounTEE and the command-line tool well enough for an ordinary agent to `init`, find and claim the demo bug.
- **The README** and its step checker. Required sections: what it is and who it's for; the problem; the NEAR features doing the work and the transactions backing them (R13.1); "do X → see Y" steps from a clean checkout, starting with the no-keys, no-funds path (`test` on a demo, `verify`), and never offering a live winning claim as a judge step (D21); deployed accounts, addresses and demo transactions with explorer links; the threat model (every trusted party and what each could do, what counts as an exploit, the measured verdict-to-pause window, the 5-minute recency window, and the stated limits: R7.8, R15.5, R15.7; "paused ✓" is worded as "the pause transaction succeeded on that chain, as verified by NEAR's MPC network", not as a claim about the contract's code); the coverage limit (R4.12); similar projects (HoneyPause, Sealed-Glass Proofs and AntiSoon, one difference each, with no claim to be first); a "Not production-ready" list next to "Verify it"; disclosures. A script runs every "do X → see Y" step and checks its expected output (R15.4).

**Decisions carried from the ADRs**

- Sealed and paused first, no patch window; pauses signed before payout and broadcast together; the payout doesn't wait for them (ADR-0001).
- USDC on NEAR, held by the keyless bounty contract (ADR-0002).
- Every bounty includes the pause; granting it proves control (ADR-0003).
- Build on testnet; the final demo on mainnet with a few dollars; every mainnet transaction needs Liam's yes (ADR-0004).
- Open payouts, no KYC (ADR-0005).
- One payout rule: theft from the covered contracts; one bounty amount and one minimum theft (ADR-0006).
- A prepaid claim balance for Whitehats and a prepaid posting fee for Protocols, so the keyless contract never pays anyone's costs (ADR-0007).
- Winning exploits published after a 1–90-day disclosure delay (ADR-0008).
- One proof chain per bounty (ADR-0009).
- Trust in OutLayer stated, not removed (ADR-0010).
- The cut order keeps the circuit breaker (ADR-0011).
- Sealed exploits readable only in jobs the bounty contract requests (ADR-0012).
- NEAR Intents only at the edges and only on mainnet; MetaMask sign-in for Protocols (ADR-0013).
- Claims judged against recent state, not a snapshot committed at posting (ADR-0014).
- Pauses delivered by anyone and verified on NEAR; demo chains Base and Arbitrum; no hosted watcher (ADR-0015).

**External contracts and services**

- OutLayer: `outlayer.testnet` / `outlayer.near`; jobs requested with explicit resource limits; attestations looked up by task id, never request id.
- NEAR Chain Signatures and foreign-chain verification: `v1.signer-prod.testnet` / `v1.signer` (both list Base and Arbitrum as verifiable chains, checked Nov 4).
- NEAR Intents 1Click (mainnet only): `withdraw` and "Fund from Base".
- Ordinary public RPCs serve recent-state proofs on Base Sepolia, Arbitrum Sepolia and Arbitrum (checked Nov 4; Arbitrum's already refuse state 2,000 blocks old). Base mainnet's public RPC failed once on the very latest block, so claims use a block a few seconds old.

## Testing Decisions

- Tests verify requirements, not code. Every test names the requirement IDs it proves; every LLR has a verification; status comes from evidence, as requirements.md's "How to read the tables" defines it. Tickets list the requirement IDs they implement; commits name their ticket.
- Tests follow Matt Pocock's `/tdd`: behaviour through public interfaces at the agreed seams, written red-then-green while each ticket is built. No tests of internals, no tautological tests.
- Seams: J (the judge, the same compiled build the enclave runs, including its posting check, run locally and offline from committed block headers and proofs, with no keys or funds), C (the bounty contract in a local NEAR sandbox, with stand-ins for OutLayer and the MPC network, including its foreign-chain verification; the stand-ins answer with success and failure alike, including failures testnet can't trigger at will, live only in the test folder and are named as test stand-ins), T (the command-line tool, driven by committed scripts on testnet, chain state read back with `cast` and NEAR RPC), W (the web app, driven by committed Playwright specs in a browser), E (the demo contracts with Foundry).
- That the real services behave as the seam C stand-ins assume is proven at seam T (R3.10, R4.11, R7.4, R7.10). Mainnet-only features (D12, D16) are verified by a recorded mainnet run under Liam's yes.
- The full two-chain run happens at the Day-3 checkpoint, at demo-ready and before the video; day to day uses J, C and T on one chain; a setup script reports every balance a run needs and stops before starting, naming what to top up, if any would run dry. One mainnet pass of the end-to-end tests runs before the demo, with Liam's yes.
- The repo is greenfield; there is no prior art in it.

## Out of Scope

- Pre-launch code with nothing live to pause.
- Covering contracts that pay callers by design (AMM pools, lending with liquidations, keeper rewards).
- Bugs where nobody profits (freezing, denial of service, insolvency), protocol-written invariants, multi-block or time-dependent attacks, attacks needing a victim's later transaction, theft of users' approvals.
- Bugs that exist only in one chain's configuration.
- More than one payout per bounty, payout tiers or scaling by funds at risk, top-ups.
- Non-EVM chains (including Solana) and EVM chains the MPC network can't verify (including Flare and Ethereum).
- A hosted watcher.
- KYC'd payouts, sponsored claims, a web claim screen (unless the Day-3 checkpoint passes with time to spare).
- A bug-finding AI agent of our own; NEAR AI Cloud; NEAR Intents anywhere except the mainnet-only `withdraw` and "Fund from Base"; choosing the payout chain at claim time.
- Accounts, profiles, notifications, leaderboards, search, editing a bounty, dispute screens.
- Insider fraud (a Protocol member planting and claiming a bug), as on any bounty platform; the README's threat model says so.
- Verifying the TDX quote inside the bounty contract.

## Further Notes

- **Dates (UTC):** Day-3 checkpoint Fri Nov 6: the core loop on one testnet chain from a clean checkout (post, claim with a real exploit carrying its own recent-state proofs, theft rule in the enclave, test-USDC payout to a fresh account, pause), plus the sealing spike, including a copied exploit sent straight to OutLayer being refused. Demo-ready Sun Nov 8. Feature freeze Wed Nov 11. Submission Fri Nov 13; Nov 14, 23:59 is the hard close.
- **Cut order** (ADR-0011): "Fund from Base"; the historical hack replay; all but one Damn Vulnerable DeFi bounty; `withdraw` to another chain; the web posting flow; mainnet. Never cut: sealing, the theft rule, the pause on Base and Arbitrum, the keyless payout, the landing story, Verify, the claim key. Fallbacks: committed snapshots (the tests 3–5 pattern: the whole snapshot committed by hash at posting, no chain proofs, the Protocol named as trusted for it matching the chain) if recent-state claims slip; "landed" with an explorer link if pause verification slips.
- **To prove in the first spikes**, each with its fallback:
  - Calling `verify_foreign_transaction` from the bounty contract on testnet: the request format, cost and time to "verified". Fallback: "landed" only.
  - How OutLayer exposes a job's caller to the program, and whether its secret access rules can name the bounty contract as the only caller. Fallback: the README names the secret's owner as trusted.
  - Whether OutLayer jobs have outbound network access, and for which WebAssembly target; the judge's claim and posting checks need it. The judge stays one build: if network access needs a newer target, the whole judge moves to it. Fallback: committed snapshots for claims, and the Protocol's client named as trusted for the posting check.
  - Whether a claim's proofs fit OutLayer's and NEAR's input limits. Fallback: committed snapshots.
  - Whether a USDC transfer-and-call signed through NEAR's Ethereum-wallet support leaves enough gas for the posting check's OutLayer request (testnet), and whether 1Click delivers to a `0x…` NEAR account not yet registered with USDC (mainnet).
  - Arbitrum Sepolia test-ETH access (likely a faucet login for Liam).
- **Open: the judge journey.** Judges include AI agents (the Claude Code and Codex screen), which will behave like Whitehats' agents, so their path through BounTEE gets its own design pass later. Known so far: `test` offline and `verify` need no keys or funds, and no live winning claim is offered. Undecided: a live "try to break it" testnet bounty on a vault with no known bug, so a judge can file the bundled cheat claim and watch it score zero.
- **Unconfirmed, so not relied on:** whether 1Click can deliver native NEAR.
- **Facts to verify before the README claims them:** that USDC's issuer can freeze sanctioned accounts on NEAR; the measured verdict-to-pause and verdict-to-verified times; every number and link.
- **Disclosures for the README:** Damn Vulnerable DeFi (MIT) adaptations, crediting the source and stating the modification; libraries; AI-written code; the Gauntlet's test runs (Oct 31–Nov 2).
- **Tracks:** security and privacy; privacy stays only while sealing ships.
- **Standing rules:** testnet transactions without asking; every push, mainnet action, publication and submission needs Liam's explicit yes; no secrets in the repo.
