// The two retries of a winning claim that anyone may run, each also a command:
//
//   bountee sign-pauses <protocol>/<name> --as <account>    (R2.5)
//   bountee retry-payout <protocol>/<name> --as <account>   (R3.6, R2.4)
//
// `sign-pauses` asks the MPC network again for a bounty left `signing` (the verdict's callback
// ran out of gas, or a signature failed or timed out). `retry-payout` starts the payout of a
// bounty left `paying`: one that waited for earlier claims (R3.6; the bounty view's
// `payout_waits_until_ns` says until when) or whose transfer failed (R2.4). Either pays only
// the winning claim's Whitehat. `bountee claim` runs `sign-pauses` itself when its key may;
// a claim key may not (R14.1), so it names these commands for the Whitehat's own key.
import { actions } from "near-api-js";
import type { BountyId } from "@bountee/formats";
import { events, Near, tgas } from "./near.ts";

export interface RetryResult {
  bounty: BountyId;
  contract: string;
  tx_hash: string;
  /** The bounty's state after the retry ran. */
  state: string;
  events: string[];
  /** The contract's refusal, if it refused the call. */
  refused?: string;
}

interface BountyView {
  state: string;
  winning_claim: number | null;
  signing_pauses: boolean;
  paying_out: boolean;
  payout_waits_until_ns: string | null;
  rules: { covered_contracts: unknown[] };
}

async function bountyOf(near: Near, contract: string, id: BountyId): Promise<BountyView> {
  const b = await near.view<BountyView | null>(contract, "bounty", { id });
  if (!b) throw new Error(`no bounty ${id.protocol}/${id.name} on ${contract}`);
  return b;
}

async function send(near: Near, contract: string, id: BountyId, signer: string, method: string, gas: bigint): Promise<RetryResult> {
  const r = await near.account(signer).signAndSendTransaction({
    receiverId: contract,
    actions: [actions.functionCall(method, { id }, gas, 0n)],
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  const status = await near.txStatus(r.transaction.hash, signer);
  const failure = status.receipts_outcome.find((x: any) => x.outcome.status.Failure && x.outcome.executor_id === contract);
  const after = await bountyOf(near, contract, id);
  return {
    bounty: id,
    contract,
    tx_hash: r.transaction.hash,
    state: after.state,
    events: events(status).map((e) => e.event),
    ...(failure ? { refused: JSON.stringify(failure.outcome.status.Failure) } : {}),
  };
}

/** Ask for the pauses' signatures again (R2.5): only while the bounty is `signing` and no request is under way. */
export async function signPauses(o: { near: Near; contract: string; bounty: BountyId; signer: string }): Promise<RetryResult> {
  const b = await bountyOf(o.near, o.contract, o.bounty);
  if (b.state !== "signing") throw new Error(`bounty ${o.bounty.protocol}/${o.bounty.name} is ${b.state}: it has no pauses waiting to be signed`);
  if (b.signing_pauses) throw new Error("a signing request is already under way: wait for it (at most 300 blocks)");
  const fees = await o.near.view(o.contract, "fees");
  const gas = BigInt(fees.min_sign_pauses_gas_base) + BigInt(fees.min_sign_pauses_gas_per_contract) * BigInt(b.rules.covered_contracts.length) + tgas(40);
  return send(o.near, o.contract, o.bounty, o.signer, "sign_pauses", gas);
}

/** Start a waiting or failed payout (R3.6, R2.4): only once no earlier claim holds its place. */
export async function retryPayout(o: { near: Near; contract: string; bounty: BountyId; signer: string; nowNs?: bigint }): Promise<RetryResult> {
  const b = await bountyOf(o.near, o.contract, o.bounty);
  if (b.state !== "paying" || b.paying_out) {
    throw new Error(`bounty ${o.bounty.protocol}/${o.bounty.name} is ${b.state}${b.paying_out ? " with a transfer under way" : ""}: it has no payout waiting for a retry`);
  }
  const now = o.nowNs ?? BigInt(Date.now()) * 1_000_000n;
  if (b.payout_waits_until_ns !== null && BigInt(b.payout_waits_until_ns) > now) {
    const until = new Date(Number(BigInt(b.payout_waits_until_ns) / 1_000_000n)).toISOString();
    throw new Error(`an earlier claim holds its place until ${until}: retry the payout after then`);
  }
  const fees = await o.near.view(o.contract, "fees");
  return send(o.near, o.contract, o.bounty, o.signer, "retry_payout", BigInt(fees.min_retry_payout_gas) + tgas(30));
}

export function formatRetryResult(method: string, r: RetryResult): string {
  const outcome = r.refused ? `refused (${r.refused})` : "sent";
  return `${method} for ${r.bounty.protocol}/${r.bounty.name} on ${r.contract}: ${outcome} ${r.tx_hash}; the bounty is now ${r.state}`;
}
