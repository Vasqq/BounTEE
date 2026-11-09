// `bountee post <protocol>/<name> --rules <rules.json> --contract <bounty contract>` (#17):
// post a bounty from the terminal, the fallback if the web posting flow is cut.
//
//   bountee post <protocol>/<name> --rules <rules.json> --contract <account>
//                [--network testnet|mainnet] [--rpc <NEAR rpc>] [--chain-rpc <chain id>=<url>[,...]]
//                [--no-preflight] [--json]
//
// The Protocol is the NEAR account named in the bounty ID; its key must be in
// ~/.near-credentials/<network>/ (or BOUNTEE_CREDENTIALS_DIR). The rules file is the shared
// formats' `Rules`; the fields BounTEE sets (`recency_limit_secs`, `seed`,
// `judge_build_hash`) are taken from the bounty contract when the file leaves them out.
//
// 1. Preflight, before anything is spent: the name is unused, the Protocol holds the NEAR the
//    posting needs in hand (`postingNeed`: the fee and the gas both calls attach, #57), and each covered chain's
//    pause-role address (the contract's `pause_role` view, D25) holds the pause gas the
//    posting check will ask for (R7.6: per pause, gas limit at fee limit plus the L1 data
//    fee, the formats' `PAUSE_GAS_PER_PAUSE`, which the judge checks and `fees()` shows). `--no-preflight` skips the pause-gas part and lets the enclave's
//    check decide.
// 2. Tops up the posting-fee balance to one posting fee (`prepay_posting_fee`).
// 3. Sends the bounty amount as one USDC `ft_transfer_call` carrying the name and rules,
//    which runs the posting check (R12.1, R12.2, R12.5, R7.6). The bounty is live if it
//    passes; otherwise the USDC comes back in full (R1.6) and the judge's reasons are shown.
//
// Exit status 1 unless the bounty went live.
import { readFileSync } from "node:fs";
import { actions } from "near-api-js";
import { PAUSE_GAS_PER_PAUSE, parseRules, type BountyId, type PostingFailure, type Rules } from "@bountee/formats";
import { parseBountyId } from "./bounties.ts";
import { defaultRpc } from "./chains.ts";
import { NEAR_RPC, type Network } from "./endpoints.ts";
import { events, formatNear, Near, tgas, type PricedCall } from "./near.ts";
import { rpc } from "./proofs.ts";

/** NEAR's Ethereum-wallet relayer caps a transaction at 270 Tgas, so the web app attaches that; so does the tool. */
const POSTING_GAS = tgas(270);
/** What a first prepayment's balance entry costs in storage, with room to spare. */
const ENTRY_STORAGE = 10n ** 22n;

export interface PostOptions {
  bounty: string;
  rules: string;
  contract: string;
  network: Network;
  nearRpc?: string;
  /** Chain ID → RPC URL for the pause-gas preflight, over the defaults. */
  chainRpcs?: Record<number, string>;
  preflight?: boolean;
}

export interface PauseGas {
  chain_id: number;
  pause_role: string;
  /** Wei, decimal. */
  balance: string;
  needed: string;
  ok: boolean;
}

export interface PostResult {
  bounty: BountyId;
  contract: string;
  /** `live`, or `check_failed` (the USDC came back). */
  state: string;
  pause_role: string;
  pause_gas: PauseGas[];
  prepaid_near?: string;
  prepay_tx?: string;
  post_tx: string;
  /** The judge's reasons when the check failed; null when the job gave none. */
  failures?: (PostingFailure & { contract: Rules["covered_contracts"][number] })[] | null;
}

/** The posting's two calls: the fee's top-up when the prepaid balance is short of one fee, then the bounty amount carrying the rules. */
function postingCalls(postingFee: bigint, prepaid: bigint, name: string, rules: Rules, amount: string, contract: string): PricedCall[] {
  const calls: PricedCall[] = [];
  if (prepaid < postingFee) {
    calls.push({ method: "prepay_posting_fee", gas: tgas(30), deposit: postingFee - prepaid + (prepaid === 0n ? ENTRY_STORAGE : 0n), argsBytes: 2 });
  }
  const args = { receiver_id: contract, amount, msg: JSON.stringify({ name, rules }) };
  calls.push({ method: "ft_transfer_call", gas: POSTING_GAS, deposit: 1n, argsBytes: JSON.stringify(args).length });
  return calls;
}

/** The calls that post `rules` as `name` on `contract`, and the NEAR `protocol` must hold for them, free of its storage stake. */
export async function postingNeed(near: Near, contract: string, protocol: string, name: string, rules: Rules): Promise<{ calls: PricedCall[]; need: bigint }> {
  const [fees, prepaid] = await Promise.all([
    near.view(contract, "fees"),
    near.view<string>(contract, "posting_fee_balance", { account_id: protocol }),
  ]);
  const calls = postingCalls(BigInt(fees.posting_fee), BigInt(prepaid), name, rules, rules.bounty_amount, contract);
  return { calls, need: await near.upfrontNear(calls) };
}

export async function post(o: PostOptions): Promise<PostResult> {
  const near = new Near(o.network, o.nearRpc ?? NEAR_RPC[o.network]);
  const id = parseBountyId(o.bounty);
  const config = await near.view(o.contract, "config");
  const given = JSON.parse(readFileSync(o.rules, "utf8"));
  const rules = parseRules({
    ...given,
    recency_limit_secs: given.recency_limit_secs ?? 300,
    seed: given.seed ?? config.seed,
    judge_build_hash: given.judge_build_hash ?? config.judge_build_hash,
  });

  // ---- 1. Preflight ----
  if (await near.view(o.contract, "bounty", { id })) {
    throw new Error(`${id.protocol}/${id.name} exists already: a bounty name is never reused (D25)`);
  }
  const { calls, need: needNear } = await postingNeed(near, o.contract, id.protocol, id.name, rules);
  const freeNear = (await near.freeNear(id.protocol)) ?? 0n;
  if (freeNear < needNear) {
    throw new Error(
      `${id.protocol} holds ${formatNear(freeNear)} NEAR free of its storage stake and the posting needs ${formatNear(needNear)} in hand ` +
        `(the posting fee and the gas both calls attach, refunded once unused): add ${formatNear(needNear - freeNear)} NEAR (nothing was spent)`,
    );
  }
  const role = await near.view<{ address: string }>(o.contract, "pause_role", { id });
  const pauses = new Map<number, number>();
  for (const c of rules.covered_contracts) pauses.set(c.chain_id, (pauses.get(c.chain_id) ?? 0) + 1);
  const pauseGas: PauseGas[] = [];
  if (o.preflight !== false) {
    for (const [chain, n] of pauses) {
      const url = o.chainRpcs?.[chain] ?? defaultRpc(chain);
      if (!url) throw new Error(`no RPC known for chain ${chain}: give one with --chain-rpc ${chain}=<url>`);
      const balance = BigInt(await rpc<string>(url, "eth_getBalance", [role.address, "latest"]));
      const needed = PAUSE_GAS_PER_PAUSE * BigInt(n);
      pauseGas.push({ chain_id: chain, pause_role: role.address, balance: balance.toString(), needed: needed.toString(), ok: balance >= needed });
    }
    const short = pauseGas.filter((p) => !p.ok);
    if (short.length > 0) {
      throw new Error(
        `the pause-role address ${role.address} needs pause gas before posting (nothing was spent): ` +
          short.map((p) => `send ${BigInt(p.needed) - BigInt(p.balance)} wei on chain ${p.chain_id}`).join("; "),
      );
    }
  }

  // ---- 2. Posting fee ----
  const protocol = near.account(id.protocol);
  const out: Partial<PostResult> = {};
  const prepay = calls.find((c) => c.method === "prepay_posting_fee");
  if (prepay) {
    const r = await protocol.signAndSendTransaction({
      receiverId: o.contract,
      actions: [actions.functionCall(prepay.method, {}, prepay.gas, prepay.deposit)],
      waitUntil: "FINAL",
    });
    out.prepaid_near = formatNear(prepay.deposit);
    out.prepay_tx = r.transaction.hash;
  }

  // ---- 3. The bounty amount, carrying the rules ----
  const sent = await protocol.signAndSendTransaction({
    receiverId: config.usdc,
    actions: [
      actions.functionCall(
        "ft_transfer_call",
        { receiver_id: o.contract, amount: rules.bounty_amount, msg: JSON.stringify({ name: id.name, rules }) },
        POSTING_GAS,
        1n,
      ),
    ],
    waitUntil: "FINAL",
    throwOnFailure: false,
  });
  const status = await near.txStatus(sent.transaction.hash, id.protocol);
  const bounty = await near.view<{ state: string } | null>(o.contract, "bounty", { id });
  if (!bounty) {
    const failure = status.receipts_outcome
      .map((r: any) => r.outcome.status.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError)
      .find(Boolean);
    throw new Error(`the posting was refused and its USDC sent back: ${failure ?? JSON.stringify(status.status)} (tx ${sent.transaction.hash})`);
  }
  const failed = events(status).find((e) => e.event === "bounty_check_failed");
  return {
    bounty: id,
    contract: o.contract,
    state: bounty.state,
    pause_role: role.address,
    pause_gas: pauseGas,
    ...out,
    post_tx: sent.transaction.hash,
    ...(failed
      ? {
          failures: failed.data.failures
            ? (failed.data.failures as PostingFailure[]).map((f) => ({ ...f, contract: rules.covered_contracts[f.index]! }))
            : null,
        }
      : {}),
  };
}

const REASON_TEXT: Record<string, string> = {
  cannot_pause: "pause() from the pause-role address reverts: grant it the pause role, and check the contract can be paused",
  pause_gas_short: "the pause-role address holds too little pause gas",
  chain_unconfirmed: "the judge's pinned RPCs for this chain didn't answer or didn't agree",
};

export function formatPostResult(r: PostResult): string {
  const lines = [`${r.bounty.protocol}/${r.bounty.name} on ${r.contract}: ${r.state}`, `posted: ${r.post_tx}`];
  if (r.prepay_tx) lines.push(`posting fee prepaid: ${r.prepaid_near} NEAR (${r.prepay_tx})`);
  lines.push(`pause-role address: ${r.pause_role}`);
  if (r.state !== "live") {
    lines.push("the posting check failed; the bounty amount was refunded in full (the posting fee is not)");
    if (r.failures === null) lines.push("the check's job gave no answer");
    for (const f of r.failures ?? []) lines.push(`  ${f.contract.chain_id} ${f.contract.address}: ${REASON_TEXT[f.reason] ?? f.reason}`);
  }
  return lines.join("\n");
}
