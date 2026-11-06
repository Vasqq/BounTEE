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
//   Ticket #35's prep adds: the run ADR-0018 makes (2 claims, the cheat and the win; a 1-day
//   disclosure delay, so the exploit is published by Nov 11) as the defaults the preflight
//   reports and checks the Whitehat against, and a delay outside R1.4's 1-90 days refused
//   before anything is read.
//   Misses: the real mainnet balances and gas prices (read when #35 runs it), and every step
//   after the preflight (each spends; rehearsed on testnet, #33).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";
import { RpcError, nearView, runScript, sendsAmong, standIns, type Logged } from "./testnet/stand-ins.ts";

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

/** The scripted world: balances by holder. */
const world = {
  near: new Map<string, bigint>(),
  nearUsdc: new Map<string, bigint>(),
  eth: new Map<number, bigint>(),
  evmUsdc: new Map<string, bigint>(),
};

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

let stands: Awaited<ReturnType<typeof standIns>>;
let requests: Logged[] = [];

beforeAll(async () => {
  stands = await standIns((where, method, p) => {
    if (where === "near") {
      if (method === "query" && p.request_type === "view_account") {
        const amount = world.near.get(p.account_id);
        return amount === undefined ? new RpcError("UNKNOWN_ACCOUNT") : { amount: amount.toString() };
      }
      if (method === "query" && p.request_type === "call_function") {
        const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString() || "{}");
        if (p.account_id === CONTRACT && p.method_name === "fees") return nearView({ posting_fee: POSTING_FEE.toString() });
        if (p.account_id === NEAR_USDC && p.method_name === "ft_balance_of") return nearView((world.nearUsdc.get(args.account_id) ?? 0n).toString());
      }
      return undefined;
    }
    const chain = Number(where.slice("chain ".length));
    if (method === "eth_chainId") return `0x${chain.toString(16)}`;
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_gasPrice") return "0x989680"; // 0.01 gwei
    if (method === "eth_getTransactionCount") return "0x0"; // cast call's default sender
    if (method === "eth_getBalance") return `0x${(world.eth.get(chain) ?? 0n).toString(16)}`;
    if (method === "eth_call") return word(world.evmUsdc.get(String(p[0].to).toLowerCase()) ?? 0n);
    return undefined;
  });
});

afterAll(() => stands.close());

async function preflight(extraEnv: Record<string, string> = {}): Promise<{ status: number | null; out: any; stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), "bountee-preflight-"));
  writeFileSync(join(dir, "deployment.json"), JSON.stringify({ network: "mainnet", contract: CONTRACT, usdc: NEAR_USDC }));
  writeFileSync(join(dir, "deployer.env"), `DEPLOYER_ADDRESS=${DEPLOYER}\nDEPLOYER_PRIVATE_KEY=${DEPLOYER_KEY}\n`);
  stands.requests.length = 0;
  requests = stands.requests;
  return runScript(script, {
    HOME: dir,
    NETWORK: "mainnet",
    BOUNTEE_DAY3: join(dir, "deployment.json"),
    DEPLOYER_ENV: join(dir, "deployer.env"),
    PROTOCOL,
    WHITEHAT,
    NEAR_RPC: `${stands.base}/near`,
    CHAIN_RPCS: `8453=${stands.base}/8453,42161=${stands.base}/42161`,
    PREFLIGHT_ONLY: "1",
    ...extraEnv,
  });
}

/** No request could have spent: nothing signed went to NEAR or to a chain. */
function expectNothingSent() {
  expect(sendsAmong(requests)).toEqual([]);
}

/** D21: with everything empty, the preflight names every balance and its top-up, exits 3, and sends nothing. */
test("D21: the mainnet preflight lists every balance the run needs and names each top-up", async () => {
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
  const evmCalls = requests.filter((q) => q.method === "eth_call").map((q) => `${q.where} ${q.detail}`);
  expect(evmCalls).toEqual([`chain 8453 ${BASE_USDC}`, `chain 42161 ${ARBITRUM_USDC}`]);
  expectNothingSent();
});

/** D21: with every balance there, the preflight passes and still sends nothing (PREFLIGHT_ONLY). */
test("D21: a funded mainnet run passes the preflight and spends nothing", async () => {
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

/** D21, ADR-0018: with no settings, the preflight plans ADR-0018's run: two claims (the cheat and the win) and a 1-day disclosure delay. */
test("D21, R1.4: by default the mainnet preflight plans ADR-0018's run: 2 claims and a 1-day disclosure delay", async () => {
  world.near.clear();
  const r = await preflight();
  expect(r.out.run).toEqual({ claims: 2, disclosure_delay_days: 1 });
  const whitehat = r.out.balances.find((b: any) => b.who === WHITEHAT);
  expect(whitehat.need).toBe("2.2 NEAR");
  expectNothingSent();
});

/** R1.4: the delay is a setting, and one outside 1-90 days stops the script before it reads or sends anything. */
test("R1.4: DISCLOSURE_DELAY_DAYS sets the delay; outside 1-90 days it is refused before anything is read", async () => {
  const set = await preflight({ DISCLOSURE_DELAY_DAYS: "7", CLAIMS: "3" });
  expect(set.out.run).toEqual({ claims: 3, disclosure_delay_days: 7 });
  for (const bad of ["0", "91", "1.5", "x"]) {
    const r = await preflight({ DISCLOSURE_DELAY_DAYS: bad });
    expect(r.status, bad).not.toBe(0);
    expect(r.status, bad).not.toBe(3);
    expect(r.stderr, bad).toMatch(/DISCLOSURE_DELAY_DAYS/);
    expect(requests, bad).toEqual([]);
  }
});
