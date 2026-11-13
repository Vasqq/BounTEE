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
// Parity with the landing page (D38). The README's Mainnet proof section (a `## Mainnet proof`
// heading, to the next heading of its level or above) holds a step table: the first table there
// whose first column is headed "Step". Each row is one step: its first cell the step's name, its
// links that step's transactions.
//   - names: the rows' names, in order, must be exactly the landing page's eight (`STEPS` in
//     web/components/landing/Landing.tsx and again in its browser script runtime.js, read from
//     the source as text, and the two must agree); a step with no row, an extra row, a renamed
//     or reordered step fails. Checked offline too.
//   - transactions: each row's links (compared without query or fragment) must be exactly the
//     transactions the landing page's demo reader (`readDemo` in web/lib/demo.ts, imported here)
//     returns for that step of the mainnet demo bounty. A row holding a placeholder isn't
//     compared and leaves the check pending. Online only; the reader takes its endpoints and demo
//     bounty from the same environment as the web app's server (web/lib/config.ts: NEAR_RPC,
//     NEAR_ARCHIVAL_RPC, TX_API, OUTLAYER_API, EVM_RPC_<chain>, DEMO_BOUNTY, BOUNTY_CONTRACT),
//     always as the mainnet build: NEXT_PUBLIC_NETWORK is unset.
//   A README with no step table is reported pending, and under --strict fails: the final README
//   must hold one.
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

/** A link compared without its query or fragment. */
const QUERY = /[?#].*$/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A fetch that waits and tries again when the server says it's busy (429 or 5xx), up to four
 * times. Public RPCs rate-limit a burst of requests, and a busy answer says nothing about the link.
 */
async function patientFetch(url: string | URL, init: RequestInit): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    if ((res.status !== 429 && res.status < 500) || attempt === 4) return res;
    await res.body?.cancel();
    const after = Number(res.headers.get("retry-after"));
    await sleep(after > 0 ? Math.min(after, 10) * 1000 : 1000 * 2 ** attempt);
  }
}

async function post(url: string, body: unknown): Promise<any> {
  const res = await patientFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
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
  const res = await patientFetch(url, { redirect: "follow", headers: { "user-agent": "bountee-readme-checker" } });
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
  const path = decodeURIComponent(target.replace(QUERY, ""));
  return existsSync(resolve(base, path.replace(/^\/+/, ""))) ? { target, status: "ok" } : { target, status: "FAIL", reason: "no such file in the repo" };
}

type Parity = { names: Status; transactions: Status; problems: string[] };
const NO_TABLE = "no step table in the Mainnet proof section";

/** The Mainnet proof section's step table, one entry per row; null when there's none. */
function stepTable(markdown: string): { name: string; links: string[]; pending: boolean }[] | null {
  const lines = markdown.split("\n");
  const start = lines.findIndex((l) => /^#{1,6}\s+Mainnet proof\b/i.test(l));
  if (start < 0) return null;
  const level = lines[start]!.match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && new RegExp(`^#{1,${level}}\\s`).test(l));
  const section = lines.slice(start + 1, end < 0 ? undefined : end);
  const isRow = (l: string | undefined) => !!l?.trim().startsWith("|");
  const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const plain = (c: string) => c.replace(/[*_`]/g, "").trim();
  for (let i = 0; i + 1 < section.length; i++) {
    if (!isRow(section[i]) || isRow(section[i - 1])) continue; // a table's header row only
    if (plain(cells(section[i]!)[0] ?? "") !== "Step" || !/^\s*\|?\s*:?-+/.test(section[i + 1]!)) continue;
    const rows = [];
    for (let j = i + 2; isRow(section[j]); j++) {
      const [first = "", ...rest] = cells(section[j]!);
      const links = [...rest.join("|").matchAll(/\]\(\s*<?([^)\s>]+)/g)].map((m) => m[1]!.replace(QUERY, ""));
      rows.push({ name: plain(first), links, pending: hasPlaceholder(section[j]!) });
    }
    return rows;
  }
  return null;
}

/**
 * The landing page's eight step names, read from its source. The page keeps them twice: the
 * component's list (the "All eight steps' transactions" list) and its browser script's (the
 * panel headings and the dock). Both are read, and they must agree, so a rename in either one
 * alone can't pass. LANDING_STEP_SOURCES (colon-separated paths) replaces the two for tests.
 */
function landingSteps(): string[] {
  const sources = process.env.LANDING_STEP_SOURCES?.split(":") ?? [`${repo}web/components/landing/Landing.tsx`, `${repo}web/components/landing/runtime.js`];
  const lists = sources.map((path) => {
    const list = readFileSync(path, "utf8").match(/const STEPS\s*=\s*(\[[^\]]*\])/)?.[1];
    if (!list) throw new Error(`no \`const STEPS = [...]\` in ${path}`);
    return JSON.parse(list.replace(/'/g, '"')) as string[];
  });
  const differs = lists.findIndex((l) => l.join("\n") !== lists[0]!.join("\n"));
  if (differs > 0) throw new Error(`the landing page's step names differ: ${sources[0]} has ${lists[0]!.join(", ")}; ${sources[differs]} has ${lists[differs]!.join(", ")}`);
  return lists[0]!;
}

/** The README's step table against the landing page's names and its demo reader's transactions (D38). */
async function parity(markdown: string): Promise<Parity> {
  const table = stepTable(markdown);
  if (!table) {
    const status: Status = flag("--strict") ? "FAIL" : "pending";
    return { names: status, transactions: status, problems: [NO_TABLE] };
  }
  const steps = landingSteps();
  const problems: string[] = [];
  for (let i = 0; i < Math.max(steps.length, table.length); i++) {
    const [mine, page] = [table[i]?.name, steps[i]];
    if (mine === page) continue;
    if (mine === undefined) problems.push(`no row for step ${i + 1}, "${page}"`);
    else if (page === undefined) problems.push(`row ${i + 1}, "${mine}", is not one of the landing page's ${steps.length} steps`);
    else problems.push(`row ${i + 1} is "${mine}" where the landing page has "${page}"`);
  }
  const names: Status = problems.length ? "FAIL" : "ok";
  if (flag("--offline")) return { names, transactions: "skipped", problems };

  delete process.env.NEXT_PUBLIC_NETWORK; // the README's proof is mainnet's: read it as the mainnet build does
  const { readDemo } = (await import(`${repo}web/lib/demo.ts`)) as typeof import("../web/lib/demo.ts");
  let demo: Awaited<ReturnType<typeof readDemo>> = null;
  for (let attempt = 0; ; attempt++) {
    try {
      demo = await readDemo();
      break;
    } catch (e) {
      // The reader is the landing page's own and doesn't retry a rate-limited RPC; give it room.
      if (attempt === 3) return { names, transactions: "FAIL", problems: [...problems, `the landing page's demo reader failed: ${(e as Error).message}`] };
      await sleep(2000 * 2 ** attempt);
    }
  }
  if (!demo) return { names, transactions: "FAIL", problems: [...problems, "the landing page's demo reader found no demo bounty"] };
  let failed = false;
  let pending = false;
  for (const row of table) {
    const i = steps.indexOf(row.name);
    if (i < 0) continue; // already a names failure
    if (row.pending) {
      pending = true;
      continue;
    }
    const theirs = (demo.story.steps[i] ?? []).filter((t) => t.hash).map((t) => t.href.replace(QUERY, ""));
    for (const link of row.links.filter((l) => !theirs.includes(l))) {
      failed = true;
      problems.push(`${row.name} cites ${link}, which the landing page's demo reader doesn't return for that step`);
    }
    for (const link of theirs.filter((l) => !row.links.includes(l))) {
      failed = true;
      problems.push(`${row.name} doesn't cite ${link}, which the landing page's demo reader returns for that step`);
    }
  }
  return { names, transactions: failed ? "FAIL" : pending ? "pending" : "ok", problems };
}

const squash = (s: string) => s.replace(/[ \t]+/g, " ");
const bountee = `bountee() { node ${JSON.stringify(`${repo}cli/src/main.ts`)} "$@"; }`;

const markdown = readFileSync(readme, "utf8");
const waiting = placeholders(markdown);
/** Each link once, a few at a time, so public RPCs aren't hit with a burst. */
async function checkLinks(targets: string[], base: string): Promise<Link[]> {
  const unique = [...new Set(targets)];
  const checked = new Map<string, Link>();
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < unique.length) {
        const target = unique[next++]!;
        checked.set(target, await checkLink(target, base));
      }
    }),
  );
  return targets.map((t) => checked.get(t)!);
}
// Links first, then the landing page's reader, which makes its own burst of RPC calls.
const linkResults = await checkLinks(links(markdown), dirname(resolve(readme)));
const parityResult = await parity(markdown);

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
  parityResult.names === "FAIL" ||
  parityResult.transactions === "FAIL" ||
  ([parityResult.names, parityResult.transactions].includes("pending") && flag("--strict")) ||
  (waiting.length > 0 && flag("--strict"));
if (flag("--json")) {
  console.log(
    JSON.stringify({
      steps: results.map(({ command, status, missing }) => (missing ? { command, status, missing } : { command, status })),
      links: linkResults.map((l) => (l.status === "skipped" ? { target: l.target, status: l.status } : l)),
      placeholders: waiting,
      parity: parityResult,
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
  if (parityResult.problems[0] === NO_TABLE) {
    console.log(`${parityResult.names.padEnd(8)} parity: ${NO_TABLE}`);
  } else {
    console.log(`${parityResult.names.padEnd(8)} parity names`);
    console.log(`${parityResult.transactions.padEnd(8)} parity transactions${flag("--offline") ? " (--offline)" : ""}`);
    for (const p of parityResult.problems) console.log(`         ${p}`);
  }
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
