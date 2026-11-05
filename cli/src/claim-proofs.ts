// A claim's proofs exactly as it was filed (R2.6, D7.1). The bounty contract keeps only their
// sha256 and the NEAR block the submission ran in, so `claim --retry`, `publish` and `rerun`
// read them back from wherever the caller has them, and take them only if they hash to the
// claim's `proofs_sha256`: no file, transaction or RPC can substitute others.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseAccountProof } from "@bountee/formats";
import type { Near } from "./near.ts";

/** What of a claim the proofs are checked against, from its `claim` or `published_exploit` view. */
export interface ClaimProofsRef {
  id: number;
  /** sha256 of the proofs exactly as submitted (`0x…`). */
  proofs_sha256: string;
  /** The NEAR block the submission ran in (decimal); older deployments don't record it. */
  submitted_at_block?: string;
}

/** Where to read the proofs from. */
export type ProofsSource =
  /** Already in hand: an older deployment's publication record kept them. */
  | { text: string }
  /** A saved job (`bountee test --out`), an evidence file, or the proofs array as JSON. */
  | { file: string }
  /** The transactions that filed or retried the claim (saved by `claim`, or `--tx`). */
  | { txs: string[]; signer: string }
  /** The chunks of the block the submission ran in and of the few before it. */
  | { chain: true };

/** How many blocks before the submission's block its transaction may sit in. */
const TX_BLOCKS_BEFORE = 10;

const sha256 = (text: string) => `0x${createHash("sha256").update(text).digest("hex")}`;

/** The proofs a file holds, as the exact text a claim sends: JSON of the parsed proofs array (claim.ts). */
function proofsInFile(path: string): string {
  const v = JSON.parse(readFileSync(path, "utf8"));
  const proofs = Array.isArray(v) ? v : (v?.replay?.proofs ?? v?.proofs);
  if (!Array.isArray(proofs)) throw new Error(`${path} holds neither a saved job, an evidence file nor a proofs array`);
  return JSON.stringify(proofs.map(parseAccountProof));
}

/** An action as NEAR RPC shows it in a transaction or receipt. */
interface Action {
  FunctionCall?: { method_name: string; args: string };
  Delegate?: { delegate_action: { receiver_id: string; actions: Action[] } };
}

/** The `proofs` argument of every `submit_claim` or `retry_claim` call to `contract` among `actions`, a meta transaction's included. */
function proofsArgs(receiver: string, actions: Action[], contract: string): string[] {
  return actions.flatMap((a) => {
    if (a.Delegate) return proofsArgs(a.Delegate.delegate_action.receiver_id, a.Delegate.delegate_action.actions, contract);
    const call = a.FunctionCall;
    if (receiver !== contract || (call?.method_name !== "submit_claim" && call?.method_name !== "retry_claim")) return [];
    try {
      const proofs = JSON.parse(Buffer.from(call.args, "base64").toString("utf8")).proofs;
      return typeof proofs === "string" ? [proofs] : [];
    } catch {
      return [];
    }
  });
}

/** The proofs passed by `submit_claim` or `retry_claim` calls in a transaction. */
const txCandidates = (tx: { receiver_id: string; actions: Action[] }, contract: string) => proofsArgs(tx.receiver_id, tx.actions, contract);

/** Candidates from the claim's transactions, as NEAR RPC has them. */
async function fromTxs(near: Near, contract: string, hashes: string[], signer: string): Promise<string[]> {
  const out: string[] = [];
  for (const hash of hashes) {
    for (const rpc of near.withArchive()) {
      const status = await rpc
        .rpc<{ transaction: { receiver_id: string; actions: Action[] } }>("EXPERIMENTAL_tx_status", { tx_hash: hash, sender_account_id: signer, wait_until: "FINAL" })
        .catch(() => null);
      if (!status) continue;
      out.push(...txCandidates(status.transaction, contract));
      break;
    }
  }
  return out;
}

/** Candidates from the chunks of NEAR blocks `from`..`to`, newest first. */
async function* fromChain(near: Near, contract: string, from: number, to: number): AsyncGenerator<string> {
  const rpcs = near.withArchive();
  for (let height = to; height >= from; height--) {
    for (const rpc of rpcs) {
      let chunks: string[];
      try {
        const b = await rpc.rpc<{ chunks: { chunk_hash: string; height_included: number }[] }>("block", { block_id: height });
        chunks = b.chunks.filter((c) => c.height_included === height).map((c) => c.chunk_hash);
      } catch {
        continue; // not kept by this RPC, or no block at this height
      }
      for (const chunk of chunks) {
        const { transactions } = await rpc.rpc<{ transactions: { receiver_id: string; actions: Action[] }[] }>("chunk", { chunk_id: chunk });
        for (const tx of transactions) yield* txCandidates(tx, contract);
      }
      break;
    }
  }
}

/**
 * The claim's proofs, from `source`, as the exact text its `submit_claim` carried. Proofs
 * given (a file, or text) that don't hash to the claim's are refused; among a transaction's
 * or a block's calls, those that don't are passed over, and none matching is an error that
 * says where it looked.
 */
export async function proofsMatchingClaim(near: Near, contract: string, claim: ClaimProofsRef, source: ProofsSource): Promise<string> {
  const want = claim.proofs_sha256.toLowerCase();
  if ("text" in source || "file" in source) {
    const proofs = "text" in source ? source.text : proofsInFile(source.file);
    if (sha256(proofs) !== want) {
      throw new Error(`these proofs hash to ${sha256(proofs)}, but claim ${claim.id} was filed with ${claim.proofs_sha256}: give the proofs it was filed with`);
    }
    return proofs;
  }
  const notFound = (where: string, hint: string) => new Error(`couldn't find claim ${claim.id}'s proofs (sha256 ${claim.proofs_sha256}) ${where}: ${hint}`);
  if ("txs" in source) {
    for (const proofs of await fromTxs(near, contract, source.txs, source.signer)) if (sha256(proofs) === want) return proofs;
    throw notFound(
      source.txs.length > 0 ? `in a submit_claim call in transaction ${source.txs.join(", ")}` : "in a saved transaction",
      "pass --tx <its submit_claim transaction>, or --job / --evidence with the proofs it was filed with",
    );
  }
  if (claim.submitted_at_block === undefined) throw new Error(`${contract} doesn't record the block claim ${claim.id} was submitted in: pass --proofs`);
  const at = Number(claim.submitted_at_block);
  for await (const proofs of fromChain(near, contract, at - TX_BLOCKS_BEFORE, at)) if (sha256(proofs) === want) return proofs;
  throw notFound(
    `in a submit_claim call at NEAR blocks ${at - TX_BLOCKS_BEFORE}-${at}`,
    "pass --proofs, or a --near-rpc that keeps those blocks (an archival RPC)",
  );
}
