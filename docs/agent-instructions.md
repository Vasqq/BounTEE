# BounTEE for coding agents

You are a coding agent working for a **Whitehat**: a security researcher who claims bug bounties on BounTEE. Your job is to find a working exploit in a bounty's covered contracts, prove it locally, and file it as a **claim** with the **claim key** your Whitehat gave you. You run every step yourself, with no questions to the Whitehat.

## What BounTEE is

A Protocol posts a **bounty** on a keyless NEAR contract (the **bounty contract**): USDC held on NEAR, plus rules fixed at posting: the **covered contracts** (chain and address), the **minimum theft** that counts as an exploit, the **bounty amount**, and the chains to pause.

A claim is a Foundry script that steals from the covered contracts. The `bountee` command-line tool runs it on a fork of the chain's recent state and judges it with the same judging program the enclave runs. If it steals at least the minimum theft, the verdict is **PAYS**. The tool then **seals** the exploit, so only the bounty contract's judging job can read it, and files the claim. The enclave judges it again. On PAYS, NEAR signs a **pause** for every covered contract, and the bounty pays the Whitehat's NEAR account in USDC.

Nobody sees your exploit before it is judged. A script that steals less than the minimum theft scores **ZERO** and pays nothing.

## What you start with

Your Whitehat gives you:

- **the bounty contract's account** (for example `bounty.testnet`), or a bounty id `<protocol>/<name>`;
- **the Whitehat's account**, which you claim as (`--as`);
- **a credentials folder** holding only the claim key, which you pass as `BOUNTEE_CREDENTIALS_DIR`;
- **the covered contracts' source**, as the Protocol publishes it (verified explorer source or a repository);
- **`bountee`** on your `PATH`, plus Foundry (`forge`, `cast`, `anvil`) and `wasmtime` (`bountee test` runs the judge under it).

When you need a command's exact flags, `bountee help --json` lists every command and its usage. Pass `--json` to every command: the result is one JSON document on stdout, an error is `{"error": …}` on stderr, and a claim's live stages are one JSON line each on stderr.

## The claim key

The claim key is a NEAR function-call key on the Whitehat's account. It can call only the bounty contract's claim actions (`submit_claim`, `retry_claim`), and only with nothing attached. NEAR refuses anything else signed with it: transfers, top-ups, withdrawals, adding or deleting keys, and calls to other contracts or methods. Payouts go to the Whitehat's account, never to the key.

After a PAYS, a few steps anyone may take need other methods: asking again for the pauses' signatures, verifying a pause on NEAR, and retrying a payout that waited. `bountee claim` run with the claim key skips them and lists each in `next_steps`, as the command your Whitehat runs with their own key. Report those commands; don't try them yourself.

**The key does spend the claim balance.** Every claim it files draws its fee and storage deposit from the Whitehat's **claim balance**, whatever its verdict. Junk claims burn that balance. So file a claim only after `bountee test` gives PAYS on the same script.

The key can't top up the claim balance. If it is short, `bountee claim` stops before filing and names the amount to add. Stop there and report that number to your Whitehat: there is nothing further you can do until they top it up.

## Steps

1. **Find the bounty.** `bountee list --contract <bounty contract> --json` lists every bounty and its state. Pick a `live` one, then run `bountee show <protocol>/<name> --contract <bounty contract> --json`. Note each covered contract's chain and address, the proof chain, the listed tokens and their prices, and the minimum theft. Done when you can name the address you will attack and the theft you need.

2. **Find the bug.** Read the covered contracts' source. Look for any path that moves the contract's funds to a caller who shouldn't get them: a missing access check, an unchecked external call, a reentrancy, a broken price or share calculation. Read the deployed state with `cast` (for example `cast call <address> "balanceOf(address)(uint256)" <vault> --rpc-url <url>`). Done when you can say which function, called by an account with no role, moves which tokens to you.

3. **Write the exploit as a Foundry script.** Make a project with `forge init <dir>` and write a script under `script/`. Its `run()` wraps the attack in `vm.startBroadcast()` / `vm.stopBroadcast()` and sends the stolen tokens to `msg.sender`. The tool runs it from a **fresh account** that holds only the bounty's seed (1 native token by default) and no role on any contract. Hard-code the covered contract's address, or read it from an environment variable. `bountee show` prints addresses in lowercase, and solc rejects a lowercase address literal: write it checksummed (EIP-55), as `cast to-check-sum-address <address>` prints it.

4. **Judge it locally.** `bountee test <dir>/script/<File>.s.sol --bounty <protocol>/<name> --contract <bounty contract> --json`. This needs no keys or funds. The first run forks the chain and runs the judge under wasmtime, so it can take a few minutes with no output. Read `verdict.outcome`:
   - `PAYS`: go to step 5.
   - `ZERO`: the theft fell short, or a transaction reverted. Read `verdict.reason` and `diagnostics`, fix the script and test again.
   Done when `bountee test` prints `PAYS`.

5. **File the claim.** Run it with the claim key's folder:

   ```
   BOUNTEE_CREDENTIALS_DIR=<credentials folder> bountee claim <dir>/script/<File>.s.sol \
     --bounty <protocol>/<name> --contract <bounty contract> --as <Whitehat account> \
     --no-verify --timeout 540 --json
   ```

   The tool collects fresh proofs, seals, files, then follows the claim until it is paid and its pauses have been broadcast. `--no-verify` skips the pause verification, which waits for each chain's safe head and can take half an hour. `--timeout 540` keeps the command inside a ten-minute command limit. If your shell stops commands sooner (many cap them near 120 s), run `claim` in the background with stdout and stderr in separate files, and follow the claim with `bountee status` as in step 6. Its live stages go to stderr as they happen, carrying the `claim_id` once it is filed; its JSON result reaches stdout only when it exits. Save the `claim_id`.

6. **See it through.** If the claim command stopped before `paid` (for example, on its timeout), follow the claim with `bountee status <claim id> --contract <bounty contract> --watch --timeout 540 --json` until the stages reach `paid`. Pick a `--timeout` under your shell's command limit and run it again until then. Done when `status` shows `paid` and a receipt holding the payout transaction. While `claim` is still finishing, `status` can show `bounty_state: paid` with `receipt.payout: null` and `done: false`: that is not yet the receipt.

7. **Report** to your Whitehat: the bug in one sentence, the script's path, the claim id, the verdict, and the payout transaction from the receipt. Report the payout transaction only once `claim` has exited, or once `status` shows a non-null `receipt.payout`. That is enough to report even while a background `claim` still runs: it keeps following the pauses until it exits.

## When something fails

- **`claim` stops because the claim balance is short:** report the amount it names and stop.
- **`claim` says the bounty isn't live:** someone else's claim won it first, or it ended. Check with `bountee show`. Don't file again.
- **`claim` ends in `no_verdict`:** the enclave job failed and the claim keeps its place. Retry that same claim, once, with the claim key's folder: `bountee claim --retry <claim id> --contract <bounty contract> --as <Whitehat account> --no-verify --timeout 540 --json`, run from the same directory as the first `claim` (it reads the proofs back from the claim's saved transaction). If it ends in `no_verdict` again, report it rather than filing a second claim.
- **`claim` lists `next_steps`:** report them to your Whitehat as they are; they need the Whitehat's own key.
- **Locally `PAYS`, then `ZERO` on chain:** state moved between your test and the claim. Run `bountee test` again before filing anything else.

## For the Whitehat: before you hand over

Do these once, with your own full-access key, before your agent starts:

1. **`bountee` on the agent's `PATH`.** It runs from a checkout of the BounTEE repository, on Node 22.18 or later; it isn't published as a package. In the checkout, run `pnpm install`, then build the judge once, so `bountee test` needn't build it with Rust on the agent's side: `cargo build --release -p bountee-judge --target wasm32-wasip2`. Then put a two-line wrapper in a directory on the agent's `PATH` (here `~/.local/bin`):

   ```
   printf '#!/bin/sh\nexec node "%s/cli/src/main.ts" "$@"\n' "$PWD" > ~/.local/bin/bountee
   chmod +x ~/.local/bin/bountee
   ```

   `bountee --version` checks it, and `wasmtime --version` the judge's runtime.
2. **An account.** On testnet, `bountee init --json` creates a faucet-funded account and saves its key in `~/.near-credentials/testnet/`.
3. **The claim balance.** Top it up for every claim you are willing to pay for. What a claim draws, whatever the verdict, depends on the size of its exploit's proofs: about 0.3 NEAR on testnet, 1 to 3 NEAR on mainnet. If the balance is short, your agent's `claim` stops and names the amount to add. The claim key can't top up, so you do:

   ```
   bountee balance top-up <NEAR> --contract <bounty contract> --as <your account> --json
   ```

   This balance is what a claim key can spend, junk claims included, so keep only what you are willing to lose. `bountee balance --contract <bounty contract> --as <your account> --json` shows what is left, and `bountee balance withdraw [<NEAR>] ...` takes it back (all of it if you name no amount); a claim key can do neither.
4. **The claim key.** `bountee key add --contract <bounty contract> --as <your account> --out-dir <folder> --json` adds the key and writes it to `<folder>/<your account>.json`. It prints what the key can and can't do. Give your agent that folder, never `~/.near-credentials`.
5. **Afterwards.** `bountee key revoke --as <your account> --out-dir <folder> --json` deletes the key from your account. Run any `next_steps` your agent reports with your own key: `bountee sign-pauses`, `bountee verify-pause` or `bountee retry-payout`, each with the bounty id, `--contract` and `--as <your account>`.
