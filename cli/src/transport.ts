// Every request the tool makes goes through `fetch`: its own JSON-RPC calls, near-api-js's
// and OutLayer's API. A request that fails below HTTP (a reset connection, a timeout, a DNS
// miss) is sent again, the same bytes, with a doubling wait. On Nov 10 one dropped connection
// while `claim` followed a claim it had already filed ended the command with "fetch failed",
// before it showed the claim's ID; an agent told only that would likely file again (#35).
//
// Sending the same bytes again is safe for what the tool sends: views and status reads; a NEAR
// transaction already signed (same hash, so the network keeps one); a signed pause, where
// "already known" counts as sent (broadcast.ts); and OutLayer's sealing, which stores nothing.

/** The errors Node's fetch gives for a request that got no HTTP answer. */
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_CLOSED",
]);

/** Whether `e`, thrown by fetch, means no HTTP answer came back. */
export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof TypeError)) return false;
  const cause = (e as { cause?: { code?: string } }).cause;
  return cause?.code === undefined ? e.message === "fetch failed" : NETWORK_CODES.has(cause.code);
}

/** `e`'s message with its cause, which Node's "fetch failed" otherwise hides. */
export function describeError(e: unknown): string {
  const err = e as { message?: string; cause?: { code?: string; message?: string } };
  const message = err?.message ?? String(e);
  const cause = err?.cause;
  if (!cause) return message;
  const detail = [cause.code, cause.message].filter(Boolean).join(": ");
  return detail && !message.includes(detail) ? `${message} (${detail})` : message;
}

/**
 * Make the global `fetch` send a request again when it gets no HTTP answer: `tries` times in
 * all, waiting `backoffMs`, then twice that, and so on (about a minute at the defaults). Call
 * once, before any request.
 */
export function retryNetworkErrors(o: { tries?: number; backoffMs?: number } = {}): void {
  const tries = o.tries ?? 7;
  const backoffMs = o.backoffMs ?? 1000;
  const send = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await send(input, init);
      } catch (e) {
        if (!isNetworkError(e) || attempt >= tries) throw e;
        await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
      }
    }
  };
}
