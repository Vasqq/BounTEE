# BounTEE

Bug bounties that pay a whitehat automatically once an enclave proves their exploit really drains funds, and that pause the vulnerable contract on every chain the bounty covers.

## Users

**Protocol**:
The team whose contracts a bounty covers. It posts and funds the bounty, commits the rules, and grants the pause role.
_Avoid_: Client, project, customer

**Security lead**:
The person who acts for a Protocol in BounTEE.
_Avoid_: Admin, owner

**Whitehat**:
Whoever submits an exploit to claim a bounty, either a person or an AI agent run by one.
_Avoid_: Hacker, researcher, hunter, claimant

**AI agent**:
A Whitehat that is software, run by a person, whose authority is limited to what claiming needs. It is a kind of Whitehat, not a separate actor.
_Avoid_: Bot, auditor

**Claim key**:
A key a Whitehat gives their AI agent that can file claims on BounTEE and do nothing else. It can't move the Whitehat's money, and payouts go to the Whitehat, never to the key.
_Avoid_: Agent key, API key, session key

**Posting fee**:
NEAR a Protocol prepays at posting to cover the posting check, the bounty's storage, its release and publication jobs, and verifying each chain's pause. Not refunded if posting is refused.
_Avoid_: Listing fee, deposit

**Claim balance**:
A small prepaid amount a Whitehat keeps on BounTEE that every claim they or their AI agent files draws its replay fee and its sealed exploit's storage deposit from.
_Avoid_: Credits, gas tank, deposit

## Supporting parties

**Verifier**:
Anyone who checks, read-only, that a bounty ran by its rules: the Protocol's community, judges, an automated screen.
_Avoid_: Auditor, observer

**Enclave**:
The trusted hardware-isolated environment that replays an exploit against the snapshot and reports the loss with an attestation.
_Avoid_: TEE box, oracle

**MPC network**:
NEAR's network of independent signers that signs pauses for other chains on the bounty's behalf, and verifies that they landed.
_Avoid_: Signer, relayer

**Broadcaster**:
Whoever submits an already-signed pause to an EVM chain. Anyone can be one, and none can change what was signed.
_Avoid_: Relayer, keeper

**Depositor**:
A user of the Protocol whose funds sit in its contracts. Never touches BounTEE, but a pause affects them.
_Avoid_: Customer, end user

## Adversaries

**Fake poster**:
Someone who posts a bounty on contracts they don't control, to buy a working exploit of them.

**Cheating whitehat**:
A Whitehat who passes off a legitimate outflow (an owner rescue, their own withdrawal, a public sweep) as theft.

**Griefer**:
Someone who spams, stalls or locks up a bounty without a real exploit.

**Watcher**:
Someone who reads public claim activity to locate the bug before the pause lands.

## Core terms

**Bounty**:
A Protocol's funded, fixed offer to pay for an exploit of its committed contracts, with rules set at posting that nobody can change.
_Avoid_: Program, audit, contest

**Snapshot**:
The proof chain's state at the recent block a claim names, proven by the claim. Exploits are replayed against it inside the enclave, never against live contracts.
_Avoid_: Freeze, fork, frozen code

**Exploit key**:
The Protocol's key for opening a winning exploit, derived from a MetaMask signature so there's no file to lose.
_Avoid_: Decryption key, private key

**Verified pause**:
A pause that NEAR's MPC network has confirmed succeeded on its chain, in a block the chain reports safe from reorganisation, recorded by the bounty contract on NEAR.
_Avoid_: Confirmed pause, finalized pause

**Proof chain**:
The one chain, named at posting, whose recent state every exploit is judged against. A winning exploit still pauses every covered chain.
_Avoid_: Home chain, main chain

**Exploit**:
A sequence of transactions that, replayed against the snapshot, causes a loss by theft.
_Avoid_: Bug report, PoC, finding

**Claim**:
A Whitehat's sealed submission of an exploit against one bounty.
_Avoid_: Report, submission

**Covered contract**:
A Protocol contract, on one chain, that a bounty tests and can pause.
_Avoid_: Target, in-scope contract

**Pause role**:
The permission a covered contract grants a bounty to pause it, and nothing else. Granting it is how a Protocol proves it controls the contract.
_Avoid_: Guardian, admin role, pauser key

**Live bounty**:
A bounty whose posting check has passed: every covered contract has granted it the pause role, can be paused, and has pause gas. Only a live bounty accepts claims.
_Avoid_: Active, open, registered

**Dependency**:
A contract in the snapshot that an exploit may use but that the bounty doesn't cover. Value taken from it never counts as loss.
_Avoid_: External contract, helper

**Listed token**:
A token the Protocol names at posting as counting toward gain and loss, each with a posting price.
_Avoid_: Whitelisted token, supported asset

**Posting price**:
The fixed value per unit of a listed token, set at posting. Nothing read during an exploit is used to value anything.
_Avoid_: Oracle price, market price

**Bounty amount**:
The whole sum a bounty pays, once, to the first Whitehat whose exploit reaches the minimum theft. Fixed at posting.
_Avoid_: Reward, prize, payout tier

**Minimum theft**:
The smallest score, fixed at posting, that wins the bounty amount.
_Avoid_: Tier, threshold, severity

## Judging

**Fresh account**:
An account that doesn't exist in the snapshot, holding no roles and no deposits. Only fresh accounts may send an exploit's transactions.
_Avoid_: Attacker address, burner

**Seed**:
The fixed starting balance of listed tokens fresh accounts receive for a replay, subtracted before scoring.
_Avoid_: Capital, funding

**Attacker holdings**:
The fresh accounts plus every contract they create during the exploit.
_Avoid_: Attacker wallet

**Gain**:
The value of the attacker holdings at the end of the replay, minus the value of the seed, at posting prices (R3.8).

**Loss**:
The fall in the value of the covered contracts' holdings during the replay, at posting prices (R3.8).
_Avoid_: Drain, damage

**Score**:
The smaller of gain and loss, never below zero.

**Verdict**:
The outcome of judging a claim: PAYS (score reaches the minimum theft), ZERO (a valid replay below it) or INVALID (the replay couldn't be judged, such as reading state the snapshot doesn't prove).
_Avoid_: Result, decision

**Attestation**:
A receipt signed by the enclave's hardware stating which program ran, on which input, and what verdict it produced. Anyone can check it.
_Avoid_: Proof, certificate, quote

**Sealed**:
Locked so that only the pinned judging program, inside the enclave, can read it. Exploits are sealed from submission until publication.
_Avoid_: Encrypted, private, hidden

**Verify**:
To check, from public data alone, that BounTEE judged, paused and paid honestly. Never a check of whether a contract has a bug.
_Avoid_: Audit, validate

## Lifecycle

**Disclosure delay**:
The time, fixed at posting and between 1 and 90 days, after a payout before the winning exploit is published for anyone to re-run.
_Avoid_: Patch window, embargo

**End date**:
The moment, fixed at posting, after which a bounty stops accepting claims and its Protocol can withdraw whatever is left. Nothing can be withdrawn before it.
_Avoid_: Expiry, deadline, close

**Pause**:
Stopping a live covered contract on a chain the bounty covers, triggered by a verified exploit. It never moves funds and never unpauses.
_Avoid_: Freeze, halt, kill switch
