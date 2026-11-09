#!/usr/bin/env node
// Proof fetching for local replays (ticket #8; reused by `bountee test` and `claim`, #11).
//
// Given an RPC, a block, the bounty's rules and an exploit, it builds the judge's replay
// job: the block's RLP header and an EIP-1186 proof (or absence proof) of every account
// and slot the replay reads. It finds those reads by asking the judge itself: it runs the
// compiled judge, reads the `unproven …` lines the judge writes on stderr, fetches those
// proofs from the RPC at the block, and runs again until nothing is unproven. So it fetches
// exactly what the judge reads, including the balance reads it scores with.
//
// As a script:
//   node cli/src/proofs.ts --rpc <url> --chain <chain id> --block <n> --rules <rules.json> --exploit <exploit.json> \
//     --wasm <bountee-judge.wasm> --out <replay.json>
// The broadcast log of a Foundry script converts to an exploit with exploitFromBroadcast().
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  parseExploit,
  parseRules,
  parseReplay,
  parseVerdict,
  toJson,
  type AccountProof,
  type Exploit,
  type Replay,
  type Rules,
  type Verdict,
} from "@bountee/formats";

const KECCAK_EMPTY = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";
const EMPTY_ROOT = "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421";

// ---- Exploit from a Foundry script's broadcast log -------------------------------------

interface BroadcastLog {
  transactions: { transaction: { from: string; to?: string | null; value?: string; input?: string; data?: string; gas?: string } }[];
}

/** The judge's exploit from `broadcast/<script>/<chain>/[dry-run/]<run>-latest.json`. */
export function exploitFromBroadcast(log: BroadcastLog): Exploit {
  return parseExploit({
    transactions: log.transactions.map(({ transaction: t }) => ({
      from: t.from.toLowerCase(),
      to: t.to ? t.to.toLowerCase() : null,
      value: BigInt(t.value ?? "0x0").toString(),
      input: (t.input ?? t.data ?? "0x").toLowerCase(),
      gas: Number(BigInt(t.gas ?? "0x0")),
    })),
  });
}

// ---- JSON-RPC ----------------------------------------------------------------------------

/**
 * POST `body` as JSON and read the JSON answer. Public RPCs and APIs rate-limit bursts (HTTP
 * 429), so those are retried with a doubling wait, `tries` times in all. Another HTTP error
 * whose body isn't JSON is thrown; one with a JSON body (a JSON-RPC error) is returned.
 */
export async function postJson<T>(url: string, body: unknown, o: { tries?: number; backoffMs?: number } = {}): Promise<T> {
  const tries = o.tries ?? 6;
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.status === 429 && attempt < tries) {
      await new Promise((r) => setTimeout(r, (o.backoffMs ?? 500) * 2 ** (attempt - 1)));
      continue;
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${url}: HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
  }
}

/** One JSON-RPC call, retried while the RPC rate-limits it. */
export async function rpc<T>(url: string, method: string, params: unknown[] | object): Promise<T> {
  const body = await postJson<{ result?: T; error?: { message: string } }>(url, { jsonrpc: "2.0", id: 1, method, params });
  if (body.error || body.result === undefined) throw new Error(`${method}: ${body.error?.message ?? "no result"}`);
  return body.result;
}

const hexOf = (bytes: Uint8Array) => `0x${Buffer.from(bytes).toString("hex")}`;
const bytesOf = (hex: string) => {
  const digits = hex.replace(/^0x/, "");
  return Uint8Array.from(Buffer.from(digits.length % 2 ? `0${digits}` : digits, "hex"));
};
const word = (quantity: string) => `0x${BigInt(quantity).toString(16).padStart(64, "0")}`;
const quantityTag = (n: number) => `0x${n.toString(16)}`;

// ---- Header --------------------------------------------------------------------------------

function rlp(item: Uint8Array | Uint8Array[]): Uint8Array {
  const length = (n: number, offset: number) => {
    if (n < 56) return Uint8Array.of(offset + n);
    const b = bytesOf(n.toString(16));
    return Uint8Array.of(offset + 55 + b.length, ...b);
  };
  if (Array.isArray(item)) {
    const body = Buffer.concat(item.map(rlp));
    return Buffer.concat([length(body.length, 0xc0), body]);
  }
  if (item.length === 1 && item[0]! < 0x80) return item;
  return Buffer.concat([length(item.length, 0x80), item]);
}

const integer = (q: string) => (BigInt(q) === 0n ? new Uint8Array() : bytesOf(BigInt(q).toString(16)));

/** Header fields in RLP order; each is a fixed-length byte string or an integer. */
const HEADER_FIELDS: [string, "bytes" | "int"][] = [
  ["parentHash", "bytes"], ["sha3Uncles", "bytes"], ["miner", "bytes"], ["stateRoot", "bytes"],
  ["transactionsRoot", "bytes"], ["receiptsRoot", "bytes"], ["logsBloom", "bytes"], ["difficulty", "int"],
  ["number", "int"], ["gasLimit", "int"], ["gasUsed", "int"], ["timestamp", "int"], ["extraData", "bytes"],
  ["mixHash", "bytes"], ["nonce", "bytes"], ["baseFeePerGas", "int"], ["withdrawalsRoot", "bytes"],
  ["blobGasUsed", "int"], ["excessBlobGas", "int"], ["parentBeaconBlockRoot", "bytes"], ["requestsHash", "bytes"],
];

/** The block's hash and RLP header, checked: keccak256(header) must equal the hash. */
export async function fetchHeader(url: string, number: number): Promise<{ hash: string; header: string }> {
  const block = await rpc<Record<string, string>>(url, "eth_getBlockByNumber", [quantityTag(number), false]);
  let header: string;
  try {
    header = await rpc<string>(url, "debug_getRawHeader", [quantityTag(number)]);
  } catch {
    const fields: Uint8Array[] = [];
    for (const [name, kind] of HEADER_FIELDS) {
      const v = block[name];
      if (v === undefined || v === null) break;
      fields.push(kind === "int" ? integer(v) : bytesOf(v));
    }
    header = hexOf(rlp(fields));
  }
  header = header.toLowerCase();
  if (hexOf(keccak_256(bytesOf(header))) !== block.hash!.toLowerCase()) {
    throw new Error(`block ${number}: the header doesn't hash to ${block.hash}`);
  }
  return { hash: block.hash!.toLowerCase(), header };
}

// ---- Proofs ----------------------------------------------------------------------------------

interface RpcProof {
  address: string;
  balance: string;
  codeHash: string;
  nonce: string;
  storageHash: string;
  accountProof: string[];
  storageProof: { key: string; value: string; proof: string[] }[];
}

/** One account's proof with the given slots, at `number`, in the shared format. */
export async function fetchProof(url: string, address: string, slots: string[], number: number): Promise<AccountProof> {
  const p = await rpc<RpcProof>(url, "eth_getProof", [address, slots, quantityTag(number)]);
  const nonce = BigInt(p.nonce).toString();
  const balance = BigInt(p.balance).toString();
  // Some nodes spell an absent account's hashes as zero; the format spells them empty.
  const absent = nonce === "0" && balance === "0" && /^0x0*$/.test(p.codeHash);
  const code_hash = absent ? KECCAK_EMPTY : p.codeHash.toLowerCase();
  const code = code_hash === KECCAK_EMPTY ? "0x" : (await rpc<string>(url, "eth_getCode", [address, quantityTag(number)])).toLowerCase();
  return {
    address: address.toLowerCase(),
    nonce,
    balance,
    code_hash,
    storage_hash: absent && /^0x0*$/.test(p.storageHash) ? EMPTY_ROOT : p.storageHash.toLowerCase(),
    account_proof: p.accountProof.map((n) => n.toLowerCase()),
    storage: p.storageProof.map((s) => ({
      key: word(s.key),
      value: word(s.value),
      proof: s.proof.map((n) => n.toLowerCase()),
    })),
    code,
  };
}

// ---- The judge, locally ------------------------------------------------------------------------

export interface JudgeRun {
  verdict: Verdict | null;
  stderr: string;
}

/** Run the compiled judge under wasmtime on one job. */
export function runJudge(wasm: string, replay: Replay): JudgeRun {
  const res = spawnSync("wasmtime", ["run", "-S", "http", "--", wasm], {
    input: toJson({ replay }),
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  if (res.error) throw res.error;
  const out = res.stdout.trim();
  return { verdict: out ? parseVerdict(JSON.parse(out)) : null, stderr: res.stderr };
}

/** The reads the judge reported unproven, from its stderr. */
export function unprovenReads(stderr: string): { accounts: string[]; slots: [string, string][] } {
  const accounts: string[] = [];
  const slots: [string, string][] = [];
  for (const line of stderr.split("\n")) {
    const m = /^unproven (account|slot) (0x[0-9a-f]{40})(?: (0x[0-9a-f]{64}))?$/.exec(line.trim());
    if (m?.[1] === "account") accounts.push(m[2]!);
    if (m?.[1] === "slot") slots.push([m[2]!, m[3]!]);
  }
  return { accounts, slots };
}

export interface CollectOptions {
  rpc: string;
  /** The chain `rpc` serves: the claim's proof chain, which its block names (D1). */
  chain: number;
  block: number;
  rules: Rules;
  exploit: Exploit;
  wasm: string;
  /** Accounts and slots to prove up front, to save judge runs. */
  accounts?: string[];
  maxRounds?: number;
}

/** Build the replay job for `exploit` at `block`, proving every read the judge makes. */
export async function collectReplay(o: CollectOptions): Promise<{ replay: Replay; verdict: Verdict | null; stderr: string }> {
  const { hash, header } = await fetchHeader(o.rpc, o.block);
  const wanted = new Map<string, Set<string>>();
  const want = (a: string, slot?: string) => {
    const set = wanted.get(a) ?? new Set<string>();
    if (slot) set.add(slot);
    wanted.set(a, set);
  };
  for (const a of o.accounts ?? []) want(a.toLowerCase());
  for (const t of o.exploit.transactions) want(t.from);

  const proofs = new Map<string, AccountProof>();
  for (let round = 0; round < (o.maxRounds ?? 200); round++) {
    for (const [address, slots] of wanted) {
      const have = proofs.get(address);
      const missing = [...slots].filter((s) => !have?.storage.some((p) => p.key === s));
      if (have && missing.length === 0) continue;
      const all = [...new Set([...(have?.storage.map((p) => p.key) ?? []), ...slots])].sort();
      proofs.set(address, await fetchProof(o.rpc, address, all, o.block));
    }
    const replay = parseReplay({
      rules: o.rules,
      block: { chain_id: o.chain, number: o.block, hash },
      header,
      proofs: [...proofs.values()].sort((a, b) => a.address.localeCompare(b.address)),
      exploit: o.exploit,
    });
    const run = runJudge(o.wasm, replay);
    const reads = unprovenReads(run.stderr);
    const fresh = [
      ...reads.accounts.filter((a) => !proofs.has(a)),
      ...reads.slots.filter(([a, s]) => !proofs.get(a)?.storage.some((p) => p.key === s)),
    ];
    if (fresh.length === 0) return { replay, verdict: run.verdict, stderr: run.stderr };
    for (const a of reads.accounts) want(a);
    for (const [a, s] of reads.slots) want(a, s);
  }
  throw new Error("the judge kept finding unproven reads");
}

// ---- Script entry ----------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    if (i < 0 || !process.argv[i + 1]) throw new Error(`missing --${name}`);
    return process.argv[i + 1]!;
  };
  const read = (p: string) => JSON.parse(readFileSync(p, "utf8"));
  const { replay, verdict } = await collectReplay({
    rpc: arg("rpc"),
    chain: Number(arg("chain")),
    block: Number(arg("block")),
    rules: read(arg("rules")),
    exploit: parseExploit(read(arg("exploit"))),
    wasm: arg("wasm"),
  });
  writeFileSync(arg("out"), `${toJson(replay)}\n`);
  console.log(JSON.stringify({ out: arg("out"), proofs: replay.proofs.length, verdict }));
}

// For scripts outside the cli package (judge/tests/fixtures/make-fixtures.ts).
export { parseRules };
