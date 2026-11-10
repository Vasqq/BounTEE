// A bounty being posted, as the Protocol fills it in, and the rules it becomes (R1.1). The
// rules are checked with the shared formats' own parser before anything is signed, so the
// browser never sends a posting the contract would refuse for its shape.
import { parseBountyId, parseRules, type Rules } from "@bountee/formats";
import { parseUnits } from "viem";
import type { PostingStatus } from "./posting.ts";

export interface Draft {
  name: string;
  covered: { chainId: number; address: string }[];
  proofChain: number;
  amount: string;
  minimum: string;
  endDate: string;
  delay: string;
}

export const emptyDraft = (): Draft => ({ name: "", covered: [{ chainId: 8453, address: "" }], proofChain: 8453, amount: "", minimum: "", endDate: "", delay: "30" });

/** The bounty ID's rule, as the contract applies it; the error to show, or null. */
export function nameProblem(name: string, protocol: string): string | null {
  if (!name) return "Name the bounty.";
  try {
    parseBountyId({ protocol, name });
    return null;
  } catch {
    return "1 to 64 characters of a–z, 0–9 and -, not starting or ending with -.";
  }
}

const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/** What's wrong with the draft, field by field; empty when it can be posted. */
export function draftProblems(d: Draft, protocol: string, decimals: number): Record<string, string> {
  const out: Record<string, string> = {};
  const n = nameProblem(d.name, protocol);
  if (n) out.name = n;
  d.covered.forEach((c, i) => {
    if (!isAddress(c.address)) out[`covered.${i}`] = "A contract address: 0x and 40 hex characters.";
  });
  const keys = d.covered.map((c) => `${c.chainId}:${c.address.toLowerCase()}`);
  if (new Set(keys).size !== keys.length) out.covered = "Each contract once.";
  const amount = (s: string) => {
    try {
      return /^\d+(\.\d+)?$/.test(s) ? parseUnits(s, decimals) : null;
    } catch {
      return null;
    }
  };
  if (!amount(d.amount) || amount(d.amount)! <= 0n) out.amount = "An amount of USDC above zero.";
  if (!amount(d.minimum) || amount(d.minimum)! <= 0n) out.minimum = "An amount of USDC above zero.";
  const end = Date.parse(`${d.endDate}T23:59:59Z`);
  if (!d.endDate || Number.isNaN(end) || end <= Date.now()) out.endDate = "A date in the future.";
  const delay = Number(d.delay);
  if (!Number.isInteger(delay) || delay < 1 || delay > 90) out.delay = "1 to 90 days.";
  return out;
}

/** The rules to post: the Protocol's draft plus what BounTEE fixes (recency limit, seed, judge build). */
export function rulesOf(d: Draft, s: PostingStatus, exploitPublicKey: string): Rules {
  const usdc = s.chains.find((c) => c.id === d.proofChain)!.usdc;
  return parseRules({
    covered_contracts: d.covered.map((c) => ({ chain_id: c.chainId, address: c.address.toLowerCase() })),
    proof_chain: d.proofChain,
    recency_limit_secs: s.fixed.recency_limit_secs,
    // Theft is valued in the proof chain's USDC, one unit for one unit, as the minimum theft is.
    listed_tokens: [{ token: usdc, price: "1" }],
    seed: s.fixed.seed,
    bounty_amount: parseUnits(d.amount, s.usdcDecimals).toString(),
    minimum_theft: parseUnits(d.minimum, s.usdcDecimals).toString(),
    end_date_ns: (BigInt(Date.parse(`${d.endDate}T23:59:59Z`)) * 1_000_000n).toString(),
    disclosure_delay_days: Number(d.delay),
    exploit_public_key: exploitPublicKey,
    judge_build_hash: s.fixed.judge_build_hash,
  });
}
