// A bounty's winning-exploit release as its open-exploit page needs it, read live (R6.2).
import { publicState, type BountyId, type PublicState } from "./bounties.ts";
import { config } from "./config.ts";
import { view } from "./near.ts";

export interface ReleaseView {
  contract: string;
  state: PublicState;
  paid: boolean;
  exploitPublicKey: string;
  /** The release, once the contract keeps it: the exploit encrypted to the exploit key. */
  release: { claimId: number; state: "requested" | "released"; released: string | null } | null;
}

export async function readRelease(id: BountyId): Promise<ReleaseView | null> {
  const c = config();
  const b = await view<{ state: any; rules: { exploit_public_key: string; end_date_ns: string } } | null>(c, c.contract, "bounty", { id });
  if (!b) return null;
  const paid = b.state === "paid";
  const r = paid ? await view<{ claim_id: number; state: "requested" | "released"; released: string | null } | null>(c, c.contract, "released_exploit", { id }) : null;
  return {
    contract: c.contract,
    state: publicState(b.state, b.rules.end_date_ns),
    paid,
    exploitPublicKey: b.rules.exploit_public_key,
    release: r ? { claimId: r.claim_id, state: r.state, released: r.released } : null,
  };
}
