// Test stand-in for every network the command-line tool reaches (seam T, ticket #43): loaded
// with `node --import`, it replaces `fetch`, records each request's URL in $BOUNTEE_FETCH_LOG
// (one line each) and answers it with a JSON-RPC error, so a command reads nothing and sends
// nothing anywhere. Lives only in the test folder.
import { appendFileSync } from "node:fs";

globalThis.fetch = async (input) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  appendFileSync(process.env.BOUNTEE_FETCH_LOG, `${url}\n`);
  const error = { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "test stand-in: nothing is sent" } };
  return new Response(JSON.stringify(error), { status: 200, headers: { "content-type": "application/json" } });
};
