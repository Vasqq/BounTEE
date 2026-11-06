// What the pages show about bounties, read live from the chains (R15.6): the bounty
// contract's views and storage on NEAR, each covered chain's receipts and balances, and the
// contract's history for the transactions behind each step.
import { config, type ChainInfo, type Config } from "./config.ts";
import { balance, receipt } from "./evm.ts";
import { forBounty, history } from "./history.ts";
import { borshString, view, viewState } from "./near.ts";
import { isoDate, units } from "./format.ts";

export interface BountyId {
  protocol: string;
  name: string;
}

type ContractState = "checking" | "live" | "check_failed" | "signing" | "paying" | "paid" | "withdrawn";

interface Rules {
  covered_contracts: { chain_id: number; address: string }[];
  proof_chain: number;
  recency_limit_secs: number;
  listed_tokens: { token: string; price: string }[];
  bounty_amount: string;
  minimum_theft: string;
  end_date_ns: string;
  disclosure_delay_days: number;
  exploit_public_key: string;
  judge_build_hash: string;
}

interface BountyView {
  id: BountyId;
  rules: Rules;
  state: ContractState;
  winning_claim: number | null;
  signed_pauses: { chain_id: number; contract: string; nonce: number; tx: string; tx_hash: string }[];
}

/**
 * The state a bounty shows the public. A claim in progress has none (R7.7): a bounty taking
 * claims reads "Live" whatever is being judged.
 */
export type PublicState = "Live" | "Checking" | "Check failed" | "Paying" | "Paid" | "Ended, unclaimed" | "Withdrawn";

export function publicState(state: ContractState, endNs: string, nowMs = Date.now()): PublicState {
  switch (state) {
    case "live":
      return BigInt(endNs) / 1_000_000n <= BigInt(nowMs) ? "Ended, unclaimed" : "Live";
    case "checking":
      return "Checking";
    case "check_failed":
      return "Check failed";
    case "signing":
    case "paying":
      return "Paying";
    case "paid":
      return "Paid";
    case "withdrawn":
      return "Withdrawn";
  }
}

/** A link to a transaction, as the page shows it: the chain, the hash, its explorer page. */
export interface TxLink {
  chain: string;
  hash: string;
  href: string;
}

export interface BountyRow {
  id: BountyId;
  chains: { id: number; name: string }[];
  amount: string;
  minimumTheft: string;
  ends: string;
  state: PublicState;
}

async function usdcDecimals(c: Config): Promise<number> {
  const cfg = await view<{ usdc: string }>(c, c.contract, "config");
  const meta = await view<{ decimals: number }>(c, cfg.usdc, "ft_metadata");
  return meta.decimals;
}

/**
 * Every bounty the contract holds. Its bounty map has no index; being keyless, its storage
 * layout never changes, so its keys are the `Bounties` prefix (0) then the Borsh `BountyId`
 * (as the command-line tool's `list` reads them, cli/src/bounties.ts).
 */
async function bountyIds(c: Config): Promise<BountyId[]> {
  return (await viewState(c, 0)).map(({ key }) => {
    const [protocol, at] = borshString(key, 1);
    const [name] = borshString(key, at);
    return { protocol, name };
  });
}

const usdc = (raw: string, decimals: number) => `${units(raw, decimals)} USDC`;

function chainsOf(r: Rules, c: Config) {
  return [...new Set(r.covered_contracts.map((x) => x.chain_id))].map((id) => ({ id, name: c.chains[id]?.name ?? `chain ${id}` }));
}

export async function listBounties(): Promise<BountyRow[]> {
  const c = config();
  const [ids, decimals] = await Promise.all([bountyIds(c), usdcDecimals(c)]);
  const rows = await Promise.all(
    ids.map(async (id) => {
      const b = await view<BountyView>(c, c.contract, "bounty", { id });
      return {
        id,
        chains: chainsOf(b.rules, c),
        amount: usdc(b.rules.bounty_amount, decimals),
        minimumTheft: usdc(b.rules.minimum_theft, decimals),
        ends: isoDate(b.rules.end_date_ns),
        state: publicState(b.state, b.rules.end_date_ns),
      };
    }),
  );
  return rows.sort((a, b) => `${a.id.protocol}/${a.id.name}`.localeCompare(`${b.id.protocol}/${b.id.name}`));
}

/** Per covered chain: its pause's three facts, each shown only once it is on chain (R7.7). */
export interface ChainPause {
  chainId: number;
  chain: string;
  contracts: string[];
  /** Where anyone's browser sends a signed pause (R7.9). */
  rpc: string;
  explorer: string;
  signed: TxLink | null;
  /** Each signed pause on this chain, its transaction, and whether it has landed. */
  pauses: { hash: string; raw: string; landed: boolean; href: string }[];
  /** Every pause on this chain landed, and succeeded against its covered contract. */
  landed: boolean;
  /** The bounty contract records every pause on this chain verified (R7.10). */
  verified: TxLink | null;
  gas: { address: string; held: string; needed: string; token: string; low: boolean } | null;
}

export interface BountyPage {
  contract: string;
  id: BountyId;
  state: PublicState;
  amount: string;
  minimumTheft: string;
  ends: string;
  claimsJudged: number;
  proofChain: string;
  recencyMinutes: number;
  disclosureDelayDays: number;
  judgeBuild: string;
  covered: { chain: string; address: string }[];
  chains: ChainPause[];
}

/** A claim as the contract keeps it, the parts the pages read. */
export interface ClaimRecord {
  id: number;
  whitehat: string;
  state: "storing" | "store_failed" | "judging" | "no_verdict" | "judged";
  verdict: { outcome: string; reason: string } | null;
}

/**
 * This bounty's claims. The claims map has no index; its keys are the `Claims` prefix (1) then
 * the claim ID (u64 little-endian), and each record's Borsh starts with its bounty ID.
 */
export async function claimsOf(c: Config, id: BountyId): Promise<ClaimRecord[]> {
  const entries = await viewState(c, 1);
  const mine = entries.filter(({ key, value }) => {
    if (key.length !== 9) return false;
    const [protocol, at] = borshString(value, 0);
    const [name] = borshString(value, at);
    return protocol === id.protocol && name === id.name;
  });
  return Promise.all(
    mine.map(async ({ key }) => {
      const claimId = Number(key.readBigUInt64LE(1));
      const r = await view<Omit<ClaimRecord, "id">>(c, c.contract, "claim", { claim_id: claimId });
      return { id: claimId, whitehat: r.whitehat, state: r.state, verdict: r.verdict };
    }),
  );
}

/** How many of this bounty's claims have a verdict (D22). Claims still being judged aren't counted, or shown (R7.7). */
async function claimsJudged(c: Config, id: BountyId): Promise<number> {
  return (await claimsOf(c, id)).filter((x) => x.state === "judged").length;
}

const nearTx = (c: Config, hash: string): TxLink => ({ chain: "NEAR", hash, href: `${c.nearExplorerTx}${hash}` });

async function chainPauses(c: Config, b: BountyView, find: ReturnType<typeof history>, gasPerPause: bigint): Promise<ChainPause[]> {
  const id = b.id;
  const [role, verifications] = await Promise.all([
    view<{ address: string }>(c, c.contract, "pause_role", { id }),
    view<{ chain_id: number; verified: boolean; verified_pauses: string[] }[]>(c, c.contract, "pause_verifications", { id }),
  ]);
  const signedEvent = b.signed_pauses.length ? await find("pauses_signed", forBounty(id)) : null;
  return Promise.all(
    [...new Set(b.rules.covered_contracts.map((x) => x.chain_id))].map(async (chainId) => {
      const chain: ChainInfo | undefined = c.chains[chainId];
      const contracts = b.rules.covered_contracts.filter((x) => x.chain_id === chainId).map((x) => x.address);
      const signed = b.signed_pauses.filter((p) => p.chain_id === chainId).sort((x, y) => x.nonce - y.nonce);
      const pauses = await Promise.all(
        signed.map(async (p) => {
          const r = chain ? await receipt(chain.rpc, p.tx_hash) : null;
          // Landed means it succeeded against the covered contract (as verify's check reads it).
          const landed = !!r && r.ok && (r.to ?? "").toLowerCase() === p.contract.toLowerCase();
          return { hash: p.tx_hash, raw: p.tx, landed, href: `${chain?.explorerTx ?? ""}${p.tx_hash}` };
        }),
      );
      const record = verifications.find((v) => v.chain_id === chainId);
      const allVerified = signed.length > 0 && !!record && signed.every((p) => record.verified_pauses.some((h) => h.toLowerCase() === p.tx_hash.toLowerCase()));
      const verifiedEvent = allVerified ? await find("pause_verified", (d) => forBounty(id)(d) && Number(d.chain_id) === chainId) : null;
      const landed = pauses.length > 0 && pauses.every((p) => p.landed);
      // Pause gas matters until the pause lands; a bounty no longer covering anything needs none.
      const covering = b.state !== "withdrawn" && b.state !== "check_failed";
      let gas: ChainPause["gas"] = null;
      if (chain && covering && !landed) {
        const held = await balance(chain.rpc, role.address);
        const needed = gasPerPause * BigInt(contracts.length);
        gas = { address: role.address, held: units(held, 18), needed: units(needed, 18), token: chain.gasToken, low: held < needed };
      }
      return {
        chainId,
        chain: chain?.name ?? `chain ${chainId}`,
        contracts,
        rpc: chain?.rpc ?? "",
        explorer: chain?.explorer ?? "",
        signed: signedEvent ? nearTx(c, signedEvent.tx) : null,
        pauses,
        landed,
        verified: allVerified ? (verifiedEvent ? nearTx(c, verifiedEvent.tx) : { chain: "NEAR", hash: "", href: c.nearExplorer }) : null,
        gas,
      };
    }),
  );
}

export async function readBounty(id: BountyId): Promise<BountyPage | null> {
  const c = config();
  const b = await view<BountyView | null>(c, c.contract, "bounty", { id });
  if (!b) return null;
  const find = history(c);
  const [decimals, judged, fees] = await Promise.all([usdcDecimals(c), claimsJudged(c, id), view<{ pause_gas_per_pause: string }>(c, c.contract, "fees")]);
  const r = b.rules;
  return {
    contract: c.contract,
    id,
    state: publicState(b.state, r.end_date_ns),
    amount: usdc(r.bounty_amount, decimals),
    minimumTheft: usdc(r.minimum_theft, decimals),
    ends: isoDate(r.end_date_ns),
    claimsJudged: judged,
    proofChain: c.chains[r.proof_chain]?.name ?? `chain ${r.proof_chain}`,
    recencyMinutes: r.recency_limit_secs / 60,
    disclosureDelayDays: r.disclosure_delay_days,
    judgeBuild: r.judge_build_hash,
    covered: r.covered_contracts.map((x) => ({ chain: c.chains[x.chain_id]?.name ?? `chain ${x.chain_id}`, address: x.address })),
    chains: await chainPauses(c, b, find, BigInt(fees.pause_gas_per_pause)),
  };
}
