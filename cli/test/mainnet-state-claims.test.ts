// Ticket #59: the new vault's two mainnet claims, rehearsed before any mainnet spend with the very
// judge build the mainnet bounty contract pins, so neither fails while the mainnet vaults sit
// funded (R3.10, R4.11 rehearsals).
//
// Where this sits (outside the five seams, so recorded here, as CLAUDE.md asks): seam T's
// interface, the command-line tool's `bountee test`, driven as seam T drives it, but on a local
// copy of mainnet instead of testnet, because what it checks (Circle's USDC, Uniswap V2, the
// mainnet judge build) exists only on mainnet, where nothing may be spent before #35's run. The
// result is a recorded analysis (requirements.md's method A), not mainnet evidence.
//
// Seams (written before the first test): `bountee test` against a plain anvil loaded with
// `mainnet-state/build.ts`'s copy of Base (Circle's USDC, Uniswap V2, the vault the deploy
// script deployed and seeded with 2 USDC), judged by the pinned mainnet build (sha256
// 5b3ba189…), under the demo bounty's mainnet rules.
//   Catches: the sealed exploit paying and the mainnet cheat (a fresh account buys USDC through
//   Uniswap V2, deposits, redeems) scoring zero, on mainnet's real code and the enclave's real
//   program; each claim's proven reads matching the read lists the claim budget is built on
//   (claim-budget.ts, DEMO_READS: #52 traced them, here the judge proves them); and how long
//   fetching those proofs from the real Base proof RPCs takes against the 300 s recency limit.
//   Misses: mainnet itself (the copy holds only what the claims touch, so trie sizes, and so
//   input bytes, are small here: the budget's sizes come from the real chain, `budgetClaims`),
//   OutLayer, and the claim and payout transactions (#35's run).
// A recorded analysis on a local copy, not mainnet evidence (requirements.md, testnet and local
// runs are rehearsals). Results go to <state dir>/claims.json.
//
// Runs only with BOUNTEE_MAINNET_STATE (the harness's manifest.json), SEALED_EXPLOIT (the sealed
// exploit script) and BOUNTEE_MAINNET_JUDGE (the reproducible build of the pinned judge).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { defaultRpc, proofRpcs } from "../src/chains.ts";
import { fetchProof, rpc } from "../src/proofs.ts";
import { loadState } from "./mainnet-state/build.ts";
import { DEMO_READS, type Role } from "./testnet/claim-budget.ts";
import { sealedExploit } from "./testnet/sealed-exploit.ts";

const MANIFEST = process.env.BOUNTEE_MAINNET_STATE;
const RUN = !!MANIFEST;
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const UNISWAP_V2_ROUTER = "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24";
/** Circle's FiatTokenProxy keeps its implementation at ZeppelinOS's slot. */
const IMPLEMENTATION_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

const cast = (...args: string[]) => spawnSync("cast", args, { encoding: "utf8" }).stdout.trim().split(" ")[0]!.toLowerCase();

describe.skipIf(!RUN)("the new vault's mainnet claims on a local copy of Base (#59)", () => {
  const manifest = RUN ? JSON.parse(readFileSync(MANIFEST!, "utf8")) : {};
  const base = RUN ? manifest.chains.find((c: any) => c.chain_id === 8453) : {};
  const dir = RUN ? dirname(MANIFEST!) : "";
  let anvil: ChildProcess;
  let url: string;
  let block: number;
  let rulesFile: string;
  let judge: string;
  const results: Record<string, unknown> = {};
  const record = (k: string, v: unknown) => {
    results[k] = v;
    writeFileSync(join(dir, "claims.json"), `${JSON.stringify(results, null, 2)}\n`);
  };

  beforeAll(async () => {
    judge = process.env.BOUNTEE_MAINNET_JUDGE ?? "";
    // The enclave's program and nothing else: the reproducible build whose sha256 the mainnet contract pins.
    expect(`0x${createHash("sha256").update(readFileSync(judge)).digest("hex")}`).toBe(manifest.rules.judge_build_hash);
    const loaded = await loadState(base.state, 8453);
    anvil = loaded.proc;
    url = loaded.url;
    // The head, whose state root is real (the loaded state's first block, the fork's, has none).
    block = Number(BigInt(await rpc<string>(url, "eth_blockNumber", [])));
    rulesFile = join(dir, "rules.json");
    writeFileSync(rulesFile, JSON.stringify(manifest.rules));
  }, 120_000);

  afterAll(() => anvil?.kill());

  /** `bountee test` on the copy; returns its result and the job it saved. */
  function claim(kind: "cheat" | "win", script: string): Promise<{ result: any; job: any }> {
    const out = join(dir, `${kind}-job.json`);
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, "test", script, "--bounty", rulesFile, "--rpc", url, "--block", String(block), "--judge", judge, "--out", out, "--json"], {
        cwd: repo,
        env: { ...process.env, VAULT: base.vault },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`bountee test (${kind}) exited ${code}:\n${stderr}`));
        resolve({ result: JSON.parse(stdout.trim().split("\n").pop()!), job: JSON.parse(readFileSync(out, "utf8")).replay });
      });
    });
  }

  /**
   * Each proven account's role and slot count. Which address plays which role is read from Base
   * itself (read-only), as the fresh-instance preflight reads it: the copy holds only what the
   * claims touch, and the swap never reads the factory's pair mapping.
   */
  async function provenReads(job: any): Promise<Partial<Record<Role, number>>> {
    const usdc = base.usdc.toLowerCase();
    const real = defaultRpc(8453)!;
    const weth = cast("call", UNISWAP_V2_ROUTER, "WETH()(address)", "--rpc-url", real);
    const pair = cast("call", cast("call", UNISWAP_V2_ROUTER, "factory()(address)", "--rpc-url", real), "getPair(address,address)(address)", weth, usdc, "--rpc-url", real);
    const impl = `0x${BigInt(await rpc<string>(real, "eth_getStorageAt", [usdc, IMPLEMENTATION_SLOT, "latest"])).toString(16).padStart(40, "0")}`;
    const coinbase = (await rpc<{ miner: string }>(url, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false])).miner.toLowerCase();
    const roles: Record<string, Role> = {
      [job.exploit.transactions[0].from]: "sender", [coinbase]: "coinbase", [base.vault]: "vault", [usdc]: "usdc",
      [impl]: "usdc_implementation", [UNISWAP_V2_ROUTER]: "uniswap_router", [pair]: "uniswap_pair", [weth]: "weth",
    };
    const reads: Partial<Record<Role, number>> = {};
    for (const p of job.proofs) {
      const role = roles[p.address.toLowerCase()];
      if (!role) throw new Error(`a proof for ${p.address}, which no budgeted role covers`);
      reads[role] = p.storage.length;
    }
    return reads;
  }

  /** Fetches the job's proofs again from Base's real proof RPCs at their head, timing each RPC; reads only. */
  async function timeProofs(job: any) {
    const timings: { rpc: string; ms: number }[] = [];
    for (const proofRpc of proofRpcs(8453)) {
      const head = Number(BigInt(await rpc<string>(proofRpc, "eth_blockNumber", [])));
      const start = Date.now();
      for (const p of job.proofs) await fetchProof(proofRpc, p.address, p.storage.map((s: any) => s.key), head);
      timings.push({ rpc: proofRpc, ms: Date.now() - start });
    }
    return timings;
  }

  for (const [kind, outcome, requirement] of [["cheat", "ZERO", "R4.11"], ["win", "PAYS", "R3.10"]] as const) {
    test(`${requirement} rehearsal: on the copy of mainnet the ${kind} claim is judged ${outcome} by the pinned judge, its reads match the claim budget's, and its proofs fetch well inside the recency limit`, async () => {
      const script = kind === "cheat" ? join(repo, "demo/script/HonestUser.s.sol") : sealedExploit();
      const { result, job } = await claim(kind, script);
      expect(result.verdict.outcome).toBe(outcome);
      const reads = await provenReads(job);
      expect(reads).toEqual(DEMO_READS.mainnet[kind]);
      const timings = await timeProofs(job);
      for (const t of timings) expect(t.ms).toBeLessThan(manifest.rules.recency_limit_secs * 1000);
      record(kind, { verdict: result.verdict, block, proven_reads: reads, proof_fetch_ms_on_base_mainnet: timings, recency_limit_secs: manifest.rules.recency_limit_secs });
    }, 600_000);
  }
});
