// Seam T, review fixes (#25, #26, #16, #17): what a Whitehat's key may send, and the commands
// for the flows the bounty contract already has: `claim --retry` (R2.6), `retry-payout` (R3.6),
// `sign-pauses` (R2.5), `balance` (R11.3), the claim key's methods (R14.1, R14.3), and one
// bounty-id rule for every command (D25).
//
// Seams (written before the first test): T, the `bountee` command line run as a process against
// a local stand-in for NEAR's RPC and one EVM chain's. The stand-in decodes every signed
// transaction the tool sends (borsh `SignedTransaction`), so each test sees the method, args,
// deposit and gas the tool really sent, and plays the bounty contract's answer to it. It serves
// the signing key's permission as the chain would: full access, or a claim key's.
//   Catches: the methods a claim key is created with; `claim` run with a claim key sending only
//   claim actions and naming the rest for the Whitehat's key; `claim --retry` sending
//   `retry_claim` with the proofs exactly as filed; `retry-payout` sending `retry_payout` only
//   once no earlier claim holds its place; `balance` reading, topping up and withdrawing with
//   exactly 1 yoctoNEAR; a bad bounty id refused alike by every command before any RPC.
//   Misses: the contract's own checks (seam C) and the network's enforcement of a claim key's
//   permission (claim-key-testnet.test.ts, live).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58 } from "@scure/base";
import { decodeSignedTransaction, KeyPair } from "near-api-js";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { NEAR_GAS_PRICE, NEAR_PROTOCOL_CONFIG } from "./testnet/stand-ins.ts";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const judgeFixtures = new URL("../../judge/tests/fixtures/", import.meta.url);
const CONTRACT = "bounty.example.testnet";
const WHITEHAT = "alice.testnet";
const BOUNTY = { protocol: "protocol.testnet", name: "vault" };
const BOUNTY_TEXT = `${BOUNTY.protocol}/${BOUNTY.name}`;
const SUBMIT_TX = "9Ld3WhcY2ZVDS6fZyZW4o7Nc9Y5dPhWv4tyUfEhVvBVa";
const PAUSE = { chain_id: 84532, contract: "0x" + "aa".repeat(20), nonce: 0, tx: "0x02", tx_hash: "0x" + "a1".repeat(32) };
const PAYS = { outcome: "PAYS", reason: "minimum_theft_reached" };
const ZERO = { outcome: "ZERO", reason: "below_minimum_theft" };
const YOCTO = 10n ** 24n;
const MIN_RETRY_PAYOUT_GAS = 45_000_000_000_000n;
const VERIFY_FEE = YOCTO / 20n;

/** R14.1, spelled out: the bounty contract's claim actions, and nothing else. */
const CLAIM_ACTIONS = ["submit_claim", "retry_claim"];
const CLAIM_KEY = { FunctionCall: { receiver_id: CONTRACT, method_names: CLAIM_ACTIONS, allowance: String(YOCTO) } };

const state = JSON.parse(readFileSync(new URL("state.json", judgeFixtures), "utf8"));
/** The proofs exactly as the claim's `submit_claim` carried them. */
const PROOFS = JSON.stringify(state.proofs);
const sha256 = (text: string) => `0x${createHash("sha256").update(text).digest("hex")}`;

// ---- The stand-in's world -----------------------------------------------------------------

interface Sent {
  hash: string;
  signer: string;
  receiver: string;
  method?: string;
  args?: any;
  deposit?: bigint;
  gas?: bigint;
  addKey?: { publicKey: string; permission: any };
}

let world: {
  claim: any;
  bounty: any;
  /** The permission of the key the tool signs with. */
  permission: unknown;
  /** Keys added by the tool, by public key. */
  added: Record<string, unknown>;
  /** The Whitehat account's NEAR (its storage stake is 1 byte). */
  near: bigint;
  balance: bigint;
  verified: boolean;
  /** The prepaid verification attempts left on the chain (of three). */
  prepaidLeft: number;
  /** What `retry_claim` leaves behind: the claim's verdict and the bounty. */
  afterRetry: { verdict: unknown; bounty?: Record<string, unknown> };
  /** What `sign_pauses` leaves the bounty as. */
  afterSign: Record<string, unknown>;
};
const sent: Sent[] = [];
const outcomes = new Map<string, unknown>();
let requests = 0;

function reset() {
  world = {
    claim: {
      bounty: BOUNTY,
      whitehat: WHITEHAT,
      block: state.block,
      header: state.header,
      proofs_sha256: sha256(PROOFS),
      submitted_at_ns: "1793850608584544984",
      secret_profile: "c3",
      state: "no_verdict",
      verdict: null,
    },
    bounty: {
      id: BOUNTY,
      rules: { bounty_amount: "100000000", covered_contracts: [{ chain_id: PAUSE.chain_id, address: PAUSE.contract }] },
      state: "live",
      winning_claim: null,
      signed_pauses: [],
      signing_pauses: false,
      paying_out: false,
      payout_waits_until_ns: null,
    },
    permission: "FullAccess",
    added: {},
    near: 10n * YOCTO,
    balance: 3n * YOCTO,
    verified: false,
    prepaidLeft: 3,
    afterRetry: { verdict: ZERO },
    afterSign: { state: "paid" },
  };
  sent.length = 0;
  outcomes.clear();
  requests = 0;
}

const outcome = (id: string, executor: string, logs: string[] = []) => ({
  id,
  outcome: { logs, receipt_ids: [], gas_burnt: 0, tokens_burnt: "0", executor_id: executor, status: { SuccessValue: "" } },
  proof: [],
  block_hash: "11111111111111111111111111111111",
});
const txOutcome = (hash: string, signer: string, receiver: string, transaction: Record<string, unknown> = {}) => ({
  status: { SuccessValue: "" },
  final_execution_status: "FINAL",
  transaction: { hash, signer_id: signer, receiver_id: receiver, ...transaction },
  transaction_outcome: outcome(hash, signer),
  receipts_outcome: [outcome(`${hash}-r`, receiver)],
});

/** The bounty contract's answer to each call the tool sends. */
function play(s: Sent) {
  if (s.addKey) world.added[s.addKey.publicKey] = s.addKey.permission;
  if (s.method === "retry_claim") {
    Object.assign(world.claim, { state: "judged", verdict: world.afterRetry.verdict });
    Object.assign(world.bounty, world.afterRetry.bounty ?? {});
  }
  if (s.method === "sign_pauses") Object.assign(world.bounty, world.afterSign);
  if (s.method === "retry_payout") world.bounty.state = "paid";
  if (s.method === "verify_pause") world.verified = true;
  if (s.method === "top_up_claim_balance") world.balance += s.deposit!;
  if (s.method === "withdraw_claim_balance") world.balance -= s.args.amount === undefined ? world.balance : BigInt(s.args.amount);
}

function decode(signedBase64: string): Sent {
  const bytes = Buffer.from(signedBase64, "base64");
  const { transaction: tx } = decodeSignedTransaction(bytes);
  const hash = base58.encode(createHash("sha256").update(bytes).digest());
  const out: Sent = { hash, signer: tx.signerId, receiver: tx.receiverId };
  const a: any = tx.actions[0];
  if (a.functionCall) {
    Object.assign(out, {
      method: a.functionCall.methodName,
      args: JSON.parse(Buffer.from(a.functionCall.args).toString("utf8")),
      deposit: BigInt(a.functionCall.deposit),
      gas: BigInt(a.functionCall.gas),
    });
  } else if (a.addKey) {
    const p = a.addKey.accessKey.permission;
    out.addKey = {
      publicKey: `ed25519:${base58.encode(Uint8Array.from(a.addKey.publicKey.ed25519Key.data))}`,
      permission: p.functionCall
        ? { FunctionCall: { receiver_id: p.functionCall.receiverId, method_names: p.functionCall.methodNames, allowance: p.functionCall.allowance?.toString() ?? null } }
        : "FullAccess",
    };
  }
  return out;
}

const VIEWS: Record<string, (args: any) => unknown> = {
  claim: ({ claim_id }) => (claim_id === 3 ? world.claim : null),
  bounty: ({ id }) => (id.protocol === BOUNTY.protocol && id.name === BOUNTY.name ? world.bounty : null),
  claim_balance: () => world.balance.toString(),
  config: () => ({ outlayer: "outlayer.testnet", usdc: "usdc.testnet", judge_build_hash: `0x${"5a".repeat(32)}` }),
  fees: () => ({
    job_deposit: String(20n * 10n ** 21n),
    storage_price_per_byte: String(10n ** 19n),
    job_input_free_bytes: 32768,
    secret_row_overhead_bytes: 1024,
    min_sign_pauses_gas_base: "50000000000000",
    min_sign_pauses_gas_per_contract: "30000000000000",
    min_retry_payout_gas: MIN_RETRY_PAYOUT_GAS.toString(),
    min_verify_pause_gas_base: "50000000000000",
    min_verify_pause_gas_per_pause: "10000000000000",
    verify_pause_fee_per_pause: VERIFY_FEE.toString(),
  }),
  pause_verifications: () => [
    { chain_id: PAUSE.chain_id, verified: world.verified, verified_pauses: world.verified ? [PAUSE.tx_hash] : [], attempts: world.verified ? 1 : 0, prepaid_attempts_left: world.prepaidLeft, verifying: false },
  ],
};

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => resolve(body));
  });
const reply = (res: ServerResponse, id: unknown, result: unknown) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
};
const unhandled: string[] = [];
let signerKey: KeyPair;

const server = createServer(async (req, res) => {
  requests++;
  const call = JSON.parse(await readBody(req));
  const ok = (result: unknown) => reply(res, call.id, result);
  const p = call.params;
  if (req.url?.startsWith("/evm")) {
    if (call.method === "eth_sendRawTransaction") return ok(PAUSE.tx_hash);
    if (call.method === "eth_getTransactionReceipt") return ok({ status: "0x1", blockNumber: "0x10" });
    if (call.method === "eth_getBlockByNumber") return ok({ number: "0x100" });
  } else if (call.method === "query" && p.request_type === "call_function" && VIEWS[p.method_name]) {
    const args = JSON.parse(Buffer.from(p.args_base64 ?? "", "base64").toString("utf8") || "{}");
    return ok({ result: [...Buffer.from(JSON.stringify(VIEWS[p.method_name]!(args)))], logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" });
  } else if (call.method === "query" && p.request_type === "view_access_key") {
    const permission = p.public_key === signerKey.getPublicKey().toString() ? world.permission : world.added[p.public_key];
    if (permission) return ok({ nonce: 1, permission, block_height: 1, block_hash: "11111111111111111111111111111111" });
  } else if (call.method === "query" && p.request_type === "view_account") {
    return ok({ amount: String(world.near), locked: "0", code_hash: "11111111111111111111111111111111", storage_usage: 1, block_height: 1, block_hash: "11111111111111111111111111111111" });
  } else if (call.method === "EXPERIMENTAL_protocol_config") {
    return ok(NEAR_PROTOCOL_CONFIG);
  } else if (call.method === "gas_price") {
    return ok(NEAR_GAS_PRICE);
  } else if (call.method === "block") {
    return ok({ header: { hash: "11111111111111111111111111111111", height: 1, timestamp: 0 } });
  } else if (call.method === "send_tx" || call.method === "broadcast_tx_commit") {
    const s = decode(p.signed_tx_base64 ?? p[0]);
    sent.push(s);
    play(s);
    const o = txOutcome(s.hash, s.signer, s.receiver);
    outcomes.set(s.hash, o);
    return ok(o);
  } else if (call.method === "EXPERIMENTAL_tx_status" || call.method === "tx") {
    if (p.tx_hash === SUBMIT_TX) {
      const args = Buffer.from(JSON.stringify({ bounty: BOUNTY, block: state.block, header: state.header, proofs: PROOFS, sealed_exploit: "AAAA" })).toString("base64");
      return ok(txOutcome(SUBMIT_TX, WHITEHAT, CONTRACT, { actions: [{ FunctionCall: { method_name: "submit_claim", args, gas: 300000000000000, deposit: "0" } }] }));
    }
    if (outcomes.has(p.tx_hash)) return ok(outcomes.get(p.tx_hash));
  }
  unhandled.push(`${req.url} ${call.method} ${JSON.stringify(p).slice(0, 160)}`);
  res.statusCode = 400;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { message: "not in the stand-in" } }));
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
  // The Whitehat's key, in a credentials folder of its own; `claim` saves its transactions
  // under the working directory, where the claim's own transaction is already recorded.
  dir = mkdtempSync(join(tmpdir(), "bountee-whitehat-"));
  signerKey = KeyPair.fromRandom("ed25519");
  writeFileSync(join(dir, `${WHITEHAT}.json`), JSON.stringify({ account_id: WHITEHAT, public_key: signerKey.getPublicKey().toString(), private_key: signerKey.toString() }));
  mkdirSync(join(dir, ".bountee", "claims", CONTRACT), { recursive: true });
  writeFileSync(join(dir, ".bountee", "claims", CONTRACT, "3.json"), JSON.stringify({ contract: CONTRACT, claim_id: 3, txs: [SUBMIT_TX] }));
});

function bountee(args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string; out: any }>((resolve) => {
    const child = spawn(process.execPath, [entry, ...args, "--json"], { cwd: dir, env: { ...process.env, BOUNTEE_CREDENTIALS_DIR: dir, BOUNTEE_CONTRACT: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => {
      let out: any = null;
      try {
        out = JSON.parse(stdout);
      } catch {
        // not JSON: the test says so
      }
      resolve({ code, stdout, stderr: `${stderr}\n${unhandled.join("\n")}`, out });
    });
  });
}
const NEAR = () => ["--contract", CONTRACT, "--near-rpc", `${base}/near`];
const RETRY = () => ["claim", "--retry", "3", "--contract", CONTRACT, "--as", WHITEHAT, "--rpc", `${base}/near`, "--chain-rpc", `84532=${base}/evm`, "--interval", "0.05", "--timeout", "1", "--verify-wait", "5"];
const methods = () => sent.map((s) => s.method ?? (s.addKey ? "add_key" : "?"));

// ---- The claim key (R14.1, R14.3) ------------------------------------------------------------

test("R14.1: bountee key add creates a function-call key on the Whitehat's account for the bounty contract's claim actions only", async () => {
  const outDir = mkdtempSync(join(tmpdir(), "bountee-agent-"));
  const r = await bountee(["key", "add", "--as", WHITEHAT, "--out-dir", outDir, ...NEAR()]);
  expect(r.code, r.stderr).toBe(0);
  expect(sent).toHaveLength(1);
  // Sent from the Whitehat's account to itself, as one AddKey...
  expect(sent[0]).toMatchObject({ signer: WHITEHAT, receiver: WHITEHAT });
  // ...whose permission is the bounty contract's claim actions, and only those.
  expect(sent[0]!.addKey!.permission).toStrictEqual({ FunctionCall: { receiver_id: CONTRACT, method_names: ["submit_claim", "retry_claim"], allowance: String(YOCTO) } });
  expect(r.out.permission.method_names).toStrictEqual(["submit_claim", "retry_claim"]);
}, 60_000);

test("R14.1 R14.3 R2.5: claim signed with a claim key never sends sign_pauses, and names the command for the Whitehat's own key", async () => {
  world.afterRetry = { verdict: PAYS, bounty: { state: "signing", winning_claim: 3, signing_pauses: false } };
  world.permission = CLAIM_KEY;
  const r = await bountee(RETRY());
  expect(r.code, r.stderr).toBe(0);
  expect(methods()).toStrictEqual(["retry_claim"]);
  expect(r.out.verdict).toStrictEqual(PAYS);
  expect(r.out.next_steps).toStrictEqual([
    `the pauses wait to be signed, and a claim key can't ask: run \`bountee sign-pauses ${BOUNTY_TEXT} --contract ${CONTRACT} --as ${WHITEHAT}\` with your own key`,
  ]);

  // The control: the same claim, signed with the account's own key, asks for the signatures.
  reset();
  world.afterRetry = { verdict: PAYS, bounty: { state: "signing", winning_claim: 3, signing_pauses: false } };
  const full = await bountee(RETRY());
  expect(full.code, full.stderr).toBe(0);
  expect(methods()).toStrictEqual(["retry_claim", "sign_pauses"]);
  expect(sent[1]!.args).toStrictEqual({ id: BOUNTY });
  expect(full.out.next_steps).toStrictEqual([]);
}, 60_000);

test("R14.1 R14.3 R7.3: claim signed with a claim key broadcasts the pause but never sends verify_pause, and names the command for the Whitehat's own key", async () => {
  const paid = { state: "paid", winning_claim: 3, signed_pauses: [PAUSE] };
  world.afterRetry = { verdict: PAYS, bounty: paid };
  world.permission = CLAIM_KEY;
  const r = await bountee(RETRY());
  expect(r.code, r.stderr).toBe(0);
  expect(methods()).toStrictEqual(["retry_claim"]);
  expect(r.out.broadcast.pauses.map((p: any) => p.tx_hash)).toStrictEqual([PAUSE.tx_hash]);
  expect(r.out.verification).toBeUndefined();
  expect(r.out.next_steps).toStrictEqual([
    `each pause is verified on NEAR once its chain reports it safe, and a claim key can't ask: run \`bountee verify-pause ${BOUNTY_TEXT} --contract ${CONTRACT} --as ${WHITEHAT}\` with your own key`,
  ]);

  // The control: signed with the account's own key, claim has the pause verified.
  reset();
  world.afterRetry = { verdict: PAYS, bounty: paid };
  const full = await bountee(RETRY());
  expect(full.code, full.stderr).toBe(0);
  expect(methods()).toStrictEqual(["retry_claim", "verify_pause"]);
  expect(full.out.verification.chains[0]).toMatchObject({ chain_id: PAUSE.chain_id, verified: true });
}, 60_000);

// ---- verify-pause: who uses the prepaid attempts (R7.10) -------------------------------------

test("R7.10: verify-pause attaches nothing for the winning Whitehat or the posting Protocol while prepaid attempts are left, and the fee per pause for anyone else or once they are used", async () => {
  Object.assign(world.claim, { state: "judged", verdict: PAYS });
  Object.assign(world.bounty, { state: "paid", winning_claim: 3, signed_pauses: [PAUSE] });
  const verifyAs = async (account: string) => {
    // Every account signs with the one stand-in key; only who it is matters here.
    writeFileSync(join(dir, `${account}.json`), JSON.stringify({ account_id: account, public_key: signerKey.getPublicKey().toString(), private_key: signerKey.toString() }));
    world.verified = false;
    const r = await bountee(["verify-pause", BOUNTY_TEXT, "--as", account, "--rpc", `84532=${base}/evm`, "--wait", "5", ...NEAR()]);
    expect(r.code, r.stderr).toBe(0);
    const s = sent.at(-1)!;
    expect(s).toMatchObject({ signer: account, method: "verify_pause", args: { id: BOUNTY, chain_id: PAUSE.chain_id } });
    expect(r.out.chains[0].deposit).toBe(s.deposit!.toString());
    return s.deposit;
  };
  expect(await verifyAs(WHITEHAT)).toBe(0n); // the winner
  expect(await verifyAs(BOUNTY.protocol)).toBe(0n); // the Protocol
  expect(await verifyAs("carol.testnet")).toBe(VERIFY_FEE); // anyone else: one pause's fee
  world.prepaidLeft = 0;
  expect(await verifyAs(WHITEHAT)).toBe(VERIFY_FEE); // the winner, once the prepaid attempts are used
}, 60_000);

// ---- claim --retry (R2.6) ------------------------------------------------------------------

test("R2.6 R14.1: claim --retry sends retry_claim with the proofs exactly as filed, read back from the claim's transaction, and sees it to its verdict", async () => {
  world.permission = CLAIM_KEY; // a claim key may retry
  const r = await bountee(RETRY());
  expect(r.code, r.stderr).toBe(0);
  expect(sent).toHaveLength(1);
  const s = sent[0]!;
  expect(s).toMatchObject({ signer: WHITEHAT, receiver: CONTRACT, method: "retry_claim", deposit: 0n });
  expect(s.args).toStrictEqual({ claim_id: 3, proofs: PROOFS });
  expect(s.gas).toBeGreaterThanOrEqual(200_000_000_000_000n);
  expect(r.out).toMatchObject({ retried: true, claim_id: 3, tx_hash: s.hash, state: "judged", verdict: ZERO });
  // The retry's transaction is kept beside the claim's, for `status`.
  expect(JSON.parse(readFileSync(join(dir, ".bountee", "claims", CONTRACT, "3.json"), "utf8")).txs).toStrictEqual([SUBMIT_TX, s.hash]);
}, 60_000);

test("R2.6: claim --retry refuses, sending nothing, proofs other than the claim's, a claim with a verdict, and someone else's claim", async () => {
  const evidence = join(dir, "other.json");
  writeFileSync(evidence, JSON.stringify({ block: state.block, header: state.header, proofs: state.proofs.slice(1) }));
  const other = await bountee([...RETRY(), "--evidence", evidence]);
  expect(other.code).toBe(1);
  expect(JSON.parse(other.stderr.split("\n")[0]!).error).toMatch(/these proofs hash to 0x[0-9a-f]{64}, but claim 3 was filed with/);

  world.claim.state = "judged";
  const judged = await bountee(RETRY());
  expect(JSON.parse(judged.stderr.split("\n")[0]!).error).toBe("claim 3 is judged: only a claim left with no verdict can be retried");

  world.claim.state = "no_verdict";
  world.claim.whitehat = "bob.testnet";
  const theirs = await bountee(RETRY());
  expect(JSON.parse(theirs.stderr.split("\n")[0]!).error).toBe("claim 3 was filed by bob.testnet: only its Whitehat may retry it");
  expect(sent).toHaveLength(0);
}, 60_000);

/**
 * R11.1 R14.1, #57: NEAR takes a call's attached gas up front at its 1e9 yoctoNEAR minimum price,
 * so `retry_claim`'s 300 Tgas wants about 0.3 NEAR in hand, and a claim key's allowance pays it.
 * The tool checks both before anything is sent, and names what to add.
 */
test("R11.1 R14.1: claim --retry refuses, sending nothing, when the Whitehat can't hold the call's gas or a claim key's allowance can't cover it", async () => {
  world.permission = CLAIM_KEY;
  world.near = (YOCTO * 3n) / 10n; // 0.3 NEAR, just under 300 Tgas at 1e9 plus the call's receipt costs
  const poor = await bountee(RETRY());
  expect(poor.code).toBe(1);
  expect(JSON.parse(poor.stderr.split("\n")[0]!).error).toMatch(/^alice\.testnet holds 0\.29\d* NEAR free of its storage stake and this claim needs 0\.30\d+ in hand .*: add 0\.00\d+ NEAR \(nothing was spent\)$/);

  world.near = 10n * YOCTO;
  world.permission = { FunctionCall: { ...CLAIM_KEY.FunctionCall, allowance: String(YOCTO / 4n) } };
  const spent = await bountee(RETRY());
  expect(spent.code).toBe(1);
  expect(JSON.parse(spent.stderr.split("\n")[0]!).error).toMatch(/^the claim key's allowance holds 0\.25 NEAR and retry_claim takes 0\.30\d+ of it up front: add a claim key with a larger --allowance \(nothing was spent\)$/);
  expect(sent).toHaveLength(0);
}, 60_000);

// ---- retry-payout (R3.6) -------------------------------------------------------------------

test("R3.6: retry-payout refuses while an earlier claim holds its place, then sends retry_payout for the bounty", async () => {
  Object.assign(world.bounty, { state: "paying", winning_claim: 3, payout_waits_until_ns: String((BigInt(Date.now()) + 3_600_000n) * 1_000_000n) });
  const early = await bountee(["retry-payout", BOUNTY_TEXT, "--as", WHITEHAT, ...NEAR()]);
  expect(early.code).toBe(1);
  expect(JSON.parse(early.stderr.split("\n")[0]!).error).toMatch(/^an earlier claim holds its place until \d{4}-\d\d-\d\dT.*: retry the payout after then$/);
  expect(sent).toHaveLength(0);

  world.bounty.payout_waits_until_ns = null;
  const r = await bountee(["retry-payout", BOUNTY_TEXT, "--as", WHITEHAT, ...NEAR()]);
  expect(r.code, r.stderr).toBe(0);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ signer: WHITEHAT, receiver: CONTRACT, method: "retry_payout", args: { id: BOUNTY }, deposit: 0n });
  expect(sent[0]!.gas).toBeGreaterThanOrEqual(MIN_RETRY_PAYOUT_GAS);
  expect(r.out).toMatchObject({ bounty: BOUNTY, contract: CONTRACT, tx_hash: sent[0]!.hash, state: "paid" });
}, 60_000);

// ---- balance (R11.3) -------------------------------------------------------------------------

test("R11.3: balance shows the claim balance, tops it up, and withdraws part or all of it with exactly 1 yoctoNEAR attached", async () => {
  const shown = await bountee(["balance", "--as", WHITEHAT, ...NEAR()]);
  expect(shown.code, shown.stderr).toBe(0);
  expect(shown.out).toStrictEqual({ contract: CONTRACT, account: WHITEHAT, action: "show", balance: String(3n * YOCTO) });
  expect(sent).toHaveLength(0);

  const topUp = await bountee(["balance", "top-up", "0.5", "--as", WHITEHAT, ...NEAR()]);
  expect(topUp.code, topUp.stderr).toBe(0);
  expect(sent[0]).toMatchObject({ receiver: CONTRACT, method: "top_up_claim_balance", args: {}, deposit: YOCTO / 2n });
  expect(topUp.out).toMatchObject({ action: "top_up", amount: String(YOCTO / 2n), balance: String(3n * YOCTO + YOCTO / 2n) });

  const part = await bountee(["balance", "withdraw", "1.25", "--as", WHITEHAT, ...NEAR()]);
  expect(part.code, part.stderr).toBe(0);
  expect(sent[1]).toMatchObject({ receiver: CONTRACT, method: "withdraw_claim_balance", args: { amount: String((5n * YOCTO) / 4n) }, deposit: 1n });
  expect(part.out).toMatchObject({ action: "withdraw", balance: String((9n * YOCTO) / 4n) });

  const all = await bountee(["balance", "withdraw", "--as", WHITEHAT, ...NEAR()]);
  expect(all.code, all.stderr).toBe(0);
  expect(sent[2]).toMatchObject({ method: "withdraw_claim_balance", args: {}, deposit: 1n });
  expect(all.out).toMatchObject({ action: "withdraw", amount: String((9n * YOCTO) / 4n), balance: "0" });
}, 60_000);

test("R11.3 R14.3: balance signed with a claim key refuses to top up or withdraw, sending nothing", async () => {
  world.permission = CLAIM_KEY;
  for (const args of [["top-up", "1"], ["withdraw"]]) {
    const r = await bountee(["balance", ...args, "--as", WHITEHAT, ...NEAR()]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stderr.split("\n")[0]!).error).toMatch(/^the local key for alice\.testnet is a claim key: it can't /);
  }
  expect(sent).toHaveLength(0);
}, 60_000);

// ---- One bounty-id rule (D25) ---------------------------------------------------------------

test("D25: every command refuses a bad bounty id the same way, before any RPC", async () => {
  const BAD = ["Protocol.testnet/vault", "protocol.testnet/Vault", "protocol.testnet/vault/x", "protocol.testnet", "protocol.testnet/-vault", "/vault", "protocol.testnet/", "protocol.testnet/va ult"];
  const rules = join(dir, "rules.json");
  writeFileSync(rules, "{}");
  const commands = (id: string): string[][] => [
    ["show", id, ...NEAR()],
    ["post", id, "--rules", rules, ...NEAR()],
    ["broadcast", id, ...NEAR()],
    ["verify-pause", id, "--as", WHITEHAT, ...NEAR()],
    ["open-exploit", id, "--key-file", rules, ...NEAR()],
    ["publish", id, "--as", WHITEHAT, "--proofs", rules, ...NEAR()],
    ["rerun", id, ...NEAR()],
    ["verify", id, ...NEAR()],
    ["sign-pauses", id, "--as", WHITEHAT, ...NEAR()],
    ["retry-payout", id, "--as", WHITEHAT, ...NEAR()],
    ["claim", "--bounty", id, "--as", WHITEHAT, "--contract", CONTRACT, "--rpc", `${base}/near`],
    ["test", "x.s.sol", "--bounty", id, ...NEAR()],
  ];
  for (const id of BAD) {
    for (const args of commands(id)) {
      const r = await bountee(args);
      expect(r.code, `${args.join(" ")}: ${r.stdout}`).toBe(1);
      expect(JSON.parse(r.stderr.split("\n")[0]!), args.join(" ")).toStrictEqual({ error: `${id} is not a bounty id <protocol account>/<bounty name>` });
    }
  }
  expect(requests).toBe(0);
}, 120_000);
