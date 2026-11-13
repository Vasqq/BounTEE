// How values read from the chains are written on the page (DESIGN.md, Voice and copy).
// Shared by server and browser code.

/** A whole-unit amount from its smallest units: "10", "2.5", "0.000123". */
export function units(raw: string | bigint, decimals: number): string {
  const s = BigInt(raw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** A NEAR timestamp in nanoseconds as an ISO date, the way the bounty list shows "Ends". */
export const isoDate = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(0, 10);

/** A contract time in nanoseconds, to the minute in UTC: "2026-11-12 04:37 UTC". */
export const utcMinute = (ns: string) => `${new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** The first 6 characters, an ellipsis, the last 4 (DESIGN.md, Chips). */
export const shortHash = (hash: string) => (hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash);

/**
 * A NEAR account as a chip shows it: an implicit account is 64 hex characters, a hash in all
 * but name, so it is shortened like one; a named account reads as itself.
 */
export const shortAccount = (account: string) => (/^[0-9a-f]{64}$/.test(account) ? shortHash(account) : account);

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A list as the copy writes it: "NEAR, Base and Arbitrum One". */
export const listOf = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
