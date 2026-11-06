"use client";
// "Send pause" (R7.9): sends a stored signed pause to its chain from this browser, straight to
// the chain's public RPC, with no wallet. The pause is already signed by NEAR's MPC network,
// so whoever sends it can't change it. Sending twice is harmless: the chain knows it already.
import { useState } from "react";

/** Errors meaning the same transaction is already pending or mined (as `bountee broadcast` reads them). */
const ALREADY = /already known|known transaction|nonce too low|already imported|AlreadyKnown/i;

export async function sendRaw(rpc: string, raw: string, hash: string): Promise<void> {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] }) });
  const body = (await res.json()) as { result?: string; error?: { message?: string } };
  if (body.error) {
    if (ALREADY.test(body.error.message ?? "")) return;
    throw new Error(body.error.message ?? "the chain refused it");
  }
  if (body.result?.toLowerCase() !== hash.toLowerCase()) throw new Error(`the chain hashed it as ${body.result}`);
}

export function SendPause({ chain, rpc, pauses, onSent }: { chain: string; rpc: string; pauses: { raw: string; hash: string }[]; onSent: () => void }) {
  const [state, setState] = useState<"idle" | "sending" | "failed">("idle");
  const [error, setError] = useState("");
  const send = async () => {
    setState("sending");
    try {
      // In nonce order: each pause-role address sends its pauses one after another.
      for (const p of pauses) await sendRaw(rpc, p.raw, p.hash);
      onSent();
    } catch (e) {
      setError((e as Error).message);
      setState("failed");
    }
  };
  return (
    <div className="send">
      <button type="button" className="btn btn-ink" onClick={send} disabled={state === "sending"}>
        {state === "sending" ? "Sending" : "Send pause"}
      </button>
      <p>{state === "failed" ? `${chain} didn't take it: ${error}` : `Signed by NEAR's MPC network. Anyone can send it; no wallet needed.`}</p>
    </div>
  );
}
