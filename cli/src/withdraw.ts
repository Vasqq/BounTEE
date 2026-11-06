// `bountee withdraw <USDC> --to <chain>:<address> --as <account>` (D12, ADR-0013): sends a
// Whitehat's USDC from their NEAR account to an address they name on another chain, through
// NEAR Intents' 1Click. Mainnet only: 1Click has no testnet.
//
// 1Click quotes the swap and names a deposit address on NEAR; USDC sent there is delivered on the
// other chain, or refunded to the Whitehat's own NEAR account if the swap fails. The quote's
// deadline is 1Click's to choose (it answered three days when asked for ten minutes, Nov 6), so
// the deposit goes straight after the quote and is refused unless the deadline is minutes away
// yet. The deposit address isn't registered with NEAR's USDC, so the one transaction registers it
// and then sends exactly the amount: both actions run in order on the USDC contract, in one
// receipt, so neither lands without the other. Once that transaction is sent, nothing after it
// may hide it: telling 1Click of the deposit is a courtesy, and the result always names it, or a
// rerun would deposit again.
import { actions } from "near-api-js";
import { needFullAccess, parseUnits } from "./balance.ts";
import { INTENTS_API } from "./endpoints.ts";
import { Near, tgas } from "./near.ts";

export interface WithdrawResult {
  account: string;
  /** In USDC's smallest unit (6 decimals). */
  amount: string;
  to: { chain: string; address: string };
  deposit_address: string;
  deposit_tx: string;
  /** What 1Click quoted as arriving, and the least it guarantees, in the target USDC's smallest unit. */
  amount_out: string;
  min_amount_out: string;
  /** 1Click's status once it stopped changing: SUCCESS, REFUNDED, FAILED, INCOMPLETE_DEPOSIT, or the last seen. */
  status: string;
  /** The delivery's transactions on the other chain. */
  delivered_txs: string[];
  /** What went wrong after the deposit was sent: it was sent all the same. */
  problems: string[];
}

interface Token {
  assetId: string;
  blockchain: string;
  symbol: string;
  decimals: number;
  contractAddress: string | null;
}

const TERMINAL = ["SUCCESS", "REFUNDED", "FAILED", "INCOMPLETE_DEPOSIT"];
/** The least time left before the quote's deadline for a deposit to go out and land before it. */
const DEADLINE_MARGIN_MS = 2 * 60_000;
/** The least share of the amount a quote must guarantee: 1Click's 0.25% fee and 1% slippage fit. */
const MIN_OUT_PERCENT = 98n;

const formatUsdc = (units: bigint | string, decimals = 6) => {
  const u = BigInt(units);
  const one = 10n ** BigInt(decimals);
  const frac = (u % one).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${u / one}${frac ? `.${frac}` : ""}`;
};

async function api<T>(base: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}${json.message ? `: ${json.message}` : ""}`), { fromIntents: true });
  return json;
}

export async function withdraw(o: { near: Near; account: string; amount: string; to: string; intentsApi?: string; pollSecs?: number; timeoutSecs?: number }): Promise<WithdrawResult> {
  const { near, account } = o;
  if (near.network !== "mainnet") throw new Error("withdraw is mainnet only: NEAR Intents' 1Click has no testnet");
  const amount = parseUnits(o.amount, 6, "USDC");
  const m = /^([a-z0-9]+):(.+)$/.exec(o.to);
  if (!m) throw new Error(`--to is <chain>:<address>, e.g. base:0x…, not ${o.to}`);
  const chain = m[1]!;
  const address = m[2]!;
  if (chain === "near") throw new Error("the USDC is already on NEAR: send it with ft_transfer, not through 1Click");
  const base = o.intentsApi ?? INTENTS_API;

  const tokens = await api<Token[]>(base, "/v0/tokens");
  const from = tokens.find((t) => t.blockchain === "near" && t.symbol === "USDC");
  const dest = tokens.find((t) => t.blockchain === chain && t.symbol === "USDC");
  if (!from?.contractAddress) throw new Error("1Click lists no USDC on NEAR");
  if (!dest) throw new Error(`1Click has no USDC on ${chain}; it has USDC on ${tokens.filter((t) => t.symbol === "USDC").map((t) => t.blockchain).join(", ")}`);

  // A claim key can't send USDC (R14.3), and NEAR would refuse its deposit anyway: say so first.
  await needFullAccess(near, account, "move USDC");
  const held = BigInt(await near.view<string>(from.contractAddress, "ft_balance_of", { account_id: account }));
  if (held < amount) throw new Error(`${account} holds ${formatUsdc(held)} USDC, less than ${formatUsdc(amount)}`);

  const quoted = await api<{ quote: { depositAddress: string; deadline: string; timeWhenInactive?: string; amountOut: string; minAmountOut: string } }>(base, "/v0/quote", {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: from.assetId,
    destinationAsset: dest.assetId,
    amount: amount.toString(),
    depositType: "ORIGIN_CHAIN",
    recipient: address,
    recipientType: "DESTINATION_CHAIN",
    refundTo: account,
    refundType: "ORIGIN_CHAIN",
    deadline: new Date(Date.now() + 10 * 60_000).toISOString(),
  }).catch((e: Error & { fromIntents?: boolean }) => {
    if (!e.fromIntents) throw e;
    const min = /try at least (\d+)/.exec(e.message);
    if (min) throw new Error(`${formatUsdc(amount)} USDC is below 1Click's minimum of ${formatUsdc(min[1]!)} USDC`);
    if (/recipient is not valid/i.test(e.message)) throw new Error(`${chain} won't accept ${address} as a recipient`);
    throw new Error(`1Click refused the quote: ${e.message}`);
  });
  const { depositAddress, deadline, timeWhenInactive, amountOut, minAmountOut } = quoted.quote;
  const expires = Math.min(Date.parse(deadline), Date.parse(timeWhenInactive ?? deadline));
  if (!(expires - Date.now() >= DEADLINE_MARGIN_MS)) throw new Error(`1Click's quote is past or too near its deadline ${deadline}: nothing was sent`);
  // USDC to USDC: what arrives, in the target's decimals, against the amount sent.
  const scale = (u: bigint) => (u * 10n ** 6n) / 10n ** BigInt(dest.decimals);
  if (scale(BigInt(minAmountOut)) * 100n < amount * MIN_OUT_PERCENT) {
    throw new Error(`1Click's quote guarantees only ${formatUsdc(minAmountOut, dest.decimals)} USDC on ${chain} for ${formatUsdc(amount)}: nothing was sent`);
  }

  const bounds = await near.view<{ min: string }>(from.contractAddress, "storage_balance_bounds");
  const r = await near.account(account).signAndSendTransaction({
    receiverId: from.contractAddress,
    actions: [
      actions.functionCall("storage_deposit", { account_id: depositAddress, registration_only: true }, tgas(10), BigInt(bounds.min)),
      actions.functionCall("ft_transfer", { receiver_id: depositAddress, amount: amount.toString() }, tgas(20), 1n),
    ],
    waitUntil: "FINAL",
  });
  const depositTx = r.transaction.hash;
  const problems: string[] = [];
  await api(base, "/v0/deposit/submit", { txHash: depositTx, depositAddress, nearSenderAccount: account }).catch((e: Error) =>
    problems.push(`1Click's /v0/deposit/submit failed (${e.message}); it finds the deposit on its own`),
  );

  let status = { status: "PENDING_DEPOSIT", swapDetails: { destinationChainTxHashes: [] as { hash: string }[] } };
  let lastPollError: string | undefined;
  const until = Date.now() + (o.timeoutSecs ?? 600) * 1000;
  for (;;) {
    status = await api<typeof status>(base, `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}`).then(
      (s) => ((lastPollError = undefined), s),
      (e: Error) => ((lastPollError = e.message), status),
    );
    if (TERMINAL.includes(status.status) || Date.now() > until) break;
    await new Promise((res) => setTimeout(res, (o.pollSecs ?? 5) * 1000));
  }
  if (lastPollError) problems.push(`1Click's /v0/status failed (${lastPollError}); ask it again with the deposit address`);
  return {
    account,
    amount: amount.toString(),
    to: { chain, address },
    deposit_address: depositAddress,
    deposit_tx: depositTx,
    amount_out: amountOut,
    min_amount_out: minAmountOut,
    status: status.status,
    delivered_txs: (status.swapDetails?.destinationChainTxHashes ?? []).map((t) => t.hash),
    problems,
  };
}

export function formatWithdrawResult(r: WithdrawResult): string {
  return [
    `withdraw ${formatUsdc(r.amount)} USDC from ${r.account} to ${r.to.address} on ${r.to.chain}: ${r.status}`,
    `  deposit:   ${r.deposit_tx} (to 1Click's ${r.deposit_address})`,
    `  delivered: ${r.delivered_txs.length ? r.delivered_txs.join(", ") : "not yet"}`,
    ...r.problems.map((p) => `  problem:   ${p}`),
  ].join("\n");
}
