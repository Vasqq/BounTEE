// How the bounty list is cut and ordered (DESIGN.md, Bounty list): a Live and a Past tab ("current" in the URL),
// and a column to sort by, both read from the page's URL so a view can be linked.
import type { BountyRow, PublicState } from "./bounties.ts";

export type Tab = "current" | "past";
export type SortKey = "bounty" | "pays" | "theft" | "ends";
export type Dir = "asc" | "desc";
export interface View {
  tab: Tab;
  sort: SortKey;
  dir: Dir;
}

/** Still open to a claim, or mid-way through one: everything else is over. */
const CURRENT: readonly PublicState[] = ["Live", "Checking", "Paying"];
export const isCurrent = (r: BountyRow) => CURRENT.includes(r.state);

const SORTS: readonly SortKey[] = ["bounty", "pays", "theft", "ends"];

export const flip = (dir: Dir): Dir => (dir === "asc" ? "desc" : "asc");

/** How many bounties each tab holds. */
export function countsFor(rows: BountyRow[]): Record<Tab, number> {
  const current = rows.filter(isCurrent).length;
  return { current, past: rows.length - current };
}

/** The order a column takes when first picked: the end a visitor most likely wants on top. */
export function firstDir(tab: Tab, sort: SortKey): Dir {
  if (sort === "bounty") return "asc";
  if (sort === "ends") return tab === "current" ? "asc" : "desc";
  return "desc";
}

/** Live opens on the highest bounty amount; Past on what ended last. */
const DEFAULT_SORT: Record<Tab, SortKey> = { current: "pays", past: "ends" };

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * The view a URL asks for, falling back to each tab's default for anything missing or unknown.
 * `order=pays:asc` is the sort select's form, sent when the page runs without JavaScript.
 */
export function viewOf(params: Params): View {
  const tab: Tab = one(params.tab) === "past" ? "past" : "current";
  // `sort` and `dir` come together from one form or the other, never one from each.
  const [orderSort, orderDir] = (one(params.order) ?? "").split(":");
  const fromOrder = one(params.sort) === undefined;
  const asked = (fromOrder ? orderSort : one(params.sort)) as SortKey | undefined;
  const valid = !!asked && SORTS.includes(asked);
  const sort = valid ? asked : DEFAULT_SORT[tab];
  const dir = valid ? (fromOrder ? orderDir : one(params.dir)) : undefined;
  return { tab, sort, dir: dir === "asc" || dir === "desc" ? dir : firstDir(tab, sort) };
}

/** The list's address for a view, leaving out whatever is that tab's default. */
export function viewHref({ tab, sort, dir }: View): string {
  const q = new URLSearchParams();
  if (tab !== "current") q.set("tab", tab);
  if (sort !== DEFAULT_SORT[tab] || dir !== firstDir(tab, sort)) {
    q.set("sort", sort);
    q.set("dir", dir);
  }
  const s = q.toString();
  return s ? `/bounties?${s}` : "/bounties";
}

export const idOf = (r: BountyRow) => `${r.id.protocol}/${r.id.name}`;
const cmpBig = (a: string, b: string) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
const BY: Record<SortKey, (a: BountyRow, b: BountyRow) => number> = {
  bounty: (a, b) => idOf(a).localeCompare(idOf(b)),
  pays: (a, b) => cmpBig(a.amountUnits, b.amountUnits),
  theft: (a, b) => cmpBig(a.minimumTheftUnits, b.minimumTheftUnits),
  ends: (a, b) => cmpBig(a.endNs, b.endNs),
};

/** One tab's rows in the view's order; ties keep A to Z by bounty, whichever way the column runs. */
export function rowsFor(rows: BountyRow[], view: View): BountyRow[] {
  const sign = view.dir === "asc" ? 1 : -1;
  return rows
    .filter((r) => isCurrent(r) === (view.tab === "current"))
    .sort((a, b) => sign * BY[view.sort](a, b) || BY.bounty(a, b));
}
