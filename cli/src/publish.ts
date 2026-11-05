// `bountee publish <protocol>/<name>` and `bountee rerun <protocol>/<name>` (#23): a winning
// exploit is published once its disclosure delay has passed since the payout, and anyone
// re-runs it to the verdict the enclave gave, trusting nobody (D7, D7.1, ADR-0008).
//
// - Both need the winning claim's proofs, exactly as its `submit_claim` carried them: the
//   contract keeps only their sha256 and the NEAR block the submission ran in. They are
//   fetched from that call's arguments (claim-proofs.ts: the block and the few before it, each
//   block's chunks, the call to the contract whose `proofs` hash to the claim's sha256, so no
//   RPC can substitute others). An ordinary RPC keeps about five epochs of blocks; past that,
//   the network's archival RPC is asked. `--proofs` (a saved job from `bountee test --out`,
//   or the proofs array as a JSON file) overrides the fetch.
// - `publish` asks the bounty contract to publish (anyone may, once the delay has passed),
//   passing those proofs. It checks the delay and the proofs against the contract's views
//   before sending anything; the bounty's posting fee pays for the job (R11.4).
// - `rerun` reads the publication (`published_exploit` view): the exploit the judge wrote in
//   the clear, beside the claim's block and header. It replays the exploit under the compiled
//   judge from that header and the claim's proofs with no RPC (R2.9), and compares the
//   verdict with the enclave's.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";
import {
  parseAccountProof,
  parseBlockRef,
  parseReleasedExploit,
  parseRules,
  parseVerdict,
  toJson,
  type BountyId,
  type Exploit,
  type Replay,
  type Verdict,
} from "@bountee/formats";
import { actions } from "near-api-js";
import { proofsMatchingClaim, type ProofsSource } from "./claim-proofs.ts";
import { events, Near, tgas } from "./near.ts";
import { runJudge } from "./proofs.ts";
import { judgeWasm } from "./test.ts";

/** The `published_exploit` view (contract/src/publication.rs). */
interface PublicationView {
  claim_id: number;
  state: "delayed" | "publishable" | "requested" | "published";
  publishable_from_ns: string;
  block: unknown;
  header: string;
  proofs_sha256: string;
  /** The NEAR block the claim's submission ran in. */
  submitted_at_block?: string;
  /** The proofs themselves, kept only by deployments from before the code review of #23. */
  proofs?: string | null;
  verdict: unknown;
  published: string | null;
}

const label = (b: BountyId) => `${b.protocol}/${b.name}`;
const when = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();

/** A paid bounty's publication, or why there is none yet. */
async function publicationOf(near: Near, contract: string, bounty: BountyId): Promise<{ rules: unknown; pub: PublicationView | null }> {
  const view = await near.view<{ state: string; rules: unknown } | null>(contract, "bounty", { id: bounty });
  if (!view) throw new Error(`${contract} has no bounty ${label(bounty)}`);
  const pub = await near.view<PublicationView | null>(contract, "published_exploit", { id: bounty });
  return { rules: view.rules, pub: view.state === "paid" ? pub : null };
}

/** Where the winning claim's proofs are read from: `--proofs`, else the chain at its submission. */
const proofsSource = (path: string | undefined): ProofsSource => (path ? { file: path } : { chain: true });

/** The claim a publication names, as its proofs are checked against. */
const claimOf = (pub: PublicationView) => ({ id: pub.claim_id, proofs_sha256: pub.proofs_sha256, submitted_at_block: pub.submitted_at_block });

export interface PublishResult {
  bounty: BountyId;
  claim_id: number;
  /** The publication transaction. */
  tx: string;
}

/** Ask the contract to publish the bounty's winning exploit, as `account`, and wait for it. */
export async function publishExploit(o: { near: Near; contract: string; bounty: BountyId; as: string; proofs?: string }): Promise<PublishResult> {
  const { pub } = await publicationOf(o.near, o.contract, o.bounty);
  if (!pub) throw new Error(`${label(o.bounty)} has not been paid, so it has no winning exploit to publish`);
  if (pub.state === "published") throw new Error(`${label(o.bounty)}'s exploit is already published: bountee rerun ${label(o.bounty)}`);
  if (pub.state === "requested") throw new Error(`${label(o.bounty)}'s publication is under way; try again in a minute`);
  if (pub.state === "delayed") {
    throw new Error(`${label(o.bounty)}'s disclosure delay hasn't passed: anyone may publish it from ${when(pub.publishable_from_ns)}`);
  }
  const proofs = await proofsMatchingClaim(o.near, o.contract, claimOf(pub), proofsSource(o.proofs));
  // The bounty's posting fee pays for the job and the record (R11.4): nothing is attached.
  const r = await o.near.account(o.as).signAndSendTransaction({
    receiverId: o.contract,
    actions: [actions.functionCall("publish_exploit", { id: o.bounty, proofs }, tgas(150), 0n)],
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  const hash = r.transaction.hash;
  const status = await o.near.txStatus(hash, o.as);
  const failure = JSON.stringify(status.status).match(/"ExecutionError":"([^"]*)"/);
  if (failure) throw new Error(`the publication was refused: ${failure[1]} (tx ${hash})`);
  if (!events(status).some((e) => e.event === "exploit_published")) {
    throw new Error(`the publication job didn't publish the exploit; anyone may ask again (tx ${hash})`);
  }
  return { bounty: o.bounty, claim_id: pub.claim_id, tx: hash };
}

export function formatPublishResult(r: PublishResult): string {
  return [
    `${label(r.bounty)}: claim ${r.claim_id}'s exploit published by tx ${r.tx}`,
    `re-run it: bountee rerun ${label(r.bounty)}`,
  ].join("\n");
}

export interface RerunResult {
  bounty: BountyId;
  claim_id: number;
  whitehat: string;
  block: { number: number; hash: string };
  /** The verdict this re-run gave, from the published header and proofs. */
  verdict: Verdict;
  /** The verdict the enclave gave, as the contract recorded it. */
  enclave_verdict: Verdict | null;
  same_verdict: boolean;
  judge: { wasm: string; sha256: string; same_as_bounty: boolean };
  exploit: Exploit;
  /** Where the replay job was saved, with `--out`. */
  out?: string;
}

/** Re-run a published exploit locally to the enclave's verdict (D7.1). */
export async function rerunPublished(o: { near: Near; contract: string; bounty: BountyId; judge?: string; out?: string; proofs?: string }): Promise<RerunResult> {
  const { rules, pub } = await publicationOf(o.near, o.contract, o.bounty);
  if (!pub || pub.state !== "published" || !pub.published) {
    const opens = pub ? `; anyone may publish it from ${when(pub.publishable_from_ns)}` : "";
    throw new Error(`${label(o.bounty)}'s winning exploit is not yet published${opens}`);
  }
  // A deployment from before the code review of #23 still keeps the proofs in its publication.
  const source = !o.proofs && typeof pub.proofs === "string" ? { text: pub.proofs } : proofsSource(o.proofs);
  const proofs = await proofsMatchingClaim(o.near, o.contract, claimOf(pub), source);
  const released = parseReleasedExploit(JSON.parse(inflateRawSync(Buffer.from(pub.published, "base64")).toString("utf8")));
  if (released.bounty.protocol !== o.bounty.protocol || released.bounty.name !== o.bounty.name || released.claim_id !== pub.claim_id) {
    throw new Error(`the publication names another claim (${label(released.bounty)} claim ${released.claim_id})`);
  }
  const replay: Replay = {
    rules: parseRules(rules),
    block: parseBlockRef(pub.block),
    header: pub.header,
    proofs: (JSON.parse(proofs) as unknown[]).map(parseAccountProof),
    exploit: released.exploit,
  };
  if (o.out) writeFileSync(o.out, `${toJson({ replay })}\n`);
  const wasm = judgeWasm({ judge: o.judge });
  const digest = createHash("sha256").update(readFileSync(wasm)).digest("hex");
  const { verdict, stderr } = runJudge(wasm, replay);
  if (!verdict) throw new Error(`the judge gave no verdict:\n${stderr.trim()}`);
  const enclave = pub.verdict === null ? null : parseVerdict(pub.verdict);
  return {
    bounty: o.bounty,
    claim_id: pub.claim_id,
    whitehat: released.whitehat,
    block: replay.block,
    verdict,
    enclave_verdict: enclave,
    same_verdict: enclave !== null && enclave.outcome === verdict.outcome && enclave.reason === verdict.reason,
    judge: { wasm, sha256: digest, same_as_bounty: `0x${digest}` === replay.rules.judge_build_hash },
    exploit: released.exploit,
    ...(o.out ? { out: o.out } : {}),
  };
}

export function formatRerunResult(r: RerunResult): string {
  const enclave = r.enclave_verdict ? `${r.enclave_verdict.outcome} (${r.enclave_verdict.reason})` : "none recorded";
  return [
    `${label(r.bounty)}: claim ${r.claim_id} by ${r.whitehat}, re-run from its published header and its claim's proofs (no RPC)`,
    `verdict: ${r.verdict.outcome} (${r.verdict.reason})`,
    `enclave: ${enclave}`,
    r.same_verdict ? "same verdict as the enclave" : "NOT the enclave's verdict",
    `block:   ${r.block.number} ${r.block.hash}`,
    `judge:   ${r.judge.wasm} (sha256 ${r.judge.sha256})${r.judge.same_as_bounty ? ", the bounty's pinned build" : ""}`,
    ...(r.out ? [`job saved to ${r.out} (bountee test --job runs it again)`] : []),
  ].join("\n");
}
