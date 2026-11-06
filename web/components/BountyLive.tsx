"use client";
// A bounty's public page, read live: the browser asks the app's server, which reads the
// chains on each request (R15.6), every 15 s, or every 3 s while a sent pause waits to land.
// Values swap in place; nothing animates in (DESIGN.md, Motion).
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BountyId, BountyPage, ChainPause } from "@/lib/bounties.ts";
import { bountyKey, useBounty } from "@/lib/live.ts";
import { rulesInPlainEnglish, whatDoesntPay } from "@/lib/rules.ts";
import { ChainMark } from "./ChainMark.tsx";
import { StatusChip, TxChip } from "./Chips.tsx";
import { CommandBlock } from "./CommandBlock.tsx";
import { ReadFailed } from "./ReadFailed.tsx";
import { SendPause } from "./SendPause.tsx";
import { VerifyTerminal } from "./Verify.tsx";

const Bar = ({ w, h = 18 }: { w: number; h?: number }) => <span className="bar" style={{ width: w, height: h }} aria-hidden="true" />;

export function BountyLive({ id }: { id: BountyId }) {
  // Chains whose pause this browser sent and that haven't landed yet: read fast until they do.
  const [sent, setSent] = useState<number[]>([]);
  const last = useQueryClient().getQueryData<BountyPage | null>(bountyKey(id));
  const q = useBounty(id, sent.some((chain) => !last?.chains.find((c) => c.chainId === chain)?.landed));
  const b = q.data ?? null;
  const title = `${id.protocol}/${id.name}`;
  if (q.isSuccess && q.data === null) {
    return (
      <>
        <h1 className="page-title">{title}</h1>
        <p className="lead">The bounty contract holds no bounty {title}.</p>
      </>
    );
  }
  const lastGood = q.isError && q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toISOString().slice(11, 19) + " UTC" : null;
  return (
    <>
      <div className="title-row">
        <h1 className="page-title">{title}</h1>
        {b ? <StatusChip state={b.state} /> : <Bar w={64} h={30} />}
      </div>
      {q.isError && (
        <div className="block">
          <ReadFailed what="Couldn't read the chains" lastGood={lastGood} onRetry={() => q.refetch()} />
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
      {b?.state === "Paid" && (
        <p className="block">
          <a className="btn btn-line" href={`/bounties/${encodeURIComponent(id.protocol)}/${encodeURIComponent(id.name)}/exploit`}>
            Open the winning exploit
          </a>
        </p>
      )}
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
                <PauseRow key={c.chainId} c={c} sent={sent.includes(c.chainId)} onSent={() => setSent((s) => [...s, c.chainId])} />
              ))}
            </div>
          </section>
        </>
      )}
      <VerifyTerminal id={id} />
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

function PauseRow({ c, sent, onSent }: { c: ChainPause; sent: boolean; onSent: () => void }) {
  const signed = c.pauses.length > 0;
  const unlanded = c.pauses.filter((p) => !p.landed);
  return (
    <section className="panel-app pause-row" aria-label={`Pause on ${c.chain}`}>
      <div className="pause-head">
        <ChainMark chainId={c.chainId} name={c.chain} />
        <h3>{c.chain}</h3>
      </div>
      <ol className="steps">
        <Step n={1} label="Signed" done={signed}>
          {c.signed && <TxChip {...c.signed} />}
        </Step>
        <Step n={2} label="Landed" done={c.landed} waiting={sent ? "sent · waiting for the receipt" : "not yet"}>
          {c.pauses.map((p) => (
            <TxChip key={p.hash} chain={c.chain} hash={p.hash} href={p.href} />
          ))}
        </Step>
        <Step n={3} label="Verified" done={!!c.verified}>
          {c.verified?.hash ? <TxChip {...c.verified} /> : null}
        </Step>
      </ol>
      {signed && unlanded.length > 0 && !sent && <SendPause chain={c.chain} rpc={c.rpc} pauses={unlanded} onSent={onSent} />}
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
