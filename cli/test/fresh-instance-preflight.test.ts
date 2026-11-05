// Seam T, ticket #43: the fresh-instance script's preflight on mainnet lists every balance the
// run needs, names what to top up, and spends nothing (D21; spec, Testing Decisions).
//
// Seams (written before the first test): T, `testnet/fresh-instance.ts` run as a process with
// NETWORK=mainnet, its NEAR RPC and its chains' RPCs pointed at local stand-ins (a NEAR RPC
// and an EVM RPC, the latter reached through `cast`) that hold scripted balances and record
// every request.
//   Catches: the preflight reading Base and Arbitrum One and Circle's USDC (on each chain and
//   on NEAR) rather than a testnet chain or the mock; one line per balance the run needs
//   (the deployer's ETH and USDC on each chain, the Protocol's NEAR and USDC, the Whitehat's
//   NEAR) with ADR-0018's amounts; exit status 3 naming each top-up when any is short; and
//   that no request sends anything.
//   Misses: the real mainnet balances and gas prices (read when #35 runs it), and every step
//   after the preflight (each spends; rehearsed on testnet, #33).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const script = fileURLToPath(new URL("./testnet/fresh-instance.ts", import.meta.url));
const CONTRACT = "bounty.bountee.near";
const NEAR_USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ARBITRUM_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const PROTOCOL = "protocol.near";
const WHITEHAT = "whitehat.near";
// A made-up deployer: the preflight only reads its balances, and never signs with the key.
const DEPLOYER = "0x00000000000000000000000000000000000000d1";
const DEPLOYER_KEY = `0x${"11".repeat(32)}`;
const YOCTO = 10n ** 24n;
const ETH = 10n ** 18n;
const POSTING_FEE = YOCTO / 2n;

/** The scripted world: balances by holder, and every request either stand-in got. */
const world = {
  near: new Map<string, bigint>(),
  nearUsdc: new Map<string, bigint>(),
  eth: new Map<number, bigint>(),
  evmUsdc: new Map<string, bigint>(),
  requests: [] as { where: string; method: string; detail?: string }[],
};

let server: Server;
let base = "";

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const call = JSON.parse(body);
      const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
      const fail = () => res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { code: -32601, message: "not scripted" } }));
      if (req.url === "/near") {
        const p = call.params;
        world.requests.push({ where: "near", method: call.method, detail: p?.method_name ?? p?.request_type });
        if (call.method === "query" && p.request_type === "view_account") {
          const amount = world.near.get(p.account_id);
          return amount === undefined ? res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, error: { message: "UNKNOWN_ACCOUNT" } })) : reply({ amount: amount.toString() });
        }
        if (call.method === "query" && p.request_type === "call_function") {
          const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString() || "{}");
          const view =
            p.account_id === CONTRACT && p.method_name === "fees"
              ? { posting_fee: POSTING_FEE.toString() }
              : p.account_id === NEAR_USDC && p.method_name === "ft_balance_of"
                ? (world.nearUsdc.get(args.account_id) ?? 0n).toString()
                : undefined;
          return view === undefined ? fail() : reply({ result: [...Buffer.from(JSON.stringify(view))], logs: [] });
        }
        return fail();
      }
      const chain = Number(req.url!.slice(1));
      const calls = Array.isArray(call) ? call : [call];
      const answers = calls.map((c) => {
        world.requests.push({ where: `chain ${chain}`, method: c.method, detail: c.method === "eth_call" ? String(c.params[0].to).toLowerCase() : undefined });
        const ok = (result: unknown) => ({ jsonrpc: "2.0", id: c.id, result });
        if (c.method === "eth_chainId") return ok(`0x${chain.toString(16)}`);
        if (c.method === "eth_blockNumber") return ok("0x10");
        if (c.method === "eth_gasPrice") return ok("0x989680"); // 0.01 gwei
        if (c.method === "eth_getTransactionCount") return ok("0x0"); // cast call's default sender
        if (c.method === "eth_getBalance") return ok(`0x${(world.eth.get(chain) ?? 0n).toString(16)}`);
        if (c.method === "eth_call") return ok(word(world.evmUsdc.get(String(c.params[0].to).toLowerCase()) ?? 0n));
        return { jsonrpc: "2.0", id: c.id, error: { code: -32601, message: "not scripted" } };
      });
      res.end(JSON.stringify(Array.isArray(call) ? answers : answers[0]));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(() => server.close());

async function preflight(): Promise<{ status: number | null; out: any; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "bountee-preflight-"));
  writeFileSync(join(dir, "deployment.json"), JSON.stringify({ network: "mainnet", contract: CONTRACT, usdc: NEAR_USDC }));
  writeFileSync(join(dir, "deployer.env"), `DEPLOYER_ADDRESS=${DEPLOYER}\nDEPLOYER_PRIVATE_KEY=${DEPLOYER_KEY}\n`);
  world.requests = [];
  // Run asynchronously: the stand-ins answer from this same process.
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      HOME: dir,
      NETWORK: "mainnet",
      BOUNTEE_DAY3: join(dir, "deployment.json"),
      DEPLOYER_ENV: join(dir, "deployer.env"),
      PROTOCOL,
      WHITEHAT,
      CLAIMS: "2",
      NEAR_RPC: `${base}/near`,
      CHAIN_RPCS: `8453=${base}/8453,42161=${base}/42161`,
      PREFLIGHT_ONLY: "1",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  const status = await new Promise<number | null>((ok) => child.on("close", ok));
  return { status, out: JSON.parse(stdout.trim().split("\n").pop() || "{}"), stderr };
}

/** No request could have spent: nothing signed went to NEAR or to a chain. */
function expectNothingSent() {
  const sends = world.requests.filter((r) => /send|broadcast_tx/i.test(r.method));
  expect(sends).toEqual([]);
}

/** D21: with everything empty, the preflight names every balance and its top-up, exits 3, and sends nothing. */
test("d21 the mainnet preflight lists every balance the run needs and names each top-up", async () => {
  world.near.clear();
  world.nearUsdc.clear();
  world.eth.clear();
  world.evmUsdc.clear();
  const r = await preflight();
  expect(r.status, r.stderr).toBe(3);
  const rows = r.out.balances.map((b: any) => [b.who, b.chain, b.asset, b.need, b.ok]);
  expect(rows).toEqual([
    [DEPLOYER, "Base", "ETH", expect.stringMatching(/ETH$/), false],
    [DEPLOYER, "Base", `USDC (${BASE_USDC})`, "2 USDC", false],
    [DEPLOYER, "Arbitrum One", "ETH", expect.stringMatching(/ETH$/), false],
    [DEPLOYER, "Arbitrum One", `USDC (${ARBITRUM_USDC})`, "1 USDC", false],
    [PROTOCOL, "near-mainnet", "NEAR", "0.6 NEAR", false],
    [PROTOCOL, "near-mainnet", `USDC (${NEAR_USDC})`, "10 USDC", false],
    [WHITEHAT, "near-mainnet", "NEAR", "2.2 NEAR", false],
  ]);
  expect(r.out.top_up).toHaveLength(7);
  // Read on the mainnet chains and Circle's USDC, nowhere else.
  const evmCalls = world.requests.filter((q) => q.method === "eth_call").map((q) => `${q.where} ${q.detail}`);
  expect(evmCalls).toEqual([`chain 8453 ${BASE_USDC}`, `chain 42161 ${ARBITRUM_USDC}`]);
  expectNothingSent();
});

/** D21: with every balance there, the preflight passes and still sends nothing (PREFLIGHT_ONLY). */
test("d21 a funded mainnet run passes the preflight and spends nothing", async () => {
  for (const who of [PROTOCOL, WHITEHAT]) world.near.set(who, 5n * YOCTO);
  world.nearUsdc.set(PROTOCOL, 10_000_000n);
  for (const chain of [8453, 42161]) world.eth.set(chain, ETH / 100n);
  world.evmUsdc.set(BASE_USDC, 2_000_000n);
  world.evmUsdc.set(ARBITRUM_USDC, 1_000_000n);
  const r = await preflight();
  expect(r.status, r.stderr).toBe(0);
  expect(r.out.ok).toBe(true);
  expect(r.out.balances.every((b: any) => b.ok)).toBe(true);
  expectNothingSent();
});
