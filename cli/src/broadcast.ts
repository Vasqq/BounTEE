// `bountee broadcast <protocol>/<name>` (ticket #13): send every signed pause the bounty
// contract stored for a bounty to its chain, all together (R7.3), and optionally wait for
// each to land. Anyone may run it: a signed pause needs no wallet, only an RPC.
//
// A pause someone else already sent is reported as `known`, not as an error, so running it
// twice is harmless. Verification on NEAR (R7.3's second half) is ticket #21.
import { defaultRpcs } from "./chains.ts";
import { NEAR_RPC } from "./near.ts";
import { rpc } from "./proofs.ts";

export interface BroadcastOptions {
  bounty: string;
  contract?: string;
  nearRpc?: string;
  /** Chain ID → RPC URL, over the defaults. */
  rpcs?: Record<number, string>;
  /** Wait for each pause's receipt, up to this many seconds. */
  waitSecs?: number;
}

interface SignedPause {
  chain_id: number;
  contract: string;
  nonce: number;
  tx: string;
  tx_hash: string;
}

export interface PauseResult {
  chain_id: number;
  contract: string;
  tx_hash: string;
  /** `sent` now, `known` (already in the pool or on chain), or `failed` to send. */
  sent: "sent" | "known" | "failed";
  error?: string;
  /** With `--wait`: whether the pause transaction succeeded, and its block. */
  receipt?: { status: "success" | "reverted"; block: number } | null;
}

export interface BroadcastResult {
  bounty: { protocol: string; name: string };
  contract: string;
  state: string;
  pauses: PauseResult[];
}

export function parseRpcFlags(values: string[]): Record<number, string> {
  const out: Record<number, string> = {};
  for (const v of values) {
    const m = /^(\d+)=(.+)$/.exec(v);
    if (!m) throw new Error(`--rpc: ${v} is not <chain id>=<url>`);
    out[Number(m[1])] = m[2]!;
  }
  return out;
}

async function viewBounty(nearRpc: string, contract: string, protocol: string, name: string) {
  const args = Buffer.from(JSON.stringify({ id: { protocol, name } })).toString("base64");
  const res = await rpc<{ result: number[] }>(nearRpc, "query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: "bounty",
    args_base64: args,
  });
  return JSON.parse(Buffer.from(res.result).toString("utf8")) as
    | { state: string; signed_pauses: SignedPause[] }
    | null;
}

/** Errors meaning the same transaction is already pending or mined. */
const ALREADY = /already known|known transaction|nonce too low|already imported|AlreadyKnown/i;

async function send(url: string, p: SignedPause): Promise<PauseResult> {
  const base = { chain_id: p.chain_id, contract: p.contract, tx_hash: p.tx_hash };
  try {
    const hash = await rpc<string>(url, "eth_sendRawTransaction", [p.tx]);
    if (hash.toLowerCase() !== p.tx_hash) throw new Error(`the chain hashed it as ${hash}`);
    return { ...base, sent: "sent" };
  } catch (e) {
    const message = (e as Error).message;
    if (ALREADY.test(message)) return { ...base, sent: "known" };
    return { ...base, sent: "failed", error: message };
  }
}

async function waitForReceipt(url: string, hash: string, secs: number) {
  const until = Date.now() + secs * 1000;
  for (;;) {
    const r = await rpc<{ status: string; blockNumber: string } | null>(url, "eth_getTransactionReceipt", [hash]).catch(() => null);
    if (r) return { status: r.status === "0x1" ? ("success" as const) : ("reverted" as const), block: Number(r.blockNumber) };
    if (Date.now() > until) return null;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
}

export async function broadcastCommand(o: BroadcastOptions): Promise<BroadcastResult> {
  const m = /^([a-z0-9._-]+)\/([a-z0-9-]+)$/.exec(o.bounty);
  if (!m) throw new Error(`${o.bounty} is not a bounty id <protocol>/<name>`);
  const [protocol, name] = [m[1]!, m[2]!];
  const contract = o.contract ?? process.env.BOUNTEE_CONTRACT;
  if (!contract) throw new Error("broadcast needs the bounty contract's account: pass --contract or set BOUNTEE_CONTRACT");
  const nearRpc = o.nearRpc ?? NEAR_RPC.testnet;
  const bounty = await viewBounty(nearRpc, contract, protocol, name);
  if (!bounty) throw new Error(`no bounty ${o.bounty} on ${contract}`);
  if (bounty.signed_pauses.length === 0) throw new Error(`bounty ${o.bounty} has no signed pauses (state: ${bounty.state})`);

  // Each chain's default public RPC (chains.ts), unless `--rpc <chain id>=<url>` names another.
  const rpcs = { ...defaultRpcs(), ...o.rpcs };
  const urlFor = (chain: number) => {
    const url = rpcs[chain];
    if (!url) throw new Error(`no RPC for chain ${chain}: pass --rpc ${chain}=<url>`);
    return url;
  };
  // Per chain, in nonce order; every chain at once.
  const chains = [...new Set(bounty.signed_pauses.map((p) => p.chain_id))];
  const byChain = await Promise.all(
    chains.map(async (chain) => {
      const url = urlFor(chain);
      const pauses = bounty.signed_pauses.filter((p) => p.chain_id === chain).sort((a, b) => a.nonce - b.nonce);
      const results: PauseResult[] = [];
      for (const p of pauses) results.push(await send(url, p));
      if (o.waitSecs !== undefined) {
        for (const r of results) if (r.sent !== "failed") r.receipt = await waitForReceipt(url, r.tx_hash, o.waitSecs);
      }
      return results;
    }),
  );
  const results = byChain.flat();
  const order = (r: PauseResult) => bounty.signed_pauses.findIndex((p) => p.tx_hash === r.tx_hash);
  results.sort((a, b) => order(a) - order(b));
  return { bounty: { protocol, name }, contract, state: bounty.state, pauses: results };
}

export function formatBroadcastResult(r: BroadcastResult): string {
  const lines = [`bounty ${r.bounty.protocol}/${r.bounty.name} on ${r.contract} (${r.state})`];
  for (const p of r.pauses) {
    const landed = p.receipt === undefined ? "" : p.receipt === null ? ", not landed yet" : `, ${p.receipt.status} in block ${p.receipt.block}`;
    lines.push(`  chain ${p.chain_id} ${p.contract}: pause ${p.tx_hash} ${p.sent}${p.error ? ` (${p.error})` : ""}${landed}`);
  }
  return lines.join("\n");
}
