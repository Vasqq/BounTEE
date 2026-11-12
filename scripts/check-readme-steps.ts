// Runs every "do X → see Y" step in the README, checks every link in it, and reports every slot
// still waiting for a fact (R15.4).
//
//   node scripts/check-readme-steps.ts [--offline] [--strict] [--readme <file>] [--json]
//
// Steps. A step is a `$ <command>` line in a ```console block; the lines after it, up to the
// next `$ ` line or the block's end, are what its output must show: each must appear in the
// command's stdout or stderr, compared with runs of spaces collapsed. The command runs from the
// repo root under bash, with `bountee` meaning `node cli/src/main.ts`, and must exit 0. A
// ```console online block needs the network (but no keys or funds); --offline skips it. A
// ```console pending block, or a command holding a placeholder, is reported pending, not run.
//
// Placeholders. `<!-- PENDING: what goes here -->`, anywhere in the README (prose, tables, link
// targets, console blocks), marks a slot still waiting for a fact. Each is reported pending;
// a link or step holding one is not checked.
//
// Links. Markdown links and images, reference definitions, and HTML href/src, outside code:
//   - a repo-relative path (resolved against the README's folder) must exist; checked offline too;
//   - an explorer link is checked on the chain, never the explorer (nearblocks and basescan refuse
//     automated requests): a NEAR account (nearblocks.io/address/…) must exist on NEAR RPC; a NEAR
//     transaction (nearblocks.io/txns/…) carries only its hash, so its signer is found through
//     FastNEAR's transaction API and the transaction then confirmed on NEAR RPC (or its archival
//     RPC, for one the ordinary RPC no longer keeps); an EVM transaction (basescan.org/tx/…,
//     arbiscan.io/tx/…) must have a successful receipt on that chain's RPC, and an EVM address
//     must have code or a balance there;
//   - any other http(s) URL must answer with a success status.
//   --offline checks repo paths only and reports the rest skipped.
//   Endpoints, each overridable: NEAR_RPC, NEAR_ARCHIVAL_RPC, TX_API, EVM_RPC_8453 (Base),
//   EVM_RPC_42161 (Arbitrum One).
//
// Exit status: 0 when every step run and every link checked passed (and, under --strict, nothing
// is pending), 1 otherwise, 2 for bad arguments.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Status = "ok" | "FAIL" | "pending" | "skipped";
type Step = { command: string; expect: string[]; online: boolean; pending: boolean };
type Link = { target: string; status: Status; reason?: string };

const repo = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const readmeAt = args.indexOf("--readme");
const readme = readmeAt >= 0 ? args[readmeAt + 1] : `${repo}README.md`;
if (!readme || args.some((a, i) => a.startsWith("--") && !["--offline", "--strict", "--json", "--readme"].includes(a) && args[i - 1] !== "--readme")) {
  console.error("usage: node scripts/check-readme-steps.ts [--offline] [--strict] [--readme <file>] [--json]");
  process.exit(2);
}

const env = process.env;
const ENDPOINTS = {
  nearRpc: env.NEAR_RPC ?? "https://free.rpc.fastnear.com",
  nearArchivalRpc: env.NEAR_ARCHIVAL_RPC ?? "https://archival-rpc.mainnet.fastnear.com",
  txApi: env.TX_API ?? "https://tx.main.fastnear.com",
  evm: {
    8453: env.EVM_RPC_8453 ?? "https://mainnet.base.org",
    42161: env.EVM_RPC_42161 ?? "https://arb1.arbitrum.io/rpc",
  } as Record<number, string>,
};

const PLACEHOLDER = /<!--\s*PENDING:\s*([\s\S]*?)\s*-->/g;
const hasPlaceholder = (s: string) => /<!--\s*PENDING:/.test(s);

/** Every step in the README, in order. */
function steps(markdown: string): Step[] {
  const out: Step[] = [];
  for (const [, info, body] of markdown.matchAll(/^```(console[^\n]*)\n([\s\S]*?)^```/gm)) {
    const tags = info!.split(/\s+/);
    for (const line of body!.split("\n")) {
      if (line.startsWith("$ ")) {
        const command = line.slice(2).trim();
        out.push({ command, expect: [], online: tags.includes("online"), pending: tags.includes("pending") || hasPlaceholder(command) });
      } else if (line.trim() && out.length) {
        out.at(-1)!.expect.push(line.trim());
      }
    }
  }
  return out;
}

/** Every placeholder in the README, with its line, in order. */
function placeholders(markdown: string) {
  return [...markdown.matchAll(PLACEHOLDER)].map((m) => ({
    line: markdown.slice(0, m.index).split("\n").length,
    what: m[1]!.replace(/\s+/g, " "),
    status: "pending" as const,
  }));
}

/** Every link target outside code and HTML comments, in order; a placeholder's slot isn't one. */
function links(markdown: string): string[] {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  const prose = markdown
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank)
    .replace(/`[^`\n]*`/g, blank)
    .replace(PLACEHOLDER, (m) => `<${blank(m).slice(1, -1)}>`) // an empty <…> target, skipped below
    .replace(/<!--[\s\S]*?-->/g, blank);
  const found: { at: number; target: string }[] = [];
  const collect = (re: RegExp) => {
    for (const m of prose.matchAll(re)) found.push({ at: m.index!, target: m[1]!.replace(/^<|>$/g, "").trim() });
  };
  collect(/\]\(\s*(<[^>\n]*>|[^)\s]+)/g); // [text](target), ![alt](target), and the outer link of a linked image
  collect(/^\s{0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gm); // [ref]: target
  collect(/\b(?:href|src)\s*=\s*"([^"]*)"/g);
  collect(/<(https?:\/\/[^>\s]+)>/g); // <https://…> autolinks
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.target)
    .filter((t) => t && !t.startsWith("#") && !/^mailto:/i.test(t));
}

async function post(url: string, body: unknown): Promise<any> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}
const rpc = async (url: string, method: string, params: unknown) => post(url, { jsonrpc: "2.0", id: "bountee-readme", method, params });

const nearAccount = async (account: string): Promise<string | undefined> => {
  const r = await rpc(ENDPOINTS.nearRpc, "query", { request_type: "view_account", finality: "final", account_id: account });
  return r.result ? undefined : `no NEAR account ${account} on NEAR RPC`;
};

async function nearTx(hash: string): Promise<string | undefined> {
  const indexed = await post(`${ENDPOINTS.txApi}/v0/transactions`, { tx_hashes: [hash] });
  const signer = indexed?.transactions?.find((t: any) => t?.transaction?.hash === hash)?.transaction?.signer_id;
  if (!signer) return `FastNEAR's transaction API doesn't know NEAR transaction ${hash}`;
  for (const url of [ENDPOINTS.nearRpc, ENDPOINTS.nearArchivalRpc]) {
    const r = await rpc(url, "tx", { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" });
    if (r.result?.transaction?.hash === hash) return undefined;
  }
  return `NEAR RPC doesn't confirm transaction ${hash} signed by ${signer}`;
}

async function evmTx(chain: number, hash: string): Promise<string | undefined> {
  const r = await rpc(ENDPOINTS.evm[chain]!, "eth_getTransactionReceipt", [hash]);
  if (!r.result) return `no receipt for ${hash} on chain ${chain}`;
  return r.result.status === "0x1" ? undefined : `transaction ${hash} reverted on chain ${chain}`;
}

async function evmAddress(chain: number, address: string): Promise<string | undefined> {
  const [code, balance] = await Promise.all([rpc(ENDPOINTS.evm[chain]!, "eth_getCode", [address, "latest"]), rpc(ENDPOINTS.evm[chain]!, "eth_getBalance", [address, "latest"])]);
  if (typeof code.result === "string" && code.result !== "0x") return undefined;
  if (typeof balance.result === "string" && BigInt(balance.result) > 0n) return undefined;
  return `${address} has no code and no balance on chain ${chain}`;
}

const EVM_EXPLORERS: Record<string, number> = { "basescan.org": 8453, "arbiscan.io": 42161 };

/** The check for one absolute URL: on the chain for an explorer link, else its HTTP status. */
async function checkUrl(url: URL): Promise<string | undefined> {
  const host = url.hostname.replace(/^www\./, "");
  const [kind, id] = url.pathname.split("/").filter(Boolean);
  if (host === "nearblocks.io" && id) {
    if (kind === "txns" || kind === "tx") return nearTx(id);
    if (kind === "address") return nearAccount(id);
  }
  const chain = EVM_EXPLORERS[host];
  if (chain && id) {
    if (kind === "tx") return evmTx(chain, id);
    if (kind === "address") return evmAddress(chain, id);
  }
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "bountee-readme-checker" }, signal: AbortSignal.timeout(30_000) });
  await res.body?.cancel();
  return res.ok ? undefined : `HTTP ${res.status}`;
}

async function checkLink(target: string, base: string): Promise<Link> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) {
    if (!/^https?:/i.test(target)) return { target, status: "skipped", reason: "not http(s)" };
    if (flag("--offline")) return { target, status: "skipped" };
    try {
      const reason = await checkUrl(new URL(target));
      return reason ? { target, status: "FAIL", reason } : { target, status: "ok" };
    } catch (e) {
      return { target, status: "FAIL", reason: (e as Error).message };
    }
  }
  const path = decodeURIComponent(target.replace(/[?#].*$/, ""));
  return existsSync(resolve(base, path.replace(/^\/+/, ""))) ? { target, status: "ok" } : { target, status: "FAIL", reason: "no such file in the repo" };
}

const squash = (s: string) => s.replace(/[ \t]+/g, " ");
const bountee = `bountee() { node ${JSON.stringify(`${repo}cli/src/main.ts`)} "$@"; }`;

const markdown = readFileSync(readme, "utf8");
const waiting = placeholders(markdown);
const linkResults = await Promise.all(links(markdown).map((t) => checkLink(t, dirname(resolve(readme)))));

const results: { command: string; status: Status; missing?: string[]; output?: string }[] = [];
for (const step of steps(markdown)) {
  if (step.pending) {
    results.push({ command: step.command, status: "pending" });
    continue;
  }
  if (step.online && flag("--offline")) {
    results.push({ command: step.command, status: "skipped" });
    continue;
  }
  const res = spawnSync("bash", ["-c", `${bountee}\n${step.command}`], { cwd: repo, encoding: "utf8", timeout: 600_000 });
  const output = squash(`${res.stdout ?? ""}${res.stderr ?? ""}`);
  const missing = step.expect.filter((e) => !output.includes(squash(e)));
  const ok = res.status === 0 && missing.length === 0;
  results.push(ok ? { command: step.command, status: "ok" } : { command: step.command, status: "FAIL", missing, output: `exit ${res.status}\n${output}` });
}

const failed =
  results.some((r) => r.status === "FAIL" || (r.status === "pending" && flag("--strict"))) ||
  linkResults.some((l) => l.status === "FAIL") ||
  (waiting.length > 0 && flag("--strict"));
if (flag("--json")) {
  console.log(
    JSON.stringify({
      steps: results.map(({ command, status, missing }) => (missing ? { command, status, missing } : { command, status })),
      links: linkResults.map((l) => (l.status === "skipped" ? { target: l.target, status: l.status } : l)),
      placeholders: waiting,
    }),
  );
} else {
  for (const r of results) {
    console.log(`${r.status.padEnd(8)} ${r.command}`);
    if (r.status === "FAIL") {
      for (const m of r.missing!) console.log(`         expected: ${m}`);
      console.log(r.output!.replace(/^/gm, "         | "));
    }
  }
  for (const l of linkResults) console.log(`${l.status.padEnd(8)} link ${l.target}${l.status === "FAIL" ? `: ${l.reason}` : ""}`);
  for (const p of waiting) console.log(`pending  placeholder line ${p.line}: ${p.what}`);
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  const linkCount = (s: Status) => linkResults.filter((l) => l.status === s).length;
  console.log(`\nsteps: ${count("ok")} ok, ${count("FAIL")} failed, ${count("pending")} pending, ${count("skipped")} skipped (online)`);
  console.log(
    `links: ${linkCount("ok")} ok, ${linkCount("FAIL")} failed` +
      (flag("--offline") ? `, ${linkCount("skipped")} chain and URL links skipped (--offline)` : linkCount("skipped") ? `, ${linkCount("skipped")} skipped (not http)` : ""),
  );
  console.log(`placeholders: ${waiting.length} pending${waiting.length && flag("--strict") ? " (refused under --strict)" : ""}`);
}
process.exit(failed ? 1 : 0);
