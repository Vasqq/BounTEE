// Seam T, ticket #20: the second chain. A bounty covers the demo vault on Base Sepolia (where
// the claim is proven) and on Arbitrum Sepolia; one winning claim pauses both. Driven through the
// committed scripts and the `bountee` command line; chain state read back with `cast` and
// NEAR RPC views.
//
//   fresh instance on both chains + `bountee post` (fresh-instance.ts, CHAINS=84532,421614): the
//   enclave's posting check reads Arbitrum Sepolia through the RPCs pinned in the judge (R12.5)
//   -> `bountee claim` of the real demo exploit against Base's vault: judged on Base's state
//      only, PAYS, paid; Arbitrum's vault is never touched (D1)
//   -> `claim` broadcasts both signed pauses: both vaults read paused (R7.4, D1)
//   -> `claim` waits for each chain's safe head and asks NEAR's MPC network to verify each
//      chain's pause (R7.10 on Arbitrum Sepolia, live for the first time)
//
// Seams (#53): T only, on PositionVault instances (ADR-0019). Catches two chains' posting check,
// pauses and their verification on the new vault; misses mainnet (#35). A testnet run is a
// rehearsal, never evidence (requirements.md, ADR-0017).
//
// Runs only with BOUNTEE_T20_RUN=1 (it spends testnet NEAR, Base Sepolia ETH and Arbitrum
// Sepolia ETH, and waits up to ~30 minutes for the safe heads). Needs SEALED_EXPLOIT, the
// absolute path of the sealed exploit script (never in this repo); without it each test stops
// with "sealed exploit not present" before deploying or spending. Needs BOUNTEE_DAY3 naming a
// deployment whose judge pins Arbitrum Sepolia's RPCs (`testnet/deploy-system.ts`),
// WHITEHAT=<account with ~1.2 NEAR>, the Protocol's key, and the deployer (same key on both
// chains) in ~/.bountee-testnet/base-sepolia-deployer.env. INSTANCE=<file> reuses an unclaimed
// instance. Every transaction hash goes to ~/.bountee-testnet/t20-evidence.json.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Near } from "../src/near.ts";
import { defaultRpc } from "../src/chains.ts";
import { sealedExploit } from "./testnet/sealed-exploit.ts";

const RUN = process.env.BOUNTEE_T20_RUN === "1";
const BASE = 84532;
const ARBITRUM = 421614;
const home = homedir();
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const freshInstance = fileURLToPath(new URL("./testnet/fresh-instance.ts", import.meta.url));
const evidenceFile = join(home, ".bountee-testnet", "t20-evidence.json");
const evidence: Record<string, unknown> = {};
const record = (k: string, v: unknown) => {
  evidence[k] = v;
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
};
const near = new Near("testnet");
const cast = (...args: string[]) => execFileSync("cast", args, { encoding: "utf8" }).trim();
const rpc = (chain: number) => defaultRpc(chain)!;
const paused = (chain: number, vault: string) => cast("call", vault, "paused()(bool)", "--rpc-url", rpc(chain));
const usdcOf = (chain: number, c: { evm_usdc: string; vault: string }) =>
  cast("call", c.evm_usdc, "balanceOf(address)(uint256)", c.vault, "--rpc-url", rpc(chain)).split(" ")[0];
const sharesOf = (chain: number, vault: string) => cast("call", vault, "totalShares()(uint256)", "--rpc-url", rpc(chain)).split(" ")[0];

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.runIf(RUN)("#20: one winning claim pauses the vault on Base Sepolia and Arbitrum Sepolia", () => {
  const deploymentFile = process.env.BOUNTEE_DAY3 ?? join(home, ".bountee-testnet", "t20-deployment.json");
  const deployment = RUN ? JSON.parse(readFileSync(deploymentFile, "utf8")) : {};
  const contract: string = deployment.contract;
  const whitehat = process.env.WHITEHAT ?? "";
  let instance: any;
  const on = (chain: number) => instance.chains.find((c: any) => c.chain_id === chain);

  test("R12.5, D1: a bounty covering both chains passes the enclave's posting check and goes live", async () => {
    sealedExploit();
    expect(whitehat, "set WHITEHAT").not.toBe("");
    if (process.env.INSTANCE) {
      instance = JSON.parse(readFileSync(process.env.INSTANCE, "utf8"));
    } else {
      const r = await run(process.execPath, [freshInstance], {
        WHITEHAT: whitehat,
        CLAIMS: "1",
        CHAINS: `${BASE},${ARBITRUM}`,
        BOUNTEE_DAY3: deploymentFile,
        BOUNTEE_INSTANCE: join(home, ".bountee-testnet", "t20-instance.json"),
      });
      expect(r.code, `${r.stderr}\n${r.stdout}`).toBe(0);
      instance = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    }
    expect(instance.contract).toBe(contract);
    record("contract", contract);
    record("instance", { bounty: instance.bounty, pause_role: instance.pause_role, post_tx: instance.post_tx, chains: instance.chains });
    // ADR-0020: each covered chain lists its own USDC (and native coin at 0); no proof chain.
    expect(instance.rules.listed_tokens.map((t: any) => t.chain_id)).toStrictEqual([BASE, BASE, ARBITRUM, ARBITRUM]);
    expect(instance.rules.covered_contracts.map((c: any) => c.chain_id)).toStrictEqual([BASE, ARBITRUM]);
    const bounty = await near.view(contract, "bounty", { id: { protocol: instance.protocol, name: instance.name } });
    // Live only on a passing posting check, which read Arbitrum Sepolia through the judge's
    // pinned RPCs inside OutLayer (a chain with none fails `chain_unconfirmed`).
    expect(bounty.state).toBe("live");
    for (const chain of [BASE, ARBITRUM]) expect(paused(chain, on(chain).vault)).toBe("false");
  }, 900_000);

  test("D1, R7.4, R7.10: one claim judged on Base's state pauses both vaults; each chain's pause is verified", async () => {
    const exploit = sealedExploit();
    const id = { protocol: instance.protocol, name: instance.name };
    const arbBefore = { usdc: usdcOf(ARBITRUM, on(ARBITRUM)), shares: sharesOf(ARBITRUM, on(ARBITRUM).vault) };
    const r = await run(process.execPath, [entry, "claim", exploit, "--bounty", instance.bounty, "--contract", contract, "--as", whitehat, "--verify-wait", "3600", "--timeout", "3600", "--json"], { VAULT: on(BASE).vault });
    const out = JSON.parse(r.stdout || "{}");
    record("claim", { code: r.code, claim_id: out.claim_id, tx: out.tx_hash, verdict: out.verdict, local_verdict: out.local_verdict, paid: out.paid, broadcast: out.broadcast, verification: out.verification, stderr: r.stderr.slice(-2000) });

    // D1: judged against the proof chain's state: the enclave's verdict is the local replay's
    // on Base Sepolia, and the exploit never touched Arbitrum's vault.
    expect(out.local_verdict).toStrictEqual({ outcome: "PAYS", reason: "minimum_theft_reached" });
    expect(out.verdict).toStrictEqual(out.local_verdict);
    expect(out.paid).toBe(true);
    expect(usdcOf(ARBITRUM, on(ARBITRUM))).toBe(arbBefore.usdc);
    expect(sharesOf(ARBITRUM, on(ARBITRUM).vault)).toBe(arbBefore.shares);

    // R7.4, D1: a pause for every covered contract on both chains, broadcast, and both read paused.
    const bounty = await near.view(contract, "bounty", { id });
    expect(bounty.state).toBe("paid");
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
    const verifications = await near.view(contract, "pause_verifications", { id });
    record("R7.10 pause_verifications", verifications);
    expect(r.code, r.stderr || r.stdout).toBe(0);
    for (const chain of [BASE, ARBITRUM]) {
      const v = verifications.find((x: any) => x.chain_id === chain);
      const stored = bounty.signed_pauses.find((p: any) => p.chain_id === chain).tx_hash;
      expect(v, `chain ${chain}`).toMatchObject({ verified: true, verified_pauses: [stored] });
    }
  }, 4_200_000);
});
