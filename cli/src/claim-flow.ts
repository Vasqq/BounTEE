// The steps of `bountee claim` around sealing and filing (#16):
//
// - before: run `test`'s collection for the Foundry script, or reuse a saved job, and re-run
//   it if its block is too old to still be recent when the claim lands (R2.8's 300 s);
// - the claim balance: top it up with what this claim will draw, if it's short (a claim key
//   can't: then it says so and stops before filing);
// - after: wait for the enclave's verdict, and on PAYS make sure the pauses are signed (asking
//   `sign_pauses` if the verdict's callback ran out of gas for them), the bounty is paid,
//   and every signed pause is broadcast, then each chain's pause verified on NEAR once the
//   chain reports it safe (R7.3). A claim key may call only the claim actions (R14.1), so
//   signed with one, the steps needing `sign_pauses` or `verify_pause` are skipped and named,
//   as is a payout left waiting (`retry_payout`) or a claim with no verdict (`retry_claim`):
//   each as the command the Whitehat runs.
import { readFileSync } from "node:fs";
import { parseReplay, RECENCY_LIMIT_SECS, type BlockRef, type BountyId, type Replay, type Verdict } from "@bountee/formats";
import { broadcastCommand, type BroadcastResult } from "./broadcast.ts";
import { rpc } from "./proofs.ts";
import { chainLabel, proofRpcs } from "./chains.ts";
import { testCommand, type TestOptions, type TestResult } from "./test.ts";
import { verifyPauses, type VerifyResult } from "./verify-pause.ts";
import { Near, events, formatNear, milliNear, roundUpNear, tgas, type PricedCall } from "./near.ts";
import { signPauses } from "./payout.ts";

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

/**
 * The claim's block's timestamp, from its chain's RPCs (or `rpcUrl`). Only an RPC that holds that
 * very block (its hash) answers, so an RPC of another chain, given with --proof-rpc, can't
 * pass a block off as recent (R2.8).
 */
async function blockTimestamp(block: BlockRef, rpcUrl?: string): Promise<number> {
  const urls = rpcUrl ? [rpcUrl] : proofRpcs(block.chain_id);
  const errors: string[] = [];
  for (const url of urls) {
    try {
      const b = await rpc<{ hash: string; timestamp: string }>(url, "eth_getBlockByNumber", [`0x${block.number.toString(16)}`, false]);
      if (b.hash !== block.hash) throw new Error(`its block ${block.number} is ${b.hash}, not the claim's (is it ${chainLabel(block.chain_id)}'s RPC?)`);
      return Number(BigInt(b.timestamp));
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(`no RPC holds block ${block.number} of ${chainLabel(block.chain_id)}:\n${errors.join("\n")}`);
}

/** A job `bountee test` saved (`--out`), read from `path`. */
export interface SavedJob {
  path: string;
  replay: Replay;
}

/** The job saved at `path`, parsed: the claim's block, header, proofs and exploit, and the rules it was judged under. */
export function readJob(path: string): SavedJob {
  return { path, replay: parseReplay(JSON.parse(readFileSync(path, "utf8")).replay) };
}

/**
 * The inputs to claim with: those `test` saved in `job` if still recent enough, else a fresh
 * `test` run of `script`. What is submitted is exactly the saved job's block, header and proofs.
 */
export async function prepareClaim(o: { job?: SavedJob; test?: TestOptions; rpc?: string }): Promise<PreparedClaim> {
  const usable = (age: number) => age + SUBMIT_MARGIN_SECS < RECENCY_LIMIT_SECS;
  if (o.job) {
    const { replay, path } = o.job;
    const age = Math.floor(Date.now() / 1000) - (await blockTimestamp(replay.block, o.rpc));
    if (usable(age) || !o.test) {
      if (!usable(age)) throw new Error(`${path} is ${age} s old: re-run \`bountee test\` (claims must be under ${RECENCY_LIMIT_SECS} s)`);
      return { replay, local: null, saved: path, block_age_secs: age, reran: false };
    }
  }
  if (!o.test) throw new Error("claim needs a Foundry script or a saved job (--job)");
  const result = await testCommand(o.test);
  const { replay } = readJob(result.saved);
  const age = Math.floor(Date.now() / 1000) - (await blockTimestamp(replay.block, result.rpc));
  if (!usable(age)) throw new Error(`the test took too long: its block is already ${age} s old`);
  return { replay, local: result.verdict, saved: result.saved, block_age_secs: age, reran: o.job !== undefined, test: result };
}

/**
 * The size of a claim's job input, built as the contract builds it (contract `claims.rs`
 * `judge_input`): the bounty's rules, the claim's bounty, Whitehat, block and header, and its
 * proofs embedded as a JSON string, so every quote in them is escaped. The job's deposit and the
 * gas the claim attaches follow it (R11.2), so it is measured, not estimated; 64 bytes of margin
 * cover number formats. `rules` and `block` are as the contract's views return them.
 */
export function claimInputBytes(o: { rules: unknown; bounty: BountyId; whitehat: string; block: unknown; header: string; proofsJson: string }): number {
  const input = {
    judge_claim: {
      rules: o.rules,
      bounty: o.bounty,
      whitehat: o.whitehat,
      block: o.block,
      header: o.header,
      proofs_json: o.proofsJson,
      submitted_at_ns: "0".repeat(19),
    },
  };
  return Buffer.byteLength(JSON.stringify(input)) + 64;
}

/**
 * An upper bound on a claim's job input before its proofs exist (a run's budget): the proofs'
 * size with a tenth more for their escaped quotes, the header and block, and 8 KiB for the rules
 * and the rest.
 */
export function claimInputBound(proofsJsonBytes: number, headerBytes: number, blockJsonBytes: number): number {
  return Math.ceil(proofsJsonBytes * 1.1) + headerBytes + blockJsonBytes + 8192;
}

/** The most gas one NEAR transaction may attach (protocol 88, mainnet and testnet). */
export const MAX_TX_GAS = 1_000_000_000_000_000n;

/**
 * The gas a claim attaches to a contract built before it named a claim's gas by size (#35):
 * such a contract (bounty3.bountee.testnet, 7b59e73) names only `min_claim_gas` (200 Tgas), and
 * its claims were filed and rehearsed at this. It passes what is left on to the claim's job, and
 * signs the pauses in the same transaction only when enough remains (about 170 Tgas plus 20 per
 * covered contract): a two-contract bounty does, a much wider one's PAYS waits for `sign_pauses`,
 * which `claim` then sends.
 */
const CLAIM_GAS_BEFORE_SIZE_RULE = 300_000_000_000_000n;

/**
 * The gas a claim (or a retry) attaches: what `contract`'s `fees()` names for a job input of
 * `inputBytes` (an upper bound, `claimInputBytes`) on a bounty covering `covered` contracts, so
 * its job is requested and a PAYS signs every pause in the same transaction (R11.2). A contract
 * keeps the rule it was built with (none can be upgraded), so the tool reads whichever one its
 * `fees()` publishes: the size rule, or a contract from before it the gas its claims were
 * rehearsed at. Refused, before any fee, when it names neither or no transaction can carry it.
 */
export function claimGas(fees: any, inputBytes: number, covered: number, contract: string): bigint {
  let gas: bigint;
  if (fees.claim_gas_base !== undefined) {
    gas =
      BigInt(fees.claim_gas_base) +
      BigInt(covered) * BigInt(fees.claim_gas_per_covered_contract) +
      BigInt(inputBytes) * BigInt(fees.claim_gas_per_input_byte);
  } else if (fees.min_claim_gas !== undefined) {
    gas = CLAIM_GAS_BEFORE_SIZE_RULE;
  } else {
    throw new Error(`${contract}'s fees() names no claim gas (neither claim_gas_base nor min_claim_gas), so the tool can't tell what a claim must attach (nothing was spent)`);
  }
  if (gas > MAX_TX_GAS) {
    throw new Error(`this claim's proofs are too large to file: it needs ${gas / 1_000_000_000_000n} Tgas, more than a transaction's ${MAX_TX_GAS / 1_000_000_000_000n}`);
  }
  return gas;
}

/** What `submit_claim` will draw from the claim balance (contract `claims.rs`), with slack. */
export function claimCost(fees: any, inputBytes: number, sealedBytes: number): bigint {
  const perByte = BigInt(fees.storage_price_per_byte);
  const hold = BigInt(Math.max(0, inputBytes - Number(fees.job_input_free_bytes)));
  const secret = BigInt(sealedBytes + Number(fees.secret_row_overhead_bytes));
  return BigInt(fees.job_deposit) + (hold + secret + 2048n) * perByte + milliNear(10);
}

/** The gas `ensureClaimBalance`'s top-up attaches, which `checkClaimNear` prices. */
const TOP_UP_GAS = tgas(30);

/** What `whitehat`'s claim balance lacks of `cost` on `contract`. */
async function claimBalanceShort(near: Near, contract: string, whitehat: string, cost: bigint): Promise<{ have: bigint; add: bigint }> {
  const have = BigInt(await near.view<string>(contract, "claim_balance", { account_id: whitehat }));
  return { have, add: have >= cost ? 0n : cost - have };
}

/**
 * Before a claim spends anything (#57): the Whitehat holds, free of its storage stake, what its
 * claim balance lacks of `cost` and the gas both calls attach (the top-up's and `call`'s, which
 * NEAR takes up front and refunds once unused); and a claim key's allowance covers `call`'s gas.
 * A claim key can't top up, so for one only `call` is priced: `ensureClaimBalance` refuses a short
 * claim balance with its own message.
 */
export async function checkClaimNear(near: Near, contract: string, whitehat: string, cost: bigint, call: PricedCall): Promise<void> {
  const claimKey = await near.signsWithFunctionCallKey(whitehat);
  const add = claimKey ? 0n : (await claimBalanceShort(near, contract, whitehat, cost)).add;
  const callNear = await near.upfrontNear([call]);
  const need = roundUpNear(add > 0n ? await near.upfrontNear([{ method: "top_up_claim_balance", gas: TOP_UP_GAS, deposit: add, argsBytes: 2 }, call]) : callNear);
  const free = (await near.freeNear(whitehat)) ?? 0n;
  if (free < need) {
    throw new Error(
      `${whitehat} holds ${formatNear(free)} NEAR free of its storage stake and this claim needs ${formatNear(need)} in hand ` +
        `(what the claim balance lacks, and the gas its calls attach, refunded once unused): add ${formatNear(roundUpNear(need - free))} NEAR (nothing was spent)`,
    );
  }
  const allowance = claimKey ? await near.keyAllowance(whitehat) : null;
  if (allowance !== null && allowance < callNear) {
    throw new Error(
      `the claim key's allowance holds ${formatNear(allowance)} NEAR and ${call.method} takes ${formatNear(roundUpNear(callNear))} of it up front: ` +
        `add a claim key with a larger --allowance (nothing was spent)`,
    );
  }
}

/** Top the Whitehat's claim balance up to `cost` if it's short. Returns the amount added. */
export async function ensureClaimBalance(near: Near, contract: string, whitehat: string, cost: bigint): Promise<bigint> {
  const { have, add } = await claimBalanceShort(near, contract, whitehat, cost);
  if (add === 0n) return 0n;
  // A claim key (#25) can't attach a deposit: the Whitehat tops up from their own key.
  if (await near.signsWithFunctionCallKey(whitehat)) {
    throw new Error(
      `${whitehat}'s claim balance holds ${formatNear(have)} NEAR and this claim draws about ${formatNear(cost)}: a claim key can't top it up. ` +
        `Ask the Whitehat to add ${formatNear(add)} NEAR or more (top_up_claim_balance on ${contract}, signed with their own key).`,
    );
  }
  await near.account(whitehat).callFunction({ contractId: contract, methodName: "top_up_claim_balance", args: {}, deposit: add, gas: TOP_UP_GAS });
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
  /** What is left that this run didn't do, each with the command that does it. */
  next_steps: string[];
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
    next_steps: [],
  };
  if (out.state === "no_verdict") {
    out.next_steps.push(`the job ended with no verdict and the claim keeps its place (R2.6): retry it with \`bountee claim --retry ${o.claimId} --bounty ${o.bounty.protocol}/${o.bounty.name} --contract ${o.contract} --as ${o.whitehat}\``);
  }
  let bounty = await near.view(o.contract, "bounty", { id: o.bounty });
  out.bounty_state = bounty?.state;
  if (out.verdict?.outcome !== "PAYS" || bounty?.winning_claim !== o.claimId) return out;

  // The verdict's callback signs the pauses when it has the gas; otherwise it leaves the
  // bounty `signing`, waiting for `sign_pauses` (anyone may call it).
  // A claim key can call only the claim actions (R14.1): every later step that needs another
  // method is left to the Whitehat's own key, and named.
  const id = `${o.bounty.protocol}/${o.bounty.name}`;
  const flags = `--contract ${o.contract} --as ${o.whitehat}`;
  for (let tries = 0; bounty.state === "signing" && Date.now() < deadline; ) {
    if (!bounty.signing_pauses && tries < 3) {
      if (!(await near.canCall(o.whitehat, o.contract, "sign_pauses"))) {
        out.next_steps.push(`the pauses wait to be signed, and a claim key can't ask: run \`bountee sign-pauses ${id} ${flags}\` with your own key`);
        break;
      }
      tries++;
      const r = await signPauses({ near, contract: o.contract, bounty: o.bounty, signer: o.whitehat });
      out.sign_pauses_tx = r.tx_hash;
      out.events.push(...r.events);
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
  if (bounty.state === "paying" && !bounty.paying_out) {
    // Waiting for earlier claims (R3.6), or the transfer failed (R2.4): anyone may retry it.
    const until = bounty.payout_waits_until_ns ? ` after ${new Date(Number(BigInt(bounty.payout_waits_until_ns) / 1_000_000n)).toISOString()}` : "";
    out.next_steps.push(`the payout waits: run \`bountee retry-payout ${id} ${flags}\`${until}${(await near.canCall(o.whitehat, o.contract, "retry_payout")) ? "" : " with your own key"}`);
  }
  if (o.broadcast && bounty.signed_pauses?.length) {
    out.broadcast = await broadcastCommand({
      bounty: `${o.bounty.protocol}/${o.bounty.name}`,
      contract: o.contract,
      near,
      rpcs: o.rpcs,
      waitSecs: 120,
    });
    // Off the money path (R7.11): the claim is paid whatever this finds.
    if (o.verify && !(await near.canCall(o.whitehat, o.contract, "verify_pause"))) {
      out.next_steps.push(`each pause is verified on NEAR once its chain reports it safe, and a claim key can't ask: run \`bountee verify-pause ${id} ${flags}\` with your own key`);
    } else if (o.verify) {
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
  for (const step of s.next_steps) lines.push(`next: ${step}`);
  return lines.join("\n");
}

export { formatNear };
