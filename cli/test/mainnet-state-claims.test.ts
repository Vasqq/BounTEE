// Ticket #59, then #35 (ADR-0020): the new vault's mainnet claims, rehearsed before any mainnet
// spend with the very judge build bounty2.bountee.near pins, so none fails while the mainnet
// vaults sit funded (R3.10, R4.11 rehearsals): the cheat proven on Base, and the win proven on
// Base and on Arbitrum One, since the agent may win on either chain.
//
// Where this sits (outside the five seams, so recorded here, as CLAUDE.md asks): seam T's
// interface, the command-line tool's `bountee test`, driven as seam T drives it, but on a local
// copy of mainnet instead of testnet, because what it checks (Circle's USDC, Uniswap V2, the
// mainnet judge build) exists only on mainnet, where nothing may be spent before #35's run. The
// result is a recorded analysis (requirements.md's method A), not mainnet evidence.
//
// Seams (written before the first test): `bountee test` against plain anvils loaded with
// `mainnet-state/build.ts`'s copies of Base and Arbitrum One (Circle's USDC, Uniswap V2 on Base,
// the vault the deploy script deployed and seeded with 2 USDC on each), judged by the build
// bounty2.bountee.near pins (sha256 497dc9b7…), under the demo bounty's mainnet rules.
//   Catches: the sealed exploit paying on either chain and the mainnet cheat (a fresh account
//   buys USDC through Uniswap V2, deposits, redeems) scoring zero on Base, on mainnet's real code
//   and the enclave's real program, Arbitrum One replayed under its compiled profile (Osaka, the
//   32M gas cap, randomness 1); each claim's proven reads matching the read lists the claim
//   budget is built on (claim-budget.ts, DEMO_READS: #52 traced them, here the judge proves
//   them); and how long fetching those proofs from each chain's real proof RPCs takes against
//   the 300 s recency limit.
//   Misses: mainnet itself (the copy holds only what the claims touch, so trie sizes, and so
//   input bytes, are small here: the budget's sizes come from the real chain, `budgetClaims`),
//   a real Arbitrum One header (the copy's blocks are anvil's; a no-op claim on the live chains
//   covers that), OutLayer, the claim and payout transactions, and the win's pauses landing and
//   verified on both chains (R7.4, R7.10: #35's run, rehearsed on testnet by #67 and #35's cold agent).
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
import { CHAINS, defaultRpc, proofRpcs } from "../src/chains.ts";
import { fetchProof, rpc } from "../src/proofs.ts";
import { BLOCKS_BEHIND } from "../src/test.ts";
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

/** The claims rehearsed: the cheat where the run files it, the win on each chain the agent may pick. */
const CASES = [
  { kind: "cheat", chain: 8453, outcome: "ZERO", requirement: "R4.11" },
  { kind: "win", chain: 8453, outcome: "PAYS", requirement: "R3.10" },
  { kind: "win", chain: 42161, outcome: "PAYS", requirement: "R3.10" },
] as const;
type Case = (typeof CASES)[number];
/** The name `--chain` takes for a chain, as the agent would type it. */
const chainName = (chainId: number) => CHAINS[chainId]!.names[0]!;

describe.skipIf(!RUN)("the new vault's mainnet claims on local copies of Base and Arbitrum One (#59, #35)", () => {
  const manifest = RUN ? JSON.parse(readFileSync(MANIFEST!, "utf8")) : {};
  const dir = RUN ? dirname(MANIFEST!) : "";
  /** Each chain's loaded copy: its anvil, the head the claims are judged at, and its manifest entry. */
  const loaded: Record<number, { proc: ChildProcess; url: string; block: number; manifestChain: any }> = {};
  let rulesFile: string;
  let judge: string;
  const results: Record<string, unknown> = { label: "Recorded analysis on a local copy of mainnet state, not mainnet evidence (#59, #35)" };
  const record = (k: string, v: unknown) => {
    results[k] = v;
    writeFileSync(join(dir, "claims.json"), `${JSON.stringify(results, null, 2)}\n`);
  };

  beforeAll(async () => {
    judge = process.env.BOUNTEE_MAINNET_JUDGE ?? "";
    // The enclave's program and nothing else: the reproducible build whose sha256 the mainnet contract pins.
    expect(`0x${createHash("sha256").update(readFileSync(judge)).digest("hex")}`).toBe(manifest.rules.judge_build_hash);
    for (const chainId of new Set(CASES.map((c) => c.chain))) {
      const manifestChain = manifest.chains.find((c: any) => c.chain_id === chainId);
      const l = await loadState(manifestChain.state, chainId);
      // The head, whose state root is real (the loaded state's first block, the fork's, has none).
      loaded[chainId] = { proc: l.proc, url: l.url, block: Number(BigInt(await rpc<string>(l.url, "eth_blockNumber", []))), manifestChain };
    }
    rulesFile = join(dir, "rules.json");
    writeFileSync(rulesFile, JSON.stringify(manifest.rules));
  }, 120_000);

  afterAll(() => Object.values(loaded).forEach((l) => l.proc.kill()));

  /** `bountee test` of one case on its chain's copy; returns its result and the job it saved. */
  function claim({ kind, chain }: Case, script: string): Promise<{ result: any; job: any }> {
    const out = join(dir, `${kind}-${chain}-job.json`);
    const { url, block, manifestChain } = loaded[chain]!;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [entry, "test", script, "--bounty", rulesFile, "--chain", chainName(chain), "--rpc", url, "--block", String(block), "--judge", judge, "--out", out, "--json"], {
        cwd: repo,
        env: { ...process.env, VAULT: manifestChain.vault },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error(`bountee test (${kind} on ${chainName(chain)}) exited ${code}:\n${stderr}`));
        resolve({ result: JSON.parse(stdout.trim().split("\n").pop()!), job: JSON.parse(readFileSync(out, "utf8")).replay });
      });
    });
  }

  /**
   * Each proven account's role and slot count. Which address plays which role is read from the
   * real chain itself (read-only), as the fresh-instance preflight reads it: the copy holds only
   * what the claims touch, and the swap never reads the factory's pair mapping.
   */
  async function provenReads(job: any, { kind, chain }: Case): Promise<Partial<Record<Role, number>>> {
    const { url, block, manifestChain } = loaded[chain]!;
    const usdc = manifestChain.usdc.toLowerCase();
    const real = defaultRpc(chain)!;
    const impl = `0x${BigInt(await rpc<string>(real, "eth_getStorageAt", [usdc, IMPLEMENTATION_SLOT, "latest"])).toString(16).padStart(40, "0")}`;
    const coinbase = (await rpc<{ miner: string }>(url, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false])).miner.toLowerCase();
    const roles: Record<string, Role> = {
      [job.exploit.transactions[0].from]: "sender", [coinbase]: "coinbase", [manifestChain.vault]: "vault", [usdc]: "usdc", [impl]: "usdc_implementation",
    };
    // The cheat buys its USDC through Uniswap V2 (on Base, where it is filed).
    if (kind === "cheat") {
      const weth = cast("call", UNISWAP_V2_ROUTER, "WETH()(address)", "--rpc-url", real);
      const pair = cast("call", cast("call", UNISWAP_V2_ROUTER, "factory()(address)", "--rpc-url", real), "getPair(address,address)(address)", weth, usdc, "--rpc-url", real);
      Object.assign(roles, { [UNISWAP_V2_ROUTER]: "uniswap_router", [pair]: "uniswap_pair", [weth]: "weth" });
    }
    const reads: Partial<Record<Role, number>> = {};
    for (const p of job.proofs) {
      const role = roles[p.address.toLowerCase()];
      if (!role) throw new Error(`a proof for ${p.address}, which no budgeted role covers`);
      reads[role] = p.storage.length;
    }
    return reads;
  }

  /**
   * Fetches the job's proofs again from the chain's real proof RPCs, timing each RPC; reads only. At
   * three blocks behind each RPC's head, as `bountee test` and `claim` pick the claim's block
   * (cli/src/test.ts, BLOCKS_BEHIND): a load-balanced RPC can name a head whose state it doesn't
   * serve yet, and Base's did here ("no state found").
   */
  async function timeProofs(job: any, chain: number) {
    const timings: { rpc: string; ms: number }[] = [];
    for (const proofRpc of proofRpcs(chain)) {
      const head = Number(BigInt(await rpc<string>(proofRpc, "eth_blockNumber", []))) - BLOCKS_BEHIND;
      const start = Date.now();
      for (const p of job.proofs) await fetchProof(proofRpc, p.address, p.storage.map((s: any) => s.key), head);
      timings.push({ rpc: proofRpc, ms: Date.now() - start });
    }
    return timings;
  }

  for (const c of CASES) {
    const { kind, chain, outcome, requirement } = c;
    const name = chainName(chain);
    test(`${requirement} rehearsal: on the copy of mainnet the ${kind} claim proven on ${name} is judged ${outcome} by the pinned judge, its reads match the claim budget's, and its proofs fetch well inside the recency limit`, async () => {
      const script = kind === "cheat" ? join(repo, "demo/script/HonestUser.s.sol") : sealedExploit();
      const { result, job } = await claim(c, script);
      expect(result.block.chain_id).toBe(chain);
      expect(result.verdict.outcome).toBe(outcome);
      const reads = await provenReads(job, c);
      expect(reads).toEqual(DEMO_READS.mainnet[kind]);
      const timings = await timeProofs(job, chain);
      for (const t of timings) expect(t.ms).toBeLessThan(manifest.rules.recency_limit_secs * 1000);
      const slowest = Math.max(...timings.map((t) => t.ms));
      record(`${kind}-${name}`, {
        verdict: result.verdict, chain_id: chain, block: loaded[chain]!.block, proven_reads: reads, proof_fetch_ms_on_mainnet: timings,
        recency_limit_secs: manifest.rules.recency_limit_secs, margin_secs: manifest.rules.recency_limit_secs - Math.ceil(slowest / 1000),
      });
    }, 600_000);
  }
});
