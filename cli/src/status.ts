// A claim's progress and its receipt (ticket #26; D23, D24), read from the chains: the bounty
// contract's views on NEAR, each pause's receipt on its own chain, and OutLayer's attestation
// of the claim's job. `bountee status` prints it once or follows it (`--watch`); `bountee
// claim` follows its own claim with the same code while it sees it through.
//
// The stages, in order: sealed (the contract holds the sealed exploit), checking (its job is
// requested), the verdict, then on a winning PAYS: pauses signed, paid, and for each pause,
// landed on its chain and verified on NEAR. A claim with no verdict ends at `no_verdict` or
// `store_failed` instead.
//
// The contract doesn't record transaction hashes, so the payout's transaction and the
// attestation (which OutLayer files under the claim's transaction) come from transactions
// the tool knows: the one `claim` sent and saved, or `--tx`.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BlockRef, BountyId, Verdict } from "@bountee/formats";
import { defaultRpc, evmReceipt, explorerTx } from "./chains.ts";
import { events, Near, NEAR_EXPLORER_TX, type Network } from "./near.ts";
import { KEYSTORE_API } from "./seal.ts";

/**
 * The bounty contract's `claim` view (its `ClaimRecord`, contract/src/lib.rs), typed from the
 * shared formats' parts.
 */
export interface ClaimView {
  bounty: BountyId;
  whitehat: string;
  block: BlockRef;
  header: string;
  /** sha256 of the proofs exactly as submitted (`0x…`). */
  proofs_sha256: string;
  /** NEAR nanoseconds, decimal. */
  submitted_at_ns: string;
  secret_profile: string;
  state: "storing" | "store_failed" | "judging" | "no_verdict" | "judged";
  verdict: Verdict | null;
}

export type Stage =
  /** `claim` shows it as soon as the exploit is sealed locally, before filing: no claim id yet. */
  | { stage: "sealed"; claim_id: number | null; secret_profile?: string }
  | { stage: "checking"; claim_id: number; submitted_at_ns: string }
  | { stage: "verdict"; claim_id: number; verdict: Verdict }
  | { stage: "no_verdict" | "store_failed"; claim_id: number }
  | { stage: "pauses_signed"; claim_id: number; pauses: { chain_id: number; contract: string; tx_hash: string }[] }
  | { stage: "paid"; claim_id: number; amount: string; whitehat: string }
  | { stage: "landed"; claim_id: number; chain_id: number; contract: string; tx_hash: string; block: number; status: "success" | "reverted" }
  | { stage: "verified"; claim_id: number; chain_id: number; contract: string; tx_hash: string };

export interface PauseRecord {
  chain_id: number;
  contract: string;
  tx_hash: string;
  link?: string;
  landed: { block: number; status: "success" | "reverted" } | null;
  verified: boolean;
}

export interface Attestation {
  url: string;
  task_id: number;
  request_id: number;
  transaction_hash: string;
  wasm_hash: string;
  input_hash: string;
  output_hash: string;
  worker_measurement: string;
  timestamp: number;
}

export interface Receipt {
  claim_id: number;
  bounty: BountyId;
  whitehat: string;
  /** The bounty amount paid, in USDC's smallest unit. */
  amount: string;
  usdc: string;
  verdict: Verdict;
  /** Where the USDC moved to the Whitehat; null if no known transaction holds it. */
  payout: { tx_hash: string; receipt_id: string; link: string } | null;
  /** OutLayer's TEE attestation of the claim's job; null without the claim's transaction. */
  attestation: Attestation | null;
  pauses: PauseRecord[];
}

export interface ClaimStatus {
  contract: string;
  claim_id: number;
  bounty: BountyId;
  whitehat: string;
  state: string;
  verdict: Verdict | null;
  submitted_at_ns: string;
  bounty_state: string;
  stages: Stage[];
  receipt?: Receipt;
  /** Nothing more will happen to this claim that the tool can follow. */
  done: boolean;
}

export interface StatusOptions {
  contract: string;
  claimId: number;
  network: Network;
  near: Near;
  /** Chain ID → RPC URL, over the defaults, for reading pause receipts. */
  rpcs?: Record<number, string>;
  outlayerApi?: string;
  /** NEAR transactions known to belong to the claim: the claim's own first. */
  txs?: string[];
}

/** Where `claim` saves the transactions it sent, so `status` can find them later. */
export function savedClaimFile(contract: string, claimId: number): string {
  return join(".bountee", "claims", contract, `${claimId}.json`);
}

export function saveClaimTxs(contract: string, claimId: number, txs: string[]): string {
  const file = savedClaimFile(contract, claimId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ contract, claim_id: claimId, txs }, null, 2)}\n`);
  return file;
}

export function loadClaimTxs(contract: string, claimId: number): string[] {
  const file = savedClaimFile(contract, claimId);
  if (!existsSync(file)) return [];
  return (JSON.parse(readFileSync(file, "utf8")).txs as string[]) ?? [];
}

/** Lookups that never change once answered, kept across a watch's polls. */
type Cache = Map<string, Promise<unknown>>;
const once = <T>(cache: Cache, key: string, f: () => Promise<T>): Promise<T> => {
  if (!cache.has(key)) cache.set(key, f().catch((e) => (cache.delete(key), Promise.reject(e))));
  return cache.get(key) as Promise<T>;
};

/** Not landed yet, or the RPC didn't answer: either way not shown as landed. */
const pauseReceipt = async (url: string | undefined, hash: string) => {
  const r = url ? await evmReceipt(url, hash) : null;
  return r ? { block: r.block, status: r.status } : null;
};

/**
 * Whether the contract records a verified pause for this transaction (R7.10): its
 * `pause_verifications` view lists, per chain, the hashes of the pauses the MPC network verified.
 */
function isVerified(verifications: { verified_pauses?: string[] }[], hash: string): boolean {
  return verifications.some((c) => (c.verified_pauses ?? []).some((h) => h.toLowerCase() === hash.toLowerCase()));
}

async function findPayout(o: StatusOptions, cache: Cache, claim: ClaimView) {
  for (const hash of o.txs ?? []) {
    const status = await once(cache, `tx:${hash}`, () => o.near.txStatus(hash, claim.whitehat, 30)).catch(() => null);
    if (!status) continue;
    const paid = events(status).some((e) => e.event === "bounty_paid" && e.data?.claim_id === o.claimId);
    if (!paid) continue;
    // The receipt where USDC moved to the Whitehat: the token's NEP-141 `ft_transfer` event.
    const transfer = (status as any).receipts_outcome.find((r: any) =>
      events({ receipts_outcome: [r] }).some((e) => e.event === "ft_transfer" && e.data?.new_owner_id === claim.whitehat),
    );
    return {
      tx_hash: hash,
      receipt_id: transfer?.id ?? "",
      link: `${NEAR_EXPLORER_TX[o.network]}${hash}`,
    };
  }
  return null;
}

/** The claim's own transaction: the one whose `claim_submitted` event names it. */
async function claimTx(o: StatusOptions, cache: Cache, whitehat: string): Promise<string | null> {
  for (const hash of o.txs ?? []) {
    const status = await once(cache, `tx:${hash}`, () => o.near.txStatus(hash, whitehat, 30)).catch(() => null);
    if (status && events(status).some((e) => e.event === "claim_submitted" && e.data?.claim_id === o.claimId)) return hash;
  }
  return null;
}

async function attestation(o: StatusOptions, cache: Cache, whitehat: string): Promise<Attestation | null> {
  const hash = await claimTx(o, cache, whitehat);
  if (!hash) return null;
  const url = `${o.outlayerApi ?? KEYSTORE_API[o.network]}/attestations/by-tx/${hash}`;
  const a = await once(cache, url, async () => {
    const res = await fetch(url, { headers: { "User-Agent": "bountee-cli" } });
    if (!res.ok) throw new Error(`OutLayer has no attestation for ${hash} (HTTP ${res.status})`);
    return (await res.json()) as any;
  }).catch(() => null);
  if (!a) return null;
  return {
    url,
    task_id: a.task_id,
    request_id: a.request_id,
    transaction_hash: a.transaction_hash,
    wasm_hash: a.wasm_hash,
    input_hash: a.input_hash,
    output_hash: a.output_hash,
    worker_measurement: a.worker_measurement,
    timestamp: a.timestamp,
  };
}

/** The claim as it stands now. */
export async function claimStatus(o: StatusOptions, cache: Cache = new Map()): Promise<ClaimStatus> {
  const claim = await o.near.view<ClaimView | null>(o.contract, "claim", { claim_id: o.claimId });
  if (!claim) throw new Error(`no claim ${o.claimId} on ${o.contract}`);
  const bounty = await o.near.view<any>(o.contract, "bounty", { id: claim.bounty });
  const id = o.claimId;
  const stages: Stage[] = [{ stage: "sealed", claim_id: id, secret_profile: claim.secret_profile }];
  const out: ClaimStatus = {
    contract: o.contract,
    claim_id: id,
    bounty: claim.bounty,
    whitehat: claim.whitehat,
    state: claim.state,
    verdict: claim.verdict ?? null,
    submitted_at_ns: claim.submitted_at_ns,
    bounty_state: bounty?.state,
    stages,
    done: false,
  };
  if (claim.state === "store_failed") {
    stages.push({ stage: "store_failed", claim_id: id });
    return { ...out, done: true };
  }
  if (claim.state === "storing") return out;
  stages.push({ stage: "checking", claim_id: id, submitted_at_ns: claim.submitted_at_ns });
  if (claim.state === "no_verdict") {
    stages.push({ stage: "no_verdict", claim_id: id });
    return { ...out, done: true };
  }
  if (claim.state !== "judged" || !claim.verdict) return out;
  const verdict = claim.verdict;
  stages.push({ stage: "verdict", claim_id: id, verdict });
  // Only the winning PAYS claim goes on: a ZERO, an INVALID, or a PAYS an earlier claim beat.
  if (verdict.outcome !== "PAYS" || bounty?.winning_claim !== id) return { ...out, done: true };

  const signed: any[] = bounty.signed_pauses ?? [];
  if (signed.length === 0) return out;
  stages.push({
    stage: "pauses_signed",
    claim_id: id,
    pauses: signed.map((p) => ({ chain_id: p.chain_id, contract: p.contract, tx_hash: p.tx_hash })),
  });
  const paid = bounty.state === "paid";
  if (paid) stages.push({ stage: "paid", claim_id: id, amount: bounty.rules.bounty_amount, whitehat: claim.whitehat });

  const verifications = await o.near
    .view<{ verified_pauses?: string[] }[]>(o.contract, "pause_verifications", { id: claim.bounty })
    .catch(() => []);
  const pauses: PauseRecord[] = await Promise.all(
    signed.map(async (p) => ({
      chain_id: p.chain_id,
      contract: p.contract,
      tx_hash: p.tx_hash,
      link: explorerTx(p.chain_id, p.tx_hash),
      landed: await pauseReceipt(o.rpcs?.[p.chain_id] ?? defaultRpc(p.chain_id), p.tx_hash),
      verified: isVerified(verifications, p.tx_hash),
    })),
  );
  for (const p of pauses) {
    if (p.landed) stages.push({ stage: "landed", claim_id: id, chain_id: p.chain_id, contract: p.contract, tx_hash: p.tx_hash, ...p.landed });
  }
  for (const p of pauses) {
    if (p.verified) stages.push({ stage: "verified", claim_id: id, chain_id: p.chain_id, contract: p.contract, tx_hash: p.tx_hash });
  }
  if (!paid) return out;

  const config = await once(cache, "config", () => o.near.view<any>(o.contract, "config"));
  out.receipt = {
    claim_id: id,
    bounty: claim.bounty,
    whitehat: claim.whitehat,
    amount: bounty.rules.bounty_amount,
    usdc: config.usdc,
    verdict,
    payout: await findPayout(o, cache, claim),
    attestation: await attestation(o, cache, claim.whitehat),
    pauses,
  };
  out.done = pauses.every((p) => p.verified);
  return out;
}

const stageKey = (s: Stage) => ("tx_hash" in s ? `${s.stage}:${s.tx_hash}` : s.stage);

/**
 * Follow the claim, calling `emit` with each stage the moment it's first seen, until nothing
 * more will happen, `stop()` says so, or the timeout. Returns the last status read.
 */
export async function watchClaim(
  o: StatusOptions,
  emit: (s: Stage) => void,
  w: { timeoutSecs: number; intervalSecs?: number; stop?: () => boolean; seen?: Set<string> },
): Promise<ClaimStatus> {
  const cache: Cache = new Map();
  const seen = w.seen ?? new Set<string>();
  const deadline = Date.now() + w.timeoutSecs * 1000;
  for (;;) {
    const stopping = w.stop?.() ?? false;
    const s = await claimStatus(o, cache);
    for (const stage of s.stages) {
      const key = stageKey(stage);
      if (seen.has(key)) continue;
      seen.add(key);
      emit(stage);
    }
    if (s.done || stopping || Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, (w.intervalSecs ?? 3) * 1000));
  }
}

export function formatStage(s: Stage): string {
  switch (s.stage) {
    case "sealed":
      return s.claim_id === null
        ? "sealed on this machine; filing the claim"
        : `claim ${s.claim_id}: sealed (held by the contract as secret ${s.secret_profile})`;
    case "checking":
      return `claim ${s.claim_id}: checking in the enclave`;
    case "verdict":
      return `claim ${s.claim_id}: verdict ${s.verdict.outcome} (${s.verdict.reason})`;
    case "no_verdict":
      return `claim ${s.claim_id}: no verdict (the job failed; the claim keeps its place)`;
    case "store_failed":
      return `claim ${s.claim_id}: the sealed exploit couldn't be stored; nothing was judged`;
    case "pauses_signed":
      return `claim ${s.claim_id}: ${s.pauses.length} pause(s) signed`;
    case "paid":
      return `claim ${s.claim_id}: paid ${s.amount} to ${s.whitehat}`;
    case "landed":
      return `claim ${s.claim_id}: pause landed on chain ${s.chain_id} (${s.status}, block ${s.block}) ${s.tx_hash}`;
    case "verified":
      return `claim ${s.claim_id}: pause verified on NEAR for chain ${s.chain_id} ${s.tx_hash}`;
  }
}

export function formatReceipt(r: Receipt): string {
  const lines = [
    `receipt for claim ${r.claim_id} on ${r.bounty.protocol}/${r.bounty.name}`,
    `  paid:        ${r.amount} (${r.usdc}) to ${r.whitehat}`,
    `  payout:      ${r.payout ? `${r.payout.link} (receipt ${r.payout.receipt_id})` : "unknown (pass --tx with the transaction that paid it)"}`,
    `  attestation: ${r.attestation ? `${r.attestation.url} (task ${r.attestation.task_id}, judge ${r.attestation.wasm_hash})` : "unknown (pass --tx with the claim's transaction)"}`,
  ];
  for (const p of r.pauses) {
    const landed = p.landed ? `landed (${p.landed.status}, block ${p.landed.block})` : "not landed";
    lines.push(`  pause:       chain ${p.chain_id} ${p.contract}: ${p.link ?? p.tx_hash} ${landed}${p.verified ? ", verified" : ""}`);
  }
  return lines.join("\n");
}

export function formatStatus(s: ClaimStatus): string {
  const lines = s.stages.map(formatStage);
  if (s.receipt) lines.push(formatReceipt(s.receipt));
  return lines.join("\n");
}
