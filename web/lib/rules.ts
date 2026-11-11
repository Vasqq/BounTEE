// A bounty's rules and what doesn't pay, in plain English, from the rules read off the chain.
import type { BountyPage } from "./bounties.ts";
import { listOf as list, plural } from "./format.ts";

export function rulesInPlainEnglish(b: BountyPage): string[] {
  const chains = list([...new Set(b.covered.map((c) => c.chain))]);
  return [
    `Pays ${b.amount} to the first Whitehat whose claim takes at least ${b.minimumTheft} from the covered contracts, valued at the prices fixed at posting.`,
    `Covers ${plural(b.covered.length, "contract")} on ${chains}. A winning claim pauses every one of them.`,
    `A theft proven on any covered chain wins: the Enclave replays each claim against that chain's state at a block at most ${plural(b.recencyMinutes, "minute")} old, under the judge build fixed at posting.`,
    `Takes claims until ${b.ends}. The winning exploit is published ${plural(b.disclosureDelayDays, "day")} after the payout.`,
  ];
}
