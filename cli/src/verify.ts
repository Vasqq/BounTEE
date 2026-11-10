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
// The checks that read only chain data (attestation, payout, pauses) live in verify-chain.ts,
// which the web app shares.
import type { BountyId } from "@bountee/formats";
import { codeHash, reproducibleBuild, resolveRev, revFromSourceMetadata, sha256File } from "./build.ts";
import { rerunPublished } from "./publish.ts";
import type { BountyView } from "./status.ts";
import { bare, chainChecks, type Check, type ChainCheckOptions, type CheckStatus, type ConfigView } from "./verify-chain.ts";

export type { Check, CheckStatus } from "./verify-chain.ts";

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


export interface VerifyOptions extends ChainCheckOptions {
  rev?: string;
  judgeWasm?: string;
  contractWasm?: string;
}

/** The bounty contract's `published_exploit` view, the part `verify` reads. */
interface PublicationView {
  state: string;
  publishable_from_ns?: string;
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
  checks.push(...(await chainChecks(o, bounty, config)));
  checks.push(
    winner === null
      ? { check: "rerun", status: "not_yet_published", detail: "the winning exploit is not yet published (no winner)" }
      : await rerunCheck(o, bounty, judgeWasm),
  );
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
