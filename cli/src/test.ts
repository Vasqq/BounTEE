// `bountee test`: judge a Whitehat's Foundry script locally against the proof chain as it is
// now (ticket #11; D2, D3, R2.9, R4.5).
//
// 1. Pick a recent block of the proof chain, the covered chain `--chain` names (D26), from an
//    ordinary public RPC.
// 2. Fork the chain at that block with anvil, give a fresh account the bounty's seed, and
//    dry-run the script as that account; its broadcast log becomes the shared Exploit.
// 3. Prove every account and slot the replay reads, from the same public RPC (proofs.ts).
// 4. Run the compiled judge under wasmtime and save its exact input (the `{"replay": …}`
//    job), so `claim` submits what `test` judged and anyone can re-run it.
//
// `bountee test --job <job.json>` replays a saved job instead (ticket #9; D19, R2.9): its
// recorded header and proofs, under the compiled judge, with no RPC, keys or funds. The demo
// bounty's exploit and cheat ship as such jobs in demo/fixtures/, so `test` on the demo runs
// offline.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { parseReplay, parseRules, toJson, type BlockRef, type Exploit, type Rules, type Verdict } from "@bountee/formats";
import { parseBountyId, proofChain } from "./bounties.ts";
import { chainLabel, proofRpcs } from "./chains.ts";
import type { Near } from "./near.ts";
import { collectReplay, exploitFromBroadcast, rpc, runJudge } from "./proofs.ts";

/** How far behind the head the claim's block is: a few seconds, since a public RPC can fail on the very latest. */
export const BLOCKS_BEHIND = 3;

const repo = fileURLToPath(new URL("../../", import.meta.url));

export interface TestOptions {
  script: string;
  bounty: string;
  sig?: string;
  out?: string;
  rpc?: string;
  block?: number;
  judge?: string;
  contract?: string;
  /** The covered chain to prove on (`--chain`, through `parseChain`); optional on a one-chain bounty (D26). */
  chain?: number;
  /** The NEAR network a bounty id is read from. */
  near: Near;
}

export interface TestResult {
  verdict: Verdict;
  block: BlockRef;
  attacker: string;
  rpc: string;
  transactions: number;
  proofs: number;
  saved: string;
  diagnostics: string[];
}

// ---- The bounty's rules ------------------------------------------------------------------------

async function loadRules(o: TestOptions): Promise<Rules> {
  if (existsSync(o.bounty)) return parseRules(JSON.parse(readFileSync(o.bounty, "utf8")));
  // Not a rules file: a bounty id, refused as every command refuses a bad one.
  const id = parseBountyId(o.bounty);
  const contract = o.contract ?? process.env.BOUNTEE_CONTRACT;
  if (!contract) throw new Error("--bounty <id> needs the bounty contract's account: pass --contract or set BOUNTEE_CONTRACT");
  const args = Buffer.from(JSON.stringify({ id })).toString("base64");
  const res = await o.near.rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: "bounty",
    args_base64: args,
  });
  const view = JSON.parse(Buffer.from(res.result).toString("utf8"));
  if (!view) throw new Error(`no bounty ${o.bounty} on ${contract}`);
  return parseRules(view.rules);
}

// ---- Local processes ---------------------------------------------------------------------------------

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 << 20 });
  if (res.error) throw new Error(`${cmd}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${cmd} ${args[0]} failed:\n${res.stdout}\n${res.stderr}`.trim());
  return res.stdout;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
  });
}

export function judgeWasm(o: { judge?: string }): string {
  if (o.judge) return resolve(o.judge);
  const target = readFileSync(`${repo}judge/wasm-target`, "utf8").trim();
  const wasm = `${repo}target/${target}/release/bountee-judge.wasm`;
  if (!existsSync(wasm)) run("cargo", ["build", "--release", "-p", "bountee-judge", "--target", target], repo);
  return wasm;
}

/** The Foundry project holding the script: the nearest directory with a foundry.toml. */
function foundryRoot(script: string): string {
  for (let dir = dirname(script); ; dir = dirname(dir)) {
    if (existsSync(`${dir}/foundry.toml`)) return dir;
    if (dirname(dir) === dir) throw new Error(`${script} is not inside a Foundry project (no foundry.toml)`);
  }
}

/** A fresh account: a random key no one has used, so it is absent at the claim's block (R4.1). */
function freshAccount(root: string): { key: string; address: string } {
  const key = `0x${randomBytes(32).toString("hex")}`;
  const address = run("cast", ["wallet", "address", "--private-key", key], root).trim().toLowerCase();
  return { key, address };
}

// ---- Steps ---------------------------------------------------------------------------------------------

async function pickRpc(chainId: number, o: TestOptions): Promise<{ urls: string[]; block: number }> {
  const urls = o.rpc ? [o.rpc] : proofRpcs(chainId);
  if (urls.length === 0) throw new Error(`no public RPC known for ${chainLabel(chainId)}: pass --rpc`);
  const errors: string[] = [];
  for (const [i, url] of urls.entries()) {
    try {
      const chain = Number(BigInt(await rpc<string>(url, "eth_chainId", [])));
      if (chain !== chainId) throw new Error(`serves ${chainLabel(chain)}, not ${chainLabel(chainId)}`);
      const head = Number(BigInt(await rpc<string>(url, "eth_blockNumber", [])));
      return { urls: urls.slice(i), block: o.block ?? head - BLOCKS_BEHIND };
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(`no RPC answered for ${chainLabel(chainId)}:\n${errors.join("\n")}`);
}

/** Dry-run the script as `attacker` on a fork at `block` and read back its broadcast as an Exploit (D3). */
async function scriptToExploit(o: TestOptions, rules: Rules, forkUrl: string, block: number) {
  const scriptPath = resolve(o.script.split(":")[0]!);
  const target = o.script.includes(":") ? `${scriptPath}:${o.script.split(":")[1]}` : scriptPath;
  const root = foundryRoot(scriptPath);
  const attacker = freshAccount(root);
  const port = await freePort();
  const anvilUrl = `http://127.0.0.1:${port}`;
  const anvil = spawn(
    "anvil",
    ["--fork-url", forkUrl, "--fork-block-number", String(block), "--port", String(port), "--silent", "--no-rate-limit"],
    { stdio: "ignore" },
  );
  try {
    for (let i = 0; ; i++) {
      try {
        await rpc(anvilUrl, "eth_blockNumber", []);
        break;
      } catch (e) {
        if (i > 300 || anvil.exitCode !== null) throw new Error(`anvil didn't start: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await rpc(anvilUrl, "anvil_setBalance", [attacker.address, `0x${BigInt(rules.seed.native).toString(16)}`]);
    const sigArgs = o.sig ? ["--sig", o.sig] : [];
    const stdout = run(
      "forge",
      ["script", target, ...sigArgs, "--root", root, "--rpc-url", anvilUrl, "--private-key", attacker.key],
      root,
    );
    const saved = /Transactions saved to: (.+-latest\.json)/.exec(stdout)?.[1]?.trim();
    if (!saved || !existsSync(saved)) throw new Error(`the script broadcast no transactions:\n${stdout}`);
    const broadcast: Exploit = exploitFromBroadcast(JSON.parse(readFileSync(saved, "utf8")));
    // Each transaction gets the claim block's whole gas limit, not forge's estimate: forge
    // estimates from the gas a transaction used, which for a deep reentrancy (each call keeps
    // 1/64 back) is far below the limit it needs, so the replay would run out of gas and a
    // real exploit score ZERO (#10's finding). The replay's gas price is 0, so gas costs the
    // Whitehat nothing, and the judge only refuses a transaction above the block's limit.
    const { gasLimit } = await rpc<{ gasLimit: string }>(forkUrl, "eth_getBlockByNumber", [`0x${block.toString(16)}`, false]);
    const gas = Number(BigInt(gasLimit));
    const exploit: Exploit = { transactions: broadcast.transactions.map((t) => ({ ...t, gas })) };
    return { exploit, attacker: attacker.address };
  } finally {
    anvil.kill();
  }
}

export async function testCommand(o: TestOptions): Promise<TestResult> {
  const rules = await loadRules(o);
  const chainId = proofChain(rules, o.chain);
  const wasm = judgeWasm(o);
  const { urls, block } = await pickRpc(chainId, o);
  const { exploit, attacker } = await scriptToExploit(o, rules, urls[0]!, block);

  // Prove up front what any replay reads: the senders, and the covered contracts and listed
  // tokens on the claim's chain (R3.8).
  const accounts = [
    ...rules.covered_contracts.filter((c) => c.chain_id === chainId).map((c) => c.address),
    ...rules.listed_tokens.filter((t) => t.chain_id === chainId && t.token !== "native").map((t) => t.token),
  ];
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const { replay, verdict, stderr } = await collectReplay({ rpc: url, chain: chainId, block, rules, exploit, wasm, accounts });
      const diagnostics = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
      if (!verdict) throw new Error(`the judge gave no verdict:\n${diagnostics.join("\n")}`);
      const job = `${toJson({ replay })}\n`;
      const id = Buffer.from(keccak_256(Buffer.from(toJson(exploit)))).toString("hex").slice(0, 8);
      const saved = resolve(o.out ?? `.bountee/test/${block}-${id}.json`);
      mkdirSync(dirname(saved), { recursive: true });
      writeFileSync(saved, job);
      return {
        verdict,
        block: replay.block,
        attacker,
        rpc: url,
        transactions: exploit.transactions.length,
        proofs: replay.proofs.length,
        saved,
        diagnostics,
      };
    } catch (e) {
      if ((e as Error).message.startsWith("the judge gave no verdict")) throw e;
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(`couldn't prove the replay's reads:\n${errors.join("\n")}`);
}

// ---- A saved job, offline ---------------------------------------------------------------------

export interface ReplayResult {
  verdict: Verdict;
  block: BlockRef;
  job: string;
  /** The compiled judge that gave the verdict, and whether it is the very build the bounty pins (the one the enclave runs). */
  judge: { wasm: string; sha256: string; bounty_build: string; same_as_bounty: boolean };
  transactions: number;
  proofs: number;
  diagnostics: string[];
}

/** Replay a saved job (one `test` saved, or a demo's committed job) from its own header and proofs, with no network (D19, R2.9). */
export function replayJob(o: { job: string; judge?: string }): ReplayResult {
  const replay = parseReplay(JSON.parse(readFileSync(o.job, "utf8")).replay);
  const wasm = judgeWasm(o);
  const sha256 = createHash("sha256").update(readFileSync(wasm)).digest("hex");
  const { verdict, stderr } = runJudge(wasm, replay);
  const diagnostics = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  if (!verdict) throw new Error(`the judge gave no verdict:\n${diagnostics.join("\n")}`);
  const bounty_build = replay.rules.judge_build_hash;
  return {
    verdict,
    block: replay.block,
    job: resolve(o.job),
    judge: { wasm, sha256, bounty_build, same_as_bounty: `0x${sha256}` === bounty_build },
    transactions: replay.exploit.transactions.length,
    proofs: replay.proofs.length,
    diagnostics,
  };
}

export function formatReplayResult(r: ReplayResult): string {
  return [
    `verdict: ${r.verdict.outcome} (${r.verdict.reason})`,
    `block:   ${r.block.number} ${r.block.hash} (recorded header and proofs, no RPC)`,
    `exploit: ${r.transactions} transaction(s), ${r.proofs} proven account(s), from ${r.job}`,
    `judge:   ${r.judge.wasm} (sha256 ${r.judge.sha256})`,
    r.judge.same_as_bounty
      ? "         the bounty's pinned build: the program the enclave runs"
      : `         not the bounty's pinned build ${r.judge.bounty_build} (that build differs only in the contract it answers to; pass it with --judge to run the enclave's exact program)`,
    ...r.diagnostics.map((d) => `judge:   ${d}`),
  ].join("\n");
}

export function formatTestResult(r: TestResult): string {
  return [
    `verdict: ${r.verdict.outcome} (${r.verdict.reason})`,
    `block:   ${r.block.number} ${r.block.hash}`,
    `exploit: ${r.transactions} transaction(s) from fresh account ${r.attacker}`,
    `proofs:  ${r.proofs} account(s), from ${r.rpc}`,
    `saved:   ${r.saved}`,
    ...r.diagnostics.map((d) => `judge:   ${d}`),
  ].join("\n");
}
