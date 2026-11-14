// Seam T, the testnet gate (#67, spec #60): a claim proven on any covered chain. One fresh
// bounty covers the demo vault on Base Sepolia and on Arbitrum Sepolia; the cheat is proven on
// Base and scores zero, then the sealed exploit's win is proven on Arbitrum, paid once, and
// pauses both vaults. Driven through the committed scripts and the `bountee` command line;
// chain state read back with `cast` and NEAR RPC views.
//
//   the deployment (`testnet/deploy-system.ts`) was built from a pushed commit holding no copy
//   of the sealed exploit, and `bountee build` of that commit reproduces the code hash NEAR
//   shows and the judge hash the contract pins (R15.2)
//   -> fresh instance on both chains + `bountee post` (fresh-instance.ts, CHAINS=84532,421614):
//      each chain's USDC listed; the enclave's posting check reads both chains (R12.5)
//   -> `bountee claim HonestUser.s.sol --chain base-sepolia`: ZERO, nothing moves (R4.11)
//   -> `bountee claim <sealed exploit> --chain arbitrum-sepolia`: the claim's block is on
//      Arbitrum Sepolia, the enclave judges it there (D1, D29), PAYS, paid once (R3.10, as a
//      rehearsal); Base's vault is never touched by the exploit
//   -> `claim` broadcasts both signed pauses: both vaults read paused (R7.4)
//   -> `claim` waits for each chain's safe head and asks NEAR's MPC network to verify each
//      chain's pause (R7.10)
//   -> `bountee verify` with the rebuilt wasms passes every layer for that win (R15.1)
//
// Seams: T only. Catches the whole any-chain change live on the real services; misses mainnet
// (#35) and the agent's cold win. A testnet run is a rehearsal, never evidence
// (requirements.md, ADR-0017).
//
// Runs only with BOUNTEE_T20_RUN=1 (it spends testnet NEAR, Base Sepolia ETH and Arbitrum
// Sepolia ETH, and waits up to ~30 minutes for the safe heads, plus two reproducible builds).
// Needs SEALED_EXPLOIT, the absolute path of the sealed exploit script (never in this repo);
// without it each test stops with "sealed exploit not present" before deploying or spending.
// BOUNTEE_DAY3 names the deployment (`testnet/deploy-system.ts`'s file); WHITEHAT=<account with
// ~2 NEAR>; PROTOCOL=<account holding the bounty's test USDC> (fresh-instance.ts's default
// otherwise); the deployer (same key on both chains) in ~/.bountee-testnet/base-sepolia-deployer.env.
// DISCLOSURE_DELAY_DAYS passes through to the instance. INSTANCE=<file> reuses an unclaimed
// instance. Every transaction hash goes to $BOUNTEE_EVIDENCE (default
// ~/.bountee-testnet/t20-evidence.json).
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Near, events } from "../src/near.ts";
import { defaultRpc } from "../src/chains.ts";
import { sealedExploit } from "./testnet/sealed-exploit.ts";

const RUN = process.env.BOUNTEE_T20_RUN === "1";
const BASE = 84532;
const ARBITRUM = 421614;
const home = homedir();
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const freshInstance = fileURLToPath(new URL("./testnet/fresh-instance.ts", import.meta.url));
const evidenceFile = process.env.BOUNTEE_EVIDENCE ?? join(home, ".bountee-testnet", "t20-evidence.json");
const evidence: Record<string, unknown> = RUN && existsSync(evidenceFile) ? JSON.parse(readFileSync(evidenceFile, "utf8")) : {};
const record = (k: string, v: unknown) => {
  evidence[k] = v;
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
};
const near = new Near("testnet");
const cast = (...args: string[]) => execFileSync("cast", args, { encoding: "utf8" }).trim();
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const rpc = (chain: number) => defaultRpc(chain)!;
const uint = (s: string) => BigInt(s.split(" ")[0]!);
const paused = (chain: number, vault: string) => cast("call", vault, "paused()(bool)", "--rpc-url", rpc(chain));
const usdcOf = (chain: number, c: { evm_usdc: string; vault: string }) =>
  uint(cast("call", c.evm_usdc, "balanceOf(address)(uint256)", c.vault, "--rpc-url", rpc(chain)));
const sharesOf = (chain: number, vault: string) => uint(cast("call", vault, "totalShares()(uint256)", "--rpc-url", rpc(chain)));

function run(cmd: string, args: string[], env: Record<string, string> = {}, cwd?: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env }, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const bountee = (args: string[], env: Record<string, string> = {}, cwd?: string) => run(process.execPath, [entry, ...args], env, cwd);
/** `bountee` from an empty directory with an empty home: no keys and no saved claims (R15.1). */
function keyless(args: string[]) {
  const empty = mkdtempSync(join(tmpdir(), "bountee-gate-keyless-"));
  return bountee(args, { HOME: empty, BOUNTEE_CREDENTIALS_DIR: join(empty, "none") }, empty);
}

describe.runIf(RUN)("#67 gate: the cheat proven on Base Sepolia scores zero; the win proven on Arbitrum Sepolia pauses both chains", () => {
  const deploymentFile = process.env.BOUNTEE_DAY3 ?? join(home, ".bountee-testnet", "t20-deployment.json");
  const deployment = RUN ? JSON.parse(readFileSync(deploymentFile, "utf8")) : {};
  const contract: string = deployment.contract;
  const usdc: string = deployment.usdc;
  const whitehat = process.env.WHITEHAT ?? "";
  let instance: any;
  let built: any;
  let winningClaim: number;
  const on = (chain: number) => instance.chains.find((c: any) => c.chain_id === chain);
  const id = () => ({ protocol: instance.protocol, name: instance.name });
  const ft = async (who: string) => BigInt(await near.view<string>(usdc, "ft_balance_of", { account_id: who }));

  test("R15.2, R2.1: the keyless deployment's commit is pushed, holds no sealed file, and rebuilds both deployed hashes", async () => {
    const exploit = sealedExploit();
    const meta = await near.view<any>(contract, "contract_source_metadata");
    const rev = /rev=([0-9a-f]{40})/.exec(meta.build_info.source_code_snapshot)![1]!;
    // Pushed: anyone can rebuild it. No sealed file: no blob in its tree is the sealed exploit,
    // and no file in it has the sealed exploit's name (an edited copy).
    expect(git("branch", "-r", "--contains", rev)).not.toBe("");
    // ls-tree: "<mode> <type> <blob>\t<path>".
    const tree = git("ls-tree", "-r", rev).split("\n").map((l) => {
      const [head, path] = l.split("\t");
      return { blob: head!.split(" ")[2], path: path! };
    });
    expect(tree.map((t) => t.blob)).not.toContain(git("hash-object", exploit));
    expect(tree.map((t) => basename(t.path))).not.toContain(basename(exploit));
    const keys = await near.rpc<{ keys: unknown[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: contract });
    expect(keys.keys).toEqual([]); // keyless: the code can't change after this

    const account = await near.rpc<{ code_hash: string }>("query", { request_type: "view_account", finality: "final", account_id: contract });
    const config = await near.view<any>(contract, "config");
    const out = mkdtempSync(join(tmpdir(), "bountee-gate-rebuild-"));
    const r = await bountee(["build", "--contract", contract, "--rev", rev, "--out-dir", out, "--json"]);
    expect(r.code, r.stderr.slice(-3000)).toBe(0);
    built = JSON.parse(r.stdout);
    record("R15.2 rebuild", { contract, rev, code_hash: account.code_hash, rebuilt_code_hash: built.contract.code_hash, judge: config.judge_build_hash, rebuilt_judge: built.judge.sha256 });
    expect(built.rev).toBe(rev);
    expect(built.contract.code_hash).toBe(account.code_hash);
    expect(`0x${built.judge.sha256}`).toBe(config.judge_build_hash);
  }, 1_900_000);

  test("R12.5, D1: a bounty covering both chains, each chain's USDC listed, passes the enclave's posting check and goes live", async () => {
    sealedExploit();
    expect(whitehat, "set WHITEHAT").not.toBe("");
    if (process.env.INSTANCE) {
      instance = JSON.parse(readFileSync(process.env.INSTANCE, "utf8"));
    } else {
      const r = await run(process.execPath, [freshInstance], {
        WHITEHAT: whitehat,
        CLAIMS: "2",
        CHAINS: `${BASE},${ARBITRUM}`,
        BOUNTEE_DAY3: deploymentFile,
        BOUNTEE_INSTANCE: process.env.BOUNTEE_INSTANCE ?? join(home, ".bountee-testnet", "t20-instance.json"),
      });
      expect(r.code, `${r.stderr}\n${r.stdout}`).toBe(0);
      instance = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    }
    expect(instance.contract).toBe(contract);
    record("contract", contract);
    record("instance", { bounty: instance.bounty, pause_role: instance.pause_role, post_tx: instance.post_tx, chains: instance.chains });
    // ADR-0020: each covered chain lists its own USDC at 1 and native coin at 0; no proof chain.
    expect(instance.rules.listed_tokens).toStrictEqual([
      { chain_id: BASE, token: on(BASE).evm_usdc, price: "1" },
      { chain_id: BASE, token: "native", price: "0" },
      { chain_id: ARBITRUM, token: on(ARBITRUM).evm_usdc, price: "1" },
      { chain_id: ARBITRUM, token: "native", price: "0" },
    ]);
    expect(instance.rules.covered_contracts.map((c: any) => c.chain_id)).toStrictEqual([BASE, ARBITRUM]);
    const bounty = await near.view(contract, "bounty", { id: id() });
    // Live only on a passing posting check, which read both chains through the judge's pinned
    // RPCs inside OutLayer; the contract reads the chained listed tokens back unchanged.
    expect(bounty.state).toBe("live");
    expect(bounty.rules.listed_tokens).toStrictEqual(instance.rules.listed_tokens);
    for (const chain of [BASE, ARBITRUM]) expect(paused(chain, on(chain).vault)).toBe("false");
  }, 900_000);

  test("R4.11: the cheat proven on Base Sepolia (a fresh account's deposit then redeem) scores ZERO and moves nothing", async () => {
    sealedExploit();
    expect(instance).toBeDefined();
    const vaults = () => [BASE, ARBITRUM].map((chain) => [usdcOf(chain, on(chain)), sharesOf(chain, on(chain).vault)]);
    const before = { whitehat: await ft(whitehat), contract: await ft(contract), vaults: vaults() };
    // 5,000 test USDC minted, deposited and redeemed: the account moves more than the minimum
    // theft through the vault, but takes nothing from it.
    const r = await bountee(
      ["claim", join(repo, "demo/script/HonestUser.s.sol"), "--bounty", instance.bounty, "--chain", "base-sepolia", "--contract", contract, "--as", whitehat, "--json"],
      { VAULT: on(BASE).vault, AMOUNT: "5000000000" },
    );
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const claimed = JSON.parse(r.stdout);
    const claim = await near.view(contract, "claim", { claim_id: claimed.claim_id });
    record("R4.11 cheat claim", { claim_id: claimed.claim_id, tx: claimed.tx_hash, block: claim.block, verdict: claimed.verdict, local_verdict: claimed.local_verdict });
    expect(claim.block.chain_id).toBe(BASE);
    expect(claimed.local_verdict).toStrictEqual({ outcome: "ZERO", reason: "below_minimum_theft" });
    expect(claimed.verdict).toStrictEqual(claimed.local_verdict);
    expect(claim.verdict).toStrictEqual({ outcome: "ZERO", reason: "below_minimum_theft" });
    expect((await near.view(contract, "bounty", { id: id() })).state).toBe("live");
    expect(await ft(whitehat)).toBe(before.whitehat);
    expect(await ft(contract)).toBe(before.contract);
    expect(vaults()).toStrictEqual(before.vaults);
    for (const chain of [BASE, ARBITRUM]) expect(paused(chain, on(chain).vault)).toBe("false");
    expect(events(await near.txStatus(claimed.tx_hash, whitehat)).map((e) => e.event)).not.toContain("bounty_paid");
  }, 900_000);

  test("R3.10, D1, D29, R7.4, R7.10: the win proven on Arbitrum Sepolia is paid once and pauses both chains, each pause verified", async () => {
    const exploit = sealedExploit();
    expect(instance).toBeDefined();
    const amount = BigInt(instance.rules.bounty_amount);
    const before = { whitehat: await ft(whitehat), contract: await ft(contract), base: [usdcOf(BASE, on(BASE)), sharesOf(BASE, on(BASE).vault)] };
    const r = await bountee(
      ["claim", exploit, "--bounty", instance.bounty, "--chain", "arbitrum-sepolia", "--contract", contract, "--as", whitehat, "--verify-wait", "3600", "--timeout", "3600", "--json"],
      { VAULT: on(ARBITRUM).vault },
    );
    const out = JSON.parse(r.stdout || "{}");
    record("claim", { code: r.code, claim_id: out.claim_id, tx: out.tx_hash, verdict: out.verdict, local_verdict: out.local_verdict, paid: out.paid, broadcast: out.broadcast, verification: out.verification, stderr: r.stderr.slice(-2000) });
    winningClaim = out.claim_id;

    // D1, D29: the claim's block is Arbitrum Sepolia's, and the enclave, confirming it through
    // Arbitrum's pinned RPCs under Arbitrum's profile, gives the local replay's verdict.
    const claim = await near.view(contract, "claim", { claim_id: out.claim_id });
    record("D1 D29 claim block", claim.block);
    expect(claim.block.chain_id).toBe(ARBITRUM);
    expect(cast("block", String(claim.block.number), "--field", "hash", "--rpc-url", rpc(ARBITRUM))).toBe(claim.block.hash);
    expect(out.local_verdict).toStrictEqual({ outcome: "PAYS", reason: "minimum_theft_reached" });
    expect(out.verdict).toStrictEqual(out.local_verdict);
    expect(claim.verdict).toStrictEqual(out.local_verdict);

    // R3.10 (rehearsal): paid exactly once, the bounty amount to the Whitehat.
    expect(out.paid).toBe(true);
    const bounty = await near.view(contract, "bounty", { id: id() });
    expect(bounty.state).toBe("paid");
    expect(bounty.winning_claim).toBe(out.claim_id);
    expect(await ft(whitehat)).toBe(before.whitehat + amount);
    expect(await ft(contract)).toBe(before.contract - amount);
    const paidEvents = events(await near.txStatus(out.tx_hash, whitehat)).filter((e) => e.event === "bounty_paid");
    record("R3.10 bounty_paid events", paidEvents);
    expect(paidEvents).toHaveLength(1);
    // The exploit ran on Arbitrum only: Base's vault holds what it did.
    expect([usdcOf(BASE, on(BASE)), sharesOf(BASE, on(BASE).vault)]).toStrictEqual(before.base);

    // R7.4, D1: a pause for every covered contract on both chains, broadcast, and both read paused.
    expect(bounty.signed_pauses.map((p: any) => [p.chain_id, p.contract])).toStrictEqual([
      [BASE, on(BASE).vault],
      [ARBITRUM, on(ARBITRUM).vault],
    ]);
    for (const p of bounty.signed_pauses) {
      const receipt = JSON.parse(cast("receipt", p.tx_hash, "--rpc-url", rpc(p.chain_id), "--json"));
      record(`pause landed on ${p.chain_id}`, { tx: p.tx_hash, block: Number(receipt.blockNumber), status: receipt.status, from: receipt.from, gas_used: Number(receipt.gasUsed) });
      expect(receipt.status).toBe("0x1");
      expect(receipt.from.toLowerCase()).toBe(instance.pause_role);
    }
    for (const chain of [BASE, ARBITRUM]) {
      const now = paused(chain, on(chain).vault);
      record(`R7.4 paused() on ${chain}`, { vault: on(chain).vault, paused: now });
      expect(now).toBe("true");
    }

    // R7.10: each chain's pause verified on NEAR by the MPC network, from the stored pause's hash.
    const verifications = await near.view(contract, "pause_verifications", { id: id() });
    record("R7.10 pause_verifications", verifications);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    for (const chain of [BASE, ARBITRUM]) {
      const v = verifications.find((x: any) => x.chain_id === chain);
      const stored = bounty.signed_pauses.find((p: any) => p.chain_id === chain).tx_hash;
      expect(v, `chain ${chain}`).toMatchObject({ verified: true, verified_pauses: [stored] });
    }
  }, 4_200_000);

  test("R15.1: verify, with no keys or funds, passes every layer of the win proven on Arbitrum Sepolia", async () => {
    sealedExploit();
    expect(built, "the R15.2 rebuild").toBeDefined();
    expect(winningClaim).toBeDefined();
    const r = await keyless([
      "verify", instance.bounty, "--contract", contract,
      "--judge-wasm", built.judge.wasm, "--contract-wasm", built.contract.wasm, "--json",
    ]);
    const result = r.stdout ? JSON.parse(r.stdout) : null;
    record("R15.1 verify", result);
    expect(result, r.stderr).toMatchObject({ state: "paid", winning_claim: winningClaim, passed: true });
    const statuses = (layer: string) => result.checks.filter((c: any) => c.check === layer).map((c: any) => c.status);
    for (const layer of ["contract_code", "judge_build", "attestation", "payout"]) expect(statuses(layer), layer).toStrictEqual(["pass"]);
    // Each chain's pause, landed and verified.
    for (const layer of ["pause_landed", "pause_verified"]) {
      const checks = result.checks.filter((c: any) => c.check === layer);
      expect(checks.map((c: any) => [c.chain_id, c.status]), layer).toStrictEqual([
        [BASE, "pass"],
        [ARBITRUM, "pass"],
      ]);
    }
    expect(statuses("rerun")).toStrictEqual(["not_yet_published"]);
    // The attested judge is the rebuilt one.
    expect(result.checks.find((c: any) => c.check === "attestation").wasm_hash).toBe(built.judge.sha256);
    expect(r.code).toBe(0);
  }, 600_000);
});
