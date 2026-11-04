// The EVM chains BounTEE knows, and their ordinary public RPCs: the one place the tool and
// its tests take an RPC from when none is given (`--rpc`).

export interface Chain {
  name: string;
  /** Public RPCs in order of preference; the first is the default for sending and reading. */
  rpcs: string[];
  /** Those known to serve `eth_getProof` at recent blocks, for `test` (spec, RPCs). */
  proofRpcs: string[];
}

export const CHAINS: Record<number, Chain> = {
  84532: {
    name: "Base Sepolia",
    rpcs: ["https://sepolia.base.org", "https://84532.rpc.thirdweb.com"],
    proofRpcs: ["https://sepolia.base.org", "https://84532.rpc.thirdweb.com"],
  },
  421614: { name: "Arbitrum Sepolia", rpcs: ["https://sepolia-rollup.arbitrum.io/rpc"], proofRpcs: [] },
  8453: { name: "Base", rpcs: ["https://mainnet.base.org"], proofRpcs: [] },
  42161: { name: "Arbitrum One", rpcs: ["https://arb1.arbitrum.io/rpc"], proofRpcs: [] },
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
