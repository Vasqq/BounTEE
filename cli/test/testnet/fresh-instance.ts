// A fresh demo instance and its bounty posted (D21): every winning run closes its bounty and
// pauses its vault, so each run uses a new one. The demo vault is a PositionVault (ADR-0019).
// NETWORK picks the network (#43): testnet (the default) deploys on Base Sepolia (and, with
// CHAINS, more chains) with a mock USDC and posts on NEAR testnet; mainnet deploys on Base and
// Arbitrum One with Circle's USDC (2 into each chain's vault, so a theft proven on either
// reaches the 1 USDC minimum theft, ADR-0020) and posts on NEAR mainnet.
//
// 0. Reports every balance the run needs, and stops before spending anything, naming what
//    to top up, if any would run dry (spec, Testing Decisions).
// 1. Reads the new bounty's pause-role address from the bounty contract (`pause_role`), and
//    checks it against the formats' own derivation (D25). One address serves every chain.
// 2. On each chain, deploys a new PositionVault (demo/script/Deploy.s.sol, --broadcast),
//    granting the pause role to that address, and funds it by the deployer's own deposit:
//    a new MockUSDC minted to the deployer on testnet, Circle's USDC the deployer holds on
//    mainnet, approved to the vault and deposited for shares (ADR-0019).
// 3. On each chain, funds the pause-role address with the pause gas the posting check asks
//    for (R7.6): the gas its signed pause may burn at its fee limit (200,000 gas at 1 gwei =
//    0.0002 ETH), plus Base's L1 data fee allowance (0.00001 ETH); the formats'
//    `PAUSE_GAS_PER_PAUSE`.
// 4. Posts the bounty with `bountee post` (#17), covering every chain's vault and listing each
//    chain's USDC at price 1 and its native coin at 0 (ADR-0020): a claim may be proven on any
//    of them (D1). It goes live once the enclave's posting check passes.
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
// deploys on every chain), CHAINS (comma-separated chain IDs; the cheat is filed on the first, a
// win budgeted on each; default 84532 on testnet, 8453,42161 on mainnet), RPC (the first chain's RPC),
// CHAIN_RPCS (<chain id>=<url>,... for any chain; every chain's default is in cli/src/chains.ts),
// NEAR_RPC, EXPLOIT_PUBLIC_KEY (the rules' exploit key, x25519:<base58>, such as the one
// `bountee open-exploit --public-key` derives from the Protocol's wallet; default: a new key,
// written to <dir>/<name>-exploit-key.pem), END_IN_SECS (the end date, this many seconds after
// the posting is built; default 30 days: the testnet site's seed sets a few minutes for its
// Ended and Withdrawn bounties, D33), SKIP_GRANT=1 (each vault names the deployer as its pauser,
// so the pause role is never granted and the posting check fails: the bounty ends Check failed
// with its USDC refunded, which the script then expects instead of Live, D33), PREFLIGHT_ONLY=1
// to stop after step 0. The deployment it reads and the instance it writes are BOUNTEE_DAY3 and
// BOUNTEE_INSTANCE.
import { execFileSync, spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58 } from "@scure/base";
import { PAUSE_GAS_PER_PAUSE, parseRules, pauseRole } from "@bountee/formats";
import { parseRpcFlags } from "../../src/broadcast.ts";
import { CHAINS, defaultRpc, proofRpcs } from "../../src/chains.ts";
import { rpc } from "../../src/proofs.ts";
import { DEMO_READS, budgetClaims, whitehatNeed, type ClaimBudget, type ClaimPlan, type Read, type Role } from "./claim-budget.ts";
import { CLAIM_GAS } from "../../src/claim.ts";
import { formatNear, roundUpNear } from "../../src/near.ts";
import { postingNeed } from "../../src/post.ts";
import { DEMO_DEPLOY_GAS, MPC_ROOT, near, network as NETWORK, need, stopIfShort, VAULT_USDC, wholeNumber, type Need } from "./deploy.ts";
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
// A malformed exploit key would only be refused at posting, after the vaults are deployed.
if (process.env.EXPLOIT_PUBLIC_KEY) {
  const [curve, key] = process.env.EXPLOIT_PUBLIC_KEY.split(":");
  let bytes = 0;
  try {
    bytes = base58.decode(key ?? "").length;
  } catch {}
  if (curve !== "x25519" || bytes !== 32) throw new Error(`EXPLOIT_PUBLIC_KEY is ${process.env.EXPLOIT_PUBLIC_KEY}: it must be x25519:<32 bytes, base58>`);
}
// The claims the run files, for the Whitehat's preflight: ADR-0018's run files two, the cheat
// that scores zero and the winning claim. A run that files more (the Day-3 checkpoint's three)
// says so.
const CLAIMS = wholeNumber("CLAIMS", 2);
// The end date, END_IN_SECS after the rules are built (R1.4 refuses one not in the future).
const END_IN_SECS = wholeNumber("END_IN_SECS", 30 * 86_400);
if (END_IN_SECS === 0) throw new Error("END_IN_SECS is 0: the end date must be in the future (R1.4)");
// D33's Check failed: the vaults never grant the pause role, so the posting check refuses.
const SKIP_GRANT = process.env.SKIP_GRANT === "1";
const EXPECTED_STATE = SKIP_GRANT ? "check_failed" : "live";
const CHAIN_IDS = (process.env.CHAINS ?? (MAINNET ? "8453,42161" : "84532")).split(",").map(Number);
const CHAIN = CHAIN_IDS[0]!;
const chainRpcs = { ...parseRpcFlags(process.env.CHAIN_RPCS ? process.env.CHAIN_RPCS.split(",") : []), ...(process.env.RPC ? { [CHAIN]: process.env.RPC } : {}) };
const rpcOf = (chain: number) => chainRpcs[chain] ?? defaultRpc(chain) ?? (() => { throw new Error(`no RPC for chain ${chain}: set CHAIN_RPCS`); })();
const chainName = (chain: number) => CHAINS[chain]?.name ?? `chain ${chain}`;
const circleUsdc = (chain: number) => CHAINS[chain]?.usdc ?? (() => { throw new Error(`no USDC known on chain ${chain}`); })();
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
// The demo contracts' Solidity dependencies (forge-std) are fetched by Soldeer, not committed, so
// a fresh checkout has none until this runs. The preflight sizes the vault's code and the deploy
// compiles it, so both need them first; `soldeer install` does nothing once they're there.
const demoDir = join(root, "demo");
foundry("forge", ["soldeer", "install"], { cwd: demoDir });
const eth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} ETH`;

// ---- 0. Preflight --------------------------------------------------------------------------------

/**
 * The bounty's rules, covering `vaults` and listing each chain's USDC (`usdcs`) at price 1 and its
 * native coin at 0 (ADR-0020): built for the preflight's sizing before the vaults exist, and for
 * the posting after.
 */
function bountyRules(config: any, vaults: { chain_id: number; address: string }[], usdcs: { chain_id: number; usdc: string }[], exploitPublicKey: string) {
  return {
    covered_contracts: vaults,
    recency_limit_secs: 300,
    listed_tokens: usdcs.flatMap(({ chain_id, usdc }) => [
      { chain_id, token: usdc, price: "1" },
      { chain_id, token: "native", price: "0" },
    ]),
    seed: config.seed,
    bounty_amount: BOUNTY_AMOUNT,
    minimum_theft: MINIMUM_THEFT,
    end_date_ns: String(BigInt(Date.now() + END_IN_SECS * 1000) * 1_000_000n),
    disclosure_delay_days: DISCLOSURE_DELAY_DAYS,
    exploit_public_key: exploitPublicKey,
    judge_build_hash: config.judge_build_hash,
  };
}

const fees = await near.view(CONTRACT, "fees");
// Gas limit at the fee limit (0.0002 ETH, R7.6), plus the L1 data fee an OP-stack chain such as
// Base charges on top: its pool refuses a pause whose sender holds exactly gas x max fee (Day-3
// run, Nov 5: "have 200000000000000 want 200000000001544"). The posting check asks for this.
const pauseGasWei = PAUSE_GAS_PER_PAUSE;
// Deploy.s.sol plus the pause-gas transfer (DEMO_DEPLOY_GAS): at 3x today's price (floor
// 0.05 gwei), plus 0.00005 ETH of slack.
const deployWei = (rpc: string) => {
  const gasPrice = BigInt(cast("gas-price", "--rpc-url", rpc));
  const deployPrice = 3n * gasPrice > 50_000_000n ? 3n * gasPrice : 50_000_000n;
  return DEMO_DEPLOY_GAS * deployPrice + 50_000_000_000_000n;
};
const WHITEHAT = process.env.WHITEHAT;
const ftBalance = async (who: string) => BigInt(await near.view<string>(USDC, "ft_balance_of", { account_id: who }));

// A chain's RPC for a claim's proofs: the one given, else one known to serve proofs.
const proofRpcOf = (chain: number) => chainRpcs[chain] ?? proofRpcs(chain)[0] ?? rpcOf(chain);
// The router demo/script/HonestUser.s.sol buys Circle's USDC through on mainnet (Uniswap V2 on
// Base, where the cheat is filed).
const UNISWAP_V2_ROUTER = "0x4752ba5dbc23f44d87826276bf6fd6b1c372ad24";
// Circle's USDC is a proxy, and every call reads its implementation's code. FiatTokenProxy keeps
// the implementation at ZeppelinOS's slot, keccak256("org.zeppelinos.proxy.implementation"), not
// EIP-1967's.
const IMPLEMENTATION_SLOT = "0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3";

const runtimes = new Map<string, string>();
/** A demo contract's compiled runtime code, compiled once. */
const runtime = (name: string) => {
  if (!runtimes.has(name)) runtimes.set(name, foundry("forge", ["inspect", name, "deployedBytecode"], { cwd: demoDir }));
  return runtimes.get(name)!;
};

/**
 * What a demo claim of `kind` proven on `chain` reads (claim-budget.ts's DEMO_READS, measured on
 * the PositionVault's replays), each account resolved on that chain: its coinbase, its USDC, and
 * for the cheat (demo/script/HonestUser.s.sol, filed on Base) Uniswap's. A contract the run
 * deploys (the vault, and the mock USDC on testnet) is budgeted from its compiled code.
 */
async function claimPlan(chain: number, kind: "cheat" | "win"): Promise<ClaimPlan> {
  const url = proofRpcOf(chain);
  const call = (to: string, sig: string, ...args: string[]) => cast("call", to, sig, ...args, "--rpc-url", url).split(" ")[0]!.toLowerCase();
  const head = await rpc<{ miner: string }>(url, "eth_getBlockByNumber", ["latest", false]);
  const accounts: Partial<Record<Role, Omit<Read, "slots">>> = {
    sender: { name: "fresh sender" },
    coinbase: { name: "block's coinbase", address: head.miner },
    vault: { name: "PositionVault", code: runtime("PositionVault") },
  };
  if (MAINNET) {
    const usdc = circleUsdc(chain);
    const impl = `0x${BigInt(cast("storage", usdc, IMPLEMENTATION_SLOT, "--rpc-url", url)).toString(16).padStart(40, "0")}`;
    if (/^0x0+$/.test(impl)) throw new Error(`${usdc} names no implementation at ${IMPLEMENTATION_SLOT}`);
    Object.assign(accounts, {
      usdc_implementation: { name: "USDC implementation", address: impl },
      usdc: { name: "USDC", address: usdc },
    });
    if (kind === "cheat") {
      const weth = call(UNISWAP_V2_ROUTER, "WETH()(address)");
      const pair = call(call(UNISWAP_V2_ROUTER, "factory()(address)"), "getPair(address,address)(address)", weth, usdc);
      Object.assign(accounts, {
        uniswap_router: { name: "Uniswap V2 router", address: UNISWAP_V2_ROUTER },
        uniswap_pair: { name: "WETH/USDC pair", address: pair },
        weth: { name: "WETH", address: weth },
      });
    }
  } else {
    accounts.usdc = { name: "MockUSDC", code: runtime("MockUSDC") };
  }
  const reads = Object.entries(DEMO_READS[NETWORK][kind]).map(([role, slots]) => ({ ...accounts[role as Role]!, slots: slots! }));
  return { kind, reads };
}

const needs: Need[] = [];
const showUsdc = (x: bigint) => `${Number(x) / 1e6} USDC`;
const showNear = (y: bigint) => `${formatNear(y)} NEAR`;
for (const chain of CHAIN_IDS) {
  const rpc = rpcOf(chain);
  needs.push(need(DEPLOYER, chainName(chain), "ETH", BigInt(cast("balance", DEPLOYER, "--rpc-url", rpc)), deployWei(rpc) + pauseGasWei, eth));
  if (MAINNET) {
    const have = BigInt(cast("call", circleUsdc(chain), "balanceOf(address)(uint256)", DEPLOYER, "--rpc-url", rpc).split(" ")[0]!);
    needs.push(need(DEPLOYER, chainName(chain), `USDC (${circleUsdc(chain)})`, have, VAULT_USDC, showUsdc));
  }
}
// The posting's NEAR in hand (#57): sized on rules of the same shape as the real ones, with
// placeholder vaults and exploit key of the same lengths (a key's base58 is 43 or 44 characters;
// this one is 44), since neither exists yet.
const sizingRules = parseRules(
  bountyRules(
    await near.view(CONTRACT, "config"),
    CHAIN_IDS.map((chain_id) => ({ chain_id, address: `0x${"0".repeat(40)}` })),
    CHAIN_IDS.map((chain_id) => ({ chain_id, usdc: MAINNET ? circleUsdc(chain_id) : `0x${"0".repeat(40)}` })),
    "x25519:6W7B3sSYk1p2DZ7FXyRbJWDNiaRfVTj1hm6k8Cqnq6wA",
  ),
);
const { need: postingNear } = await postingNeed(near, CONTRACT, { protocol: PROTOCOL, name: NAME }, sizingRules);
needs.push(need(PROTOCOL, nearChain, "NEAR", (await near.freeNear(PROTOCOL)) ?? 0n, postingNear, showNear));
needs.push(need(PROTOCOL, nearChain, `${MAINNET ? "" : "test "}USDC (${USDC})`, await ftBalance(PROTOCOL), BigInt(BOUNTY_AMOUNT), showUsdc));
let claimBudgets: ClaimBudget[] = [];
let winBudgets: ClaimBudget[] = [];
if (WHITEHAT) {
  // Each claim's draw, from the very proofs it will carry on the chain it is proven on
  // (claim-budget.ts). The cheat is filed on the first chain (Base); a win may be proven on any
  // covered chain (ADR-0020), so it is budgeted on each, from that chain's own proofs and header,
  // and every win the run files is held at the costliest chain's. The Whitehat holds the
  // largest draw plus what the others keep.
  if (CLAIMS > 0) {
    for (const chain of CHAIN_IDS) winBudgets.push(...(await budgetClaims(proofRpcOf(chain), fees, [await claimPlan(chain, "win")])));
    const win = winBudgets.reduce((m, w) => (w.draw > m.draw ? w : m));
    const cheat = CLAIMS === 1 ? [] : await budgetClaims(proofRpcOf(CHAIN), fees, [await claimPlan(CHAIN, "cheat")]);
    claimBudgets = [...cheat, ...Array.from({ length: CLAIMS - cheat.length }, () => win)];
  }
  // Plus one claim's gas in hand (#57): `submit_claim` attaches CLAIM_GAS, bought up front, and the
  // claims go one at a time, so the largest claim's call is the most ever held at once.
  const claimGas = await Promise.all(
    claimBudgets.map((c) => near.upfrontNear([{ method: "submit_claim", gas: CLAIM_GAS, deposit: 0n, argsBytes: c.input_bytes }])),
  );
  const claimGasNear = claimGas.reduce((m, x) => (x > m ? x : m), 0n);
  needs.push(need(WHITEHAT, nearChain, "NEAR", (await near.freeNear(WHITEHAT)) ?? 0n, roundUpNear(whitehatNeed(claimBudgets) + claimGasNear), showNear));
}
const shownBudget = (c: ClaimBudget) => ({ chain_id: c.chain_id, input_bytes: c.input_bytes, draw: showNear(c.draw), refunded: showNear(c.refunded) });
stopIfShort(needs, {
  run: {
    claims: CLAIMS,
    disclosure_delay_days: DISCLOSURE_DELAY_DAYS,
    ...(WHITEHAT ? { claim_budget: claimBudgets.map((c) => ({ kind: c.kind, ...shownBudget(c) })), win_budgets: winBudgets.map(shownBudget) } : {}),
  },
});

// ---- 1. Pause-role address -------------------------------------------------------------------------

const id = { protocol: PROTOCOL, name: NAME };
if (await near.view(CONTRACT, "bounty", { id })) throw new Error(`${PROTOCOL}/${NAME} exists already: names are never reused (D25)`);
const role = await near.view<{ path: string; address: string }>(CONTRACT, "pause_role", { id });
const derived = pauseRole.address(MPC_ROOT[NETWORK], CONTRACT, id);
if (role.address !== derived) throw new Error(`pause_role says ${role.address}, the formats derive ${derived}`);

// ---- 2. PositionVault -----------------------------------------------------------------------------

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
    cwd: demoDir,
    env: { PAUSE_ROLE: SKIP_GRANT ? DEPLOYER : role.address, ...(MAINNET ? { USDC: circleUsdc(chain), SEED_USDC: VAULT_USDC.toString() } : {}) },
  });
  const deployed = JSON.parse(forge.slice(forge.indexOf("DEMO_DEPLOY_JSON:") + "DEMO_DEPLOY_JSON:".length).trim().split("\n")[0]!);
  const vault = String(deployed.vault).toLowerCase();
  const evmUsdc = String(deployed.usdc).toLowerCase();
  const runLog = JSON.parse(readFileSync(join(root, `demo/broadcast/Deploy.s.sol/${chain}/run-latest.json`), "utf8"));
  const deployTxs: string[] = runLog.receipts.map((r: { transactionHash: string }) => r.transactionHash);
  const pauser = SKIP_GRANT ? DEPLOYER.toLowerCase() : role.address;
  if (cast("call", vault, "pauser()(address)", "--rpc-url", rpc).toLowerCase() !== pauser) {
    throw new Error(`the PositionVault's pauser on chain ${chain} isn't ${pauser}`);
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
const exploitPublicKey = process.env.EXPLOIT_PUBLIC_KEY ?? newExploitKey();
function newExploitKey(): string {
  const x25519 = generateKeyPairSync("x25519");
  const pub = Buffer.from(x25519.publicKey.export({ format: "jwk" }).x!, "base64url");
  writeFileSync(join(dir, `${NAME}-exploit-key.pem`), x25519.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  return `x25519:${base58.encode(pub)}`;
}
const rules = bountyRules(
  config,
  chains.map((c) => ({ chain_id: c.chain_id, address: c.vault })),
  chains.map((c) => ({ chain_id: c.chain_id, usdc: c.evm_usdc })),
  exploitPublicKey,
);
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
// `post` exits 1 on a failed check, which SKIP_GRANT expects; the state read back decides.
if (postResult.state !== EXPECTED_STATE || (EXPECTED_STATE === "live" && posted.status !== 0)) {
  save({ posted: false, rules, post: postResult });
  throw new Error(`the bounty isn't ${EXPECTED_STATE}: ${posted.stdout}${posted.stderr}`);
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
  state: postResult.state,
  rules,
  balances: needs,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(instance, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(instance));
