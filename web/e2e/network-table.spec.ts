// D30, ticket #72: every network value comes from one table (lib/network.ts). An inspection
// run as a test: the app's source outside the table names no chain ID, network host
// (explorer or RPC), NEAR account or MPC root key, so a second network is one more row in the
// table and never an edit scattered through the pages. It reads the source; no browser.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { expect, test } from "@playwright/test";
import { pauseRole } from "@bountee/formats";

const WEB = join(import.meta.dirname, "..");
const TABLE = "lib/network.ts";
/** The landing page's prototype script: it tells the one mainnet demo bounty and stays mainnet-only (ADR-0021). */
const EXCEPTIONS = ["components/landing/runtime.js"];
/** Hosts that carry no network value: fonts, and the source repository. */
const NEUTRAL_HOSTS = ["api.fontshare.com", "fonts.googleapis.com", "fonts.gstatic.com", "github.com"];

const NETWORK_VALUES: [string, RegExp][] = [
  // Mainnet's and testnet's covered chains, NEAR's Ethereum-compatible chains, Ethereum's.
  ["a chain ID", /(?<![\w.-])(8453|42161|84532|421614|397|398|11155111)(?![\w.-])/g],
  // The same chains' IDs as hex, as a wallet writes them.
  ["a chain ID in hex", /\b0x(2105|a4b1|14a34|66eee|18d|18e|aa36a7)\b/gi],
  ["a network host", /https?:\/\/([a-z0-9.-]+)/gi],
  // A host written without its scheme.
  ["a bare host", /(?<=["'`\s])([a-z0-9-]+(\.[a-z0-9-]+)*\.(io|org|com|ai|xyz))(?![\w.-])/gi],
  // A named account where text starts (after a quote, a space or a slash, so `s.account.near`
  // is code, not an account), or an implicit one: 64 hex characters.
  ["a NEAR account", /(?<=["'`\s/])[a-z0-9_-]+(\.[a-z0-9_-]+)*\.(near|testnet)(?![\w.-])|(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g],
  ["an MPC root key", /(MAINNET|TESTNET)_ROOT_PUBLIC_KEY|secp256k1:[1-9A-HJ-NP-Za-km-z]{20,}/g],
];

function sources(dir: string): string[] {
  return readdirSync(join(WEB, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(WEB, path)).isDirectory() ? sources(path) : /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

/** The code, without its comments: a comment may say "Base" or "mainnet"; only code reaches a page. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");

test("D30: web/app, web/components and web/lib name no chain ID, network host, NEAR account or MPC root key outside the network table", () => {
  const files = ["app", "components", "lib"].flatMap(sources).map((f) => relative(WEB, join(WEB, f)));
  expect(files).toContain(TABLE);
  const found: string[] = [];
  for (const file of files.filter((f) => f !== TABLE && !EXCEPTIONS.includes(f))) {
    const text = code(readFileSync(join(WEB, file), "utf8"));
    for (const [what, pattern] of NETWORK_VALUES) {
      for (const m of text.matchAll(pattern)) {
        if ((what === "a network host" || what === "a bare host") && NEUTRAL_HOSTS.includes(m[1]!.toLowerCase())) continue;
        found.push(`${file}: ${what}, ${m[0]}`);
      }
    }
  }
  expect(found).toEqual([]);
});

test("D30: the grep finds what it looks for, in the table and the listed exception", () => {
  // A check that can't fail proves nothing: the table holds a value of every kind, and the
  // landing script names mainnet's explorers and contract.
  const table = code(readFileSync(join(WEB, TABLE), "utf8"));
  const finds = (text: string, kind: string) => [...text.matchAll(NETWORK_VALUES.find(([what]) => what === kind)![1])].length;
  for (const kind of ["a chain ID", "a network host", "a NEAR account", "an MPC root key"]) expect(finds(table, kind), kind).toBeGreaterThan(0);
  const landing = code(readFileSync(join(WEB, EXCEPTIONS[0]!), "utf8"));
  expect(finds(landing, "a network host")).toBeGreaterThan(0);
  expect(finds(landing, "a NEAR account")).toBeGreaterThan(0);
});

/** The table's row as a build for `network` sees it: the table loaded in its own process with the setting set. */
function rowOf(network: "mainnet" | "testnet"): Record<string, unknown> {
  const load = `const { net } = await import("./${TABLE}"); console.log(JSON.stringify(net));`;
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", load], { cwd: WEB, env: { PATH: process.env.PATH, NODE_ENV: "production", NEXT_PUBLIC_NETWORK: network }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
}

/** Every value in a row: its strings and numbers, and each URL's host. */
function leaves(x: unknown): (string | number)[] {
  if (typeof x === "string") return /^https?:\/\//.test(x) ? [x, new URL(x).host] : [x];
  if (typeof x === "number") return [x];
  if (x && typeof x === "object") return Object.values(x).flatMap(leaves);
  return [];
}

test("D30: the testnet table names no mainnet host, account or chain ID", () => {
  const testnet = rowOf("testnet");
  expect(testnet.network).toBe("testnet");
  const values = leaves(testnet);
  const hosts = values.filter((v): v is string => typeof v === "string" && /^[a-z0-9.-]+\.[a-z]+$/.test(v));
  expect(hosts.length).toBeGreaterThan(0);
  // Mainnet's, written out: its explorers and RPCs, its accounts, its chains (Base, Arbitrum One, NEAR's 397, Ethereum).
  const MAINNET_HOSTS = ["basescan.org", "arbiscan.io", "nearblocks.io", "mainnet.base.org", "arb1.arbitrum.io", "eth-rpc.mainnet.near.org", "eth-explorer.near.org"];
  for (const host of hosts) expect(MAINNET_HOSTS, host).not.toContain(host);
  for (const v of values) if (typeof v === "string") expect(v, "a mainnet NEAR account").not.toMatch(/\.near$/);
  for (const id of [8453, 42161, 397, 1]) expect(values, `chain ${id}`).not.toContain(id);
  // Nor anything else the mainnet row names, beyond the words both share (the gas token, the chain families).
  const SHARED = new Set<string | number>(["ETH", "base", "arbitrum"]);
  const mainnet = new Set(leaves(rowOf("mainnet")));
  expect(values.filter((v) => mainnet.has(v) && !SHARED.has(v))).toEqual([]);
});

test("D30, D25: each row's MPC root key is the formats' key for its network", () => {
  expect(rowOf("mainnet").mpcRootPublicKey).toBe(pauseRole.MAINNET_ROOT_PUBLIC_KEY);
  expect(rowOf("testnet").mpcRootPublicKey).toBe(pauseRole.TESTNET_ROOT_PUBLIC_KEY);
});
