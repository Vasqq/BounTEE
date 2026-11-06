"use client";
// A bounty's public page, read live: the browser asks the app's server, which reads the
// chains on each request (R15.6), and asks again every 15 s. Values swap in place; nothing
// animates in (DESIGN.md, Motion).
import { useCallback, useEffect, useState } from "react";
import type { BountyId, BountyPage, ChainPause } from "@/lib/bounties.ts";
import { rulesInPlainEnglish, whatDoesntPay } from "@/lib/rules.ts";
import { ChainMark } from "./ChainMark.tsx";
import { StatusChip, TxChip } from "./Chips.tsx";
import { CommandBlock } from "./CommandBlock.tsx";
import { ReadFailed } from "./ReadFailed.tsx";

const POLL_MS = 15_000;
const CHAIN_IDS: Record<string, number> = { Base: 8453, "Arbitrum One": 42161 };

type Load = { status: "loading" } | { status: "missing" } | { status: "ok"; bounty: BountyPage; at: Date } | { status: "failed"; last: { bounty: BountyPage; at: Date } | null };

export function useBounty(id: BountyId) {
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const read = useCallback(async () => {
    try {
      const res = await fetch(`/api/bounties/${encodeURIComponent(id.protocol)}/${encodeURIComponent(id.name)}`, { cache: "no-store" });
      const body = (await res.json()) as { bounty?: BountyPage | null; error?: string };
      if (!res.ok) throw new Error(body.error ?? String(res.status));
      setLoad(body.bounty ? { status: "ok", bounty: body.bounty, at: new Date() } : { status: "missing" });
    } catch {
      setLoad((prev) => ({ status: "failed", last: prev.status === "ok" ? { bounty: prev.bounty, at: prev.at } : prev.status === "failed" ? prev.last : null }));
    }
  }, [id.protocol, id.name]);
  useEffect(() => {
    read();
    const t = setInterval(read, POLL_MS);
    return () => clearInterval(t);
  }, [read]);
  return { load, read };
}

const Bar = ({ w, h = 18 }: { w: number; h?: number }) => <span className="bar" style={{ width: w, height: h }} aria-hidden="true" />;

export function BountyLive({ id }: { id: BountyId }) {
  const { load, read } = useBounty(id);
  const title = `${id.protocol}/${id.name}`;
  if (load.status === "missing") {
    return (
      <>
        <h1 className="page-title">{title}</h1>
        <p className="lead">The bounty contract holds no bounty {title}.</p>
      </>
    );
  }
  const b = load.status === "ok" ? load.bounty : load.status === "failed" ? load.last?.bounty ?? null : null;
  const lastGood = load.status === "failed" && load.last ? load.last.at.toISOString().slice(11, 19) + " UTC" : null;
  return (
    <>
      <div className="title-row">
        <h1 className="page-title">{title}</h1>
        {b ? <StatusChip state={b.state} /> : <Bar w={64} h={30} />}
      </div>
      {load.status === "failed" && (
        <div className="block">
          <ReadFailed what="Couldn't read the chains" lastGood={lastGood} onRetry={read} />
        </div>
      )}
      <dl className="proof" aria-label="The bounty">
        <dt>Bounty amount</dt>
        <dd data-testid="bounty-amount">{b ? b.amount : <Bar w={72} h={14} />}</dd>
        <dt>Minimum theft</dt>
        <dd data-testid="minimum-theft">{b ? b.minimumTheft : <Bar w={64} h={14} />}</dd>
        <dt>Ends</dt>
        <dd>{b ? b.ends : <Bar w={84} h={14} />}</dd>
        <dt>Claims judged</dt>
        <dd data-testid="claims-judged">{b ? b.claimsJudged : <Bar w={16} h={14} />}</dd>
      </dl>
      {b && (
        <>
          <section className="block cols" aria-label="Rules">
            <div className="panel-app">
              <h2 className="h-panel">Rules in plain English</h2>
              {rulesInPlainEnglish(b).map((t) => (
                <p key={t}>{t}</p>
              ))}
            </div>
            <div className="panel-app">
              <h2 className="h-panel">What doesn't pay</h2>
              <ul className="plain">
                {whatDoesntPay(b).map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </div>
          </section>
          <section className="block" aria-labelledby="pauseH">
            <h2 id="pauseH">Pause, per chain</h2>
            <div className="pauses">
              {b.chains.map((c) => (
                <PauseRow key={c.chainId} c={c} />
              ))}
            </div>
          </section>
        </>
      )}
    </>
  );
}

function Step({ n, label, done, children, waiting = "not yet" }: { n: number; label: string; done: boolean; children?: React.ReactNode; waiting?: string }) {
  return (
    <li className="step">
      <span className="lbl">
        <span className={`num${done ? " ok" : ""}`}>{n}.</span> {label}
        <span className="sr-only">{done ? " done" : " not yet"}</span>
      </span>
      {done ? <div className="meta">{children}</div> : <p className="wait" aria-hidden="true">{waiting}</p>}
    </li>
  );
}

function PauseRow({ c }: { c: ChainPause }) {
  const signed = c.pauses.length > 0;
  return (
    <section className="panel-app pause-row" aria-label={`Pause on ${c.chain}`}>
      <div className="pause-head">
        <ChainMark chainId={c.chainId ?? CHAIN_IDS[c.chain]} name={c.chain} />
        <h3>{c.chain}</h3>
      </div>
      <ol className="steps">
        <Step n={1} label="Signed" done={signed}>
          {c.signed && <TxChip {...c.signed} />}
        </Step>
        <Step n={2} label="Landed" done={c.landed}>
          {c.pauses.map((p) => (
            <TxChip key={p.hash} chain={c.chain} hash={p.hash} href={p.href} />
          ))}
        </Step>
        <Step n={3} label="Verified" done={!!c.verified}>
          {c.verified?.hash ? <TxChip {...c.verified} /> : null}
        </Step>
      </ol>
      {c.gas?.low && (
        <div className="warnbox" role="note" aria-label={`Low pause gas on ${c.chain}`}>
          <span className="chip warn">Low pause gas</span>
          <p>
            Pause gas on {c.chain}: {c.gas.held} {c.gas.token}. The signed pause needs {c.gas.needed} {c.gas.token}. Top up the pause-role address.
          </p>
          <CommandBlock text={c.gas.address} />
        </div>
      )}
    </section>
  );
}
