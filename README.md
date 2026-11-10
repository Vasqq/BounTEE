# BounTEE

**Bug bounties that pay the Whitehat the moment their exploit is proven, and pause the bug on every chain before anyone else can use it.**

A Protocol posts a bounty in USDC on a NEAR contract that nobody holds a key to. A Whitehat (a person, or an AI agent with a key that can only file claims) writes the exploit as a Foundry script, seals it on their own machine and files a claim on whichever covered chain the exploit works on. An enclave replays it against that chain's recent state. If fresh accounts walk away with at least the bounty's minimum theft from the covered contracts there, NEAR Chain Signatures signs a pause for every covered contract on every chain, the Whitehat is paid the whole bounty, and only then can the Protocol open the exploit. Anyone can check all of it afterwards, with no keys and no funds.

Built for the NEAR hackathon, security track.

**Who it's for.** Protocols that want bug reports which are proven, not argued about. Whitehats and their AI agents who want to be paid without handing over their leverage first. Verifiers (judges, a Protocol's community) who want to check that a bounty ran by its rules.

## The problem

- **Protocols triage noise.** Most bug reports don't reproduce, and AI now writes them for free.
- **A real report is a public pointer to the bug.** The contracts stay exposed on every chain until someone reads it and acts.
- **Whitehats lose their leverage.** They hand the exploit over before they are paid; after that, severity can be downgraded and payment delayed.

## Why NEAR

The core promises rest on things only NEAR provides. Each is backed by a mainnet transaction from the demo bounty.

| Promise | What on NEAR does it | Mainnet evidence |
|---|---|---|
| Nobody can take the bounty or block a valid payout: not the Protocol, not the Whitehat, not us (R2) | A **keyless contract**, `bounty2.bountee.near`, holds the USDC and the right to request pauses. Its account has no access keys, so only its code can move funds. | Deployment and key removal: _pending mainnet run_ <!-- MAINNET: contract deploy tx; access-key deletion tx --> |
| One proven exploit pauses the bug on every chain at once (R7.1) | **Chain Signatures**: the contract asks NEAR's MPC network to sign a `pause()` from the bounty's own address on Base and on Arbitrum. No one holds that key. | Pause signing: _pending mainnet run_ <!-- MAINNET: sign-pauses tx --> · Pause on Base: _pending_ <!-- MAINNET: Base pause tx --> · Pause on Arbitrum: _pending_ <!-- MAINNET: Arbitrum pause tx --> |
| A pause shown as "verified" really landed (R7.10) | **MPC foreign-chain transaction verification**: NEAR's MPC network checks the pause on Base and Arbitrum and the contract records it on NEAR. | Verified pauses: _pending mainnet run_ <!-- MAINNET: verify-pause tx (Base); verify-pause tx (Arbitrum) --> |
| An AI agent can claim and be paid without holding the Whitehat's money keys (R14.2) | A **function-call access key** limited to the contract's two claim methods. NEAR itself refuses anything else signed with it. | Claim key added: _pending_ <!-- MAINNET: key add tx --> · Agent's claim: _pending_ <!-- MAINNET: agent's submit_claim tx --> · Payout: _pending_ <!-- MAINNET: payout tx --> |
| The exploit stays sealed until the payout (R5) | **OutLayer** runs the judge in an Intel TDX enclave, and only jobs the keyless contract requests can open a sealed exploit. | Attestation for the winning claim: _pending mainnet run_ <!-- MAINNET: OutLayer attestation link for the winning claim --> |

## Try it: no keys, no funds, no network

You need Node 22.18 or later, pnpm, the Rust toolchain in `rust-toolchain.toml` with the `wasm32-wasip2` target, and [wasmtime](https://wasmtime.dev). From the repo root:

```sh
pnpm install
cargo build --release -p bountee-judge --target wasm32-wasip2   # the judge the enclave runs
alias bountee='node cli/src/main.ts'   # in a script, use `pnpm bountee` instead
```

Each step below is a command and what it prints. They replay recorded jobs (the exact judge input: a block header, its state proofs and the exploit, all committed in the repo) through the judge compiled from this repo. The enclave's build differs from yours only in the bounty contract it answers to, so `bountee test` notes that yours is "not the bounty's pinned build", and `--judge` runs any build. They spend nothing and send nothing.

**1. A real exploit of the demo vault pays.** Fresh accounts walk away with the vault's USDC.

Steps 1 and 2 replay jobs recorded on the earlier demo vault (`demo/src/DemoVault.sol`). The live demo bounty now covers the position vault (`demo/src/PositionVault.sol`); its jobs replace these once the mainnet run records them (#35).

```console
$ bountee test --job demo/fixtures/exploit.json
verdict: PAYS (minimum_theft_reached)
```

**2. A cheat pays nothing.** A fresh account deposits and withdraws its own money: funds leave the vault, but nothing is stolen.

```console
$ bountee test --job demo/fixtures/cheat.json
verdict: ZERO (below_minimum_theft)
```

**3. The judge isn't tuned to our demo.** Three [Damn Vulnerable DeFi](https://www.damnvulnerabledefi.xyz) v4 levels, each with an exploit that pays and a cheat that doesn't.

```console
$ bountee test --job demo/fixtures/dvd/truster-exploit.json
verdict: PAYS (minimum_theft_reached)
$ bountee test --job demo/fixtures/dvd/truster-cheat.json
verdict: ZERO (below_minimum_theft)
$ bountee test --job demo/fixtures/dvd/side-entrance-exploit.json
verdict: PAYS (minimum_theft_reached)
$ bountee test --job demo/fixtures/dvd/side-entrance-cheat.json
verdict: ZERO (below_minimum_theft)
$ bountee test --job demo/fixtures/dvd/puppet-exploit.json
verdict: PAYS (minimum_theft_reached)
$ bountee test --job demo/fixtures/dvd/puppet-cheat.json
verdict: ZERO (below_minimum_theft)
```

**4. A real historical hack pays.** The June 2023 DEPUSDT/LEVUSDC hack, replayed against Ethereum mainnet's real state at block 17,484,161, the block before it.

```console
$ bountee test --job cli/test/fixtures/historical/depusdt-levusdc.json
verdict: PAYS (minimum_theft_reached)
block: 17484161
```

**5. The payout rule, case by case.** The judge's scenario tests: a depositor's own withdrawal, an owner rescue, a public sweep, a flash loan, a reentrancy theft, a mint, a forged owner transaction, an unproven read, a score just below and exactly at the minimum theft, and more (the table under R4.10 in [docs/requirements.md](docs/requirements.md)).

```console
$ cargo test -p bountee-judge --test seam_j_scenarios
test result: ok
```

**Check every step at once.** `node scripts/check-readme-steps.ts` runs each step in this README and checks that its output shows what is written here.

## Run the tests

`pnpm test` runs every suite. Each suite names the requirements it proves (see "How to read the tables" in [docs/requirements.md](docs/requirements.md)). The suites and their times in CI:

| Suite | Command | Proves | Time |
|---|---|---|---|
| formats | `pnpm test:formats` | Rust and TypeScript read the same formats | under 1 min |
| j | `pnpm test:j` | the judge's payout rule, scenario by scenario | about 3 min |
| t | `pnpm test:t` | the command-line tool, against local stand-ins | about 3 min |
| w | `pnpm test:w` | the web app | under 1 min |
| e | `pnpm test:e` | the demo contracts | under 1 min |
| c | `pnpm test:c` | the bounty contract, in NEAR's sandbox | about 40 min |

Beyond "Try it" above, the full run needs [cargo-near](https://github.com/near/cargo-near), [Foundry](https://getfoundry.sh) and Playwright's Chromium (`pnpm --filter @bountee/web exec playwright install chromium`). The contract builds with its own Rust 1.86.0 (`contract/rust-toolchain.toml`), which rustup installs on first use. For a quick check, `pnpm test:j` and `pnpm test:t` need nothing beyond "Try it".

The command-line tool reads three environment variables, all optional: `BOUNTEE_CONTRACT` (the bounty contract, in place of `--contract`), `BOUNTEE_CREDENTIALS_DIR` (where account keys are, in place of `~/.near-credentials/<network>`) and `BOUNTEE_WALLET_KEY_FILE` (the Protocol's EVM key file, for `open-exploit`).

## Check the mainnet demo: no keys, no funds

These need the network.

**The bounty contract holds no keys.**

```console online pending
$ curl -s https://free.rpc.fastnear.com -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"bounty2.bountee.near"}}'
"keys":[]
```

**Everything about the demo bounty checks out.** This one also needs Docker, for the reproducible build. `verify` rebuilds the contract and the judge from this repo and compares their hashes with what ran, checks the enclave's attestation against Intel's certificates, the payout, each pause's landing and its verified record on NEAR, and re-runs the published exploit.

```console online
$ bountee verify <MAINNET: demo bounty id> --contract bounty2.bountee.near --network mainnet
pass contract_code
pass judge_build
pass attestation
pass payout
pass pause_landed
pass pause_verified
pass rerun
```

There is no live bounty for you to win. A win closes its bounty and pauses its vault, so every winning run uses a fresh instance, deployed and posted by `cli/test/testnet/fresh-instance.ts` (with `NETWORK=mainnet` for the demo).

## Try it on testnet

The same web app also runs as a testnet site, on NEAR testnet, Base Sepolia and Arbitrum Sepolia, with no real money. Its address isn't set yet: it isn't hosted, and this section will name it once it is. Its bounty contract is `bounty2.bountee.testnet`, which takes Circle's testnet USDC and holds no keys. Its bounty list holds bounties from made-up Protocols in each state that lasts: Live, Live with claims judged, Paid, Ended unclaimed, Withdrawn and Check failed (seeded by `cli/test/testnet/site-seed.ts`).

To post a bounty there, you need MetaMask, testnet NEAR (`bountee init` creates a testnet account funded by NEAR's faucet), test USDC ([Circle's faucet](https://faucet.circle.com)) and a pausable contract you control on Base Sepolia or Arbitrum Sepolia. To claim from the command line, run `bountee init` for a testnet account, then `bountee test` and `bountee claim` against a Live bounty with `--contract bounty2.bountee.testnet --network testnet`.

Nothing on the testnet site is evidence for anything in this README. Every proof cited here is a mainnet transaction.

## Not production-ready

- Not audited by a third party. Our own audit of the whole contract, on the build first deployed as `bounty.bountee.near`, found no critical or high issues, and its five known issues are listed in [docs/audit.md](docs/audit.md). `bounty2.bountee.near` is that build plus the any-chain changes, which that audit didn't cover. The five stay unfixed in the demo, because the deployed build must be the one the full rehearsal ran.
- The contract has no admin and can't be upgraded. A bounty whose pause signatures can never be made (if NEAR's MPC network changed its interface), or whose winner Circle has blocklisted, stays stuck, and its USDC stays locked.
- The bounty contract trusts OutLayer's verdict; it doesn't check the enclave's attestation itself. Anyone can check it afterwards with `bountee verify`.
- One payout per bounty, EVM chains only. A claim is proven on one covered chain, any of them; an exploit that needs two chains' state at once can't be judged.
- The demo bounty is deliberately small: 10 USDC, with 2 USDC in each chain's vault, so a theft on either chain can reach the 1 USDC minimum theft.

## The mainnet demo bounty

One bounty, one story: an independent AI agent, given only [docs/agent-instructions.md](docs/agent-instructions.md) and a claim key, found the demo bug and won. A cheat claim on the same bounty scored zero first. A person claims with the same commands, using their own key.

The bounty contract is `bounty2.bountee.near`. An earlier deployment, `bounty.bountee.near` (Nov 7), pins the earlier judge, under which each bounty names a single proof chain; it holds no keys and can't be upgraded, so it stays unused.

| Step | Mainnet transaction |
|---|---|
| Bounty contract deployed (`bounty2.bountee.near`) | _pending_ <!-- MAINNET: deploy tx --> |
| Judge build pinned by `bounty2.bountee.near` | _pending_ <!-- MAINNET: judge build hash --> |
| Demo vault on Base | _pending_ <!-- MAINNET: Base vault address --> |
| Demo vault on Arbitrum One | _pending_ <!-- MAINNET: Arbitrum vault address --> |
| Bounty posted (10 USDC, minimum theft 1 USDC) | _pending_ <!-- MAINNET: post tx --> |
| Cheat claim judged ZERO, nothing moved | _pending_ <!-- MAINNET: cheat claim tx; its verdict tx --> |
| Agent's claim, filed with a claim key, judged PAYS | _pending_ <!-- MAINNET: agent claim tx; verdict tx --> |
| Pauses signed | _pending_ <!-- MAINNET: sign-pauses tx --> |
| Whitehat paid 10 USDC | _pending_ <!-- MAINNET: payout tx --> |
| Pause landed on Base | _pending_ <!-- MAINNET: Base pause tx --> |
| Pause landed on Arbitrum One | _pending_ <!-- MAINNET: Arbitrum pause tx --> |
| Pause verified on NEAR, Base | _pending_ <!-- MAINNET: verify-pause tx, Base --> |
| Pause verified on NEAR, Arbitrum One | _pending_ <!-- MAINNET: verify-pause tx, Arbitrum --> |
| Exploit published after its disclosure delay | _pending_ <!-- MAINNET: publish tx --> |
| Winnings withdrawn to Base through NEAR Intents (`bountee withdraw`) | _pending_ <!-- MAINNET: withdraw deposit tx on NEAR; delivery tx on Base (D12) --> |

## Threat model

### What counts as an exploit

One rule. A claim names its **proof chain**, any chain the bounty covers, and a recent block on it. Replay the claim's transactions, sent only by fresh accounts, against the proof chain's state at that block. **Gain** is what the fresh accounts (and contracts they create) end up holding, minus the seed they started with. **Loss** is what the covered contracts on the proof chain lost. Both count only the tokens listed on the proof chain, at prices fixed when the bounty was posted. The score is the smaller of the two; at or above the minimum theft it **PAYS**, below it scores **ZERO**, and a malformed claim, a transaction from an existing account, or a read of state the claim didn't prove is **INVALID**. A win pauses every covered contract on every covered chain, whichever chain it was proven on.

So a depositor's own withdrawal, an owner rescue, a sweep to the treasury, a swap or flash loan in a pool the bounty doesn't cover, and an unsold mint all score zero. Theft from the covered contracts is the only thing that pays.

### Who you trust, and what each could do

| Party | Trusted for | If it misbehaved |
|---|---|---|
| **OutLayer** (its operator, its upgradeable contract, and the one-member DAO that governs its keystore and approves enclave builds) | Running the pinned judge in the enclave and returning its verdict; opening sealed exploits only in jobs the bounty contract asks for | Could forge a verdict: the worst that does is pause the covered contracts and pay one bounty. Could read sealed exploits, or refuse to run jobs (claims then wait, unpaid and unjudged). A forged verdict is caught after the fact by the attestation, the rebuilt judge hash and the re-run of the published exploit (`bountee verify`). |
| **Intel** (TDX hardware and attestation) | The enclave really isolates the judge, and its attestation is genuine | A broken enclave or forged attestation could leak sealed exploits or forge verdicts, with the same worst case as above. The re-run of the published exploit doesn't depend on Intel. |
| **NEAR's MPC network** (Chain Signatures and foreign-chain verification) | Signing the bounty's pauses, and checking that they landed | Could sign other transactions from a bounty's pause address, but the pause role can only pause: it can't unpause or move funds. Could refuse to sign (a winning claim waits, unpaid), or record a pause as verified that didn't land (the payout never depends on it, and anyone can check the chain). |
| **The RPCs pinned in the judge's build** (three per chain; at least two must answer and all answers must agree) | Confirming the claim's block hash, and reading each chain at posting | Two colluding RPCs, with the third unreachable, could confirm a fake block, letting a claim be judged against invented state: a forged verdict. One RPC alone can only stall a claim. |
| **NEAR** (its validators) | Running the bounty contract as written | The same trust as any NEAR contract. |
| **Circle** (the USDC issuer) | USDC keeps its value and stays transferable | Could blocklist the bounty contract or the winner on NEAR's USDC (its contract has `blocklist` and `is_blocklisted`), freezing their USDC. |
| **BounTEE's builders** (us) | Nothing after deployment | The contract holds no keys, so we can't move funds, pause, or change a bounty's rules. We chose the judge and its pinned RPCs at deployment; both are open source here, and `verify` rebuilds them and compares the hashes that ran. |
| **The Protocol** | Its own contracts | Can revoke the pause role, upgrade its contracts or fix the bug: a valid claim is still paid, and a fixed bug stops being claimable 5 minutes after the fix lands. Can't withdraw the bounty before its end date or while a claim is unresolved. A Protocol insider planting a bug and claiming it themselves is not something BounTEE can prevent, as on any bounty platform. |

Nobody needs to trust the Whitehat, the broadcaster of a signed pause (anyone can send it; nobody can change it) or the explorer `verify` uses to find transactions (every transaction is read again from NEAR RPC).

### Timing

- **Recency window: 5 minutes.** A claim is judged against its proof chain's state at a block no more than 5 minutes older than the claim. A bug the Protocol fixes itself on a chain stops being claimable there 5 minutes after the fix lands; it stays claimable on a chain where it isn't fixed.
- **Verdict to pause: measured on the mainnet run.** A PAYS verdict is public on NEAR, so from that moment a watcher knows a covered contract has a bug, though not what it is, until the pauses land. On the demo bounty that window, from the PAYS verdict to the last pause landing, was _pending mainnet run_ <!-- MAINNET: verdict-to-last-pause-landed, in seconds (R7.8) -->. From the verdict to the last verified pause took _pending mainnet run_ <!-- MAINNET: verdict-to-last-verified-pause, in seconds -->.

### Stated limits

- **A pause protects only the covered contracts.** Copies of the same code deployed elsewhere stay exposed.
- **Publishing the exploit exposes those copies further.** Winning exploits are published after the disclosure delay the Protocol chose at posting (1–90 days).
- **Payouts are open to anyone, with no identity check.** No allowlist, no KYC. Circle, USDC's issuer, can blocklist an account on NEAR's USDC, which would freeze a sanctioned winner's payout.
- **A Fake poster can still post a bounty on a copy of someone else's code.** Granting the pause role proves control of the covered contracts, not authorship of the code in them.
- **A failed claim reveals its read set, never its exploit.** The claim's proofs go on NEAR, so anyone can see which fresh addresses and storage slots it touched.
- **"Paused" means the pause transaction succeeded on that chain, as verified by NEAR's MPC network.** It is not a claim about what the contract's code does when paused.
- **The replay doesn't reproduce every chain exactly.** On Arbitrum, the chain's block-number opcode returns an Ethereum block number where the replay returns the Arbitrum block's own, and Arbitrum's system contracts (such as `ArbSys`) and Stylus (WebAssembly) contracts don't exist in the replay. Base runs Osaka's opcodes, but its claims are still replayed under Prague's rules. So on Arbitrum a contract that reads the block number, calls a system contract or is a Stylus contract, and on Base a contract that uses Osaka's opcodes, may replay differently from how it runs on the chain.

### Coverage limit

**Only contracts that pay nothing to callers by design can be covered.** An AMM pool, a lending market that pays liquidation bonuses, or a contract that pays keeper rewards hands value to fresh accounts as part of normal use, so the rule would count it as theft. Cover the contracts that hold funds and pay out only to their owners; such pools can still appear in an exploit as dependencies, where value taken from them never counts.

Also out of scope: bugs where nobody profits (locked funds, denial of service, insolvency), attacks needing several blocks or time to pass, attacks needing a victim's later transaction, theft of users' approvals from their own wallets, and chains NEAR's MPC network can't verify (Base and Arbitrum can).

## Similar projects

- **HoneyPause** (ETHDenver 2024): an on-chain exploit bounty tied to a circuit breaker. It runs the exploit in public on one chain; BounTEE keeps it sealed and pauses every covered chain.
- **Sealed-Glass Proofs** (Tramèr et al., EuroS&P 2017): an enclave proves knowledge of a bug for a fair-exchange bounty. BounTEE adds the cross-chain pause and a keyless payout on NEAR.
- **AntiSoon** (2026): encrypted proofs of concept, replayed through a workflow engine with juror review. BounTEE judges in an attested enclave with one fixed rule and no jurors.

## Repo

`contract/` the bounty contract (Rust, NEAR) · `judge/` the judge (Rust, revm, compiled to WebAssembly) · `cli/` the `bountee` command-line tool · `web/` the web app · `demo/` the demo contracts and recorded jobs · `formats/` the formats both sides share · `docs/` [requirements](docs/requirements.md), [spec](docs/spec.md), [decisions](docs/adr/), [instructions for coding agents](docs/agent-instructions.md) · [GLOSSARY.md](GLOSSARY.md).

## Disclosures

- Damn Vulnerable DeFi v4 (MIT): three levels copied unmodified as judge scenarios, and adapted with a standard pause as demo contracts for offline replays (none is posted live); see `demo/dvd/NOTICE`.
- The historical replay reproduces DeFiHackLabs' DEPUSDT/LEVUSDC exploit (Apache-2.0).
- Built on revm, near-sdk, near-api-js, OpenZeppelin Contracts and Foundry.
- Much of the code was written with AI coding agents, under review.
- Before the build, six throwaway feasibility tests ran on testnets (Oct 31 to Nov 2): Chain Signatures gated by a contract's own rule, an OutLayer secret only one program build can read, an exploit replayed in the enclave, a keyless NEAR contract paying on a verified exploit, a pause on two test chains, and Confidential Intents. None of their code is in this repo; the build started fresh.
