// The mainnet demo bounty the landing page tells (D4, ADR-0018), read live: its rules, and
// the transaction behind each step of the story, in the order things happen (posted → sealed
// → checked → pauses signed → paid → landed per chain → verified per chain → published).
// A step with no transaction yet has none, and the page shows it as "tx pending".
import { claimsOf, readBounty, type BountyId } from "./bounties.ts";
import { config } from "./config.ts";
import { forBounty, history } from "./history.ts";
import { signedWithFunctionCallKey, view } from "./near.ts";

export interface StoryTx {
  chain: string;
  href: string;
  /** Empty when the fact is on chain but its transaction wasn't found: then `label` says so. */
  hash: string;
  label?: string;
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
  /** Each of the eight steps' transactions; empty while a step hasn't happened. */
  steps: StoryTx[][];
  /** The posting check passed: the pause role and pause gas were confirmed on every chain (R7.6). */
  checked: boolean;
  /** The winning claim was filed with a claim key (a function-call key limited to the bounty contract), as NEAR records it. */
  claimKey: boolean;
  verdict: string | null;
  /** A claim on this bounty filed before the winner was judged ZERO. */
  cheat: boolean;
  paidOnce: boolean;
  /** Chains whose pauses have all landed, of the chains covered. */
  landed: [number, number];
  /** Chains the contract records verified, of the chains covered (R7.7). */
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
  const near = (hash: string | undefined, label = "NEAR"): StoryTx[] => (hash ? [{ chain: label, hash, href: `${c.nearExplorerTx}${hash}` }] : []);

  const [b, claims] = await Promise.all([view<{ winning_claim: number | null }>(c, c.contract, "bounty", { id }), claimsOf(c, id)]);
  const winner = b.winning_claim;
  const isWinner = (d: Record<string, unknown>) => winner !== null && Number(d.claim_id) === winner;
  // A cheat claim: one of this bounty's claims filed before the winner (claim IDs count up), judged ZERO (ADR-0018).
  const cheatClaim = winner === null ? undefined : claims.find((x) => x.id < winner && x.state === "judged" && x.verdict?.outcome === "ZERO");
  const [posted, live, sealed, judged, signed, paid, published] = await Promise.all([
    find("bounty_posted", mine),
    find("bounty_live", mine),
    winner === null ? null : find("claim_submitted", (d) => mine(d) && isWinner(d)),
    winner === null ? null : find("claim_judged", isWinner),
    find("pauses_signed", mine),
    find("bounty_paid", mine),
    find("exploit_published", mine),
  ]);
  const claimKey = sealed ? (await signedWithFunctionCallKey(c, sealed.tx, sealed.signer, c.contract)) === true : false;
  const landed: StoryTx[] = page.chains.flatMap((ch) => (ch.landed ? ch.pauses.map((p) => ({ chain: ch.chain, hash: p.hash, href: p.href })) : []));
  const verified: StoryTx[] = page.chains.flatMap((ch) => (ch.verified ? [ch.verified.hash ? { chain: "NEAR", hash: ch.verified.hash, href: ch.verified.href } : { chain: "NEAR", hash: "", href: `${c.nearExplorer}address/${c.contract}`, label: `${ch.chain} recorded` }] : []));
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
      checked: !!live,
      claimKey,
      verdict,
      cheat: !!cheatClaim,
      paidOnce: !!paid,
      landed: [page.chains.filter((ch) => ch.landed).length, page.chains.length],
      verified: [page.chains.filter((ch) => ch.verified).length, page.chains.length],
      published: !!published,
    },
  };
}
