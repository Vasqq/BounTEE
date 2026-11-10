// Ticket #58: a local copy of the demo's mainnet state, built before any mainnet spend, so the
// new vault's mainnet numbers are checked without sending anything to mainnet.
//
//   node cli/test/mainnet-state/build.ts [--out <dir>] [--name <bounty name>]
//
// Reads Base and Arbitrum One from public RPCs (read-only) and writes, per chain, an anvil state
// file and a manifest (`<dir>/manifest.json`) that the seam J posting check and #59's claim
// rehearsal load into a plain, non-fork anvil.
//
// Why not just fork: blocks a forked anvil mines carry an all-zero state root, and the judge
// checks every proof against the header's state root first, so every claim on a fork comes back
// INVALID. A dump of a fork keeps only what transactions wrote, not what they read (a reverted
// warm-up or an eth_call leaves nothing in it), so the copy is built explicitly:
//   1. Fork the chain a few blocks behind its head.
//   2. Give a local deployer the vault's USDC (Circle's), and fund the bounty's pause-role
//      address (the mainnet MPC derivation for demo.bountee.near/<name> on bounty2.bountee.near).
//   3. Deploy the vault and deposit its USDC with demo/script/Deploy.s.sol's own transactions,
//      each sent with its EIP-2930 access list recorded first (eth_createAccessList: every
//      account and slot the EVM touches, read or written).
//   4. Record the same for the claims proven on each chain (ADR-0020), each from a fresh
//      account holding the bounty's native seed, then roll them back: on Base the cheat
//      (HonestUser.s.sol, buying through Uniswap V2) and the sealed exploit (SEALED_EXPLOIT);
//      on Arbitrum One the sealed exploit, since the agent may win on either chain.
//   5. Write every recorded account (code, balance, nonce) and slot back onto the fork with its
//      current value, which puts it in the fork's own state; dump that.
//   On each chain, before the claims, the drain bot's fork test runs against this vault.
//   6. Load the dump into a plain anvil with the chain's ID and hardfork and check its blocks'
//      state roots are real: non-zero, and the root `eth_getProof` proves against.
// Rebuilding the copy changes it, so #59's claim rehearsal (mainnet-state-claims.test.ts) is
// rerun on each rebuild: it is what shows the claims replay on the copy.
// It also records the deploy gas against the preflight's budget (DEMO_DEPLOY_GAS): measured on
// Base's fork; on Arbitrum One the fork's figure plus the L1 part anvil leaves out, from the real
// RPC's NodeInterface (`gasEstimateL1Component`), cross-checked by the real RPC's own
// `eth_estimateGas` for the vault's creation.
//
// Needs anvil, forge and cast, and SEALED_EXPLOIT (the sealed exploit script's path, never in
// this repo) for Base's claim reads. Spends nothing: every transaction runs on a local fork.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { PAUSE_GAS_PER_PAUSE, pauseRole, type BountyId } from "@bountee/formats";
import { rpc } from "../../src/proofs.ts";
import { DEMO_DEPLOY_GAS, VAULT_USDC } from "../testnet/deploy.ts";
import { sealedExploit } from "../testnet/sealed-exploit.ts";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const demo = join(repo, "demo");
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const OUT = resolve(arg("out") ?? join(repo, ".bountee/mainnet-state"));
/** The demo bounty as #35 posts it (`--name` overrides): its name fixes the pause-role address. */
const BOUNTY: BountyId = { protocol: "demo.bountee.near", name: arg("name") ?? "demo" };
const CONTRACT = "bounty2.bountee.near";
/** The mainnet bounty contract's seed for a claim's fresh accounts (`config().seed`). */
const SEED_NATIVE = 10n ** 18n;
/** How far behind each chain's head the fork starts, so every public RPC has the block. */
const BEHIND = 5;

interface ChainPlan {
  id: number;
  name: string;
  rpc: string;
  usdc: string;
  /** Circle's FiatToken keeps balances in `balanceAndBlacklistStates`, slot 9. */
  balanceSlot: bigint;
  /** The claims proven on this chain whose reads go into the copy. */
  claims: ("cheat" | "win")[];
}
const CHAINS: ChainPlan[] = [
  { id: 8453, name: "Base", rpc: process.env.BASE_RPC ?? "https://mainnet.base.org", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", balanceSlot: 9n, claims: ["cheat", "win"] },
  { id: 42161, name: "Arbitrum One", rpc: process.env.ARBITRUM_RPC ?? "https://arb1.arbitrum.io/rpc", usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", balanceSlot: 9n, claims: ["win"] },
];

/** The judge build bounty2.bountee.near pins: `bountee build --contract bounty2.bountee.near --rev e472404` (R15.2). */
const PINNED_JUDGE = "0x497dc9b792d15fc32fdaf56cd663a3f3929c700839c2ecce89e1fa05242f3384";
/**
 * The copy's own EVM, for building it and serving its proofs; judge/tests/seam_j_mainnet_state.rs loads with the same.
 * The judge replays each claim under its chain's compiled profile (ADR-0020: Arbitrum One on Osaka with its 32M gas
 * cap and randomness 1), not under this, so the copy's hardfork never decides a verdict.
 */
const HARDFORK = "prague";
/** Blocks mined on a loaded state before use: `bountee test` judges a block three behind the head, and the first is the dumped fork block, whose root is zero. */
const MINED_ON_LOAD = 5; // as judge/tests/seam_j_mainnet_state.rs mines

const hex = (n: bigint) => `0x${n.toString(16)}`;
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}`;
const port = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });

async function anvil(args: string[]): Promise<{ url: string; proc: ChildProcess }> {
  const p = await port();
  const proc = spawn("anvil", [...args, "--port", String(p), "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${p}`;
  for (let i = 0; ; i++) {
    try {
      await rpc(url, "eth_chainId", []);
      return { url, proc };
    } catch (e) {
      if (i > 300 || proc.exitCode !== null) throw new Error(`anvil didn't start: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

function run(cmd: string, args: string[], cwd: string, env: Record<string, string> = {}): string {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(`${cmd} ${args[0]} failed:\n${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

interface Tx {
  from: string;
  to: string | null;
  input: string;
  value: string;
}

/** A Foundry script's transactions, simulated by forge against `url` as `sender` and not sent. */
function scriptTxs(script: string, url: string, chainId: number, sender: string, env: Record<string, string>): Tx[] {
  const root = dirname(dirname(script));
  run("forge", ["script", script, "--root", root, "--rpc-url", url, "--sender", sender, "--slow"], root, env);
  const log = JSON.parse(readFileSync(join(root, "broadcast", script.split("/").pop()!, String(chainId), "dry-run", "run-latest.json"), "utf8"));
  return log.transactions.map(({ transaction: t }: any) => ({
    from: t.from.toLowerCase(),
    to: t.to ? t.to.toLowerCase() : null,
    input: t.input ?? t.data ?? "0x",
    value: t.value ?? "0x0",
  }));
}

/**
 * A sent transaction's receipt. Anvil answers `eth_sendTransaction` before its block is mined, and
 * on an Arbitrum One fork mining takes long enough that an immediate lookup returns null.
 */
async function receiptOf(url: string, hash: string): Promise<{ status: string; gasUsed: string; contractAddress: string | null }> {
  for (let i = 0; ; i++) {
    const receipt = await rpc<{ status: string; gasUsed: string; contractAddress: string | null } | null>(url, "eth_getTransactionReceipt", [hash]);
    if (receipt) return receipt;
    if (i > 600) throw new Error(`no receipt for ${hash} after 60 s`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Every account and slot the transactions touch, as each is sent in turn on `url`; returns their receipts. */
async function sendRecording(url: string, txs: Tx[], reads: Map<string, Set<string>>): Promise<{ gasUsed: bigint; created: string | null }[]> {
  const receipts: { gasUsed: bigint; created: string | null }[] = [];
  for (const t of txs) {
    // forge's gas guess for the fork can be short (it is on Arbitrum One's), so the fork estimates its own.
    const call = { from: t.from, ...(t.to ? { to: t.to } : {}), data: t.input, value: t.value };
    const list = await rpc<{ accessList: { address: string; storageKeys: string[] }[] }>(url, "eth_createAccessList", [call, "latest"]);
    for (const a of [t.from, ...(t.to ? [t.to] : [])]) if (!reads.has(a)) reads.set(a, new Set());
    for (const { address, storageKeys } of list.accessList) {
      const set = reads.get(address.toLowerCase()) ?? new Set<string>();
      for (const k of storageKeys) set.add(k.toLowerCase());
      reads.set(address.toLowerCase(), set);
    }
    await rpc(url, "anvil_impersonateAccount", [t.from]);
    const hash = await rpc<string>(url, "eth_sendTransaction", [call]);
    const receipt = await receiptOf(url, hash);
    if (receipt.status !== "0x1") throw new Error(`a transaction reverted on the fork: ${hash}`);
    receipts.push({ gasUsed: BigInt(receipt.gasUsed), created: receipt.contractAddress?.toLowerCase() ?? null });
  }
  return receipts;
}

/** Writes each account and slot back with its current value, so the fork's own state holds it. */
async function materialize(url: string, reads: Map<string, Set<string>>) {
  for (const [address, slots] of reads) {
    const [code, balance, nonce] = await Promise.all([
      rpc<string>(url, "eth_getCode", [address, "latest"]),
      rpc<string>(url, "eth_getBalance", [address, "latest"]),
      rpc<string>(url, "eth_getTransactionCount", [address, "latest"]),
    ]);
    if (code !== "0x") await rpc(url, "anvil_setCode", [address, code]);
    await rpc(url, "anvil_setBalance", [address, balance]);
    await rpc(url, "anvil_setNonce", [address, nonce]);
    for (const slot of slots) {
      await rpc(url, "anvil_setStorageAt", [address, slot, await rpc<string>(url, "eth_getStorageAt", [address, slot, "latest"])]);
    }
  }
}

/** Arbitrum's L1 gas for a transaction, which anvil leaves out (NodeInterface, read-only on the real RPC). */
function arbitrumL1Gas(rpcUrl: string, t: Tx): bigint {
  const out = run("cast", [
    "call", "0x00000000000000000000000000000000000000C8",
    "gasEstimateL1Component(address,bool,bytes)(uint64,uint256,uint256)",
    t.to ?? "0x0000000000000000000000000000000000000000", t.to ? "false" : "true", t.input, "--rpc-url", rpcUrl,
  ], repo);
  return BigInt(out.trim().split("\n")[0]!.split(" ")[0]!);
}

async function build(chain: ChainPlan, role: string) {
  const head = Number(BigInt(await rpc<string>(chain.rpc, "eth_blockNumber", [])));
  const forkBlock = head - BEHIND;
  const fork = await anvil(["--fork-url", chain.rpc, "--fork-block-number", String(forkBlock)]);
  try {
    const reads = new Map<string, Set<string>>();
    const deployer = `0x${randomBytes(20).toString("hex")}`;
    await rpc(fork.url, "anvil_setBalance", [deployer, hex(10n ** 18n)]);
    // The deployer's USDC: Circle's balance word for it, written straight into the fork.
    const balanceKey = `0x${Buffer.from(keccak_256(Buffer.from(word(BigInt(deployer)).slice(2) + word(chain.balanceSlot).slice(2), "hex"))).toString("hex")}`;
    await rpc(fork.url, "anvil_setStorageAt", [chain.usdc, balanceKey, word(VAULT_USDC)]);
    const held = BigInt(run("cast", ["call", chain.usdc, "balanceOf(address)(uint256)", deployer, "--rpc-url", fork.url], repo).trim().split(" ")[0]!);
    if (held !== VAULT_USDC) throw new Error(`${chain.name}: the deployer's USDC reads ${held}, not ${VAULT_USDC}: Circle's balance slot moved`);
    await rpc(fork.url, "anvil_setBalance", [role, hex(PAUSE_GAS_PER_PAUSE)]);

    const deployTxs = scriptTxs(join(demo, "script/Deploy.s.sol"), fork.url, chain.id, deployer, {
      USDC: chain.usdc, SEED_USDC: VAULT_USDC.toString(), PAUSE_ROLE: role,
    });
    const deployed = await sendRecording(fork.url, deployTxs, reads);
    // On mainnet Deploy.s.sol creates one contract, the vault, then approves and deposits.
    const vault = deployed.find((r) => r.created)?.created;
    if (!vault) throw new Error(`${chain.name}: Deploy.s.sol created no vault`);
    // ADR-0019's evidence on this vault: the drain bot's own code (on the fork, from mainnet) as
    // the position is refused and the vault's USDC doesn't move. Throws if the test fails.
    const bot = run("forge", ["test", "--match-contract", "PositionVaultBotForkTest"], demo, { FORK_RPC: fork.url, VAULT: vault, FOUNDRY_PROFILE: "fork" });
    if (!/\[PASS\] test_real_bot_code_as_its_own_position_is_refused/.test(bot)) throw new Error(`${chain.name}: the drain bot's fork test didn't run:\n${bot}`);
    // The pause-gas transfer the fresh-instance script sends: a plain transfer.
    const transferGas = 21_000n;
    const l1Gas = chain.id === 42161 ? deployTxs.reduce((sum, t) => sum + arbitrumL1Gas(chain.rpc, t), 0n) : 0n;
    // A cross-check of the fork's figure on Arbitrum One itself: the vault's creation needs no
    // state, so the real RPC estimates it (L1 part included); the approve and deposit need the
    // vault, which only the fork has.
    const createEstimate = chain.id === 42161
      ? BigInt(await rpc<string>(chain.rpc, "eth_estimateGas", [{ from: deployer, data: deployTxs[0]!.input }]))
      : null;
    // The real estimate runs a little above the fork's gas used (an estimate pads the 63/64 gas a
    // creation keeps back, and adds the L1 part); far above means the fork misprices Arbitrum.
    if (createEstimate !== null && createEstimate > (deployed[0]!.gasUsed * 105n) / 100n + l1Gas) {
      throw new Error(`${chain.name}: the real chain estimates the vault's creation at ${createEstimate} gas, over 5% above the fork's ${deployed[0]!.gasUsed}`);
    }
    const deployTotal = deployed.reduce((a, r) => a + r.gasUsed, 0n) + transferGas + l1Gas;
    if (deployTotal > DEMO_DEPLOY_GAS) throw new Error(`${chain.name}: deploying takes ${deployTotal} gas, over the ${DEMO_DEPLOY_GAS} the preflight budgets`);

    if (chain.claims.length > 0) {
      const snapshot = await rpc<string>(fork.url, "evm_snapshot", []);
      const claimant = () => `0x${randomBytes(20).toString("hex")}`;
      const scripts = { cheat: join(demo, "script/HonestUser.s.sol"), win: sealedExploit() };
      for (const script of chain.claims.map((kind) => scripts[kind])) {
        const env = { VAULT: vault };
        const from = claimant();
        await rpc(fork.url, "anvil_setBalance", [from, hex(SEED_NATIVE)]);
        await sendRecording(fork.url, scriptTxs(script, fork.url, chain.id, from, env), reads);
        // A fresh account is fresh: its own state never goes into the copy.
        reads.delete(from);
      }
      await rpc(fork.url, "evm_revert", [snapshot]);
    }
    await materialize(fork.url, reads);
    const dump = await rpc<string>(fork.url, "anvil_dumpState", []);
    const raw = Buffer.from(dump.slice(2), "hex");
    const state = JSON.parse((raw[0] === 0x1f ? gunzipSync(raw) : raw).toString("utf8"));
    const file = join(OUT, `${chain.id}-state.json`);
    writeFileSync(file, JSON.stringify(state));
    return {
      vault, forkBlock, file, accounts: reads.size, deployGas: deployed.reduce((a, r) => a + r.gasUsed, 0n) + transferGas, l1Gas,
      createGas: deployed[0]!.gasUsed, createEstimate,
    };
  } finally {
    fork.proc.kill();
  }
}

/** Loads a state file into a plain anvil and checks its blocks carry the state root `eth_getProof` proves against. */
export async function loadState(file: string, chainId: number): Promise<{ url: string; proc: ChildProcess; stateRoot: string }> {
  const chain = await anvil(["--load-state", file, "--chain-id", String(chainId), "--hardfork", HARDFORK]);
  await rpc(chain.url, "anvil_mine", [hex(BigInt(MINED_ON_LOAD))]);
  const block = await rpc<{ stateRoot: string }>(chain.url, "eth_getBlockByNumber", ["latest", false]);
  return { ...chain, stateRoot: block.stateRoot };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  mkdirSync(OUT, { recursive: true });
  const role = pauseRole.address(pauseRole.MAINNET_ROOT_PUBLIC_KEY, CONTRACT, BOUNTY).toLowerCase();
  const chains: any[] = [];
  for (const chain of CHAINS) {
    const b = await build(chain, role);
    const loaded = await loadState(b.file, chain.id);
    try {
      const proof = await rpc<{ accountProof: string[] }>(loaded.url, "eth_getProof", [b.vault, [], "latest"]);
      const proven = `0x${Buffer.from(keccak_256(Buffer.from(proof.accountProof[0]!.slice(2), "hex"))).toString("hex")}`;
      if (/^0x0+$/.test(loaded.stateRoot) || proven !== loaded.stateRoot) {
        throw new Error(`${chain.name}: the loaded state's root ${loaded.stateRoot} isn't the one eth_getProof proves (${proven})`);
      }
      chains.push({
        chain_id: chain.id, name: chain.name, state: b.file, vault: b.vault, usdc: chain.usdc, vault_usdc: VAULT_USDC.toString(),
        fork_block: b.forkBlock, accounts: b.accounts, state_root: loaded.stateRoot, drain_bot: "refused, vault USDC unchanged",
        deploy_gas: b.deployGas.toString(), arbitrum_l1_gas: b.l1Gas.toString(), deploy_gas_with_l1: (b.deployGas + b.l1Gas).toString(),
        deploy_gas_budget: DEMO_DEPLOY_GAS.toString(),
        ...(b.createEstimate === null ? {} : { vault_create_gas_on_fork: b.createGas.toString(), vault_create_estimate_on_arbitrum_one: b.createEstimate.toString() }),
      });
      console.error(`${chain.name}: vault ${b.vault}, ${b.accounts} accounts copied, root ${loaded.stateRoot}, deploy gas ${b.deployGas + b.l1Gas}`);
    } finally {
      loaded.proc.kill();
    }
  }
  // The demo bounty's mainnet rules (ADR-0018, ADR-0020), for the posting check and the
  // claims: each covered chain lists its own USDC at price 1 and its native coin at 0.
  const rules = {
    covered_contracts: chains.map((c) => ({ chain_id: c.chain_id, address: c.vault })),
    recency_limit_secs: 300,
    listed_tokens: chains.flatMap((c) => [
      { chain_id: c.chain_id, token: c.usdc, price: "1" },
      { chain_id: c.chain_id, token: "native", price: "0" },
    ]),
    seed: { native: SEED_NATIVE.toString(), tokens: [] },
    bounty_amount: "10000000",
    minimum_theft: "1000000",
    end_date_ns: String(BigInt(Date.now() + 30 * 86_400_000) * 1_000_000n),
    disclosure_delay_days: 1,
    exploit_public_key: "x25519:6W7B3sSYk1p2DZ7FXyRbJWDNiaRfVTj1hm6k8Cqnq6wA",
    judge_build_hash: PINNED_JUDGE,
  };
  const manifest = { bounty: BOUNTY, contract: CONTRACT, pause_role: role, built_at: new Date().toISOString(), rules, chains };
  writeFileSync(join(OUT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(JSON.stringify(manifest));
}
