// `bountee key add` and `bountee key revoke` (#25): a claim key for a Whitehat's AI agent.
//
// A claim key is a NEAR function-call key on the Whitehat's own account (ADR-0007), so every
// claim it files comes from that account and any payout lands there (R14.2). NEAR itself
// limits it (R14.1, R14.3): it can only call the bounty contract, only the methods below, and
// only with nothing attached, so it can't transfer NEAR, top up or withdraw the claim balance
// (`withdraw_claim_balance` asks exactly 1 yoctoNEAR), add or delete keys, or call any other
// contract; its gas comes from the account, up to its allowance.
//
//   bountee key add --contract <bounty contract> --as <account> [--allowance <NEAR>] [--out-dir <dir>]
//   bountee key revoke [<public key>] --as <account> [--out-dir <dir>]
//
// `add` signs with the account's own key (~/.near-credentials, or BOUNTEE_CREDENTIALS_DIR),
// writes the new key to <out-dir>/<account>.json (default ~/.bountee/claim-keys/<network>/,
// outside any checkout), and shows what the key can and can't do as the chain records it.
// The agent runs the usual commands with BOUNTEE_CREDENTIALS_DIR=<out-dir>. `revoke` deletes
// the key (that file's, or the one named) from the account, refusing a full-access key, and
// removes the file.
import { existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { actions, KeyPair, PublicKey } from "near-api-js";
import { formatNear, loadKey, Near, saveKey } from "./near.ts";

/**
 * The claim actions: `submit_claim`, `retry_claim` (a claim with no verdict), and the steps
 * `bountee claim` takes after a PAYS that anyone may take (`sign_pauses`, `retry_payout`,
 * `verify_pause` on its prepaid attempts). None moves the Whitehat's money anywhere but to
 * the Whitehat.
 */
export const CLAIM_KEY_METHODS = ["submit_claim", "retry_claim", "sign_pauses", "retry_payout", "verify_pause"];
/** The gas a new claim key may spend, by default: about 30 claims' worth at 300 Tgas each. */
export const DEFAULT_ALLOWANCE_NEAR = "1";

export function claimKeysDir(network: string): string {
  return join(homedir(), ".bountee", "claim-keys", network);
}

interface Permission {
  receiver_id: string;
  method_names: string[];
  allowance: string | null;
}

export interface KeyAddResult {
  account: string;
  network: string;
  public_key: string;
  key_file: string;
  /** Give this folder to the agent: `BOUNTEE_CREDENTIALS_DIR=<it> bountee claim ... --as <account>`. */
  credentials_dir: string;
  tx_hash: string;
  /** The key's permission as the chain records it. */
  permission: Permission;
  can: string[];
  cannot: string[];
}

export interface KeyRevokeResult {
  account: string;
  network: string;
  public_key: string;
  tx_hash: string;
  key_file_removed: string | null;
}

function parseNear(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,24}))?$/.exec(text);
  if (!m) throw new Error(`--allowance is an amount of NEAR, e.g. 1 or 0.5: got ${text}`);
  return BigInt(m[1]!) * 10n ** 24n + BigInt((m[2] ?? "").padEnd(24, "0") || "0");
}

async function permissionOf(near: Near, account: string, publicKey: string): Promise<"FullAccess" | { FunctionCall: Permission }> {
  const r = await near.rpc<any>("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey });
  return r.permission;
}

/** What the key can and can't do, in words, from its permission on chain. */
export function describe(p: Permission): { can: string[]; cannot: string[] } {
  return {
    can: [
      `call ${p.receiver_id}, and only these methods: ${p.method_names.join(", ")}`,
      "file claims from your account, which are judged like any other and paid to your account",
      "draw this account's claim balance, as each claim does, to pay for its judging",
      `spend ${p.allowance === null ? "unlimited" : `up to ${formatNear(BigInt(p.allowance))} NEAR of`} this account's NEAR on gas fees`,
    ],
    cannot: [
      "transfer NEAR or tokens from your account",
      "attach a deposit to any call, so it can't top up or withdraw the claim balance",
      "withdraw the claim balance (that takes 1 yoctoNEAR, which only your own key can attach)",
      "add, delete or change keys, deploy code, or delete the account",
      `call any other contract, or any other method of ${p.receiver_id}`,
    ],
  };
}

export async function keyAdd(o: { near: Near; contract: string; account: string; allowance?: string; outDir?: string }): Promise<KeyAddResult> {
  const dir = o.outDir ?? claimKeysDir(o.near.network);
  const file = join(dir, `${o.account}.json`);
  if (existsSync(file)) throw new Error(`${file} already holds a claim key: revoke it first (bountee key revoke --as ${o.account})`);
  if ((await o.near.balance(o.contract)) === null) throw new Error(`no account ${o.contract} on ${o.near.network}`);
  const allowance = parseNear(o.allowance ?? DEFAULT_ALLOWANCE_NEAR);
  if (allowance === 0n) throw new Error("--allowance must be more than 0 (0 would mean unlimited)");
  const key = KeyPair.fromRandom("ed25519");
  const publicKey = key.getPublicKey();
  // Saved before it is added, so a crash never leaves a key on the account nobody holds.
  saveKey(o.near.network, o.account, key, dir);
  let txHash: string;
  try {
    const r = await o.near.account(o.account).signAndSendTransaction({
      receiverId: o.account,
      actions: [actions.addFunctionCallAccessKey(publicKey, o.contract, CLAIM_KEY_METHODS, allowance)],
      waitUntil: "FINAL",
    });
    txHash = r.transaction.hash;
  } catch (e) {
    rmSync(file, { force: true });
    throw e;
  }
  // Shown as the chain records it, not as asked.
  const permission = await permissionOf(o.near, o.account, publicKey.toString());
  if (permission === "FullAccess") throw new Error(`${publicKey} is a full-access key on ${o.account}`);
  const p = permission.FunctionCall;
  return { account: o.account, network: o.near.network, public_key: publicKey.toString(), key_file: file, credentials_dir: dir, tx_hash: txHash, permission: p, ...describe(p) };
}

export async function keyRevoke(o: { near: Near; account: string; publicKey?: string; outDir?: string }): Promise<KeyRevokeResult> {
  const dir = o.outDir ?? claimKeysDir(o.near.network);
  const file = join(dir, `${o.account}.json`);
  if (o.publicKey === undefined && !existsSync(file)) throw new Error(`no claim key for ${o.account} in ${dir}: name the public key to revoke`);
  const fileKey = existsSync(file) ? KeyPair.fromString(loadKey(o.near.network, o.account, dir)).getPublicKey().toString() : null;
  const publicKey = o.publicKey ?? fileKey!;
  let permission;
  try {
    permission = await permissionOf(o.near, o.account, publicKey);
  } catch (e) {
    throw new Error(`${o.account} holds no key ${publicKey}: ${(e as Error).message}`);
  }
  // Never the account's own key: only a function-call key is a claim key.
  if (permission === "FullAccess") throw new Error(`${publicKey} is a full-access key on ${o.account}, not a claim key: not revoked`);
  const r = await o.near.account(o.account).signAndSendTransaction({
    receiverId: o.account,
    actions: [actions.deleteKey(PublicKey.fromString(publicKey))],
    waitUntil: "FINAL",
  });
  // The local copy of a revoked key is dead: removed, so `key add` can write a new one.
  let removed: string | null = null;
  if (fileKey === publicKey) {
    rmSync(file);
    removed = file;
  }
  return { account: o.account, network: o.near.network, public_key: publicKey, tx_hash: r.transaction.hash, key_file_removed: removed };
}

export function formatKeyAdd(r: KeyAddResult): string {
  return [
    `claim key ${r.public_key} added to ${r.account} (${r.tx_hash})`,
    `saved to ${r.key_file}`,
    "It can:",
    ...r.can.map((c) => `  - ${c}`),
    "It can't:",
    ...r.cannot.map((c) => `  - ${c}`),
    `Give your agent: BOUNTEE_CREDENTIALS_DIR=${r.credentials_dir} bountee claim ... --as ${r.account}`,
    `Revoke it: bountee key revoke --as ${r.account}${r.credentials_dir === claimKeysDir(r.network) ? "" : ` --out-dir ${r.credentials_dir}`}`,
  ].join("\n");
}

export function formatKeyRevoke(r: KeyRevokeResult): string {
  return `claim key ${r.public_key} revoked from ${r.account} (${r.tx_hash})${r.key_file_removed ? `; removed ${r.key_file_removed}` : ""}`;
}
