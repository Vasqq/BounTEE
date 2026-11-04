// `bountee test`: judge a Whitehat's Foundry script locally against the proof chain as it is
// now (ticket #11; D2, D3, R2.9, R4.5).
//
// 1. Pick a recent block of the proof chain from an ordinary public RPC.
// 2. Fork the chain at that block with anvil, give a fresh account the bounty's seed, and
//    dry-run the script as that account; its broadcast log becomes the shared Exploit.
// 3. Prove every account and slot the replay reads, from the same public RPC (proofs.ts).
// 4. Run the compiled judge under wasmtime and save its exact input (the `{"replay": …}`
//    job), so `claim` submits what `test` judged and anyone can re-run it.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { parseRules, toJson, type Exploit, type Rules, type Verdict } from "@bountee/formats";
import { collectReplay, exploitFromBroadcast, rpc } from "./proofs.ts";

/** Ordinary public RPCs that serve `eth_getProof` at recent blocks, in order of preference (spec, RPCs). */
export const PUBLIC_RPCS: Record<number, string[]> = {
  84532: ["https://sepolia.base.org", "https://84532.rpc.thirdweb.com"],
};

/** How far behind the head the claim's block is: a few seconds, since a public RPC can fail on the very latest. */
const BLOCKS_BEHIND = 3;

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
  nearRpc?: string;
}

export interface TestResult {
  verdict: Verdict;
  block: { number: number; hash: string };
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
  const m = /^([a-z0-9._-]+)\/([a-z0-9-]+)$/.exec(o.bounty);
  if (!m) throw new Error(`--bounty: ${o.bounty} is neither a rules file nor a bounty id <protocol>/<name>`);
  const contract = o.contract ?? process.env.BOUNTEE_CONTRACT;
  if (!contract) throw new Error("--bounty <id> needs the bounty contract's account: pass --contract or set BOUNTEE_CONTRACT");
  const args = Buffer.from(JSON.stringify({ id: { protocol: m[1], name: m[2] } })).toString("base64");
  const res = await rpc<{ result: number[] }>(o.nearRpc ?? "https://rpc.testnet.near.org", "query", {
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

function judgeWasm(o: TestOptions): string {
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

async function pickRpc(rules: Rules, o: TestOptions): Promise<{ urls: string[]; block: number }> {
  const urls = o.rpc ? [o.rpc] : PUBLIC_RPCS[rules.proof_chain];
  if (!urls) throw new Error(`no public RPC known for chain ${rules.proof_chain}: pass --rpc`);
  const errors: string[] = [];
  for (const [i, url] of urls.entries()) {
    try {
      const chain = Number(BigInt(await rpc<string>(url, "eth_chainId", [])));
      if (chain !== rules.proof_chain) throw new Error(`serves chain ${chain}, not ${rules.proof_chain}`);
      const head = Number(BigInt(await rpc<string>(url, "eth_blockNumber", [])));
      return { urls: urls.slice(i), block: o.block ?? head - BLOCKS_BEHIND };
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(`no RPC answered for chain ${rules.proof_chain}:\n${errors.join("\n")}`);
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
    const exploit: Exploit = exploitFromBroadcast(JSON.parse(readFileSync(saved, "utf8")));
    return { exploit, attacker: attacker.address };
  } finally {
    anvil.kill();
  }
}

export async function testCommand(o: TestOptions): Promise<TestResult> {
  const rules = await loadRules(o);
  const wasm = judgeWasm(o);
  const { urls, block } = await pickRpc(rules, o);
  const { exploit, attacker } = await scriptToExploit(o, rules, urls[0]!, block);

  // Prove up front what any replay reads: the senders, covered contracts and listed tokens.
  const accounts = [
    ...rules.covered_contracts.filter((c) => c.chain_id === rules.proof_chain).map((c) => c.address),
    ...rules.listed_tokens.map((t) => t.token).filter((t) => t !== "native"),
  ];
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const { replay, verdict, stderr } = await collectReplay({ rpc: url, block, rules, exploit, wasm, accounts });
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
