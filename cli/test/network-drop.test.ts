// D23, R14.6 (#35): a dropped connection doesn't end a command. On Nov 10 one request with no
// HTTP answer ended `claim` with "fetch failed" after the claim was filed, before its ID showed.
//
// Seam T: the tool run from the terminal against a local NEAR RPC that drops connections
// without answering. It catches that the tool sends the same JSON-RPC call again and finishes.
// It misses which real network faults happen, and how often.
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

let server: Server | undefined;
afterEach(() => server?.close());

/** A NEAR RPC that drops the first `drops` connections, then answers every view with `"5"`. */
async function droppingRpc(drops: number): Promise<{ url: string; seen: () => number }> {
  let seen = 0;
  server = createServer((req, res) => {
    seen++;
    if (seen <= drops) {
      req.socket.destroy();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id } = JSON.parse(body);
      const result = { result: [...Buffer.from('"5"')], logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    });
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, seen: () => seen };
}

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args], { env: { ...process.env, NODE_USE_ENV_PROXY: "" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("D23 R14.6: a NEAR call whose connection drops twice is sent again and the command finishes", async () => {
  const rpc = await droppingRpc(2);
  const r = await run(["balance", "--as", "alice.testnet", "--contract", "bounty.testnet", "--network", "testnet", "--near-rpc", rpc.url, "--json"]);
  expect(r.code, r.stderr).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ account: "alice.testnet", balance: "5" });
  expect(rpc.seen()).toBe(3);
}, 30_000);
