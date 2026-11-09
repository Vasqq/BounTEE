// Seam T, ticket #64: `bountee test` and `bountee claim` prove a claim on the covered chain the
// Whitehat names with `--chain` (D26), and the claim's block carries it (D1).
//
// Seams (written before the first test):
//   T, offline: the `bountee` command line run as a process, its `fetch` replaced by a recorder
//   (fetch-recorder.mjs) or pointed at a local stand-in for NEAR's RPC, OutLayer's keystore and
//   an EVM chain's RPC that logs every request and decodes every signed transaction.
//     Catches: a two-chain bounty's `test` or `claim` with no `--chain`, an uncovered chain or an
//     unknown name refused, listing the covered chains, before any EVM request and with nothing
//     signed; `claim --job` of a job proven on the second chain filing its block (chain
//     included), header and proofs unchanged; `verify-pause --chain` reading names alike.
//     Misses: the contract's own refusal of an uncovered chain (#63, seam C) and the enclave.
//   T, live and read-only: `test --chain arbitrum-sepolia` of the demo exploit against the
//   public missing-access-check DemoVault on Arbitrum Sepolia (ticket #61's), on rules covering
//   Base Sepolia first. No keys, no funds, no NEAR.
//     Catches: the named chain picking the fork, the proof RPCs and the claim's block.
//     Misses: a claim filed on testnet (the rehearsal, #67).
import { spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58 } from "@scure/base";
import { decodeSignedTransaction, KeyPair } from "near-api-js";
import { afterAll, beforeAll, expect, test } from "vitest";
import { proofRpcs } from "../src/chains.ts";
import { NEAR_GAS_PRICE, NEAR_PROTOCOL_CONFIG, nearView, standIns, type Route } from "./testnet/stand-ins.ts";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const recorder = fileURLToPath(new URL("./fetch-recorder.mjs", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const DRAIN = `${repo}demo/script/DrainStrategy.s.sol`;
const BASE_SEPOLIA = 84532;
const ARBITRUM_SEPOLIA = 421614;
/** The public missing-access-check DemoVault on Arbitrum Sepolia, and its MockUSDC (ticket #61). */
const ARB_VAULT = "0x3c7d331ed71ab628b8aa256618186258b2ac0857";
const ARB_USDC = "0x14ad4c07713ae2cef1a160561e9bc554a699b6c0";
/** Circle's test USDC on Base Sepolia, standing in for the bounty's Base Sepolia contract. */
const BASE_USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";

/** A bounty covering a contract on Base Sepolia first, then the DemoVault on Arbitrum Sepolia. */
const TWO_CHAIN_RULES = {
  covered_contracts: [
    { chain_id: BASE_SEPOLIA, address: BASE_USDC },
    { chain_id: ARBITRUM_SEPOLIA, address: ARB_VAULT },
  ],
  recency_limit_secs: 300,
  listed_tokens: [
    { chain_id: BASE_SEPOLIA, token: BASE_USDC, price: "1" },
    { chain_id: BASE_SEPOLIA, token: "native", price: "0" },
    { chain_id: ARBITRUM_SEPOLIA, token: ARB_USDC, price: "1" },
    { chain_id: ARBITRUM_SEPOLIA, token: "native", price: "0" },
  ],
  seed: { native: "1000000000000000000", tokens: [] },
  bounty_amount: "100000000",
  minimum_theft: "1000000000",
  end_date_ns: "1796442141731000000",
  disclosure_delay_days: 30,
  exploit_public_key: "x25519:BvcnVkZZ98AyydmC32UrjcUUKA5YpUydb2v2jm76HBnB",
  judge_build_hash: `0x${"5a".repeat(32)}`,
};

function bountee(args: string[], o: { cwd?: string; env?: Record<string, string>; recordFetch?: boolean } = {}) {
  const dir = o.cwd ?? mkdtempSync(join(tmpdir(), "bountee-chain-"));
  const log = join(dir, "fetch.log");
  writeFileSync(log, "");
  const pre = o.recordFetch ? ["--import", recorder] : [];
  return new Promise<{ code: number | null; out: any; error: string | undefined; stderr: string; fetched: string[] }>((resolve) => {
    const child = spawn(process.execPath, [...pre, entry, ...args, "--json"], {
      cwd: dir,
      env: { ...process.env, BOUNTEE_FETCH_LOG: log, BOUNTEE_CONTRACT: "", VAULT: ARB_VAULT, ...o.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      const parse = (text: string) => {
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      };
      resolve({
        code,
        out: parse(stdout),
        error: parse(stderr.trim().split("\n").pop() ?? "")?.error,
        stderr,
        fetched: readFileSync(log, "utf8").split("\n").filter(Boolean),
      });
    });
  });
}

function rulesFile(rules: unknown = TWO_CHAIN_RULES): string {
  const file = join(mkdtempSync(join(tmpdir(), "bountee-rules-")), "rules.json");
  writeFileSync(file, JSON.stringify(rules));
  return file;
}

const LISTED = /Base Sepolia \(84532\).*Arbitrum Sepolia \(421614\)/;

// ---- test: the chain is chosen before anything is asked of a chain (D26) ----------------------

test("D26: test on a two-chain bounty with no --chain is refused before any request, listing the covered chains", async () => {
  const r = await bountee(["test", DRAIN, "--bounty", rulesFile()], { recordFetch: true });
  expect(r.code).toBe(1);
  expect(r.error).toMatch(/--chain/);
  expect(r.error).toMatch(LISTED);
  expect(r.fetched).toEqual([]);
}, 60_000);

test("D26: test naming a chain the bounty doesn't cover, by name or chain ID, is refused before any request, listing the covered chains", async () => {
  for (const named of ["base", "Arbitrum-One", "8453"]) {
    const r = await bountee(["test", DRAIN, "--bounty", rulesFile(), "--chain", named], { recordFetch: true });
    expect(r.code, named).toBe(1);
    expect(r.error, named).toMatch(/covers no contract on (Base \(8453\)|Arbitrum One \(42161\))/);
    expect(r.error, named).toMatch(LISTED);
    expect(r.fetched, named).toEqual([]);
  }
}, 60_000);

test("D26: test naming no chain BounTEE knows is refused before any request, naming the names --chain takes", async () => {
  const r = await bountee(["test", DRAIN, "--bounty", rulesFile(), "--chain", "polygon"], { recordFetch: true });
  expect(r.code).toBe(1);
  expect(r.error).toMatch(/--chain takes a chain ID or one of base, arbitrum, arbitrum-one, base-sepolia, arbitrum-sepolia: got polygon/);
  expect(r.fetched).toEqual([]);
}, 60_000);

// ---- test: on the chain named, live (D26, D1, D2) -------------------------------------------------

test("D26 D1 D2: test --chain arbitrum-sepolia on a two-chain bounty runs on Arbitrum Sepolia and saves a job whose block carries it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bountee-arb-"));
  const out = join(dir, "job.json");
  const r = await bountee(["test", DRAIN, "--bounty", rulesFile(), "--chain", "arbitrum-sepolia", "--out", out], { cwd: dir });
  expect(r.code, r.stderr).toBe(0);
  // The demo exploit drains the public DemoVault's 1,000,000 MockUSDC: only Arbitrum Sepolia's
  // state holds it. (If a stranger ever drains that vault for real, this reads ZERO: redeploy it.)
  expect(r.out.verdict).toEqual({ outcome: "PAYS", reason: "minimum_theft_reached" });
  expect(r.out.block.chain_id).toBe(ARBITRUM_SEPOLIA);
  expect(proofRpcs(ARBITRUM_SEPOLIA)).toContain(r.out.rpc);
  // The block is Arbitrum Sepolia's, read back from the chain.
  const onChain = spawnSync("cast", ["block", String(r.out.block.number), "--field", "hash", "--rpc-url", proofRpcs(ARBITRUM_SEPOLIA)[0]!], { encoding: "utf8" });
  expect(onChain.stdout.trim()).toBe(r.out.block.hash);
  // The saved job carries that block, and replays offline to the verdict test printed.
  const saved = JSON.parse(readFileSync(out, "utf8")).replay;
  expect(saved.block).toEqual(r.out.block);
  const again = await bountee(["test", "--job", out], { recordFetch: true });
  expect(again.out.verdict).toEqual(r.out.verdict);
  expect(again.fetched).toEqual([]);
}, 600_000);

// ---- claim: the stand-ins -------------------------------------------------------------------

const CONTRACT = "bounty.example.testnet";
const WHITEHAT = "alice.testnet";
const BOUNTY = { protocol: "protocol.testnet", name: "vault" };
const BOUNTY_TEXT = `${BOUNTY.protocol}/${BOUNTY.name}`;
const YOCTO = 10n ** 24n;
/** A job `bountee test --out` saved on Arbitrum Sepolia (ticket #61): a real block, header and proofs. */
const ARB_JOB = `${repo}judge/tests/fixtures/arbitrum-sepolia/drain.json`;
const arbReplay = JSON.parse(readFileSync(ARB_JOB, "utf8")).replay;

/** Each signed transaction sent to NEAR, decoded. */
const sent: { method: string; args: any }[] = [];
/** The bounty's rules, and how old the stand-in chain says a claimed block is, and its hash there (default the Arbitrum job's). */
let world: { rules: unknown; blockAgeSecs?: number; blockHash?: string };
const keystore = generateKeyPairSync("x25519");
const keystorePub = keystore.publicKey.export({ format: "der", type: "spki" }).subarray(12).toString("hex");

const HASH = "11111111111111111111111111111111";
const VIEWS: Record<string, (args: any) => unknown> = {
  bounty: ({ id }) =>
    id.protocol === BOUNTY.protocol && id.name === BOUNTY.name ? { id: BOUNTY, rules: world.rules, state: "live", winning_claim: null, signed_pauses: [] } : null,
  config: () => ({ outlayer: "outlayer.testnet", usdc: "usdc.testnet", judge_build_hash: `0x${"5a".repeat(32)}` }),
  fees: () => ({ job_deposit: String(20n * 10n ** 21n), storage_price_per_byte: String(10n ** 19n), job_input_free_bytes: 32768, secret_row_overhead_bytes: 1024 }),
  claim_balance: () => String(3n * YOCTO),
};

const outcome = (id: string, executor: string) => ({
  id,
  outcome: { logs: [], receipt_ids: [], gas_burnt: 0, tokens_burnt: "0", executor_id: executor, status: { SuccessValue: "" } },
  proof: [],
  block_hash: HASH,
});

/** NEAR's RPC and the EVM chains, as the stand-ins answer them. */
const route: Route = (where, method, p) => {
  if (where !== "near") {
    // The chain as it is now: the block the claim names is a few seconds old.
    if (method === "eth_getBlockByNumber") return { number: p[0], hash: world.blockHash ?? arbReplay.block.hash, timestamp: `0x${(Math.floor(Date.now() / 1000) - (world.blockAgeSecs ?? 5)).toString(16)}` };
    return undefined;
  }
  if (method === "query" && p.request_type === "call_function" && VIEWS[p.method_name]) {
    return nearView(VIEWS[p.method_name]!(JSON.parse(Buffer.from(p.args_base64 ?? "", "base64").toString("utf8") || "{}")));
  }
  if (method === "query" && p.request_type === "view_access_key") return { nonce: 1, permission: "FullAccess", block_height: 1, block_hash: HASH };
  if (method === "query" && p.request_type === "view_account") {
    return { amount: String(10n * YOCTO), locked: "0", code_hash: HASH, storage_usage: 1, block_height: 1, block_hash: HASH };
  }
  if (method === "EXPERIMENTAL_protocol_config") return NEAR_PROTOCOL_CONFIG;
  if (method === "gas_price") return NEAR_GAS_PRICE;
  if (method === "block") return { header: { hash: HASH, height: 1, timestamp: 0 } };
  if (method === "send_tx" || method === "broadcast_tx_commit") {
    const bytes = Buffer.from(p.signed_tx_base64 ?? p[0], "base64");
    const { transaction: tx } = decodeSignedTransaction(bytes);
    const fc: any = (tx.actions[0] as any).functionCall;
    sent.push({ method: fc.methodName, args: JSON.parse(Buffer.from(fc.args).toString("utf8")) });
    const hash = base58.encode(createHash("sha256").update(bytes).digest());
    // The contract files it as claim 7.
    return {
      status: { SuccessValue: Buffer.from("7").toString("base64") },
      final_execution_status: "EXECUTED_OPTIMISTIC",
      transaction: { hash, signer_id: tx.signerId, receiver_id: tx.receiverId },
      transaction_outcome: outcome(hash, tx.signerId),
      receipts_outcome: [outcome(`${hash}-r`, tx.receiverId)],
    };
  }
  return undefined;
};

let stand: Awaited<ReturnType<typeof standIns>>;
beforeAll(async () => {
  stand = await standIns(route, { "/secrets/pubkey": () => ({ pubkey: keystorePub }) });
});
afterAll(() => stand.close());

/** Each request the stand-ins got: `near <method or view>`, `chain <id> <method>` or `http <path>` (OutLayer's keystore). */
const asked = () => stand.requests.map((r) => `${r.where} ${r.where === "near" ? (r.detail ?? r.method) : r.method}`);

/** `bountee claim` as the Whitehat against the stand-ins, its proof RPC the stand-in chain `proofRpcChain`. */
async function claim(args: string[], proofRpcChain: number) {
  stand.requests.length = 0;
  sent.length = 0;
  const dir = mkdtempSync(join(tmpdir(), "bountee-claim-"));
  const key = KeyPair.fromRandom("ed25519");
  writeFileSync(join(dir, `${WHITEHAT}.json`), JSON.stringify({ account_id: WHITEHAT, public_key: key.getPublicKey().toString(), private_key: key.toString() }));
  return bountee(
    [
      "claim", ...args,
      "--contract", CONTRACT, "--bounty", BOUNTY_TEXT, "--as", WHITEHAT,
      "--rpc", `${stand.base}/near`, "--proof-rpc", `${stand.base}/${proofRpcChain}`, "--outlayer-api", stand.base, "--no-wait",
    ],
    { cwd: dir, env: { BOUNTEE_CREDENTIALS_DIR: dir } },
  );
}

const evmAsked = () => asked().filter((a) => a.startsWith("chain "));

// ---- claim: the chain is chosen before any EVM call or fee (D26) ------------------------------

test("D26: claim of a script on a two-chain bounty with no --chain is refused after reading the bounty, before any EVM call or fee, listing the chains", async () => {
  world = { rules: TWO_CHAIN_RULES };
  const r = await claim([DRAIN], BASE_SEPOLIA);
  expect(r.code).toBe(1);
  expect(r.error).toMatch(/--chain/);
  expect(r.error).toMatch(LISTED);
  expect(evmAsked()).toEqual([]);
  expect(asked().every((a) => a === "near bounty")).toBe(true);
  expect(sent).toEqual([]);
}, 60_000);

test("D26 D1: claim of a job saved on the second chain files its block, chain included, header and proofs unchanged, asking only that chain", async () => {
  world = { rules: TWO_CHAIN_RULES };
  for (const named of [["--chain", "arbitrum-sepolia"], ["--chain", "421614"]]) {
    const r = await claim(["--job", ARB_JOB, ...named], ARBITRUM_SEPOLIA);
    expect(r.code, r.stderr).toBe(0);
    expect(sent.map((s) => s.method)).toEqual(["submit_claim"]);
    const filed = sent[0]!.args;
    expect(filed.bounty).toEqual(BOUNTY);
    expect(filed.block).toEqual({ chain_id: ARBITRUM_SEPOLIA, number: 327577406, hash: "0xed32e831a0448de34d9b5ad10305d342cef360348e550af8d6d758191b4d953d" });
    expect(filed.header).toBe(arbReplay.header);
    expect(filed.proofs).toBe(JSON.stringify(arbReplay.proofs));
    expect(r.out.block).toEqual(filed.block);
    // The recency re-check asked the block's chain, and no other.
    expect(evmAsked()).toEqual([`chain ${ARBITRUM_SEPOLIA} eth_getBlockByNumber`]);
  }
}, 60_000);

/** The Arbitrum Sepolia job as `claim --exploit --evidence` takes it. */
function arbEvidence(): string[] {
  const dir = mkdtempSync(join(tmpdir(), "bountee-evidence-"));
  writeFileSync(join(dir, "exploit.json"), JSON.stringify(arbReplay.exploit));
  writeFileSync(join(dir, "evidence.json"), JSON.stringify({ block: arbReplay.block, header: arbReplay.header, proofs: arbReplay.proofs }));
  return ["--exploit", join(dir, "exploit.json"), "--evidence", join(dir, "evidence.json")];
}

test("D26 D1: claim of a job or evidence on a chain the bounty doesn't cover is refused before any EVM call or fee, listing the covered chains", async () => {
  world = { rules: { ...TWO_CHAIN_RULES, covered_contracts: [TWO_CHAIN_RULES.covered_contracts[0]], listed_tokens: TWO_CHAIN_RULES.listed_tokens.slice(0, 2) } };
  for (const given of [["--job", ARB_JOB], arbEvidence()]) {
    const r = await claim(given, ARBITRUM_SEPOLIA);
    expect(r.code, given[0]).toBe(1);
    expect(r.error, given[0]).toMatch(/covers no contract on Arbitrum Sepolia \(421614\): it covers Base Sepolia \(84532\)/);
    expect(evmAsked(), given[0]).toEqual([]);
    expect(asked(), given[0]).not.toContain("http /secrets/pubkey");
    expect(sent, given[0]).toEqual([]);
  }
}, 60_000);

test("D26: claim of a job or evidence on a two-chain bounty with no --chain is refused before any EVM call or fee, listing the chains", async () => {
  world = { rules: TWO_CHAIN_RULES };
  for (const given of [["--job", ARB_JOB], arbEvidence()]) {
    const r = await claim(given, ARBITRUM_SEPOLIA);
    expect(r.code, given[0]).toBe(1);
    expect(r.error, given[0]).toMatch(/--chain/);
    expect(r.error, given[0]).toMatch(LISTED);
    expect(evmAsked(), given[0]).toEqual([]);
    expect(sent, given[0]).toEqual([]);
  }
}, 60_000);

test("D26: claim of a job or evidence proven on one chain with --chain naming another is refused before any EVM call or fee", async () => {
  world = { rules: TWO_CHAIN_RULES };
  for (const given of [["--job", ARB_JOB], arbEvidence()]) {
    const r = await claim([...given, "--chain", "base-sepolia"], ARBITRUM_SEPOLIA);
    expect(r.code, given[0]).toBe(1);
    expect(r.error, given[0]).toMatch(/proven on Arbitrum Sepolia \(421614\), not Base Sepolia \(84532\)/);
    expect(evmAsked(), given[0]).toEqual([]);
    expect(sent, given[0]).toEqual([]);
  }
}, 60_000);

test("D26 R2.8: claim of a job whose recency RPC holds another block at its number (another chain's) is refused, filing nothing", async () => {
  // --proof-rpc of Base Sepolia given for the Arbitrum Sepolia job: block 327577406 there is another block.
  world = { rules: TWO_CHAIN_RULES, blockHash: `0x${"0b".repeat(32)}` };
  const r = await claim(["--job", ARB_JOB, "--chain", "arbitrum-sepolia"], BASE_SEPOLIA);
  expect(r.code).toBe(1);
  expect(r.error).toMatch(/no RPC holds block 327577406 of Arbitrum Sepolia \(421614\)/);
  expect(r.error).toMatch(/is 0x(0b){32}, not the claim's/);
  expect(asked()).not.toContain("http /secrets/pubkey");
  expect(sent).toEqual([]);
}, 60_000);

test("D26: claim of a script with --chain, or of a saved job too old to file, runs test on that chain", async () => {
  world = { rules: TWO_CHAIN_RULES };
  // The stand-in chain answers no eth_chainId, so each run stops at test's first EVM call: the
  // check that the proof RPC serves the chosen chain.
  const named = await claim([DRAIN, "--chain", "arbitrum-sepolia"], ARBITRUM_SEPOLIA);
  expect(named.code).toBe(1);
  expect(named.error).toMatch(/no RPC answered for Arbitrum Sepolia \(421614\)/);
  expect(evmAsked()).toEqual([`chain ${ARBITRUM_SEPOLIA} eth_chainId`]);
  expect(sent).toEqual([]);

  // A job past the recency limit is tested again on its chain, the one --chain names.
  world.blockAgeSecs = 1000;
  const old = await claim([DRAIN, "--job", ARB_JOB, "--chain", "421614"], ARBITRUM_SEPOLIA);
  expect(old.code).toBe(1);
  expect(old.error).toMatch(/no RPC answered for Arbitrum Sepolia \(421614\)/);
  expect(evmAsked()).toEqual([`chain ${ARBITRUM_SEPOLIA} eth_getBlockByNumber`, `chain ${ARBITRUM_SEPOLIA} eth_chainId`]);
  expect(sent).toEqual([]);
}, 60_000);
