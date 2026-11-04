// TypeScript twins of formats/src/primitives.rs. Each must accept and refuse exactly the
// strings the Rust type does; formats/ts/test/roundtrip.test.ts checks that.

export class FormatError extends Error {
  override name = "FormatError";
}

export const fail = (what: string, value: unknown): never => {
  throw new FormatError(`invalid ${what}: ${JSON.stringify(value)}`);
};

const hexOf = (n: number) => new RegExp(`^0x[0-9a-f]{${n}}$`);
const ADDRESS = hexOf(40);
const B256_RE = hexOf(64);
const BYTES = /^0x([0-9a-f]{2})*$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PUBLIC_KEY = /^[a-z0-9]+:[1-9A-HJ-NP-Za-km-z]+$/;
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const BOUNTY_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** A NEAR account ID by NEAR's rules: 2–64 chars, `a-z0-9` with `-_.` separators. */
export const isAccountId = (s: string): boolean => s.length >= 2 && s.length <= 64 && ACCOUNT_ID.test(s);
/** A bounty's name: 1–64 chars of `a-z0-9-`, not starting or ending with `-`; never `/`. */
export const isBountyName = (s: string): boolean => s.length >= 1 && s.length <= 64 && BOUNTY_NAME.test(s);

const str = (what: string, ok: (s: string) => boolean) => (v: unknown): string =>
  typeof v === "string" && ok(v) ? v : fail(what, v);

const decimalAtMost = (max: bigint) => (s: string) => DECIMAL.test(s) && BigInt(s) <= max;

export const accountId = str("NEAR account ID", isAccountId);
export const bountyName = str("bounty name", isBountyName);
export const evmAddress = str("EVM address", (s) => ADDRESS.test(s));
export const b256 = str("32-byte hex value", (s) => B256_RE.test(s));
export const bytes = str("hex bytes", (s) => BYTES.test(s));
export const uint = str("unsigned integer", decimalAtMost(2n ** 256n - 1n));
export const u64 = str("64-bit unsigned integer", decimalAtMost(2n ** 64n - 1n));
export const base64 = str("base64", (s) => s.length > 0 && s.length % 4 === 0 && BASE64.test(s));
export const publicKey = str("public key", (s) => PUBLIC_KEY.test(s));

const int = (what: string, max: number) => (v: unknown): number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max ? v : fail(what, v);

/** A JSON-number integer up to 2^53 − 1 (chain IDs, block numbers). */
export const safeU64 = int("safe integer", Number.MAX_SAFE_INTEGER);
export const u32 = int("u32", 2 ** 32 - 1);
export const u16 = int("u16", 65535);

export const array = <T>(item: (v: unknown) => T) => (v: unknown): T[] =>
  Array.isArray(v) ? v.map(item) : fail("array", v);

/** Read an object with exactly these keys, in this order, refusing unknown ones. */
export const object = <T extends object>(fields: { [K in keyof T]: (v: unknown) => T[K] }) =>
  (v: unknown): T => {
    if (typeof v !== "object" || v === null || Array.isArray(v)) return fail("object", v);
    const input = v as Record<string, unknown>;
    for (const key of Object.keys(input)) if (!(key in fields)) fail("field", key);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(fields)) {
      if (!(key in input)) fail("missing field", key);
      out[key] = (fields as Record<string, (v: unknown) => unknown>)[key]!(input[key]);
    }
    return out as T;
  };
