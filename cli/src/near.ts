// NEAR plumbing shared by the commands: RPCs, local keys (kept the way near-cli keeps them,
// ~/.near-credentials/<network>/<account>.json, or BOUNTEE_CREDENTIALS_DIR), views and the
// full outcome of a transaction once every receipt has run.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";

/** FastNEAR: rpc.testnet.near.org now answers 429 "deprecated" (Nov 4). */
export const NEAR_RPC = { testnet: "https://test.rpc.fastnear.com", mainnet: "https://free.rpc.fastnear.com" } as const;
export type Network = keyof typeof NEAR_RPC;
/** A NEAR transaction's page on the explorer, for receipts' links. */
export const NEAR_EXPLORER_TX = { testnet: "https://testnet.nearblocks.io/txns/", mainnet: "https://nearblocks.io/txns/" } as const;

export function parseNetwork(value: string | undefined): Network {
  const n = value ?? "testnet";
  if (n !== "testnet" && n !== "mainnet") throw new Error("--network is testnet or mainnet");
  return n;
}

export function credentialsDir(network: Network): string {
  return process.env.BOUNTEE_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials", network);
}

export function saveKey(network: Network, accountId: string, key: KeyPair): string {
  const dir = credentialsDir(network);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${accountId}.json`);
  if (existsSync(file)) throw new Error(`${file} already exists`);
  const body = { account_id: accountId, public_key: key.getPublicKey().toString(), private_key: key.toString() };
  writeFileSync(file, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function loadKey(network: Network, accountId: string): KeyPairString {
  const dir = credentialsDir(network);
  const file = JSON.parse(readFileSync(join(dir, `${accountId}.json`), "utf8"));
  const key = file.private_key ?? file.secret_key;
  if (typeof key !== "string") throw new Error(`no key for ${accountId} in ${dir}`);
  return key as KeyPairString;
}

export class Near {
  readonly network: Network;
  readonly url: string;
  readonly provider: JsonRpcProvider;
  constructor(network: Network, url: string = NEAR_RPC[network]) {
    this.network = network;
    this.url = url;
    this.provider = new JsonRpcProvider({ url });
  }

  account(id: string): Account {
    return new Account(id, this.provider, loadKey(this.network, id));
  }

  async rpc<T = any>(method: string, params: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (res.status === 429 && attempt < 6) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        continue;
      }
      const body = (await res.json()) as { result?: T; error?: unknown };
      if (body.error) throw new Error(JSON.stringify(body.error));
      return body.result as T;
    }
  }

  async view<T = any>(contract: string, method: string, args: unknown = {}): Promise<T> {
    const r = await this.rpc<{ result: number[] }>("query", {
      request_type: "call_function",
      finality: "optimistic",
      account_id: contract,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
    });
    return JSON.parse(Buffer.from(r.result).toString("utf8"));
  }

  /** The account's NEAR balance in yoctoNEAR, or null if it doesn't exist. */
  async balance(accountId: string): Promise<bigint | null> {
    try {
      const a = await this.rpc<{ amount: string }>("query", { request_type: "view_account", finality: "final", account_id: accountId });
      return BigInt(a.amount);
    } catch (e) {
      if (/UNKNOWN_ACCOUNT|does not exist/.test((e as Error).message)) return null;
      throw e;
    }
  }

  /** A transaction's whole outcome, every receipt included, once all have executed. */
  async txStatus(hash: string, sender: string, timeoutSecs = 180): Promise<any> {
    const until = Date.now() + timeoutSecs * 1000;
    for (;;) {
      try {
        const r = await this.rpc<any>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: sender, wait_until: "FINAL" });
        if (!r.receipts_outcome.some((o: any) => o.outcome.status === "Unknown")) return r;
      } catch {
        // not known yet
      }
      if (Date.now() > until) throw new Error(`transaction ${hash} never finished`);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

/** NEP-297 events (`EVENT_JSON:`) a transaction's receipts logged, in order. */
export function events(status: any): { event: string; data: any }[] {
  const out: { event: string; data: any }[] = [];
  for (const r of status.receipts_outcome ?? []) {
    for (const log of r.outcome.logs as string[]) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(log.slice("EVENT_JSON:".length));
        out.push({ event: e.event, data: Array.isArray(e.data) ? e.data[0] : e.data });
      } catch {
        // not ours
      }
    }
  }
  return out;
}

export const tgas = (n: number) => BigInt(n) * 10n ** 12n;
export const milliNear = (n: number) => BigInt(Math.round(n * 1000)) * 10n ** 18n;
export const formatNear = (yocto: bigint) => {
  const s = yocto.toString().padStart(25, "0");
  return `${s.slice(0, -24)}.${s.slice(-24, -19)}`.replace(/\.?0+$/, "") || "0";
};
