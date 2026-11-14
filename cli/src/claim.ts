// `bountee claim`: seal the exploit on this machine, file it with the bounty contract, and
// see it through (#15: sealing and submission; #16: the Foundry-script path, the verdict,
// the payout and the pauses).
//
//   bountee claim [<foundry-script>[:<contract>]] --contract <bounty contract>
//                 --bounty <protocol>/<name> --as <account>
//                 [--chain <name | chain id>] [--sig <fn>] [--job <saved test job.json>]
//                 [--exploit <exploit.json> --evidence <{block, header, proofs}.json>]
//                 [--network testnet|mainnet] [--rpc <NEAR rpc>] [--proof-rpc <chain rpc>]
//                 [--outlayer-api <url>] [--chain-rpc <chain id>=<url>[,...]]
//                 [--timeout <secs>] [--interval <secs>]
//                 [--no-wait] [--no-broadcast] [--no-verify] [--verify-wait <secs>]
//                 [--dry-run] [--json]
//   bountee claim --retry <claim id> --contract <bounty contract> --as <account>
//                 [--bounty <protocol>/<name>] [--tx <hash>[,...] | --job <job.json> | --evidence <evidence.json>]
//                 [the same network, wait and follow flags]
//
// `--retry` retries a claim whose enclave job ended with no verdict (R2.6): `retry_claim` with
// the proofs it was filed with (read back from its saved `submit_claim` transaction, or from
// `--tx`, `--job` or `--evidence`, and checked against the sha256 the contract kept), then sees
// it through as below. It keeps its place and its original submission time; the new job is
// drawn from the claim balance. A claim key may retry (R14.1).
//
// With a Foundry script (or `--job`, a job `bountee test` saved), claim runs `test`'s
// collection and submits exactly the inputs it judged, re-running it if the saved block is
// too old to still be recent when the claim lands (D2, D3, R2.8). The exploit is sealed for
// the account filing the claim, to the judge build the bounty contract pins (read from its
// `config`), with the contract as the secret's owner (R5.1, R5.3, R5.4). Only the sealed text
// is sent. The claim balance is topped up with what the claim draws if it's short. Then it
// waits for the verdict; on PAYS it sees the pauses signed and the bounty paid, and
// broadcasts every signed pause, then has each chain's pause verified on NEAR once that chain
// reports it safe, which takes minutes (R7.3; `--no-verify` skips it, `bountee verify-pause`
// does it later; `--verify-wait`, default 3600 s, bounds the wait for the safe head).
// `--dry-run` seals and prints without filing.
//
// From filing on, each stage of the claim is shown the moment the chains show it (D23:
// sealed, checking, the verdict, and on PAYS pauses signed, paid, then each pause landed and
// verified), until nothing more will happen or `--timeout` (default 30 min: a pause is
// verified only once its chain's safe head passes it). A paid claim ends with its receipt
// (D24). The transactions sent are saved under `.bountee/claims/`, so `bountee status` can
// build the receipt again later. Signed with a claim key, which may call only `submit_claim`
// and `retry_claim` (R14.1), the steps that need another method (`sign_pauses`,
// `verify_pause`, `retry_payout`) are skipped, and `next_steps` names the command the
// Whitehat runs with their own key for each.
import { readFileSync } from "node:fs";
import { actions } from "near-api-js";
import { BARE_FLAGS } from "./usage.ts";
import { parseBlockRef, parseExploit, parseAccountProof, parseRules, type BlockRef, type BountyId, type Exploit, type Rules, type Verdict } from "@bountee/formats";
import { parseBountyId, proofChain, refuseUncovered } from "./bounties.ts";
import { chainLabel, parseChain } from "./chains.ts";
import { parseRpcFlags } from "./broadcast.ts";
import { checkClaimNear, claimCost, claimGas, claimInputBytes, ensureClaimBalance, prepareClaim, readJob, settle, type Settlement } from "./claim-flow.ts";
import { proofsMatchingClaim, type ProofsSource } from "./claim-proofs.ts";
import { KEYSTORE_API, NEAR_RPC, type Network } from "./endpoints.ts";
import { formatNear, Near, parseNetwork } from "./near.ts";
import { seal } from "./seal.ts";
import { describeError, isNetworkError } from "./transport.ts";
import {
  claimStatus,
  formatReceipt,
  loadClaimTxs,
  saveClaimTxs,
  watchClaim,
  type ClaimStatus,
  type ClaimView,
  type Receipt,
  type Stage,
  type StatusOptions,
} from "./status.ts";


function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function required(args: string[], name: string): string {
  const v = flag(args, name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

/** The first argument that is neither a flag nor a flag's value. */
function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (BARE_FLAGS.has(args[i]!)) continue;
    if (args[i]!.startsWith("--")) { i++; continue; }
    return args[i];
  }
  return undefined;
}

const sameId = (a: BountyId, b: BountyId) => a.protocol === b.protocol && a.name === b.name;

/**
 * Refuse, before any EVM call or fee (D26), a saved job or evidence proven on `chain` (its
 * block's) when the bounty covers no contract there, when --chain is missing on a multi-chain
 * bounty, or when it names another chain. A dry run, which files nothing, reads no `rules`,
 * so only the last is checked there.
 */
function checkProvenOn(chain: number, named: number | undefined, rules: Rules | undefined): void {
  if (rules) refuseUncovered(rules, chain);
  if (named === chain) return;
  // The Whitehat names the chain as for `test`: required on a multi-chain bounty (D26).
  const chosen = rules ? proofChain(rules, named) : named;
  if (chosen !== undefined && chosen !== chain) {
    throw new Error(`the claim is proven on ${chainLabel(chain)}, not ${chainLabel(chosen)}: test it again on ${chainLabel(chosen)}`);
  }
}

/**
 * Where the proofs a claim was filed with are read from: `--job` or `--evidence` if given,
 * else the claim's own transactions on NEAR (saved by `claim` under `.bountee/claims/`, or
 * `--tx`). The contract keeps only their sha256.
 */
function filedProofsSource(args: string[], contract: string, claimId: number, whitehat: string): ProofsSource {
  const file = flag(args, "job") ?? flag(args, "evidence");
  if (file) return { file };
  return { txs: flag(args, "tx")?.split(",") ?? loadClaimTxs(contract, claimId), signer: whitehat };
}

export interface ClaimResult {
  bounty_contract: string;
  /** The judge build sealed to, and the sealed text; absent on a retry, which seals nothing. */
  judge_build_hash?: string;
  sealed_exploit?: string;
  /** This run retried a claim left with no verdict (`--retry`, R2.6) rather than filing one. */
  retried?: boolean;
  /** The verdict `bountee test` gave these exact inputs (D2); null when claiming from --exploit/--evidence or an unre-run --job. */
  local_verdict?: Verdict | null;
  saved?: string;
  block?: BlockRef;
  block_age_secs?: number;
  topped_up_near?: string;
  claim_id?: number;
  tx_hash?: string;
  /** The enclave's verdict, once the claim is judged. */
  verdict?: Verdict | null;
  state?: string;
  submitted_at_ns?: string;
  bounty_state?: string;
  paid?: boolean;
  sign_pauses_tx?: string;
  broadcast?: Settlement["broadcast"];
  verification?: Settlement["verification"];
  /** Every stage the claim reached, as shown live (D23). */
  stages?: Stage[];
  /** On a paid claim: the payout, attestation and each pause's transaction (D24). */
  receipt?: Receipt;
  /** What is left that this run didn't do, each with the command that does it. */
  next_steps?: string[];
}

export async function claim(args: string[], onStage: (s: Stage) => void = () => {}): Promise<ClaimResult> {
  const network = parseNetwork(flag(args, "network"));
  const contract = required(args, "contract");
  const bountyText = flag(args, "retry") === undefined ? required(args, "bounty") : flag(args, "bounty");
  const given = bountyText === undefined ? undefined : parseBountyId(bountyText);
  const whitehat = required(args, "as");
  const near = new Near(network, flag(args, "rpc") ?? NEAR_RPC[network]);
  if (flag(args, "retry") !== undefined) return retryClaim(args, { near, network, contract, whitehat, given }, onStage);
  const bounty = given!;
  const named = parseChain(flag(args, "chain"));

  // A dry run only seals, filing and spending nothing, so it reads no bounty: its rules, and so the covered chains, stay unread.
  let rules: Rules | undefined;
  let liveRules: unknown;
  if (!args.includes("--dry-run")) {
    const live = await near.view<{ state: string; rules: unknown } | null>(contract, "bounty", { id: bounty });
    if (!live) throw new Error(`no bounty ${bountyText} on ${contract}`);
    if (live.state !== "live") throw new Error(`bounty ${bountyText} is ${live.state}: it takes no claims${live.state === "paid" || live.state === "signing" || live.state === "paying" ? " (it has been won)" : ""}`);
    rules = parseRules(live.rules);
    liveRules = live.rules;
  }

  let exploit: Exploit;
  let block, header: string, proofs;
  const result: Partial<ClaimResult> = {};
  const script = positional(args);
  if (script || flag(args, "job")) {
    const jobFile = flag(args, "job");
    const job = jobFile === undefined ? undefined : readJob(jobFile);
    // A saved job names its chain in its block (D1): it is claimed there, the chain --chain names.
    if (job) checkProvenOn(job.replay.block.chain_id, named, rules);
    const prepared = await prepareClaim({
      job,
      rpc: flag(args, "proof-rpc"),
      test: script
        ? { script, bounty: bountyText!, sig: flag(args, "sig"), rpc: flag(args, "proof-rpc"), contract, chain: named, near }
        : undefined,
    });
    ({ exploit, block, header, proofs } = prepared.replay);
    Object.assign(result, { local_verdict: prepared.local, saved: prepared.saved, block, block_age_secs: prepared.block_age_secs });
  } else {
    exploit = parseExploit(JSON.parse(readFileSync(required(args, "exploit"), "utf8")));
    const evidence = JSON.parse(readFileSync(required(args, "evidence"), "utf8"));
    block = parseBlockRef(evidence.block);
    checkProvenOn(block.chain_id, named, rules);
    proofs = (evidence.proofs as unknown[]).map(parseAccountProof);
    header = String(evidence.header);
  }

  const config = await near.provider.callFunction<{ judge_build_hash: string }>({ contractId: contract, method: "config", args: {} });
  if (!config?.judge_build_hash) throw new Error(`${contract} has no judge build pinned`);
  const sealed = await seal({
    api: flag(args, "outlayer-api") ?? KEYSTORE_API[network],
    judgeHash: config.judge_build_hash,
    bountyContract: contract,
    whitehat,
    exploit,
  });
  const out: ClaimResult = { bounty_contract: contract, judge_build_hash: config.judge_build_hash, sealed_exploit: sealed, ...result };
  if (args.includes("--dry-run")) return out;
  // Filing waits for the whole claim transaction, often the verdict too: say it's sealed first.
  onStage({ stage: "sealed", claim_id: null });

  const proofsJson = JSON.stringify(proofs);
  const fees = await near.view(contract, "fees");
  const inputBytes = claimInputBytes({ rules: liveRules, bounty, whitehat, block, header, proofsJson });
  const cost = claimCost(fees, inputBytes, sealed.length);
  const gas = claimGas(fees, inputBytes, rules!.covered_contracts.length, contract);
  const submitArgs = { bounty, block, header, proofs: proofsJson, sealed_exploit: sealed };
  await checkClaimNear(near, contract, whitehat, cost, { method: "submit_claim", gas, deposit: 0n, argsBytes: JSON.stringify(submitArgs).length });
  const added = await ensureClaimBalance(near, contract, whitehat, cost);
  if (added > 0n) out.topped_up_near = formatNear(added);

  let outcome;
  try {
    outcome = await near.account(whitehat).signAndSendTransaction({
      receiverId: contract,
      actions: [actions.functionCall("submit_claim", submitArgs, gas, 0n)],
      waitUntil: "EXECUTED_OPTIMISTIC",
      throwOnFailure: false,
    });
  } catch (e) {
    throw mayHaveLanded(e, `${whitehat}'s submit_claim on ${contract}`, "the claim may have been filed", "file");
  }
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
  if (status.SuccessValue === undefined) {
    throw new Error(`the claim was refused: ${JSON.stringify(status.Failure ?? status)}`);
  }
  out.claim_id = Number(JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8")));
  out.tx_hash = outcome.transaction.hash;
  saveClaimTxs(contract, out.claim_id, [out.tx_hash]);
  // Filed: say so with its ID before following it, so a failure after this point never
  // leaves the Whitehat unsure whether the claim exists (#35).
  onStage({ stage: "sealed", claim_id: out.claim_id, tx_hash: out.tx_hash });
  if (args.includes("--no-wait")) return out;
  return seeThrough(args, { near, network, contract, whitehat, bounty }, out, [out.tx_hash], new Set(["sealed"]), onStage);
}

/**
 * A send that got no answer from NEAR, after the transport's own resends, may still have
 * landed: running it again could pay for a second claim or job (#35). Say so, rather than
 * report a plain failure. Any other error is a failure before anything was sent.
 */
function mayHaveLanded(e: unknown, what: string, may: string, again: string): unknown {
  if (!isNetworkError(e)) return e;
  return new Error(`${may} (no answer from NEAR: ${describeError(e)}). Don't ${again} again: look for ${what} first`);
}

interface Context {
  near: Near;
  network: Network;
  contract: string;
  whitehat: string;
}

/**
 * Retry a claim whose job ended with no verdict (R2.6): `retry_claim` with the proofs it was
 * filed with, drawing the new job's deposit from the claim balance, then see it through as a
 * new claim is. The claim keeps its place and its original submission time.
 */
async function retryClaim(args: string[], c: Context & { given?: BountyId }, onStage: (s: Stage) => void): Promise<ClaimResult> {
  const claimId = Number(flag(args, "retry"));
  if (!Number.isSafeInteger(claimId) || claimId < 0) throw new Error(`--retry takes a claim id: got ${flag(args, "retry")}`);
  const filed = await c.near.view<ClaimView | null>(c.contract, "claim", { claim_id: claimId });
  if (!filed) throw new Error(`no claim ${claimId} on ${c.contract}`);
  if (filed.whitehat !== c.whitehat) throw new Error(`claim ${claimId} was filed by ${filed.whitehat}: only its Whitehat may retry it`);
  if (c.given && !sameId(c.given, filed.bounty)) throw new Error(`claim ${claimId} is on ${filed.bounty.protocol}/${filed.bounty.name}, not ${c.given.protocol}/${c.given.name}`);
  if (filed.state !== "no_verdict") throw new Error(`claim ${claimId} is ${filed.state}: only a claim left with no verdict can be retried`);

  const proofs = await proofsMatchingClaim(c.near, c.contract, { ...filed, id: claimId }, filedProofsSource(args, c.contract, claimId, c.whitehat));
  const out: ClaimResult = { bounty_contract: c.contract, retried: true, claim_id: claimId, block: filed.block };
  const fees = await c.near.view(c.contract, "fees");
  // The new job's input is the claim's own; no secret is stored again.
  const live = await c.near.view<{ rules: Rules }>(c.contract, "bounty", { id: filed.bounty });
  const inputBytes = claimInputBytes({ rules: live.rules, bounty: filed.bounty, whitehat: c.whitehat, block: filed.block, header: filed.header, proofsJson: proofs });
  const cost = claimCost(fees, inputBytes, 0);
  const gas = claimGas(fees, inputBytes, live.rules.covered_contracts.length, c.contract);
  const retryArgs = { claim_id: claimId, proofs };
  await checkClaimNear(c.near, c.contract, c.whitehat, cost, { method: "retry_claim", gas, deposit: 0n, argsBytes: JSON.stringify(retryArgs).length });
  const added = await ensureClaimBalance(c.near, c.contract, c.whitehat, cost);
  if (added > 0n) out.topped_up_near = formatNear(added);

  let outcome;
  try {
    outcome = await c.near.account(c.whitehat).signAndSendTransaction({
      receiverId: c.contract,
      actions: [actions.functionCall("retry_claim", retryArgs, gas, 0n)],
      waitUntil: "EXECUTED_OPTIMISTIC",
      throwOnFailure: false,
    });
  } catch (e) {
    throw mayHaveLanded(e, `${c.whitehat}'s retry_claim of claim ${claimId} on ${c.contract}`, "the retry may have been sent", "retry");
  }
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
  if (status.SuccessValue === undefined) throw new Error(`the retry was refused: ${JSON.stringify(status.Failure ?? status)}`);
  out.tx_hash = outcome.transaction.hash;
  const txs = [...new Set([...loadClaimTxs(c.contract, claimId), out.tx_hash])];
  saveClaimTxs(c.contract, claimId, txs);
  if (args.includes("--no-wait")) return out;
  return seeThrough(args, { ...c, bounty: filed.bounty }, out, txs, new Set(["sealed", "checking"]), onStage);
}

/** See the claim through (settle) while following it (watchClaim), side by side. */
async function seeThrough(
  args: string[],
  c: Context & { bounty: BountyId },
  out: ClaimResult,
  txs: string[],
  seen: Set<string>,
  onStage: (s: Stage) => void,
): Promise<ClaimResult> {
  const claimId = out.claim_id!;
  const txHash = out.tx_hash!;
  const chainRpc = flag(args, "chain-rpc");
  const chainRpcs = chainRpc === undefined ? undefined : parseRpcFlags(chainRpc.split(","));
  const statusOptions: StatusOptions = {
    contract: c.contract,
    claimId,
    network: c.network,
    near: c.near,
    rpcs: chainRpcs,
    outlayerApi: flag(args, "outlayer-api"),
    txApi: flag(args, "tx-api"),
    txs,
  };
  let failed = false;
  const settling = settle(c.near, {
    contract: c.contract,
    bounty: c.bounty,
    claimId,
    txHash,
    whitehat: c.whitehat,
    broadcast: !args.includes("--no-broadcast"),
    verify: !args.includes("--no-broadcast") && !args.includes("--no-verify"),
    verifyWaitSecs: flag(args, "verify-wait") === undefined ? undefined : Number(flag(args, "verify-wait")),
    rpcs: chainRpcs,
  }).catch((e) => {
    failed = true;
    throw e;
  });
  const following = watchClaim(statusOptions, onStage, {
    timeoutSecs: flag(args, "timeout") === undefined ? 1800 : Number(flag(args, "timeout")),
    intervalSecs: flag(args, "interval") === undefined ? undefined : Number(flag(args, "interval")),
    stop: () => failed,
    seen, // the stages shown before filing
  });
  const [s, followed] = await Promise.all([settling, following]);
  let last: ClaimStatus = followed;
  if (s.sign_pauses_tx) {
    // The payout may sit in the `sign_pauses` retry's transaction rather than the claim's.
    statusOptions.txs = [...txs, s.sign_pauses_tx];
    saveClaimTxs(c.contract, claimId, statusOptions.txs);
    if (last.receipt && !last.receipt.payout) last = await claimStatus(statusOptions);
  }
  return {
    ...out,
    verdict: s.verdict,
    state: s.state,
    submitted_at_ns: s.submitted_at_ns,
    bounty_state: s.bounty_state,
    ...(s.paid !== undefined ? { paid: s.paid } : {}),
    ...(s.sign_pauses_tx ? { sign_pauses_tx: s.sign_pauses_tx } : {}),
    ...(s.broadcast ? { broadcast: s.broadcast } : {}),
    ...(s.verification ? { verification: s.verification } : {}),
    next_steps: s.next_steps,
    stages: last.stages,
    ...(last.receipt ? { receipt: last.receipt } : {}),
  };
}


export function formatClaimResult(r: ClaimResult): string {
  if (r.claim_id === undefined) return `sealed for ${r.bounty_contract} (judge ${r.judge_build_hash}); not filed (--dry-run)`;
  const lines = [`claim ${r.claim_id} ${r.retried ? "retried" : "filed"}: ${r.tx_hash}`];
  if (r.local_verdict) lines.push(`bountee test said: ${r.local_verdict.outcome} (${r.local_verdict.reason})`);
  if (r.topped_up_near) lines.push(`claim balance topped up by ${r.topped_up_near} NEAR`);
  if (r.state) lines.push(`enclave: ${r.state}${r.verdict ? ` ${r.verdict.outcome} (${r.verdict.reason})` : " (no verdict)"}`);
  if (r.bounty_state) lines.push(`bounty: ${r.bounty_state}${r.paid ? " (paid to you)" : ""}`);
  if (r.sign_pauses_tx) lines.push(`pauses signed by retry: ${r.sign_pauses_tx}`);
  for (const p of r.broadcast?.pauses ?? []) lines.push(`pause on ${p.chain_id} ${p.contract}: ${p.sent} ${p.tx_hash}${p.receipt ? ` (${p.receipt.status})` : ""}`);
  for (const c of r.verification?.chains ?? []) lines.push(`pause on ${c.chain_id}: ${c.verified ? "verified on NEAR" : `not verified (${c.error ?? "unknown"})`}`);
  if (r.receipt) lines.push(formatReceipt(r.receipt));
  for (const step of r.next_steps ?? []) lines.push(`next: ${step}`);
  return lines.join("\n");
}
