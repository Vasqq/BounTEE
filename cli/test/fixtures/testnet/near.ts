// Testnet helpers for the T tests' scripts: accounts from ~/.near-credentials/testnet, plain
// RPC reads, and transactions whose full outcome (every receipt) is kept as evidence.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, type KeyPairString } from "near-api-js";

export const RPC = process.env.NEAR_TESTNET_RPC ?? "https://rpc.testnet.near.org";
export const provider = new JsonRpcProvider({ url: RPC });

export function account(id: string): Account {
  const file = JSON.parse(readFileSync(join(homedir(), ".near-credentials", "testnet", `${id}.json`), "utf8"));
  return new Account(id, provider, (file.private_key ?? file.secret_key) as KeyPairString);
}

export async function rpc<T = any>(method: string, params: unknown): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result as T;
}

export async function view<T = any>(contract: string, method: string, args: unknown = {}): Promise<T> {
  const r = await rpc<{ result: number[] }>("query", {
    request_type: "call_function",
    finality: "optimistic",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
}

/** A transaction's whole outcome, every receipt included, once all have executed. */
export async function txStatus(hash: string, sender: string): Promise<any> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await rpc<any>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
      const pending = r.receipts_outcome.some((o: any) => o.outcome.status === "Unknown");
      if (!pending) return r;
    } catch {
      // not known yet
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`transaction ${hash} never finished`);
}

/** The final value a transaction returned, or its failure, as text. */
export function finalValue(status: any): { ok: boolean; text: string } {
  const s = status.status;
  if (s.SuccessValue !== undefined) return { ok: true, text: Buffer.from(s.SuccessValue, "base64").toString("utf8") };
  return { ok: false, text: JSON.stringify(s.Failure ?? s) };
}
