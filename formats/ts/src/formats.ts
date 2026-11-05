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

export const parseCoveredContract = object<CoveredContract>({ chain_id: safeU64, address: evmAddress });

export const parseRules: (v: unknown) => Rules = object<Rules>({
  covered_contracts: array(parseCoveredContract),
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

export const parseBlockRef = object<BlockRef>({ number: safeU64, hash: b256 });

export const parseAccountProof = object<AccountProof>({
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

/** The enclave's claim job, as the bounty contract requests it (R2.8; see job.rs). */
export interface JudgeClaim {
  rules: Rules;
  bounty: BountyId;
  whitehat: string;
  block: BlockRef;
  header: string;
  /** The claim's proofs array, as the JSON text the Whitehat submitted. */
  proofs_json: string;
  /** NEAR nanoseconds, U64 decimal string. */
  submitted_at_ns: string;
}

/** The enclave's posting check, as the bounty contract requests it (#17; see posting.rs). */
export interface PostingCheck {
  bounty: BountyId;
  rules: Rules;
}

/** The enclave's release job (#22, R6.1, R12.4; see job.rs). */
export interface Release {
  bounty: BountyId;
  claim_id: number;
  whitehat: string;
  exploit_public_key: string;
}

/** The enclave's publication job (#23, D7, D7.1; see job.rs). */
export interface Publish {
  bounty: BountyId;
  claim_id: number;
  whitehat: string;
}

/** The judge's stdin. */
export type Job =
  | { replay: Replay }
  | { judge_claim: JudgeClaim }
  | { posting_check: PostingCheck }
  | { release: Release }
  | { publish: Publish };

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

const text = (v: unknown): string => (typeof v === "string" ? v : fail("string", v));

export const parseJudgeClaim: (v: unknown) => JudgeClaim = object<JudgeClaim>({
  rules: parseRules,
  bounty: parseBountyId,
  whitehat: accountId,
  block: parseBlockRef,
  header: bytes,
  proofs_json: text,
  submitted_at_ns: u64,
});

export const parsePostingCheck: (v: unknown) => PostingCheck = object<PostingCheck>({
  bounty: parseBountyId,
  rules: parseRules,
});

export const parseRelease: (v: unknown) => Release = object<Release>({
  bounty: parseBountyId,
  claim_id: safeU64,
  whitehat: accountId,
  exploit_public_key: publicKey,
});

export const parsePublish: (v: unknown) => Publish = object<Publish>({
  bounty: parseBountyId,
  claim_id: safeU64,
  whitehat: accountId,
});

/** One key naming the action, as serde writes a Rust enum. */
export const parseJob = (v: unknown): Job => {
  if (typeof v === "object" && v !== null && !Array.isArray(v) && "judge_claim" in v) {
    return object<{ judge_claim: JudgeClaim }>({ judge_claim: parseJudgeClaim })(v);
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v) && "posting_check" in v) {
    return object<{ posting_check: PostingCheck }>({ posting_check: parsePostingCheck })(v);
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v) && "release" in v) {
    return object<{ release: Release }>({ release: parseRelease })(v);
  }
  if (typeof v === "object" && v !== null && !Array.isArray(v) && "publish" in v) {
    return object<{ publish: Publish }>({ publish: parsePublish })(v);
  }
  return object<{ replay: Replay }>({ replay: parseReplay })(v);
};

/**
 * What a Whitehat seals (R5.1): the exploit with their account bound inside it (R5.4).
 * Sealed as base64(raw DEFLATE(JSON)), the value of the secret `BOUNTEE_SEALED_EXPLOIT`
 * (see job.rs).
 */
export interface SealedBundle {
  whitehat: string;
  exploit: Exploit;
}

export const parseSealedBundle: (v: unknown) => SealedBundle = object<SealedBundle>({
  whitehat: accountId,
  exploit: parseExploit,
});

/** What the Protocol opens with its exploit key (R6.2; the encryption is in job.rs). */
export interface ReleasedExploit {
  bounty: BountyId;
  claim_id: number;
  whitehat: string;
  exploit: Exploit;
}

export const parseReleasedExploit: (v: unknown) => ReleasedExploit = object<ReleasedExploit>({
  bounty: parseBountyId,
  claim_id: safeU64,
  whitehat: accountId,
  exploit: parseExploit,
});

/** The release job's stdout: the ReleasedExploit, encrypted to the exploit key. */
export interface ReleaseOutput {
  released: string;
}

export const parseReleaseOutput: (v: unknown) => ReleaseOutput = object<ReleaseOutput>({ released: base64 });

/**
 * The publication job's stdout (#23, D7.1): the ReleasedExploit in the clear, as base64 of
 * its raw DEFLATE'd JSON (BounTEE publication v1; see job.rs).
 */
export interface PublishOutput {
  published: string;
}

export const parsePublishOutput: (v: unknown) => PublishOutput = object<PublishOutput>({ published: base64 });

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

/** Gas limit and fee limit (wei) of every signed pause (see posting.rs). */
export const PAUSE_GAS_LIMIT = 200_000n;
export const PAUSE_MAX_FEE_PER_GAS = 1_000_000_000n;
/** The L1 data fee an OP-stack chain such as Base charges on top of gas × fee: 0.00001 ETH. */
export const PAUSE_L1_DATA_FEE_ALLOWANCE = 10_000_000_000_000n;
/** The pause gas a pause-role address must hold per pause on a chain (R7.6): 0.00021 ETH. */
export const PAUSE_GAS_PER_PAUSE = PAUSE_GAS_LIMIT * PAUSE_MAX_FEE_PER_GAS + PAUSE_L1_DATA_FEE_ALLOWANCE;

/** Why a covered contract fails the posting check (see posting.rs). */
export const POSTING_FAILURE_REASONS = ["chain_unconfirmed", "cannot_pause", "pause_gas_short"] as const;
export type PostingFailureReason = (typeof POSTING_FAILURE_REASONS)[number];

export interface PostingFailure {
  /** The failing contract's place in the rules' `covered_contracts` (from 0). */
  index: number;
  reason: PostingFailureReason;
}

/** The posting check's answer: no failures passes (#17; see posting.rs). */
export interface PostingCheckResult {
  failures: PostingFailure[];
}

const postingFailureReason = (v: unknown): PostingFailureReason =>
  POSTING_FAILURE_REASONS.find((r) => r === v) ?? fail("posting failure reason", v);

export const parsePostingCheckResult: (v: unknown) => PostingCheckResult = object<PostingCheckResult>({
  failures: array(object<PostingFailure>({ index: u32, reason: postingFailureReason })),
});
