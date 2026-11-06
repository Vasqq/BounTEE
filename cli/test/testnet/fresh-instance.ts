// A fresh demo instance and its bounty posted (D21): every winning run closes its bounty and
// pauses its vault, so each run uses a new one. NETWORK picks the network (#43): testnet (the
// default) deploys on Base Sepolia (and, with CHAINS, more chains) with a mock USDC and
// posts on NEAR testnet; mainnet deploys on Base and Arbitrum One with Circle's USDC (2 into
// the proof chain's vault, 1 into each other, ADR-0018) and posts on NEAR mainnet.
//
// 0. Reports every balance the run needs, and stops before spending anything, naming what
//    to top up, if any would run dry (spec, Testing Decisions).
// 1. Reads the new bounty's pause-role address from the bounty contract (`pause_role`), and
//    checks it against the formats' own derivation (D25). One address serves every chain.
// 2. On each chain, deploys a new DemoVault (demo/script/Deploy.s.sol, --broadcast), with a
//    new MockUSDC minted into it on testnet or real USDC sent from the deployer on mainnet,
//    granting the pause role to that address.
// 3. On each chain, funds the pause-role address with the pause gas the posting check asks
//    for (R7.6): the gas its signed pause may burn at its fee limit (200,000 gas at 1 gwei =
//    0.0002 ETH), plus Base's L1 data fee allowance (0.00001 ETH); the formats'
//    `PAUSE_GAS_PER_PAUSE`.
// 4. Posts the bounty with `bountee post` (#17), covering every chain's vault, the first
//    chain as its proof chain (D1); it goes live once the enclave's posting check passes.
//
// The deployer's key never goes on forge's or cast's command line (where a failed command's
// error would print it): they read it from a throwaway encrypted keystore (evm-key.ts), and
// everything this script prints on failure is redacted.
//
// Writes the instance to $BOUNTEE_INSTANCE (default ~/.bountee-<network>/day3-instance.json)
// and prints it as one JSON line. Exit status 3 = a balance is short (nothing was spent).
//
// Env: NETWORK (testnet or mainnet), BOUNTEE_DAY3 (deploy-system.ts's file, default
// ~/.bountee-<network>/day3-deployment.json), PROTOCOL (holds the USDC; default
// bountee-spike4.testnet, required on mainnet), BOUNTY_NAME (default demo-<UTC yyyymmddhhmm>),
// BOUNTY_AMOUNT (USDC smallest unit; default 100e6 on testnet, 10e6 on mainnet),
// MINIMUM_THEFT (default 1000e6 on testnet, 1e6 on mainnet), DISCLOSURE_DELAY_DAYS (1-90,
// default 1, ADR-0018), WHITEHAT and CLAIMS (the Whitehat and how many claims the run files,
// for the preflight; default 2, ADR-0018's cheat and win), DEPLOYER_ENV (default
// ~/.bountee-testnet/base-sepolia-deployer.env, ~/.bountee-mainnet/deployer.env; the same key
// deploys on every chain), CHAINS (comma-separated chain IDs, the proof chain first; default
// 84532 on testnet, 8453,42161 on mainnet), RPC (the proof chain's RPC), CHAIN_RPCS
// (<chain id>=<url>,... for any chain; every chain's default is in cli/src/chains.ts),
// NEAR_RPC, PREFLIGHT_ONLY=1 to stop after step 0.
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58 } from "@scure/base";
import { PAUSE_GAS_PER_PAUSE, pauseRole } from "@bountee/formats";
import { parseRpcFlags } from "../../src/broadcast.ts";
import { CHAINS, defaultRpc, proofRpcs } from "../../src/chains.ts";
import { rpc } from "../../src/proofs.ts";
import { budgetClaims, whitehatNeed, type ClaimBudget, type ClaimPlan, type Read } from "./claim-budget.ts";
import { formatNear, milliNear } from "../../src/near.ts";
import { MPC_ROOT, near, network as NETWORK, need, stopIfShort, wholeNumber, type Need } from "./deploy.ts";
import { keystoreEnv, redact } from "./evm-key.ts";

const home = homedir();
const root = fileURLToPath(new URL("../../../", import.meta.url));
const MAINNET = NETWORK === "mainnet";
const dir = join(home, `.bountee-${NETWORK}`);
const deployment = JSON.parse(readFileSync(process.env.BOUNTEE_DAY3 ?? join(dir, "day3-deployment.json"), "utf8"));
if ((deployment.network ?? "testnet") !== NETWORK) throw new Error(`the deployment is on ${deployment.network}, not ${NETWORK}`);
const CONTRACT: string = deployment.contract;
const USDC: string = deployment.usdc;
const PROTOCOL = process.env.PROTOCOL ?? (MAINNET ? undefined : "bountee-spike4.testnet");
if (!PROTOCOL) throw new Error("set PROTOCOL: the NEAR account that posts the bounty");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
const NAME = process.env.BOUNTY_NAME ?? `demo-${stamp}`;
// ADR-0018: on mainnet a 10 USDC bounty and a 1 USDC minimum theft.
const BOUNTY_AMOUNT = process.env.BOUNTY_AMOUNT ?? (MAINNET ? "10000000" : "100000000");
const MINIMUM_THEFT = process.env.MINIMUM_THEFT ?? (MAINNET ? "1000000" : "1000000000");
// ADR-0018's run: the exploit is published a disclosure delay after the payout, and the demo
// must reach "published" by Nov 11, so the delay is R1.4's minimum, 1 day, on both networks
// (testnet rehearses the mainnet run, #33). The contract refuses one outside 1-90 days, but
// only after the vaults are deployed and funded, so it is checked here, before anything.
const DISCLOSURE_DELAY_DAYS = wholeNumber("DISCLOSURE_DELAY_DAYS", 1);
if (DISCLOSURE_DELAY_DAYS < 1 || DISCLOSURE_DELAY_DAYS > 90) {
  throw new Error(`DISCLOSURE_DELAY_DAYS is ${DISCLOSURE_DELAY_DAYS}: a disclosure delay is 1-90 days (R1.4)`);
}
// The claims the run files, for the Whitehat's preflight: ADR-0018's run files two, the cheat
// that scores zero and the winning claim. A run that files more (the Day-3 checkpoint's three)
// says so.
const CLAIMS = wholeNumber("CLAIMS", 2);
const CHAIN_IDS = (process.env.CHAINS ?? (MAINNET ? "8453,42161" : "84532")).split(",").map(Number);
const CHAIN = CHAIN_IDS[0]!;
const chainRpcs = { ...parseRpcFlags(process.env.CHAIN_RPCS ? process.env.CHAIN_RPCS.split(",") : []), ...(process.env.RPC ? { [CHAIN]: process.env.RPC } : {}) };
const rpcOf = (chain: number) => chainRpcs[chain] ?? defaultRpc(chain) ?? (() => { throw new Error(`no RPC for chain ${chain}: set CHAIN_RPCS`); })();
const chainName = (chain: number) => CHAINS[chain]?.name ?? `chain ${chain}`;
// How much of Circle's USDC each mainnet vault starts with (ADR-0018: 2 on the proof chain,
// 1 on each other; the replay measures it). Testnet mints a mock.
const circleUsdc = (chain: number) => CHAINS[chain]?.usdc ?? (() => { throw new Error(`no USDC known on chain ${chain}`); })();
const vaultSeed = (chain: number) => (chain === CHAIN ? 2_000_000n : 1_000_000n);
if (MAINNET) CHAIN_IDS.forEach(circleUsdc);
const nearChain = `near-${NETWORK}`;
const OUT = process.env.BOUNTEE_INSTANCE ?? join(dir, "day3-instance.json");
const deployerEnv: Record<string, string> = Object.fromEntries(
  readFileSync(process.env.DEPLOYER_ENV ?? join(dir, MAINNET ? "deployer.env" : "base-sepolia-deployer.env"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
);
const DEPLOYER = deployerEnv.DEPLOYER_ADDRESS ?? "";
const DEPLOYER_KEY = deployerEnv.DEPLOYER_PRIVATE_KEY ?? "";
if (!DEPLOYER || !DEPLOYER_KEY) throw new Error("the deployer env file needs DEPLOYER_ADDRESS and DEPLOYER_PRIVATE_KEY");
// The deployer key reaches forge and cast as an encrypted keystore named in the environment,
// never on a command line, and any error this script prints is redacted (evm-key.ts).
const deployerKeystore = keystoreEnv(DEPLOYER_KEY);
process.on("exit", deployerKeystore.cleanup);
const redactErrors = (e: unknown) => {
  const err = e as Error & { stdout?: unknown; stderr?: unknown };
  console.error(redact(`${err?.stack ?? err}\n${err?.stdout ?? ""}\n${err?.stderr ?? ""}`));
  process.exit(1);
};
process.on("uncaughtException", redactErrors);
process.on("unhandledRejection", redactErrors);
/** forge or cast; with `signs`, signing as the deployer through its keystore. */
function foundry(tool: "forge" | "cast", args: string[], o: { signs?: boolean; cwd?: string; env?: Record<string, string> } = {}): string {
  try {
    return execFileSync(tool, args, {
      cwd: o.cwd,
      encoding: "utf8",
      env: { ...process.env, ...(o.signs ? deployerKeystore.env : {}), ...o.env },
      maxBuffer: 64 << 20,
    }).trim();
  } catch (e) {
    const err = e as Error & { stderr?: string };
    throw new Error(redact(`${tool} ${args[0]} failed: ${err.message}\n${err.stderr ?? ""}`));
  }
}
const cast = (...args: string[]) => foundry("cast", args);
const eth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} ETH`;

// ---- 0. Preflight --------------------------------------------------------------------------------

const fees = await near.view(CONTRACT, "fees");
// Gas limit at the fee limit (0.0002 ETH, R7.6), plus the L1 data fee an OP-stack chain such as
// Base charges on top: its pool refuses a pause whose sender holds exactly gas x max fee (Day-3
// run, Nov 5: "have 200000000000000 want 200000000001544"). The posting check asks for this.
const pauseGasWei = PAUSE_GAS_PER_PAUSE;
// Deploy.s.sol plus the pause-gas transfer, ~3.2M gas: at 3x today's price (floor 0.05 gwei),
// plus 0.00005 ETH of slack.
const deployWei = (rpc: string) => {
  const gasPrice = BigInt(cast("gas-price", "--rpc-url", rpc));
  const deployPrice = 3n * gasPrice > 50_000_000n ? 3n * gasPrice : 50_000_000n;
  return 4_000_000n * deployPrice + 50_000_000_000_000n;
};
const WHITEHAT = process.env.WHITEHAT;
const ftBalance = async (who: string) => BigInt(await near.view<string>(USDC, "ft_balance_of", { account_id: who }));

// The proof chain's RPC for the claims' proofs: the one given, else one known to serve proofs.
const proofRpc = chainRpcs[CHAIN] ?? proofRpcs(CHAIN)[0] ?? rpcOf(CHAIN);
// The router demo/script/HonestUser.s.sol buys Circle's USDC through on mainnet (Uniswap V2).
const UNISWAP_V2_ROUTER = "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24";
// Circle's USDC is a proxy, and every call reads its implementation's code. FiatTokenProxy keeps
// the implementation at ZeppelinOS's slot, keccak256("org.zeppelinos.proxy.implementation"), not
// EIP-1967's.
const IMPLEMENTATION_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

/**
 * The run's claims and what each replay reads (the accounts and slot counts the Day-3 run's jobs
 * and #35's mainnet cheat proved): the cheat (demo/script/HonestUser.s.sol) first, then the
 * winning exploit (Exploit.s.sol) for every other claim; a one-claim run files only the win.
 */
async function claimPlans(): Promise<ClaimPlan[]> {
  const call = (to: string, sig: string, ...args: string[]) => cast("call", to, sig, ...args, "--rpc-url", proofRpc).split(" ")[0]!.toLowerCase();
  const runtime = (name: string) => foundry("forge", ["inspect", name, "deployedBytecode"], { cwd: join(root, "demo") });
  const head = await rpc<{ miner: string }>(proofRpc, "eth_getBlockByNumber", ["latest", false]);
  const sender: Read = { name: "fresh sender", slots: 0 };
  const coinbase: Read = { name: "block's coinbase", address: head.miner, slots: 0 };
  const vault: Read = { name: "DemoVault", code: runtime("DemoVault"), slots: 0 };
  let cheat: Read[];
  let win: Read[];
  if (MAINNET) {
    const usdc = circleUsdc(CHAIN);
    const impl = `0x${BigInt(cast("storage", usdc, IMPLEMENTATION_SLOT, "--rpc-url", proofRpc)).toString(16).padStart(40, "0")}`;
    if (/^0x0+$/.test(impl)) throw new Error(`${usdc} names no implementation at ${IMPLEMENTATION_SLOT}`);
    const weth = call(UNISWAP_V2_ROUTER, "WETH()(address)");
    const pair = call(call(UNISWAP_V2_ROUTER, "factory()(address)"), "getPair(address,address)(address)", weth, usdc);
    const token = [{ name: "USDC implementation", address: impl, slots: 0 }];
    cheat = [sender, coinbase, vault, ...token, { name: "USDC", address: usdc, slots: 8 },
      { name: "Uniswap V2 router", address: UNISWAP_V2_ROUTER, slots: 0 }, { name: "WETH/USDC pair", address: pair, slots: 6 }, { name: "WETH", address: weth, slots: 2 }];
    win = [sender, coinbase, vault, ...token, { name: "USDC", address: usdc, slots: 4 }];
  } else {
    const mock = runtime("MockUSDC");
    cheat = [sender, coinbase, vault, { name: "MockUSDC", code: mock, slots: 4 }];
    win = [sender, coinbase, vault, { name: "MockUSDC", code: mock, slots: 2 }];
  }
  const wins = Array.from({ length: Math.max(0, CLAIMS - 1) }, () => ({ kind: "win", reads: win }));
  return CLAIMS === 0 ? [] : CLAIMS === 1 ? [{ kind: "win", reads: win }] : [{ kind: "cheat", reads: cheat }, ...wins];
}

const needs: Need[] = [];
const showUsdc = (x: bigint) => `${Number(x) / 1e6} USDC`;
const showNear = (y: bigint) => `${formatNear(y)} NEAR`;
for (const chain of CHAIN_IDS) {
  const rpc = rpcOf(chain);
  needs.push(need(DEPLOYER, chainName(chain), "ETH", BigInt(cast("balance", DEPLOYER, "--rpc-url", rpc)), deployWei(rpc) + pauseGasWei, eth));
  if (MAINNET) {
    const have = BigInt(cast("call", circleUsdc(chain), "balanceOf(address)(uint256)", DEPLOYER, "--rpc-url", rpc).split(" ")[0]!);
    needs.push(need(DEPLOYER, chainName(chain), `USDC (${circleUsdc(chain)})`, have, vaultSeed(chain), showUsdc));
  }
}
needs.push(need(PROTOCOL, nearChain, "NEAR", (await near.balance(PROTOCOL)) ?? 0n, BigInt(fees.posting_fee) + milliNear(100), showNear));
needs.push(need(PROTOCOL, nearChain, `${MAINNET ? "" : "test "}USDC (${USDC})`, await ftBalance(PROTOCOL), BigInt(BOUNTY_AMOUNT), showUsdc));
let claimBudgets: ClaimBudget[] = [];
if (WHITEHAT) {
  // Each claim's draw, from the very proofs it will carry on this network's proof chain
  // (claim-budget.ts); the Whitehat holds the largest draw plus what the others keep.
  claimBudgets = await budgetClaims(proofRpc, fees, await claimPlans());
  needs.push(need(WHITEHAT, nearChain, "NEAR", (await near.balance(WHITEHAT)) ?? 0n, whitehatNeed(claimBudgets), showNear));
}
stopIfShort(needs, {
  run: {
    claims: CLAIMS,
    disclosure_delay_days: DISCLOSURE_DELAY_DAYS,
    ...(WHITEHAT ? { claim_budget: claimBudgets.map((c) => ({ kind: c.kind, input_bytes: c.input_bytes, draw: showNear(c.draw), refunded: showNear(c.refunded) })) } : {}),
  },
});

// ---- 1. Pause-role address -------------------------------------------------------------------------

const id = { protocol: PROTOCOL, name: NAME };
if (await near.view(CONTRACT, "bounty", { id })) throw new Error(`${PROTOCOL}/${NAME} exists already: names are never reused (D25)`);
const role = await near.view<{ path: string; address: string }>(CONTRACT, "pause_role", { id });
const derived = pauseRole.address(MPC_ROOT[NETWORK], CONTRACT, id);
if (role.address !== derived) throw new Error(`pause_role says ${role.address}, the formats derive ${derived}`);

// ---- 2. Demo vault ---------------------------------------------------------------------------------

interface ChainInstance {
  chain_id: number;
  vault: string;
  evm_usdc: string;
  vault_usdc: string;
  deploy_txs: string[];
  pause_gas_tx: string;
  pause_role_balance_wei: string;
}
const chains: ChainInstance[] = [];
// Written after each chain, so a failure later never loses what was spent.
const save = (extra: Record<string, unknown>) => {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify({ contract: CONTRACT, bounty: `${PROTOCOL}/${NAME}`, pause_role: role.address, chains, ...extra }, null, 2)}\n`, { mode: 0o600 });
};

for (const chain of CHAIN_IDS) {
  const rpc = rpcOf(chain);
  const forge = foundry("forge", ["script", "script/Deploy.s.sol", "--rpc-url", rpc, "--broadcast", "--sender", DEPLOYER, "--slow"], {
    signs: true,
    cwd: join(root, "demo"),
    env: { PAUSE_ROLE: role.address, ...(MAINNET ? { USDC: circleUsdc(chain), SEED_USDC: vaultSeed(chain).toString() } : {}) },
  });
  const deployed = JSON.parse(forge.slice(forge.indexOf("DEMO_DEPLOY_JSON:") + "DEMO_DEPLOY_JSON:".length).trim().split("\n")[0]!);
  const vault = String(deployed.vault).toLowerCase();
  const evmUsdc = String(deployed.usdc).toLowerCase();
  const runLog = JSON.parse(readFileSync(join(root, `demo/broadcast/Deploy.s.sol/${chain}/run-latest.json`), "utf8"));
  const deployTxs: string[] = runLog.receipts.map((r: { transactionHash: string }) => r.transactionHash);
  if (cast("call", vault, "pauser()(address)", "--rpc-url", rpc).toLowerCase() !== role.address) {
    throw new Error(`the vault's pauser on chain ${chain} isn't ${role.address}`);
  }

  // ---- 3. Pause gas --------------------------------------------------------------------------------

  const fund = JSON.parse(
    foundry("cast", ["send", role.address, "--value", pauseGasWei.toString(), "--rpc-url", rpc, "--json"], { signs: true }),
  );
  chains.push({
    chain_id: chain,
    vault,
    evm_usdc: evmUsdc,
    vault_usdc: cast("call", evmUsdc, "balanceOf(address)(uint256)", vault, "--rpc-url", rpc).split(" ")[0]!,
    deploy_txs: deployTxs,
    pause_gas_tx: fund.transactionHash,
    pause_role_balance_wei: BigInt(cast("balance", role.address, "--rpc-url", rpc)).toString(),
  });
  save({ posted: false });
}
const proof = chains[0]!;

// ---- 4. Post the bounty ------------------------------------------------------------------------------

const config = await near.view(CONTRACT, "config");
const x25519 = generateKeyPairSync("x25519");
const pub = Buffer.from(x25519.publicKey.export({ format: "jwk" }).x!, "base64url");
const exploitKeyFile = join(dir, `${NAME}-exploit-key.pem`);
writeFileSync(exploitKeyFile, x25519.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
const rules = {
  covered_contracts: chains.map((c) => ({ chain_id: c.chain_id, address: c.vault })),
  proof_chain: CHAIN,
  recency_limit_secs: 300,
  listed_tokens: [
    { token: proof.evm_usdc, price: "1" },
    { token: "native", price: "0" },
  ],
  seed: config.seed,
  bounty_amount: BOUNTY_AMOUNT,
  minimum_theft: MINIMUM_THEFT,
  end_date_ns: String(BigInt(Date.now() + 30 * 86_400_000) * 1_000_000n),
  disclosure_delay_days: DISCLOSURE_DELAY_DAYS,
  exploit_public_key: `x25519:${base58.encode(pub)}`,
  judge_build_hash: config.judge_build_hash,
};
const rulesFile = join(dir, `${NAME}-rules.json`);
writeFileSync(rulesFile, `${JSON.stringify(rules, null, 2)}\n`, { mode: 0o600 });
const posted = spawnSync(
  process.execPath,
  [
    join(root, "cli/src/main.ts"), "post", `${PROTOCOL}/${NAME}`, "--rules", rulesFile, "--contract", CONTRACT, "--network", NETWORK,
    ...(process.env.NEAR_RPC ? ["--near-rpc", process.env.NEAR_RPC] : []),
    "--chain-rpc", CHAIN_IDS.map((c) => `${c}=${rpcOf(c)}`).join(","),
    "--json",
  ],
  { encoding: "utf8" },
);
const postResult = JSON.parse(posted.stdout.trim().split("\n").pop() || posted.stderr.trim().split("\n").pop() || "{}");
if (posted.status !== 0 || postResult.state !== "live") {
  save({ posted: false, rules, post: postResult });
  throw new Error(`the bounty isn't live: ${posted.stdout}${posted.stderr}`);
}

const instance = {
  contract: CONTRACT,
  bounty: `${PROTOCOL}/${NAME}`,
  protocol: PROTOCOL,
  name: NAME,
  // The proof chain's instance, as one-chain runs read it; `chains` has every chain's.
  chain_id: CHAIN,
  vault: proof.vault,
  evm_usdc: proof.evm_usdc,
  vault_usdc: proof.vault_usdc,
  pause_role: role.address,
  pause_role_balance_wei: proof.pause_role_balance_wei,
  deploy_txs: proof.deploy_txs,
  pause_gas_tx: proof.pause_gas_tx,
  chains,
  post_tx: postResult.post_tx,
  rules,
  balances: needs,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(instance, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(instance));
