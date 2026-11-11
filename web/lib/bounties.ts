// What the pages show about bounties, read live from the chains (R15.6): the bounty
// contract's views and storage on NEAR, each covered chain's receipts and balances, and the
// contract's history for the transactions behind each step.
import { config, type ChainInfo, type Config } from "./config.ts";
import { rpc as evmRpc } from "@bountee/cli/src/proofs.ts";
import { balance, receipt } from "./evm.ts";
import { forBounty, history, type ContractEvent, type Find } from "./history.ts";
import { borshString, txReceipts, view, viewState } from "./near.ts";
import { isoDate, units } from "./format.ts";

export interface BountyId {
  protocol: string;
  name: string;
}

type ContractState = "checking" | "live" | "check_failed" | "signing" | "paying" | "paid" | "withdrawn";

interface Rules {
  covered_contracts: { chain_id: number; address: string }[];
  recency_limit_secs: number;
  listed_tokens: { chain_id: number; token: string; price: string }[];
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
 * claims reads "Live" whatever is being judged. A bounty whose posting check failed never took
 * a claim, so it reads "Not posted" (DESIGN.md, Bounty list).
 */
export type PublicState = "Live" | "Checking" | "Not posted" | "Paying" | "Paid" | "Ended, unclaimed" | "Withdrawn";

export function publicState(state: ContractState, endNs: string, nowMs = Date.now()): PublicState {
  switch (state) {
    case "live":
      return BigInt(endNs) / 1_000_000n <= BigInt(nowMs) ? "Ended, unclaimed" : "Live";
    case "checking":
      return "Checking";
    case "check_failed":
      return "Not posted";
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
  /** The raw values the list sorts by: USDC's smallest units and the end date in nanoseconds. */
  amountUnits: string;
  minimumTheftUnits: string;
  endNs: string;
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

/** Every bounty, and the contract they were read from, which the list names and links (R15.6). */
export interface BountyList {
  contract: string;
  contractHref: string;
  rows: BountyRow[];
}

export async function listBounties(): Promise<BountyList> {
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
        amountUnits: b.rules.bounty_amount,
        minimumTheftUnits: b.rules.minimum_theft,
        endNs: b.rules.end_date_ns,
      };
    }),
  );
  return { contract: c.contract, contractHref: c.contractHref, rows };
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

/** Why the posting check failed, per covered contract, as the judge answered (null: the check couldn't run). */
export type PostingFailure = "chain_unconfirmed" | "cannot_pause" | "pause_gas_short";

/** Not posted: why the posting check failed, and what came back. */
export interface Posting {
  /** Each failing contract by its place in `covered`, or null when the check couldn't run. */
  failures: { index: number; reason: PostingFailure }[] | null;
  /** The USDC the bounty contract sent back, read from that transaction's USDC transfer. */
  returned: string | null;
}

/** The winning claim, shown once the bounty is paid (D28): earlier, an earlier claim could still take the win. */
export interface Winner {
  whitehat: string;
  whitehatHref: string;
  chain: string;
  block: number;
  blockHref: string;
  payout: TxLink | null;
}

export type PublicationState = "delayed" | "publishable" | "requested" | "published";

export interface Publication {
  state: PublicationState;
  /** From when anyone may trigger it (ISO date): the payout plus the disclosure delay. */
  from: string;
  tx: TxLink | null;
}

export interface BountyPage {
  contract: string;
  contractHref: string;
  id: BountyId;
  state: PublicState;
  amount: string;
  minimumTheft: string;
  ends: string;
  claimsJudged: number;
  recencyMinutes: number;
  disclosureDelayDays: number;
  judgeBuild: string;
  covered: { chain: string; chainId: number; address: string; href: string }[];
  /** The listed tokens a theft is counted in (price above zero), each by its symbol as its chain reports it. */
  counts: { chain: string; symbol: string; href: string }[];
  posting: Posting | null;
  winner: Winner | null;
  publication: Publication | null;
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

async function chainPauses(c: Config, b: BountyView, find: Find, gasPerPause: bigint): Promise<ChainPause[]> {
  const id = b.id;
  const [role, verifications] = await Promise.all([
    view<{ address: string }>(c, c.contract, "pause_role", { id }),
    view<{ chain_id: number; verified: boolean; verified_pauses: string[] }[]>(c, c.contract, "pause_verifications", { id }),
  ]);
  const signedEvent = b.signed_pauses.length ? await eventOf(c, find, "pauses_signed", id) : null;
  return Promise.all(
    [...new Set(b.rules.covered_contracts.map((x) => x.chain_id))].map(async (chainId) => {
      const chain: ChainInfo | undefined = c.chains[chainId];
      const contracts = b.rules.covered_contracts.filter((x) => x.chain_id === chainId).map((x) => x.address);
      const signed = b.signed_pauses.filter((p) => p.chain_id === chainId).sort((x, y) => x.nonce - y.nonce);
      const pauses = await Promise.all(
        signed.map(async (p) => {
          const r = chain ? (landedReceipts.get(p.tx_hash) ?? (await receipt(chain.rpc, p.tx_hash))) : null;
          // Kept only once NEAR has recorded this pause verified: before that, a reorg could still undo the landing.
          const verifiedOnNear = verifications.some((v) => v.chain_id === chainId && v.verified_pauses.some((h) => h.toLowerCase() === p.tx_hash.toLowerCase()));
          if (r?.ok && verifiedOnNear) landedReceipts.set(p.tx_hash, r);
          // Landed means it succeeded against the covered contract (as verify's check reads it).
          const landed = !!r && r.ok && (r.to ?? "").toLowerCase() === p.contract.toLowerCase();
          return { hash: p.tx_hash, raw: p.tx, landed, href: `${chain?.explorerTx ?? ""}${p.tx_hash}` };
        }),
      );
      const record = verifications.find((v) => v.chain_id === chainId);
      const allVerified = signed.length > 0 && !!record && signed.every((p) => record.verified_pauses.some((h) => h.toLowerCase() === p.tx_hash.toLowerCase()));
      const verifiedEvent = allVerified ? await eventOf(c, find, "pause_verified", id, (d) => Number(d.chain_id) === chainId, String(chainId)) : null;
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

/**
 * Events found once never change (the chain is append-only), so each is kept for the server's
 * life: a bounty's page re-reads every 15 s, and the explorer's history is paged in full to find one.
 */
const seen = new Map<string, ContractEvent>();
/** A pause's receipt, once NEAR has verified the pause (so no reorg can undo it), isn't asked for again. */
const landedReceipts = new Map<string, Awaited<ReturnType<typeof receipt>>>();

async function eventOf(c: Config, find: Find, event: string, id: BountyId, match: (d: Record<string, unknown>) => boolean = () => true, scope = ""): Promise<ContractEvent | null> {
  const key = `${c.contract}|${event}|${id.protocol}/${id.name}|${scope}`;
  const hit = seen.get(key);
  if (hit) return hit;
  const e = await find(event, (d) => forBounty(id)(d) && match(d));
  if (e) seen.set(key, e);
  return e;
}

/** The USDC the token contract sent `to` in this transaction (its NEP-141 `ft_transfer` event), or null. */
async function usdcSent(c: Config, e: ContractEvent, to: string, decimals: number): Promise<string | null> {
  const token = (await view<{ usdc: string }>(c, c.contract, "config")).usdc;
  const receipts = await txReceipts(c, e.tx, e.signer);
  for (const r of receipts ?? []) {
    if (r.executor_id !== token || !r.ok) continue;
    for (const log of r.logs) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const ev = JSON.parse(log.slice("EVENT_JSON:".length));
        if (ev.standard !== "nep141" || ev.event !== "ft_transfer") continue;
        const sent = (ev.data as { old_owner_id: string; new_owner_id: string; amount: string }[]).find((x) => x.old_owner_id === c.contract && x.new_owner_id === to);
        if (sent) return usdc(sent.amount, decimals);
      } catch {
        // not an event
      }
    }
  }
  return null;
}

async function postingOf(c: Config, find: Find, b: BountyView, decimals: number): Promise<Posting | null> {
  if (b.state !== "check_failed") return null;
  const e = await eventOf(c, find, "bounty_check_failed", b.id);
  if (!e) return null;
  return { failures: (e.data.failures as Posting["failures"]) ?? null, returned: await usdcSent(c, e, b.id.protocol, decimals) };
}

async function winnerOf(c: Config, find: Find, b: BountyView): Promise<Winner | null> {
  if (b.state !== "paid" || b.winning_claim === null) return null;
  const claimId = b.winning_claim;
  const [claim, paid] = await Promise.all([
    view<{ whitehat: string; block: { chain_id: number; number: number } }>(c, c.contract, "claim", { claim_id: claimId }),
    eventOf(c, find, "bounty_paid", b.id, (d) => Number(d.claim_id) === claimId),
  ]);
  const chain = c.chains[claim.block.chain_id];
  return {
    whitehat: claim.whitehat,
    whitehatHref: `${c.nearExplorer}address/${claim.whitehat}`,
    chain: chain?.name ?? `chain ${claim.block.chain_id}`,
    block: claim.block.number,
    blockHref: `${chain?.explorer ?? ""}block/${claim.block.number}`,
    payout: paid ? nearTx(c, paid.tx) : null,
  };
}

async function publicationOf(c: Config, find: Find, b: BountyView): Promise<Publication | null> {
  if (b.state !== "paid") return null;
  const p = await view<{ state: string; publishable_from_ns: string } | null>(c, c.contract, "published_exploit", { id: b.id });
  if (!p) return null;
  const state = p.state.toLowerCase() as PublicationState;
  const e = state === "published" ? await eventOf(c, find, "exploit_published", b.id) : null;
  return { state, from: isoDate(p.publishable_from_ns), tx: e ? nearTx(c, e.tx) : null };
}

const ERC20_SYMBOL = "0x95d89b41";

/** A token's symbol as its contract reports it (ABI-encoded string), or null if it doesn't answer. */
async function symbolOf(rpcUrl: string, token: string): Promise<string | null> {
  try {
    const hex = await evmRpc<string>(rpcUrl, "eth_call", [{ to: token, data: ERC20_SYMBOL }, "latest"]);
    const bytes = Buffer.from(hex.slice(2), "hex");
    if (bytes.length < 64) return null;
    const len = Number(bytes.readBigUInt64BE(56));
    const s = bytes.subarray(64, 64 + len).toString("utf8");
    return /^[\x20-\x7e]{1,16}$/.test(s) ? s : null;
  } catch {
    return null;
  }
}

/** The listed tokens a theft is counted in: those with a price above zero, by their own symbols. */
async function countsOf(c: Config, r: Rules): Promise<BountyPage["counts"]> {
  const priced = r.listed_tokens.filter((t) => BigInt(t.price) > 0n);
  const out = await Promise.all(
    priced.map(async (t) => {
      const chain = c.chains[t.chain_id];
      if (!chain) return null;
      const symbol = t.token === "native" ? chain.gasToken : await symbolOf(chain.rpc, t.token);
      if (!symbol) return null;
      return { chain: chain.name, symbol, href: t.token === "native" ? chain.explorer : `${chain.explorer}token/${t.token}` };
    }),
  );
  return out.filter((x): x is BountyPage["counts"][number] => x !== null);
}

export async function readBounty(id: BountyId): Promise<BountyPage | null> {
  const c = config();
  const b = await view<BountyView | null>(c, c.contract, "bounty", { id });
  if (!b) return null;
  const find = history(c);
  const [decimals, judged, fees] = await Promise.all([usdcDecimals(c), claimsJudged(c, id), view<{ pause_gas_per_pause: string }>(c, c.contract, "fees")]);
  const r = b.rules;
  const [posting, winner, publication, counts, chains] = await Promise.all([
    postingOf(c, find, b, decimals),
    winnerOf(c, find, b),
    publicationOf(c, find, b),
    countsOf(c, r),
    chainPauses(c, b, find, BigInt(fees.pause_gas_per_pause)),
  ]);
  return {
    contract: c.contract,
    contractHref: c.contractHref,
    id,
    state: publicState(b.state, r.end_date_ns),
    amount: usdc(r.bounty_amount, decimals),
    minimumTheft: usdc(r.minimum_theft, decimals),
    ends: isoDate(r.end_date_ns),
    claimsJudged: judged,
    recencyMinutes: r.recency_limit_secs / 60,
    disclosureDelayDays: r.disclosure_delay_days,
    judgeBuild: r.judge_build_hash,
    covered: r.covered_contracts.map((x) => {
      const chain = c.chains[x.chain_id];
      return { chain: chain?.name ?? `chain ${x.chain_id}`, chainId: x.chain_id, address: x.address, href: `${chain?.explorer ?? ""}address/${x.address}` };
    }),
    counts,
    posting,
    winner,
    publication,
    chains,
  };
}
