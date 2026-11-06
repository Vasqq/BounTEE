"use client";
// "Send pause" (R7.9): sends a stored signed pause to its chain from this browser, through a
// viem client on the chain's public RPC, with no wallet. The pause is already signed by NEAR's
// MPC network, so whoever sends it can't change it. Sending twice is harmless: the chain
// knows it already.
import { useMutation } from "@tanstack/react-query";
import { createPublicClient, http, type Hex } from "viem";

/** Errors meaning the same transaction is already pending or mined (as `bountee broadcast` reads them). */
const ALREADY = /already known|known transaction|nonce too low|already imported|AlreadyKnown/i;

async function send(rpc: string, pauses: { raw: string; hash: string }[]) {
  const client = createPublicClient({ transport: http(rpc) });
  // In nonce order: each pause-role address sends its pauses one after another.
  for (const p of pauses) {
    try {
      const hash = await client.sendRawTransaction({ serializedTransaction: p.raw as Hex });
      if (hash.toLowerCase() !== p.hash.toLowerCase()) throw new Error(`the chain hashed it as ${hash}`);
    } catch (e) {
      const err = e as { details?: string; shortMessage?: string; message: string };
      if (ALREADY.test(`${err.details ?? ""} ${err.message}`)) continue;
      throw new Error(err.details ?? err.shortMessage ?? err.message);
    }
  }
}

export function SendPause({ chain, rpc, pauses, onSent }: { chain: string; rpc: string; pauses: { raw: string; hash: string }[]; onSent: () => void }) {
  const m = useMutation({ mutationFn: () => send(rpc, pauses), onSuccess: onSent });
  return (
    <div className="send">
      <button type="button" className="btn btn-ink" onClick={() => m.mutate()} disabled={m.isPending}>
        {m.isPending ? "Sending" : "Send pause"}
      </button>
      <p role={m.isError ? "alert" : undefined}>
        {m.isError ? `${chain} didn't take it: ${m.error.message}` : "Signed by NEAR's MPC network. Anyone can send it; no wallet needed."}
      </p>
    </div>
  );
}
