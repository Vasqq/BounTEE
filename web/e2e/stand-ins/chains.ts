// Test stand-in for every chain service the web app reads or writes: NEAR RPC, FastNEAR's
// explorer API, and each EVM chain's JSON-RPC. It answers from a `World` the spec sets with
// `PUT /world`, so a spec can put the chains in any state, including ones mainnet can't be
// driven into at will. It lives only in the test folder; the app reaches it because the
// Playwright config points the app's endpoints here (playwright.config.ts).
//
// Its answers keep the shapes the real services give, as read on Nov 6 from NEAR RPC
// (`query` call_function / view_state / view_account, `EXPERIMENTAL_tx_status`), FastNEAR's
// `/v0/account` and `/v0/transactions`, and ordinary EVM JSON-RPC.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { base58 } from "@scure/base";
import { decodeFunctionData, encodeAbiParameters, keccak256, parseAbi, toHex } from "viem";
import { pauseRole } from "@bountee/formats";
import { CONTRACT, hashOfRaw as txHash, nearHash, type World } from "./world.ts";

let world: World | null = null;
/** Raw transactions sent to each EVM chain, in order, for a spec to read back. */
let sent: Record<number, string[]> = {};

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

const bountyKey = (id: { protocol: string; name: string }) => `${id.protocol}/${id.name}`;

/** Borsh of a string: u32 little-endian length, then the UTF-8 bytes. */
function borshString(s: string): Buffer {
  const b = Buffer.from(s, "utf8");
  const n = Buffer.alloc(4);
  n.writeUInt32LE(b.length);
  return Buffer.concat([n, b]);
}

function view(w: World, method: string, args: any): unknown {
  switch (method) {
    case "config":
      return w.config;
    case "fees":
      return w.fees;
    case "bounty":
      return w.bounties.find((b) => bountyKey(b.id) === bountyKey(args.id)) ?? null;
    case "claim":
      return w.claims.find((c) => c.id === args.claim_id)?.record ?? null;
    case "pause_role":
      // As the contract derives it (D25), unless the spec pinned one.
      return w.pauseRoles[bountyKey(args.id)] ?? { path: bountyKey(args.id), address: pauseRole.address(pauseRole.MAINNET_ROOT_PUBLIC_KEY, w.contract, args.id) };
    case "pause_verifications":
      return w.verifications[bountyKey(args.id)] ?? [];
    case "published_exploit":
      return w.publications[bountyKey(args.id)] ?? null;
    case "released_exploit":
      return w.releases[bountyKey(args.id)] ?? null;
    case "posting_fee_balance":
      return w.posting?.feeBalances[args.account_id] ?? "0";
    case "ft_metadata":
      return { spec: "ft-1.0.0", name: "USDC", symbol: "USDC", decimals: 6 };
    case "ft_balance_of":
      return w.posting?.usdc[args.account_id] ?? "0";
    default:
      throw new Error(`MethodNotFound: ${method}`);
  }
}

/** The contract's storage under one prefix, as `view_state` lists it (contract/src/lib.rs `Key`). */
function state(w: World, prefix: number): { key: string; value: string }[] {
  if (prefix === 0) {
    return w.bounties.map((b) => ({
      key: Buffer.concat([Buffer.from([0]), borshString(b.id.protocol), borshString(b.id.name)]).toString("base64"),
      value: "",
    }));
  }
  if (prefix === 1) {
    return w.claims.map((c) => {
      const id = Buffer.alloc(8);
      id.writeBigUInt64LE(BigInt(c.id));
      // A claim record's Borsh starts with its bounty id; the rest isn't read by the app.
      const value = Buffer.concat([borshString(c.record.bounty.protocol), borshString(c.record.bounty.name), Buffer.alloc(16)]);
      return { key: Buffer.concat([Buffer.from([1]), id]).toString("base64"), value: value.toString("base64") };
    });
  }
  return [];
}

function nearRpc(w: World, method: string, params: any): { result?: unknown; error?: unknown } {
  if (method === "query") {
    if (params.request_type === "call_function") {
      const account = params.account_id;
      const args = JSON.parse(Buffer.from(params.args_base64 ?? "", "base64").toString("utf8") || "{}");
      if (account !== w.contract && !(account === w.config.usdc && ["ft_metadata", "ft_balance_of"].includes(params.method_name))) {
        return { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } };
      }
      try {
        const out = view(w, params.method_name, args);
        return { result: { result: [...Buffer.from(JSON.stringify(out))], logs: [], block_height: 1, block_hash: "stand-in" } };
      } catch (e) {
        return { error: { name: "HANDLER_ERROR", cause: { name: "FUNCTION_CALL_ERROR" }, data: (e as Error).message } };
      }
    }
    if (params.request_type === "view_state") {
      if (params.account_id !== w.contract) return { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } };
      const prefix = Buffer.from(params.prefix_base64 ?? "", "base64")[0] ?? 0;
      return { result: { values: state(w, prefix), block_height: 1, block_hash: "stand-in" } };
    }
    if (params.request_type === "view_access_key" && w.posting && params.public_key === `ed25519:${base58.encode(Buffer.from(w.posting.relayerKeyHex, "hex"))}`) {
      return w.posting.onboarded.includes(params.account_id)
        ? { result: { nonce: 0, permission: { FunctionCall: { allowance: null, receiver_id: params.account_id, method_names: ["rlp_execute"] } } } }
        : { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCESS_KEY" }, message: "access key does not exist while viewing" } };
    }
    if (params.request_type === "view_access_key") {
      const claimKey = w.claimKeys?.[`${params.account_id}/${params.public_key}`];
      return { result: { nonce: 1, permission: claimKey ? { FunctionCall: { allowance: null, receiver_id: claimKey, method_names: ["submit_claim", "retry_claim"] } } : "FullAccess" } };
    }
    if (params.request_type === "view_account") {
      const a = w.accounts[params.account_id];
      if (!a) return { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_ACCOUNT" } } };
      return { result: { amount: a.amount, code_hash: a.code_hash, locked: "0", storage_usage: 182 } };
    }
  }
  if (method === "EXPERIMENTAL_tx_status" || method === "tx") {
    const tx = w.nearTxs.find((t) => t.hash === params.tx_hash && t.signer === params.sender_account_id);
    if (!tx) return { error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } };
    return {
      result: {
        status: { SuccessValue: "" },
        transaction: { hash: tx.hash, signer_id: tx.signer, public_key: tx.publicKey ?? `ed25519:full-${tx.signer}`, receiver_id: w.contract, actions: [] },
        transaction_outcome: { id: tx.hash, block_hash: `block-of-${tx.hash}`, outcome: { executor_id: tx.signer, logs: [], status: { SuccessReceiptId: "" } } },
        receipts: tx.receipts.map((r, i) => ({ receipt_id: `${tx.hash}-${i}`, predecessor_id: r.predecessor ?? tx.signer, receipt: { Action: { actions: [] } } })),
        receipts_outcome: tx.receipts.map((r, i) => ({
          id: `${tx.hash}-${i}`,
          block_hash: "stand-in",
          outcome: { executor_id: r.executor, logs: r.logs, status: r.ok ? { SuccessValue: "" } : { Failure: {} } },
        })),
      },
    };
  }
  return { error: { name: "REQUEST_VALIDATION_ERROR", cause: { name: "METHOD_NOT_FOUND" } } };
}

function evmRpc(w: World, chainId: number, method: string, params: any[]): { result?: unknown; error?: unknown } {
  const chain = w.evm[chainId];
  if (!chain) return { error: { code: -32601, message: `no chain ${chainId}` } };
  switch (method) {
    case "eth_chainId":
      return { result: `0x${chainId.toString(16)}` };
    case "eth_getBalance":
      return { result: `0x${BigInt(chain.balances[String(params[0]).toLowerCase()] ?? "0").toString(16)}` };
    case "eth_getTransactionReceipt": {
      const r = chain.receipts[String(params[0]).toLowerCase()];
      return { result: r ? receiptJson(String(params[0]), r) : null };
    }
    case "eth_call":
      return ethCall(w, chainId, params[0]);
    case "eth_getCode":
      // The covered contracts the spec set up have code; anything else is an empty account.
      return { result: w.pausers?.[`${chainId}:${String(params[0]).toLowerCase()}`] ? "0x6080604052" : "0x" };
    case "near_getPublicKey":
      return { result: { public_key: w.posting?.relayerKeyHex } };
    case "eth_blockNumber":
      return { result: "0x1500000" };
    case "eth_sendRawTransaction": {
      const raw = String(params[0]);
      const hash = txHash(raw);
      (sent[chainId] ??= []).push(raw);
      // A sent pause lands at once when the spec says the chain takes it.
      const landing = chain.landOnSend?.[hash];
      if (landing) chain.receipts[hash] = landing;
      return { result: hash };
    }
    default:
      return { error: { code: -32601, message: `the method ${method} does not exist` } };
  }
}

function receiptJson(hash: string, r: { ok: boolean; block: number; to: string; nearTransactionHash?: string }) {
  return {
    status: r.ok ? "0x1" : "0x0",
    blockNumber: `0x${r.block.toString(16)}`,
    blockHash: `0x${"b".repeat(64)}`,
    transactionHash: hash,
    transactionIndex: "0x0",
    from: "0x0000000000000000000000000000000000000000",
    to: r.to,
    contractAddress: null,
    cumulativeGasUsed: "0x5208",
    gasUsed: "0x5208",
    effectiveGasPrice: "0x1",
    logs: [],
    logsBloom: `0x${"0".repeat(512)}`,
    type: "0x0",
    ...(r.nearTransactionHash ? { nearTransactionHash: r.nearTransactionHash } : {}),
  };
}

const PAUSE = "0x8456cb59";
const ACCESS_CONTROL = parseAbi(["function grantRole(bytes32 role, address account)", "function hasRole(bytes32 role, address account) view returns (bool)"]);
const PAUSER_ROLE = keccak256(toHex("PAUSER_ROLE"));
const NEAR_ACCOUNT = parseAbi([
  "function functionCall(string receiver_id, string method_name, bytes args, uint64 gas, uint32 yoctoNear) payable",
  "function addKey(uint8 public_key_kind, bytes public_key, uint64 nonce, bool is_full_access, bool is_limited_allowance, uint128 allowance, string receiver_id, string[] method_names) external",
]);
const revert = { error: { code: 3, message: "execution reverted" } };

/** `eth_call`: `pause()` succeeds only from a holder of the pause role; AccessControl contracts answer `hasRole`. */
function ethCall(w: World, chainId: number, call: { from?: string; to: string; data: string }) {
  const pausers = w.pausers?.[`${chainId}:${call.to.toLowerCase()}`];
  if (call.data === PAUSE) return pausers?.includes((call.from ?? "").toLowerCase()) ? { result: "0x" } : revert;
  if (pausers && call.data.startsWith("0x91d14854")) {
    const { args } = decodeFunctionData({ abi: ACCESS_CONTROL, data: call.data as `0x${string}` });
    return { result: encodeAbiParameters([{ type: "bool" }], [args[0] === PAUSER_ROLE && pausers.includes(String(args[1]).toLowerCase())]) };
  }
  return revert;
}

let sentCount = 0;

/**
 * A transaction the stand-in MetaMask sends: applied as the chain would. On Base and Arbitrum
 * One, a grant of PAUSER_ROLE or a plain transfer; on NEAR's Ethereum-compatible chain, the
 * relayer-key onboarding, the posting-fee prepayment and the USDC transfer-and-call that posts.
 */
function apply(w: World, tx: { chainId: number; from: string; to?: string; data?: string; value?: string }): string {
  const hash = `0x${(++sentCount).toString(16).padStart(64, "0")}`;
  const from = tx.from.toLowerCase();
  const value = BigInt(tx.value ?? "0x0");
  const chain = w.evm[tx.chainId]!;
  let ok = true;
  let nearTransactionHash: string | undefined;
  if (tx.chainId === 397) {
    nearTransactionHash = nearHash(`relayed${sentCount}`);
    const call = decodeFunctionData({ abi: NEAR_ACCOUNT, data: tx.data as `0x${string}` });
    const p = w.posting!;
    if (call.functionName === "addKey") {
      // An Ethereum-address NEAR account exists only once NEAR reaches it; before that, NEAR refuses its transactions.
      if (BigInt(w.accounts[from]?.amount ?? "0") === 0n) ok = false;
      else if (`0x${(call.args[1] as string).slice(2)}` === `0x${p.relayerKeyHex}`) p.onboarded.push(from);
    } else {
      const [receiver, method, argsHex, , yocto] = call.args as [string, string, `0x${string}`, bigint, number];
      const deposit = value * 10n ** 6n + BigInt(yocto);
      const args = JSON.parse(Buffer.from(argsHex.slice(2), "hex").toString("utf8"));
      const held = BigInt(w.accounts[from]?.amount ?? "0");
      if (!p.onboarded.includes(from) || held < deposit) ok = false;
      else if (receiver === w.contract && method === "prepay_posting_fee") {
        p.feeBalances[from] = String(BigInt(p.feeBalances[from] ?? "0") + deposit);
        w.accounts[from]!.amount = String(held - deposit);
      } else if (receiver === w.config.usdc && method === "ft_transfer_call" && args.receiver_id === w.contract) {
        const msg = JSON.parse(args.msg);
        const fee = BigInt(w.fees.posting_fee);
        const id = { protocol: from, name: msg.name };
        if (BigInt(p.usdc[from] ?? "0") < BigInt(args.amount) || BigInt(p.feeBalances[from] ?? "0") < fee || args.amount !== msg.rules.bounty_amount) ok = false;
        else {
          p.usdc[from] = String(BigInt(p.usdc[from]!) - BigInt(args.amount));
          p.feeBalances[from] = String(BigInt(p.feeBalances[from]!) - fee);
          w.bounties.push({ id, rules: msg.rules, state: "live", winning_claim: null, signed_pauses: [], signing_pauses: false, paying_out: false, payout_waits_until_ns: null, posting_fee_left: String(fee) });
          const ev = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "bountee", version: "1.0.0", event, data: [data] })}`;
          w.nearTxs.push({ hash: nearTransactionHash, signer: from, receipts: [{ executor: CONTRACT, logs: [ev("bounty_posted", { bounty: id, amount: args.amount }), ev("bounty_live", { bounty: id })], ok: true }] });
        }
      } else ok = false;
    }
  } else if (tx.data && tx.data !== "0x" && tx.to) {
    const key = `${tx.chainId}:${tx.to.toLowerCase()}`;
    const pausers = w.pausers?.[key];
    if (pausers && tx.data.startsWith("0x2f2ff15d")) {
      const { args } = decodeFunctionData({ abi: ACCESS_CONTROL, data: tx.data as `0x${string}` });
      if (args[0] === PAUSER_ROLE) pausers.push(String(args[1]).toLowerCase());
    } else ok = false;
  } else if (tx.to) {
    const to = tx.to.toLowerCase();
    chain.balances[to] = String(BigInt(chain.balances[to] ?? "0") + value);
  }
  chain.receipts[hash] = { ok, block: 22_000_001, to: tx.to ?? "", ...(nearTransactionHash ? { nearTransactionHash } : {}) };
  (sentTxs[tx.chainId] ??= []).push({ ...tx, hash });
  return hash;
}
/** Every transaction the stand-in MetaMask sent, by chain. */
let sentTxs: Record<number, unknown[]> = {};

/** FastNEAR's explorer API, the two calls the app makes. */
function txApi(w: World, path: string, req: any): unknown {
  if (path === "/v0/account") {
    const txs = req.account_id === w.contract ? w.nearTxs : [];
    return { account_txs: [...txs].reverse().map((t) => ({ transaction_hash: t.hash, signer_id: t.signer })) };
  }
  if (path === "/v0/transactions") {
    const wanted = new Set<string>(req.tx_hashes ?? []);
    return {
      transactions: w.nearTxs
        .filter((t) => wanted.has(t.hash))
        .map((t) => ({
          transaction: { hash: t.hash, signer_id: t.signer },
          receipts: t.receipts.map((r) => ({ execution_outcome: { outcome: { executor_id: r.executor, logs: r.logs, status: r.ok ? { SuccessValue: "" } : { Failure: {} } } } })),
        })),
    };
  }
  return null;
}

const port = Number(process.env.STAND_IN_PORT ?? 3199);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://stand-in");
    // The app's server reads here, and so does the browser (Send pause), from another origin.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") return json(res, 204, null);
    if (url.pathname === "/world" && req.method === "PUT") {
      world = await body(req);
      sent = {};
      sentTxs = {};
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/sent") return json(res, 200, sent);
    if (url.pathname === "/world" && req.method === "GET") return json(res, 200, world);
    if (url.pathname === "/wallet-sent") return json(res, 200, sentTxs);
    if (url.pathname === "/fund" && req.method === "POST") {
      // NEAR arriving at an account from outside the app (D17).
      if (!world) return json(res, 503, { error: "no world set" });
      const { account, yocto } = await body(req);
      const prev = BigInt(world.accounts[account]?.amount ?? "0");
      world.accounts[account] = { amount: String(prev + BigInt(yocto)), code_hash: "11111111111111111111111111111111" };
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/apply" && req.method === "POST") {
      if (!world) return json(res, 503, { error: "no world set" });
      return json(res, 200, { hash: apply(world, await body(req)) });
    }
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (!world) return json(res, 503, { error: "no world set" });
    const b = await body(req);
    if (url.pathname === "/near") return json(res, 200, { jsonrpc: "2.0", id: b.id, ...nearRpc(world, b.method, b.params) });
    const evm = /^\/evm\/(\d+)$/.exec(url.pathname);
    if (evm) return json(res, 200, { jsonrpc: "2.0", id: b.id, ...evmRpc(world, Number(evm[1]), b.method, b.params ?? []) });
    if (url.pathname.startsWith("/txapi/")) return json(res, 200, txApi(world, url.pathname.slice("/txapi".length), b));
    const attestation = /^\/outlayer\/attestations\/by-tx\/(.+)$/.exec(url.pathname);
    if (attestation) {
      const a = world.attestations?.[attestation[1]!];
      return a ? json(res, 200, a) : json(res, 404, { error: "not found" });
    }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: (e as Error).message });
  }
}).listen(port, () => console.log(`chain stand-in on ${port}`));
