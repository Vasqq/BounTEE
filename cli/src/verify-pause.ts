// `bountee verify-pause <protocol>/<name>` (#21): have the bounty contract record each chain's
// pause as verified by NEAR's MPC network (R7.3, R7.10). `claim` runs the same steps right after
// it broadcasts.
//
// The MPC network answers only for a transaction that succeeded in a block the chain reports
// safe; anything else (reverted, unknown, not yet safe) times out after about two minutes and
// uses one of the chain's three prepaid attempts. So, per chain, the tool first waits for every
// pause's receipt, refuses to ask about a reverted one, then waits until the chain's `safe` head
// has passed the pauses' blocks (11-27 minutes on Base Sepolia), and only then calls
// `verify_pause`. The contract takes the transaction hashes from the pauses it stored; the tool
// never sends one. Once the prepaid attempts are used, it attaches the fee `fees()` names.
import { actions } from "near-api-js";
import { defaultRpcs, waitForEvmReceipt } from "./chains.ts";
import { Near, events, tgas } from "./near.ts";
import { rpc } from "./proofs.ts";

export interface VerifyOptions {
  near: Near;
  contract: string;
  bounty: { protocol: string; name: string };
  /** The NEAR account that signs `verify_pause` (anyone may). */
  signer: string;
  /** Chain ID -> RPC URL, over the defaults. */
  rpcs?: Record<number, string>;
  /** Only these chains; default every chain with a signed pause. */
  chains?: number[];
  /** How long to wait, per chain, for the pauses to land and reach the safe head. */
  waitSecs?: number;
}

export interface ChainVerification {
  chain_id: number;
  tx_hashes: string[];
  /** The highest block the chain's pauses landed in. */
  landed_block?: number;
  /** The chain's safe head when the request was made. */
  safe_block?: number;
  /** Seconds spent waiting for the safe head. */
  waited_secs?: number;
  /** Whether this run asked the contract to verify (false if already verified, or not ready). */
  requested: boolean;
  near_tx?: string;
  verified: boolean;
  attempts: number;
  error?: string;
}

export interface VerifyResult {
  bounty: { protocol: string; name: string };
  contract: string;
  chains: ChainVerification[];
}

interface ViewVerification {
  chain_id: number;
  verified: boolean;
  verified_pauses: string[];
  attempts: number;
  prepaid_attempts_left: number;
  verifying: boolean;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function chainView(near: Near, o: VerifyOptions, chain: number): Promise<ViewVerification> {
  const all = await near.view<ViewVerification[]>(o.contract, "pause_verifications", { id: o.bounty });
  const v = all.find((c) => c.chain_id === chain);
  if (!v) throw new Error(`bounty has no signed pause on chain ${chain}`);
  return v;
}

async function safeHead(url: string): Promise<number> {
  const b = await rpc<{ number: string }>(url, "eth_getBlockByNumber", ["safe", false]);
  return Number(b.number);
}

async function verifyChain(o: VerifyOptions, chain: number, hashes: string[], url: string): Promise<ChainVerification> {
  const near = o.near;
  const out: ChainVerification = { chain_id: chain, tx_hashes: hashes, requested: false, verified: false, attempts: 0 };
  const until = Date.now() + (o.waitSecs ?? 3600) * 1000;
  let v = await chainView(near, o, chain);
  // Someone else's request may be under way; its answer may settle this.
  while (v.verifying && Date.now() < until) {
    await sleep(5000);
    v = await chainView(near, o, chain);
  }
  Object.assign(out, { verified: v.verified, attempts: v.attempts });
  if (v.verified) return out;
  if (v.verifying) return { ...out, error: "another verification is still under way" };

  const pending = hashes.filter((h) => !v.verified_pauses.includes(h));
  let landed = 0;
  for (const h of pending) {
    const r = await waitForEvmReceipt(url, h, until, 3000);
    if (!r) return { ...out, error: `pause ${h} has not landed` };
    if (r.status !== "success") return { ...out, error: `pause ${h} reverted in block ${r.block}: not asking (it can't verify)` };
    landed = Math.max(landed, r.block);
  }
  out.landed_block = landed;
  const started = Date.now();
  let safe = await safeHead(url);
  while (safe < landed && Date.now() < until) {
    await sleep(15_000);
    safe = await safeHead(url);
  }
  out.safe_block = safe;
  out.waited_secs = Math.round((Date.now() - started) / 1000);
  if (safe < landed) return { ...out, error: `chain ${chain}'s safe head ${safe} hasn't reached block ${landed}` };

  // Someone may have asked meanwhile.
  v = await chainView(near, o, chain);
  while (v.verifying && Date.now() < until) {
    await sleep(5000);
    v = await chainView(near, o, chain);
  }
  Object.assign(out, { verified: v.verified, attempts: v.attempts });
  if (v.verified) return out;
  if (v.verifying) return { ...out, error: "another verification is still under way" };
  const fees = await near.view(o.contract, "fees");
  const gas = BigInt(fees.min_verify_pause_gas_base) + BigInt(fees.min_verify_pause_gas_per_pause) * BigInt(pending.length) + tgas(20);
  const deposit = v.prepaid_attempts_left > 0 ? 0n : BigInt(fees.verify_pause_fee_per_pause) * BigInt(pending.length);
  const r = await near.account(o.signer).signAndSendTransaction({
    receiverId: o.contract,
    actions: [actions.functionCall("verify_pause", { id: o.bounty, chain_id: chain }, gas, deposit)],
    waitUntil: "INCLUDED_FINAL",
    throwOnFailure: false,
  });
  out.requested = true;
  out.near_tx = r.transaction.hash;
  // The MPC network's answer arrives in later receipts: a verified one in seconds, a refusal
  // only when the request times out (~2 minutes).
  const status = await near.txStatus(r.transaction.hash, o.signer, 400);
  const failure = status.receipts_outcome.find((x: any) => x.outcome.status.Failure && x.outcome.executor_id === o.contract);
  if (failure && !events(status).some((e) => e.event === "pause_verification_requested")) {
    return { ...out, error: `verify_pause was refused: ${JSON.stringify(failure.outcome.status.Failure)}` };
  }
  v = await chainView(near, o, chain);
  Object.assign(out, { verified: v.verified, attempts: v.attempts });
  if (!v.verified) out.error = "the MPC network didn't verify it";
  return out;
}

export async function verifyPauses(o: VerifyOptions): Promise<VerifyResult> {
  const bounty = await o.near.view<{ signed_pauses: { chain_id: number; tx_hash: string }[]; state: string } | null>(o.contract, "bounty", { id: o.bounty });
  if (!bounty) throw new Error(`no bounty ${o.bounty.protocol}/${o.bounty.name} on ${o.contract}`);
  if (bounty.signed_pauses.length === 0) throw new Error(`bounty ${o.bounty.protocol}/${o.bounty.name} has no signed pauses (state: ${bounty.state})`);
  const rpcs = { ...defaultRpcs(), ...o.rpcs };
  const chains = [...new Set(bounty.signed_pauses.map((p) => p.chain_id))].filter((c) => !o.chains || o.chains.includes(c));
  const results = await Promise.all(
    chains.map(async (chain) => {
      const hashes = bounty.signed_pauses.filter((p) => p.chain_id === chain).map((p) => p.tx_hash);
      const url = rpcs[chain];
      if (!url) return { chain_id: chain, tx_hashes: hashes, requested: false, verified: false, attempts: 0, error: `no RPC for chain ${chain}: pass --rpc ${chain}=<url>` };
      return verifyChain(o, chain, hashes, url).catch((e) => ({ chain_id: chain, tx_hashes: hashes, requested: false, verified: false, attempts: 0, error: (e as Error).message }));
    }),
  );
  return { bounty: o.bounty, contract: o.contract, chains: results };
}

export function formatVerifyResult(r: VerifyResult): string {
  const lines = [`bounty ${r.bounty.protocol}/${r.bounty.name} on ${r.contract}`];
  for (const c of r.chains) {
    const state = c.verified ? "verified on NEAR" : `not verified${c.error ? ` (${c.error})` : ""}`;
    const tx = c.near_tx ? `, request ${c.near_tx}` : "";
    lines.push(`  chain ${c.chain_id}: ${state}${tx}, ${c.attempts} attempt(s)`);
  }
  return lines.join("\n");
}
