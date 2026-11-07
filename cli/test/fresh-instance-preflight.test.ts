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
//   before anything is read. The Whitehat's budget comes from each claim's input on the proof
//   chain (the stand-in chain answers proofs of a set node size): which accounts and slots each
//   claim proves, OutLayer's hold from fees(), and the peak with holds refunded between claims.
//   The real sizes are a recorded analysis: run against Base mainnet the cheat budgets 289 KB,
//   matching the ~289 KB a real cheat replay proved (ticket #35's prep notes).
//   Misses: the real mainnet balances and gas prices (read when #35 runs it), and every step
//   after the preflight (each spends; rehearsed on testnet, #33).
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
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
// The contract's fees() (contract/src/lib.rs `fees`), as deployed.
const FEES = {
  posting_fee: POSTING_FEE.toString(), job_deposit: (YOCTO / 50n).toString(), job_input_free_bytes: 32 * 1024,
  storage_price_per_byte: (10n ** 19n).toString(), secret_row_overhead_bytes: 1024,
};
// Uniswap V2 on Base, as HonestUser.s.sol buys through it, and Circle's USDC behind its proxy.
const ROUTER = "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24";
const FACTORY = "0x8909dc15e40173ff4699343b6eb8132c65e18ec6";
const WETH = "0x4200000000000000000000000000000000000006";
const PAIR = "0x88a43bbdf9d098eec7bceda4e2494615dfd9bb9c";
const USDC_IMPL = "0x2ce6311ddae708829bc0784c967b7d77d19fd779";
const COINBASE = "0x4200000000000000000000000000000000000011";
const IMPL_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";
const CONTRACTS = new Set([ROUTER, FACTORY, WETH, PAIR, USDC_IMPL, COINBASE, BASE_USDC]);
const RAW_HEADER = `0x${"cd".repeat(600)}`;
const HEADER_HASH = `0x${Buffer.from(keccak_256(Buffer.from(RAW_HEADER.slice(2), "hex"))).toString("hex")}`;

/** The scripted world: balances by holder. */
const world = {
  /** Bytes per trie node in the stand-in chain's proofs: a deeper, wider trie gives bigger proofs. */
  node: 500,
  near: new Map<string, bigint>(),
  nearUsdc: new Map<string, bigint>(),
  eth: new Map<number, bigint>(),
  evmUsdc: new Map<string, bigint>(),
};

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

// Each preflight runs the script, which compiles the demo contracts to size the claims' code
// (forge inspect): seconds each, more while other suites build.
vi.setConfig({ testTimeout: 180_000 });

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
        if (p.account_id === CONTRACT && p.method_name === "fees") return nearView(FEES);
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
    if (method === "eth_call") {
      const to = String(p[0].to).toLowerCase();
      const selector = String(p[0].data ?? p[0].input).slice(0, 10);
      if (to === ROUTER && selector === "0xad5c4648") return word(BigInt(WETH)); // WETH()
      if (to === ROUTER && selector === "0xc45a0155") return word(BigInt(FACTORY)); // factory()
      if (to === FACTORY && selector === "0xe6a43905") return word(BigInt(PAIR)); // getPair(address,address)
      return word(world.evmUsdc.get(to) ?? 0n);
    }
    if (method === "eth_getStorageAt" && String(p[0]).toLowerCase() === BASE_USDC && p[1] === IMPL_SLOT) return word(BigInt(USDC_IMPL));
    if (method === "eth_getBlockByNumber") return { number: "0x10", hash: HEADER_HASH, miner: COINBASE };
    if (method === "debug_getRawHeader") return RAW_HEADER;
    if (method === "eth_getProof") {
      // Eight nodes for an account, six per slot; an account the stand-in doesn't know is absent.
      const known = CONTRACTS.has(String(p[0]).toLowerCase());
      const nodes = (n: number) => Array.from({ length: n }, () => `0x${"ab".repeat(world.node)}`);
      return {
        address: p[0], nonce: known ? "0x1" : "0x0", balance: "0x0", codeHash: known ? `0x${"11".repeat(32)}` : `0x${"00".repeat(32)}`,
        storageHash: `0x${"22".repeat(32)}`, accountProof: nodes(8),
        storageProof: (p[1] as string[]).map((key) => ({ key, value: "0x1", proof: nodes(6) })),
      };
    }
    if (method === "eth_getCode") return `0x${"60".repeat(4000)}`;
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
    [WHITEHAT, "near-mainnet", "NEAR", expect.stringMatching(/ NEAR$/), false],
  ]);
  expect(r.out.top_up).toHaveLength(7);
  // Read on the mainnet chains and Circle's USDC, nowhere else.
  const evmCalls = requests.filter((q) => q.method === "eth_call").map((q) => `${q.where} ${q.detail}`);
  expect(evmCalls).toEqual([
    `chain 8453 ${BASE_USDC}`, `chain 42161 ${ARBITRUM_USDC}`,
    // The claims' budget reads Base, the proof chain: Uniswap V2, where the cheat buys its USDC.
    `chain 8453 ${ROUTER}`, `chain 8453 ${ROUTER}`, `chain 8453 ${FACTORY}`,
  ]);
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
  expect(r.out.run).toMatchObject({ claims: 2, disclosure_delay_days: 1 });
  expect(r.out.run.claim_budget.map((c: any) => c.kind)).toEqual(["cheat", "win"]);
  expectNothingSent();
});

const near = (text: string) => BigInt(Math.round(Number(text.replace(/ NEAR$/, "") ) * 1e5)) * 10n ** 19n;

/** D21: each claim is budgeted from the proofs it will carry on the proof chain, held by OutLayer above the free bytes. */
test("D21: the Whitehat's budget follows each claim's input on the proof chain: the largest draw plus what the rest keep", async () => {
  world.near.clear();
  world.node = 500;
  const r = await preflight();
  const [cheat, win] = r.out.run.claim_budget;
  // The cheat proves the accounts its purchase reads, on Base: the router, pair, WETH, and
  // Circle's USDC and its implementation; the win reads none of Uniswap's.
  const proved = requests.filter((q) => q.method === "eth_getProof").map((q) => `${q.where} ${q.detail}`);
  for (const [address, slots] of [[ROUTER, 0], [PAIR, 6], [WETH, 2], [BASE_USDC, 8], [USDC_IMPL, 0], [BASE_USDC, 4], [COINBASE, 0]] as const) {
    expect(proved).toContain(`chain 8453 ${address} ${slots}`);
  }
  expect(proved.every((q) => q.startsWith("chain 8453 "))).toBe(true);
  expect(cheat.input_bytes).toBeGreaterThan(win.input_bytes);
  // OutLayer holds the storage price for every input byte above the free 32 KiB (fees()).
  for (const c of [cheat, win]) expect(near(c.refunded)).toBe(BigInt(c.input_bytes - 32 * 1024) * 10n ** 19n);
  // The claims run one at a time and each hold comes back: the cheat's whole draw, and the win's draw less its hold.
  const whitehat = r.out.balances.find((b: any) => b.who === WHITEHAT);
  expect(near(whitehat.need)).toBe(near(cheat.draw) + near(win.draw) - near(win.refunded));
  // A deeper trie on the proof chain makes bigger proofs, and the budget grows with them.
  world.node = 1000;
  const deeper = await preflight();
  expect(deeper.out.run.claim_budget[0].input_bytes).toBeGreaterThan(cheat.input_bytes + 50_000);
  expect(near(deeper.out.balances.find((b: any) => b.who === WHITEHAT).need)).toBeGreaterThan(near(whitehat.need));
  world.node = 500;
  expectNothingSent();
});

/** R1.4: the delay is a setting, and one outside 1-90 days stops the script before it reads or sends anything. */
test("R1.4: DISCLOSURE_DELAY_DAYS sets the delay; outside 1-90 days it is refused before anything is read", async () => {
  const set = await preflight({ DISCLOSURE_DELAY_DAYS: "7", CLAIMS: "3" });
  expect(set.out.run).toMatchObject({ claims: 3, disclosure_delay_days: 7 });
  expect(set.out.run.claim_budget.map((c: any) => c.kind)).toEqual(["cheat", "win", "win"]);
  for (const bad of ["0", "91", "1.5", "x"]) {
    const r = await preflight({ DISCLOSURE_DELAY_DAYS: bad });
    expect(r.status, bad).not.toBe(0);
    expect(r.status, bad).not.toBe(3);
    expect(r.stderr, bad).toMatch(/DISCLOSURE_DELAY_DAYS/);
    expect(requests, bad).toEqual([]);
  }
});
