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
import { hashOfRaw as txHash, type World } from "./world.ts";

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
      return w.pauseRoles[bountyKey(args.id)] ?? { path: bountyKey(args.id), address: "0x0000000000000000000000000000000000000000" };
    case "pause_verifications":
      return w.verifications[bountyKey(args.id)] ?? [];
    case "published_exploit":
      return w.publications[bountyKey(args.id)] ?? null;
    case "released_exploit":
      return w.releases[bountyKey(args.id)] ?? null;
    case "ft_metadata":
      return { spec: "ft-1.0.0", name: "USDC", symbol: "USDC", decimals: 6 };
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
      if (account !== w.contract && !(account === w.config.usdc && params.method_name === "ft_metadata")) {
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
        transaction: { hash: tx.hash, signer_id: tx.signer, receiver_id: w.contract, actions: [] },
        receipts: [],
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
      return { result: r ? { status: r.ok ? "0x1" : "0x0", blockNumber: `0x${r.block.toString(16)}`, to: r.to, transactionHash: params[0] } : null };
    }
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
      return json(res, 200, { ok: true });
    }
    if (url.pathname === "/sent") return json(res, 200, sent);
    if (url.pathname === "/health") return json(res, 200, { ok: true });
    if (!world) return json(res, 503, { error: "no world set" });
    const b = await body(req);
    if (url.pathname === "/near") return json(res, 200, { jsonrpc: "2.0", id: b.id, ...nearRpc(world, b.method, b.params) });
    const evm = /^\/evm\/(\d+)$/.exec(url.pathname);
    if (evm) return json(res, 200, { jsonrpc: "2.0", id: b.id, ...evmRpc(world, Number(evm[1]), b.method, b.params ?? []) });
    if (url.pathname.startsWith("/txapi/")) return json(res, 200, txApi(world, url.pathname.slice("/txapi".length), b));
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: (e as Error).message });
  }
}).listen(port, () => console.log(`chain stand-in on ${port}`));
