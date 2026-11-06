// Seam T, ticket #36: `bountee withdraw` sends a Whitehat's USDC from NEAR to an address they
// name on another chain, through NEAR Intents' 1Click (D12, ADR-0013).
//
// Seams (written before the first test): T, the `bountee` command line run as a process against
// a local stand-in for NEAR's RPC (mainnet) and for 1Click's API. The stand-in decodes every
// signed transaction the tool sends (borsh `SignedTransaction`), so each test sees every action,
// its args, deposit and gas, and it answers quotes the way 1Click does (its own error messages,
// a deadline of its own choosing).
//   Catches: the quote `withdraw` asks for (USDC on NEAR to USDC on the named chain, the
//   recipient, the refund to the Whitehat's own NEAR account); the one transaction it sends to
//   NEAR's USDC (the deposit address registered, then exactly the amount sent to it); the deposit
//   reported to 1Click; the result it reports; and everything it refuses before sending: an
//   amount below 1Click's minimum, an address the chain won't accept, a quote at or near its
//   deadline, a quote promising too little, testnet, a claim key, an amount above the balance,
//   NEAR as the target; and that a deposit once sent is always reported, even when 1Click
//   can't be told of it or its status can't be read.
//   Misses: 1Click's real routing and delivery, verified by the recorded mainnet run (D12's A).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58 } from "@scure/base";
import { decodeSignedTransaction, KeyPair } from "near-api-js";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const WHITEHAT = "5ee1a7b0c0ffee000000000000000000000000000000000000000000000beef1";
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const NEAR_USDC = `nep141:${USDC}`;
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const DEPOSIT = "c301252e757a0ff705e57bd4a8103d46e4871e2dbf4103e5a75344460f21fa49";
const BASE_TX = "0x" + "be".repeat(32);

const TOKENS = [
  { assetId: NEAR_USDC, blockchain: "near", symbol: "USDC", decimals: 6, contractAddress: USDC },
  { assetId: BASE_USDC, blockchain: "base", symbol: "USDC", decimals: 6, contractAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
  { assetId: "nep141:base.omft.near", blockchain: "base", symbol: "ETH", decimals: 18, contractAddress: null },
];

interface Sent {
  hash: string;
  signer: string;
  receiver: string;
  actions: { method: string; args: any; deposit: bigint; gas: bigint }[];
}

let world: {
  usdc: bigint;
  permission: unknown;
  /** How 1Click answers the committed quote: a quote, or one of its errors. */
  quote: { deadline: string; minAmountOut?: (amount: bigint) => bigint } | { status: number; message: string };
  /** 1Click's answers to `/v0/deposit/submit` and `/v0/status`: an HTTP error status when set. */
  submitFails?: number;
  statusFails?: number;
  quotes: any[];
  submitted: any[];
};
const sent: Sent[] = [];

function reset() {
  world = {
    usdc: 10_000_000n,
    permission: "FullAccess",
    quote: { deadline: new Date(Date.now() + 3 * 86_400_000).toISOString() },
    quotes: [],
    submitted: [],
  };
  sent.length = 0;
}

function decode(signedBase64: string): Sent {
  const bytes = Buffer.from(signedBase64, "base64");
  const { transaction: tx } = decodeSignedTransaction(bytes);
  return {
    hash: base58.encode(createHash("sha256").update(bytes).digest()),
    signer: tx.signerId,
    receiver: tx.receiverId,
    actions: tx.actions.map((a: any) => ({
      method: a.functionCall.methodName,
      args: JSON.parse(Buffer.from(a.functionCall.args).toString("utf8")),
      deposit: BigInt(a.functionCall.deposit),
      gas: BigInt(a.functionCall.gas),
    })),
  };
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => resolve(body));
  });
const send = (res: ServerResponse, body: unknown, status = 200) => {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
};
const outcome = (id: string, executor: string) => ({
  id,
  outcome: { logs: [], receipt_ids: [], gas_burnt: 0, tokens_burnt: "0", executor_id: executor, status: { SuccessValue: "" } },
  proof: [],
  block_hash: "11111111111111111111111111111111",
});
const unhandled: string[] = [];
let signerKey: KeyPair;

const server = createServer(async (req, res) => {
  const url = req.url ?? "";
  const body = await readBody(req);
  if (url === "/1click/v0/tokens") return send(res, TOKENS);
  if (url === "/1click/v0/quote") {
    const q = JSON.parse(body);
    world.quotes.push(q);
    if ("status" in world.quote) return send(res, { message: world.quote.message, path: "/v0/quote" }, world.quote.status);
    // 1Click's unauthenticated fee is 0.25%; the 1% slippage asked for comes off the minimum.
    const out = (BigInt(q.amount) * 9975n) / 10000n;
    const min = world.quote.minAmountOut?.(BigInt(q.amount)) ?? (out * 99n) / 100n;
    const quote = { amountIn: q.amount, amountOut: out.toString(), minAmountOut: min.toString(), timeEstimate: 22 };
    return send(res, { quoteRequest: q, quote: q.dry ? quote : { ...quote, depositAddress: DEPOSIT, deadline: world.quote.deadline }, signature: "ed25519:x", timestamp: new Date().toISOString() });
  }
  if (url === "/1click/v0/deposit/submit") {
    world.submitted.push(JSON.parse(body));
    if (world.submitFails) return send(res, { message: "Internal server error" }, world.submitFails);
    return send(res, { status: "KNOWN_DEPOSIT_TX" });
  }
  if (url === `/1click/v0/status?depositAddress=${DEPOSIT}`) {
    if (world.statusFails) return send(res, { message: "Bad gateway" }, world.statusFails);
    return send(res, { status: "SUCCESS", swapDetails: { destinationChainTxHashes: [{ hash: BASE_TX, explorerUrl: `https://basescan.org/tx/${BASE_TX}` }] } });
  }

  const call = JSON.parse(body);
  const ok = (result: unknown) => send(res, { jsonrpc: "2.0", id: call.id, result });
  const p = call.params;
  if (call.method === "query" && p.request_type === "call_function" && p.account_id === USDC) {
    const args = JSON.parse(Buffer.from(p.args_base64 ?? "", "base64").toString("utf8") || "{}");
    const value = p.method_name === "ft_balance_of" && args.account_id === WHITEHAT ? world.usdc.toString() : p.method_name === "storage_balance_bounds" ? { min: "1250000000000000000000", max: "1250000000000000000000" } : null;
    return ok({ result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" });
  } else if (call.method === "query" && p.request_type === "view_access_key") {
    if (p.public_key === signerKey.getPublicKey().toString()) return ok({ nonce: 1, permission: world.permission, block_height: 1, block_hash: "11111111111111111111111111111111" });
  } else if (call.method === "block") {
    return ok({ header: { hash: "11111111111111111111111111111111", height: 1, timestamp: 0 } });
  } else if (call.method === "send_tx" || call.method === "broadcast_tx_commit") {
    const s = decode(p.signed_tx_base64 ?? p[0]);
    sent.push(s);
    return ok({
      status: { SuccessValue: "" },
      transaction: { hash: s.hash, signer_id: s.signer, receiver_id: s.receiver },
      transaction_outcome: outcome(s.hash, s.signer),
      receipts_outcome: [outcome("R1", s.receiver)],
    });
  }
  unhandled.push(`${url} ${call.method} ${JSON.stringify(p).slice(0, 160)}`);
  send(res, { jsonrpc: "2.0", id: call.id, error: { message: "not in the stand-in" } }, 400);
});

let base = "";
let dir = "";
beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => server.close());
beforeEach(() => {
  reset();
  unhandled.length = 0;
  signerKey = KeyPair.fromRandom("ed25519");
  dir = mkdtempSync(join(tmpdir(), "bountee-withdraw-"));
  writeFileSync(join(dir, `${WHITEHAT}.json`), JSON.stringify({ account_id: WHITEHAT, public_key: signerKey.getPublicKey().toString(), private_key: signerKey.toString() }));
});

function bountee(args: string[], network = "mainnet") {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      [entry, "withdraw", ...args, "--timeout", "1", "--as", WHITEHAT, "--network", network, "--near-rpc", `${base}/near`, "--intents-api", `${base}/1click`, "--json"],
      { env: { ...process.env, BOUNTEE_CREDENTIALS_DIR: dir } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("D12: withdraw quotes USDC on NEAR to the named chain, refunds to the Whitehat's own NEAR account, sends exactly the amount to the deposit address and reports delivery", async () => {
  const r = await bountee(["2.5", "--to", `base:${RECIPIENT}`]);
  expect(r.code, `${r.stderr}\n${unhandled.join("\n")}`).toBe(0);

  const committed = world.quotes.find((q) => q.dry === false);
  expect(committed).toMatchObject({
    swapType: "EXACT_INPUT",
    originAsset: NEAR_USDC,
    destinationAsset: BASE_USDC,
    amount: "2500000",
    recipient: RECIPIENT,
    recipientType: "DESTINATION_CHAIN",
    depositType: "ORIGIN_CHAIN",
    refundTo: WHITEHAT,
    refundType: "ORIGIN_CHAIN",
  });

  // One transaction to NEAR's USDC: register the deposit address, then send it the amount.
  expect(sent).toHaveLength(1);
  const tx = sent[0]!;
  expect([tx.signer, tx.receiver]).toStrictEqual([WHITEHAT, USDC]);
  expect(tx.actions.map((a) => [a.method, a.args, a.deposit])).toStrictEqual([
    ["storage_deposit", { account_id: DEPOSIT, registration_only: true }, 1_250_000_000_000_000_000_000n],
    ["ft_transfer", { receiver_id: DEPOSIT, amount: "2500000" }, 1n],
  ]);

  expect(world.submitted).toStrictEqual([{ txHash: tx.hash, depositAddress: DEPOSIT, nearSenderAccount: WHITEHAT }]);
  expect(JSON.parse(r.stdout)).toMatchObject({
    amount: "2500000",
    to: { chain: "base", address: RECIPIENT },
    deposit_address: DEPOSIT,
    deposit_tx: tx.hash,
    amount_out: "2493750",
    min_amount_out: "2468812",
    status: "SUCCESS",
    delivered_txs: [BASE_TX],
  });
}, 60_000);

test("D12: an amount below 1Click's minimum is refused with the minimum, and nothing is sent", async () => {
  world.quote = { status: 400, message: "Amount is too low for bridge, try at least 4715" };
  const r = await bountee(["0.001", "--to", `base:${RECIPIENT}`]);
  expect(r.code).not.toBe(0);
  expect(JSON.parse(r.stderr).error).toMatch(/below 1Click's minimum of 0\.004715 USDC/);
  expect(sent).toHaveLength(0);
}, 60_000);

test("D12: an address the target chain won't accept is refused, and nothing is sent", async () => {
  world.quote = { status: 400, message: "recipient is not valid" };
  const r = await bountee(["1", "--to", "base:0x1234"]);
  expect(r.code).not.toBe(0);
  expect(JSON.parse(r.stderr).error).toMatch(/base won't accept 0x1234/);
  expect(sent).toHaveLength(0);
}, 60_000);

test("D12: a quote past its deadline, or too close to it to land in time, is never deposited to", async () => {
  for (const ms of [-1000, 60_000]) {
    world.quote = { deadline: new Date(Date.now() + ms).toISOString() };
    const r = await bountee(["1", "--to", `base:${RECIPIENT}`]);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.stderr).error).toMatch(/deadline/);
  }
  expect(sent).toHaveLength(0);
}, 60_000);

test("D12: a quote that guarantees less than 98% of the amount is refused, and nothing is sent", async () => {
  world.quote = { deadline: new Date(Date.now() + 86_400_000).toISOString(), minAmountOut: (a) => (a * 95n) / 100n };
  const r = await bountee(["1", "--to", `base:${RECIPIENT}`]);
  expect(r.code).not.toBe(0);
  expect(JSON.parse(r.stderr).error).toMatch(/guarantees only 0\.95 USDC/);
  expect(sent).toHaveLength(0);
}, 60_000);

test("D12: once the deposit is sent it is always reported, even when 1Click can't be told of it or asked its status", async () => {
  Object.assign(world, { submitFails: 500, statusFails: 502 });
  const r = await bountee(["1", "--to", `base:${RECIPIENT}`]);
  expect(sent).toHaveLength(1);
  expect(r.code).not.toBe(0);
  const out = JSON.parse(r.stdout);
  expect(out).toMatchObject({ deposit_address: DEPOSIT, deposit_tx: sent[0]!.hash, status: "PENDING_DEPOSIT" });
  expect(out.problems.join("\n")).toMatch(/deposit\/submit.*500[\s\S]*status.*502/);
}, 60_000);

test("D12: withdraw refuses before quoting: testnet, a chain 1Click has no USDC on, more than the balance, a claim key", async () => {
  const cases: [string[], RegExp, string?][] = [
    [["1", "--to", `base:${RECIPIENT}`], /mainnet only/, "testnet"],
    [["1", "--to", `flare:${RECIPIENT}`], /no USDC on flare/],
    [["11", "--to", `base:${RECIPIENT}`], /holds 10 USDC/],
    [["1", "--to", `near:${WHITEHAT}`], /already on NEAR/],
  ];
  for (const [args, error, network] of cases) {
    const r = await bountee(args, network);
    expect(r.code, args.join(" ")).not.toBe(0);
    expect(JSON.parse(r.stderr).error).toMatch(error);
  }
  world.permission = { FunctionCall: { receiver_id: "bounty.bountee.near", method_names: ["submit_claim", "retry_claim"], allowance: null } };
  const r = await bountee(["1", "--to", `base:${RECIPIENT}`]);
  expect(JSON.parse(r.stderr).error).toMatch(/claim key/);
  expect(world.quotes.filter((q) => q.dry === false)).toHaveLength(0);
  expect(sent).toHaveLength(0);
}, 60_000);
