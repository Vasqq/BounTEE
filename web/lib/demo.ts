// The mainnet demo bounty the landing page tells (D4, ADR-0018), read live: its rules, and
// the transaction behind each step of the story, in the order things happen (posted → sealed
// → checked → pauses signed → paid → landed per chain → verified per chain → published).
// A step with no transaction yet has none, and the page shows it as "tx pending".
import { readBounty, type BountyId } from "./bounties.ts";
import { config } from "./config.ts";
import { forBounty, history } from "./history.ts";
import { view } from "./near.ts";

export interface StoryTx {
  c: string;
  href: string;
  hash: string;
}

/** What the landing page's script states about the bounty (components/landing/runtime.js `live`). */
export interface Story {
  protocol: string;
  name: string;
  amount: string;
  min: string;
  delay: number;
  pauses: number;
  chains: string[];
  proofChain: string;
  /** Each of the eight steps' transactions; empty while a step hasn't happened. */
  steps: StoryTx[][];
  verdict: string | null;
  cheat: boolean;
  paidOnce: boolean;
  verified: [number, number];
  published: boolean;
}

export interface Demo {
  contract: string;
  contractHref: string;
  chains: string[];
  amount: string;
  paidOnce: boolean;
  story: Story;
}

export function demoId(): BountyId | null {
  const text = config().demoBounty;
  const slash = text?.indexOf("/") ?? -1;
  return text && slash > 0 ? { protocol: text.slice(0, slash), name: text.slice(slash + 1) } : null;
}

export async function readDemo(): Promise<Demo | null> {
  const c = config();
  const id = demoId();
  if (!id) return null;
  const page = await readBounty(id);
  if (!page) return null;
  const find = history(c);
  const mine = forBounty(id);
  const near = (hash: string | undefined, label = "NEAR"): StoryTx[] => (hash ? [{ c: label, hash, href: `${c.nearExplorerTx}${hash}` }] : []);

  const b = await view<{ winning_claim: number | null; state: string }>(c, c.contract, "bounty", { id });
  const winner = b.winning_claim;
  const isWinner = (d: Record<string, unknown>) => winner !== null && Number(d.claim_id) === winner;
  const [posted, sealed, judged, signed, paid, published, zero] = await Promise.all([
    find("bounty_posted", mine),
    winner === null ? null : find("claim_submitted", (d) => mine(d) && isWinner(d)),
    winner === null ? null : find("claim_judged", isWinner),
    find("pauses_signed", mine),
    find("bounty_paid", mine),
    find("exploit_published", mine),
    // A cheat claim: another claim on this bounty, judged ZERO before the win.
    find("claim_judged", (d) => !isWinner(d) && (d.verdict as { outcome?: string } | undefined)?.outcome === "ZERO"),
  ]);
  // The ZERO verdict counts as this bounty's only if its claim was filed on it.
  const cheat = zero ? !!(await find("claim_submitted", (d) => mine(d) && Number(d.claim_id) === Number(zero.data.claim_id))) : false;
  const landed: StoryTx[] = page.chains.flatMap((ch) => (ch.landed ? ch.pauses.map((p) => ({ c: ch.chain, hash: p.hash, href: p.href })) : []));
  const verified: StoryTx[] = page.chains.flatMap((ch) => (ch.verified?.hash ? [{ c: "NEAR", hash: ch.verified.hash, href: ch.verified.href }] : []));
  const chains = page.chains.map((ch) => ch.chain);
  const verdict = judged ? ((judged.data.verdict as { outcome?: string } | undefined)?.outcome ?? null) : null;
  return {
    contract: c.contract,
    contractHref: `${c.nearExplorer}address/${c.contract}`,
    chains,
    amount: page.amount,
    paidOnce: !!paid,
    story: {
      protocol: id.protocol,
      name: id.name,
      amount: page.amount,
      min: page.minimumTheft,
      delay: page.disclosureDelayDays,
      pauses: page.chains.reduce((n, ch) => n + ch.contracts.length, 0),
      chains,
      proofChain: page.proofChain,
      steps: [
        near(posted?.tx),
        near(sealed?.tx),
        near(judged?.tx),
        near(signed?.tx, "NEAR MPC"),
        near(paid?.tx),
        landed,
        verified,
        near(published?.tx),
      ],
      verdict,
      cheat,
      paidOnce: !!paid,
      verified: [page.chains.filter((ch) => ch.verified).length, page.chains.length],
      published: !!published,
    },
  };
}
