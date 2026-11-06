"use client";
// The Verify check list (DESIGN.md, Terminal and Verify check list): R15.1's checks read live,
// PASS, FAIL or WAIT, then a summary that counts failures first.
import { useCallback, useEffect, useState } from "react";
import type { BountyId } from "@/lib/bounties.ts";
import type { VerifyResult, VerifyRow } from "@/lib/verify.ts";
import { ReadFailed } from "./ReadFailed.tsx";

const MARK = { pass: "PASS", fail: "FAIL", wait: "WAIT" } as const;
const POLL_MS = 30_000;

export function useVerify(id: BountyId | null) {
  const [result, setResult] = useState<VerifyResult | null>(null);
  const [failed, setFailed] = useState(false);
  const read = useCallback(async () => {
    if (!id) return;
    try {
      const res = await fetch(`/api/bounties/${encodeURIComponent(id.protocol)}/${encodeURIComponent(id.name)}/verify`, { cache: "no-store" });
      const body = (await res.json()) as { verify?: VerifyResult | null };
      if (!res.ok) throw new Error(String(res.status));
      setResult(body.verify ?? null);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [id?.protocol, id?.name]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    read();
    const t = setInterval(read, POLL_MS);
    return () => clearInterval(t);
  }, [read]);
  return { result, failed, read };
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
  const { result, failed, read } = useVerify(id);
  const command = `bountee verify ${id.protocol}/${id.name} --network mainnet`;
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
          {failed && !result ? <ReadFailed what="Couldn't run the checks" onRetry={read} /> : result ? <VerifyRun rows={result.rows} /> : <p className="note">reading…</p>}
        </div>
      </div>
    </section>
  );
}
