"use client";
// The Verify check list (DESIGN.md, Terminal and Verify check list): R15.1's checks read live,
// PASS, FAIL or WAIT, then a summary that counts failures first.
import { useState } from "react";
import type { BountyId } from "@/lib/bounties.ts";
import { useVerify } from "@/lib/live.ts";
import { verifyCommand } from "@/lib/network.ts";
import { BOUNTY_CONTRACT } from "@/lib/pinned.ts";
import type { VerifyRow } from "@/lib/verify.ts";
import { ReadFailed } from "./ReadFailed.tsx";

const MARK = { pass: "PASS", fail: "FAIL", wait: "WAIT" } as const;

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
          <b>{parts[0]}</b>, {parts[1]}.
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

/** A bounty page's Verify section: the command in the bar, the checks read live below it. */
export function VerifyTerminal({ id }: { id: BountyId }) {
  const q = useVerify(id);
  const result = q.data ?? null;
  // The server names the contract it read the checks from; until it answers, this build's.
  const command = result?.command ?? verifyCommand(`${id.protocol}/${id.name}`, BOUNTY_CONTRACT);
  const [label, setLabel] = useState("Copy");
  const copy = async () => {
    await navigator.clipboard.writeText(command).then(() => setLabel("Copied"), () => setLabel("Copy failed"));
    setTimeout(() => setLabel("Copy"), 1600);
  };
  return (
    <section className="block" aria-label="Verify">
      <h2>Verify</h2>
      <div className="term ran">
        <div className="term-bar">
          <code>
            <span className="p" aria-hidden="true">
              $
            </span>
            {command}
          </code>
          <button className="copy" type="button" onClick={copy}>
            {label}
          </button>
        </div>
        <div className="term-body">
          <p className="note">reading {id.name} from the chains, with no keys and no funds</p>
          {q.isError && !result ? <ReadFailed what="Couldn't run the checks" onRetry={() => q.refetch()} /> : result ? <VerifyRun rows={result.rows} /> : <p className="note">reading…</p>}
        </div>
      </div>
    </section>
  );
}
