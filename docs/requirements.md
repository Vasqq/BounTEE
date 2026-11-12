# Requirements

The high-level requirements (HLRs) are R1–R15 from section 2 of [project-context.md](../project-context.md), which stays unedited. Each is restated below in requirement language and broken down into low-level requirements (LLRs) small enough to verify one at a time. Terms are defined in [GLOSSARY.md](../GLOSSARY.md); decisions are in [docs/adr/](adr/). The testing method is in [spec.md's Testing Decisions](spec.md#testing-decisions).

Drafted Nov 3, 2026, from the grilling session.

## Requirement language

The key words "MUST", "MUST NOT", "REQUIRED", "SHALL", "SHALL NOT", "SHOULD", "SHOULD NOT", "RECOMMENDED", "NOT RECOMMENDED", "MAY", and "OPTIONAL" in this document are to be interpreted as described in BCP 14 [RFC 2119] [RFC 8174] when, and only when, they appear in all capitals, as shown here.

This document uses SHALL and SHALL NOT for every requirement. A SHOULD or MAY can't be verified pass or fail, so none is used. Each requirement names the part of the system it binds:

- **the bounty contract:** the keyless NEAR contract that holds bounties;
- **the judge:** the judging program, run in the enclave and locally, including its posting check;
- **the command-line tool**;
- **the web app**;
- **the demo contracts:** the demo protocol's EVM contracts;
- **the README**.

## How to read the tables

- **ID:** `R<hlr>.<n>` for an LLR under an HLR; `D<n>` for a derived requirement (one that comes from a design decision, not from R1–R15). A derived requirement's **From** column names the ADR or the spec that made the decision.
- Each LLR states behaviour observable at its seam, never how the code achieves it.
- **Seam:** where it's verified.
  - **J:** the judge, run locally (the same compiled program the enclave runs).
  - **C:** the bounty contract's public actions on NEAR.
  - **T:** the command-line tool, driven from the terminal, with chain state read back (`cast`, NEAR RPC).
  - **W:** the web app, driven in a browser.
  - **E:** the demo contracts.
- **Method:** **T** test, **I** inspection (a recorded review of an artefact), **A** analysis (a recorded measurement or argument). "T, I" means both are needed: a test for the behaviour and an inspection that no other path exists.
- An LLR is **verified** when its tests pass, or its inspection or analysis is recorded. An HLR is **done** when all its LLRs are verified.
- **Mainnet is the evidence (ADR-0017).** An LLR verified by a live run (seam T against real services, or an analysis of a recorded run) is verified by a mainnet run. Testnet runs come first as rehearsals and are never cited as evidence.

## R1 · The rules are fixed when the bounty is posted

**HLR:** A bounty's rules SHALL be fixed when it is posted: what is tested, which judging program judges it, what counts as a loss, the payout and the chains to pause.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R1.1 | When a bounty is posted, the bounty contract SHALL record its covered contracts (chain and address), recency limit (fixed at 5 minutes by BounTEE, not a Protocol setting), listed tokens (each with its chain and posting price), seed (set by BounTEE, not a Protocol setting), bounty amount, minimum theft, end date, disclosure delay, the Protocol's exploit public key, and the judge's build hash (the one pinned in the bounty contract at deployment). | C | T |
| R1.2 | The bounty contract SHALL return every recorded rule unchanged for the bounty's whole life, and SHALL NOT provide any action that changes a recorded rule. | C | T, I |
| R1.3 | The bounty contract SHALL fix the judge's build hash at deployment and SHALL refuse a posting that names any other judge build. Neither a Protocol nor a claim SHALL choose the judge build or its pinned RPCs. | C | T |
| R1.4 | The bounty contract SHALL refuse a posting with a missing or invalid rule: a minimum theft not above zero, an end date not in the future, a disclosure delay outside 1–90 days, no covered contract, no listed token, a listed token on a chain the bounty covers no contract on, or a covered chain with no listed token. | C | T |
| R1.5 | The bounty contract SHALL refuse a posting unless the full bounty amount in USDC arrives with it, and SHALL NOT accept funds for a bounty after it is posted. | C | T |
| R1.6 | If the posting check fails, the bounty contract SHALL refund the bounty amount in full to the Protocol. | C | T |

*Sharpened by grilling:* one bounty amount and one minimum theft replace payout tiers (ADR-0006).

## R2 · Nobody can move the bounty, block a valid payout or force an invalid one

**HLR:** No party, including the Protocol, the Whitehat and BounTEE's builders, SHALL be able to move a bounty's funds, block a valid payout, or force an invalid one.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R2.1 | The bounty contract's account SHALL hold no access keys after deployment. | C | T |
| R2.2 | The bounty contract SHALL accept a verdict only from OutLayer's contract, and SHALL refuse one from any other caller. | C | T |
| R2.3 | The bounty contract SHALL release bounty funds only as a payout on a PAYS verdict, or as the posting Protocol's withdrawal after the end date when no payout was made. It SHALL NOT provide any other action that moves bounty funds. | C | T, I |
| R2.4 | The bounty contract SHALL pay a PAYS verdict once every pause is signed, whether or not any pause lands, including when the Protocol has revoked the pause role, the covered contract is already paused, or the pause gas has run out. | C | T |
| R2.5 | If pause signing fails or times out, the bounty contract SHALL keep the claim pending, retryable and in its place, and SHALL NOT pay it until every pause is signed. | C | T |
| R2.6 | If an enclave job fails, times out, or can't confirm the claim's block (too few RPC answers, or answers that disagree with each other), the bounty contract SHALL keep the claim pending in its place with no verdict, SHALL NOT move bounty funds, and SHALL let the Whitehat retry it. A retry keeps the claim's original submission time. | C | T |
| R2.7 | The bounty contract SHALL complete a payout to a Whitehat whose account isn't yet registered to hold USDC. | C | T |
| R2.8 | In the enclave, the judge SHALL ask the three independent RPCs pinned in its build for the claim's proof chain (D1) for the hash of the claim's block number. It SHALL accept the block only when at least two answer and every answer matches the claim's hash. It SHALL return INVALID when at least two agree on a different hash, or when the block's timestamp is more than 5 minutes before the claim's submission time (recorded by the bounty contract and passed in by it) or after that submission time. Any other outcome fails the job with no verdict (R2.6). It SHALL NOT take RPC addresses from a claim or a Protocol. (ADR-0014) | J | T |
| R2.9 | The judge's local runs (`test`, `verify`, a published exploit's re-run, the offline demo tests) SHALL replay against a recorded block header and its proofs, checking the header's hash, without RPC confirmation; the bounty contract SHALL request only the full enclave mode. | J, C | T |

## R3 · Pay only for a verified exploit that reaches the minimum theft, and never twice

**HLR:** A bounty SHALL pay only for a verified exploit whose score reaches the minimum theft. Harmless, below-minimum, malformed and repeated claims SHALL pay nothing, and no bounty SHALL pay twice.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R3.1 | The bounty contract SHALL pay a claim only on a PAYS verdict. | C | T |
| R3.2 | The bounty contract SHALL pay a winning claim the whole bounty amount. | C | T |
| R3.3 | On a ZERO or INVALID verdict, the bounty contract SHALL NOT move any funds and SHALL NOT request any pause signature. | C | T |
| R3.4 | After a payout, the bounty contract SHALL close the bounty and SHALL refuse every later claim without replaying it. | C | T |
| R3.5 | The bounty contract SHALL NOT judge the same sealed exploit to a verdict more than once. A job that fails without a verdict (R2.6) doesn't count. | C | T |
| R3.6 | The bounty contract SHALL NOT pay a PAYS verdict while any earlier-submitted claim on the same bounty is unresolved. When two claims both score PAYS, it SHALL pay the earlier submission and refuse the later, even if the later verdict arrives first. | C | T |
| R3.7 | The bounty contract SHALL refuse claims submitted after the end date. | C | T |
| R3.8 | The judge SHALL compute the score as the smaller of gain and loss, and SHALL set the score to zero when either gain or loss is zero or negative. Gain SHALL be the value of the attacker holdings (R4.8) at the end of the replay minus the value of the seed (R4.7). Loss SHALL be the value of the holdings of the covered contracts on the claim's proof chain (D1) in the state at the claim's block minus the value of their holdings at the end of the replay. A value SHALL be the sum, over the listed tokens on the claim's proof chain, of each token's amount held times its posting price (R4.9). The proof chain's native coin SHALL count only when it is a listed token on that chain, valued by account balance. Prices SHALL be per smallest unit of the token, and all value arithmetic SHALL be exact integer arithmetic. For a replay not ended as INVALID, it SHALL return PAYS when the score is equal to or greater than the minimum theft, and ZERO when the score is below it. | J | T |
| R3.9 | Given the same block header, proofs, exploit and rules, the judge SHALL always return the same verdict and output. (That the enclave agrees with the local run is D2.) | J | T |
| R3.10 | A real exploit of the demo protocol, claimed on mainnet through the command-line tool, SHALL be paid exactly once, end to end. | T | T |
| R3.11 | The judge SHALL return INVALID for a malformed exploit. | J | T |
| R3.12 | The bounty contract SHALL refuse claims on a bounty whose posting check hasn't passed. | C | T |
| R3.13 | After a ZERO or INVALID verdict, the bounty contract SHALL keep the bounty open to further claims, including a new claim from the same Whitehat. | C | T |

*Sharpened by grilling:* "meets the tier" becomes "reaches the minimum theft" (ADR-0006).

## R4 · Only theft counts

**HLR:** Only theft from the covered contracts SHALL score as an exploit. A depositor withdrawing their own funds, an owner rescuing funds, a sweep anyone may call, and a bundle that impersonates the owner SHALL NOT score.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R4.1 | The judge SHALL return INVALID for an exploit with any transaction sent by an account that exists in the state at the claim's block. | J | T |
| R4.2 | The judge SHALL score zero for fresh accounts that deposit into a covered contract and withdraw no more than they deposited. | J | T |
| R4.3 | The judge SHALL score zero for an exploit that moves covered funds only to addresses that aren't attacker holdings, such as a sweep to the treasury. | J | T |
| R4.4 | The judge SHALL score zero for value taken only from dependencies and not from covered contracts. | J | T |
| R4.5 | The judge SHALL return INVALID for an exploit that reads any account or storage slot not proven against the state root of the claim's block. It SHALL treat an account or storage slot as absent or empty only on a proof of its absence against that state root, and SHALL NOT require a proof for an account or storage slot created during the replay. | J | T |
| R4.6 | The judge SHALL score zero for every randomized sequence of the demo protocol's honest actions by fresh accounts. | J | T |
| R4.7 | The judge SHALL start every replay with the fresh accounts holding exactly the seed recorded in the bounty's rules (R1.1), and SHALL subtract the seed before scoring, so fresh accounts holding only their seed score zero. | J | T |
| R4.8 | The judge SHALL treat as attacker holdings the fresh accounts plus every contract they create during the replay, and nothing else, so value held at the end by contracts the fresh accounts created counts as gain. | J | T |
| R4.9 | The judge SHALL value only listed tokens, at posting prices, and SHALL NOT let anything read during the replay change any value. | J | T |
| R4.10 | The judge SHALL return the expected outcome for every scenario in the R4.10 scenario table below that names R4.10, including ZERO for each out-of-scope scenario. Multi-block attacks can't be expressed as one exploit, so they have no test. | J | T |
| R4.11 | A cheat claimed on mainnet through the command-line tool (a deposit-then-withdraw by a fresh account) SHALL score zero and SHALL NOT move any funds, end to end. | T | T |
| R4.12 | The README and the web app's posting flow SHALL state the coverage limit: only contracts that pay nothing to callers by design may be covered. | W | I |

**R4.10 scenario table.** Each row is an exploit and the outcome it SHALL produce. Rows that name R4.10 are verified by R4.10; the others are verified by the requirement named. Rows 22–24 apply only to the Damn Vulnerable DeFi levels kept under the cut order (ADR-0011).

| # | Scenario | Expected outcome | Requirement |
|---|---|---|---|
| 1 | A depositor withdraws their own funds: fresh accounts deposit, then withdraw no more than they deposited | ZERO | R4.10, R4.2 |
| 2a | An owner rescue attempted by a fresh account | ZERO (fresh accounts hold no roles) | R4.10 |
| 2b | A bundle impersonating the owner | INVALID | R4.10, R4.1 |
| 3 | A public sweep of covered funds to the treasury | ZERO (loss, but no gain) | R4.10, R4.3 |
| 4 | An ordinary swap in a dependency pool | ZERO | R4.10, R4.4 |
| 5 | A liquidation bonus from a dependency (out of scope as a covered contract, R4.12) | ZERO | R4.10 |
| 6 | Arbitrage of a mispriced dependency pool (out of scope as a covered contract, R4.12) | ZERO | R4.10 |
| 7 | A flash loan from a dependency, repaid in the same bundle | ZERO | R4.10 |
| 8 | A reentrancy drain of a covered contract, proceeds swept to a fresh account | PAYS | R4.10 |
| 9 | The same drain, proceeds left in a contract the fresh accounts created | PAYS | R4.10, R4.8 |
| 10 | A read of an account, and of a storage slot, that the claim doesn't prove | INVALID | R4.10, R4.5 |
| 11a | An unlimited mint, not sold (out of scope) | ZERO | R4.10 |
| 11b | A mint, then swapped into a covered vault for listed tokens | PAYS | R4.10 |
| 11c | A mint, then sold into an uncovered pool | ZERO | R4.10, R4.4 |
| 12 | An attack needing time to pass or several blocks (out of scope) | No test: it can't be expressed as one exploit | n/a |
| 13 | Theft of users' approvals from their own wallets (out of scope) | ZERO | R4.10 |
| 14 | A permanent freeze or denial of service (out of scope) | ZERO | R4.10 |
| 15 | An attack needing a victim's later transaction (out of scope) | ZERO | R4.10 |
| 16 | A bug the Protocol fixed before the claim's block | ZERO; a fix after the claim's block doesn't change the claim's verdict | R4.10 |
| 17 | Two Whitehats claim the same bug | The earlier submission is paid; the later is refused and never revealed | R3.6, R5.6 |
| 18 | A winning claim | Every covered contract on every chain is paused | R7.1 |
| 19 | A claim block the independent RPCs don't confirm, or older than the recency limit | INVALID | R2.8 |
| 20 | A proof that doesn't match the claim's block | INVALID | R4.10, R4.5 |
| 21 | A missing access check (modelled on the DEPUSDT/LEVUSDC hack of June 2023) | PAYS | R4.10 |
| 22 | Damn Vulnerable DeFi v4 Truster, unmodified, its pool covered | PAYS | R4.10 |
| 23 | Damn Vulnerable DeFi v4 Side Entrance, unmodified, its pool covered | PAYS | R4.10 |
| 24 | Damn Vulnerable DeFi v4 Puppet, unmodified, its lending pool covered and its Uniswap pool a dependency | PAYS | R4.10 |
| 25 | A drain whose score equals the minimum theft | PAYS | R4.10, R3.8 |
| 26 | A drain whose score is just below the minimum theft | ZERO | R4.10, R3.8 |

## R5 · The exploit stays sealed

**HLR:** A Whitehat's exploit SHALL stay sealed: no one SHALL be able to read it before the payout, and failed attempts SHALL NOT be revealed.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R5.1 | The command-line tool SHALL seal the exploit on the Whitehat's machine and SHALL NOT send a plaintext exploit anywhere. | T | T |
| R5.2 | The judge SHALL open a sealed exploit only in a job the bounty contract requests, and SHALL refuse a direct OutLayer job given a copied sealed exploit. | T | T |
| R5.3 | The command-line tool SHALL seal exploits so that no build of the judge other than the pinned one can open them. | T | T |
| R5.4 | The judge SHALL return INVALID when the account named inside a sealed exploit differs from the account that submitted the claim. | J, C | T |
| R5.5 | For a ZERO or INVALID claim, the judge and the bounty contract SHALL NOT put the plaintext exploit on chain or in any job output, and SHALL record publicly only one coarse reason. | T | T |
| R5.6 | The bounty contract SHALL NOT deliver or publish a failed or refused exploit. | C | T |
| R5.7 | The access rule for a sealed exploit SHALL be owned by the keyless bounty contract, so no one can change who may open it. | C | T, I |

## R6 · The Protocol receives the exploit when, and only when, the Whitehat is paid

**HLR:** The Protocol SHALL receive a winning exploit when, and only when, the Whitehat is paid.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R6.1 | The bounty contract SHALL release the Protocol's copy of a winning exploit only through a job it requests after the payout has succeeded. | C | T |
| R6.2 | The Protocol SHALL NOT be able to open a winning exploit with its exploit key before the payout, and SHALL be able to after it. | T, W | T |

## R7 · A verified exploit pauses every covered contract on every chain, and nothing public points at the bug first

**HLR:** A verified exploit SHALL pause every covered contract on every chain the bounty covers, and nothing public SHALL point at the bug before the pause can take effect.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R7.1 | On a PAYS verdict, the bounty contract SHALL obtain a signed pause for every covered contract on every chain before paying. | C | T |
| R7.2 | Each signed pause SHALL come from that bounty's pause-role address for its chain. | C | T |
| R7.3 | The bounty contract SHALL store signed pauses for anyone to broadcast. The command-line tool SHALL broadcast all of them together right after a PAYS verdict, and SHALL request each pause's verification once its chain reports it final. | T | T |
| R7.4 | After a winning claim, the command-line tool's broadcast SHALL leave every covered contract on every chain reading as paused. | T | T |
| R7.5 | A paused demo contract SHALL refuse the exploit's path, so replaying the exploit live after the pause fails. | E | T |
| R7.6 | The bounty contract SHALL refuse a posting unless the judge's posting check confirms that each chain's pause-role address holds enough gas for its signed pause at its fee limit. | J, C | T |
| R7.7 | The web app's public bounty page SHALL NOT show a claim in progress. It SHALL show a chain as "landed" only once its pause has landed there, and as "verified" only once the bounty contract has recorded a verified pause for it. | W | T |
| R7.8 | The time from a PAYS verdict to the last pause landing, and to the last verified pause, SHALL be measured, and the README's threat model SHALL report the first as the window in which a public PAYS verdict shows a covered contract has a bug before it is paused. | T | A |
| R7.9 | The web app SHALL show every signed pause that hasn't landed with a "Send pause" button that sends it to its chain, needing no wallet. | W | T |
| R7.10 | The bounty contract SHALL let anyone request verification of a chain's pause through NEAR's MPC foreign-chain transaction verification, using the transaction hash it computes from the signed pause it stored (never one supplied by the caller). It SHALL record a verified pause only when that transaction succeeded. It SHALL fund up to three verification attempts per chain from the posting fee, and further requests SHALL pay their own cost. | C | T |
| R7.11 | The bounty contract SHALL NOT make any payout depend on a pause landing or being verified. | C | T |

## R8 · The breaker fails safe

**HLR:** The breaker SHALL only be able to pause. It SHALL NOT be able to move funds or unpause, so a false verdict can at worst pause.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R8.1 | Every signed pause SHALL call only `pause()` on a covered contract. | C | T |
| R8.2 | On the demo contracts, the pause role SHALL be able to pause and SHALL NOT be able to unpause or move funds. | E | T |
| R8.3 | The bounty contract SHALL NOT be able to request a signature for anything but a pause. | C | I |

## R9 · An unclaimed bounty can be recovered by the Protocol

**HLR:** The Protocol SHALL be able to recover an unclaimed bounty, on terms fixed at posting.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R9.1 | After the end date, if no payout was made, the bounty contract SHALL let the posting Protocol withdraw the whole bounty amount. | C | T |
| R9.2 | The bounty contract SHALL refuse a withdrawal from anyone but the posting Protocol. | C | T |

## R10 · The Protocol can't pull the bounty while a valid claim is under way

**HLR:** The Protocol SHALL NOT be able to withdraw a bounty while a valid claim is under way.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R10.1 | The bounty contract SHALL refuse a withdrawal before the end date. | C | T |
| R10.2 | The bounty contract SHALL refuse a withdrawal while any claim is unresolved, including a PAYS claim still waiting for its pause signatures, even after the end date. | C | T |

## R11 · Nobody can cheaply block, stall or grief a bounty

**HLR:** No one SHALL be able to cheaply block, stall or grief a bounty.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R11.1 | The bounty contract SHALL draw every claim's replay fee and its sealed exploit's storage deposit from the Whitehat's claim balance, and SHALL refuse a claim that balance can't cover. | C | T |
| R11.2 | The bounty contract SHALL request each claim's enclave job when the claim is submitted, so judging never waits behind other claims; only payment waits (R3.6). | C | T |
| R11.3 | The bounty contract SHALL let a Whitehat top up their claim balance and withdraw what remains of it. | C | T |
| R11.4 | The bounty contract SHALL refuse a posting unless the Protocol has prepaid, in NEAR, the posting fee covering the posting check, the bounty's storage, its release and publication jobs, and verifying each chain's pause. The posting fee SHALL NOT be refunded when a posting is refused. The bounty contract SHALL NOT spend its own balance on any bounty's or claim's costs. | C | T |

## R12 · Only whoever controls the covered contracts can post a bounty on them and receive their exploits

**HLR:** Only whoever controls the covered contracts SHALL be able to post a bounty on them and receive their exploits.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R12.1 | The bounty contract SHALL refuse a posting while any covered contract on any chain hasn't granted the pause role to the bounty. | J, C | T |
| R12.2 | The bounty contract SHALL refuse a posting that covers a contract the judge's posting check can't pause from the bounty's pause-role address in a simulated call. | J, C | T |
| R12.3 | The bounty contract SHALL refuse a posting that covers a contract already covered by a live or pending bounty. | C | T |
| R12.4 | The bounty contract SHALL deliver a winning exploit only to the posting Protocol's exploit key. | C | T |
| R12.5 | The judge's posting check SHALL read each covered chain through the RPCs pinned in its build and SHALL fail unless at least two answer and every answer agrees. | J | T |

*Residual risk, stated in the threat model:* a Fake poster can still post a bounty on their own copy of someone else's code (ADR-0003).

## R13 · NEAR does real work

**HLR:** The parts only NEAR provides SHALL carry the core promise, rather than decorate it.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R13.1 | The README SHALL show which promises rest on NEAR (the keyless contract holding money and pause rights, and Chain Signatures signing pauses for several chains) and SHALL back each with a mainnet transaction, as evidenced by R2.1, R7.1 and R14.2. | n/a | I |

## R14 · An AI agent can claim end to end, with authority limited to claiming

**HLR:** An AI agent SHALL be able to make a claim end to end with no human, and its authority SHALL be limited to what claiming needs.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R14.1 | The command-line tool SHALL create a claim key: a function-call key on the Whitehat's own account, limited to the bounty contract's claim actions. | T | T |
| R14.2 | The bounty contract SHALL judge a claim filed with a claim key like any other, and SHALL pay it to the Whitehat's account. | T | T |
| R14.3 | The command-line tool SHALL create claim keys that can't transfer funds, withdraw the claim balance, add keys or call anything else. | T | T |
| R14.4 | The command-line tool SHALL revoke a claim key so that it can no longer file claims. | T | T |
| R14.5 | Every command of the command-line tool SHALL offer machine-readable output. | T | T |
| R14.6 | An ordinary coding agent, given only the instructions file, SHALL find the demo bug and complete a claim with a claim key, with no human input during the run, as shown by a recorded mainnet run. | T | A |

## R15 · Everything claimed can be checked

**HLR:** Everything BounTEE claims SHALL be checkable: every README claim SHALL have a command or link and its expected output; at least one check path SHALL need no keys and no funds; anyone SHALL be able to rebuild the deployed contract and the judge and get the hashes that ran; and the README SHALL name every trusted party and what counts as an exploit.

| ID | Low-level requirement | Seam | Method |
|---|---|---|---|
| R15.1 | The command-line tool's `verify` SHALL check a bounty's attestation, the rebuilt program hash, the on-chain payout, and each pause's landing and verified-pause record, and, once the disclosure delay has passed, a re-run of the published exploit, all with no keys and no funds. Before publication it SHALL report the re-run as "not yet published", not as passing or failing. | T | T |
| R15.2 | The repo's build SHALL reproduce the deployed bounty contract's code hash and the judge's attested build hash. | T | T |
| R15.3 | The judge's scenario tests SHALL run offline from committed fixtures, with no keys, funds or network. | J | T |
| R15.4 | A script SHALL run every README "do X → see Y" step and check its expected output. | T | T |
| R15.5 | The README SHALL name every trusted party, what each could do if it misbehaved, and what counts as an exploit. | n/a | I |
| R15.6 | The web app SHALL read everything it shows about a bounty live from the chains, and SHALL NOT show any value typed into the page. | W | T, I |
| R15.7 | The README SHALL state: that a pause protects only the covered contracts and copies of their code elsewhere stay exposed; that publishing an exploit exposes those copies further; that payouts are open to anyone with no identity check (claiming that USDC's issuer can freeze sanctioned accounts only once verified); that a Fake poster can still post a bounty on a copy of someone else's code; and that the replay doesn't reproduce every chain exactly: on Arbitrum a contract that reads the block number, calls Arbitrum's system contracts or is a Stylus contract, and on Base a contract that uses Osaka's opcodes, may replay differently from how it runs on the chain. | n/a | I |

## Derived requirements

| ID | Requirement | From | Seam | Method |
|---|---|---|---|---|
| D1 | Each claim SHALL name one chain, its proof chain, with its block on that chain, and any covered chain SHALL be accepted as a proof chain. The bounty contract SHALL refuse a claim whose proof chain the bounty covers no contract on, without drawing from the claim balance, and the judge SHALL return INVALID for a claim job or a local replay job naming one. Every claim SHALL be judged against its proof chain's state at its block, and a winning exploit SHALL pause every covered contract on every covered chain. | ADR-0020, ADR-0014 | J, C | T |
| D2 | The command-line tool's `test` SHALL give the Whitehat, before any fee is spent, the same verdict the enclave then gives for the same claim. | Spec | T | T |
| D3 | The command-line tool SHALL turn an exploit written as a Foundry script into a claim. | Spec | T | T |
| D4 | The web app's landing page SHALL be the finished mainnet demo bounty, won by an AI agent with a claim key, told as a story in the order things happen (posted → sealed → checked → pauses signed → paid → pause landed per chain → pause verified per chain → published), with each step linking its real mainnet transaction, and SHALL NOT require a wallet. | Spec, ADR-0017, ADR-0018 | W | T |
| D5 | The web app's posting flow SHALL show each pause-role grant and pause-gas top-up per chain and tick each off as it lands, and SHALL show the rules back in plain English. Its pause-gas step SHALL explain that the pause is a real transaction on that chain, paid by the pause-role address, so it needs a few cents of that chain's token in advance; that BounTEE's funds on NEAR can't pay gas there; that only the BounTEE contract can sign for that address, so nobody, the Protocol included, can take that gas back; and that nobody presses the pause button, because a proven exploit triggers it. | Spec, ADR-0015 | W | T |
| D6 | The web app SHALL show, on every bounty, a Verify section with each check from R15.1 as passing, failing or not yet published. | Spec | W | T |
| D7 | The bounty contract SHALL let anyone trigger a winning exploit's publication once its disclosure delay (1–90 days, fixed at posting) has passed, and SHALL refuse it before. | ADR-0008 | C | T |
| D7.1 | A published exploit SHALL include the claim's block header and commit to its proofs by hash, the proofs being readable from the claim's transaction in NEAR's chain history; the command-line tool SHALL fetch and check them and re-run the exploit locally to the same verdict the enclave gave, at any time after publication. | ADR-0008, ADR-0014, ADR-0016 | T | T |
| D8 | The web app SHALL warn the Protocol on the bounty page when any chain's pause-role address holds less gas than its signed pause needs at its fee limit. | Spec | W | T |
| D9 | The bounty contract SHALL pay any account, with no allowlist or identity check. | ADR-0005 | C | T |
| D10 | *Removed:* the hosted watcher (ADR-0015). Delivery by anyone is R7.9. | ADR-0015 | n/a | n/a |
| D11 | The judge SHALL contain nothing specific to any demo exploit, demo contract or bounty. | ADR-0006 | J | I |
| D12 | On mainnet, the command-line tool's `withdraw` SHALL send a Whitehat's USDC from their NEAR account to an address they name on any chain NEAR Intents supports. It SHALL set the refund address to the Whitehat's own NEAR account, SHALL refuse an amount below 1Click's minimum or a recipient address the target chain won't accept, and SHALL send the deposit straight after the quote and never after its deadline. Verified by a recorded mainnet run under Liam's yes, with its transactions cited in the README. | ADR-0013 | T | A |
| D13 | The web app SHALL let a Protocol sign in with MetaMask and use that one wallet both to grant pause roles on EVM chains and to post on NEAR. | ADR-0013 | W | T |
| D14 | For each pause-role grant, the web app SHALL offer the grant's transaction details to copy into a multisig. | ADR-0013 | W | T |
| D15 | Before the Protocol signs a posting, the web app SHALL show a "what you're risking" panel stating: a claim tests the contracts as they are at a recent block, so a bug you fix yourself stops being claimable 5 minutes after the fix lands; the bounty is locked until the end date and paid in full to the first proven theft of at least the minimum theft; the posting fee isn't refunded and pause gas can't be recovered; the worst a wrong verdict can do is pause the covered contracts, and BounTEE can never move the Protocol's funds; the winning exploit is published after the chosen disclosure delay; and the same list of trusted parties the README names (R15.5). | ADR-0013 | W | T |
| D16 | On mainnet, the web app SHALL let a Protocol fund its own NEAR account with USDC from Base before posting, with the refund address set to the Protocol's own Base address. Verified by a recorded mainnet run under Liam's yes, with its transactions cited in the README. | ADR-0013 | W | A |
| D18 | The command-line tool's `init` SHALL create a local NEAR account and, on testnet, fund it from the NEAR faucet with no sign-up; on mainnet it SHALL state plainly how much NEAR to add and the address to send it to. | Spec | T | T |
| D19 | The command-line tool's `test` on a demo bounty SHALL run offline, from proofs committed in the repo, with no RPC. | ADR-0014 | T | T |
| D20 | Before the posting prompts, the web app SHALL derive the Protocol's exploit key from a MetaMask signature of a fixed message naming the bounty contract, the Protocol's account and the bounty's name, so there is no file to save, and SHALL include its public key in the posted rules (R1.1). If the wallet doesn't return the same signature twice, it SHALL fall back to a saved key file. | Spec | W | T |
| D22 | The web app's public bounty page SHALL show the number of claims judged so far. | Spec | W | T |
| D23 | The command-line tool SHALL show a claim's progress live: sealed, checking, then the verdict, and on PAYS, pauses signed, paid, then each chain landed and verified. | Spec | T | T |
| D24 | On a paid claim, the command-line tool SHALL give the Whitehat a receipt with the payout transaction, the attestation and each pause's transaction. | Spec | T | T |
| D25 | Each bounty's pause-role address on each chain SHALL be derived from the bounty contract's account and a path built from the Protocol's account and the bounty's name, so the web app and the command-line tool can compute it before posting; the bounty contract SHALL refuse a bounty name the same Protocol has used before. | Spec | C | T |
| D21 | A script SHALL deploy a fresh demo instance (demo contracts on each chain, pause-role grants, pause gas) and post its bounty, so every winning run uses a new bounty. The README SHALL NOT offer a live winning claim as a judge step. | ADR-0014 | T | T |
| D26 | The command-line tool's `test` and `claim` SHALL prove a claim on the covered chain the Whitehat names. When the bounty covers one chain, they SHALL use it when none is named. When it covers several and none is named, or a chain it doesn't cover is named, they SHALL refuse before any EVM RPC call or fee, listing the covered chains. | ADR-0020 | T | T |
| D29 | The judge SHALL accept the block header of every chain pinned in its build, Arbitrum's included. A chain with a profile in the judge (its EVM rules, per-transaction gas cap, randomness and fewest header fields) SHALL be replayed under that profile, and every build SHALL hold the same profiles, so local and enclave runs agree; a chain without one SHALL be replayed as before this requirement. | ADR-0020 | J | T |
| D27 | The web app's posting flow SHALL NOT ask for a proof chain. It SHALL list each covered chain's USDC as a listed token at price 1, and its plain-English rules SHALL state that a theft proven on any covered chain wins and pauses every covered contract on every chain. | ADR-0020 | W | T |
| D28 | The web app SHALL name the chain and block a winning claim was proven on, in the landing story's "checked" step, on the bounty page and on the open-exploit page. | ADR-0020 | W | T |
| D17 | The web app's posting flow SHALL show the native NEAR the Protocol's account needs for gas and the posting fee, its NEAR address with a copy button and, on testnet, a link to the NEAR faucet, and SHALL tick the step off once the account holds enough. | ADR-0013 | W | T |
| D30 | The web app's network SHALL be set by one setting when it is built, with mainnet the default and no control on any page. A testnet build SHALL read from, link to and ask MetaMask to sign on only NEAR testnet, Base Sepolia and Arbitrum Sepolia: its bounty contract, NEAR's USDC, the MPC root key a pause-role address is derived from, explorers, NEAR's Ethereum-compatible chain and the network its Verify command names; a mainnet build only mainnet's. | ADR-0021 | W | T |
| D31 | A testnet build SHALL look and behave as a mainnet build except for one "Testnet" badge beside the wordmark in the nav on every page, linking to the mainnet site. Its `/` SHALL lead to the bounty list and SHALL NOT show the mainnet demo story, and its nav's Verify link SHALL lead to the mainnet site's Verify section. A mainnet build SHALL link to the testnet site from its bounty list and its landing page's footer. While the testnet site's address is set, the mainnet landing page's "Open the app" and "Post a bounty" SHALL open the testnet site's bounty list and posting flow. A link to the other site SHALL be shown only when that site's address is set. | ADR-0021 | W | T |
| D32 | On testnet, the web app's posting flow SHALL link to Circle's faucet for test USDC beside the Protocol's USDC balance. | ADR-0021 | W | T |
| D33 | A script SHALL deploy the testnet site's bounty contract on Circle's testnet USDC and seed it with bounties from fictional Protocols in each lasting public state: Live, Live with claims judged, Paid, Ended unclaimed, Withdrawn and Not posted (a failed posting check). Verified by a recorded testnet run (a testnet run is this requirement's own subject, not evidence for any other, ADR-0017). | ADR-0021 | T | A |
| D34 | The README SHALL name the landing page's eight demo steps in the same words and order, and cite for them the transactions the landing page reads (D4); a script SHALL check both. | Spec | T | T |

*Amended Nov 8 (ADR-0020):* any covered chain can be a claim's proof chain. D1 is rewritten, R1.1, R1.4, R2.8 and R3.8 follow it, R15.7 states the replay's per-chain limits, and D26–D29 are new.

*Amended Nov 10 (ADR-0021):* a testnet build of the web app is a second site for trying BounTEE; D30–D33 are new.

*Amended Nov 11:* D31's mainnet landing page sends its app buttons to the testnet site, which has bounties to try; mainnet has none yet.

*Amended again Nov 10 (Liam):* the public state of a bounty whose posting check failed reads "Not posted", not "Check failed" (DESIGN.md, Bounty list); D33 follows.

*Amended Nov 12 (spec #82, the final README):* the README tells the landing page's story in its words and with its transactions; D34 is new, and R15.4's script checks it alongside the README's steps, links and placeholders.
