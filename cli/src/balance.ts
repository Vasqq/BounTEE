// `bountee balance` (R11.3): a Whitehat's claim balance on the bounty contract, the NEAR each
// claim's judging and storage is drawn from (R11.1).
//
//   bountee balance --as <account>                     what it holds
//   bountee balance top-up <NEAR> --as <account>       add that much (`top_up_claim_balance`)
//   bountee balance withdraw [<NEAR>] --as <account>   send that much, or all of it, back to the
//                                                      account (`withdraw_claim_balance`)
//
// A withdrawal attaches exactly 1 yoctoNEAR, as the contract asks, so only the account's own
// key can make one, never a claim key (R14.3); the yoctoNEAR comes back with it. A claim key
// can't top up either (no deposit), so both say so before sending if the local key is one.
import { actions } from "near-api-js";
import { formatNear, Near, tgas } from "./near.ts";

export interface BalanceResult {
  contract: string;
  account: string;
  /** What was done: nothing (a read), a top-up or a withdrawal. */
  action: "show" | "top_up" | "withdraw";
  /** The amount moved, in yoctoNEAR (all of it for a withdrawal with no amount). */
  amount?: string;
  tx_hash?: string;
  /** The claim balance afterwards, in yoctoNEAR. */
  balance: string;
}

/** An amount of NEAR as typed (`1`, `0.25`) in yoctoNEAR. */
export function parseNearAmount(text: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,24}))?$/.exec(text);
  if (!m) throw new Error(`${text} is not an amount of NEAR, e.g. 1 or 0.25`);
  const yocto = BigInt(m[1]!) * 10n ** 24n + BigInt((m[2] ?? "").padEnd(24, "0") || "0");
  if (yocto === 0n) throw new Error("the amount must be more than 0 NEAR");
  return yocto;
}

const balanceOf = async (near: Near, contract: string, account: string) => BigInt(await near.view<string>(contract, "claim_balance", { account_id: account }));

/** Any deposit needs a full-access key: NEAR refuses one signed with a function-call key. */
async function needFullAccess(near: Near, account: string, what: string) {
  if (await near.signsWithFunctionCallKey(account)) {
    throw new Error(`the local key for ${account} is a claim key: it can't ${what}. Run this with the account's own key.`);
  }
}

export async function balanceCommand(o: { near: Near; contract: string; account: string; action: "show" | "top_up" | "withdraw"; amount?: string }): Promise<BalanceResult> {
  const { near, contract, account } = o;
  const base = { contract, account, action: o.action };
  if (o.action === "show") return { ...base, balance: (await balanceOf(near, contract, account)).toString() };

  if (o.action === "top_up") {
    if (o.amount === undefined) throw new Error("balance top-up needs an amount of NEAR");
    const amount = parseNearAmount(o.amount);
    await needFullAccess(near, account, "top up the claim balance (that attaches NEAR)");
    const r = await near.account(account).signAndSendTransaction({
      receiverId: contract,
      actions: [actions.functionCall("top_up_claim_balance", {}, tgas(30), amount)],
      waitUntil: "FINAL",
    });
    return { ...base, amount: amount.toString(), tx_hash: r.transaction.hash, balance: (await balanceOf(near, contract, account)).toString() };
  }

  const have = await balanceOf(near, contract, account);
  const amount = o.amount === undefined ? have : parseNearAmount(o.amount);
  if (have === 0n) throw new Error(`${account}'s claim balance on ${contract} is empty: nothing to withdraw`);
  if (amount > have) throw new Error(`${account}'s claim balance holds ${formatNear(have)} NEAR: less than ${formatNear(amount)}`);
  await needFullAccess(near, account, "withdraw the claim balance (that attaches 1 yoctoNEAR)");
  const r = await near.account(account).signAndSendTransaction({
    receiverId: contract,
    // No amount withdraws all of it, as the contract reads it at the time.
    actions: [actions.functionCall("withdraw_claim_balance", o.amount === undefined ? {} : { amount: amount.toString() }, tgas(30), 1n)],
    waitUntil: "FINAL",
  });
  return { ...base, amount: amount.toString(), tx_hash: r.transaction.hash, balance: (await balanceOf(near, contract, account)).toString() };
}

export function formatBalanceResult(r: BalanceResult): string {
  const now = `claim balance of ${r.account} on ${r.contract}: ${formatNear(BigInt(r.balance))} NEAR`;
  if (r.action === "show") return now;
  const moved = `${r.action === "top_up" ? "topped up" : "withdrew"} ${formatNear(BigInt(r.amount!))} NEAR (${r.tx_hash})`;
  return `${moved}\n${now}`;
}
