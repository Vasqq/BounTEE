// The transactions behind each step of a bounty's life. The contract logs an event for each
// step (NEP-297 `EVENT_JSON:`); FastNEAR's explorer API says which of the contract's
// transactions logged which, and every one the page links is read again from NEAR RPC, so
// the explorer is trusted for nothing (as the command-line tool's verify does).
import { history as explorerHistory, listTxs } from "@bountee/cli/src/explorer.ts";
import type { Config } from "./config.ts";
import { txReceipts } from "./near.ts";

export interface ContractEvent {
  event: string;
  data: Record<string, unknown>;
  tx: string;
  signer: string;
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
  const out: ContractEvent[] = [];
  for await (const page of explorerHistory(c.txApi, c.contract)) {
    for (const t of await listTxs(c.txApi, page)) {
      if (!t.signer_id) continue;
      for (const r of t.receipts) {
        if (r.executor_id !== c.contract || !r.ok) continue;
        for (const e of eventsIn(r.logs)) out.push({ ...e, tx: t.hash, signer: t.signer_id });
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
