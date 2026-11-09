// Stand-ins for the run scripts' preflight tests (seam T): a local JSON-RPC server that answers
// as NEAR RPC or an EVM chain from a test's own script and logs every request, and a runner that
// starts a script as a process and reads its last JSON line.
import { spawn } from "node:child_process";
import { createServer } from "node:http";

/** One request a stand-in got: where (`near` or `chain <id>`), the method, and what it asked for. */
export interface Logged {
  where: string;
  method: string;
  detail?: string;
}

/** A JSON-RPC error a route answers with. */
export class RpcError {
  readonly message: string;
  constructor(message: string) {
    this.message = message;
  }
}

/** What a route answers: a result, an RpcError, or undefined for "not scripted". */
export type Route = (where: string, method: string, params: any) => unknown;

/** Answers `{"result": [...bytes]}` as NEAR's `call_function` does, for a view returning `value`. */
/**
 * NEAR's pricing as mainnet's `EXPERIMENTAL_protocol_config` and `gas_price` reported it on Nov 8
 * (testnet's is the same): what a stand-in NEAR RPC answers so a pre-spend check can price a
 * transaction's gas in hand (#57).
 */
export const NEAR_PROTOCOL_CONFIG = {
  runtime_config: {
    min_gas_purchase_price: "1000000000",
    storage_amount_per_byte: "10000000000000000000",
    transaction_costs: {
      action_receipt_creation_config: { send_not_sir: 108059500000, send_sir: 108059500000, execution: 108059500000 },
      action_creation_config: {
        function_call_cost: { send_not_sir: 200000000000, send_sir: 200000000000, execution: 780000000000 },
        function_call_cost_per_byte: { send_not_sir: 47683715, send_sir: 2235934, execution: 2235934 },
      },
    },
  },
};
export const NEAR_GAS_PRICE = { gas_price: "100000000" };

export const nearView = (value: unknown) => ({ result: [...Buffer.from(JSON.stringify(value))], logs: [] });

/** Nothing signed went to NEAR or a chain. */
export const sendsAmong = (requests: Logged[]) => requests.filter((r) => /send|broadcast_tx/i.test(r.method));

/**
 * A local JSON-RPC server: `<base>/near` answers as NEAR RPC, `<base>/<chain id>` as that EVM
 * chain (batches too), each from `route`; every request is logged in `requests`.
 */
export async function standIns(route: Route): Promise<{ base: string; requests: Logged[]; close: () => void }> {
  const requests: Logged[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const where = req.url === "/near" ? "near" : `chain ${req.url!.slice(1)}`;
      const answer = (call: any) => {
        const p = call.params;
        const detail =
          where === "near"
            ? (p?.method_name ?? p?.request_type)
            : call.method === "eth_call"
              ? String(p[0].to).toLowerCase()
              : call.method === "eth_getProof"
                ? `${String(p[0]).toLowerCase()} ${p[1].length}`
                : undefined;
        requests.push({ where, method: call.method, detail });
        const result = route(where, call.method, p);
        if (result === undefined) return { jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "not scripted" } };
        if (result instanceof RpcError) return { jsonrpc: "2.0", id: call.id, error: { code: -32000, message: result.message } };
        return { jsonrpc: "2.0", id: call.id, result };
      };
      res.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(answer) : answer(parsed)));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests, close: () => server.close() };
}

/** Run a script as a process with `env` on top of this one's, and read the last JSON line it printed. */
export async function runScript(script: string, env: Record<string, string>): Promise<{ status: number | null; out: any; stderr: string }> {
  // Asynchronously: the stand-ins answer from this same process.
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const status = await new Promise<number | null>((ok) => child.on("close", ok));
  return { status, out: JSON.parse(stdout.trim().split("\n").pop() || "{}"), stderr };
}
