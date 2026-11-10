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

/** The first 6 characters, an ellipsis, the last 4 (DESIGN.md, Chips). */
export const shortHash = (hash: string) => (hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash);

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A list as the copy writes it: "NEAR, Base and Arbitrum One". */
export const listOf = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
