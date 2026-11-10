// Seam T, ticket #75: the testnet site's seed script checks every balance its six bounties need
// before it spends anything, names each top-up, and exits 3 when any is short (D33; spec #71,
// "the seed script stops before spending anything and names what to top up").
//
// Seams (written before the first test): T, `testnet/site-seed.ts` run as a process with its NEAR
// RPC and both Sepolia chains' RPCs pointed at local stand-ins (stand-ins.ts) that hold scripted
// balances and record every request.
//   Catches: the seed adding up what its six fresh-instance runs need (D21's preflight, run once
//   per bounty): the deployer's ETH on Base Sepolia and on Arbitrum Sepolia for six instances;
//   the funder's Circle testnet USDC for the six bounty amounts (about 12 USDC, less what a
//   Protocol already holds) and its NEAR for registering each Protocol on the USDC; an existing
//   Protocol's or Whitehat's NEAR; a Protocol not yet created counted as funded by NEAR's faucet
//   (`bountee init`); exit status 3 naming every short balance; that nothing is sent and no
//   account is created before the check passes.
//   Misses: the real testnet balances and gas prices (read by the live preflight, recorded on
//   #75), the faucet's real grant, and every step after the preflight (each spends; the seed's
//   recorded run, method A).
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { NEAR_GAS_PRICE, NEAR_PROTOCOL_CONFIG, RpcError, nearView, runScript, sendsAmong, standIns, type Logged } from "./testnet/stand-ins.ts";

const seed = fileURLToPath(new URL("./testnet/site-seed.ts", import.meta.url));
const freshInstance = fileURLToPath(new URL("./testnet/fresh-instance.ts", import.meta.url));
const CONTRACT = "bounty.bountee.testnet";
// Circle's USDC on NEAR testnet (spec #71, read Nov 10).
const USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const FUNDER = "bountee.testnet";
const WHITEHAT = "quellford-sec.testnet";
// The six fictional Protocols spec #71 names.
const PROTOCOLS = ["brassmoor-lend", "tallowfen-swap", "corvane-perps", "lindquay-vaults", "osterwick-dex", "pellmar-stable"].map((p) => `${p}.testnet`);
// A made-up deployer: the preflight only reads its balances, and never signs with the key.
const DEPLOYER = "0x00000000000000000000000000000000000000d1";
const DEPLOYER_KEY = `0x${"11".repeat(32)}`;
const YOCTO = 10n ** 24n;
const ETH = 10n ** 18n;
const TGAS = 10n ** 12n;
// The contract's fees() (contract/src/lib.rs `fees`), with its gas minimums.
const FEES = {
  posting_fee: (YOCTO / 2n).toString(), job_deposit: (YOCTO / 50n).toString(), job_input_free_bytes: 32 * 1024,
  storage_price_per_byte: (10n ** 19n).toString(), secret_row_overhead_bytes: 1024,
  min_withdraw_bounty_gas: (100n * TGAS).toString(), min_sign_pauses_gas_base: (50n * TGAS).toString(),
  min_sign_pauses_gas_per_contract: (50n * TGAS).toString(), min_verify_pause_gas_base: (50n * TGAS).toString(),
  min_verify_pause_gas_per_pause: (50n * TGAS).toString(),
};
// NEP-145's storage_balance_bounds on Circle's USDC: 0.00125 NEAR to register an account.
const STORAGE_MIN = 1_250_000_000_000_000_000_000n;
const COINBASE = "0x4200000000000000000000000000000000000011";
const ARBITRUM_COINBASE = "0xa4b000000000000000000073657175656e636572";
const RAW_HEADER = `0x${"cd".repeat(600)}`;
const HEADER_HASH = `0x${Buffer.from(keccak_256(Buffer.from(RAW_HEADER.slice(2), "hex"))).toString("hex")}`;

/** The scripted world: balances by holder. */
const world = {
  near: new Map<string, bigint>(),
  usdc: new Map<string, bigint>(),
  registered: new Set<string>(),
  eth: new Map<number, bigint>(),
};

const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;

// Each seed preflight runs D21's preflight six times, each compiling the demo contracts.
vi.setConfig({ testTimeout: 900_000 });

let stands: Awaited<ReturnType<typeof standIns>>;
let requests: Logged[] = [];

beforeAll(async () => {
  stands = await standIns((where, method, p) => {
    if (where === "near") {
      if (method === "query" && p.request_type === "view_account") {
        const amount = world.near.get(p.account_id);
        return amount === undefined ? new RpcError(`UNKNOWN_ACCOUNT: ${p.account_id} does not exist`) : { amount: amount.toString(), locked: "0", storage_usage: 182 };
      }
      if (method === "EXPERIMENTAL_protocol_config") return NEAR_PROTOCOL_CONFIG;
      if (method === "gas_price") return NEAR_GAS_PRICE;
      if (method === "query" && p.request_type === "call_function") {
        const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString() || "{}");
        if (p.account_id === CONTRACT) {
          if (p.method_name === "fees") return nearView(FEES);
          if (p.method_name === "config") return nearView({ seed: { native: "1000000000000000000", tokens: [] }, judge_build_hash: `0x${"d6".repeat(32)}`, usdc: USDC });
          if (p.method_name === "posting_fee_balance") return nearView("0");
          if (p.method_name === "bounty") return nearView(null);
        }
        if (p.account_id === USDC) {
          if (p.method_name === "ft_balance_of") return nearView((world.usdc.get(args.account_id) ?? 0n).toString());
          if (p.method_name === "storage_balance_bounds") return nearView({ min: STORAGE_MIN.toString(), max: STORAGE_MIN.toString() });
          if (p.method_name === "storage_balance_of") {
            return nearView(world.registered.has(args.account_id) ? { total: STORAGE_MIN.toString(), available: "0" } : null);
          }
        }
      }
      return undefined;
    }
    const chain = Number(where.slice("chain ".length));
    if (method === "eth_chainId") return `0x${chain.toString(16)}`;
    if (method === "eth_blockNumber") return "0x10";
    if (method === "eth_gasPrice") return "0x989680"; // 0.01 gwei
    if (method === "eth_getTransactionCount") return "0x0";
    if (method === "eth_getBalance") return `0x${(world.eth.get(chain) ?? 0n).toString(16)}`;
    if (method === "eth_call") return word(0n);
    if (method === "eth_getBlockByNumber") return { number: "0x10", hash: HEADER_HASH, miner: chain === 421614 ? ARBITRUM_COINBASE : COINBASE };
    if (method === "debug_getRawHeader") return RAW_HEADER;
    if (method === "eth_getProof") {
      const known = [COINBASE, ARBITRUM_COINBASE].includes(String(p[0]).toLowerCase());
      const nodes = (n: number) => Array.from({ length: n }, () => `0x${"ab".repeat(500)}`);
      return {
        address: p[0], nonce: known ? "0x1" : "0x0", balance: "0x0", codeHash: `0x${"00".repeat(32)}`,
        storageHash: `0x${"22".repeat(32)}`, accountProof: nodes(8),
        storageProof: (p[1] as string[]).map((key) => ({ key, value: "0x1", proof: nodes(6) })),
      };
    }
    if (method === "eth_getCode") return "0x";
    return undefined;
  });
});

afterAll(() => stands.close());

/** Every balance empty, the funder's NEAR and USDC included; no Protocol or Whitehat created yet. */
beforeEach(() => {
  world.near.clear();
  world.usdc.clear();
  world.registered.clear();
  world.eth.clear();
  world.near.set(FUNDER, 0n);
});

function files() {
  const dir = mkdtempSync(join(tmpdir(), "bountee-site-seed-"));
  writeFileSync(join(dir, "site-deployment.json"), JSON.stringify({ network: "testnet", contract: CONTRACT, usdc: USDC }));
  writeFileSync(join(dir, "deployer.env"), `DEPLOYER_ADDRESS=${DEPLOYER}\nDEPLOYER_PRIVATE_KEY=${DEPLOYER_KEY}\n`);
  return {
    dir,
    env: {
      HOME: dir,
      NETWORK: "testnet",
      BOUNTEE_SITE: join(dir, "site-deployment.json"),
      DEPLOYER_ENV: join(dir, "deployer.env"),
      NEAR_RPC: `${stands.base}/near`,
      CHAIN_RPCS: `84532=${stands.base}/84532,421614=${stands.base}/421614`,
      PREFLIGHT_ONLY: "1",
    },
  };
}

async function preflight(extra: Record<string, string> = {}) {
  const { dir, env } = files();
  stands.requests.length = 0;
  requests = stands.requests;
  const r = await runScript(seed, { ...env, ...extra });
  return { ...r, dir };
}

/** An asset by kind: "ETH", "NEAR", or "USDC" (shown as "test USDC (<token>)" on testnet). */
const kind = (asset: string) => (asset.includes("USDC") ? "USDC" : asset);
const row = (out: any, who: string, chain: string, asset: string) => out.balances.find((b: any) => b.who === who && b.chain === chain && kind(b.asset) === asset);

/** Nothing could have spent: nothing signed went to NEAR or a chain, and no account was made (init saves its key first). */
function expectNothingSpent(dir: string) {
  expect(sendsAmong(requests)).toEqual([]);
  const keys = join(dir, ".near-credentials", "testnet");
  expect(existsSync(keys) ? readdirSync(keys) : []).toEqual([]);
}

test("D33: with every balance empty, the seed's preflight names every short balance, exits 3 and spends nothing", async () => {
  const r = await preflight();
  expect(r.status, r.stderr).toBe(3);
  const short = r.out.balances.filter((b: any) => !b.ok).map((b: any) => [b.who, b.chain, kind(b.asset)]);
  expect(short).toEqual([
    [DEPLOYER, "Base Sepolia", "ETH"],
    [DEPLOYER, "Arbitrum Sepolia", "ETH"],
    [FUNDER, "near-testnet", "USDC"],
    [FUNDER, "near-testnet", "NEAR"],
  ]);
  // One top-up line per short balance, each naming who and where.
  expect(r.out.top_up).toHaveLength(4);
  for (const [who, chain] of short) expect(r.out.top_up.some((t: string) => t.includes(who) && t.includes(chain))).toBe(true);
  // Six bounties of 1 to 3 USDC each, about 12 in all (spec #71), all from the funder.
  expect(row(r.out, FUNDER, "near-testnet", "USDC").need).toBe("12 USDC");
  expect(r.out.bounties.map((b: any) => b.protocol).sort()).toEqual([...PROTOCOLS].sort());
  for (const b of r.out.bounties) expect(b.usdc).toBeGreaterThanOrEqual(1), expect(b.usdc).toBeLessThanOrEqual(3);
  expect(r.out.bounties.map((b: any) => b.state).sort()).toEqual(["check_failed", "claims_judged", "ended", "live", "paid", "withdrawn"]);
  // Accounts not yet created are made by `bountee init` from NEAR's faucet, which funds them.
  expect(r.out.created_by_faucet.sort()).toEqual([...PROTOCOLS, WHITEHAT].sort());
  expectNothingSpent(r.dir);
});

test("D33: the deployer's ETH on each chain is six fresh instances' worth (D21's preflight, once per bounty)", async () => {
  const r = await preflight();
  // One D21 preflight of a single two-chain instance, run directly.
  const { env } = files();
  const one = await runScript(freshInstance, {
    ...env, BOUNTEE_DAY3: env.BOUNTEE_SITE, PROTOCOL: PROTOCOLS[0]!, BOUNTY_NAME: "one", BOUNTY_AMOUNT: "1000000", CHAINS: "84532,421614",
  });
  for (const chain of ["Base Sepolia", "Arbitrum Sepolia"]) {
    const single = BigInt(row(one.out, DEPLOYER, chain, "ETH").units.need);
    expect(BigInt(row(r.out, DEPLOYER, chain, "ETH").units.need), chain).toBe(6n * single);
  }
});

test("D33: with everything funded the preflight passes and still spends nothing (PREFLIGHT_ONLY)", async () => {
  world.near.set(FUNDER, 1n * YOCTO);
  world.usdc.set(FUNDER, 12_000_000n);
  for (const chain of [84532, 421614]) world.eth.set(chain, ETH / 10n);
  const r = await preflight();
  expect(r.status, r.stderr).toBe(0);
  expect(r.out.ok).toBe(true);
  expect(r.out.balances.every((b: any) => b.ok)).toBe(true);
  // The funder registers each of the six Protocols on the USDC: at least six storage deposits.
  expect(BigInt(row(r.out, FUNDER, "near-testnet", "NEAR").units.need)).toBeGreaterThan(6n * STORAGE_MIN);
  expectNothingSpent(r.dir);
});

test("D33: an existing Protocol short of NEAR is named, and USDC a Protocol already holds is not asked of the funder", async () => {
  world.near.set(FUNDER, 1n * YOCTO);
  world.usdc.set(FUNDER, 12_000_000n);
  for (const chain of [84532, 421614]) world.eth.set(chain, ETH / 10n);
  // osterwick-dex exists with 0.1 NEAR: too little to post (the 0.5 NEAR fee alone) and withdraw.
  const osterwick = "osterwick-dex.testnet";
  world.near.set(osterwick, YOCTO / 10n);
  // brassmoor-lend exists, registered, with 1 USDC of its own.
  const brassmoor = "brassmoor-lend.testnet";
  world.near.set(brassmoor, 5n * YOCTO);
  world.usdc.set(brassmoor, 1_000_000n);
  world.registered.add(brassmoor);
  const r = await preflight();
  expect(r.status, r.stderr).toBe(3);
  expect(r.out.balances.filter((b: any) => !b.ok).map((b: any) => [b.who, b.asset])).toEqual([[osterwick, "NEAR"]]);
  expect(r.out.top_up).toEqual([expect.stringContaining(`to ${osterwick} on near-testnet`)]);
  expect(row(r.out, FUNDER, "near-testnet", "USDC").need).toBe("11 USDC");
  expect(r.out.created_by_faucet).not.toContain(osterwick);
  expectNothingSpent(r.dir);
});
