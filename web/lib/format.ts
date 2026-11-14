// How values read from the chains are written on the page (DESIGN.md, Voice and copy).
// Shared by server and browser code.

/** A whole-unit amount from its smallest units: "10", "2.5", "0.000123". */
export function units(raw: string | bigint, decimals: number): string {
  const s = BigInt(raw).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** A NEAR timestamp in nanoseconds as an ISO date: the bounty list's "Ends" once a bounty is no longer Live. */
export const isoDate = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(0, 10);

/** A contract time in nanoseconds, to the minute in UTC: "2026-11-12 04:37 UTC". */
export const utcMinute = (ns: string) => `${new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/**
 * Time left until a contract time, in whole units, never rounded up (it never overstates what is left):
 * "1 day 23 hours" from a day on, "5 hours 12 minutes" under a day, "42 minutes" under an hour,
 * "less than a minute" in the last one. A zero part is left out. Null once the time has passed, so
 * the caller shows the date instead.
 */
export function timeLeft(endNs: string, nowMs: number): string | null {
  const mins = Math.floor((Number(BigInt(endNs) / 1_000_000n) - nowMs) / 60_000);
  if (mins < 0) return null;
  if (mins === 0) return "less than a minute";
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const d = Math.floor(mins / 1440);
  const h = Math.floor((mins % 1440) / 60);
  const m = mins % 60;
  const parts = d > 0 ? [unit(d, "day"), h ? unit(h, "hour") : ""] : h > 0 ? [unit(h, "hour"), m ? unit(m, "minute") : ""] : [unit(m, "minute")];
  return parts.filter(Boolean).join(" ");
}

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
