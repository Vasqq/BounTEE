// The chains' state the stand-in answers from, and builders for the states the specs need.
// Shapes follow the bounty contract's views (contract/src/lib.rs `BountyView`, `ClaimRecord`;
// pauses.rs `SignedPause`; verification.rs `PauseVerification`) as NEAR RPC returns them.
import type { Page } from "@playwright/test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";

export interface BountyId {
  protocol: string;
  name: string;
}

export interface SignedPause {
  chain_id: number;
  contract: string;
  nonce: number;
  tx: string;
  tx_hash: string;
}

export interface BountyView {
  id: BountyId;
  rules: any;
  state: "checking" | "live" | "check_failed" | "signing" | "paying" | "paid" | "withdrawn";
  winning_claim: number | null;
  signed_pauses: SignedPause[];
  signing_pauses: boolean;
  paying_out: boolean;
  payout_waits_until_ns: string | null;
  posting_fee_left: string;
}

export interface NearTx {
  hash: string;
  signer: string;
  receipts: { executor: string; logs: string[]; ok: boolean }[];
}

export interface EvmReceipt {
  ok: boolean;
  block: number;
  to: string;
}

export interface World {
  contract: string;
  config: any;
  fees: any;
  accounts: Record<string, { amount: string; code_hash: string }>;
  bounties: BountyView[];
  claims: { id: number; record: any }[];
  pauseRoles: Record<string, { path: string; address: string }>;
  verifications: Record<string, any[]>;
  publications: Record<string, any>;
  releases: Record<string, any>;
  /** The contract's NEAR transactions, oldest first, as the explorer indexes them. */
  nearTxs: NearTx[];
  evm: Record<
    number,
    {
      balances: Record<string, string>;
      receipts: Record<string, EvmReceipt>;
      /** A raw transaction whose hash is a key here lands with this receipt once sent. */
      landOnSend?: Record<string, EvmReceipt>;
    }
  >;
}

export const CONTRACT = "bounty.bountee.near";
export const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
export const BASE = 8453;
export const ARBITRUM = 42161;
export const PAUSE_ROLE = "0x5a1c6a3e0c1f5b8e2d7f4a9b3c6d8e0f1a2b3c4d";
export const VAULT_BASE = "0x8e01c52f1b2bbedd8b714b9ae168d022b52e74c1";
export const VAULT_ARB = "0x3f6a9e2d4c1b8a7e5d0f9c3b2a1e8d7c6b5a4f3e";
/** Gas a pause needs at its fee limit: 200,000 gas at 1 gwei plus Base's L1 data-fee allowance (`fees()`). */
export const PAUSE_GAS_PER_PAUSE = "210000000000000";

const event = (event: string, data: unknown) => `EVENT_JSON:${JSON.stringify({ standard: "bountee", version: "1.0.0", event, data: [data] })}`;

/** A NEAR transaction hash: 44 base58 characters, distinct per seed. */
export const nearHash = (seed: string) => (seed.repeat(44) + "A".repeat(44)).replace(/[0OIl]/g, "x").slice(0, 44);
/** An EVM transaction hash, distinct per seed. */
export const evmHash = (seed: string) => `0x${Buffer.from(seed).toString("hex").padEnd(64, "a").slice(0, 64)}`;

export function rules(over: Partial<any> = {}) {
  return {
    covered_contracts: [
      { chain_id: BASE, address: VAULT_BASE },
      { chain_id: ARBITRUM, address: VAULT_ARB },
    ],
    proof_chain: BASE,
    recency_limit_secs: 300,
    listed_tokens: [{ token: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", price: "1" }],
    seed: { native: "1000000000000000000", tokens: [] },
    bounty_amount: "10000000",
    minimum_theft: "1000000",
    end_date_ns: String(Date.UTC(2026, 11, 31) * 1_000_000),
    disclosure_delay_days: 1,
    exploit_public_key: "x25519:4s3jkZs26UE79gfW5kAkuVBUBur231tDgBEALmQqkRxB",
    judge_build_hash: "0xa55296e4214ea39685e8995430a9dfab460cc8fedb92e611d72e1b5c41bb118c",
    ...over,
  };
}

export function bounty(id: BountyId, over: Partial<BountyView> = {}): BountyView {
  return {
    id,
    rules: rules(),
    state: "live",
    winning_claim: null,
    signed_pauses: [],
    signing_pauses: false,
    paying_out: false,
    payout_waits_until_ns: null,
    posting_fee_left: "400000000000000000000000",
    ...over,
  };
}

export function claim(id: number, bountyId: BountyId, state: string, verdict: { outcome: string; reason: string } | null, whitehat = "whitehat.near") {
  return {
    id,
    record: {
      bounty: bountyId,
      whitehat,
      block: { number: 38_000_000 + id, hash: evmHash(`block${id}`) },
      header: "0xf90279",
      proofs_sha256: evmHash(`proofs${id}`),
      submitted_at_ns: "1794000000000000000",
      submitted_at_block: "190000000",
      step_started_at_block: "190000002",
      secret_profile: `c${id}`,
      state,
      verdict,
    },
  };
}

/** A world with nothing posted: the contract deployed, chains up, pause-role gas at `balance`. */
export function emptyWorld(): World {
  return {
    contract: CONTRACT,
    config: { outlayer: "outlayer.near", mpc: "v1.signer", usdc: USDC, judge_build_hash: rules().judge_build_hash, seed: rules().seed },
    fees: {
      posting_fee: "500000000000000000000000",
      pause_gas_limit: 200000,
      pause_max_fee_per_gas: "1000000000",
      pause_l1_data_fee_allowance: "10000000000000",
      pause_gas_per_pause: PAUSE_GAS_PER_PAUSE,
      prepaid_verify_attempts: 3,
    },
    accounts: { [CONTRACT]: { amount: "4849165010462500000000000", code_hash: "8Ld3ac3b1nH3rFfg2e4Zk9q4ixpvG9Bqv7rUd3q1Ytrd" } },
    bounties: [],
    claims: [],
    pauseRoles: {},
    verifications: {},
    publications: {},
    releases: {},
    nearTxs: [],
    evm: {
      [BASE]: { balances: {}, receipts: {} },
      [ARBITRUM]: { balances: {}, receipts: {} },
    },
  };
}

/** Post a bounty: its posting transaction, its pause role, and pause gas held on each chain. */
export function post(w: World, id: BountyId, over: Partial<BountyView> = {}, gasWei = "1000000000000000"): BountyView {
  const b = bounty(id, over);
  w.bounties.push(b);
  w.pauseRoles[`${id.protocol}/${id.name}`] = { path: `${id.protocol}/${id.name}`, address: PAUSE_ROLE };
  for (const chain of [BASE, ARBITRUM]) w.evm[chain]!.balances[PAUSE_ROLE] = gasWei;
  w.nearTxs.push({
    hash: nearHash(`post${id.name}`),
    signer: id.protocol,
    receipts: [{ executor: CONTRACT, logs: [event("bounty_posted", { bounty: id, amount: b.rules.bounty_amount }), event("bounty_live", { bounty: id })], ok: true }],
  });
  return b;
}

/** File a claim and record its verdict, each in its own transaction, as the contract logs them. */
export function judge(w: World, id: BountyId, claimId: number, outcome: "PAYS" | "ZERO", whitehat = "whitehat.near") {
  const verdict = { outcome, reason: outcome === "PAYS" ? "minimum_theft_reached" : "no_theft" };
  w.claims.push(claim(claimId, id, "judged", verdict, whitehat));
  w.nearTxs.push({
    hash: nearHash(`submit${claimId}`),
    signer: whitehat,
    receipts: [{ executor: CONTRACT, logs: [event("claim_submitted", { claim_id: claimId, bounty: id, whitehat })], ok: true }],
  });
  w.nearTxs.push({
    hash: nearHash(`judged${claimId}`),
    signer: "worker.outlayer.near",
    receipts: [{ executor: CONTRACT, logs: [event("claim_judged", { claim_id: claimId, verdict })], ok: true }],
  });
}

/** A claim that has been filed and not yet judged: a claim in progress (R7.7). */
export function claimInProgress(w: World, id: BountyId, claimId: number) {
  w.claims.push(claim(claimId, id, "judging", null, "hunter.near"));
  w.nearTxs.push({
    hash: nearHash(`submit${claimId}`),
    signer: "hunter.near",
    receipts: [{ executor: CONTRACT, logs: [event("claim_submitted", { claim_id: claimId, bounty: id, whitehat: "hunter.near" })], ok: true }],
  });
}

/** A raw transaction's hash, as its chain computes it. */
export const hashOfRaw = (raw: string) => `0x${bytesToHex(keccak_256(hexToBytes(raw.replace(/^0x/, ""))))}`;

/** The raw signed pause for a chain. */
export const rawPause = (chain: number) => `0x02f8${chain.toString(16)}deadbeef${"00".repeat(40)}`;

/**
 * Win the bounty with claim `claimId`: pauses signed for each covered contract, the payout,
 * then whichever pauses have landed and been verified, per chain.
 */
export function win(
  w: World,
  id: BountyId,
  claimId: number,
  o: { landed?: number[]; verified?: number[] } = {},
) {
  judge(w, id, claimId, "PAYS");
  const b = w.bounties.find((x) => x.id.name === id.name && x.id.protocol === id.protocol)!;
  b.signed_pauses = b.rules.covered_contracts.map((c: any) => {
    const tx = rawPause(c.chain_id);
    return { chain_id: c.chain_id, contract: c.address, nonce: 0, tx, tx_hash: hashOfRaw(tx) };
  });
  b.state = "paid";
  b.winning_claim = claimId;
  w.nearTxs.push({
    hash: nearHash(`signed${claimId}`),
    signer: "relayer.near",
    receipts: [
      { executor: CONTRACT, logs: [event("pauses_signed", { bounty: id, claim_id: claimId, pauses: b.signed_pauses.length })], ok: true },
      { executor: CONTRACT, logs: [event("bounty_paid", { bounty: id, claim_id: claimId, amount: b.rules.bounty_amount })], ok: true },
    ],
  });
  for (const p of b.signed_pauses) {
    if (o.landed?.includes(p.chain_id)) w.evm[p.chain_id]!.receipts[p.tx_hash] = { ok: true, block: 22_000_000, to: p.contract };
  }
  w.verifications[`${id.protocol}/${id.name}`] = [BASE, ARBITRUM].map((chain) => {
    const done = o.verified?.includes(chain) ?? false;
    return {
      chain_id: chain,
      verified: done,
      verified_pauses: done ? b.signed_pauses.filter((p) => p.chain_id === chain).map((p) => p.tx_hash) : [],
      attempts: done ? 1 : 0,
      prepaid_attempts_left: done ? 2 : 3,
      verifying: false,
    };
  });
  for (const chain of o.verified ?? []) {
    w.nearTxs.push({
      hash: nearHash(`verified${chain}`),
      signer: "relayer.near",
      receipts: [{ executor: CONTRACT, logs: [event("pause_verified", { bounty: id, chain_id: chain, verified_pauses: b.signed_pauses.filter((p) => p.chain_id === chain).map((p) => p.tx_hash) })], ok: true }],
    });
  }
}

export const STAND_IN = `http://localhost:${process.env.STAND_IN_PORT ?? 3199}`;

/** Put the chains in this state before the page reads them. */
export async function setWorld(page: Page, w: World) {
  const r = await page.request.put(`${STAND_IN}/world`, { data: w });
  if (!r.ok()) throw new Error(`stand-in refused the world: ${r.status()}`);
}

/** Raw transactions the page sent to each EVM chain. */
export async function sentTxs(page: Page): Promise<Record<number, string[]>> {
  return (await page.request.get(`${STAND_IN}/sent`)).json();
}

/** Publish the winning exploit after its disclosure delay (D7). */
export function publish(w: World, id: BountyId, claimId: number) {
  w.publications[`${id.protocol}/${id.name}`] = { claim_id: claimId, state: "published", publishable_from_ns: "1794100000000000000", verdict: { outcome: "PAYS", reason: "minimum_theft_reached" }, published: "AAAA" };
  w.nearTxs.push({
    hash: nearHash(`published${claimId}`),
    signer: "anyone.near",
    receipts: [{ executor: CONTRACT, logs: [event("exploit_published", { bounty: id, claim_id: claimId })], ok: true }],
  });
}

/** The demo bounty the app is configured to tell (playwright.config.ts DEMO_BOUNTY). */
export const DEMO: BountyId = { protocol: "0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e", name: "mainnet-demo" };

/** The finished demo: posted, a cheat claim scored ZERO, the agent's claim won, both pauses landed and verified, published. */
export function finishedDemo(): World {
  const w = emptyWorld();
  post(w, DEMO);
  judge(w, DEMO, 0, "ZERO", "cheat.near");
  win(w, DEMO, 1, { landed: [BASE, ARBITRUM], verified: [BASE, ARBITRUM] });
  publish(w, DEMO, 1);
  return w;
}
