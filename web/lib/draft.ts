// A bounty being posted, as the Protocol fills it in, and the rules it becomes (R1.1). The
// rules are checked with the shared formats' own parser before anything is signed, so the
// browser never sends a posting the contract would refuse for its shape.
import { isBountyName, parseRules, type Rules } from "@bountee/formats";
import { parseUnits } from "viem";
import { coveredChain, net } from "./network.ts";
import type { PostingBasics } from "./posting.ts";

export interface Draft {
  /** What the Protocol typed for the bounty: any words. */
  label: string;
  /** The bounty name the label becomes (`slug`), the ID's second half (D25). */
  name: string;
  covered: { chainId: number; address: string }[];
  proofChain: number;
  amount: string;
  minimum: string;
  endDate: string;
  delay: string;
}

export const emptyDraft = (): Draft => ({ label: "", name: "", covered: [{ chainId: net.chains[0].id, address: "" }], proofChain: net.chains[0].id, amount: "", minimum: "1", endDate: "", delay: "30" });

/**
 * Any words as a bounty name, as the contract's rule has it: a–z, 0–9 and single dashes, at
 * most 64, no dash at either end. "Lending Pool v1" becomes "lending-pool-v1".
 */
export function slug(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}

/** The label with a number added or raised, for a name the Protocol has used before: "Vault" → "Vault 2". */
export function nextLabel(label: string): string {
  const m = label.trim().match(/^(.*\S)\s+(\d+)$/);
  return m && slug(m[1]!) ? `${m[1]} ${Number(m[2]) + 1}` : `${label.trim()} 2`;
}

/** The bounty name's rule, as the contract applies it; the error to show, or null. */
export function nameProblem(name: string): string | null {
  if (!name) return "Say what it protects, in a few words.";
  return isBountyName(name) ? null : "Use some letters or numbers.";
}

const isAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);

/** An amount as typed, in USDC's smallest unit: "2,000" and "2000" alike. Commas only group digits. */
export function usdcUnits(typed: string, decimals: number): bigint {
  return parseUnits(typed.replace(/,/g, ""), decimals);
}

function usdcProblem(typed: string, decimals: number): string | null {
  const plain = typed.replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(plain)) return "An amount of USDC above zero.";
  if ((plain.split(".")[1] ?? "").length > decimals) return `USDC has at most ${decimals} decimal places.`;
  return usdcUnits(plain, decimals) > 0n ? null : "An amount of USDC above zero.";
}

/** What's wrong with the draft, field by field; empty when it can be posted. */
export function draftProblems(d: Draft, decimals: number): Record<string, string> {
  const out: Record<string, string> = {};
  const n = nameProblem(d.name);
  if (n) out.name = n;
  const keys = d.covered.map((c) => `${c.chainId}:${c.address.toLowerCase()}`);
  d.covered.forEach((c, i) => {
    if (!isAddress(c.address)) out[`covered.${i}`] = "A contract address: 0x and 40 hex characters.";
    else if (keys.indexOf(keys[i]!) < i) out[`covered.${i}`] = "Already listed above on this chain.";
  });
  for (const k of ["amount", "minimum"] as const) {
    const problem = usdcProblem(d[k], decimals);
    if (problem) out[k] = problem;
  }
  const end = Date.parse(`${d.endDate}T23:59:59Z`);
  if (!d.endDate || Number.isNaN(end) || end <= Date.now()) out.endDate = "A date in the future.";
  const delay = Number(d.delay);
  if (!Number.isInteger(delay) || delay < 1 || delay > 90) out.delay = "Between 1 and 90 days.";
  return out;
}

/** The rules to post: the Protocol's draft plus what BounTEE fixes (recency limit, seed, judge build). */
export function rulesOf(d: Draft, s: PostingBasics, exploitPublicKey: string): Rules {
  const chainIds = [...new Set(d.covered.map((c) => c.chainId))];
  return parseRules({
    covered_contracts: d.covered.map((c) => ({ chain_id: c.chainId, address: c.address.toLowerCase() })),
    recency_limit_secs: s.fixed.recency_limit_secs,
    // Theft is valued in each covered chain's USDC, one unit for one unit, as the minimum theft
    // is (D27). The address is this build's, from the network table, never the server's.
    listed_tokens: chainIds.map((id) => {
      const chain = coveredChain(id);
      if (!chain) throw new Error(`This app can't cover a contract on chain ${id}.`);
      return { chain_id: id, token: chain.usdc, price: "1" };
    }),
    seed: s.fixed.seed,
    bounty_amount: usdcUnits(d.amount, s.usdcDecimals).toString(),
    minimum_theft: usdcUnits(d.minimum, s.usdcDecimals).toString(),
    end_date_ns: (BigInt(Date.parse(`${d.endDate}T23:59:59Z`)) * 1_000_000n).toString(),
    disclosure_delay_days: Number(d.delay),
    exploit_public_key: exploitPublicKey,
    judge_build_hash: s.fixed.judge_build_hash,
  });
}
