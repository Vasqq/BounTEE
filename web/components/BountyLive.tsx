"use client";
// A bounty's details page, read live (DESIGN.md, Bounty page): the browser asks the app's server,
// which reads the chains on each request (R15.6), every 15 s, or every 3 s while a sent pause
// waits to land. The top answers what every reader asks first (is it real, what is at stake,
// where); each block below has a plain heading and shows only in the states it applies to.
// Values swap in place; nothing animates in (DESIGN.md, Motion).
import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BountyId, BountyPage, ChainPause, PostingFailure, PublicState } from "@/lib/bounties.ts";
import { plural, shortHash } from "@/lib/format.ts";
import { bountyKey, useBounty } from "@/lib/live.ts";
import { net } from "@/lib/network.ts";
import { BOUNTY_CONTRACT } from "@/lib/pinned.ts";
import { ChainMark } from "./ChainMark.tsx";
import { Ext, StatusChip, TxChip, TxPending } from "./Chips.tsx";
import { CommandBlock } from "./CommandBlock.tsx";
import { Hint } from "./Hint.tsx";
import { ReadFailed } from "./ReadFailed.tsx";
import { SendPause } from "./SendPause.tsx";
import { VerifyTerminal } from "./Verify.tsx";

const REPO = "https://github.com/Vasqq/bountee";

/** The Rules section's one-line summary, shown while loading and once read. */
const RULES_LEAD = "Locked at posting. Nobody can change these rules or upgrade the contract.";

/** NEAR's N mark, as the landing page's "Built on NEAR" badge draws it. */
const NearMark = () => (
  <svg className="near-mark" viewBox="0 0 16 16" aria-hidden="true">
    <path
      d="M13.9017 0.646973C13.3462 0.646973 12.8304 0.929357 12.5394 1.39357L9.40403 5.95741C9.30186 6.10784 9.34331 6.31059 9.49675 6.41075C9.6211 6.49202 9.78561 6.48196 9.89889 6.38645L12.9851 3.76201C13.0364 3.71677 13.1154 3.72137 13.1616 3.77165C13.1825 3.79469 13.1937 3.82444 13.1937 3.85502V12.0719C13.1937 12.1397 13.1377 12.1942 13.0684 12.1942C13.0312 12.1942 12.9962 12.1783 12.9727 12.1502L3.6435 1.20169C3.33966 0.850174 2.89352 0.647392 2.42388 0.646973H2.09782C1.21536 0.646973 0.5 1.34833 0.5 2.2135V13.7863C0.5 14.6515 1.21536 15.3528 2.09782 15.3528C2.65336 15.3528 3.16915 15.0704 3.46017 14.6062L6.59558 10.0424C6.69769 9.89194 6.65624 9.68919 6.50279 9.58903C6.37845 9.50776 6.21394 9.51782 6.10071 9.61334L3.01446 12.2378C2.96318 12.283 2.88412 12.2784 2.83797 12.2281C2.81703 12.2051 2.80592 12.1753 2.80634 12.1447V3.92583C2.80634 3.85796 2.86232 3.80349 2.93155 3.80349C2.96831 3.80349 3.00377 3.81941 3.02728 3.84748L12.3552 14.7981C12.659 15.1496 13.1052 15.3524 13.5749 15.3528H13.9009C14.7833 15.3532 15.4992 14.6523 15.5 13.7871V2.2135C15.5 1.34833 14.7842 0.646973 13.9017 0.646973Z"
      fill="currentColor"
    />
  </svg>
);

/** A loading bar at its value's real size; `i` sets its place in the left-to-right breathe. */
const Bar = ({ w, h = 18, i = 0 }: { w: number | string; h?: number; i?: number }) => <span className="bar" style={{ width: w, height: h, "--i": i } as React.CSSProperties} aria-hidden="true" />;

const FAILURE: Record<PostingFailure, string> = {
  cannot_pause: "The pause can't be sent",
  pause_gas_short: "Not enough pause gas",
  chain_unconfirmed: "The chain couldn't be confirmed",
};

export function BountyLive({ id }: { id: BountyId }) {
  // Chains whose pause this browser sent.
  const [sent, setSent] = useState<number[]>([]);
  const [fastUntil, setFastUntil] = useState(0);
  const queryClient = useQueryClient();
  const q = useBounty(id, fastUntil);
  const b = q.data ?? null;
  // A sent pause is read at once, then every 3 s until it lands, for at most two minutes.
  const onSent = (chain: number) => {
    setSent((s) => [...s, chain]);
    setFastUntil(Date.now() + 120_000);
    queryClient.invalidateQueries({ queryKey: bountyKey(id) });
  };
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
  // D8 on a Live bounty before any pause is signed: the warning stands under the summary, the one thing the Protocol must act on.
  const lowGas = b?.state === "Live" ? b.chains.filter((c) => c.gas?.low && c.pauses.length === 0) : [];
  return (
    <div className="bounty">
      <header className="bounty-head">
        <div className="title-row">
          <h1 className="page-title">
            {id.protocol}/<wbr />
            {id.name}
          </h1>
          {b ? <StatusChip state={b.state} /> : <Bar w={64} h={30} i={1} />}
        </div>
        <p className="source">
          <span className="live-dot" key={q.dataUpdatedAt} aria-hidden="true" />
          Read live from{" "}
          <a href={b?.contractHref ?? undefined} target="_blank" rel="noopener">
            {b?.contract ?? BOUNTY_CONTRACT}
          </a>
        </p>
      </header>
      {q.isError && (
        <div className="block">
          <ReadFailed what="Couldn't read the chains" lastGood={lastGood} onRetry={() => q.refetch()} />
        </div>
      )}
      <Figures b={b} />
      {lowGas.map((c) => (
        <div key={c.chainId} className="block">
          <GasWarning c={c} />
        </div>
      ))}
      {b?.state === "Paid" && b.winner && <WinningClaim b={b} />}
      {b?.state === "Paying" && (
        <section className="block" aria-labelledby="payoutH">
          <h2 id="payoutH">Payout</h2>
          <div className="panel-app">
            <dl className="facts">
              <dt>Payout</dt>
              <dd>
                <TxPending chain="NEAR" explorer={new URL(b.contractHref).origin} />
              </dd>
            </dl>
          </div>
        </section>
      )}
      {b?.state === "Not posted" && <WhyNotPosted b={b} />}
      <Covered b={b} />
      {b && b.chains.some((c) => c.pauses.length > 0) && (
        <section className="block" aria-labelledby="pausesH">
          <h2 id="pausesH">Pauses</h2>
          <div className="pauses">
            {b.chains.map((c) => (
              <PauseRow key={c.chainId} c={c} sent={sent.includes(c.chainId)} onSent={() => onSent(c.chainId)} />
            ))}
          </div>
        </section>
      )}
      {b ? b.state !== "Not posted" && <Rules b={b} /> : <RulesLoading />}
      <VerifyTerminal id={id} state={b?.state} />
    </div>
  );
}

/** The figures: what it pays, for how big a theft, what it covers, until when, and how many claims were judged. */
function Figures({ b }: { b: BountyPage | null }) {
  const s = b?.state;
  const amountLabel = s === "Paid" ? "Paid" : s === "Withdrawn" || s === "Not posted" ? "Bounty" : "Pays";
  const coversLabel = s === "Not posted" ? "Named" : s === "Withdrawn" ? "Covered" : "Covers";
  const showEnds = s !== "Paid" && s !== "Paying" && s !== "Not posted";
  const endsLabel = s === "Ended, unclaimed" || s === "Withdrawn" ? "Ended" : "Ends";
  // Each label explains itself on hover, focus or tap, in the tense of the bounty's state.
  const amountTip =
    s === "Paid"
      ? "The reward that was paid to the person who proved an exploit on these contracts."
      : s === "Withdrawn"
        ? "The reward offered. Nobody won it, so it went back to the Protocol."
        : s === "Not posted"
          ? "The reward offered. The bounty never went live, so it went back to the Protocol."
          : "The reward, paid once, to the first person who proves an exploit on these contracts.";
  const coversTip =
    s === "Not posted"
      ? "The smart contracts the Protocol listed. The bounty never went live for them."
      : s === "Withdrawn"
        ? "The smart contracts this bounty was for."
        : "The smart contracts this bounty is for. If someone proves an exploit, all of them are paused.";
  const endsTip = endsLabel === "Ended" ? "The last day exploits could be submitted (UTC time)." : "The last day to submit an exploit (UTC time).";
  return (
    <section className="block" aria-labelledby="summaryH">
      <h2 id="summaryH">Summary</h2>
      <dl className="figs">
        <div className="fig money">
          <dt>{b ? <Hint tip={amountTip}>{amountLabel}</Hint> : amountLabel}</dt>
          <dd data-testid="bounty-amount">{b ? b.amount : <Bar w={96} h={26} i={0} />}</dd>
        </div>
        <div className="fig money min">
          <dt>
            <Hint tip="An exploit only wins the reward if it could take at least this much from the contracts.">Minimum theft</Hint>
          </dt>
          <dd data-testid="minimum-theft">{b ? b.minimumTheft : <Bar w={96} h={26} i={1} />}</dd>
        </div>
        <div className="fig">
          <dt>{b ? <Hint tip={coversTip}>{coversLabel}</Hint> : coversLabel}</dt>
          <dd>{b ? b.covered.length === 1 ? "1 contract" : `${b.covered.length} contracts` : <Bar w={120} h={18} i={2} />}</dd>
        </div>
        {(!b || showEnds) && (
          <div className="fig ends">
            <dt>{b ? <Hint tip={endsTip}>{endsLabel}</Hint> : endsLabel}</dt>
            <dd>{b ? b.ends : <Bar w={96} h={18} i={3} />}</dd>
          </div>
        )}
        {(!b || s !== "Not posted") && (
          <div className={`fig claims${showEnds ? " first-col" : ""}`}>
            <dt>
              <Hint tip="How many submitted exploits have been checked so far.">Claims judged</Hint>
            </dt>
            <dd data-testid="claims-judged">{b ? b.claimsJudged : <Bar w={24} h={18} i={4} />}</dd>
          </div>
        )}
      </dl>
    </section>
  );
}

/** Paid: who won, where it was proven (D28), the payout, and the exploit's publication. */
function WinningClaim({ b }: { b: BountyPage }) {
  const w = b.winner!;
  const p = b.publication;
  const base = `/bounties/${encodeURIComponent(b.id.protocol)}/${encodeURIComponent(b.id.name)}`;
  return (
    <section className="block" aria-labelledby="winH">
      <h2 id="winH">Winning claim</h2>
      <div className="ticket">
        <dl className="tk-main">
          <div className="tk-field">
            <dt>Paid</dt>
            <dd>
              <span className="tk-paid">
                <span className="tk-amount">{b.amount}</span>
                <span className="tk-on">
                  on <NearMark /> NEAR
                </span>
              </span>
              {w.payout ? <LinkChip href={w.payout.href} label={shortHash(w.payout.hash)} title={w.payout.hash} proven /> : <TxPending chain="NEAR" explorer={new URL(b.contractHref).origin} />}
            </dd>
          </div>
          <div className="tk-field">
            <dt>To</dt>
            <dd>
              <LinkChip href={w.whitehatHref} label={w.whitehat} title={w.whitehat} />
            </dd>
          </div>
          <div className="tk-field">
            <dt>Proven on</dt>
            <dd>
              <span className="tx">
                <span className="chip">{w.chain}</span>
                <LinkChip href={w.blockHref} label={`block ${w.block}`} title={`${w.chain} block ${w.block}`} />
              </span>
            </dd>
          </div>
        </dl>
        <div className="tk-stub">
          <span className="tk-label">Exploit</span>
          {p && <p className="tk-when">{publicationLine(p.state, p.from)}</p>}
          {p?.state === "published" && p.tx && <TxChip {...p.tx} copy={false} />}
          {p?.state === "publishable" && <CommandBlock prompt text={`bountee publish ${b.id.protocol}/${b.id.name} --as <account> --contract ${b.contract} --network ${net.network}`} />}
          <a className="btn btn-line" href={`${base}/exploit`}>
            Open the winning exploit
          </a>
        </div>
      </div>
    </section>
  );
}

const publicationLine = (state: string, from: string) =>
  state === "delayed" ? `Anyone can make it public from ${from}.` : state === "publishable" ? "Anyone can make it public now." : state === "requested" ? "It is being made public." : "It is public.";

/** Not posted: the check's outcome in one line, what came back, and how to try again. Each contract's reason sits on its row. */
function WhyNotPosted({ b }: { b: BountyPage }) {
  const f = b.posting?.failures;
  const failing = f ? new Set(f.map((x) => x.index)).size : 0;
  return (
    <section className="block" aria-labelledby="whyH">
      <h2 id="whyH">Why it wasn't posted</h2>
      <div className="panel-app why">
        {/* Only what the check's event says (R15.6): unread, the line is left out rather than guessed. */}
        {b.posting && <p>{f ? `The check failed on ${failing} of ${b.covered.length} ${b.covered.length === 1 ? "contract" : "contracts"}.` : "The check couldn't run."}</p>}
        <p>
          {b.posting?.returned ? `${b.posting.returned} came back to the Protocol. ` : ""}
          The posting fee paid for the check.
        </p>
        <a className="btn btn-line" href="/post">
          Post again under a new name
        </a>
      </div>
    </section>
  );
}

/** What the bounty covers: one row per contract, its chain and its address, as a table with column headers like the bounty list. */
function Covered({ b }: { b: BountyPage | null }) {
  const named = b?.state === "Not posted" || b?.state === "Withdrawn";
  const failures = b?.posting?.failures ?? null;
  return (
    <section className="block" aria-labelledby="coveredH">
      <h2 id="coveredH">{named ? "Named at posting" : "Covered contracts"}</h2>
      <table className="dtable">
        <thead>
          <tr>
            <th className="col-chain">Chain</th>
            <th>Contract address</th>
            {failures && <th>Posting check</th>}
          </tr>
        </thead>
        <tbody>
          {b ? (
            b.covered.map((x, i) => {
              const fail = failures?.find((f) => f.index === i);
              return (
                <tr key={`${x.chainId}:${x.address}`}>
                  <td>
                    <span className="chain-cell">
                      <ChainMark chainId={x.chainId} name={x.chain} />
                      {x.chain}
                    </span>
                  </td>
                  <td>
                    <LinkChip href={x.href} label={shortHash(x.address)} title={x.address} />
                  </td>
                  {failures && <td>{fail ? FAILURE[fail.reason] : "Passed"}</td>}
                </tr>
              );
            })
          ) : (
            <tr aria-hidden="true">
              <td>
                <Bar w={140} h={16} />
              </td>
              <td>
                <Bar w={130} h={30} i={1} />
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

/** Paying and Paid: each chain's pause, its three facts each shown only once on chain (R7.7), and Send pause where one hasn't landed (R7.9). */
function PauseRow({ c, sent, onSent }: { c: ChainPause; sent: boolean; onSent: () => void }) {
  const unlanded = c.pauses.filter((p) => !p.landed);
  return (
    <section className="panel-app pause-row" aria-label={`Pause on ${c.chain}`}>
      <div className="pause-head">
        <ChainMark chainId={c.chainId} name={c.chain} />
        <h3>{c.chain}</h3>
      </div>
      <ol className="steps ptl">
        <Step n={1} label="Signed" done={c.pauses.length > 0} linked={c.pauses.length > 0 && c.landed}>
          {c.signed && <TxChip {...c.signed} copy={false} />}
        </Step>
        <Step
          n={2}
          label="Landed"
          done={c.landed}
          linked={c.landed && !!c.verified}
          waiting={sent ? "sent · waiting for the receipt" : "not yet"}
          pending={sent ? c.pauses.map((p) => <TxChip key={p.hash} chain={c.chain} hash={p.hash} href={p.href} copy={false} />) : null}
        >
          {c.pauses.map((p) => (
            <TxChip key={p.hash} chain={c.chain} hash={p.hash} href={p.href} copy={false} />
          ))}
        </Step>
        <Step n={3} label="Verified" done={!!c.verified}>
          {c.verified?.hash ? <TxChip {...c.verified} copy={false} /> : null}
        </Step>
      </ol>
      {unlanded.length > 0 && !sent && <SendPause chain={c.chain} rpc={c.rpc} pauses={unlanded} onSent={onSent} />}
      {c.gas?.low && c.pauses.length > 0 && <GasWarning c={c} />}
    </section>
  );
}

/** One fact of a chain's pause, drawn as a node on the pause's line, like Verify's timeline: green only once on chain (R7.7). */
function Step({
  n,
  label,
  done,
  linked = false,
  children,
  waiting = "not yet",
  pending = null,
}: {
  n: number;
  label: string;
  done: boolean;
  linked?: boolean;
  children?: ReactNode;
  waiting?: string;
  /** Shown above the waiting line before the fact is on chain: a sent pause's tx chip. */
  pending?: ReactNode;
}) {
  return (
    <li className={`step${done ? " done" : ""}${linked ? " linked" : ""}`}>
      <span className="node" aria-hidden="true" />
      <span className="lbl">
        <span className={`num${done ? " ok" : ""}`}>{n}.</span> {label}
        <span className="sr-only">{done ? " done" : " not yet"}</span>
      </span>
      {done ? (
        <div className="meta">{children}</div>
      ) : (
        <>
          {pending && <div className="meta">{pending}</div>}
          <p className="wait" aria-hidden="true">
            {waiting}
          </p>
        </>
      )}
    </li>
  );
}

/** D8: a chain's pause gas below what a pause needs. The payout never waits on it (R7.11). */
function GasWarning({ c }: { c: ChainPause }) {
  const g = c.gas!;
  const what = c.pauses.length > 0 ? "The signed pause needs" : "A pause needs";
  return (
    <div className="warnbox" role="note" aria-label={`Low pause gas on ${c.chain}`}>
      <span className="chip warn">Low pause gas</span>
      <p>
        Pause gas on {c.chain}: {g.held} {g.token}. {what} {g.needed} {g.token}. The Protocol can top up the address that sends the pause. The payout doesn't depend on it.
      </p>
      <CommandBlock text={g.address} />
    </div>
  );
}

/**
 * The rules, as a ledger (DESIGN.md, Ledger, without glyphs): a short title over one plain sentence each,
 * in everyday words, never repeating the figures. Folded once nothing they decide is still open.
 */
function Rules({ b }: { b: BountyPage }) {
  const settled = b.state === "Paid" || b.state === "Withdrawn";
  const [open, setOpen] = useState(!settled);
  const chains = [...new Set(b.covered.map((c) => c.chain))];
  const noWinner =
    b.state === "Live" || b.state === "Checking"
      ? `If nobody wins by ${b.ends}, the Protocol can take the reward back.`
      : b.state === "Ended, unclaimed"
        ? "Nobody won, so the Protocol can take the reward back."
        : null;
  const items: { title: string; body: ReactNode; wide?: boolean }[] = [
    {
      title: "What wins",
      body:
        chains.length === 1
          ? `The first exploit proven on ${chains[0]}. It pauses every covered contract.`
          : "The first exploit proven on any covered chain. It pauses every covered contract, on every chain.",
    },
    // A token whose symbol its chain didn't answer isn't shown (R15.6); with none read, the rule is left out.
    ...(b.counts.length > 0
      ? [
          {
            title: "What counts",
            body: (
              <span className="chip-row">
                {b.counts.map((t) => (
                  <LinkChip key={t.href} href={t.href} label={`${t.symbol} · ${t.chain}`} title={`${t.symbol} on ${t.chain}`} />
                ))}
              </span>
            ),
          },
        ]
      : []),
    { title: "What doesn't", body: "Taking from contracts not listed above, a depositor's own withdrawal, an owner rescue, a sweep or an unsold mint." },
    { title: "Freshness", body: `Each exploit is tested against the chain as it was at most ${plural(b.recencyMinutes, "minute")} before it was submitted.` },
    { title: "Payout", body: "Paid even if a pause fails to go through." },
    ...(noWinner ? [{ title: "No winner", body: noWinner }] : []),
    { title: "Disclosure", body: `Anyone can make the winning exploit public ${plural(b.disclosureDelayDays, "day")} after the payout.` },
    {
      title: "Trusted",
      wide: true,
      body: (
        <>
          OutLayer and Intel run the judge, three RPC providers per chain confirm blocks, NEAR&apos;s MPC network signs the pauses, NEAR runs the contract, Circle issues USDC.{" "}
          <a href={`${REPO}#who-you-trust-and-what-each-could-do`} target="_blank" rel="noopener">
            What each could do
          </a>
        </>
      ),
    },
  ];
  // The section's summary sits under its heading, outside the panel, and stays in view when the rules are folded.
  const lead = <p className="section-lead">{RULES_LEAD}</p>;
  const body = (
    <div className="panel-app rules">
      <ul className="rule-list">
        {items.map((r) => (
          <li key={r.title} className={r.wide ? "wide" : undefined}>
            <h3>{r.title}</h3>
            <p>{r.body}</p>
          </li>
        ))}
      </ul>
    </div>
  );
  return (
    <section className="block" aria-labelledby="rulesH" data-open={open || undefined}>
      {settled ? (
        <>
          <h2 id="rulesH" className="fold-h">
            <button type="button" aria-expanded={open} aria-controls="rulesBody" onClick={() => setOpen((o) => !o)}>
              Rules
              <span className="pm" aria-hidden="true">
                <svg viewBox="0 0 10 10">
                  <path d="M5 0v10M0 5h10" stroke="currentColor" strokeWidth="1.4" />
                </svg>
              </span>
            </button>
          </h2>
          {lead}
          <div className="fold" id="rulesBody">
            <div inert={!open || undefined}>{body}</div>
          </div>
        </>
      ) : (
        <>
          <h2 id="rulesH">Rules</h2>
          {lead}
          {body}
        </>
      )}
    </section>
  );
}

/** Rules while the bounty is read: the heading and its line are known; each rule waits as a bar of its size. */
function RulesLoading() {
  return (
    <section className="block" aria-labelledby="rulesH" aria-busy="true">
      <h2 id="rulesH">Rules</h2>
      <p className="section-lead">{RULES_LEAD}</p>
      <div className="panel-app rules" aria-hidden="true">
        <ul className="rule-list">
          {Array.from({ length: 6 }, (_, i) => (
            <li key={i}>
              <Bar w={90} h={16} i={i} />
              <p>
                <Bar w="92%" h={14} i={i} /> <Bar w="70%" h={14} i={i} />
              </p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/** A link chip: a machine-read string (an address, an account, a block) linking to its explorer page. */
function LinkChip({ href, label, title, proven = false }: { href: string; label: string; title: string; proven?: boolean }) {
  return (
    <span className={`chip link solo${proven ? " ok" : ""}`}>
      <a href={href} target="_blank" rel="noopener" title={title}>
        {label}
        <Ext />
      </a>
    </span>
  );
}
