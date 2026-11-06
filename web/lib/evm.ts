// An EVM chain's JSON-RPC: a pause's receipt, and the pause-role address's gas.
async function call<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), cache: "no-store" });
  const body = (await res.json()) as { result?: T; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
  return body.result as T;
}

export interface Receipt {
  ok: boolean;
  block: number;
  to: string | null;
}

/** The transaction's receipt, or null while it hasn't landed. */
export async function receipt(url: string, hash: string): Promise<Receipt | null> {
  const r = await call<{ status: string; blockNumber: string; to?: string | null } | null>(url, "eth_getTransactionReceipt", [hash]);
  return r ? { ok: r.status === "0x1", block: Number(r.blockNumber), to: r.to ?? null } : null;
}

export async function balance(url: string, address: string): Promise<bigint> {
  return BigInt(await call<string>(url, "eth_getBalance", [address, "latest"]));
}
