// A fresh demo instance on Base Sepolia, and its bounty posted on NEAR testnet (D21): every
// winning run closes its bounty and pauses its vault, so each run uses a new one.
//
// 0. Reports every balance the run needs, and stops before spending anything, naming what
//    to top up, if any would run dry (spec, Testing Decisions).
// 1. Reads the new bounty's pause-role address from the bounty contract (`pause_role`), and
//    checks it against the formats' own derivation (D25).
// 2. Deploys a new MockUSDC + DemoVault (demo/script/Deploy.s.sol, --broadcast), granting the
//    pause role to that address.
// 3. Funds the pause-role address with the gas its signed pause may burn at its fee limit
//    (200,000 gas at 1 gwei = 0.0002 ETH; `fees()` on the contract), plus Base's L1 data fee.
// 4. Posts the bounty: one USDC `ft_transfer_call` carrying the rules, covering the vault.
//
// Writes the instance to $BOUNTEE_INSTANCE (default ~/.bountee-testnet/day3-instance.json)
// and prints it as one JSON line. Exit status 3 = a balance is short (nothing was spent).
//
// Env: BOUNTEE_DAY3 (deploy-system.ts's file), PROTOCOL (holds the test USDC; default
// bountee-spike4.testnet), BOUNTY_NAME (default demo-<UTC yyyymmddhhmm>), BOUNTY_AMOUNT (test
// USDC smallest unit, default 100e6), MINIMUM_THEFT (default 1000e6), WHITEHAT and
// CLAIMS (the Whitehat and how many claims the run files, for the preflight), DEPLOYER_ENV
// (default ~/.bountee-testnet/base-sepolia-deployer.env), RPC (default: Base Sepolia's in cli/src/chains.ts),
// PREFLIGHT_ONLY=1 to stop after step 0.
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58 } from "@scure/base";
import { actions } from "near-api-js";
import { pauseRole } from "@bountee/formats";
import { defaultRpc } from "../../src/chains.ts";
import { Near, events, formatNear, milliNear, tgas } from "../../src/near.ts";

const home = homedir();
const root = fileURLToPath(new URL("../../../", import.meta.url));
const deployment = JSON.parse(readFileSync(process.env.BOUNTEE_DAY3 ?? join(home, ".bountee-testnet", "day3-deployment.json"), "utf8"));
const CONTRACT: string = deployment.contract;
const USDC: string = deployment.usdc;
const PROTOCOL = process.env.PROTOCOL ?? "bountee-spike4.testnet";
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
const NAME = process.env.BOUNTY_NAME ?? `demo-${stamp}`;
const BOUNTY_AMOUNT = process.env.BOUNTY_AMOUNT ?? "100000000";
const MINIMUM_THEFT = process.env.MINIMUM_THEFT ?? "1000000000";
const CHAIN = 84532;
const RPC = process.env.RPC ?? defaultRpc(CHAIN)!;
const OUT = process.env.BOUNTEE_INSTANCE ?? join(home, ".bountee-testnet", "day3-instance.json");
const deployerEnv: Record<string, string> = Object.fromEntries(
  readFileSync(process.env.DEPLOYER_ENV ?? join(home, ".bountee-testnet", "base-sepolia-deployer.env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const DEPLOYER = deployerEnv.DEPLOYER_ADDRESS ?? "";
const DEPLOYER_KEY = deployerEnv.DEPLOYER_PRIVATE_KEY ?? "";
if (!DEPLOYER || !DEPLOYER_KEY) throw new Error("the deployer env file needs DEPLOYER_ADDRESS and DEPLOYER_PRIVATE_KEY");
const near = new Near("testnet");
const cast = (...args: string[]) => execFileSync("cast", args, { encoding: "utf8" }).trim();
const eth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} ETH`;

// ---- 0. Preflight --------------------------------------------------------------------------------

const fees = await near.view(CONTRACT, "fees");
// Gas limit at the fee limit (0.0002 ETH, R7.6), plus the L1 data fee an OP-stack chain such as
// Base charges on top: its pool refuses a pause whose sender holds exactly gas x max fee (Day-3
// run, Nov 5: "have 200000000000000 want 200000000001544"). 0.00001 ETH covers it many times over.
const OP_STACK_L1_FEE_WEI = 10_000_000_000_000n;
const pauseGasWei = BigInt(fees.pause_gas_limit) * BigInt(fees.pause_max_fee_per_gas) + OP_STACK_L1_FEE_WEI;
const gasPrice = BigInt(cast("gas-price", "--rpc-url", RPC));
// Deploy.s.sol plus the pause-gas transfer, ~3.2M gas: at 3x today's price (floor 0.05 gwei),
// plus 0.00005 ETH of slack.
const deployPrice = 3n * gasPrice > 50_000_000n ? 3n * gasPrice : 50_000_000n;
const deployWei = 4_000_000n * deployPrice + 50_000_000_000_000n;
const claims = Number(process.env.CLAIMS ?? 3);
const WHITEHAT = process.env.WHITEHAT;
const ftBalance = async (who: string) => BigInt(await near.view<string>(USDC, "ft_balance_of", { account_id: who }));

interface Need { who: string; chain: string; asset: string; have: string; need: string; ok: boolean; top_up?: string }
const needs: Need[] = [];
const need = (who: string, chain: string, asset: string, have: bigint, want: bigint, show: (x: bigint) => string) =>
  needs.push({ who, chain, asset, have: show(have), need: show(want), ok: have >= want, ...(have < want ? { top_up: show(want - have) } : {}) });

need(DEPLOYER, "base-sepolia", "ETH", BigInt(cast("balance", DEPLOYER, "--rpc-url", RPC)), deployWei + pauseGasWei, eth);
need(PROTOCOL, "near-testnet", "NEAR", (await near.balance(PROTOCOL)) ?? 0n, BigInt(fees.posting_fee) + milliNear(100), (y) => `${formatNear(y)} NEAR`);
need(PROTOCOL, "near-testnet", `test USDC (${USDC})`, await ftBalance(PROTOCOL), BigInt(BOUNTY_AMOUNT), (x) => `${Number(x) / 1e6} USDC`);
if (WHITEHAT) {
  // Each live claim draws ~0.9 NEAR (its ~120 KB input is held while the job runs) plus gas.
  need(WHITEHAT, "near-testnet", "NEAR", (await near.balance(WHITEHAT)) ?? 0n, milliNear(1100 * claims), (y) => `${formatNear(y)} NEAR`);
}
const short = needs.filter((n) => !n.ok);
console.error(needs.map((n) => `${n.ok ? "ok   " : "SHORT"} ${n.who} (${n.chain}) ${n.asset}: has ${n.have}, needs ${n.need}`).join("\n"));
if (short.length > 0) {
  console.log(JSON.stringify({ ok: false, balances: needs, top_up: short.map((n) => `${n.top_up} to ${n.who} on ${n.chain}`) }));
  process.exit(3);
}
if (process.env.PREFLIGHT_ONLY === "1") {
  console.log(JSON.stringify({ ok: true, balances: needs }));
  process.exit(0);
}

// ---- 1. Pause-role address -------------------------------------------------------------------------

const id = { protocol: PROTOCOL, name: NAME };
if (await near.view(CONTRACT, "bounty", { id })) throw new Error(`${PROTOCOL}/${NAME} exists already: names are never reused (D25)`);
const role = await near.view<{ path: string; address: string }>(CONTRACT, "pause_role", { id });
const derived = pauseRole.address(pauseRole.TESTNET_ROOT_PUBLIC_KEY, CONTRACT, id);
if (role.address !== derived) throw new Error(`pause_role says ${role.address}, the formats derive ${derived}`);

// ---- 2. Demo vault ---------------------------------------------------------------------------------

const forge = execFileSync(
  "forge",
  ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast", "--private-key", DEPLOYER_KEY, "--slow"],
  { cwd: join(root, "demo"), encoding: "utf8", env: { ...process.env, PAUSE_ROLE: role.address }, maxBuffer: 64 << 20 },
);
const deployed = JSON.parse(forge.slice(forge.indexOf("DEMO_DEPLOY_JSON:") + "DEMO_DEPLOY_JSON:".length).trim().split("\n")[0]!);
const vault = String(deployed.vault).toLowerCase();
const evmUsdc = String(deployed.usdc).toLowerCase();
const runLog = JSON.parse(readFileSync(join(root, `demo/broadcast/Deploy.s.sol/${CHAIN}/run-latest.json`), "utf8"));
const deployTxs: string[] = runLog.receipts.map((r: { transactionHash: string }) => r.transactionHash);
if (cast("call", vault, "pauser()(address)", "--rpc-url", RPC).toLowerCase() !== role.address) {
  throw new Error(`the vault's pauser isn't ${role.address}`);
}

// ---- 3. Pause gas ----------------------------------------------------------------------------------

const fund = JSON.parse(
  cast("send", role.address, "--value", pauseGasWei.toString(), "--private-key", DEPLOYER_KEY, "--rpc-url", RPC, "--json"),
);
const pauserBalance = BigInt(cast("balance", role.address, "--rpc-url", RPC));

// ---- 4. Post the bounty ------------------------------------------------------------------------------

const config = await near.view(CONTRACT, "config");
const x25519 = generateKeyPairSync("x25519");
const pub = Buffer.from(x25519.publicKey.export({ format: "jwk" }).x!, "base64url");
const exploitKeyFile = join(home, ".bountee-testnet", `${NAME}-exploit-key.pem`);
writeFileSync(exploitKeyFile, x25519.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
const rules = {
  covered_contracts: [{ chain_id: CHAIN, address: vault }],
  proof_chain: CHAIN,
  recency_limit_secs: 300,
  listed_tokens: [
    { token: evmUsdc, price: "1" },
    { token: "native", price: "0" },
  ],
  seed: config.seed,
  bounty_amount: BOUNTY_AMOUNT,
  minimum_theft: MINIMUM_THEFT,
  end_date_ns: String(BigInt(Date.now() + 30 * 86_400_000) * 1_000_000n),
  disclosure_delay_days: 30,
  exploit_public_key: `x25519:${base58.encode(pub)}`,
  judge_build_hash: config.judge_build_hash,
};
const protocol = near.account(PROTOCOL);
await protocol.callFunction({
  contractId: CONTRACT,
  methodName: "prepay_posting_fee",
  args: {},
  deposit: BigInt(fees.posting_fee) + milliNear(10),
  gas: tgas(30),
});
const post = await protocol.signAndSendTransaction({
  receiverId: USDC,
  actions: [actions.functionCall("ft_transfer_call", { receiver_id: CONTRACT, amount: BOUNTY_AMOUNT, msg: JSON.stringify({ name: NAME, rules }) }, tgas(270), 1n)],
  waitUntil: "FINAL",
});
const postStatus = await near.txStatus(post.transaction.hash, PROTOCOL);
const bounty = await near.view(CONTRACT, "bounty", { id });
if (bounty?.state !== "live") {
  throw new Error(`the bounty isn't live (${bounty?.state ?? "absent"}): ${JSON.stringify(events(postStatus))}`);
}

const instance = {
  contract: CONTRACT,
  bounty: `${PROTOCOL}/${NAME}`,
  protocol: PROTOCOL,
  name: NAME,
  chain_id: CHAIN,
  vault,
  evm_usdc: evmUsdc,
  vault_usdc: cast("call", evmUsdc, "balanceOf(address)(uint256)", vault, "--rpc-url", RPC).split(" ")[0],
  pause_role: role.address,
  pause_role_balance_wei: pauserBalance.toString(),
  deploy_txs: deployTxs,
  pause_gas_tx: fund.transactionHash,
  post_tx: post.transaction.hash,
  rules,
  balances: needs,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(instance, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(instance));
