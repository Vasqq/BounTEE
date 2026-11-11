"use client";
// Chips (DESIGN.md, Chips): a bounty's status, and a transaction as a chain chip plus a
// link chip that shows its shortened hash, an external-link glyph and a copy button.
import { useState } from "react";
import { DitherHalo } from "./DitherHalo.tsx";
import type { PublicState } from "@/lib/bounties.ts";
import { shortHash } from "@/lib/format.ts";

const TONE: Record<PublicState, string> = { Live: "", Checking: "", Paying: "", Paid: "ok", "Ended, unclaimed": "mute", Withdrawn: "mute", "Not posted": "mute" };

export function StatusChip({ state }: { state: PublicState }) {
  if (state === "Live") return <LiveChip />;
  return <span className={`chip ${TONE[state]}`.trim()}>{state}</span>;
}

/**
 * "Live": the chip, its word led by a small dot of faint green dither that breathes (DitherHalo), Liam's one
 * exception to green-means-proven, as the testnet badge's wash is (DESIGN.md, Status chip).
 */
function LiveChip() {
  return (
    <span className="chip live">
      <DitherHalo tone="faint" size={14} cell={1} inner={0} rest={4} reach={7} className="live-dither" />
      Live
    </span>
  );
}

export const Ext = () => (
  <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M4 2h6v6M10 2 3 9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const CopyGlyph = () => (
  <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
    <path d="M8.5 1.5h-6a1 1 0 0 0-1 1v6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
  </svg>
);
const CheckGlyph = () => (
  <svg viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="m2.5 6.5 2.3 2.3L9.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** A transaction that exists: chain, shortened hash linking to its explorer page, copy. `proven`: a payout, in green (Principle 1). */
export function TxChip({ chain, hash, href, proven = false, copy: canCopy = true }: { chain: string; hash: string; href: string; proven?: boolean; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hash);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // the hash is still in the link's title
    }
  };
  return (
    <span className="tx">
      <span className="chip">{chain}</span>
      <span className={`chip link${proven ? " ok" : ""}`}>
        <a href={href} target="_blank" rel="noopener" title={hash}>
          {shortHash(hash)}
          <Ext />
        </a>
        {canCopy && (
          <button type="button" className="cp" aria-label="Copy transaction hash" onClick={copy}>
            {copied ? <CheckGlyph /> : <CopyGlyph />}
          </button>
        )}
      </span>
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </span>
  );
}

/** A transaction that doesn't exist yet: "tx pending", pointing at the explorer root. */
export function TxPending({ chain, explorer }: { chain: string; explorer: string }) {
  return (
    <span className="tx">
      <span className="chip">{chain}</span>
      <a className="chip pending" href={explorer} target="_blank" rel="noopener">
        tx pending
        <Ext />
      </a>
    </span>
  );
}
