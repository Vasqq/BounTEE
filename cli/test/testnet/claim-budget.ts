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

/** An account a demo claim's replay reads, by what it is to the run. */
export type Role =
  | "sender" // the claim's fresh account
  | "coinbase" // the block's coinbase
  | "vault" // the demo PositionVault
  | "usdc" // its token: the demo's MockUSDC on testnet, Circle's USDC on mainnet
  | "usdc_implementation" // Circle's USDC implementation, behind its proxy
  | "uniswap_router" // Uniswap V2's router, where the mainnet cheat buys its USDC
  | "uniswap_pair" // the WETH/USDC pair it buys from
  | "weth"; // WETH

/**
 * How many storage slots each demo replay proves, per account, on each network: the cheat
 * (demo/script/HonestUser.s.sol: deposit then redeem, after buying Circle's USDC on Uniswap V2
 * on mainnet) and the winning exploit on the PositionVault.
 *
 * Measured on Nov 8, 2026 (ticket #52). Testnet: `bountee test` of HonestUser.s.sol and of the
 * sealed exploit against a fresh PositionVault instance on Base Sepolia, counting each saved
 * job's proofs (cli/test/fresh-instance-testnet.test.ts checks these against a live replay).
 * Mainnet (no mainnet transaction): both scripts run on a local anvil fork of Base with a
 * PositionVault deployed and seeded there, counting the accounts and slots each transaction
 * reads (call tree and SLOAD/SSTORE keys from the debug tracer), plus what the judge proves for
 * every replay: the coinbase, and the attacker's holdings (R4.8).
 * The same count on a Base Sepolia fork gives the testnet numbers below.
 */
export const DEMO_READS: Record<"testnet" | "mainnet", Record<"cheat" | "win", Partial<Record<Role, number>>>> = {
  testnet: {
    cheat: { sender: 0, coinbase: 0, vault: 3, usdc: 4 },
    win: { sender: 0, coinbase: 0, vault: 3, usdc: 3 },
  },
  mainnet: {
    cheat: { sender: 0, coinbase: 0, vault: 3, usdc_implementation: 0, usdc: 7, uniswap_router: 0, uniswap_pair: 6, weth: 2 },
    win: { sender: 0, coinbase: 0, vault: 3, usdc_implementation: 0, usdc: 6 },
  },
};

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
