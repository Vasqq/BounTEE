// The EVM chains BounTEE knows, and their ordinary public RPCs: the one place the tool and
// its tests take an RPC from when none is given (`--rpc`), and the one reader of a transaction's
// receipt there.
import { rpc } from "./proofs.ts";

export interface Chain {
  name: string;
  /** Public RPCs in order of preference; the first is the default for sending and reading. */
  rpcs: string[];
  /** Those known to serve `eth_getProof` at recent blocks, for `test` (spec, RPCs). */
  proofRpcs: string[];
  /** A block explorer's page for a transaction, for receipts' links. */
  explorerTx: string;
  /**
   * The RPCs the judge's build pins for this chain as a proof chain (`judge/src/confirm.rs`
   * `PINNED`; at least two must agree, ADR-0014), shown as a trusted party. The judge build,
   * named by its hash, is what binds them; keep this list equal to it.
   */
  judgeRpcs?: string[];
}

export const CHAINS: Record<number, Chain> = {
  84532: {
    name: "Base Sepolia",
    rpcs: ["https://sepolia.base.org", "https://84532.rpc.thirdweb.com"],
    proofRpcs: ["https://sepolia.base.org", "https://84532.rpc.thirdweb.com"],
    explorerTx: "https://sepolia.basescan.org/tx/",
    judgeRpcs: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.gateway.tenderly.co"],
  },
  421614: {
    name: "Arbitrum Sepolia",
    rpcs: ["https://sepolia-rollup.arbitrum.io/rpc", "https://421614.rpc.thirdweb.com"],
    proofRpcs: ["https://sepolia-rollup.arbitrum.io/rpc", "https://421614.rpc.thirdweb.com"],
    explorerTx: "https://sepolia.arbiscan.io/tx/",
    judgeRpcs: [
      "https://sepolia-rollup.arbitrum.io/rpc",
      "https://arbitrum-sepolia-rpc.publicnode.com",
      "https://arbitrum-sepolia.gateway.tenderly.co",
    ],
  },
  8453: { name: "Base", rpcs: ["https://mainnet.base.org"], proofRpcs: [], explorerTx: "https://basescan.org/tx/" },
  42161: { name: "Arbitrum One", rpcs: ["https://arb1.arbitrum.io/rpc"], proofRpcs: [], explorerTx: "https://arbiscan.io/tx/" },
};

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
