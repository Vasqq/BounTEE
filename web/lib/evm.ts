// An EVM chain's JSON-RPC: a pause's receipt (the command-line tool's reader), and the
// pause-role address's gas.
import { evmReceipt } from "@bountee/cli/src/chains.ts";
import { rpc } from "@bountee/cli/src/proofs.ts";

export interface Receipt {
  ok: boolean;
  block: number;
  to: string | null;
}

/** The transaction's receipt, or null while it hasn't landed (or the RPC didn't answer). */
export async function receipt(url: string, hash: string): Promise<Receipt | null> {
  const r = await evmReceipt(url, hash);
  return r ? { ok: r.status === "success", block: r.block, to: r.to } : null;
}

export async function balance(url: string, address: string): Promise<bigint> {
  return BigInt(await rpc<string>(url, "eth_getBalance", [address, "latest"]));
}
