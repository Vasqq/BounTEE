// The steps of `bountee claim` around sealing and filing (#16):
//
// - before: run `test`'s collection for the Foundry script, or reuse a saved job, and re-run
//   it if its block is too old to still be recent when the claim lands (R2.8's 300 s);
// - the claim balance: top it up with what this claim will draw, if it's short;
// - after: wait for the enclave's verdict, and on PAYS make sure the pauses are signed (asking
//   `sign_pauses` if the verdict's callback ran out of gas for them), the bounty is paid,
//   and every signed pause is broadcast, then each chain's pause verified on NEAR once the
//   chain reports it safe (R7.3).
import { readFileSync } from "node:fs";
import { actions } from "near-api-js";
import { parseReplay, RECENCY_LIMIT_SECS, type Replay, type Verdict } from "@bountee/formats";
import { broadcastCommand, type BroadcastResult } from "./broadcast.ts";
import { rpc } from "./proofs.ts";
import { proofRpcs } from "./chains.ts";
import { testCommand, type TestOptions, type TestResult } from "./test.ts";
import { verifyPauses, type VerifyResult } from "./verify-pause.ts";
import { Near, events, formatNear, milliNear, tgas } from "./near.ts";

/** Time a claim needs from here to `submit_claim` recording its submission time. */
export const SUBMIT_MARGIN_SECS = 60;

export interface PreparedClaim {
  replay: Replay;
  /** The verdict `bountee test` gave for exactly these inputs (D2). */
  local: Verdict | null;
  saved: string;
  block_age_secs: number;
  reran: boolean;
  test?: TestResult;
}

async function blockTimestamp(chainId: number, number: number, rpcUrl?: string): Promise<number> {
  const urls = rpcUrl ? [rpcUrl] : proofRpcs(chainId);
  for (const url of urls) {
    try {
      const b = await rpc<{ timestamp: string }>(url, "eth_getBlockByNumber", [`0x${number.toString(16)}`, false]);
      return Number(BigInt(b.timestamp));
    } catch {
      // next RPC
    }
  }
  throw new Error(`no RPC answered for block ${number} of chain ${chainId}`);
}

/**
 * The inputs to claim with: those `test` saved in `job` if still recent enough, else a fresh
 * `test` run of `script`. What is submitted is exactly the saved job's block, header and proofs.
 */
export async function prepareClaim(o: { job?: string; test?: TestOptions; rpc?: string }): Promise<PreparedClaim> {
  const usable = (age: number) => age + SUBMIT_MARGIN_SECS < RECENCY_LIMIT_SECS;
  if (o.job) {
    const replay = parseReplay(JSON.parse(readFileSync(o.job, "utf8")).replay);
    const age = Math.floor(Date.now() / 1000) - (await blockTimestamp(replay.rules.proof_chain, replay.block.number, o.rpc));
    if (usable(age) || !o.test) {
      if (!usable(age)) throw new Error(`${o.job} is ${age} s old: re-run \`bountee test\` (claims must be under ${RECENCY_LIMIT_SECS} s)`);
      return { replay, local: null, saved: o.job, block_age_secs: age, reran: false };
    }
  }
  if (!o.test) throw new Error("claim needs a Foundry script or a saved job (--job)");
  const result = await testCommand(o.test);
  const replay = parseReplay(JSON.parse(readFileSync(result.saved, "utf8")).replay);
  const age = Math.floor(Date.now() / 1000) - (await blockTimestamp(replay.rules.proof_chain, replay.block.number, result.rpc));
  if (!usable(age)) throw new Error(`the test took too long: its block is already ${age} s old`);
  return { replay, local: result.verdict, saved: result.saved, block_age_secs: age, reran: o.job !== undefined, test: result };
}

/** What `submit_claim` will draw from the claim balance (contract `claims.rs`), with slack. */
export function claimCost(fees: any, inputBytes: number, sealedBytes: number): bigint {
  const perByte = BigInt(fees.storage_price_per_byte);
  const hold = BigInt(Math.max(0, inputBytes - Number(fees.job_input_free_bytes)));
  const secret = BigInt(sealedBytes + Number(fees.secret_row_overhead_bytes));
  return BigInt(fees.job_deposit) + (hold + secret + 2048n) * perByte + milliNear(10);
}

/** Top the Whitehat's claim balance up to `cost` if it's short. Returns the amount added. */
export async function ensureClaimBalance(near: Near, contract: string, whitehat: string, cost: bigint): Promise<bigint> {
  const have = BigInt(await near.view<string>(contract, "claim_balance", { account_id: whitehat }));
  if (have >= cost) return 0n;
  const add = cost - have;
  await near.account(whitehat).callFunction({ contractId: contract, methodName: "top_up_claim_balance", args: {}, deposit: add, gas: tgas(30) });
  return add;
}

export interface Settlement {
  claim_id: number;
  state: string;
  verdict: Verdict | null;
  submitted_at_ns: string;
  bounty_state: string;
  /** `sign_pauses` transaction, if the verdict's callback left the pauses for a retry. */
  sign_pauses_tx?: string;
  paid?: boolean;
  broadcast?: BroadcastResult;
  /** Each chain's pause verification on NEAR, after the broadcast. */
  verification?: VerifyResult;
  events: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait for the claim's verdict; on PAYS see it paid and its pauses broadcast. */
export async function settle(
  near: Near,
  o: { contract: string; bounty: { protocol: string; name: string }; claimId: number; txHash: string; whitehat: string; broadcast: boolean; verify?: boolean; verifyWaitSecs?: number; rpcs?: Record<number, string>; timeoutSecs?: number },
): Promise<Settlement> {
  const deadline = Date.now() + (o.timeoutSecs ?? 300) * 1000;
  const status = await near.txStatus(o.txHash, o.whitehat, o.timeoutSecs ?? 300);
  const seen = events(status).map((e) => e.event);
  let claim: any;
  for (;;) {
    claim = await near.view(o.contract, "claim", { claim_id: o.claimId });
    if (["judged", "no_verdict", "store_failed"].includes(claim?.state)) break;
    if (Date.now() > deadline) break;
    await sleep(3000);
  }
  const out: Settlement = {
    claim_id: o.claimId,
    state: claim?.state ?? "unknown",
    verdict: claim?.verdict ?? null,
    submitted_at_ns: claim?.submitted_at_ns,
    bounty_state: "",
    events: seen,
  };
  let bounty = await near.view(o.contract, "bounty", { id: o.bounty });
  out.bounty_state = bounty?.state;
  if (out.verdict?.outcome !== "PAYS" || bounty?.winning_claim !== o.claimId) return out;

  // The verdict's callback signs the pauses when it has the gas; otherwise it leaves the
  // bounty `signing`, waiting for `sign_pauses` (anyone may call it).
  for (let tries = 0; bounty.state === "signing" && Date.now() < deadline; ) {
    if (!bounty.signing_pauses && tries < 3) {
      tries++;
      const fees = await near.view(o.contract, "fees");
      const gas = BigInt(fees.min_sign_pauses_gas_base) + BigInt(fees.min_sign_pauses_gas_per_contract) * BigInt(bounty.rules.covered_contracts.length) + tgas(40);
      const r = await near.account(o.whitehat).signAndSendTransaction({
        receiverId: o.contract,
        actions: [actions.functionCall("sign_pauses", { id: o.bounty }, gas, 0n)],
        waitUntil: "FINAL",
        throwOnFailure: false,
      });
      out.sign_pauses_tx = r.transaction.hash;
      const s = await near.txStatus(r.transaction.hash, o.whitehat);
      out.events.push(...events(s).map((e) => e.event));
    } else if (!bounty.signing_pauses) {
      break; // three retries failed: the claim stays pending, unpaid (R2.5)
    } else {
      await sleep(5000);
    }
    bounty = await near.view(o.contract, "bounty", { id: o.bounty });
  }
  for (; bounty.state === "paying" && Date.now() < deadline; bounty = await near.view(o.contract, "bounty", { id: o.bounty })) await sleep(3000);
  out.bounty_state = bounty.state;
  out.paid = bounty.state === "paid";
  if (o.broadcast && bounty.signed_pauses?.length) {
    out.broadcast = await broadcastCommand({
      bounty: `${o.bounty.protocol}/${o.bounty.name}`,
      contract: o.contract,
      nearRpc: near.url,
      rpcs: o.rpcs,
      waitSecs: 120,
    });
    // Off the money path (R7.11): the claim is paid whatever this finds.
    if (o.verify) {
      out.verification = await verifyPauses({
        near,
        contract: o.contract,
        bounty: o.bounty,
        signer: o.whitehat,
        rpcs: o.rpcs,
        waitSecs: o.verifyWaitSecs,
      });
    }
  }
  return out;
}

export function formatSettlement(s: Settlement): string {
  const lines = [`claim ${s.claim_id}: ${s.state}${s.verdict ? ` ${s.verdict.outcome} (${s.verdict.reason})` : ""}`, `bounty: ${s.bounty_state}`];
  if (s.sign_pauses_tx) lines.push(`pauses signed by retry: ${s.sign_pauses_tx}`);
  for (const p of s.broadcast?.pauses ?? []) lines.push(`pause on ${p.chain_id} ${p.contract}: ${p.sent} ${p.tx_hash}${p.receipt ? ` (${p.receipt.status})` : ""}`);
  for (const c of s.verification?.chains ?? []) lines.push(`pause on ${c.chain_id}: ${c.verified ? "verified on NEAR" : `not verified (${c.error ?? "unknown"})`}`);
  return lines.join("\n");
}

export { formatNear };
