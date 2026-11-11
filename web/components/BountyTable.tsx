"use client";
// The bounty list's tabs and table (DESIGN.md, Bounty list). The server's read seeds it and a
// background query keeps it current (lib/live.ts); switching tab or sort filters and orders the
// rows already here, in place, with no read of its own, and writes the view into
// the URL with history.pushState, which the App Router folds into useSearchParams, so back,
// forward and a shared link all land on the same view with no new read. Every control is still
// a real link or GET form, so the page works without JavaScript.
import { useSearchParams } from "next/navigation";
import type { MouseEvent, ReactNode } from "react";
import { ReadFailed } from "./ReadFailed.tsx";
import { ChainMark } from "./ChainMark.tsx";
import { StatusChip } from "./Chips.tsx";
import { Hint } from "./Hint.tsx";
import { SortSelect } from "./SortSelect.tsx";
import { countsFor, firstDir, flip, idOf, rowsFor, viewHref, viewOf, type Dir, type SortKey, type Tab, type View } from "@/lib/bounty-list.ts";
import type { BountyList, BountyRow } from "@/lib/bounties.ts";
import { useBountyList } from "@/lib/live.ts";

const href = (r: BountyRow) => `/bounties/${encodeURIComponent(r.id.protocol)}/${encodeURIComponent(r.id.name)}`;
const EMPTY: Record<Tab, string> = { current: "No bounties are live.", past: "No bounties have ended yet." };

/** Show a view in place. Only a plain click: a modified one (new tab, new window) follows the link. */
function go(view: View, e?: MouseEvent) {
  if (e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
  }
  window.history.pushState(null, "", viewHref(view));
}

const Arrow = ({ dir }: { dir: Dir }) => (
  <svg className="sort-arrow" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d={dir === "asc" ? "M6 10V2M2.5 5.5 6 2l3.5 3.5" : "M6 2v8M2.5 6.5 6 10l3.5-3.5"} stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A sortable column's header: this column sorted, or flipped if it already is. */
function SortHeader({ view, sort, right, tip, children }: { view: View; sort: SortKey; right?: boolean; tip?: string; children: ReactNode }) {
  const active = view.sort === sort;
  const next: View = { tab: view.tab, sort, dir: active ? flip(view.dir) : firstDir(view.tab, sort) };
  const to = viewHref(next);
  const label = (
    <>
      {children}
      {active && <Arrow dir={view.dir} />}
    </>
  );
  return (
    <th className={`col-${sort}${right ? " r" : ""}`} aria-sort={active ? (view.dir === "asc" ? "ascending" : "descending") : undefined} data-active={active || undefined}>
      {tip ? (
        <Hint tip={tip} href={to} onClick={(e) => go(next, e)}>
          {label}
        </Hint>
      ) : (
        <a className="sort" href={to} onClick={(e) => go(next, e)}>
          {label}
        </a>
      )}
    </th>
  );
}

const clock = (ms: number) => new Date(ms).toISOString().slice(11, 19) + " UTC";

export function BountyTable({ initial, readAt }: { initial: BountyList; readAt: number }) {
  const q = useBountyList(initial, readAt);
  const list = q.data;
  const view = viewOf(Object.fromEntries(useSearchParams()));
  const rows = rowsFor(list.rows, view);
  const count = countsFor(list.rows);
  return (
    <>
      <div className="list-bar">
        <nav className="tabs" aria-label="Bounties">
          {(["current", "past"] as const).map((tab) => (
            <a key={tab} href={viewHref(viewOf({ tab }))} onClick={(e) => go(viewOf({ tab }), e)} aria-current={view.tab === tab ? "page" : undefined}>
              {tab === "current" ? "Live" : "Past"} <span className="n">{count[tab]}</span>
            </a>
          ))}
        </nav>
        <SortSelect view={view} onPick={(v) => go(v)} />
      </div>
      {q.isError && (
        <div className="block">
          <ReadFailed what="Couldn't refresh from NEAR" lastGood={clock(q.dataUpdatedAt)} onRetry={() => q.refetch()} />
        </div>
      )}
      <p className="source">
        Read live from{" "}
        <a className="datum" href={list.contractHref} target="_blank" rel="noopener">
          {list.contract}
        </a>
      </p>
      {rows.length === 0 ? (
        <p className="empty">{EMPTY[view.tab]}</p>
      ) : (
        <table className="list">
          <thead>
            <tr>
              <SortHeader view={view} sort="bounty">
                Bounty
              </SortHeader>
              <th className="col-chains">Chains</th>
              <SortHeader view={view} sort="pays" right>
                Pays
              </SortHeader>
              <SortHeader view={view} sort="theft" right tip="Pays only for an exploit that could steal at least this much.">
                Minimum theft
              </SortHeader>
              <SortHeader view={view} sort="ends" right>
                Ends
              </SortHeader>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={idOf(r)}>
                <td>
                  <span className="head">
                    <a className="id" href={href(r)}>
                      {idOf(r)}
                    </a>
                    <StatusChip state={r.state} />
                  </span>
                  <span className="sub">
                    {r.amount} · ends {r.ends}
                    <span className="marks">
                      {r.chains.map((c) => (
                        <ChainMark key={c.id} chainId={c.id} name={c.name} />
                      ))}
                    </span>
                  </span>
                </td>
                <td>
                  <span className="marks">
                    {r.chains.map((c) => (
                      <ChainMark key={c.id} chainId={c.id} name={c.name} />
                    ))}
                  </span>
                </td>
                <td className="r">{r.amount}</td>
                <td className="r">{r.minimumTheft}</td>
                <td className="r">{r.ends}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
