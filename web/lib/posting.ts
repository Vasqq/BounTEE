// What the posting flow needs to know, read live (D5, D13, D17): the contract's fees and the
// rules BounTEE sets, the Protocol's NEAR account, and per covered contract whether the
// pause-role grant and the pause gas are in place. A grant is checked the way the posting
// check proves it (R12.1): `pause()` called from the bounty's pause-role address doesn't revert.
import { base58 } from "@scure/base";
import { encodeFunctionData, keccak256, toHex } from "viem";
import { config } from "./config.ts";
import { PAUSE_GAS_LIMIT } from "@bountee/formats";
import { rpc as evmRpc } from "@bountee/cli/src/proofs.ts";
import { balance } from "./evm.ts";
import { rpc, view } from "./near.ts";

const PAUSE = "0x8456cb59";
/** OpenZeppelin AccessControl's pauser role, the one standard pause-role grant. */
export const PAUSER_ROLE = keccak256(toHex("PAUSER_ROLE"));
const ACCESS_CONTROL = [
  { type: "function", name: "grantRole", stateMutability: "nonpayable", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [] },
  { type: "function", name: "hasRole", stateMutability: "view", inputs: [{ name: "role", type: "bytes32" }, { name: "account", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

/** A transaction to send from the Protocol's wallet or multisig (D14). */
export interface EvmCall {
  chainId: number;
  to: string;
  data: string;
  value: string;
}

export interface CoveredStatus {
  chainId: number;
  chain: string;
  address: string;
  /** `pause()` from the pause-role address succeeds now. */
  granted: boolean;
  /** The grant as one transaction, when the contract uses AccessControl; null when it must be granted its own way. */
  grant: EvmCall | null;
}

export interface GasStatus {
  chainId: number;
  chain: string;
  token: string;
  held: string;
  needed: string;
  /** What to send, in wei, when short. */
  short: string;
  ok: boolean;
}

/** What the rules step needs before a wallet connects: the same for every Protocol. */
export interface PostingBasics {
  contract: string;
  usdc: string;
  usdcDecimals: number;
  /** The chains a bounty can cover, and the USDC each values theft in. */
  chains: { id: number; name: string; usdc: string; explorerTx: string }[];
  postingFee: string;
  /** Rules BounTEE sets, not the Protocol (R1.1, R1.3). */
  fixed: { recency_limit_secs: number; seed: unknown; judge_build_hash: string };
  nearEth: { chainId: number; rpc: string };
}

export interface PostingStatus extends PostingBasics {
  nameTaken: boolean;
  /** The bounty's state once posted under this name; null before. */
  bountyState: string | null;
  pauseRole: string;
  /** NEAR the account needs: what the posting fee balance lacks, plus gas for the two prompts. */
  nearNeeded: string;
  account: { near: string; postingFeeBalance: string; usdc: string; onboarded: boolean; relayerKey: string };
  covered: CoveredStatus[];
  gas: GasStatus[];
}

/** Gas for the two posting prompts: MetaMask checks a fee of about 0.15 NEAR for a 270 Tgas call (spec, posting flow). */
const GAS_MARGIN = 2n * 10n ** 23n;

/**
 * As the posting check does it (judge/src/posting.rs): the contract has code, and `pause()`
 * from the pause-role address succeeds within the pause's gas limit. A call to an address
 * with no code would succeed, so a mistyped address must not tick.
 */
async function simulatePause(url: string, from: string, to: string): Promise<boolean> {
  const code = await evmRpc<string>(url, "eth_getCode", [to, "latest"]).catch(() => "0x");
  if (!code || code === "0x") return false;
  return evmRpc<string>(url, "eth_call", [{ from, to, data: PAUSE, gas: `0x${PAUSE_GAS_LIMIT.toString(16)}` }, "latest"]).then(
    () => true,
    () => false,
  );
}

async function usesAccessControl(url: string, to: string, account: string): Promise<boolean> {
  const data = encodeFunctionData({ abi: ACCESS_CONTROL, functionName: "hasRole", args: [PAUSER_ROLE, account as `0x${string}`] });
  return evmRpc<string>(url, "eth_call", [{ to, data }, "latest"]).then(
    (r) => typeof r === "string" && r.length === 66,
    () => false,
  );
}

async function readContract(c: ReturnType<typeof config>) {
  const [cfg, fees] = await Promise.all([
    view<{ usdc: string; seed: unknown; judge_build_hash: string }>(c, c.contract, "config"),
    view<{ posting_fee: string; pause_gas_per_pause: string }>(c, c.contract, "fees"),
  ]);
  const meta = await view<{ decimals: number }>(c, cfg.usdc, "ft_metadata");
  const basics: PostingBasics = {
    contract: c.contract,
    usdc: cfg.usdc,
    usdcDecimals: meta.decimals,
    chains: Object.values(c.chains).map((x) => ({ id: x.id, name: x.name, usdc: x.usdc, explorerTx: x.explorerTx })),
    postingFee: fees.posting_fee,
    fixed: { recency_limit_secs: 300, seed: cfg.seed, judge_build_hash: cfg.judge_build_hash },
    nearEth: c.nearEth,
  };
  return { basics, pauseGasPerPause: BigInt(fees.pause_gas_per_pause) };
}

export async function readBasics(): Promise<PostingBasics> {
  return (await readContract(config())).basics;
}

export async function readPosting(protocol: string, name: string, covered: { chainId: number; address: string }[]): Promise<PostingStatus> {
  const c = config();
  const id = { protocol, name };
  const [{ basics, pauseGasPerPause }, existing, role] = await Promise.all([
    readContract(c),
    view<{ state: string } | null>(c, c.contract, "bounty", { id }),
    view<{ address: string }>(c, c.contract, "pause_role", { id }),
  ]);
  const [feeBalance, usdc, account, relayer] = await Promise.all([
    view<string>(c, c.contract, "posting_fee_balance", { account_id: protocol }).catch(() => "0"),
    view<string>(c, basics.usdc, "ft_balance_of", { account_id: protocol }).catch(() => "0"),
    rpc<{ amount: string }>(c.nearRpc, "query", { request_type: "view_account", finality: "final", account_id: protocol }).catch(() => null),
    rpc<{ public_key: string }>(c.nearEth.rpc, "near_getPublicKey", []),
  ]);
  const relayerKey = `ed25519:${base58.encode(Buffer.from(relayer.public_key, "hex"))}`;
  const onboarded = await rpc(c.nearRpc, "query", { request_type: "view_access_key", finality: "final", account_id: protocol, public_key: relayerKey }).then(
    () => true,
    () => false,
  );

  const coveredStatus = await Promise.all(
    covered.map(async (x) => {
      const chain = c.chains[x.chainId];
      if (!chain) return { chainId: x.chainId, chain: `chain ${x.chainId}`, address: x.address, granted: false, grant: null };
      const [granted, ac] = await Promise.all([simulatePause(chain.rpc, role.address, x.address), usesAccessControl(chain.rpc, x.address, role.address)]);
      const grant = ac
        ? { chainId: x.chainId, to: x.address, value: "0", data: encodeFunctionData({ abi: ACCESS_CONTROL, functionName: "grantRole", args: [PAUSER_ROLE, role.address as `0x${string}`] }) }
        : null;
      return { chainId: x.chainId, chain: chain.name, address: x.address, granted, grant };
    }),
  );
  const perChain = new Map<number, number>();
  for (const x of covered) perChain.set(x.chainId, (perChain.get(x.chainId) ?? 0) + 1);
  const gas = await Promise.all(
    [...perChain].filter(([id]) => c.chains[id]).map(async ([chainId, n]) => {
      const chain = c.chains[chainId]!;
      const held = await balance(chain.rpc, role.address);
      const needed = pauseGasPerPause * BigInt(n);
      return { chainId, chain: chain.name, token: chain.gasToken, held: held.toString(), needed: needed.toString(), short: (needed > held ? needed - held : 0n).toString(), ok: held >= needed };
    }),
  );
  const postingFee = BigInt(basics.postingFee);
  const lacking = postingFee > BigInt(feeBalance) ? postingFee - BigInt(feeBalance) : 0n;
  return {
    ...basics,
    nameTaken: existing !== null,
    bountyState: existing?.state ?? null,
    pauseRole: role.address,
    nearNeeded: (lacking + GAS_MARGIN).toString(),
    account: { near: account?.amount ?? "0", postingFeeBalance: String(feeBalance), usdc: String(usdc), onboarded, relayerKey },
    covered: coveredStatus,
    gas,
  };
}
