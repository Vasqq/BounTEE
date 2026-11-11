"use client";
// The Verify check list (DESIGN.md, Terminal and Verify check list): R15.1's checks read live,
// PASS, FAIL or WAIT, then a summary that counts failures first.
import { useEffect, useState } from "react";
import type { BountyId, PublicState } from "@/lib/bounties.ts";
import { useVerify } from "@/lib/live.ts";
import { verifyCommand } from "@/lib/network.ts";
import { BOUNTY_CONTRACT } from "@/lib/pinned.ts";
import type { VerifyRow } from "@/lib/verify.ts";
import { CommandBlock } from "./CommandBlock.tsx";
import { DitherHalo } from "./DitherHalo.tsx";
import { ReadFailed } from "./ReadFailed.tsx";

const MARK = { pass: "PASS", fail: "FAIL", wait: "WAIT" } as const;
/** The same states in plain words, for the bounty page's proof timeline (the landing terminal keeps the marks). */
const WORD = { pass: "Pass", fail: "Fail", wait: "Not yet run" } as const;

/** The checks that rebuild code from source: only the command-line tool can run them. */
const LOCAL = new Set(["Contract code matches source", "Judge build is the one that ran"]);

/**
 * For a check that hasn't run, when it will, in plain words (the bounty page only; the landing terminal
 * keeps the command-line tool's details). A pause landed on some chains keeps its own detail.
 */
function whenItRuns(r: VerifyRow): string {
  if (LOCAL.has(r.name)) return "Run it yourself, below.";
  if (r.name === "Re-run of the published exploit") {
    if (r.detail.startsWith("published")) return "Run it yourself, below.";
    const days = /after (\d+ days?)/.exec(r.detail)?.[1];
    return days ? `${days} after the payout.` : r.detail;
  }
  if (r.detail.startsWith("not yet on")) return r.detail;
  return "Once a claim wins.";
}

function Summary({ rows }: { rows: VerifyRow[] }) {
  const n = (s: VerifyRow["status"]) => rows.filter((r) => r.status === s).length;
  const fail = n("fail");
  const parts = [`${n("pass")} passing`, `${n("wait")} not yet`];
  return (
    <p className="sum">
      {fail > 0 ? (
        <>
          <b className="fail">{fail} failing</b>, {parts.join(", ")}.
        </>
      ) : (
        <>
          <b className={n("pass") === 0 ? "zero" : undefined}>{parts[0]}</b>, {parts[1]}.
        </>
      )}
    </p>
  );
}

/** The rows and summary, as the terminal body lists them. */
export function VerifyRun({ rows }: { rows: VerifyRow[] }) {
  return (
    <>
      <ul className="run" aria-label="Check results">
        {rows.map((r) => (
          <li key={r.name}>
            <span className={`st ${r.status}`}>{MARK[r.status]}</span>
            <span className="name">{r.name}</span>
            <span className="det">
              {r.detail}
              {r.links.map((l) => (
                <span key={l.href}>
                  {" · "}
                  <a href={l.href} target="_blank" rel="noopener">
                    {l.label}
                  </a>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
      <Summary rows={rows} />
    </>
  );
}

/**
 * A bounty page's Verify section (D6), as a proof timeline: R15.1's checks in the order a bounty's life
 * proves them, each cell filling green once it passes, the count of proven checks above, and the command
 * to run every check yourself below. The checks are read live; the cells light up one after another.
 */
export function VerifyTerminal({ id, state }: { id: BountyId; state?: PublicState }) {
  // A bounty that closed without a winner can never pass the on-chain checks: they won't run, not "not yet".
  const closed = state === "Withdrawn" ? "The bounty was withdrawn with no winner." : state === "Not posted" ? "The bounty never went live." : null;
  const q = useVerify(id);
  const result = q.data ?? null;
  // The server names the contract it read the checks from; until it answers, this build's.
  const command = result?.command ?? verifyCommand(id, BOUNTY_CONTRACT);
  // The cells mount unlit, then light on the next frame, so each one's delay plays.
  const [ran, setRan] = useState(false);
  useEffect(() => {
    if (!result || ran) return;
    const f = requestAnimationFrame(() => requestAnimationFrame(() => setRan(true)));
    return () => cancelAnimationFrame(f);
  }, [result, ran]);
  const all = result?.rows ?? [];
  // Two checks rebuild code from source, which only the command-line tool can do; they sit under
  // "Run it yourself". The other five are a bounty's events in the order they happen: the timeline.
  const local = all.filter((r) => LOCAL.has(r.name));
  const rows = all.filter((r) => !LOCAL.has(r.name));
  const pass = rows.filter((r) => r.status === "pass").length;
  const fail = all.filter((r) => r.status === "fail").length;
  const lastPass = rows.map((r) => r.status).lastIndexOf("pass");
  return (
    <section className="block" aria-label="Verify">
      <h2>Verify</h2>
      <p className="section-lead">Seven checks show this bounty ran by its rules.</p>
      <div className={`panel-app vpanel${ran ? " ran" : ""}`}>
        {q.isError && !result ? (
          <ReadFailed what="Couldn't run the checks" onRetry={() => q.refetch()} />
        ) : (
          <>
            <div className="vsub">
              <h3>On chain</h3>
              <p>Read live from each chain, in the order they happen.</p>
            </div>
            <p className="vcount" aria-live="polite">
              {result ? (
                <>
                  <b className={pass > 0 ? "ok" : undefined}>{pass}</b> of {rows.length} proven
                  {fail > 0 && <span className="fail-count"> · {fail} failing</span>}
                </>
              ) : (
                <span className="bar" style={{ width: 180, height: 26, "--i": 0 } as React.CSSProperties} aria-hidden="true" />
              )}
            </p>
            <ol className="vtl" aria-label="Check results">
              {(result ? rows : Array.from({ length: 5 }, () => null)).map((r, i) => {
                if (!r)
                  return (
                    <li key={i} className="vstep" aria-hidden="true">
                      <span className="node" />
                      <span className="bar" style={{ width: "70%", height: 14, "--i": i } as React.CSSProperties} />
                    </li>
                  );
                // The line to the next step turns green only between two passed checks; the pulse marks the furthest one proven.
                const linked = r.status === "pass" && rows[i + 1]?.status === "pass";
                const frontier = !closed && i === (lastPass >= 0 ? lastPass : 0);
                return (
                  <li key={r.name} className={`vstep ${r.status}${linked ? " linked" : ""}${frontier ? " frontier" : ""}`} style={{ "--row-d": `${120 + i * 140}ms` } as React.CSSProperties}>
                    <span className="node" aria-hidden="true">
                      {frontier && ran && <DitherHalo tone={r.status === "pass" ? "proven" : "grey"} />}
                    </span>
                    <span className="nm">
                      <span className="n">{i + 1}.</span> {r.name}
                    </span>
                    <span className={`st ${r.status}`}>{closed && r.status === "wait" ? "Won't run" : WORD[r.status]}</span>
                    <span className="det">
                      {r.status === "wait" ? (closed ?? whenItRuns(r)) : r.detail}
                      {(r.status !== "wait" || r.detail.startsWith("not yet on")) &&
                        r.links.map((l) => (
                          <span key={l.href}>
                            {" · "}
                            <a href={l.href} target="_blank" rel="noopener">
                              {l.label}
                            </a>
                          </span>
                        ))}
                    </span>
                  </li>
                );
              })}
            </ol>
            <div className="vrun">
              <div className="vsub">
                <h3>On your machine</h3>
                <p>These rebuild the code from source, so they run only with the command below.</p>
              </div>
              <ul className="vlocal" aria-label="Checks only the command runs">
                {(result ? local : [null, null]).map((r, i) =>
                  r ? (
                    <li key={r.name}>
                      <span className="nm">{r.name}</span>
                      <span className={`st ${r.status}`}>{WORD[r.status]}</span>
                    </li>
                  ) : (
                    <li key={i} aria-hidden="true">
                      <span className="bar" style={{ width: 220, height: 14, "--i": i } as React.CSSProperties} />
                    </li>
                  ),
                )}
              </ul>
              <CommandBlock prompt text={command} />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
