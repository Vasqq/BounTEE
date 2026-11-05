// `bountee verify <protocol>/<name>` (R15.1): checks, from public data alone and with no keys
// or funds, that BounTEE judged, paused and paid this bounty honestly. One result per layer,
// each "pass", "fail", "not_yet" (it hasn't happened yet) or "not_yet_published":
//
// - contract_code: the bounty contract's code hash on NEAR is the reproducible build's (R15.2);
// - judge_build: the rebuilt judge's sha256 is the build the bounty's rules pin;
// - attestation: OutLayer's attestation of the winning claim's job is an Intel-signed TDX
//   quote over that job, from an approved worker build, running the pinned judge with the
//   claim's own sealed secret, and its output is the verdict the contract recorded;
// - payout: the bounty's USDC moved to the winning Whitehat, in a receipt that succeeded;
// - pause_landed / pause_verified, per signed pause: it succeeded on its chain, against the
//   covered contract; NEAR records it verified by the MPC network (R7.10);
// - rerun: the published exploit, re-run from its published header and its claim's proofs
//   (fetched from the claim's `submit_claim` transaction and checked against the recorded
//   sha256, as `rerun` does: the contract keeps no copy) under the rebuilt judge, gives the
//   enclave's verdict. Before publication it is "not_yet_published".
//   A re-run counts only under the bounty's pinned build: the same verdict from another build
//   proves nothing about the program the enclave ran, so it is a failure, naming both hashes.
//
// The rebuilt artefacts come from `bountee build` (Docker) at the commit the deployment names
// in its NEP-330 source metadata, or from `--judge-wasm`/`--contract-wasm` built beforehand.
// Transactions (the claim's job, the payout) are located in the contract's account history on
// FastNEAR's public explorer API, or given with `--tx`. The explorer is an indexer and trusted
// for nothing: it only says which hashes to look at and who signed them. Every transaction a
// check relies on is read again from NEAR RPC (`EXPERIMENTAL_tx_status`, through the archival
// RPC once an ordinary one no longer keeps it), and only what NEAR RPC returns is checked.
import { createHash } from "node:crypto";
import type { BountyId, Verdict } from "@bountee/formats";
import { checkQuote, OUTLAYER_REGISTER, type AttestationRecord } from "./attestation.ts";
import { codeHash, reproducibleBuild, resolveRev, revFromSourceMetadata, sha256File } from "./build.ts";
import { defaultRpc, evmReceipt, explorerTx } from "./chains.ts";
import { KEYSTORE_API, NEAR_EXPLORER_TX, TX_API, type Network } from "./endpoints.ts";
import { type Near } from "./near.ts";
import { postJson } from "./proofs.ts";
import { rerunPublished } from "./publish.ts";
import { loadClaimTxs, type BountyView, type ClaimView } from "./status.ts";

export type CheckStatus = "pass" | "fail" | "not_yet" | "not_yet_published";

export interface Check {
  check: "contract_code" | "judge_build" | "attestation" | "payout" | "pause_landed" | "pause_verified" | "rerun";
  status: CheckStatus;
  detail: string;
  [evidence: string]: unknown;
}

export interface VerifyResult {
  contract: string;
  bounty: BountyId;
  state: string;
  winning_claim: number | null;
  /** The commit the rebuilt artefacts came from, when `verify` built them. */
  rev: string | null;
  checks: Check[];
  /** No check failed (some may not have happened yet). */
  passed: boolean;
}

export interface VerifyOptions {
  near: Near;
  network: Network;
  contract: string;
  bounty: BountyId;
  rev?: string;
  judgeWasm?: string;
  contractWasm?: string;
  /** Chain ID → RPC URL, over the defaults, for reading pause receipts. */
  rpcs?: Record<number, string>;
  /** NEAR transactions to look in, beside those found in the contract's history. */
  txs?: string[];
  outlayerApi?: string;
  /** FastNEAR's explorer API (account history and transactions). */
  txApi?: string;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const bare = (hash: string | null | undefined) => (hash ?? "").toLowerCase().replace(/^0x/, "");

/** Receipts' outcomes, as `eventsOf` reads them. */
interface Outcomes {
  receipts: { executor_id: string; predecessor_id?: string; logs: string[]; ok: boolean }[];
}

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
interface ConfigView {
  usdc: string;
  outlayer: string;
}

/** The bounty contract's `published_exploit` view, the part `verify` reads. */
interface PublicationView {
  state: string;
  publishable_from_ns?: string;
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

const post = <T>(url: string, body: unknown) => postJson<T>(url, body, { backoffMs: 1000 });

/** The contract's transactions, newest first, a page at a time, as the explorer API lists them. */
async function* history(api: string, account: string): AsyncGenerator<string[]> {
  let resume: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await post<{ account_txs: { transaction_hash: string }[]; resume_token?: string }>(`${api}/v0/account`, {
      account_id: account,
      limit: 200,
      ...(resume ? { resume_token: resume } : {}),
    });
    yield [...new Set(r.account_txs.map((t) => t.transaction_hash))];
    if (!r.resume_token) return;
    resume = r.resume_token;
  }
}

/** A transaction as FastNEAR's explorer API lists it. */
interface IndexedTx {
  transaction?: { hash?: string; signer_id?: string };
  receipts?: { execution_outcome?: { outcome?: { executor_id?: string; logs?: string[]; status?: object } } }[];
}

/** What the explorer says a transaction is: who signed it and, as a hint of where to look, what it logged. */
interface Listed extends Outcomes {
  hash: string;
  signer_id?: string;
}

async function listTxs(api: string, hashes: string[]): Promise<Listed[]> {
  const out: Listed[] = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const r = await post<{ transactions?: (IndexedTx | null)[] }>(`${api}/v0/transactions`, { tx_hashes: hashes.slice(i, i + 20) });
    for (const t of r.transactions ?? []) {
      if (!t?.transaction?.hash) continue;
      const receipts = (t.receipts ?? []).map((x) => ({
        executor_id: x.execution_outcome?.outcome?.executor_id ?? "",
        logs: x.execution_outcome?.outcome?.logs ?? [],
        ok: !("Failure" in (x.execution_outcome?.outcome?.status ?? {})),
      }));
      out.push({ hash: t.transaction.hash, signer_id: t.transaction.signer_id, receipts });
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
async function findTxs(o: VerifyOptions, claim: ClaimView, claimId: number, wantPayout: boolean): Promise<{ judged: Tx | null; paid: Tx | null }> {
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
    const signers = new Map((await listTxs(api, known).catch(() => [])).map((t) => [t.hash, t.signer_id]));
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

async function attestationCheck(o: VerifyOptions, bounty: BountyView, config: ConfigView, claim: ClaimView & { id: number }, tx: Tx | null): Promise<Check> {
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

function payoutCheck(o: VerifyOptions, bounty: BountyView, claim: ClaimView, usdc: string, tx: Tx | null, claimId: number): Check {
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

async function pauseChecks(o: VerifyOptions, bounty: BountyView): Promise<Check[]> {
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

async function rerunCheck(o: VerifyOptions, bounty: BountyView, judgeWasm: string): Promise<Check> {
  let pub: PublicationView | null = null;
  let note = "";
  const r = await o.near.rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function",
    finality: "final",
    account_id: o.contract,
    method_name: "published_exploit",
    args_base64: Buffer.from(JSON.stringify({ id: o.bounty })).toString("base64"),
  }).catch((e: Error) => ({ error: e.message }) as { result?: number[]; error?: string });
  if (r.result) pub = JSON.parse(Buffer.from(r.result).toString("utf8"));
  else if (/MethodNotFound/.test(r.error ?? "")) note = " (this deployment predates publication)";
  else throw new Error(`published_exploit: ${r.error}`);
  if (!pub || pub.state !== "published") {
    const when = pub?.publishable_from_ns ? `; publishable from ${new Date(Number(BigInt(pub.publishable_from_ns) / 1_000_000n)).toISOString()}` : "";
    return { check: "rerun", status: "not_yet_published", detail: `the winning exploit is not yet published${when}${note}` };
  }
  try {
    const r = await rerunPublished({ near: o.near, contract: o.contract, bounty: o.bounty, judge: judgeWasm });
    const evidence = { verdict: r.verdict, enclave_verdict: r.enclave_verdict, judge_sha256: r.judge.sha256, pinned: bare(bounty.rules.judge_build_hash) };
    if (!r.judge.same_as_bounty) {
      return { check: "rerun", status: "fail", detail: `re-ran under judge ${r.judge.sha256}, not the bounty's pinned build ${bare(bounty.rules.judge_build_hash)}`, ...evidence };
    }
    return r.same_verdict
      ? { check: "rerun", status: "pass", detail: `re-ran claim ${r.claim_id} under the pinned judge to the enclave's verdict ${r.verdict.outcome} (${r.verdict.reason})`, ...evidence }
      : { check: "rerun", status: "fail", detail: `re-ran to ${r.verdict.outcome} (${r.verdict.reason}), not the enclave's verdict`, ...evidence };
  } catch (e) {
    return { check: "rerun", status: "fail", detail: (e as Error).message };
  }
}

export async function verify(o: VerifyOptions): Promise<VerifyResult> {
  const bounty = await o.near.view<BountyView | null>(o.contract, "bounty", { id: o.bounty });
  if (!bounty) throw new Error(`no bounty ${o.bounty.protocol}/${o.bounty.name} on ${o.contract}`);
  const config = await o.near.view<ConfigView>(o.contract, "config");
  const checks: Check[] = [];

  // The rebuilt artefacts: given, or built at the commit the deployment names.
  let rev: string | null = null;
  let judgeWasm = o.judgeWasm;
  let contractWasm = o.contractWasm;
  if (!judgeWasm || !contractWasm) {
    const meta = await o.near.view<unknown>(o.contract, "contract_source_metadata").catch(() => null);
    rev = resolveRev(o.rev ?? revFromSourceMetadata(meta) ?? "HEAD");
    const only = judgeWasm ? "contract" : contractWasm ? "judge" : undefined;
    const built = reproducibleBuild({ pin: o.contract, rev, only });
    judgeWasm ??= built.judge!.wasm;
    contractWasm ??= built.contract!.wasm;
  }
  const account = await o.near.rpc<{ code_hash: string }>("query", { request_type: "view_account", finality: "final", account_id: o.contract });
  const rebuiltCode = codeHash(contractWasm);
  checks.push(
    account.code_hash === rebuiltCode
      ? { check: "contract_code", status: "pass", detail: `the contract's code hash ${account.code_hash} is the rebuilt one`, code_hash: account.code_hash }
      : { check: "contract_code", status: "fail", detail: `the contract's code hash is ${account.code_hash}; the rebuild gives ${rebuiltCode}`, code_hash: account.code_hash, rebuilt: rebuiltCode },
  );
  const judgeHash = sha256File(judgeWasm);
  const pinned = bare(bounty.rules.judge_build_hash);
  checks.push(
    judgeHash === pinned
      ? { check: "judge_build", status: "pass", detail: `the rebuilt judge's sha256 ${judgeHash} is the build the bounty pins`, sha256: judgeHash }
      : { check: "judge_build", status: "fail", detail: `the bounty pins judge ${pinned}; the rebuild gives ${judgeHash}`, sha256: judgeHash, pinned },
  );

  const winner: number | null = bounty.winning_claim ?? null;
  if (winner === null) {
    checks.push({ check: "attestation", status: "not_yet", detail: "no claim has won this bounty" });
    checks.push({ check: "payout", status: "not_yet", detail: "no claim has won this bounty" });
    checks.push({ check: "rerun", status: "not_yet_published", detail: "the winning exploit is not yet published (no winner)" });
  } else {
    const claim = await o.near.view<ClaimView>(o.contract, "claim", { claim_id: winner });
    const txs = await findTxs(o, claim, winner, bounty.state === "paid");
    checks.push(await attestationCheck(o, bounty, config, { ...claim, id: winner }, txs.judged));
    checks.push(payoutCheck(o, bounty, claim, config.usdc, txs.paid, winner));
    checks.push(...(await pauseChecks(o, bounty)));
    checks.push(await rerunCheck(o, bounty, judgeWasm));
  }
  return {
    contract: o.contract,
    bounty: o.bounty,
    state: bounty.state,
    winning_claim: winner,
    rev,
    checks,
    passed: checks.every((c) => c.status !== "fail"),
  };
}

const MARK: Record<CheckStatus, string> = { pass: "pass", fail: "FAIL", not_yet: "not yet", not_yet_published: "not yet published" };

export function formatVerifyResult(r: VerifyResult): string {
  return [
    `${r.bounty.protocol}/${r.bounty.name} on ${r.contract}: ${r.state}${r.winning_claim === null ? "" : `, won by claim ${r.winning_claim}`}`,
    ...(r.rev ? [`rebuilt from commit ${r.rev}`] : []),
    ...r.checks.map((c) => `  ${MARK[c.status].padEnd(17)} ${c.check}: ${c.detail}`),
    r.passed ? "no check failed" : "SOME CHECKS FAILED",
  ].join("\n");
}
