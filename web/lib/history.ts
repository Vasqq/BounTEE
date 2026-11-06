// The transactions behind each step of a bounty's life. The contract logs an event for each
// step (NEP-297 `EVENT_JSON:`); FastNEAR's explorer API says which of the contract's
// transactions logged which, and every one the page links is read again from NEAR RPC, so
// the explorer is trusted for nothing (as the command-line tool's verify does).
import type { Config } from "./config.ts";
import { txReceipts } from "./near.ts";

export interface ContractEvent {
  event: string;
  data: Record<string, unknown>;
  tx: string;
  signer: string;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return (await res.json()) as T;
}

function eventsIn(logs: string[]): { event: string; data: Record<string, unknown> }[] {
  return logs.flatMap((log) => {
    if (!log.startsWith("EVENT_JSON:")) return [];
    try {
      const e = JSON.parse(log.slice("EVENT_JSON:".length));
      if (e.standard !== "bountee") return [];
      return (Array.isArray(e.data) ? e.data : [e.data]).map((data: Record<string, unknown>) => ({ event: String(e.event), data }));
    } catch {
      return [];
    }
  });
}

/** Every event the bounty contract logged, oldest first, as the explorer indexes them (unconfirmed). */
async function indexed(c: Config): Promise<ContractEvent[]> {
  const hashes: string[] = [];
  let resume: string | undefined;
  for (let page = 0; page < 20; page++) {
    const r = await post<{ account_txs: { transaction_hash: string }[]; resume_token?: string }>(`${c.txApi}/v0/account`, {
      account_id: c.contract,
      limit: 200,
      ...(resume ? { resume_token: resume } : {}),
    });
    for (const t of r.account_txs) if (!hashes.includes(t.transaction_hash)) hashes.push(t.transaction_hash);
    if (!r.resume_token) break;
    resume = r.resume_token;
  }
  const out: ContractEvent[] = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const r = await post<{ transactions?: ({ transaction?: { hash?: string; signer_id?: string }; receipts?: { execution_outcome?: { outcome?: { executor_id?: string; logs?: string[]; status?: object } } }[] } | null)[] }>(
      `${c.txApi}/v0/transactions`,
      { tx_hashes: hashes.slice(i, i + 20) },
    );
    for (const t of r.transactions ?? []) {
      const hash = t?.transaction?.hash;
      const signer = t?.transaction?.signer_id;
      if (!hash || !signer) continue;
      for (const rc of t?.receipts ?? []) {
        const o = rc.execution_outcome?.outcome;
        if (o?.executor_id !== c.contract || "Failure" in (o.status ?? {})) continue;
        for (const e of eventsIn(o.logs ?? [])) out.push({ ...e, tx: hash, signer });
      }
    }
  }
  // The explorer lists newest first.
  return out.reverse();
}

/** Whether NEAR RPC shows `tx` logging this event from the contract, in a receipt that succeeded. */
async function confirmed(c: Config, e: ContractEvent): Promise<boolean> {
  const receipts = await txReceipts(c, e.tx, e.signer);
  const want = JSON.stringify(e.data);
  return !!receipts?.some((r) => r.executor_id === c.contract && r.ok && eventsIn(r.logs).some((x) => x.event === e.event && JSON.stringify(x.data) === want));
}

export type Find = (event: string, match: (data: Record<string, unknown>) => boolean) => Promise<ContractEvent | null>;

/**
 * A finder over the contract's history: the first event of a kind matching `match`, once NEAR
 * RPC confirms it, or null. The explorer is read once per finder.
 */
export function history(c: Config): Find {
  let all: Promise<ContractEvent[]> | null = null;
  return async (event, match) => {
    all ??= indexed(c);
    for (const e of await all) {
      if (e.event === event && match(e.data) && (await confirmed(c, e))) return e;
    }
    return null;
  };
}

/** Whether an event's `bounty` is this bounty. */
export const forBounty = (id: { protocol: string; name: string }) => (data: Record<string, unknown>) => {
  const b = data.bounty as { protocol?: string; name?: string } | undefined;
  return b?.protocol === id.protocol && b?.name === id.name;
};
