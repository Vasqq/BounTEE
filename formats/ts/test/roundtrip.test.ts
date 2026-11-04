// Ticket #6 and D25: Rust and TypeScript agree on every format. TypeScript generates values
// (fast-check), the Rust crate parses and writes them back (formats/examples/echo.rs), and
// the two JSON spellings must be identical; random near-miss strings must be accepted or
// refused by both alike; and random bounties get the same pause-role address from both.
//
// This sits outside seams J/C/T/W/E on purpose: it is the public interface of the one
// format both the Rust side (judge, contract) and the TypeScript side (CLI, web) read.
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { beforeAll, expect, test } from "vitest";
import { isAccountId, isBountyName, pauseRole, parseBountyId, parseClaim, parseExploit, parseJob, parseRules, parseSealedBundle, parseVerdict, REASONS, toJson } from "../src/index.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
let echoBin = "";

beforeAll(() => {
  const out = execFileSync(
    "cargo",
    ["build", "-q", "-p", "bountee-formats", "--example", "echo", "--message-format=json"],
    { cwd: repo, encoding: "utf8", maxBuffer: 64 << 20 },
  );
  for (const line of out.split("\n")) {
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.reason === "compiler-artifact" && msg.target?.name === "echo" && msg.executable) echoBin = msg.executable;
  }
  expect(echoBin).not.toBe("");
}, 300_000);

type Reply = { ok?: unknown; err?: string };

/** Ask the Rust side about many values in one process. */
function rust(requests: { kind: string; value: unknown }[]): Reply[] {
  const input = requests.map((r) => JSON.stringify(r)).join("\n") + "\n";
  const res = spawnSync(echoBin, { input, encoding: "utf8", maxBuffer: 256 << 20 });
  expect(res.status).toBe(0);
  return res.stdout.trim().split("\n").map((l) => JSON.parse(l));
}

const hex = (n: number) => fc.stringMatching(new RegExp(`^[0-9a-f]{${n}}$`)).map((h) => `0x${h}`);
const bytes = fc.uint8Array({ maxLength: 40 }).map((b) => `0x${Buffer.from(b).toString("hex")}`);
const uint = (bits: bigint) => fc.bigInt({ min: 0n, max: 2n ** bits - 1n }).map(String);
const address = hex(40);
const accountId = fc
  .stringMatching(/^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/)
  .filter((s) => s.length >= 2 && s.length <= 64);
const bountyName = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/);
const base58 = fc.stringMatching(/^[1-9A-HJ-NP-Za-km-z]{1,50}$/);
const bountyId = fc.record({ protocol: accountId, name: bountyName });

const rulesArb = fc.record({
  covered_contracts: fc.array(fc.record({ chain_id: fc.maxSafeNat(), address }), { maxLength: 4 }),
  proof_chain: fc.maxSafeNat(),
  recency_limit_secs: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
  listed_tokens: fc.array(fc.record({ token: fc.oneof(fc.constant("native"), address), price: uint(256n) }), {
    maxLength: 4,
  }),
  seed: fc.record({
    native: uint(256n),
    tokens: fc.array(fc.record({ token: address, amount: uint(256n) }), { maxLength: 3 }),
  }),
  bounty_amount: uint(256n),
  minimum_theft: uint(256n),
  end_date_ns: uint(64n),
  disclosure_delay_days: fc.integer({ min: 0, max: 65535 }),
  exploit_public_key: fc.tuple(fc.constantFrom("x25519", "secp256k1", "ed25519"), base58).map(([s, d]) => `${s}:${d}`),
  judge_build_hash: hex(64),
});

const accountProofArb = fc.record({
  address,
  nonce: uint(64n),
  balance: uint(256n),
  code_hash: hex(64),
  storage_hash: hex(64),
  account_proof: fc.array(bytes, { maxLength: 3 }),
  storage: fc.array(fc.record({ key: hex(64), value: hex(64), proof: fc.array(bytes, { maxLength: 2 }) }), {
    maxLength: 2,
  }),
  code: bytes,
});

const blockArb = fc.record({ number: fc.maxSafeNat(), hash: hex(64) });

// #8: the exploit the judge replays; `to: null` is a contract creation.
const exploitArb = fc.record({
  transactions: fc.array(
    fc.record({ from: address, to: fc.option(address, { nil: null }), value: uint(256n), input: bytes, gas: fc.maxSafeNat() }),
    { maxLength: 4 },
  ),
});

const jobArb = fc.oneof(
  fc.record({
    replay: fc.record({
      rules: rulesArb,
      block: blockArb,
      header: bytes,
      proofs: fc.array(accountProofArb, { maxLength: 2 }),
      exploit: exploitArb,
    }),
  }),
  // #14: the enclave's claim job, as the bounty contract builds it.
  fc.record({
    judge_claim: fc.record({
      rules: rulesArb,
      bounty: bountyId,
      whitehat: accountId,
      block: blockArb,
      header: bytes,
      proofs_json: fc.string(),
      submitted_at_ns: uint(64n),
    }),
  }),
);

const claimArb = fc.record({
  bounty: bountyId,
  whitehat: accountId,
  block: blockArb,
  header: bytes,
  proofs: fc.array(accountProofArb, { maxLength: 3 }),
  sealed_exploit: fc.uint8Array({ minLength: 1, maxLength: 60 }).map((b) => Buffer.from(b).toString("base64")),
});

const sealedBundleArb = fc.record({ whitehat: accountId, exploit: exploitArb });

const verdictArb = fc.constantFrom(...REASONS).map((r) => ({ outcome: r.outcome, reason: r.reason }));

const formats = [
  ["rules", rulesArb, parseRules],
  ["claim", claimArb, parseClaim],
  ["verdict", verdictArb, parseVerdict],
  ["bounty_id", bountyId, parseBountyId],
  ["exploit", exploitArb, parseExploit],
  ["job", jobArb, parseJob],
  ["sealed_bundle", sealedBundleArb, parseSealedBundle],
] as const;

test.each(formats.map((f) => [f[0], f]))("R1.2 %s: Rust writes back exactly what TypeScript wrote", (_k, f) => {
  const [kind, arb, parse] = f;
  const values = fc.sample(arb as fc.Arbitrary<unknown>, { numRuns: 300, seed: 6 });
  const written = values.map((v) => toJson((parse as (v: unknown) => unknown)(v)));
  const replies = rust(written.map((w) => ({ kind, value: JSON.parse(w) })));
  replies.forEach((reply, i) => {
    expect(reply.err, written[i]).toBeUndefined();
    expect(JSON.stringify(reply.ok)).toBe(written[i]);
  });
});

const nearMiss = fc.oneof(
  fc.string({ maxLength: 70 }),
  fc.stringMatching(/^[a-zA-Z0-9._\-/]{0,70}$/),
  accountId,
  bountyName,
);

test("D25: account IDs and bounty names, the pause-role path's parts: Rust and TypeScript accept and refuse the same strings", () => {
  const strings = fc.sample(nearMiss, { numRuns: 2000, seed: 6 });
  const replies = rust(strings.flatMap((s) => [{ kind: "account_id", value: s }, { kind: "bounty_name", value: s }]));
  strings.forEach((s, i) => {
    expect(replies[2 * i]!.ok !== undefined, `account ${JSON.stringify(s)}`).toBe(isAccountId(s));
    expect(replies[2 * i + 1]!.ok !== undefined, `name ${JSON.stringify(s)}`).toBe(isBountyName(s));
  });
});

test("D25 Rust and TypeScript derive the same pause-role address for any bounty", () => {
  const inputs = fc.sample(fc.record({ bounty_contract: accountId, bounty: bountyId }), { numRuns: 100, seed: 25 });
  const replies = rust(
    inputs.map((v) => ({ kind: "pause_role_address", value: { root: pauseRole.TESTNET_ROOT_PUBLIC_KEY, ...v } })),
  );
  inputs.forEach((v, i) => {
    expect(replies[i]!.ok).toBe(pauseRole.address(pauseRole.TESTNET_ROOT_PUBLIC_KEY, v.bounty_contract, v.bounty));
  });
});
