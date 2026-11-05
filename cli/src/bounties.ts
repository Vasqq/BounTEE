// `bountee list` and `bountee show` (ticket #26): what a Whitehat reads before hunting, the
// bounties a contract holds, and one bounty's rules, covered contracts and trusted parties.
// Read-only: no keys, no funds.
import { parseBountyId as bountyIdOf, type BountyId, type Rules } from "@bountee/formats";
import { CHAINS } from "./chains.ts";
import type { Near } from "./near.ts";

export interface BountySummary {
  id: BountyId;
  state: string;
  bounty_amount: string;
  minimum_theft: string;
  end_date_ns: string;
  chains: number[];
  covered_contracts: number;
}

/**
 * Every bounty id the contract holds. The contract keeps bounties in a map with no index, and
 * once deployed it is keyless, so its storage layout never changes: its keys are the
 * `Bounties` prefix (0, the first storage key in `contract/src/lib.rs`) then the Borsh
 * `BountyId` (two length-prefixed strings). NEAR RPC's `view_state` lists them by prefix.
 */
async function bountyIds(near: Near, contract: string): Promise<BountyId[]> {
  const state = await near.rpc<{ values: { key: string }[] }>("query", {
    request_type: "view_state",
    finality: "final",
    account_id: contract,
    prefix_base64: Buffer.from([0]).toString("base64"),
  });
  return state.values.map(({ key }) => {
    const k = Buffer.from(key, "base64");
    let at = 1;
    const str = () => {
      const n = k.readUInt32LE(at);
      const s = k.subarray(at + 4, at + 4 + n).toString("utf8");
      at += 4 + n;
      return s;
    };
    const id = { protocol: str(), name: str() };
    if (at !== k.length) throw new Error(`${contract}: a bounty key isn't a bounty id; is it a BounTEE bounty contract?`);
    return id;
  });
}

export async function listBounties(near: Near, contract: string): Promise<{ contract: string; bounties: BountySummary[] }> {
  const ids = await bountyIds(near, contract);
  const bounties = await Promise.all(
    ids.map(async (id) => {
      const b = await near.view<{ state: string; rules: Rules }>(contract, "bounty", { id });
      return {
        id,
        state: b.state,
        bounty_amount: b.rules.bounty_amount,
        minimum_theft: b.rules.minimum_theft,
        end_date_ns: b.rules.end_date_ns,
        chains: [...new Set(b.rules.covered_contracts.map((c) => c.chain_id))],
        covered_contracts: b.rules.covered_contracts.length,
      };
    }),
  );
  bounties.sort((a, b) => `${a.id.protocol}/${a.id.name}`.localeCompare(`${b.id.protocol}/${b.id.name}`));
  return { contract, bounties };
}

export interface TrustedParty {
  party: string;
  role: string;
  account?: string;
  rpcs?: Record<number, string[]>;
}

export interface BountyDetail {
  contract: string;
  id: BountyId;
  state: string;
  rules: Rules;
  covered_contracts: { chain_id: number; chain: string; address: string }[];
  /** The address every pause of this bounty is signed from, on every chain (D25). */
  pause_role: string;
  judge_build_hash: string;
  winning_claim: number | null;
  signed_pauses: { chain_id: number; contract: string; tx_hash: string }[];
  trusted_parties: TrustedParty[];
}

/**
 * A bounty id as typed, `<protocol account>/<bounty name>`: the one parser every command uses.
 * Its parts follow the formats' `BountyId` rules, which the bounty contract applies to a
 * posting (the protocol a NEAR account ID, the name 1-64 chars of `a-z0-9-`, never `/`), so an
 * id the contract could never hold is refused here, before any RPC.
 */
export function parseBountyId(text: string): BountyId {
  const slash = text.indexOf("/");
  try {
    if (slash < 0) throw new Error("no slash");
    return bountyIdOf({ protocol: text.slice(0, slash), name: text.slice(slash + 1) });
  } catch {
    throw new Error(`${text} is not a bounty id <protocol account>/<bounty name>`);
  }
}

export async function showBounty(near: Near, contract: string, id: BountyId): Promise<BountyDetail> {
  const b = await near.view<any>(contract, "bounty", { id });
  if (!b) throw new Error(`no bounty ${id.protocol}/${id.name} on ${contract}`);
  const [config, role] = await Promise.all([
    near.view<any>(contract, "config"),
    near.view<{ address: string }>(contract, "pause_role", { id }),
  ]);
  const rules: Rules = b.rules;
  const proofChain = rules.proof_chain;
  return {
    contract,
    id,
    state: b.state,
    rules,
    covered_contracts: rules.covered_contracts.map((c) => ({ chain_id: c.chain_id, chain: CHAINS[c.chain_id]?.name ?? `chain ${c.chain_id}`, address: c.address })),
    pause_role: role.address,
    judge_build_hash: rules.judge_build_hash,
    winning_claim: b.winning_claim ?? null,
    signed_pauses: (b.signed_pauses ?? []).map((p: any) => ({ chain_id: p.chain_id, contract: p.contract, tx_hash: p.tx_hash })),
    // Who a Whitehat relies on for this bounty (ADR-0010), as this contract pins them.
    trusted_parties: [
      {
        party: "OutLayer",
        account: config.outlayer,
        role: "runs the pinned judge build in an Intel TDX enclave and returns its verdict; its operator and keystore DAO are trusted not to forge a verdict or open a sealed exploit",
      },
      { party: "Intel", role: "the TDX hardware and the attestation that the pinned judge build ran" },
      { party: "NEAR MPC network", account: config.mpc, role: "signs each pause, and confirms each pause landed" },
      {
        party: "Proof-chain RPCs",
        rpcs: { [proofChain]: CHAINS[proofChain]?.judgeRpcs ?? [] },
        role: `the judge build ${rules.judge_build_hash} confirms the claim's block with these; at least two must answer and agree`,
      },
      { party: "USDC", account: config.usdc, role: "the token the bounty is held and paid in" },
    ],
  };
}

const days = (ns: string) => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString().slice(0, 10);

export function formatList(r: { contract: string; bounties: BountySummary[] }): string {
  if (r.bounties.length === 0) return `no bounties on ${r.contract}`;
  return r.bounties
    .map((b) => `${b.id.protocol}/${b.id.name}  ${b.state}  pays ${b.bounty_amount} for a theft of at least ${b.minimum_theft}  ${b.covered_contracts} contract(s) on chain(s) ${b.chains.join(", ")}  ends ${days(b.end_date_ns)}`)
    .join("\n");
}

export function formatBounty(d: BountyDetail): string {
  const r = d.rules;
  const lines = [
    `${d.id.protocol}/${d.id.name} on ${d.contract}: ${d.state}`,
    `  pays ${r.bounty_amount} (USDC, smallest unit) to the first claim whose fresh accounts take at least ${r.minimum_theft} from the covered contracts`,
    `  valued in: ${r.listed_tokens.map((t) => `${t.token} at ${t.price}`).join(", ")}`,
    `  replayed on chain ${r.proof_chain} at a block at most ${r.recency_limit_secs} s old; ends ${days(r.end_date_ns)}; exploit published ${r.disclosure_delay_days} day(s) after a win`,
    "  covered contracts:",
    ...d.covered_contracts.map((c) => `    ${c.chain} (${c.chain_id}) ${c.address}`),
    `  pause-role address: ${d.pause_role}`,
    `  judge build: ${d.judge_build_hash}`,
    "  trusted parties:",
    ...d.trusted_parties.map((p) => `    ${p.party}${p.account ? ` (${p.account})` : ""}${p.rpcs ? ` ${Object.values(p.rpcs).flat().join(", ")}` : ""}: ${p.role}`),
  ];
  if (d.winning_claim !== null) lines.push(`  won by claim ${d.winning_claim}`);
  return lines.join("\n");
}
