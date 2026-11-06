// FastNEAR's public explorer API: an indexer of NEAR transactions, trusted for nothing. It says
// which transactions to look at and who signed them, since NEAR RPC finds a transaction only
// when asked with its signer; everything checked is read again from NEAR RPC.
import { postJson } from "./proofs.ts";

const post = <T>(url: string, body: unknown) => postJson<T>(url, body, { backoffMs: 1000 });

/** The contract's transactions, newest first, a page at a time, as the explorer API lists them. */
export async function* history(api: string, account: string): AsyncGenerator<string[]> {
  let resume: string | undefined;
  for (let page = 0; page < 50; page++) {
    const r = await post<{ account_txs: { transaction_hash: string }[]; resume_token?: string }>(`${api}/v0/account`, {
      account_id: account,
      limit: 200,
      ...(resume ? { resume_token: resume } : {}),
    });
    yield [...new Set(r.account_txs.map((t) => t.transaction_hash))];
    if (!r.resume_token) return;
    resume = r.resume_token;
  }
}

/** A transaction as FastNEAR's explorer API lists it. */
interface IndexedTx {
  transaction?: { hash?: string; signer_id?: string };
  receipts?: { execution_outcome?: { outcome?: { executor_id?: string; logs?: string[]; status?: object } } }[];
}

/** Receipts' outcomes, as events are read from them. */
export interface Outcomes {
  receipts: { executor_id: string; predecessor_id?: string; logs: string[]; ok: boolean }[];
}

/** What the explorer says a transaction is: who signed it and, as a hint of where to look, what it logged. */
export interface Listed extends Outcomes {
  hash: string;
  signer_id?: string;
}

/** The explorer's account of each transaction it has indexed among `hashes`, 20 to a request. */
export async function listTxs(api: string, hashes: string[]): Promise<Listed[]> {
  const out: Listed[] = [];
  for (let i = 0; i < hashes.length; i += 20) {
    const r = await post<{ transactions?: (IndexedTx | null)[] }>(`${api}/v0/transactions`, { tx_hashes: hashes.slice(i, i + 20) });
    for (const t of r.transactions ?? []) {
      if (!t?.transaction?.hash) continue;
      const receipts = (t.receipts ?? []).map((x) => ({
        executor_id: x.execution_outcome?.outcome?.executor_id ?? "",
        logs: x.execution_outcome?.outcome?.logs ?? [],
        ok: !("Failure" in (x.execution_outcome?.outcome?.status ?? {})),
      }));
      out.push({ hash: t.transaction.hash, signer_id: t.transaction.signer_id, receipts });
    }
  }
  return out;
}

/** Who signed each of `hashes` the explorer has indexed; none, if it can't be reached. */
export async function txSigners(api: string, hashes: string[]): Promise<Map<string, string>> {
  const listed = await listTxs(api, hashes).catch(() => []);
  return new Map(listed.flatMap((t) => (t.signer_id ? [[t.hash, t.signer_id] as const] : [])));
}
