"use client";
// The bounty list's sort on a phone or tablet, where the table's headers are hidden
// (DESIGN.md, Bounty list): one select whose choice sorts the list in place, as a header click
// does. Without JavaScript it is a plain GET form with its own button (lib/bounty-list.ts reads `order`).
import { firstDir, flip, type Dir, type SortKey, type View } from "@/lib/bounty-list.ts";

const LABEL: Record<SortKey, Record<Dir, string>> = {
  pays: { desc: "Pays, highest first", asc: "Pays, lowest first" },
  theft: { desc: "Minimum theft, highest first", asc: "Minimum theft, lowest first" },
  ends: { asc: "Ends, soonest first", desc: "Ends, latest first" },
  bounty: { asc: "Bounty, A to Z", desc: "Bounty, Z to A" },
};

export function SortSelect({ view, onPick }: { view: View; onPick: (view: View) => void }) {
  const options = (Object.keys(LABEL) as SortKey[]).flatMap((sort) => {
    const first = firstDir(view.tab, sort);
    return [first, flip(first)].map((dir) => ({ value: `${sort}:${dir}`, label: LABEL[sort][dir] }));
  });
  return (
    <form className="sort-select" method="get" action="/bounties">
      {view.tab !== "current" && <input type="hidden" name="tab" value={view.tab} />}
      <label>
        <span className="sr-only">Sort by</span>
        <select
          name="order"
          value={`${view.sort}:${view.dir}`}
          onChange={(e) => {
            const [sort, dir] = e.target.value.split(":") as [SortKey, Dir];
            onPick({ tab: view.tab, sort, dir });
          }}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <noscript>
        <button type="submit" className="btn btn-line">
          Sort
        </button>
      </noscript>
    </form>
  );
}
