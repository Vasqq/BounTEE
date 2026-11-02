# BounTEE · project context

Handoff from the Gauntlet ideation run to the build repo, for Liam and for any agent working in the repo. Written Nov 2, 2026, and revised the same day after three independent reviews: a cold read, a live fact-check and a red team.

## Read this first

- **This file is context, not a plan.** It contains no architecture, stack choice, interface design or build plan. Requirements, the grilling session and the spec happen in this repo, with Liam.
- **Every item below is one of five things:**
  - a fact, with its source;
  - a requirement: what must be true, not how;
  - a submission must-have from the official rules;
  - Gauntlet advice, labelled as such;
  - an open question.
- **The name is BounTEE** (Liam, Nov 2), with the tagline "Confidential bounTEEs". The name is "bounty" with the secure-enclave tech (TEE) built in. The earlier working name, "Proof of Exploit", is already used by two other projects, so don't use it.
- **The tests describe throwaway code.** Section 6 is evidence of what's possible, not a design to copy.
- **Nothing secret is in here.** The test accounts, keys and code stay out of this repo.
- **Terms used:**
  - **The Gauntlet:** the ideation and validation process that picked this idea.
  - **The simulated jury:** nine AI personas modelled on the real judges (seven humans, plus Claude Code and Codex). The model is low-confidence: use it for relative rank and objections, never as a win probability.
  - **Q-001 to Q-017:** FAQ items in the official rules file, HACKATHON.md.
  - **R1–R15:** the requirements in section 2.
  - **Tests 1–6:** section 6.

Contents:
1. The idea
2. What it must do
3. Why the Gauntlet picked it, and the honest standing
4. The first filter: the Claude Code and Codex screen
5. Submission must-haves
6. Tests already run
7. Constraints and pitfalls from the tests
8. Competitors and prior art
9. The judges, and what the simulated jury said
10. Hackathon facts
11. Dates
12. Open questions
13. Day 0 and working rules
14. Where the evidence lives

---

## 1. The idea

**In one line:** bug bounties that pay out automatically when a secure enclave proves an exploit really drains funds, and that trigger a pause of the vulnerable contract on every chain where it's deployed.

**How it works, at the level of the idea:**
1. **A protocol posts a bounty on NEAR.**
   - It commits to a frozen copy of its contracts' on-chain state (a "snapshot"), a rule for what counts as a loss, and payout tiers.
   - The rules are fixed at posting (R1), and nobody can move the money except by those rules (R2).
   - For the circuit breaker, the protocol gives a pause-only role on its contracts to an address that the bounty controls through NEAR's Chain Signatures.
2. **A whitehat submits a working exploit,** sealed so that nobody can read it before payout (R5). The whitehat can be a person or an AI agent.
3. **A secure enclave replays the exploit in an EVM against the snapshot.** It reports the loss with a hardware attestation anyone can check. In the tests, the enclave was OutLayer's Intel TDX service, which the security track's prompt points to.
4. **If the loss meets the tier:**
   - the vulnerable contract is paused on every chain the bounty covers (R7);
   - the whitehat is paid;
   - the protocol receives the exploit (R6).

   Below the tier, nothing happens and nobody pays.

How these parts connect is for the spec. The tests used one pattern (section 6), and older Gauntlet documents describe another (section 14).

The bounty is the original idea, first called "Proof of Exploit". The circuit breaker was added on Nov 2: four of the nine simulated jurors named it as the change that would most raise their score, and five named a "quiet claim" instead (section 9).

### Who it's for

**Whitehats:** a person, or an AI auditing agent run by one, holding a working exploit against an EVM protocol.
- **Today,** the exploit goes to the protocol or a platform before any payment. After that the whitehat has no leverage, because severity can be downgraded and payment disputed or delayed.
- **Cases on record** (sources in `probe-viability.md`):
  - Immunefi calls its mediation "a strong recommendation and not a final verdict". Its target is 7 days, and delays of over a month are reported.
  - HackenProof's NEAR Intents programme allows up to 30 business days to pay, possibly in vested NEAR.
  - Injective offered $50k against a $500k maximum.
  - A Uniswap finding stalled for 29 days.
- **The aim:** paid within seconds of a verified drain (each claim took about 18–22 s in tests 4–5), with nothing to negotiate, and the exploit handed over only with the payment. Sealing isn't built yet (R5, R6).

**Protocol security leads.**
- **Today:** triage. Most reports don't reproduce, and AI-written reports cost nothing to send. Immunefi found "not a single genuine vulnerability" in ChatGPT-written reports.
- **The aim:** pay only for an exploit that drains the committed state, so junk reports cost nothing. A verified exploit also triggers a pause of the vulnerable contract on every chain where it's deployed.

**Use cases on record:**
1. **An auto-paid "drain tier" next to a protocol's normal bounty programme.** The viability probe read it as a complement to Immunefi, not a replacement.
2. **A protocol deployed on several chains,** paused on all of them by one verified exploit.
3. **Pre-launch code:** audit contests and invariant bounties on contracts that don't hold money yet. There, a public "a bug exists" signal costs nothing. This is the first user that three simulated jurors named (Eddy, Mert, Stepan).
4. **AI auditing agents as whitehats,** claiming and getting paid with no human reading a report.
   - In Anthropic's SCONE-bench, AI agents produced working exploits for 207 of 405 contracts that were really hacked between 2020 and 2025.
   - In a separate zero-day run over 2,849 new contracts, an agent run cost about $1.22.

**A tension for the grilling session** (section 12):
- The first users the jurors named (pre-launch code) have nothing live to pause.
- The circuit breaker, and the NEAR case built on it, need a live protocol deployed on two or more chains. Jurors said such a protocol wouldn't post a bounty as built.

**What the judges have in mind: the Oct 1 incident.**
- On Sep 30–Oct 1, 2026, NEAR Intents lost about $3.9M USDT on BSC through the HOT Omni deposit/withdraw path. Services were paused for about an hour, and the funds were returned within about a day (The Block, fetched Oct 26).
- Illia's simulated persona asked first whether this product would have caught it. It wouldn't: that attack was live, cross-chain and multi-step. This product acts only when a whitehat claims, and it replays single-sender exploits against a snapshot. Expect the same question from the real judges.

### Questions Liam already asked

- **Why not just hand over the exploit and get paid?** After hand-over the whitehat has no leverage. Here the replay decides the payout, not the protocol.
- **Why not just exploit the bug and keep the money?**
  - That's theft. The bounty is the legal route, and it needs no negotiation.
  - SEAL's safe-harbor framework, with 20+ adopters, shows that protocols already commit in advance to non-negotiable whitehat bounties. It covers rescues during live exploits only.
- **Who runs it and pays out?** Once it's deployed, nobody can move the money except by its rules (R2). In the tests, the NEAR contract had no access keys at all.
- **Do protocols have to change their contracts?**
  - For the bounty, no.
  - For the circuit breaker, yes. The contract needs a pause function, and the protocol must grant a pause-only role on each chain.
  - Pausable contracts with a guardian role are a common pattern (for example OpenZeppelin's Pausable). Contracts without one would need an upgrade.
- **So it needs protocols to cooperate?** Yes. In a hackathon demo the team plays the protocol, and the simulated jury reads that as "toy" risk. An outside claimant or a named security lead would counter it, but Liam has decided against recruiting outside parties (section 13), so the demo itself has to carry the story.
- **Why Base, if Flare already proves it?**
  - Nothing in the mechanism is Base-specific. It works on any EVM chain whose transactions Chain Signatures can sign.
  - Coston2 (Flare's testnet) passed end to end. Base Sepolia is signed and simulated, but waiting for test ETH.

---

## 2. What it must do

Each line says what must be true, not how. The last column says what the tests show so far.

| # | Must be true | Why | Shown so far |
|---|---|---|---|
| R1 | **The rules are fixed when the bounty is posted:** what is tested, which replay program judges it, what counts as a loss, the tiers and the chains to pause. | Both sides must know in advance what pays. | **Yes.** In tests 4–5 the NEAR contract stored them at creation, and its setup code rejects a replay program that isn't pinned to one version. |
| R2 | **Nobody can move the bounty, block a valid payout or force an invalid one,** including the protocol, the whitehat and us. | The core promise. | **Yes, for the NEAR contract** (no access keys after deployment, tests 4–5). OutLayer and the MPC network remain trusted (section 3). |
| R3 | **Pay only for a verified exploit whose replayed loss meets the tier.** Harmless, below-tier, malformed and repeat claims pay nothing, and no claim is paid twice. | The core promise. | **Yes, on a 93-byte toy vault** (tests 4–5). |
| R4 | **Only theft counts.** None of these may score as an exploit: a depositor withdrawing their own funds, an owner rescuing funds, a sweep anyone may call, or a bundle that impersonates the owner. | The red team's top finding, classed as an implementation fix (not a reason to drop the idea). | **No.** The tested replay accepts any sender. |
| R5 | **The exploit stays sealed.** Nobody can read it before the payout, and failed attempts are never revealed. | It is the whitehat's leverage. The "public bug signal" answer, the difference from HoneyPause and the privacy-track fit all depend on it. | **No.** Every test sent the exploit in plain text, readable on NEAR testnet. |
| R6 | **The protocol receives the exploit when, and only when, the whitehat is paid.** | Fair exchange. | **No.** |
| R7 | **A verified exploit pauses the vulnerable contract on every chain the bounty covers, and nothing public points at the bug before the pause can take effect.** | The circuit breaker. It addresses the jury's top objection, and it is the main "why NEAR" argument. | **Partly.** In test 5 both pauses were signed before the payout, and the Coston2 pause executed. However, the time from verdict to on-chain pause wasn't measured, the payout didn't wait for signing to succeed, and plain-text claims (R5) are public first. |
| R8 | **The breaker fails safe.** It can only pause, never move funds or unpause. A false verdict can, at worst, pause. | Protocols must be willing to grant the role. | **Yes, on the test vault.** |
| R9 | **An unclaimed bounty can be recovered** by the protocol on terms fixed at posting. | Otherwise funds stay stuck. | **No.** 7.8 test NEAR is permanently stuck in the test contracts. |
| R10 | **The protocol can't pull the bounty while a valid claim is under way.** | The Codex persona; Sealed-Glass Proofs calls this "unfair bounty withdrawal". | **No.** |
| R11 | **Nobody can cheaply block, stall or grief a bounty.** | Red-team finding. | **Partly.** Repeat and simultaneous claims are handled; spam and lock-ups are not. |
| R12 | **Only whoever controls the target contracts can post a bounty on them and receive their exploits.** | Red-team attack path C: a fake bounty on someone else's protocol buys a working exploit of it. | **No.** |
| R13 | **NEAR does real work.** The parts only NEAR provides carry the core promise, rather than decorating it. | Only the NEAR integration built in the window is judged (Q-002). It is also the Illia, Kain and Stepan question. | Section 3. |
| R14 | **The AI angle is real.** An AI agent can make a claim end to end with no human, and its authority is limited to what claiming needs. | The track is "AI Security & Defense". Its hints include agent security and function-call keys, and "keys to an LLM" is a veto for Eddy and Illia. | **No.** No agent has claimed yet. |
| R15 | **Everything claimed can be checked.** That covers four things:<ul><li>every README claim has a command or link and its expected output;</li><li>at least one check path needs no keys and no funds;</li><li>anyone can rebuild the deployed contract and the enclave program from the repo and get the hashes that ran;</li><li>the README names every trusted party and what counts as an exploit.</li></ul> | The AI screen (section 4). The track tagline is "Trust, but verify". Eddy and Mert. | **Only as test evidence.** The test contracts used a non-reproducible build. |

**The riskiest open link is sealing (R5).**
- R7's promise, the main difference from HoneyPause, the whitehat's leverage and the privacy-track fit all assume it.
- The simulated jury scored a design in which the exploit was sealed.
- It is untested in this form. Test 2 is the closest evidence.
- The playbook's Day-3 checkpoint (section 11) doesn't exercise it.

**Also unproven:**
- **Real protocol state.** Only the toy vault has been replayed, plus synthetic size probes. Not yet replayed:
  - a Solidity contract;
  - a reentrancy exploit;
  - token losses;
  - oracle or flash-loan state;
  - a historical hack.
- **Failing safely on reads outside the snapshot.** Unknown accounts and storage read as empty.
- **The pause.** How fast it lands after the verdict, and who broadcasts it.
- **Base Sepolia.** No broadcast yet; it needs test ETH.
- **Outside parties.** No outside or AI-agent claimant, and no outside protocol.
- **Failure paths.** An OutLayer timeout or instruction-cap failure through the contract (per OutLayer's source, both return no result, so nothing is paid), and verdicts over 1 KB.
- **Non-EVM pauses.**
- **Scoring.** The simulated jury hasn't scored the circuit-breaker version.

---

## 3. Why the Gauntlet picked it, and the honest standing

| Reason (evidence) | What it implies for the build |
|---|---|
| **The simulated jury likes it, with limits.** Round 1: 6 of 7 human personas championed it, with no vetoes. After deliberation: 3 champions (Eddy, Mert, Stepan), still no vetoes, about 3rd–4th of 50 in security. But three of the seven human personas scored it level with or below the strongest clone, an "attested agent firewall". The Gauntlet's own table turns that rank, in a field of about 320, into roughly a 2% podium chance. That is a rough reading, not a forecast. | The objections in section 9 decide the outcome. The circuit-breaker version has never been scored; a re-score early is suggested (section 11). |
| **Jurors called it the most verifiable security entry they expected to see.** The money path has testnet transactions, including the cases that must pay nothing. The AI personas weigh executed transactions through a NEAR feature heavily. | Keep everything checkable (R15). |
| **Its riskiest integrations already ran, with $0 of mainnet spend:**<ul><li>the enclave replay and the payout from a contract with no keys passed on testnet;</li><li>the cross-chain pause passed end to end on Coston2;</li><li>on Base Sepolia, the pause is signed and simulated only.</li></ul> | Anything the demo relies on beyond that needs proving early. |
| **The pain is documented:** non-binding mediation, public payout disputes, 7–30-day waits and AI-written junk reports. | Name the user and the problem first. |
| **It stands out in the field.** On Nov 2 at about 21:00 UTC, the site's public project directory listed 68 submissions, about 35 tagged security. Nearly all are agent spending guards or firewalls, and none is about exploits or bounties. | Differentiation is real. The track-fit gap (section 10) is the cost. |
| **It fits stories the judges carry:**<ul><li>the Oct 1 Intents exploit (the playbook notes "security posture gets noticed");</li><li>NEAR's Oct 22 post on "privacy, cross-chain, and agentic apps";</li><li>Illia's Oct 26 line, "Cross-chain markets and confidential AI are NEAR";</li><li>Haseeb's prediction that crypto's AI use cases in 2026 "remain within software engineering and security".</li></ul>The X quotes come from the Gauntlet's Oct 26 fetch. | Use these themes only where they are built, and state the limits. |
| **No veto triggers:** no token, no gambling, no keys handed to an AI model. | Keep it that way (see R14). |
| **No mainnet needed:** testnet-only projects are eligible in every track (Q-010). | Mainnet stays a Liam decision (section 13). |

### Why NEAR carries the weight, and where it doesn't

**The bounty on its own is "convenient", not load-bearing** (the NEAR probe; all 9 simulated jurors said "partly").
- The enclave carries the promise, not NEAR.
- For a single-chain bounty, an EVM-only build reaches the same trust: an escrow on Base, a Phala TDX enclave, and the enclave key checked by Automata's on-chain verifier.

**What NEAR did in the tests:**
1. **A NEAR contract that nobody holds a key to ordered attested compute and settled in its own callback,** with no relayer and no server (test 4).
2. **The same kind of contract got NEAR's MPC network (Chain Signatures) to sign `pause()` for two EVM chains.** It checked the signatures itself, then paid (test 5).

**The honest edge:** one public rule that nobody holds a key to:
- holds pause rights on several EVM chains;
- signs every pause before it pays;
- keeps the signing keys with NEAR's MPC network, not with the enclave that judges.

A contract on any single chain can't hold that rule for other chains without a bridge. That matters for protocols on two or more chains. Four simulated jurors named this as their top fix (Illia, Kain, Stepan, the Codex judge). All four said it moves NEAR from "partly" to "yes", and Illia and Kain said they would then champion it.

**The rebuttals it must survive:**
- **Portable signature.** The verdict is a portable signature, so per-chain verifier contracts, or an enclave-held key, could pause each chain (`probe-near.md`).
- **Single-chain protocols.** On one chain, a contract there can pause without NEAR; HoneyPause does.
- **Trust in OutLayer.** The NEAR contract pays on OutLayer's answer and doesn't check the enclave's hardware quote itself. A faked answer would still get the pauses signed. It would be detectable afterwards, but not prevented.
- **OutLayer is third-party.** NEAR's docs call it "a third-party platform", built by FastNEAR, and advise evaluating its "operational guarantees, attestation verification flow, and key custody model".
- **MPC uptime.** The breaker needs the MPC network to be up.
- **Limited test coverage.** Only EVM chains were tested, and only one pause was broadcast.
- **No Intents.** Intents is unused because it has no testnet (Q-007).

### The NEAR tech in play

Checked against docs.near.org, HACKATHON.md and the live security track prompt on Nov 2.

| Piece | What it is | Who provides it | What the hackathon says | Used in tests |
|---|---|---|---|---|
| **Chain Signatures** | Lets a NEAR account, including a contract, sign transactions for other chains. MPC contract: `v1.signer` on mainnet, `v1.signer-prod.testnet` on testnet. | NEAR. Independent MPC nodes do the signing; mpc.nearone.org lists the operators. | A hint in the defi, business and agents tracks. NEAR's launch post names "chain signatures". | Yes (tests 1, 5) |
| **Yield and resume** | Lets a contract call wait for an off-chain answer. | NEAR protocol. | Not named. | Yes, under OutLayer and the MPC signer |
| **Access keys** | NEAR's account permission model, including function-call keys and accounts with no keys. | NEAR protocol. | FUNCTION CALL KEYS is a security hint. "Access keys" is a "start here" link in the security prompt. | The test contracts had no keys. Function-call keys are unused. |
| **OutLayer** | "A verifiable off-chain compute platform for NEAR". It runs WebAssembly in Intel TDX enclaves and returns an attestation. | FastNEAR, a NEAR infrastructure provider. NEAR docs list it as the off-chain compute platform. | An ecosystem partner in HACKATHON.md. A "start here" link in the security prompt. TEE ATTESTATION is a security hint. | Yes (tests 2–5) |
| **NEAR AI Cloud** | Private AI model inference in TEEs, with attestation. | NEAR AI. | A privacy hint. A "start here" link in the security prompt. | No |
| **Agent API** (Agents on Intents) | Policy-bound agent wallets on Intents, with custody on OutLayer. | Agents on Intents. | A "start here" link in the security prompt. | No. Wallet calls need a demo or partner key, and the demo host is on mainnet. |
| **NEAR Intents and Confidential Intents** | Cross-chain settlement, with an optional private mode. | NEAR Intents. | A hint in many tracks. No testnet (Q-007). | No (test 6) |

Shade Agents, NEAR's former framework for TEE-based agents, has been unmaintained since Apr 19, 2026, and the hackathon doesn't mention it.

No integration is mandatory: "Hints are hints. Own contract on NEAR that fits the track is enough." (Q-011).

---

## 4. The first filter: the Claude Code and Codex screen

**What is official:**
- **The site's FAQ:** "Claude Code & Codex screen every project first: they check that it runs and does what the README says. The human judges above make the decisions."
- **Q-017:** "Screening, not deciding: reproducibility check, feature verification, structured report, preliminary score. Humans decide; low AI score alone cannot reject."

**What is unknown.** No live source states any of these (checked Oct 31 and Nov 2):
- the screen's rubric;
- its run environment: keys, funds, network access, time per project;
- how its report reaches the humans;
- whether humans review every project;
- whether it reads the X post or watches the video.

**Liam's priority** is to pass this screen cleanly. The Gauntlet assumes that, with hundreds of entries (its estimate is about 700) and seven humans over three days, the screen's report shapes what humans look at first. Passing it is not about gaming it. Every claim has to be true, and checkable by an agent that may have no keys and no funds.

**What a machine reader can check and rewards** (Gauntlet advice, from its model of the AI judges):
- **Claim ↔ code.** Every claimed feature can be found in the repo. A mismatch is "the single most detectable failure".
- **Real, not mocked.** The code really calls the services the README names. A search for `mock`, `TODO`, `fake_`, hard-coded responses or demo-only branches finds them instantly.
- **On-chain evidence:** deployed accounts, tx hashes and explorer links that match the code's config.
- **Tests that are visible and pass.**
- **Reproducibility.** The project runs from a clean checkout, and its hashes rebuild (R15). Expect the screen to run a simple documented command, but not to "fight with missing env vars, paid API keys, or mainnet funds".
- **Commit history** with real iteration across the window, not one dump.
- **Hygiene:** lockfiles, an example env file with names only, no secrets, a LICENSE.
- **Track vocabulary.** NEAR's exact names for the features actually used.

**What it can't check, so the README must carry it honestly:**
- the video;
- UX beyond what the repo shows (the Gauntlet's model expects design to be judged from screenshots and front-end code);
- traction, so never inflate numbers;
- anything that needs funds or keys it doesn't have;
- TEE attestations, unless the README gives the verification command and its expected output;
- originality: it knows prior art from its training, so argue the difference explicitly;
- sustainability: keep it concrete (costs, who pays, what breaks at scale).

**What reads as AI slop:**
- **Unbacked prose:** README sentences the code doesn't back, generated filler, marketing words.
- **Hollow code:** "impressive-looking but trivial code" and "demo paths that don't match the repo", both known failure modes of AI judging.
- **Wrong numbers and dead links.** An earlier Gauntlet README draft had three:
  - a "~16 s" timing, when we measured 16.6–24.3 s;
  - a false nearest-competitor sentence whose cited link now returns 404;
  - an attestation URL that returns another project's job if given the wrong kind of id.
- **A README describing a design the code doesn't implement.** Older Gauntlet documents describe an enclave-signature check the tested pattern doesn't perform, and the simulated AI judges flagged exactly that risk.
- **An Intents payment shown "on testnet".** Intents has no testnet. The AI judges and Illia veto it.

**What this means for this project:**
- **The screen likely can't re-run the circuit breaker.** The full flow needs EVM testnet gas, which sits behind a faucet login or a CAPTCHA. R15's path with no keys and no funds is the answer, and how to build it is open question 9.
- **The tests prove feasibility, not the product.** Their transactions aren't the product's evidence. The README should point to transactions made by the code in the repo (claim ↔ code).
- **Allow for timing.** Each enclave job takes about 20 seconds, so the steps should say so.
- **Keep the screen in proportion.** Every extra document adds claims that must match code that changes for 12 days, and the simulated jury's deciding objections were about the design, not the paperwork.
- **The Gauntlet's own check before submitting:** a fresh agent with no context reads the real README and answers five questions, missing at most one (playbook Appendix D):
  1. What is it?
  2. Who is it for?
  3. Why NEAR, and which part is load-bearing?
  4. Which tracks fit?
  5. What would you verify first?

---

## 5. Submission must-haves

### Eligibility (official; failing any of these means zero)
- [ ] **A public repository.** Its http(s) URL goes in the form, at most 300 characters. It must be public by Nov 14, 23:59 UTC, and it stays public through judging. Each repository can be submitted only once. Liam makes it public.
- [ ] **A LICENSE file.** Any license is accepted; MIT is fine.
- [ ] **An X post that Liam publishes from @itzbanknotez.** It must:
  - say the project was built at NEAR HACKATHON;
  - tag @NEARProtocol and #NEARHackathon (@NearLegion and @NearBuilders are optional);
  - attach the demo video. Q-012 says "screenshots are not enough when judges cannot open the demo".
- [ ] **The submission fields:**
  - project name (2–80 characters);
  - lead name;
  - contact email;
  - team size;
  - tracks;
  - a NEAR mainnet payout account (`bountee.near`, section 13);
  - repo URL;
  - X post URL;
  - a 20–2,000-character description of the problem, the product and how NEAR fits;
  - consent.
- [ ] **Submission mechanics:**
  - The `requestId` is generated once and reused on any retry.
  - The `website` field is a spam trap: anything in it rejects the submission.
  - The body is at most 12,000 bytes.
- [ ] **Built in the window,** with reuse disclosed. Code written from Oct 19 counts (Q-001). List libraries, templates and AI-written code in the README (Q-005).

### What judges reward in the repo (Gauntlet advice; where it lives is for the spec)
- [ ] An easy-to-find architecture diagram. The Gauntlet's judge model: "a tidy architecture diagram plus a real end-to-end path beats breadth".
- [ ] Demo steps with their expected outputs, including the path with no keys and no funds.
- [ ] A list of every deployed account and address, and every demo transaction, with explorer links.
- [ ] A threat model: what's verified, what's trusted, and how authority is scoped.
- [ ] Tests that pass, and one simple documented way to run the demo.

### README content
- [ ] One sentence on what it is and who it's for, then the problem.
- [ ] The NEAR features that do the work, named, and why NEAR, concretely. Not "powered by NEAR".
- [ ] "Do X → see Y" steps that a human or an AI agent can follow from a clean checkout. HACKATHON.md asks for this, and for no marketing.
- [ ] For each claim, where to check it: a file path, a test or a tx link, with the expected output.
- [ ] Limits in one compact "Not production-ready" list next to a "Verify it" list, after the proof. Simulated jurors Kain and Avichal credited this format; a first screen full of caveats reads as defensive.
- [ ] Prior art named, with one checkable difference and no "first" claims (section 8).
- [ ] An identifiable user and a route to them. A concrete sustainability section.
- [ ] Screenshots of anything a user sees.
- [ ] Disclosures:
  - libraries and templates;
  - AI-written code;
  - the Gauntlet's tests (Oct 31–Nov 2);
  - any pre-window code (Q-002);
  - the other project's name, if Liam enters a second one (Q-015).
- [ ] Every number re-measured and every link re-opened before it goes in.

### Repo hygiene
- [ ] Tests that include the cheats that must pay nothing (R3, R4).
- [ ] No mocks, TODOs or demo-only branches on the demo path.
- [ ] No secrets in the repo or its history. HACKATHON.md: "Keys belong in environment variables, never in the repository."
- [ ] Commits spread across the window, with meaningful messages.
- [ ] Tagged tracks that match the features actually used.
  - **Official:** list "every track the project fits".
  - **Gauntlet advice:** 2–4 tracks, never more.

### The human pass (Gauntlet advice, playbook §3–4)
- [ ] Can someone say what it is in one sentence?
- [ ] Does something real happen on screen in the first 90 seconds?
- [ ] Is it obvious why it needs NEAR?
- [ ] Is it honest, with nothing embarrassing?
- [ ] It isn't a recognizable clone, and it trips no judge's veto.

### Demo video and X post
- [ ] **Length (Gauntlet advice):** the X cut runs at most 2:20, and the real flow works on screen within the first 90 seconds.
- [ ] **The organizers' advice:**
  - lead with the user's problem;
  - show one complete moment, from a real user action to a visible result;
  - explain NEAR's role concretely;
  - no long intro, no architecture slides, no setup;
  - give a next step.
- [ ] **Integrity rules** (from the Gauntlet's earlier storyboard):
  - never type or fake terminal output;
  - never show a "Verified" or "Paid" that isn't driven by a real check or transaction;
  - no placeholder hashes, simulated attestations or transactions from another run;
  - the asset named on screen is the asset the replay measures.
- [ ] **Bank two complete real takes on different days,** since OutLayer or the network could be down on the day.
- [ ] **A note from the simulated jury.** Kain called a fake claim that pays nothing "the best moment in the demo", because it shows the AI-slop filter working.
- [ ] **Liam records and posts.** Agents may draft the text.

### Before sending
- [ ] Re-read the live HACKATHON.md.
- [ ] The repo is public and the X post is up.
- [ ] Liam confirms the exact payload. It is sent once, and it can't be edited.
- [ ] After submission, the project's name, tracks and demo link appear in the site's public directory.
- [ ] Any hosted demo stays up until Nov 18, ideally Nov 25.

---

## 6. Tests already run

All tests ran on testnets, with $0 of mainnet spend. Each describes throwaway code; the pitfalls they found are in section 7.

| # | Test | Date | Result |
|---|---|---|---|
| 1 | A NEAR contract gets Chain Signatures only when its own rule allows | Oct 31 | pass |
| 2 | A secret that only one exact program build can read (OutLayer keystore) | Nov 1 | pass |
| 3 | Replaying an exploit inside the enclave (Gauntlet label SG6) | Nov 1 | pass |
| 4 | A NEAR contract with no keys pays on a verified exploit (SG6b) | Nov 2 | pass |
| 5 | The circuit breaker, on Base Sepolia and Flare Coston2 (SG6c) | Nov 2 | Coston2 pass; Base Sepolia partial |
| 6 | Confidential Intents (private settlement) | Oct 31 | partial; access is gated |

Explorers:
- NEAR testnet: `https://testnet.nearblocks.io/txns/<hash>`
- Coston2: `https://coston2-explorer.flare.network/tx/<hash>`

### Test 1: Chain Signatures from a contract, gated by its own rule (Oct 31)
- **Why:** can a NEAR contract get MPC signatures for another chain only when its own rule holds? This is the feature under the circuit breaker.
- **Setup:** a small Rust contract on NEAR testnet with a spending cap, calling `v1.signer-prod.testnet`.
- **What ran:** one request within the cap and one over it.
- **Result: pass.**
  - The allowed request returned a signature that recovers to the contract's derived EVM address.
  - The over-cap request was refused, with no signature requested.
  - Transactions:
    - deploy: `7x2GCDj8Q5tGxrnCv8V6imWneYNojePGGWP2aCghPtN8`;
    - allowed: `3bNydC2Mf8YBJdoQchGNTfLeRrdW1g7hJyjQWj8q9vMq`;
    - refused: `FGr3TX59xopRJunpdLYmFWdS1gGhUjWh7NmmMLXkDSDH`.
- **Why it's useful:**
  - The MPC fee is 1 yoctoNEAR, and no API key or allowlist is needed.
  - Signing took about 5.5 s on chain.
- **Not shown:** a Base Sepolia broadcast (no test ETH).

### Test 2: a secret only one exact program build can read (Nov 1; run for another idea)
- **Why:** can OutLayer hold a key that only one pinned program build can use? Sealing (R5) needs something like this.
- **Setup:** OutLayer's keystore generated a secret inside its enclave, bound to a project. The test never saw the key.
- **What ran:**
  1. Five enclave jobs used the secret across separate runs.
  2. The secret was locked to one program build.
  3. A different build asked for it.
- **Result: pass.**
  - Once locked to a build hash, the secret was refused to the other build (tx `XhrcsEeV4AyFZ31A9Bj8ZxGs58YT1j6fgwNJKPV1zej`).
  - Before the lock, every version of the project could read it.
- **Not shown:**
  - a contract owning the secret;
  - encrypting the job's inputs and outputs, which are otherwise public on chain.

  Whoever owns the secret can remove the lock or overwrite the key.

### Test 3: replaying an exploit inside the enclave (Nov 1)
- **Why:** this was the riskiest piece. Can a full EVM run inside OutLayer's enclave and judge an exploit?
- **Setup:**
  - An 852,880-byte WebAssembly program embedding the revm EVM (version 43.0.3), registered on OutLayer testnet.
  - Snapshot: a deliberately broken 93-byte vault holding 10 ETH, whose withdraw has no owner check.
  - Loss rule: the vault must not fall below 5 ETH, except by paying its owner.
- **What ran:**
  - an exploit bundle (call `owner()`, then withdraw 10 ETH);
  - a harmless bundle (the owner withdraws 7 ETH);
  - a tampered snapshot;
  - size and limit probes.
- **Result: pass.**
  - Exploit → `INVARIANT_VIOLATED`, 10 ETH drained (tx `Eh3PvmqKWAuuLN1qrUbZJLfpDCHx1FxBQRdLLt92rwbF`).
  - Harmless → `NO_VIOLATION` (tx `5egqHh4DsEQSFqzrz1JmuPxyUBQP5NpfayuDA8Ccg9cs`).
  - The tampered snapshot was refused inside the enclave.
  - The attestation's input and output hashes recompute locally, and the TDX quote verifies (dcap-qvl: UpToDate).
  - A 56.5 KB snapshot holding a maximum-size contract and a 15.6M-gas loop also ran.
  - Each job took 16.6–24.3 s.
  - An independent check on Nov 2 found all 11 transactions with their recorded results. One, an underpaid probe, failed as recorded.
- **Why it's useful:** the core of the idea works on real infrastructure, and the timing sets the demo's pace.
- **Not shown:** see "Also unproven" in section 2.

### Test 4: a NEAR contract with no keys pays on a verified exploit (Nov 2)
- **Why:** can a contract nobody holds a key to order the replay itself and pay from the result?
- **Setup:** `escrow.sg6b-1793627514.testnet`, created with no access keys. It held:
  - 4 test NEAR;
  - the snapshot's hash;
  - the pinned replay program from test 3;
  - an 8 ETH tier and a 1 NEAR payout.
- **What ran:**
  - A separate account submitted a harmless bundle, a 6 ETH exploit (below the tier) and the 10 ETH exploit.
  - Then a resubmission, a malformed bundle, and two simultaneous exploit claims against a second contract.
- **Result: pass.**
  - The contract itself requested the replay and paid 1 NEAR in its callback on the 10 ETH exploit (tx `D2d5Rokz4PFryEBwCxzpoaHJZ7efLAtdNbWjD8NS5nSr`).
  - It paid nothing on the harmless bundle (`8mVxndBvxdfxHjNXNYAhaytR6Be1k63UEhENmocfEPZF`) or the below-tier one (`CSNdZZpxbP976aUH9R7jgiqRGKHYkbND6FjZ7oE5uSJL`).
  - The resubmission was refused, the malformed bundle was rejected, and the simultaneous claims produced one payout.
  - Every job's attestation verifies.
  - About 18–19 s per claim.
- **Why it's useful:** in the tested pattern there was no relayer, no server and no admin. OutLayer's operator stayed trusted (section 3).

### Test 5: the circuit breaker (Nov 2)
- **Why:** four jurors' top fix was to pause the vulnerable contract on its chains before paying. Liam asked for Base and Flare.
- **Setup:**
  - A new NEAR contract with no keys (`escrow.sg6c-1793631736.testnet`), with the same replay, tier and payout.
  - A minimal pausable vault, deployed on Coston2 and simulated on Base Sepolia. Its only pauser, the "guardian", is the EVM address that Chain Signatures derives for the NEAR contract: `0x4Eb15F8B2108e762D3E7fD122044E5BdAD691750`.
- **What ran:** harmless, below-tier and 10 ETH exploit claims. On the exploit, the NEAR contract:
  1. built both `pause()` transactions;
  2. had the MPC network sign them;
  3. checked that each signature recovers to the guardian;
  4. stored them for anyone to broadcast;
  5. then paid.
- **Result:**
  - **NEAR side: pass, in one transaction** (`BfMKgNu3mjHcN4kCCmRz35A8Ri7hFRT6f7BxLRAMUnhG`). The harmless claim (`EBdW7VtW9DnDyhmvwEdfAVSE7ZBooeqjwoA3brM1dbr7`) and the below-tier claim (`Cy9fDA8eFz3uoiHE86Uc1uiQDrSdG3rC28WgtjWZnXSr`) requested no signatures.
  - **Flare Coston2: pass.** Liam solved the faucet's CAPTCHA.
    - The vault `0x8ADeCFbb0b01876db913f5245D05D64BbFAE6Ba3` was deployed in tx `0x000078ebacf1b4263930e808091cf7d1e38e7ec66aaaffafd58e22ac6f6ba717`.
    - The NEAR-signed pause was broadcast unchanged by hand in tx `0xb585db9108529499fa132d7b0c79a633bb3879fd1d4ed66665e2c7f2174e20e8`, and `paused()` reads true.
  - **Base Sepolia: partial.** The pause is signed, recovers to the guardian and simulates correctly, but it wasn't broadcast: every Base Sepolia faucet needs a login.
  - About 21.8 s per claim with the breaker.
- **Why it's useful:** a NEAR contract that nobody holds a key to got a contract on another chain paused, from one verified exploit. The MPC network holds the signing key.
- **Not shown:**
  - **Different contracts.** The contract whose exploit was replayed (test 3's toy vault snapshot) is not the contract that was paused, which was a separate vault deployed for this test.
  - **Historical hacks.** A real historical hack can't be paused at all.
  - **The demo choice.** Making one contract both proven exploitable and paused is a choice the demo must make (open question 3).

### Test 6: Confidential Intents (Oct 31)
- **Why:** is NEAR Intents' private settlement usable? It matters because five jurors asked for a "quiet claim".
- **Result: partial.**
  - A user session and an empty confidential balance worked.
  - Every confidential quote needs a Partner JWT (a gated sign-up), and a swap needs mainnet funds.
  - Balances live on a permissioned NEAR fork with a private RPC.
- **Why it's useful:** Confidential Intents is one route to a quiet claim, but a gated, mainnet-only one. Other routes exist (section 9).

---

## 7. Constraints and pitfalls from the tests

- **Latency.**
  - Each enclave job took 16.6–24.3 s (test 3).
  - A claim through the contract took 17.8–19.0 s (test 4), or 21.8 s with two pause signatures (test 5).
  - The public NEAR testnet RPC added about 10 s per call (test 1).
- **Trust boundary in the tested pattern.**
  - The NEAR contract pays on whatever OutLayer's contract returns.
  - Only OutLayer's operator account can resolve a request, and OutLayer's contract has a full-access key, so it can be upgraded.
  - The attestation reveals a forged verdict afterwards; it doesn't prevent one.
  - The attestation names the claimant, not the bounty contract. Linking the two takes the request id and the transaction receipts.
- **Attestation lookup trap.** `testnet-api.outlayer.ai/attestations/<id>` expects the task id. Given a request id, it returns a different project's job.
- **Stuck funds.** A contract with no keys and no exit path keeps its funds forever.
- **Claim race.** In the tested pattern the first callback wins, not the first submission. Every claim admitted before the first verdict reveals its exploit and pays its fee.
- **Prepaid gas.**
  - NEAR charges prepaid gas up front, so a claimant attaching 300 Tgas needs at least 0.401 NEAR. About 100–120 Tgas was enough.
  - A short-balance transaction sent without waiting for the result was silently dropped.
- **The pause in the tested pattern.**
  - The guardian address pays its own gas on each chain, so it has to be funded in advance. It is derived from the NEAR contract's account name plus a path, so a new contract means a new guardian address.
  - A signed pause has its fee cap and nonce fixed at signing. Coston2's base fee (500 gwei) was 100,000 times Base Sepolia's (0.005 gwei). If a chain's fee rises above the cap, the transaction can't land.
  - A pause sent to an address with no code yet "succeeds" as a no-op and uses up the nonce. The NEAR contract can't see EVM state.
  - The payout didn't wait for signing to succeed.
  - OutLayer's operator could force a pause. That is a denial of service, not theft.
- **Base quirks.** Base charges an L1 data fee on top of the gas price, and its public RPC doesn't check the sender's balance in simulations. Coston2 does.
- **Unpausing.** A real vault needs a way to unpause, such as governance or a timelock.
- **Testnet funds:**
  - NEAR: the faucet is instant, with no sign-up.
  - Base Sepolia ETH: needs a faucet login, for example Coinbase's CDP portal, which gives up to 0.1 ETH a day.
  - Coston2: no account, but a browser CAPTCHA that Liam solves himself.
- **Versions that worked in the tests** (facts, not a stack decision):
  - revm 43.0.3 compiled to `wasm32-wasip1`;
  - near-sdk 5.30 (its `ecrecover` needs the `unstable` feature, and builds need `cargo near build`);
  - chainsig.js 1.1.16;
  - viem 2.57;
  - solc 0.8.28;
  - dcap-qvl 0.7.0.

---

## 8. Competitors and prior art

The AI judges will recognize much of this, so the README should name the nearest entries and state one checkable difference.

| Entry | What it is | Status | Facts that matter |
|---|---|---|---|
| **HoneyPause** | An "onchain exploit bounty tied to a circuit breaker". The exploit runs on chain inside a call that is then reverted, a protocol-written verifier checks invariants, and the protocol's pauser and payer run, all in one transaction. | A winner at ETHDenver 2024 (Identity, Privacy & Security track). Ethereum Sepolia; mainnet "TBD". | Closest prior art for the breaker. It works against live state, which the tested replay doesn't. The exploit is public once the claim lands. It pauses only its own chain. Co-author Lawrence Forman was described in 2024 as a security engineer at Dragonfly, judge Haseeb Qureshi's firm. |
| **Hydra** ("Enter the Hydra", Breidenbach, Daian, Tramèr, Juels; USENIX Security 2018) | N-of-N-version programming: several independent implementations of a contract, plus an "exploit gap" that enables "runtime detection, and rewarding, of critical bugs". | Academic. | Both AI personas cited it: contract-enforced automatic bounties have precedent. |
| **Sealed-Glass Proofs** (Tramèr, Zhang, Lin, Hubaux, Juels, Shi; EuroS&P 2017) | An enclave proves knowledge of a bug, and a smart contract handles the fair exchange for a bounty. | Academic (Intel SGX). | Jurors used it to cut originality: "enclave-proved bounty" isn't new. |
| **Zk Bug Bounty** (ETHPrague 2022) | A zero-knowledge proof of a hack pays the bounty and freezes the contract on a valid claim. | Hackathon entry; deployment not stated. | Another "verified claim → freeze" precedent. |
| **Bit Bounty** (2026) | An on-chain invariant check, run in a self-call that always reverts, pays the hunter atomically. | Base Sepolia. | On-chain, like HoneyPause. |
| **sealed-code-bounty** | A Solana bounty. Exploits are encrypted to a verifier key, and an AWS Nitro enclave (designed, not built) is meant to check them. | Its own note (Oct 9, 2026): "pre-production and not deployed". | Nearest in wording. No EVM replay, no pause. |
| **Mnemo** (Synthesis hackathon, Mar 2026) | A TEE-resolved bounty escrow with a researcher agent, on Phala TDX. | Base Sepolia. Its README says the attestation is simulated. Last transaction Mar 22. | Already describes "automatic" release on a TEE verdict. |
| **AntiSoon** (Chainlink hackathon, 2026) | Encrypted proofs of concept, replayed on Tenderly test networks through Chainlink's workflow engine. LLM and human jurors handle edge cases. | Sepolia and Oasis Sapphire. | Deterministic EVM replay. It names no TEE. |
| **jenzylove/exploit**, titled "Proof of Exploit" | ZK bug bounties on Midnight: "prove you can break a contract, get paid, and only then reveal how". | A live app. A 2023 Devfolio project also used the title. | Holds our old working name. |
| **zkPoEX** and related work | Zero-knowledge proofs of an exploit. | Hackathon prototypes (2022–23). | ZK instead of a TEE. |
| **judge-near** (this hackathon) | A deterministic judge on OutLayer TDX. A NEAR escrow calls OutLayer and pays or refunds in the callback. It claims the security track. | Its judge ran on OutLayer testnet. Its escrow's testnet deployment was "next" as of Nov 1. | Same pattern, for agent work. The red team called revm its "obvious next commit". |
| **PatchBond** (this hackathon) | Refundable bonds on pull requests, an AI judge in a TEE, and a sealed vulnerability-report route. | `patchbond-dev.testnet`. | The red team rated the race "about even": we're ahead on verifier depth, behind on maturity and on the AI theme. |
| **BattleChain** (found Nov 2; not yet examined) | "The pre-mainnet environment where protocols stress-test smart contracts with real stakes before going live." Ethical hackers, AI bots and researchers attack contracts that a DAO has approved as "attackable", under a Safe Harbor agreement. Protocols set the bounty terms. | The site says it is "under construction". It links to the CyfrinAudits YouTube channel and doesn't say who runs it or how payouts work. | It targets the same pre-launch market the jurors named as the first user. Check it before claiming that market. |
| **Incumbents** | Immunefi, Cantina, HackenProof, Code4rena, Sherlock and Hats (which said it would close its front end at the end of 2025). | Live. | People or committees decide payouts. SEAL Safe Harbor commits bounties in advance for rescues during live exploits. |

**In the window:**
- On Nov 2, a search of the site's project directory found nothing for "exploit", "bounty", "judge" or "PatchBond".
- The Gauntlet couldn't read GitHub, so the current state of judge-near and PatchBond is unknown. Re-check both, and the directory, during the build.

---

## 9. The judges, and what the simulated jury said

**The judges** (from nearhackathon.com): Claude Code and Codex screen every project first, and seven humans decide. The middle columns come from the Gauntlet's judge model, which is built from each judge's public statements.

| Judge | Rewards | Rejects | Simulated stance after deliberation |
|---|---|---|---|
| Illia Polosukhin (NEAR Protocol) | Real products where Intents, Chain Signatures or NEAR AI Cloud is load-bearing; a verification story; a distribution path | A technical solution before the problem; mocked "on NEAR" claims | Neutral (was champion). Would champion with the circuit breaker. |
| Eddy Lazzarin (a16z crypto) | Explicit, verifiable security boundaries; a README that separates verified from trusted | Implicit trust; claims that can't be checked | **Champion** |
| Mert Mumtaz (Helius; on the NEAR Foundation Council since Oct 15, per The Block) | Visible rigor (tests, invariants, a threat model); real on-chain activity with explorer links | Unverifiable claims; hand-waved metrics; janky data UX | **Champion.** Wants fuzz or property testing of the loss rule, "the whole security boundary". |
| Avichal Garg (Electric Capital) | An identifiable user and go-to-market; security rigor; a contrarian insight | "Who is the user?"; claims the repo doesn't back | Neutral (was champion). Wants a quiet claim. |
| Kain Warwick (Synthetix & Infinex) | Consumer-grade UX; a reason to switch; a happy path under a minute | Purist tech with no user story; agent fluff | Neutral. With the breaker, he said NEAR becomes a "yes" and he'd champion it. |
| Haseeb Qureshi (Dragonfly) | Crypto that is earned, not assumed; agents that protect the human; a threat model | "A primitive pretending to be a company"; farmed metrics | Neutral (was champion). Wants a quiet claim. |
| Stepan Gershuni (cyber•Fund) | Verifiable work receipts (TEE attestations or re-runs); agent identity and reputation | No validation of agent work | **Champion.** Named the breaker. |
| Claude Code and Codex (screen) | Claims that map to code; a runnable demo; tests; deployed addresses; named NEAR features | Vague READMEs; mocks; secrets; a single-dump history | Neutral. Claude's biggest objection was "why NEAR". After deliberation, Codex ranked the public bug signal first. Both warned the README must match the code. |

**Lines that bear on this idea** (from the profiles in `01_judges/profiles-and-panel.md`):
- **Mert** has written that AI-accelerated attacks will end crypto's "illusion of comfort": admin keys, controlled validator sets, emergency interventions. A pause is an emergency intervention. The difference to argue is that no person holds this one, and only a verified exploit triggers it.
- **Eddy:** "Vulnerabilities can be removed. They can be designed away."
- **Haseeb:** "I can have a look at your protocol and tell you if I was an attacker here's what I would do."
- **Illia:** "defining success criteria and verification methods" is the key skill for builders now.

**The simulated jury's objections:**
1. **Toy target.** Only a 93-byte hand-built vault has run, and the team plays every role.
2. **The public bug signal.** This was the top objection, raised by four jurors: a claim announces "this named contract has an unpatched critical bug".
3. **Why NEAR?** Why would a Base protocol fund a NEAR escrow?
4. **Prior art,** especially Sealed-Glass Proofs. Hydra came up from the AI personas, and HoneyPause was found later.
5. **Narrow scope:** single-sender drains, on a snapshot the protocol picks.
6. **Concentrated trust:** OutLayer, the enclave, the MPC network.
7. **Sanctions and KYC.** Paying anonymous addresses automatically runs into protocols' OFAC and KYC practice. Four personas raised it: Claude, Codex, Haseeb and Stepan.

**Fixes they asked for:**
- **The circuit breaker** (Illia, Kain, Stepan, Codex): proven on Coston2 (test 5).
- **A quiet claim** (Eddy, Mert, Haseeb, Avichal, Claude): keep the bug private through a fixed patch window that the protocol can't cancel.
  - **Avichal's version needs no Intents:** the claim is recorded on chain only as a blinded commitment, and it pays out automatically after the window.
  - **Others proposed Confidential Intents,** which test 6 found gated and mainnet-only.
- **Counters to the "toy" reading** (viability probe):
  - replay a real historical exploit from a fork at the pre-hack block;
  - get an outside claimant before Nov 14 (ruled out by Liam, Nov 2);
  - have an AI agent claim with no human triage;
  - abuse tests (a depositor's withdrawal, an owner's rescue, a sweep and a fake bundle all pay nothing);
  - a time-and-cost comparison with the incumbents;
  - a named security lead's commitment to post a bounty (ruled out by Liam, Nov 2).

---

## 10. Hackathon facts

Source: https://nearhackathon.com/HACKATHON.md.
- A snapshot was taken Oct 31 and re-checked on Nov 2 at about 21:00 UTC.
- The only change was one partner row added (Gulf Labs).
- The site also added a public project directory.

Re-read the rules before submitting.

- **Goal (Liam):** 1st place in the security track. The Gauntlet's advice is to aim for 1st in one or two fitting tracks, with the grand prize as the stretch.
- **Primary track: security, "AI Security & Defense"** (tagline "Trust, but verify").
  - **Official text:** "Build spending limits, policy engines, sandboxed wallets, reputation and scam detection. Give AI money without giving it the keys to everything."
  - **Hints:** AGENT SECURITY, FUNCTION CALL KEYS, TEE ATTESTATION.
  - **The security prompt's "start here" links:**
    - NEAR access keys;
    - OutLayer getting started;
    - NEAR AI Cloud verification;
    - Agent API policies and limits.
  - **Fit:**
    - The tagline and the TEE ATTESTATION hint fit.
    - The main line is about limiting what AI agents can spend, which this isn't.
    - The AI angle is so far only a narrative (R14).
    - The one-liner leads with "bug bounties", not with AI security.
- **Crowding.**
  - The Gauntlet forecast about 320 security entries (range 210–430), dominated by agent spending firewalls, limit vaults and scam checks.
  - The live directory on Nov 2 (68 projects, about 35 tagged security) bears that out.
  - The Gauntlet's clone baselines for security: a counterparty check for paying agents (the most likely), an attested agent firewall (the strongest), and a spending-limit vault (the cheapest).
- **Other tracks:**
  - **Privacy** ("confidential computation … TEE") is the best literal fit, but only once the exploit is sealed.
  - **Open** is the catch-all, and prior art weakens it.
  - **DeFi**'s build line (exchanges, perps, lending, vaults, trading agents settling through Intents) doesn't describe this, though its hints include CHAIN SIGNATURES, which the breaker uses.
  - Before the breaker, the simulated jury ranked it about 6th–9th of 50 in open and 16th–30th in defi.
- **Rules that shape the build:**
  - **Q-001:** code from Oct 19 counts; earlier commits are baseline.
  - **Q-002:** an existing product on another chain is allowed, but only the NEAR integration built in the window is judged.
  - **Q-005:** libraries, templates and AI-written code are allowed, and must be listed in the README.
  - **Q-007:** Intents has no testnet.
  - **Q-010:** testnet-only projects are eligible in all tracks, with mainnet only where an integration is mainnet-only.
  - **Q-011:** no integration is mandatory.
  - **Q-012:** a local-only demo is fine with a reproducible README and a video. A hosted demo is a plus.
  - **Q-015:** at most two different projects per person, each README naming the other.
- **Judging:**
  - The site's FAQ: "Previous NEAR hackathons evaluated technical implementation, design, impact, originality and sustainability — a good guide to prepare by." It states no weights.
  - The Gauntlet found that past NEAR rubrics weighted the five equally, and defined impact to include being open source.
  - Its reading: a project with nothing usable to see loses ground on design.
- **Prizes:**
  - $250k in total. The grand prize is $55k.
  - Each of the 13 tracks pays $10k, $3k and $2k.
  - Prizes are paid in NEAR, as a single payment within 30 days of results (Q-016).
- **Never without the human's confirmation** (HACKATHON.md):
  - sending the submission;
  - posting on X or another network;
  - making the repo public, pushing or force-pushing;
  - "Sign transactions, spend tokens or deploy to mainnet";
  - committing secrets.

  The standing rules for this repo are in section 13.

---

## 11. Dates

**Hard dates (UTC).** US Eastern time is UTC−5 from Nov 1.

| What | When |
|---|---|
| Code counts from | Oct 19 |
| Hackathon starts, submissions open | Sun Nov 1, 00:00 UTC |
| Repo public and submission sent | by Sat Nov 14, 23:59 UTC (6:59 pm EST). The API refuses submissions after that. |
| Judging starts | Mon Nov 16, 00:00 UTC |
| Results | by Wed Nov 18, 23:59 UTC |
| Any hosted demo stays up | until Nov 18, ideally Nov 25 |

**Suggested checkpoints** (Gauntlet playbook, re-cut on Nov 2; Liam can override them):

| When | Checkpoint |
|---|---|
| Mon Nov 2 – Tue Nov 3 | Day 0 (section 13). |
| Early, before or just after the spec | Re-run the simulated jury and a cold read on the circuit-breaker version; it has never been scored. |
| Thu Nov 5 | **Day-3 go/no-go:** one end-to-end path with a real on-chain action, run from a clean checkout by the README's steps. Liam's recorded fallback if it fails: cut the circuit breaker and keep the core bounty (open question 12). This checkpoint doesn't test sealing. |
| Sun Nov 8 | Demo-ready. Re-run the simulated jury, including the AI personas, on the real repo. |
| Wed Nov 11 | Feature freeze. |
| Thu Nov 12 | Video. Five-question cold read of the real README (section 4). |
| Fri Nov 13 | Submit. |
| Sat Nov 14 | Spare day. |

---

## 12. Open questions

These are for the grilling session. None is decided unless noted.

1. **Name: decided.** BounTEE (Liam, Nov 2), tagline "Confidential bounTEEs". A quick web search on Nov 2 found no crypto project using it, and it isn't in the hackathon's project directory. Still to check: GitHub, X, domains and the matching NEAR account name.
2. **The first user.** Pre-launch code has nothing live to pause, while the breaker and the NEAR case need a live protocol on two or more chains. Who is the demo's user, and who does the README say it is for?
3. **Demo realism.**
   - The jury's main "toy" counter is replaying a real historical exploit, but a historical hack can't be paused.
   - In test 5, the contract whose exploit was proven was not the one paused.
   - What does the demo prove, against which contract? Does the scope need to grow beyond single-sender, snapshot and native-coin loss?
4. **Chains.** Which chains does the demo pause on? Coston2 is proven, Base Sepolia needs test ETH, and anything else is untested.
5. **The bounty money.** Where does it live, in what asset, and on which chain? The tests paid in test NEAR, and "why would an EVM protocol fund on NEAR?" is still open.
6. **The public bug signal.** Is sealing plus the pause enough, or is a quiet claim with a patch window needed? Five of nine jurors asked for one. Avichal's version needs no Intents, and Confidential Intents is gated and mainnet-only.
7. **Trust in OutLayer.** Reduce it, or state it plainly? All nine jurors noted it, and three (Eddy, Mert, Stepan) asked for the contract to check the enclave's signature itself.
8. **The AI angle.** How does R14 become real? The security prompt points to function-call keys, NEAR AI Cloud verification and the Agent API, and none is used yet.
9. **The AI screen.** How does a screener with no keys and no funds check the whole flow, including the pause?
10. **Who may post, and who gets paid.**
    - How is R12 (only the target's controller can post a bounty) enforced?
    - What is the stance on sanctions and KYC for automatic payouts?
11. **Interfaces.** What does each user touch: the protocol, a human whitehat, an AI-agent whitehat, and anyone verifying (judges, the AI screen)? Earlier drafts assumed specific interfaces, but none was built or decided. Design is one of the five criteria.
12. **Scope and cuts.** What's the minimum that still wins?
    - The recorded fallback (Liam, Nov 2) cuts the breaker first.
    - Weigh that: the breaker is the best-proven new piece and the main NEAR argument.
    - Meanwhile sealing (R5), the theft-only rule (R4) and real-state replay are unproven core links with no cut order yet.
13. **Originality.** The difference that survives the prior art is a sealed exploit, replayed against committed EVM state in an attested enclave, that triggers MPC-signed pauses on several chains before payout. It holds only once sealing ships. Is that the claim?

---

## 13. Day 0 and working rules

**About the team** (from `00_brief/operator.md`):
- **Who does what.** Liam doesn't implement. Claude Code designs, builds and tests end to end. Liam checks that the product works as agreed in the requirements, reviews the UX and UI, and makes the gate decisions. He has 1–3 hours a day for this.
- **Liam's timezone:** America/Toronto.
- **GitHub account for the public repo:** `Vasqq`.
- **X account for the demo post:** @itzbanknotez. Liam builds in public every few days and posts himself.
- **Hosting for a live demo, if there is one:** Vercel or Netlify by default.
- **Budgets:**
  - $50 for mainnet testing;
  - tens of dollars for inference or cloud, more case by case if you ask Liam with a specific amount and reason.
- **Prior work:** AgentVault, 1st place at a Flare confidential-compute hackathon (summer 2026). The Gauntlet's notes describe it as separating an agent's ability to request a payment from the authority to sign it; Liam's own description and the repo link were never added. Any reused AgentVault code must be disclosed as baseline (Q-002, Q-005).
- **Demo:** Liam will narrate the video and appear on camera for a short intro.
- **Mainnet appetite:** open where the risk is small and the verification value is high. Otherwise testnet, with the reasoning stated in the README.

**Things only Liam can do:**
1. **The payout account: done.** `bountee.near` on NEAR mainnet (Liam, Nov 2, created in Meteor Wallet). A mainnet RPC check the same day showed that it exists, with one full-access key and 0 NEAR, which is fine for receiving the prize. It also fits the submission field's format.
2. **The repo.** The local folder is `bounTEE` in Liam's `code` folder, and the GitHub repo goes under `Vasqq`. It can stay private while building; making it public needs Liam's yes.
3. **Standing rules: decided** (Liam, Nov 2).
   - Agents may sign testnet transactions without asking each time.
   - Pushing committed code needs Liam's yes every time. There are no automatic pushes.
   - Mainnet, publishing and submission still need his explicit yes (below).
4. **Testnet gas for whichever EVM chains the demo uses:**
   - Base Sepolia ETH from a login faucet;
   - Coston2 C2FLR from https://faucet.flare.network/coston2, with the CAPTCHA solved by Liam.

   New addresses need their own funding.
5. **Outside parties: decided** (Liam, Nov 2). There will be no outside claimant and no security lead. The demos have to be crafted well and tell a good story.

   Of the jury's "toy" counters (section 9), these remain:
   - the historical-exploit question (open question 3);
   - a real AI-agent claim (R14);
   - the abuse tests;
   - the comparison with the incumbents.
6. **Submission details:** team size, lead name, contact email, and whether to enter a second project (Q-015).
7. **X:** @itzbanknotez is confirmed for the demo post.

**Working rules carried over from the Gauntlet run:**
- **Testnet by default.** Testnet transactions need no confirmation. Each push of committed code needs Liam's yes. No mainnet deploys, transactions or spending, X posts, publishing or submission without Liam's explicit yes. Q-010 allows mainnet only where an integration exists only on mainnet. The Gauntlet's mainnet test budget was $50.
- **No secrets in the repo.** Keys go in environment variables. The Gauntlet's test-wallet key never enters this repo.
- **No personal data** (such as Liam's email) in any request, URL or header.
- **Never bypass a CAPTCHA or bot check.** Liam handles those.
- **Claims match the code,** and every number and link is re-checked before it goes in.
- **Independent reviews (suggested).** The Gauntlet used fresh-context agents for cold reads, red teams and jury simulations, so that reviewers didn't inherit the builder's conclusions.

---

## 14. Where the evidence lives

These files are in the claude.ai project "NEAR Hackathon Nov 2026". A build agent can read them only if the project is connected to its session.

- **`06_validation/IDEA-906/`:**
  - `feasibility-spike.md` (test 3), `feasibility-spike-sg6b.md` (test 4) and `feasibility-spike-sg6c.md` (test 5);
  - `probe-summary.md`, `probe-factcheck.md`, `probe-near.md` (why NEAR) and `probe-viability.md` (market and sources);
  - `prior-art.md`, `red-team.md` (attack paths A–E) and `judge-sim.md`;
  - `demo-storyboard.md`. It was written for the earlier design; its integrity rules still apply.
- **`06_validation/IDEA-515/feasibility-spike.md`:** test 2.
- **`02_stack/touch-tests.md`:** tests 1 and 6.
- **`_work/p9/out/`:** the nine simulated jurors' scorecards, with their deliberation.
- **`01_judges/profiles-and-panel.md`:** the judge profiles, including §8 on the AI judges. Read it before writing the README.
- **`01_judges/scoring-model.md`:** the judge model and the veto table.
- **`playbook/gauntlet-system.md`:** §2–4 cover the Gauntlet's model of the hackathon, the judges and a winning submission.
- **`03_landscape/crowding-forecast.md`:** track crowding and clone baselines.
- **`_work/HACKATHON.live.md`:** the Oct 31 rules snapshot.
- **`07_portfolio/decision-log.md`:** every decision, including the row "G7b · Liam's pick" (Nov 2).

**The test code** isn't in the project. The playbook says the build starts fresh and the README discloses the tests. A copy without keys can be provided for reference if wanted.

**About older documents.** `brief.md`, its README skeleton and the "distinguishing sentence" in `prior-art.md` describe an earlier design, in which the whitehat runs the replay and the contract checks an enclave signature. The tests used a different pattern. Treat that text as history, not a decision.
