// TypeScript twin of formats/src/{rules,claim,verdict}.rs. The Rust crate is the
// definition; field meanings are documented there. Each parse* returns a fresh object
// with fields in the defined order, so toJson() writes the same bytes Rust writes.
import {
  accountId,
  array,
  b256,
  base64,
  bountyName,
  bytes,
  evmAddress,
  fail,
  FormatError,
  object,
  publicKey,
  safeU64,
  u16,
  u32,
  u64,
  uint,
} from "./primitives.ts";

/** BounTEE fixes every bounty's recency limit at 5 minutes (R1.1, R2.8). */
export const RECENCY_LIMIT_SECS = 300;

export interface BountyId {
  protocol: string;
  name: string;
}

export interface CoveredContract {
  chain_id: number;
  address: string;
}

/** `"native"` or an ERC-20 address. */
export type Token = string;

export interface ListedToken {
  token: Token;
  price: string;
}

export interface TokenAmount {
  token: string;
  amount: string;
}

export interface Seed {
  native: string;
  tokens: TokenAmount[];
}

/** A bounty's rules, fixed at posting (R1.1). */
export interface Rules {
  covered_contracts: CoveredContract[];
  proof_chain: number;
  recency_limit_secs: number;
  listed_tokens: ListedToken[];
  seed: Seed;
  bounty_amount: string;
  minimum_theft: string;
  end_date_ns: string;
  disclosure_delay_days: number;
  exploit_public_key: string;
  judge_build_hash: string;
}

export interface BlockRef {
  number: number;
  hash: string;
}

export interface StorageProof {
  key: string;
  value: string;
  proof: string[];
}

export interface AccountProof {
  address: string;
  nonce: string;
  balance: string;
  code_hash: string;
  storage_hash: string;
  account_proof: string[];
  storage: StorageProof[];
  code: string;
}

export interface Claim {
  bounty: BountyId;
  whitehat: string;
  block: BlockRef;
  header: string;
  proofs: AccountProof[];
  sealed_exploit: string;
}

export type Outcome = "PAYS" | "ZERO" | "INVALID";

/** Every coarse reason and the one outcome it belongs to (R5.5). */
export const REASONS = [
  { reason: "minimum_theft_reached", outcome: "PAYS" },
  { reason: "below_minimum_theft", outcome: "ZERO" },
  { reason: "malformed_exploit", outcome: "INVALID" },
  { reason: "account_mismatch", outcome: "INVALID" },
  { reason: "existing_sender", outcome: "INVALID" },
  { reason: "unproven_state", outcome: "INVALID" },
  { reason: "block_not_confirmed", outcome: "INVALID" },
  { reason: "stale_block", outcome: "INVALID" },
] as const;

export type Reason = (typeof REASONS)[number]["reason"];

export interface Verdict {
  outcome: Outcome;
  reason: Reason;
}

const token = (v: unknown): Token => (v === "native" ? "native" : evmAddress(v));

export const parseBountyId = object<BountyId>({ protocol: accountId, name: bountyName });

export const parseRules: (v: unknown) => Rules = object<Rules>({
  covered_contracts: array(object<CoveredContract>({ chain_id: safeU64, address: evmAddress })),
  proof_chain: safeU64,
  recency_limit_secs: u32,
  listed_tokens: array(object<ListedToken>({ token, price: uint })),
  seed: object<Seed>({ native: uint, tokens: array(object<TokenAmount>({ token: evmAddress, amount: uint })) }),
  bounty_amount: uint,
  minimum_theft: uint,
  end_date_ns: u64,
  disclosure_delay_days: u16,
  exploit_public_key: publicKey,
  judge_build_hash: b256,
});

const parseBlockRef = object<BlockRef>({ number: safeU64, hash: b256 });

const parseAccountProof = object<AccountProof>({
  address: evmAddress,
  nonce: u64,
  balance: uint,
  code_hash: b256,
  storage_hash: b256,
  account_proof: array(bytes),
  storage: array(object<StorageProof>({ key: b256, value: b256, proof: array(bytes) })),
  code: bytes,
});

export const parseClaim: (v: unknown) => Claim = object<Claim>({
  bounty: parseBountyId,
  whitehat: accountId,
  block: parseBlockRef,
  header: bytes,
  proofs: array(parseAccountProof),
  sealed_exploit: base64,
});

/** One transaction of an exploit; `to` is `null` for a contract creation (see job.rs). */
export interface ExploitTransaction {
  from: string;
  to: string | null;
  value: string;
  input: string;
  gas: number;
}

/** The transactions a Foundry script broadcasts, replayed from fresh accounts. */
export interface Exploit {
  transactions: ExploitTransaction[];
}

/** A local replay (R2.9): rules, the claim's block, header and proofs, and the exploit. */
export interface Replay {
  rules: Rules;
  block: BlockRef;
  header: string;
  proofs: AccountProof[];
  exploit: Exploit;
}

/** The judge's stdin. */
export type Job = { replay: Replay };

const evmAddressOrNull = (v: unknown): string | null => (v === null ? null : evmAddress(v));

export const parseExploit: (v: unknown) => Exploit = object<Exploit>({
  transactions: array(
    object<ExploitTransaction>({ from: evmAddress, to: evmAddressOrNull, value: uint, input: bytes, gas: safeU64 }),
  ),
});

export const parseReplay: (v: unknown) => Replay = object<Replay>({
  rules: parseRules,
  block: parseBlockRef,
  header: bytes,
  proofs: array(parseAccountProof),
  exploit: parseExploit,
});

export const parseJob: (v: unknown) => Job = object<Job>({ replay: parseReplay });

const outcomeOf = (v: unknown): Outcome =>
  v === "PAYS" || v === "ZERO" || v === "INVALID" ? v : fail("outcome", v);

const reasonOf = (v: unknown): Reason => REASONS.find((r) => r.reason === v)?.reason ?? fail("reason", v);

export const parseVerdict = (v: unknown): Verdict => {
  const verdict = object<Verdict>({ outcome: outcomeOf, reason: reasonOf })(v);
  const belongs = REASONS.find((r) => r.reason === verdict.reason)!.outcome;
  if (belongs !== verdict.outcome) {
    throw new FormatError(`reason ${verdict.reason} doesn't belong to outcome ${verdict.outcome}`);
  }
  return verdict;
};

/** Write a parsed format as JSON, the same bytes the Rust crate writes. */
export const toJson = (value: unknown): string => JSON.stringify(value);
