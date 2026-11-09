// NEAR plumbing shared by the commands: RPCs, local keys (kept the way near-cli keeps them,
// ~/.near-credentials/<network>/<account>.json, or BOUNTEE_CREDENTIALS_DIR), views and the
// full outcome of a transaction once every receipt has run.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, JsonRpcProvider, KeyPair, type KeyPairString } from "near-api-js";
import { ARCHIVAL_RPC, NEAR_RPC, type Network } from "./endpoints.ts";
import { postJson } from "./proofs.ts";

export function parseNetwork(value: string | undefined): Network {
  const n = value ?? "testnet";
  if (n !== "testnet" && n !== "mainnet") throw new Error("--network is testnet or mainnet");
  return n;
}

export function credentialsDir(network: Network): string {
  return process.env.BOUNTEE_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials", network);
}

export function saveKey(network: Network, accountId: string, key: KeyPair, dir: string = credentialsDir(network)): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${accountId}.json`);
  if (existsSync(file)) throw new Error(`${file} already exists`);
  const body = { account_id: accountId, public_key: key.getPublicKey().toString(), private_key: key.toString() };
  writeFileSync(file, `${JSON.stringify(body)}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

export function loadKey(network: Network, accountId: string, dir: string = credentialsDir(network)): KeyPairString {
  const file = JSON.parse(readFileSync(join(dir, `${accountId}.json`), "utf8"));
  const key = file.private_key ?? file.secret_key;
  if (typeof key !== "string") throw new Error(`no key for ${accountId} in ${dir}`);
  return key as KeyPairString;
}

/** A function call a pre-spend check prices: its method, attached gas, deposit and argument bytes. */
export interface PricedCall {
  method: string;
  gas: bigint;
  deposit: bigint;
  argsBytes: number;
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

  /** Whether the local key for `id` is a function-call key (a claim key, #25) rather than a full-access one. */
  async signsWithFunctionCallKey(id: string): Promise<boolean> {
    const publicKey = KeyPair.fromString(loadKey(this.network, id)).getPublicKey().toString();
    const r = await this.rpc<{ permission: unknown }>("query", { request_type: "view_access_key", finality: "final", account_id: id, public_key: publicKey });
    return r.permission !== "FullAccess";
  }

  /**
   * Whether the local key for `id` may call `method` on `contract` with nothing attached: a
   * full-access key may; a function-call key (a claim key, #25) only within its receiver and methods.
   */
  async canCall(id: string, contract: string, method: string): Promise<boolean> {
    const publicKey = KeyPair.fromString(loadKey(this.network, id)).getPublicKey().toString();
    const r = await this.rpc<{ permission: "FullAccess" | { FunctionCall: { receiver_id: string; method_names: string[] } } }>("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: id,
      public_key: publicKey,
    });
    if (r.permission === "FullAccess") return true;
    const p = r.permission.FunctionCall;
    return p.receiver_id === contract && (p.method_names.length === 0 || p.method_names.includes(method));
  }

  /**
   * This RPC, then the network's archival RPC when this is the network's default one (an
   * RPC given with `--near-rpc` must keep what is asked of it).
   */
  withArchive(): Near[] {
    return this.url === NEAR_RPC[this.network] ? [this, new Near(this.network, ARCHIVAL_RPC[this.network])] : [this];
  }

  async rpc<T = any>(method: string, params: unknown): Promise<T> {
    const body = await postJson<{ result?: T; error?: unknown }>(this.url, { jsonrpc: "2.0", id: 1, method, params }, { tries: 7, backoffMs: 1000 });
    if (body.error) throw new Error(JSON.stringify(body.error));
    return body.result as T;
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

  /** The NEAR an account can spend: its balance less the stake its stored bytes lock; null if it doesn't exist. */
  async freeNear(accountId: string): Promise<bigint | null> {
    let a: { amount: string; locked: string; storage_usage: number };
    try {
      a = await this.rpc("query", { request_type: "view_account", finality: "final", account_id: accountId });
    } catch (e) {
      if (/UNKNOWN_ACCOUNT|does not exist/.test((e as Error).message)) return null;
      throw e;
    }
    const { storage_amount_per_byte } = (await this.rpc<any>("EXPERIMENTAL_protocol_config", { finality: "final" })).runtime_config;
    const stake = BigInt(a.storage_usage) * BigInt(storage_amount_per_byte) - BigInt(a.locked);
    return BigInt(a.amount) - (stake > 0n ? stake : 0n);
  }

  /**
   * The NEAR a signer must hold to send these function calls, each as its own transaction to
   * another account (NEAR docs, protocol/transactions/gas). Turning a transaction into its receipt
   * burns the send costs at the gas price; the receipt's execution costs and its attached gas are
   * bought up front at max(gas price, min_gas_purchase_price), and what's unused comes back only
   * afterwards. That minimum is 1e9 yoctoNEAR on mainnet and testnet while `gas_price` reports 1e8,
   * so 270 Tgas wants 0.27 NEAR in hand: Nov 7's mainnet post failed holding 0.0903 for 0.2709.
   * Summing the calls counts no refund between them, so a run of calls is never short.
   */
  async upfrontNear(calls: PricedCall[]): Promise<bigint> {
    const [{ runtime_config: rc }, { gas_price }] = await Promise.all([
      this.rpc<any>("EXPERIMENTAL_protocol_config", { finality: "final" }),
      this.rpc<{ gas_price: string }>("gas_price", [null]),
    ]);
    const price = BigInt(gas_price);
    const minimum = BigInt(rc.min_gas_purchase_price);
    const buy = price > minimum ? price : minimum;
    const receipt = rc.transaction_costs.action_receipt_creation_config;
    const call = rc.transaction_costs.action_creation_config.function_call_cost;
    const perByte = rc.transaction_costs.action_creation_config.function_call_cost_per_byte;
    let total = 0n;
    for (const c of calls) {
      const bytes = BigInt(c.method.length + c.argsBytes);
      const send = BigInt(receipt.send_not_sir) + BigInt(call.send_not_sir) + BigInt(perByte.send_not_sir) * bytes;
      const execution = BigInt(receipt.execution) + BigInt(call.execution) + BigInt(perByte.execution) * bytes;
      total += c.deposit + send * price + (execution + c.gas) * buy;
    }
    return total;
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
