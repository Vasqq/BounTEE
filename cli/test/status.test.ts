// Seam T, ticket #26 (offline half): a claim's progress shows live (D23), and a paid claim
// gives a receipt (D24), driven through `bountee status --watch` and `bountee claim`.
//
// A local stand-in plays NEAR's RPC (the bounty contract's views, transactions), two EVM
// chains' RPCs (pause receipts), OutLayer's attestation API and FastNEAR's explorer (who signed
// each transaction). The test moves the stand-in's
// claim on one step at a time, and only once the tool has printed the stage before it: a
// tool that printed its progress only at the end would never see the next step, and the
// test would time out.
//
// Seams (written before the first test): T here catches D23's stages, their order and that
// each shows while the claim is at it, and D24's receipt (the payout found from the
// `bounty_paid` event, the attestation filed under the claim's transaction, every pause's
// transaction; a payout someone else signed, found through the explorer; events counted only
// from the bounty contract and its USDC); R14.5 (each stage a JSON line, the result JSON). It
// misses the real services' answers: `status-testnet.test.ts` reads a real paid claim. The verified-pause
// record is the contract's `pause_verifications` view (ticket #21), played here per chain.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const judgeFixtures = new URL("../../judge/tests/fixtures/", import.meta.url);
const CONTRACT = "bounty.example.testnet";
const WHITEHAT = "alice.testnet";
const BOUNTY = { protocol: "protocol.testnet", name: "vault" };
const CLAIM_TX = "9Ld3WhcY2ZVDS6fZyZW4o7Nc9Y5dPhWv4tyUfEhVvBVa";
/** A `retry-payout` someone other than the Whitehat sent: anyone may. */
const RETRY_TX = "4fTqkTzAAg5mUqqtJ8WCBvBRSm7LCmrvA9dKqMpFwy6P";
const RETRIER = "bob.testnet";
/** Another account's contract, logging the bounty contract's and USDC's events as its own. */
const FORGED_TX = "8kzGq2bW6v3pQ4m1N7xTc5Lr9yHdF2aJsE6uKwB3nVtZ";
const FORGER = "mallory.testnet";
const PAUSES = [
  { chain_id: 84532, contract: "0x" + "aa".repeat(20), nonce: 0, tx: "0x02", tx_hash: "0x" + "a1".repeat(32) },
  { chain_id: 421614, contract: "0x" + "bb".repeat(20), nonce: 0, tx: "0x02", tx_hash: "0x" + "b2".repeat(32) },
];
const JUDGE_HASH = "5a".repeat(32);
const PAYS = { outcome: "PAYS", reason: "minimum_theft_reached" };

// ---- The stand-in's world, moved on by `step` -------------------------------------------------

let world: {
  claim: any;
  bounty: any;
  /** The hashes the contract records as verified, by chain ID. */
  verified: Record<number, string[]>;
  receipts: Record<string, { status: string; blockNumber: string }>;
  /** `claim` showed "sealed" before it filed: the claim, once filed, goes straight to judging. */
  sealedBeforeFiling?: boolean;
  /** The claim's own transaction didn't pay; RETRY_TX did. */
  paidByRetry?: boolean;
};

function reset() {
  world = {
    claim: null,
    bounty: {
      id: BOUNTY,
      rules: { bounty_amount: "100000000", covered_contracts: PAUSES.map((p) => ({ chain_id: p.chain_id, address: p.contract })) },
      state: "live",
      winning_claim: null,
      signed_pauses: [],
      signing_pauses: false,
      paying_out: false,
    },
    verified: {},
    receipts: {},
  };
}

const newClaim = () => ({
  bounty: BOUNTY,
  whitehat: WHITEHAT,
  block: { number: 8, hash: "0x" + "00".repeat(32) },
  header: "0x",
  proofs_sha256: "0x" + "00".repeat(32),
  submitted_at_ns: "1793850608584544984",
  secret_profile: "c0",
  state: "storing",
  verdict: null,
});

/** Each step moves the claim on to the next stage the tool should show. */
const STEPS: { shows: string; then: () => void }[] = [
  {
    shows: "sealed",
    then: () => {
      if (world.claim) world.claim.state = "judging";
      else world.sealedBeforeFiling = true;
    },
  },
  {
    shows: "checking",
    then: () => {
      Object.assign(world.claim, { state: "judged", verdict: PAYS });
      Object.assign(world.bounty, { state: "signing", winning_claim: 0, signing_pauses: true });
    },
  },
  { shows: "verdict", then: () => Object.assign(world.bounty, { state: "paying", signing_pauses: false, paying_out: true, signed_pauses: PAUSES }) },
  { shows: "pauses_signed", then: () => Object.assign(world.bounty, { state: "paid", paying_out: false }) },
  { shows: "paid", then: () => (world.receipts[PAUSES[0]!.tx_hash] = { status: "0x1", blockNumber: "0x10" }) },
  { shows: `landed ${PAUSES[0]!.tx_hash}`, then: () => (world.receipts[PAUSES[1]!.tx_hash] = { status: "0x1", blockNumber: "0x20" }) },
  { shows: `landed ${PAUSES[1]!.tx_hash}`, then: () => (world.verified[84532] = [PAUSES[0]!.tx_hash]) },
  { shows: `verified ${PAUSES[0]!.tx_hash}`, then: () => (world.verified[421614] = [PAUSES[1]!.tx_hash]) },
];
const LAST = `verified ${PAUSES[1]!.tx_hash}`;

// ---- The stand-in ----------------------------------------------------------------------------

const log = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "bountee", version: "1.0.0", event, data: [data] })}`;
const outcome = (id: string, executor: string, logs: string[]) => ({
  id,
  outcome: { logs, receipt_ids: [], gas_burnt: 0, tokens_burnt: "0", executor_id: executor, status: { SuccessValue: "" } },
  proof: [],
  block_hash: "11111111111111111111111111111111",
});
/** The claim's transaction: filed, judged, signed and paid in one, as on testnet (#16 claim 7). */
function claimTxStatus() {
  return {
    status: { SuccessValue: Buffer.from("0").toString("base64") },
    transaction: { hash: CLAIM_TX, signer_id: WHITEHAT, receiver_id: CONTRACT },
    transaction_outcome: outcome(CLAIM_TX, WHITEHAT, []),
    receipts_outcome: [
      outcome("R1", CONTRACT, [log("claim_submitted", { claim_id: 0, bounty: BOUNTY, whitehat: WHITEHAT })]),
      outcome("R2", CONTRACT, [log("claim_judged", { claim_id: 0, verdict: PAYS })]),
      ...(world.paidByRetry ? [] : payoutOutcomes("PAYOUT")),
    ],
  };
}
const payoutOutcomes = (id: string) => [
  outcome(id, "usdc.testnet", [
    `EVENT_JSON:${JSON.stringify({ standard: "nep141", version: "1.0.0", event: "ft_transfer", data: [{ old_owner_id: CONTRACT, new_owner_id: WHITEHAT, amount: "100000000" }] })}`,
  ]),
  outcome(`${id}-event`, CONTRACT, [log("bounty_paid", { bounty: BOUNTY, claim_id: 0, amount: "100000000" })]),
];
function retryTxStatus() {
  return {
    status: { SuccessValue: "" },
    transaction: { hash: RETRY_TX, signer_id: RETRIER, receiver_id: CONTRACT },
    transaction_outcome: outcome(RETRY_TX, RETRIER, []),
    receipts_outcome: payoutOutcomes("RETRY-PAYOUT"),
  };
}
function forgedTxStatus() {
  const forged = payoutOutcomes("FORGED").map((r) => ({ ...r, outcome: { ...r.outcome, executor_id: FORGER } }));
  return {
    status: { SuccessValue: "" },
    transaction: { hash: FORGED_TX, signer_id: FORGER, receiver_id: FORGER },
    transaction_outcome: outcome(FORGED_TX, FORGER, []),
    receipts_outcome: forged,
  };
}
/** Who signed each transaction: NEAR RPC finds one only when asked with its signer. */
const SIGNERS: Record<string, string> = { [CLAIM_TX]: WHITEHAT, [RETRY_TX]: RETRIER, [FORGED_TX]: FORGER };

const VIEWS: Record<string, (args: any) => unknown> = {
  claim: ({ claim_id }) => (claim_id === 0 ? world.claim : null),
  bounty: () => world.bounty,
  // The contract's view: every chain with a signed pause, and the hashes verified on it.
  pause_verifications: () =>
    [...new Set<number>(world.bounty.signed_pauses.map((p: any) => p.chain_id))].map((chain_id) => {
      const verified_pauses = world.verified[chain_id] ?? [];
      const all = world.bounty.signed_pauses.filter((p: any) => p.chain_id === chain_id);
      return { chain_id, verified: all.every((p: any) => verified_pauses.includes(p.tx_hash)), verified_pauses, attempts: verified_pauses.length ? 1 : 0, prepaid_attempts_left: verified_pauses.length ? 2 : 3, verifying: false };
    }),
  config: () => ({ outlayer: "outlayer.testnet", usdc: "usdc.testnet", judge_build_hash: `0x${JUDGE_HASH}` }),
  fees: () => ({ job_deposit: "0", storage_price_per_byte: "0", job_input_free_bytes: 0, secret_row_overhead_bytes: 0 }),
  claim_balance: () => "10000000000000000000000000",
};

const keystore = KeyPair.fromRandom("ed25519");
const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => resolve(body));
  });
const send = (res: ServerResponse, body: unknown) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};
const unhandled: string[] = [];

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = req.url ?? "";
  if (url === `/outlayer/attestations/by-tx/${CLAIM_TX}`) {
    return send(res, { task_id: 4242, request_id: 99, transaction_hash: CLAIM_TX, wasm_hash: JUDGE_HASH, input_hash: "11", output_hash: "22", worker_measurement: "33", timestamp: 1, tdx_quote: "AAAA" });
  }
  if (url === "/txapi/v0/transactions") {
    // FastNEAR's explorer: who signed each transaction asked about.
    const hashes: string[] = JSON.parse(body).tx_hashes;
    return send(res, { transactions: hashes.map((h) => (SIGNERS[h] ? { transaction: { hash: h, signer_id: SIGNERS[h] }, receipts: [] } : null)) });
  }
  if (url === "/outlayer/secrets/pubkey") {
    // Any X25519 key will do: nothing here opens what the tool seals.
    const { generateKeyPairSync } = await import("node:crypto");
    const k = generateKeyPairSync("x25519").publicKey.export({ format: "der", type: "spki" }).subarray(12);
    return send(res, { pubkey: k.toString("hex") });
  }
  const call = JSON.parse(body);
  const reply = (result: unknown) => send(res, { jsonrpc: "2.0", id: call.id, result });
  if (url.startsWith("/evm")) {
    if (call.method === "eth_getTransactionReceipt") return reply(world.receipts[call.params[0]] ?? null);
  } else if (call.method === "query" && call.params.request_type === "call_function") {
    const view = VIEWS[call.params.method_name];
    if (view) {
      const args = JSON.parse(Buffer.from(call.params.args_base64 ?? "", "base64").toString("utf8") || "{}");
      return reply({ result: [...Buffer.from(JSON.stringify(view(args)))], logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" });
    }
  } else if (call.method === "query" && call.params.request_type === "view_access_key") {
    return reply({ nonce: 1, permission: "FullAccess", block_height: 1, block_hash: "11111111111111111111111111111111" });
  } else if (call.method === "block") {
    return reply({ header: { hash: "11111111111111111111111111111111", height: 1, timestamp: 0 } });
  } else if (call.method === "send_tx" || call.method === "broadcast_tx_commit") {
    // submit_claim: the contract holds the sealed exploit as `c0`.
    world.claim = { ...newClaim(), state: world.sealedBeforeFiling ? "judging" : "storing" };
    return reply(claimTxStatus());
  } else if (call.method === "EXPERIMENTAL_tx_status" || call.method === "tx") {
    if (call.params.sender_account_id === SIGNERS[call.params.tx_hash]) {
      if (call.params.tx_hash === CLAIM_TX) return reply(claimTxStatus());
      if (call.params.tx_hash === RETRY_TX) return reply(retryTxStatus());
      if (call.params.tx_hash === FORGED_TX) return reply(forgedTxStatus());
    }
  }
  unhandled.push(`${url} ${call.method} ${JSON.stringify(call.params).slice(0, 120)}`);
  res.statusCode = 400;
  send(res, { jsonrpc: "2.0", id: call.id, error: { message: "not in the stand-in" } });
});

let base = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => server.close());
beforeEach(() => {
  reset();
  unhandled.length = 0;
});

/**
 * Run the tool; as each stage line arrives on stderr, check it's the one the stand-in is at,
 * then move the stand-in on. Resolves when the tool exits.
 */
function follow(args: string[], env: Record<string, string> = {}, cwd?: string) {
  return new Promise<{ code: number | null; stdout: string; shown: string[]; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { cwd, env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    let pending = "";
    const shown: string[] = [];
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => {
      stderr += d;
      pending += d;
      let nl: number;
      while ((nl = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, nl);
        pending = pending.slice(nl + 1);
        let stage: any;
        try {
          stage = JSON.parse(line); // R14.5: every progress line is JSON
        } catch {
          shown.push(`not JSON: ${line}`);
          continue;
        }
        const name = stage.tx_hash && stage.stage !== "pauses_signed" ? `${stage.stage} ${stage.tx_hash}` : stage.stage;
        shown.push(name);
        const step = STEPS[shown.length - 1];
        if (step && step.shows === name) step.then();
      }
    });
    child.on("close", (code) => resolve({ code, stdout, shown, stderr }));
  });
}

const EXPECTED = [...STEPS.map((s) => s.shows), LAST];

function expectReceipt(out: any) {
  expect(out.receipt).toMatchObject({
    claim_id: 0,
    bounty: BOUNTY,
    whitehat: WHITEHAT,
    amount: "100000000",
    verdict: PAYS,
    payout: { tx_hash: CLAIM_TX, receipt_id: "PAYOUT" },
    attestation: { task_id: 4242, transaction_hash: CLAIM_TX, wasm_hash: JUDGE_HASH },
  });
  expect(out.receipt.pauses.map((p: any) => [p.chain_id, p.tx_hash, p.landed?.status, p.verified])).toStrictEqual([
    [84532, PAUSES[0]!.tx_hash, "success", true],
    [421614, PAUSES[1]!.tx_hash, "success", true],
  ]);
}

test("D23 D24 R14.5: status --watch shows each stage while the claim is at it, then the receipt", async () => {
  world.claim = newClaim();
  const r = await follow([
    "status", "0", "--contract", CONTRACT, "--watch", "--interval", "0.05", "--timeout", "60",
    "--near-rpc", `${base}/near`, "--rpc", `84532=${base}/evm,421614=${base}/evm`,
    "--outlayer-api", `${base}/outlayer`, "--tx-api", `${base}/txapi`, "--tx", CLAIM_TX, "--json",
  ]);
  expect(r.code, `${r.stderr}\n${unhandled.join("\n")}`).toBe(0);
  expect(r.shown).toStrictEqual(EXPECTED);
  const out = JSON.parse(r.stdout);
  expect(out.done).toBe(true);
  expectReceipt(out);
}, 60_000);

test("D23 D24 R14.5: claim shows its own progress live after filing, then gives the receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bountee-progress-"));
  writeFileSync(join(dir, `${WHITEHAT}.json`), JSON.stringify({ account_id: WHITEHAT, public_key: keystore.getPublicKey().toString(), private_key: keystore.toString() }));
  const state = JSON.parse(readFileSync(new URL("state.json", judgeFixtures), "utf8"));
  writeFileSync(join(dir, "exploit.json"), readFileSync(new URL("exploits/drain.json", judgeFixtures)));
  writeFileSync(join(dir, "evidence.json"), JSON.stringify({ block: state.block, header: state.header, proofs: state.proofs }));

  const r = await follow(
    [
      "claim", "--contract", CONTRACT, "--bounty", `${BOUNTY.protocol}/${BOUNTY.name}`, "--as", WHITEHAT,
      "--exploit", join(dir, "exploit.json"), "--evidence", join(dir, "evidence.json"),
      "--rpc", `${base}/near`, "--outlayer-api", `${base}/outlayer`, "--tx-api", `${base}/txapi`, "--chain-rpc", `84532=${base}/evm,421614=${base}/evm`,
      "--no-broadcast", "--interval", "0.05", "--json",
    ],
    { BOUNTEE_CREDENTIALS_DIR: dir },
    dir,
  );
  expect(r.code, `${r.stderr}\n${unhandled.join("\n")}`).toBe(0);
  expect(r.shown).toStrictEqual(EXPECTED);
  const out = JSON.parse(r.stdout);
  expect(out.claim_id).toBe(0);
  expect(out.tx_hash).toBe(CLAIM_TX);
  // "Sealed" showed before the claim was filed: filing can take as long as the verdict.
  expect(world.sealedBeforeFiling).toBe(true);
  expectReceipt(out);
}, 60_000);

test("D24: a payout someone else sent with retry-payout is the receipt's payout", async () => {
  Object.assign(world, { claim: { ...newClaim(), state: "judged", verdict: PAYS }, paidByRetry: true });
  Object.assign(world.bounty, { state: "paid", winning_claim: 0, signed_pauses: PAUSES });
  const r = await follow([
    "status", "0", "--contract", CONTRACT, "--near-rpc", `${base}/near`, "--rpc", `84532=${base}/evm,421614=${base}/evm`,
    "--outlayer-api", `${base}/outlayer`, "--tx-api", `${base}/txapi`, "--tx", `${CLAIM_TX},${RETRY_TX}`, "--json",
  ]);
  expect(r.code, `${r.stderr}\n${unhandled.join("\n")}`).toBe(0);
  expect(JSON.parse(r.stdout).receipt.payout).toMatchObject({ tx_hash: RETRY_TX, receipt_id: "RETRY-PAYOUT" });
}, 60_000);

test("D24: a payout's events count only from the bounty contract and its USDC, not another account's logs", async () => {
  Object.assign(world, { claim: { ...newClaim(), state: "judged", verdict: PAYS }, paidByRetry: true });
  Object.assign(world.bounty, { state: "paid", winning_claim: 0, signed_pauses: PAUSES });
  const r = await follow([
    "status", "0", "--contract", CONTRACT, "--near-rpc", `${base}/near`, "--rpc", `84532=${base}/evm,421614=${base}/evm`,
    "--outlayer-api", `${base}/outlayer`, "--tx-api", `${base}/txapi`, "--tx", `${FORGED_TX},${CLAIM_TX},${RETRY_TX}`, "--json",
  ]);
  expect(r.code, `${r.stderr}\n${unhandled.join("\n")}`).toBe(0);
  expect(JSON.parse(r.stdout).receipt.payout).toMatchObject({ tx_hash: RETRY_TX, receipt_id: "RETRY-PAYOUT" });
}, 60_000);
