// The checks of `bountee verify` (R15.1) that need nothing rebuilt, only public chain data:
// the winning claim's attestation, the payout, and each signed pause's landing and
// verified-pause record. `verify.ts` adds the rebuilt contract and judge and the re-run; the
// web app's Verify runs these same checks on its server (D6), so this module imports nothing
// that builds or runs code.
//
// Transactions (the claim's job, the payout) are located in the contract's account history on
// FastNEAR's public explorer API, or given with `--tx`. The explorer is an indexer and trusted
// for nothing: it only says which hashes to look at and who signed them. Every transaction a
// check relies on is read again from NEAR RPC (`EXPERIMENTAL_tx_status`, through the archival
// RPC once an ordinary one no longer keeps it), and only what NEAR RPC returns is checked.
import { createHash } from "node:crypto";
import type { BountyId } from "@bountee/formats";
import { checkQuote, OUTLAYER_REGISTER, type AttestationRecord } from "./attestation.ts";
import { defaultRpc, evmReceipt, explorerTx } from "./chains.ts";
import { KEYSTORE_API, NEAR_EXPLORER_TX, TX_API, type Network } from "./endpoints.ts";
import { history, listTxs, txSigners, type Outcomes } from "./explorer.ts";
import { type Near } from "./near.ts";
import { loadClaimTxs, type BountyView, type ClaimView } from "./status.ts";

export type CheckStatus = "pass" | "fail" | "not_yet" | "not_yet_published";

export interface Check {
  check: "contract_code" | "judge_build" | "attestation" | "payout" | "pause_landed" | "pause_verified" | "rerun";
  status: CheckStatus;
  detail: string;
  [evidence: string]: unknown;
}


/** What the chain checks read: public data alone, no keys, no funds, nothing rebuilt. */
export interface ChainCheckOptions {
  near: Near;
  network: Network;
  contract: string;
  bounty: BountyId;
  /** Chain ID → RPC URL, over the defaults, for reading pause receipts. */
  rpcs?: Record<number, string>;
  /** NEAR transactions to look in, beside those found in the contract's history. */
  txs?: string[];
  outlayerApi?: string;
  /** FastNEAR's explorer API (account history and transactions). */
  txApi?: string;
}

export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
export const bare = (hash: string | null | undefined) => (hash ?? "").toLowerCase().replace(/^0x/, "");

/** A NEAR transaction as NEAR RPC gives it: every receipt, with its outcome and its calls. */
interface Tx extends Outcomes {
  hash: string;
  signer_id: string;
  /** It carries a meta transaction (a `Delegate` action). */
  delegated: boolean;
  receipts: {
    id: string;
    predecessor_id: string;
    executor_id: string;
    /** The block the receipt ran in. */
    block_hash: string;
    logs: string[];
    ok: boolean;
    calls: { method_name: string; args: string }[];
  }[];
}

/** NEAR RPC's `EXPERIMENTAL_tx_status` result, the parts read here. */
interface TxStatus {
  transaction: { hash: string; signer_id: string; actions: unknown[] };
  receipts: { receipt_id: string; predecessor_id: string; receipt: { Action?: { actions: unknown[] } } }[];
  receipts_outcome: { id: string; block_hash: string; outcome: { executor_id: string; logs: string[]; status: unknown } }[];
}

/** A NEP-297 event's data: the fields each check reads are checked where they are read. */
type EventData = Record<string, unknown>;

/** The bounty contract's `config` view, the part `verify` reads. */
export interface ConfigView {
  usdc: string;
  outlayer: string;
}

type Event = { event: string; data: EventData; executor_id: string; predecessor_id?: string; ok: boolean };

function eventsOf(tx: Outcomes): Event[] {
  const out: Event[] = [];
  for (const r of tx.receipts) {
    for (const log of r.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const e = JSON.parse(log.slice("EVENT_JSON:".length));
        for (const data of Array.isArray(e.data) ? e.data : [e.data]) {
          out.push({ event: e.event, data, executor_id: r.executor_id, predecessor_id: r.predecessor_id, ok: r.ok });
        }
      } catch {
        // not an event
      }
    }
  }
  return out;
}

const succeeded = (status: unknown) => typeof status === "object" && status !== null && ("SuccessValue" in status || "SuccessReceiptId" in status);

/** The transaction as NEAR RPC has it (the archival RPC once an ordinary one has dropped it), or null. */
async function nearTx(near: Near, hash: string, signer: string): Promise<Tx | null> {
  for (const rpc of near.withArchive()) {
    const r = await rpc.rpc<TxStatus>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" }).catch(() => null);
    if (r?.transaction?.hash !== hash) continue;
    const receipts = new Map(r.receipts.map((x) => [x.receipt_id, x]));
    return {
      hash,
      signer_id: r.transaction.signer_id,
      delegated: r.transaction.actions.some((a) => typeof a === "object" && a !== null && "Delegate" in a),
      receipts: r.receipts_outcome.map((x) => {
        const receipt = receipts.get(x.id);
        const calls = (receipt?.receipt.Action?.actions ?? []).flatMap((a) => {
          const call = typeof a === "object" && a !== null ? (a as { FunctionCall?: { method_name: string; args: string } }).FunctionCall : undefined;
          return call ? [call] : [];
        });
        return {
          id: x.id,
          predecessor_id: receipt?.predecessor_id ?? "",
          executor_id: x.outcome.executor_id,
          block_hash: x.block_hash,
          logs: x.outcome.logs,
          ok: succeeded(x.outcome.status),
          calls,
        };
      }),
    };
  }
  return null;
}

/**
 * The transactions holding the winning claim's verdict (`claim_judged`) and its payout
 * (`bounty_paid`), as NEAR RPC has them: from `--tx` and `claim`'s saved list first, then the
 * contract's history on the explorer, whose own account of a transaction only says which
 * ones to read from NEAR RPC.
 */
async function findTxs(o: ChainCheckOptions, claim: ClaimView, claimId: number, wantPayout: boolean): Promise<{ judged: Tx | null; paid: Tx | null }> {
  const api = o.txApi ?? TX_API[o.network];
  let judged: Tx | null = null;
  let paid: Tx | null = null;
  const logs = (t: Outcomes, event: string) => eventsOf(t).some((e) => e.event === event && e.executor_id === o.contract && e.data.claim_id === claimId);
  const done = () => judged !== null && (paid !== null || !wantPayout);
  const read = async (hash: string, signer: string | undefined) => {
    const tx = await nearTx(o.near, hash, signer ?? claim.whitehat);
    if (!tx) return;
    if (!judged && logs(tx, "claim_judged")) judged = tx;
    if (!paid && logs(tx, "bounty_paid")) paid = tx;
  };
  const known = [...new Set([...(o.txs ?? []), ...loadClaimTxs(o.contract, claimId)])];
  if (known.length > 0) {
    const signers = await txSigners(api, known);
    for (const hash of known) {
      await read(hash, signers.get(hash));
      if (done()) return { judged, paid };
    }
  }
  for await (const page of history(api, o.contract)) {
    for (const t of await listTxs(api, page)) {
      if ((!judged && logs(t, "claim_judged")) || (wantPayout && !paid && logs(t, "bounty_paid"))) await read(t.hash, t.signer_id);
      if (done()) return { judged, paid };
    }
  }
  return { judged, paid };
}

/** A block's height, from NEAR RPC (the archival RPC once an ordinary one has dropped it), or null. */
async function blockHeight(near: Near, hash: string): Promise<number | null> {
  for (const rpc of near.withArchive()) {
    const b = await rpc.rpc<{ header: { height: number } }>("block", { block_id: hash }).catch(() => null);
    if (b) return b.header.height;
  }
  return null;
}

/**
 * Whether OutLayer's `input_hash` is SHA-256 of the claim's job input, as the bounty contract
 * builds it (contract/src/claims.rs `judge_input`) from the claim's record: the bounty's
 * rules, the claim's bounty, Whitehat, block, header, proofs and submission time. The
 * contract keeps only the proofs' sha256, so they are read from the request's own arguments
 * on NEAR and checked against it.
 */
function inputProblems(a: AttestationRecord, request: Tx["receipts"][number], bounty: BountyView, claim: ClaimView & { id: number }): string[] {
  let proofs: unknown;
  try {
    const call = request.calls.find((c) => c.method_name === "request_execution");
    const args = JSON.parse(Buffer.from(call?.args ?? "", "base64").toString("utf8")) as { input_data: string };
    proofs = (JSON.parse(args.input_data) as { judge_claim?: { proofs_json?: unknown } }).judge_claim?.proofs_json;
  } catch {
    proofs = undefined;
  }
  if (typeof proofs !== "string" || `0x${sha256(proofs)}` !== claim.proofs_sha256.toLowerCase()) {
    return [`the job's input carries other proofs than claim ${claim.id}'s`];
  }
  const input = JSON.stringify({
    judge_claim: {
      rules: bounty.rules,
      bounty: claim.bounty,
      whitehat: claim.whitehat,
      block: claim.block,
      header: claim.header,
      proofs_json: proofs,
      submitted_at_ns: claim.submitted_at_ns,
    },
  });
  return bare(a.input_hash) === sha256(input) ? [] : [`its input isn't claim ${claim.id}'s job input (sha256 ${sha256(input)})`];
}

async function attestationCheck(o: ChainCheckOptions, bounty: BountyView, config: ConfigView, claim: ClaimView & { id: number }, tx: Tx | null): Promise<Check> {
  if (!tx) return { check: "attestation", status: "fail", detail: "no transaction NEAR RPC knows holds the winning claim's verdict" };
  const url = `${o.outlayerApi ?? KEYSTORE_API[o.network]}/attestations/by-tx/${tx.hash}`;
  const res = await fetch(url, { headers: { "User-Agent": "bountee-cli" } }).catch(() => null);
  if (!res?.ok) return { check: "attestation", status: "fail", detail: `OutLayer has no attestation for ${tx.hash}`, url };
  const a = (await res.json()) as AttestationRecord;
  const problems: string[] = [];
  const pinned = bare(bounty.rules.judge_build_hash);
  const quote = checkQuote(a);
  problems.push(...quote.problems);
  if (quote.measurements) {
    const approved = await o.near
      .view<boolean>(OUTLAYER_REGISTER[o.network], "is_measurements_approved", { measurements: quote.measurements })
      .catch(() => false);
    if (!approved) problems.push(`the worker's measurements aren't approved by ${OUTLAYER_REGISTER[o.network]}`);
  }
  if (bare(a.wasm_hash) !== pinned) problems.push(`it ran judge ${a.wasm_hash}, not the bounty's pinned build ${pinned}`);
  if (a.executed_wasm_sha256 && bare(a.executed_wasm_sha256) !== pinned) problems.push(`the executed wasm was ${a.executed_wasm_sha256}`);
  const secret = `${o.contract}/${claim.secret_profile}`;
  if (a.secrets_ref !== secret) problems.push(`it read secret ${a.secrets_ref}, not the claim's ${secret}`);
  const verdict = JSON.stringify(claim.verdict);
  if (bare(a.output_hash) !== sha256(verdict)) problems.push(`its output isn't the recorded verdict ${verdict}`);
  // The job's request, as NEAR RPC has it: OutLayer's receipt logging `execution_requested`
  // for this request id; its predecessor is the account that asked for the job.
  const request = tx.receipts
    .filter((r) => r.executor_id === config.outlayer && r.ok)
    .flatMap((r) =>
      eventsOf({ receipts: [r] })
        .filter((e) => e.event === "execution_requested")
        .map((e) => {
          try {
            return { receipt: r, data: JSON.parse(String(e.data.request_data)) as { request_id?: number; predecessor_id?: string } };
          } catch {
            return null;
          }
        }),
    )
    .find((x) => x?.data.request_id === a.request_id);
  if (!request) problems.push(`the transaction requested no job ${a.request_id} from ${config.outlayer}`);
  else {
    const by = request.receipt.predecessor_id !== o.contract ? request.receipt.predecessor_id : request.data.predecessor_id;
    if (by !== o.contract) problems.push(`job ${a.request_id} was requested by ${by}, not the bounty contract`);
    // OutLayer's worker names the block the request's event was logged in as the job's.
    const height = await blockHeight(o.near, request.receipt.block_hash);
    if (a.block_height !== height) {
      problems.push(`it names NEAR block ${a.block_height}, but job ${a.request_id} was requested in block ${height ?? `${request.receipt.block_hash} (unknown to NEAR RPC)`}`);
    }
    problems.push(...inputProblems(a, request.receipt, bounty, claim));
  }
  // OutLayer names as the job's caller the transaction's signer (the request's `sender_id`),
  // or for a meta transaction the account that made the request (worker/src/event_monitor.rs).
  // It doesn't attest the request's predecessor: that the bounty contract asked for the job
  // is the request receipt's predecessor on NEAR, above.
  const caller = tx.delegated ? o.contract : tx.signer_id;
  if (a.caller_account_id !== caller) {
    problems.push(`it names caller ${a.caller_account_id}, not the ${tx.delegated ? "meta transaction's requester" : "transaction's signer"} ${caller}`);
  }
  const evidence = { url, task_id: a.task_id, request_id: a.request_id, transaction_hash: tx.hash, wasm_hash: a.wasm_hash, measurements: quote.measurements };
  return problems.length === 0
    ? { check: "attestation", status: "pass", detail: `Intel-signed TDX quote: OutLayer task ${a.task_id} ran the pinned judge on claim ${claim.id}'s job and output ${verdict}`, ...evidence }
    : { check: "attestation", status: "fail", detail: problems.join("; "), ...evidence };
}

function payoutCheck(o: ChainCheckOptions, bounty: BountyView, claim: ClaimView, usdc: string, tx: Tx | null, claimId: number): Check {
  if (bounty.state !== "paid") return { check: "payout", status: "not_yet", detail: `the bounty is ${bounty.state}, not paid` };
  if (!tx) return { check: "payout", status: "fail", detail: `the bounty is paid, but no transaction shows claim ${claimId}'s payout` };
  const amount = String(bounty.rules.bounty_amount);
  const transfer = eventsOf(tx).find(
    (e) =>
      e.event === "ft_transfer" &&
      e.executor_id === usdc &&
      e.predecessor_id === o.contract &&
      e.ok &&
      e.data.new_owner_id === claim.whitehat &&
      String(e.data.amount) === amount,
  );
  const link = `${NEAR_EXPLORER_TX[o.network]}${tx.hash}`;
  return transfer
    ? { check: "payout", status: "pass", detail: `${amount} of ${usdc} moved to ${claim.whitehat}`, tx_hash: tx.hash, link }
    : { check: "payout", status: "fail", detail: `${tx.hash} records the payout, but no ${usdc} transfer of ${amount} to ${claim.whitehat} succeeded on NEAR`, tx_hash: tx.hash };
}

async function pauseChecks(o: ChainCheckOptions, bounty: BountyView): Promise<Check[]> {
  const signed = bounty.signed_pauses ?? [];
  const verifications = await o.near.view<{ verified_pauses?: string[] }[]>(o.contract, "pause_verifications", { id: bounty.id }).catch(() => []);
  const checks: Check[] = [];
  for (const p of signed) {
    const where = { chain_id: p.chain_id, contract: p.contract, tx_hash: p.tx_hash, link: explorerTx(p.chain_id, p.tx_hash) };
    const url = o.rpcs?.[p.chain_id] ?? defaultRpc(p.chain_id);
    let landed: Check;
    if (!url) landed = { check: "pause_landed", status: "fail", detail: `no RPC known for chain ${p.chain_id} (pass --rpc)`, ...where };
    else {
      const r = await evmReceipt(url, p.tx_hash);
      if (!r) landed = { check: "pause_landed", status: "not_yet", detail: `the pause hasn't landed on chain ${p.chain_id}`, ...where };
      else if (r.status !== "success") landed = { check: "pause_landed", status: "fail", detail: `the pause reverted on chain ${p.chain_id}`, ...where };
      else if ((r.to ?? "").toLowerCase() !== p.contract.toLowerCase()) {
        landed = { check: "pause_landed", status: "fail", detail: `the transaction landed, but called ${r.to}, not ${p.contract}`, ...where };
      } else landed = { check: "pause_landed", status: "pass", detail: `paused ${p.contract} on chain ${p.chain_id} in block ${r.block}`, block: r.block, ...where };
    }
    checks.push(landed);
    const verified = verifications.some((c) => (c.verified_pauses ?? []).some((h) => h.toLowerCase() === p.tx_hash.toLowerCase()));
    checks.push(
      verified
        ? { check: "pause_verified", status: "pass", detail: `NEAR records the pause on chain ${p.chain_id} verified by the MPC network`, ...where }
        : { check: "pause_verified", status: "not_yet", detail: `NEAR doesn't record the pause on chain ${p.chain_id} as verified yet`, ...where },
    );
  }
  return checks;
}

/**
 * The checks that need nothing rebuilt, only public chain data: the winning claim's
 * attestation, the payout, and each signed pause's landing and verified-pause record. The web
 * app's Verify runs these same checks (D6).
 */
export async function chainChecks(o: ChainCheckOptions, bounty: BountyView, config: ConfigView): Promise<Check[]> {
  const winner: number | null = bounty.winning_claim ?? null;
  if (winner === null) {
    return [
      { check: "attestation", status: "not_yet", detail: "no claim has won this bounty" },
      { check: "payout", status: "not_yet", detail: "no claim has won this bounty" },
    ];
  }
  const claim = await o.near.view<ClaimView>(o.contract, "claim", { claim_id: winner });
  const txs = await findTxs(o, claim, winner, bounty.state === "paid");
  return [
    await attestationCheck(o, bounty, config, { ...claim, id: winner }, txs.judged),
    payoutCheck(o, bounty, claim, config.usdc, txs.paid, winner),
    ...(await pauseChecks(o, bounty)),
  ];
}
