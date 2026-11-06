// NEAR RPC, the reads the web app makes: contract views, contract storage by prefix,
// accounts, and a transaction's outcome (from the archival RPC once an ordinary one has
// dropped it).
import type { Config } from "./config.ts";

async function post<T>(url: string, body: unknown, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
      if (res.status === 429 || res.status >= 500) throw new Error(`${url} answered ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
      await new Promise((ok) => setTimeout(ok, 400 * (i + 1)));
    }
  }
  throw last;
}

export class NearError extends Error {}

export async function rpc<T>(url: string, method: string, params: unknown): Promise<T> {
  const r = await post<{ result?: T; error?: unknown }>(url, { jsonrpc: "2.0", id: 1, method, params });
  if (r.error !== undefined) throw new NearError(JSON.stringify(r.error));
  return r.result as T;
}

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

export async function view<T>(c: Config, account: string, method: string, args: unknown = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>(c.nearRpc, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: account,
    method_name: method,
    args_base64: b64(JSON.stringify(args)),
  });
  return JSON.parse(Buffer.from(r.result).toString("utf8")) as T;
}

/** The contract's storage entries under a one-byte prefix (a `Key` of contract/src/lib.rs). */
export async function viewState(c: Config, prefix: number): Promise<{ key: Buffer; value: Buffer }[]> {
  const r = await rpc<{ values: { key: string; value: string }[] }>(c.nearRpc, "query", {
    request_type: "view_state",
    finality: "final",
    account_id: c.contract,
    prefix_base64: Buffer.from([prefix]).toString("base64"),
  });
  return r.values.map((v) => ({ key: Buffer.from(v.key, "base64"), value: Buffer.from(v.value, "base64") }));
}

export interface NearReceipt {
  executor_id: string;
  logs: string[];
  ok: boolean;
}

/** A transaction's receipts as NEAR RPC has them, or null if neither RPC knows it. */
export async function txReceipts(c: Config, hash: string, signer: string): Promise<NearReceipt[] | null> {
  for (const url of [c.nearRpc, c.nearArchivalRpc]) {
    const r = await rpc<{ transaction: { hash: string }; receipts_outcome: { outcome: { executor_id: string; logs: string[]; status: object } }[] }>(
      url,
      "EXPERIMENTAL_tx_status",
      { tx_hash: hash, sender_account_id: signer, wait_until: "NONE" },
    ).catch(() => null);
    if (r?.transaction?.hash !== hash) continue;
    return r.receipts_outcome.map((o) => ({
      executor_id: o.outcome.executor_id,
      logs: o.outcome.logs,
      ok: "SuccessValue" in o.outcome.status || "SuccessReceiptId" in o.outcome.status,
    }));
  }
  return null;
}

/** Borsh: a u32 little-endian length, then that many UTF-8 bytes; returns the string and where it ends. */
export function borshString(b: Buffer, at: number): [string, number] {
  const n = b.readUInt32LE(at);
  return [b.subarray(at + 4, at + 4 + n).toString("utf8"), at + 4 + n];
}
