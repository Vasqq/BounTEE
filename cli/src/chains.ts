// The EVM chains BounTEE knows, and their ordinary public RPCs: the one place the tool and
// its tests take an RPC from when none is given (`--rpc`), and the one reader of a transaction's
// receipt there.
import { rpc } from "./proofs.ts";

export interface Chain {
  name: string;
  /** The names `--chain` takes for it, in any case (D26), beside its chain ID. */
  names: string[];
  /** Public RPCs in order of preference; the first is the default for sending and reading. */
  rpcs: string[];
  /** Those known to serve `eth_getProof` at recent blocks, for `test` (spec, RPCs). */
  proofRpcs: string[];
  /** A block explorer's page for a transaction, for receipts' links. */
  explorerTx: string;
  /**
   * The RPCs the judge's build pins for this chain as a proof chain (`judge/src/confirm.rs`
   * `TESTNET` or `MAINNET`, the build's network's; at least two must agree, ADR-0014), shown as a trusted party. The judge build,
   * named by its hash, is what binds them; keep this list equal to it.
   */
  judgeRpcs?: string[];
  /** Circle's USDC on a mainnet chain (spec, demo contracts); testnet demos mint a mock. */
  usdc?: string;
}

export const CHAINS: Record<number, Chain> = {
  84532: {
    name: "Base Sepolia",
    names: ["base-sepolia"],
    rpcs: ["https://sepolia.base.org", "https://84532.rpc.thirdweb.com"],
    proofRpcs: ["https://sepolia.base.org", "https://84532.rpc.thirdweb.com"],
    explorerTx: "https://sepolia.basescan.org/tx/",
    judgeRpcs: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.gateway.tenderly.co"],
  },
  421614: {
    name: "Arbitrum Sepolia",
    names: ["arbitrum-sepolia"],
    rpcs: ["https://sepolia-rollup.arbitrum.io/rpc", "https://421614.rpc.thirdweb.com"],
    proofRpcs: ["https://sepolia-rollup.arbitrum.io/rpc", "https://421614.rpc.thirdweb.com"],
    explorerTx: "https://sepolia.arbiscan.io/tx/",
    judgeRpcs: [
      "https://sepolia-rollup.arbitrum.io/rpc",
      "https://arbitrum-sepolia-rpc.publicnode.com",
      "https://arbitrum-sepolia.gateway.tenderly.co",
    ],
  },
  8453: {
    name: "Base",
    names: ["base"],
    rpcs: ["https://mainnet.base.org", "https://8453.rpc.thirdweb.com"],
    // Not mainnet.base.org: it answers "no state found" for a proof 100 blocks back (Nov 5).
    // dRPC first: a fork through it took 5-6 s on Nov 10, through thirdweb 37-52 s, and the claim's
    // proofs must be fetched and filed inside the 300 s recency limit. Both free tiers rate-limit
    // an IP that forks Base many times in a row (HTTP 429), so either one may be the one answering.
    proofRpcs: ["https://base.drpc.org", "https://8453.rpc.thirdweb.com"],
    explorerTx: "https://basescan.org/tx/",
    judgeRpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.gateway.tenderly.co"],
    usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
  },
  42161: {
    name: "Arbitrum One",
    names: ["arbitrum", "arbitrum-one"],
    rpcs: ["https://arb1.arbitrum.io/rpc", "https://42161.rpc.thirdweb.com"],
    // Not PublicNode: it wants a token for proofs 100 blocks back (Nov 5).
    proofRpcs: ["https://arb1.arbitrum.io/rpc", "https://42161.rpc.thirdweb.com"],
    explorerTx: "https://arbiscan.io/tx/",
    judgeRpcs: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com", "https://arbitrum.gateway.tenderly.co"],
    usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
  },
};

/**
 * The chain `--chain` names (D26): a known chain's name, in any case, or a chain ID; undefined
 * when the flag isn't given. Every command reads the flag through here.
 */
export function parseChain(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const names = Object.entries(CHAINS).flatMap(([id, c]) => c.names.map((name) => [name, Number(id)] as const));
  const named = names.find(([name]) => name === text.toLowerCase());
  if (named) return named[1];
  if (/^[1-9][0-9]*$/.test(text) && Number.isSafeInteger(Number(text))) return Number(text);
  throw new Error(`--chain takes a chain ID or one of ${names.map(([name]) => name).join(", ")}: got ${text}`);
}

/** A chain as people read it: "Arbitrum Sepolia (421614)", or "chain 31337" for one BounTEE doesn't know. */
export function chainLabel(chainId: number): string {
  const name = CHAINS[chainId]?.name;
  return name ? `${name} (${chainId})` : `chain ${chainId}`;
}

/** The chain's default public RPC, if BounTEE knows the chain. */
export function defaultRpc(chainId: number): string | undefined {
  return CHAINS[chainId]?.rpcs[0];
}

/** Every known chain's default RPC, by chain ID. */
export function defaultRpcs(): Record<number, string> {
  return Object.fromEntries(Object.entries(CHAINS).map(([id, c]) => [Number(id), c.rpcs[0]!]));
}

/** RPCs that serve proofs for the chain, in order of preference; empty if none is known. */
export function proofRpcs(chainId: number): string[] {
  return CHAINS[chainId]?.proofRpcs ?? [];
}

/** A link to the transaction on the chain's explorer, if BounTEE knows the chain. */
export function explorerTx(chainId: number, hash: string): string | undefined {
  const base = CHAINS[chainId]?.explorerTx;
  return base ? `${base}${hash}` : undefined;
}

/** A transaction's receipt on an EVM chain: whether it succeeded, its block, and the address it called. */
export interface EvmReceipt {
  status: "success" | "reverted";
  block: number;
  /** null for a contract creation. */
  to: string | null;
}

/** The transaction's receipt now, or null if it hasn't landed (or the RPC didn't answer). */
export async function evmReceipt(url: string, hash: string): Promise<EvmReceipt | null> {
  const r = await rpc<{ status: string; blockNumber: string; to?: string | null } | null>(url, "eth_getTransactionReceipt", [hash]).catch(() => null);
  return r ? { status: r.status === "0x1" ? "success" : "reverted", block: Number(r.blockNumber), to: r.to ?? null } : null;
}

/** The transaction's receipt once it lands, read every `intervalMs`; null if not landed by `untilMs`. */
export async function waitForEvmReceipt(url: string, hash: string, untilMs: number, intervalMs: number): Promise<EvmReceipt | null> {
  for (;;) {
    const r = await evmReceipt(url, hash);
    if (r || Date.now() > untilMs) return r;
    await new Promise((ok) => setTimeout(ok, intervalMs));
  }
}
