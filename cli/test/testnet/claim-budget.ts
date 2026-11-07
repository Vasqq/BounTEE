// What each claim of a demo run will draw from the Whitehat's claim balance, budgeted from the
// proof chain as it is now (D21's preflight). A claim's draw is mostly OutLayer's hold on its job
// input above the free bytes (fees()), and that input is mostly the proofs of every account and
// slot its replay reads, whose size is set by the chain: Base's state trie and Circle's USDC make
// a mainnet proof several times a testnet one's, and the cheat's USDC purchase reads Uniswap's
// contracts too (ticket #35 measured ~300 KB for the mainnet cheat against ~50 KB on Base Sepolia).
//
// So the budget asks the proof chain's RPC for the very proofs each claim will carry: of each
// account it reads that exists now, with as many slots as it reads; of a fresh address for an
// account the run creates or the claim's fresh sender, with the code the run will deploy there.
import { randomBytes } from "node:crypto";
import { claimCost, claimInputBytes } from "../../src/claim-flow.ts";
import { fetchHeader, fetchProof, rpc } from "../../src/proofs.ts";

/** One account a claim's replay reads: one that exists now, or one the run deploys (`code`), or the claim's fresh sender (neither). */
export interface Read {
  /** What it is, for the report. */
  name: string;
  address?: string;
  /** Runtime code (hex) of a contract the run deploys before the claim. */
  code?: string;
  /** How many of its storage slots the replay reads. */
  slots: number;
}

export interface ClaimPlan {
  kind: string;
  reads: Read[];
}

export interface ClaimBudget {
  kind: string;
  input_bytes: number;
  /** yoctoNEAR the claim draws from the claim balance at filing. */
  draw: bigint;
  /** The part OutLayer refunds at settlement: its hold on the input above the free bytes. */
  refunded: bigint;
}

/**
 * Storage proofs in a contract the run deploys minutes before the claim: its trie holds a handful
 * of slots, so each proof is a node or two (Day-3's mock USDC: 1,515 bytes for 4 slots).
 */
const NEW_TRIE_SLOT_PROOF_BYTES = 400;
/** A sealed exploit: the demo's are 0.3-2.5 KB of JSON, sealed and base64-encoded. */
const SEALED_EXPLOIT_BYTES = 4096;

const freshAddress = () => `0x${randomBytes(20).toString("hex")}`;
// Its first `n` slots: a contract's low slots hold its fixed state, so each proof runs to a leaf
// as a read slot's does (a random key's proof stops short, where its path leaves the trie).
const slotKeys = (n: number) => Array.from({ length: n }, (_, i) => `0x${i.toString(16).padStart(64, "0")}`);

/** The bytes a claim's proofs take in its input (claim.ts sends `JSON.stringify(proofs)`). */
async function proofsBytes(url: string, block: number, reads: Read[]): Promise<number> {
  let bytes = 2; // the array's brackets
  for (const r of reads) {
    if (r.address) {
      bytes += JSON.stringify(await fetchProof(url, r.address, slotKeys(r.slots), block)).length + 1;
      continue;
    }
    // Not there yet: an absent account's proof at today's depth, then the code the run deploys
    // and its new trie's slots.
    const absent = JSON.stringify(await fetchProof(url, freshAddress(), [], block)).length + 1;
    bytes += absent + (r.code ? r.code.length - 2 : 0) + r.slots * NEW_TRIE_SLOT_PROOF_BYTES;
  }
  return bytes;
}

/** Each claim's input size and draw, from the proof chain at its head and the contract's `fees()`. */
export async function budgetClaims(url: string, fees: any, plans: ClaimPlan[]): Promise<ClaimBudget[]> {
  const block = Number(BigInt(await rpc<string>(url, "eth_blockNumber", [])));
  const { hash, header } = await fetchHeader(url, block);
  const headerBytes = header.length;
  const blockJsonBytes = JSON.stringify({ number: block, hash }).length;
  const out: ClaimBudget[] = [];
  for (const plan of plans) {
    const input = claimInputBytes(await proofsBytes(url, block, plan.reads), headerBytes, blockJsonBytes);
    const refunded = BigInt(Math.max(0, input - Number(fees.job_input_free_bytes))) * BigInt(fees.storage_price_per_byte);
    out.push({ kind: plan.kind, input_bytes: input, draw: claimCost(fees, input, SEALED_EXPLOIT_BYTES), refunded });
  }
  return out;
}

/**
 * What the Whitehat holds at the run's peak: claims run one after another and OutLayer refunds
 * each one's hold at settlement, so the largest claim's whole draw, plus what every other claim
 * keeps (its job, its secret's storage, slack).
 */
export function whitehatNeed(claims: ClaimBudget[]): bigint {
  if (claims.length === 0) return 0n;
  const kept = claims.map((c) => c.draw - c.refunded);
  const biggest = claims.reduce((m, c, i) => (c.draw > claims[m]!.draw ? i : m), 0);
  return claims.reduce((sum, c, i) => sum + (i === biggest ? c.draw : kept[i]!), 0n);
}
