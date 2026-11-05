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
- **`bountee`** on your `PATH`, plus Foundry (`forge`, `cast`, `anvil`).

When you need a command's exact flags, `bountee help --json` lists every command and its usage. Pass `--json` to every command: the result is one JSON document on stdout, an error is `{"error": …}` on stderr, and a claim's live stages are one JSON line each on stderr.

## The claim key

The claim key is a NEAR function-call key on the Whitehat's account. It can call only the bounty contract's claim methods (`submit_claim`, `retry_claim`, `sign_pauses`, `retry_payout`, `verify_pause`), and only with nothing attached. NEAR refuses anything else signed with it: transfers, top-ups, withdrawals, adding or deleting keys, and calls to other contracts or methods. Payouts go to the Whitehat's account, never to the key.

**The key does spend the claim balance.** Every claim it files draws its fee and storage deposit from the Whitehat's **claim balance**, whatever its verdict. Junk claims burn that balance. So file a claim only after `bountee test` gives PAYS on the same script.

The key can't top up the claim balance. If it is short, `bountee claim` stops before filing and says how much to add. Stop there and report that number to your Whitehat: there is nothing further you can do until they top it up.

## Steps

1. **Find the bounty.** `bountee list --contract <bounty contract> --json` lists every bounty and its state. Pick a `live` one, then run `bountee show <protocol>/<name> --contract <bounty contract> --json`. Note each covered contract's chain and address, the proof chain, the listed tokens and their prices, and the minimum theft. Done when you can name the address you will attack and the theft you need.

2. **Find the bug.** Read the covered contracts' source. Look for any path that moves the contract's funds to a caller who shouldn't get them: a missing access check, an unchecked external call, a reentrancy, a broken price or share calculation. Read the deployed state with `cast` (for example `cast call <address> "balanceOf(address)(uint256)" <vault> --rpc-url <url>`). Done when you can say which function, called by an account with no role, moves which tokens to you.

3. **Write the exploit as a Foundry script.** Make a project with `forge init <dir>` and write a script under `script/`. Its `run()` wraps the attack in `vm.startBroadcast()` / `vm.stopBroadcast()` and sends the stolen tokens to `msg.sender`. The tool runs it from a **fresh account** that holds only the bounty's seed (1 native token by default) and no role on any contract. Hard-code the covered contract's address, or read it from an environment variable.

4. **Judge it locally.** `bountee test <dir>/script/<File>.s.sol --bounty <protocol>/<name> --contract <bounty contract> --json`. This needs no keys or funds. Read `verdict.outcome`:
   - `PAYS`: go to step 5.
   - `ZERO`: the theft fell short, or a transaction reverted. Read `verdict.reason` and `diagnostics`, fix the script and test again.
   Done when `bountee test` prints `PAYS`.

5. **File the claim.** Run it with the claim key's folder:

   ```
   BOUNTEE_CREDENTIALS_DIR=<credentials folder> bountee claim <dir>/script/<File>.s.sol \
     --bounty <protocol>/<name> --contract <bounty contract> --as <Whitehat account> \
     --no-verify --timeout 540 --json
   ```

   The tool collects fresh proofs, seals, files, then follows the claim until it is paid and its pauses have been broadcast. `--no-verify` skips the pause verification, which waits for each chain's safe head and can take half an hour. `--timeout 540` keeps the command inside a ten-minute command limit. Save the `claim_id` it prints.

6. **See it through.** If the claim command stopped before `paid` (for example, on its timeout), follow the claim with `bountee status <claim id> --contract <bounty contract> --watch --timeout 540 --json` until the stages reach `paid`. Done when `status` shows `paid` and a receipt holding the payout transaction.

7. **Report** to your Whitehat: the bug in one sentence, the script's path, the claim id, the verdict, and the payout transaction from the receipt.

## When something fails

- **`claim` stops because the claim balance is short:** report the amount it names and stop.
- **`claim` says the bounty isn't live:** someone else's claim won it first, or it ended. Check with `bountee show`. Don't file again.
- **`claim` ends in `no_verdict`:** the enclave job failed and the claim keeps its place. `bountee status <claim id> --json` shows it. Report it rather than filing a second claim.
- **Locally `PAYS`, then `ZERO` on chain:** state moved between your test and the claim. Run `bountee test` again before filing anything else.

## For the Whitehat: before you hand over

Do these once, with your own full-access key, before your agent starts:

1. **An account.** On testnet, `bountee init --json` creates a faucet-funded account and saves its key in `~/.near-credentials/testnet/`.
2. **The claim balance.** Top it up for every claim you are willing to pay for. Each claim draws about 1 NEAR, whatever the verdict. The claim key can't top up, so you do, with NEAR CLI:

   ```
   near contract call-function as-transaction <bounty contract> top_up_claim_balance json-args '{}' \
     prepaid-gas '30 Tgas' attached-deposit '1.2 NEAR' \
     sign-as <your account> network-config testnet sign-with-legacy-keychain send
   ```

   This balance is what a claim key can spend, junk claims included, so keep only what you are willing to lose.
3. **The claim key.** `bountee key add --contract <bounty contract> --as <your account> --out-dir <folder> --json` adds the key and writes it to `<folder>/<your account>.json`. It prints what the key can and can't do. Give your agent that folder, never `~/.near-credentials`.
4. **Afterwards.** `bountee key revoke --as <your account> --out-dir <folder> --json` deletes the key from your account.
