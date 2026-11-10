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

// As the README's "What counts as an exploit" states the one rule.
export function whatDoesntPay(b: BountyPage): string[] {
  return [
    `A theft of less than ${b.minimumTheft}, counted as the smaller of what the fresh accounts gained and what the covered contracts lost.`,
    "Value taken from contracts the bounty doesn't cover, such as a swap or flash loan in a pool it doesn't cover.",
    "A depositor's own withdrawal, an owner rescue, a sweep to the treasury or an unsold mint. Each scores zero.",
    "Tokens the bounty didn't list when it was posted.",
    `A claim against a block more than ${plural(b.recencyMinutes, "minute")} old, or filed after the bounty is won or has ended.`,
  ];
}
