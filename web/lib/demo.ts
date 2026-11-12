// The mainnet demo bounty the landing page tells (D4, ADR-0018), read live: its rules, and
// the transaction behind each step of the story, in the order things happen (posted → sealed
// → checked → pauses signed → paid → landed per chain → verified per chain → published).
// A step with no transaction yet has none, and the page shows it as "tx pending".
import { claimsOf, readBounty, type BountyId } from "./bounties.ts";
import { config } from "./config.ts";
import { plural, utcMinute } from "./format.ts";
import { forBounty, history } from "./history.ts";
import { signedWithFunctionCallKey, view } from "./near.ts";
import { coveredChain, verifyCommand } from "./network.ts";

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
  /** The cheat claim was filed by the winning claim's own account, with a full-access key (not a claim key). */
  cheatByWhitehat: boolean;
  /** The covered chain and block the winning claim was proven on (D28), from its claim record. */
  provenOn: { chain: string; block: number } | null;
  /** The winner was sealed, judged, signed and paid in one NEAR transaction: steps 2–5 link the same hash. */
  oneTx: boolean;
  /**
   * What the published step says until it happens: when the contract lets anyone publish
   * (`publishable_from_ns`), or else the disclosure delay. Null once published.
   */
  publishPending: string | null;
  /** The command-line check for this bounty (`verifyCommand`), as the Verify section shows it. */
  command: string;
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
  const [cheatSealed, cheatJudged, record, publication] = await Promise.all([
    cheatClaim ? find("claim_submitted", (d) => mine(d) && Number(d.claim_id) === cheatClaim.id) : null,
    cheatClaim ? find("claim_judged", (d) => Number(d.claim_id) === cheatClaim.id) : null,
    winner === null ? null : view<{ block?: { chain_id?: number; number?: number } } | null>(c, c.contract, "claim", { claim_id: winner }),
    winner === null ? null : view<{ state: string; publishable_from_ns: string } | null>(c, c.contract, "published_exploit", { id }),
  ]);
  const claimKey = sealed ? (await signedWithFunctionCallKey(c, sealed.tx, sealed.signer, c.contract)) === true : false;
  const cheatByWhitehat =
    !!sealed && !!cheatSealed && cheatSealed.signer === sealed.signer && (await signedWithFunctionCallKey(c, cheatSealed.tx, cheatSealed.signer, c.contract)) === false;
  const provenChain = record?.block?.chain_id === undefined ? undefined : coveredChain(record.block.chain_id);
  const provenOn = provenChain && typeof record?.block?.number === "number" ? { chain: provenChain.name, block: record.block.number } : null;
  const winnerTxs = [sealed?.tx, judged?.tx, signed?.tx, paid?.tx];
  // The cheat claim's ZERO verdict is linked beside the win's, in the checked step.
  const cheatTx: StoryTx[] = cheatJudged ? near(cheatJudged.tx, "Cheat claim: ZERO") : [];
  const landed: StoryTx[] = page.chains.flatMap((ch) => (ch.landed ? ch.pauses.map((p) => ({ chain: ch.chain, hash: p.hash, href: p.href })) : []));
  const verified: StoryTx[] = page.chains.flatMap((ch) => (ch.verified ? [ch.verified.hash ? { chain: `NEAR · ${ch.chain}`, hash: ch.verified.hash, href: ch.verified.href } : { chain: "NEAR", hash: "", href: c.contractHref, label: `${ch.chain} recorded` }] : []));
  const chains = page.chains.map((ch) => ch.chain);
  const verdict = judged ? ((judged.data.verdict as { outcome?: string } | undefined)?.outcome ?? null) : null;
  return {
    contract: c.contract,
    contractHref: c.contractHref,
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
        [...near(judged?.tx), ...cheatTx],
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
      cheatByWhitehat,
      provenOn,
      oneTx: winnerTxs.every((h) => h && h === winnerTxs[0]),
      publishPending: published
        ? null
        : publication && publication.state !== "published"
          ? `pending · from ${utcMinute(publication.publishable_from_ns)}`
          : `pending · after ${plural(page.disclosureDelayDays, "day")}`,
      command: verifyCommand(id, c.contract),
      paidOnce: !!paid,
      landed: [page.chains.filter((ch) => ch.landed).length, page.chains.length],
      verified: [page.chains.filter((ch) => ch.verified).length, page.chains.length],
      published: !!published,
    },
  };
}
