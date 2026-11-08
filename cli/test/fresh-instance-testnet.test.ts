// Seam T, ticket #52: a fresh demo instance on the position vault, on NEAR testnet and Base
// Sepolia, driven through the committed fresh-instance script and the `bountee` command line;
// chain state read back with `cast` and NEAR RPC.
//
// Seams (written before the first test): T only.
//   fresh-instance.ts deploys a PositionVault, seeds it by the deployer's deposit, grants the
//     pause role, funds its pause gas and posts the bounty (D21); its deploy fits the gas the
//     preflight budgets.
//     Catches: deploy, seed, grant and posting regressions on the new vault, read back from
//     the chains; a deploy gas budget too small for the new deploy (approve and deposit
//     included).
//   `bountee test` of the honest user and of the sealed exploit on that instance: the accounts
//     and slot counts each replay proves are the read lists the preflight budgets (D21).
//     Catches: a claim budget measured on the old vault, too small for the new replays.
//   a cheat (HonestUser.s.sol: a fresh account deposits then redeems) claimed through
//     `bountee claim` scores ZERO and moves nothing (R4.11).
//     Catches: honest use of the new vault scored as theft by the enclave, or funds moving.
//   Misses: mainnet (#35; there the cheat also buys Circle's USDC on Uniswap V2), the winning
//   claim (#53, #54 reuse this instance), and the second chain.
//
// A testnet run is a rehearsal, never evidence (requirements.md, ADR-0017).
//
// Runs only with BOUNTEE_FRESH_RUN=1 (it spends Base Sepolia ETH and testnet NEAR). Needs
// SEALED_EXPLOIT, the absolute path of the sealed exploit script (it is never in this repo);
// without it every test stops with "sealed exploit not present" before deploying or spending.
// BOUNTEE_DAY3 names deploy-system.ts's deployment file, WHITEHAT the account that files the
// cheat (its key in ~/.near-credentials/testnet), BOUNTEE_INSTANCE where the instance is written
// (default ~/.bountee-testnet/spec48-52-instance.json), and INSTANCE=<file> reuses an unclaimed
// instance after a failure past the deploy. Transaction hashes go to
// ~/.bountee-testnet/spec48-52-evidence.json.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PAUSE_GAS_PER_PAUSE } from "@bountee/formats";
import { describe, expect, test } from "vitest";
import { defaultRpc } from "../src/chains.ts";
import { Near, events } from "../src/near.ts";
import { DEMO_READS, type Role } from "./testnet/claim-budget.ts";
import { DEMO_DEPLOY_GAS } from "./testnet/deploy.ts";

const RUN = process.env.BOUNTEE_FRESH_RUN === "1";
const home = homedir();
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const freshInstance = fileURLToPath(new URL("./testnet/fresh-instance.ts", import.meta.url));
const RPC = defaultRpc(84532)!;
const SEED = 1_000_000n * 10n ** 6n;
const evidenceFile = join(home, ".bountee-testnet", "spec48-52-evidence.json");
const evidence: Record<string, unknown> = RUN && existsSync(evidenceFile) ? JSON.parse(readFileSync(evidenceFile, "utf8")) : {};
const record = (k: string, v: unknown) => {
  evidence[k] = v;
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
};
const near = new Near("testnet");
const cast = (...args: string[]) => execFileSync("cast", args, { encoding: "utf8" }).trim();
const uint = (s: string) => BigInt(s.split(" ")[0]!);

/** The sealed exploit's path, checked before anything is deployed or spent. */
function sealedExploit(): string {
  const path = process.env.SEALED_EXPLOIT;
  if (!path || !existsSync(path)) throw new Error("sealed exploit not present");
  return path;
}

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const bountee = (args: string[], env: Record<string, string> = {}) => run([entry, ...args], env);

describe.runIf(RUN)("a fresh testnet instance on the position vault (#52)", () => {
  const deploymentFile = process.env.BOUNTEE_DAY3 ?? join(home, ".bountee-testnet", "day3-deployment.json");
  const deployment = RUN ? JSON.parse(readFileSync(deploymentFile, "utf8")) : {};
  const contract: string = deployment.contract;
  const usdc: string = deployment.usdc;
  const whitehat = process.env.WHITEHAT ?? "";
  const out = process.env.BOUNTEE_INSTANCE ?? join(home, ".bountee-testnet", "spec48-52-instance.json");
  let instance: any;
  const ft = async (who: string) => BigInt(await near.view<string>(usdc, "ft_balance_of", { account_id: who }));
  const vaultCall = (sig: string, ...args: string[]) => uint(cast("call", instance.vault, sig, ...args, "--rpc-url", RPC));
  const vaultUsdc = () => uint(cast("call", instance.evm_usdc, "balanceOf(address)(uint256)", instance.vault, "--rpc-url", RPC));

  test("D21: fresh-instance.ts deploys a PositionVault seeded by deposit, grants the pause role and posts its bounty", async () => {
    sealedExploit();
    expect(whitehat, "set WHITEHAT").not.toBe("");
    if (process.env.INSTANCE) {
      instance = JSON.parse(readFileSync(process.env.INSTANCE, "utf8"));
    } else {
      const r = await run([freshInstance], { WHITEHAT: whitehat, BOUNTEE_DAY3: deploymentFile, BOUNTEE_INSTANCE: out });
      expect(r.code, `${r.stderr}\n${r.stdout}`).toBe(0);
      instance = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    }
    record("D21 instance", { file: process.env.INSTANCE ?? out, bounty: instance.bounty, vault: instance.vault, evm_usdc: instance.evm_usdc, pause_role: instance.pause_role });
    record("D21 vault deploy txs", instance.deploy_txs);
    record("D21 pause gas tx", instance.pause_gas_tx);
    record("D21 post tx", instance.post_tx);

    // Read back from the chains, not from the script's report.
    const deployer = JSON.parse(cast("receipt", instance.deploy_txs[0], "--rpc-url", RPC, "--json")).from.toLowerCase();
    expect(cast("call", instance.vault, "pauser()(address)", "--rpc-url", RPC).toLowerCase()).toBe(instance.pause_role);
    expect(cast("call", instance.vault, "token()(address)", "--rpc-url", RPC).toLowerCase()).toBe(instance.evm_usdc);
    expect(cast("call", instance.vault, "paused()(bool)", "--rpc-url", RPC)).toBe("false");
    // Seeded by an ordinary deposit: the deployer holds every share, 1:1 with the seed.
    expect(vaultUsdc()).toBe(SEED);
    expect(vaultCall("totalShares()(uint256)")).toBe(SEED);
    expect(vaultCall("shares(address)(uint256)", deployer)).toBe(SEED);
    expect(BigInt(cast("balance", instance.pause_role, "--rpc-url", RPC))).toBeGreaterThanOrEqual(PAUSE_GAS_PER_PAUSE);
    const bounty = await near.view(contract, "bounty", { id: { protocol: instance.protocol, name: instance.name } });
    expect(bounty.state).toBe("live");
    expect(bounty.rules.covered_contracts).toStrictEqual([{ chain_id: 84532, address: instance.vault }]);

    // The deploy (mock, vault, mint, approve, deposit) and the pause-gas transfer fit the gas the preflight budgets.
    const gasUsed = [...instance.deploy_txs, instance.pause_gas_tx]
      .map((tx: string) => BigInt(JSON.parse(cast("receipt", tx, "--rpc-url", RPC, "--json")).gasUsed))
      .reduce((a: bigint, b: bigint) => a + b, 0n);
    record("D21 deploy gas used", gasUsed.toString());
    expect(gasUsed).toBeLessThanOrEqual(DEMO_DEPLOY_GAS);
  }, 900_000);

  /** The accounts a saved job's replay proves, by role, each with how many of its slots. */
  function provedReads(job: string, attacker: string): [string, number][] {
    const replay = JSON.parse(readFileSync(job, "utf8")).replay;
    const miner = cast("block", String(replay.block.number), "--field", "miner", "--rpc-url", RPC).toLowerCase();
    const role = (a: string): Role | string =>
      a === instance.vault ? "vault" : a === instance.evm_usdc ? "usdc" : a === attacker.toLowerCase() ? "sender" : a === miner ? "coinbase" : a;
    return replay.proofs
      .map((p: { address: string; storage: unknown[] }) => [role(p.address), p.storage.length] as [string, number])
      .sort((a: [string, number], b: [string, number]) => a[0].localeCompare(b[0]));
  }
  const expected = (reads: Partial<Record<Role, number>>) => Object.entries(reads).sort((a, b) => a[0].localeCompare(b[0]));

  test("D21: the claim budget's read lists are the accounts and slots the cheat's and the win's replays prove", async () => {
    const exploit = sealedExploit();
    expect(instance).toBeDefined();
    const dir = mkdtempSync(join(tmpdir(), "bountee-52-"));
    const measured: Record<string, [string, number][]> = {};
    for (const [kind, script] of [["cheat", join(repo, "demo/script/HonestUser.s.sol")], ["win", exploit]] as const) {
      const job = join(dir, `${kind}.json`);
      const r = await bountee(["test", script, "--bounty", instance.bounty, "--contract", contract, "--out", job, "--json"], { VAULT: instance.vault });
      expect(r.code, r.stderr || r.stdout).toBe(0);
      const result = JSON.parse(r.stdout);
      expect(result.verdict.outcome).toBe(kind === "win" ? "PAYS" : "ZERO");
      measured[kind] = provedReads(job, result.attacker);
    }
    record("D21 measured read lists", measured);
    expect(measured.cheat).toStrictEqual(expected(DEMO_READS.testnet.cheat));
    expect(measured.win).toStrictEqual(expected(DEMO_READS.testnet.win));
  }, 900_000);

  test("R4.11: a cheat (a fresh account's deposit then redeem) claimed through the tool scores ZERO and moves nothing", async () => {
    sealedExploit();
    expect(instance).toBeDefined();
    const before = { whitehat: await ft(whitehat), contract: await ft(contract), vault: vaultUsdc(), shares: vaultCall("totalShares()(uint256)") };
    // 5,000 test USDC minted, deposited and redeemed: the account moves more than the minimum
    // theft through the vault, but takes nothing from it.
    const r = await bountee(
      ["claim", join(repo, "demo/script/HonestUser.s.sol"), "--bounty", instance.bounty, "--contract", contract, "--as", whitehat, "--json"],
      { VAULT: instance.vault, AMOUNT: "5000000000" },
    );
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const claimed = JSON.parse(r.stdout);
    record("R4.11 cheat claim", { claim_id: claimed.claim_id, tx: claimed.tx_hash, verdict: claimed.verdict, local_verdict: claimed.local_verdict });
    expect(claimed.local_verdict).toStrictEqual({ outcome: "ZERO", reason: "below_minimum_theft" });
    expect(claimed.verdict).toStrictEqual(claimed.local_verdict);
    const claim = await near.view(contract, "claim", { claim_id: claimed.claim_id });
    expect(claim.verdict).toStrictEqual({ outcome: "ZERO", reason: "below_minimum_theft" });
    expect((await near.view(contract, "bounty", { id: claim.bounty })).state).toBe("live");
    expect(await ft(whitehat)).toBe(before.whitehat);
    expect(await ft(contract)).toBe(before.contract);
    expect(vaultUsdc()).toBe(before.vault);
    expect(vaultCall("totalShares()(uint256)")).toBe(before.shares);
    expect(cast("call", instance.vault, "paused()(bool)", "--rpc-url", RPC)).toBe("false");
    expect(events(await near.txStatus(claimed.tx_hash, whitehat)).map((e) => e.event)).not.toContain("bounty_paid");
  }, 900_000);
});
