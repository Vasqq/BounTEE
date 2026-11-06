// Every endpoint and account the web app reads, read from the environment at request time on
// the server, with mainnet's as the defaults (ADR-0017). The network is a deployment setting,
// never a control on the page. Only server code imports this: the browser gets what it needs
// (an EVM RPC to send a signed pause to) inside the data the server hands it.

export interface ChainInfo {
  id: number;
  /** Written in full, as the design system asks: "Arbitrum One", never "Arbitrum". */
  name: string;
  /** The chain's gas token, for pause gas. */
  gasToken: string;
  rpc: string;
  explorer: string;
  explorerTx: string;
  /** Circle's USDC there: what a bounty's theft is valued in by default. */
  usdc: string;
}

const env = (name: string, fallback: string) => process.env[name] || fallback;

/** The chains a bounty can cover: those NEAR's MPC network can sign and verify a pause on. */
export function chains(): Record<number, ChainInfo> {
  return {
    8453: { id: 8453, name: "Base", gasToken: "ETH", rpc: env("EVM_RPC_8453", "https://mainnet.base.org"), explorer: "https://basescan.org/", explorerTx: "https://basescan.org/tx/", usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
    42161: { id: 42161, name: "Arbitrum One", gasToken: "ETH", rpc: env("EVM_RPC_42161", "https://arb1.arbitrum.io/rpc"), explorer: "https://arbiscan.io/", explorerTx: "https://arbiscan.io/tx/", usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  };
}

export function config() {
  return {
    /** NEAR RPC. FastNEAR's free RPC, as the command-line tool uses (cli/src/endpoints.ts). */
    nearRpc: env("NEAR_RPC", "https://free.rpc.fastnear.com"),
    /** For transactions an ordinary RPC no longer keeps (about two and a half days). */
    nearArchivalRpc: env("NEAR_ARCHIVAL_RPC", "https://archival-rpc.mainnet.fastnear.com"),
    /** FastNEAR's explorer API: says which transactions to look at; trusted for nothing. */
    txApi: env("TX_API", "https://tx.main.fastnear.com"),
    /** OutLayer's API, for the winning claim's attestation. */
    outlayerApi: env("OUTLAYER_API", "https://api.outlayer.ai"),
    nearExplorer: "https://nearblocks.io/",
    nearExplorerTx: "https://nearblocks.io/txns/",
    contract: env("BOUNTY_CONTRACT", "bounty.bountee.near"),
    /** The mainnet demo bounty the landing page tells (ADR-0018), as `<protocol>/<name>`; unset until it is posted. */
    demoBounty: process.env.DEMO_BOUNTY || null,
    chains: chains(),
    /** NEAR's Ethereum-compatible RPC (NEP-518), through which MetaMask signs as a 0x… NEAR account. */
    nearEth: { chainId: 397, rpc: env("NEAR_ETH_RPC", "https://eth-rpc.mainnet.near.org") },
  };
}

export type Config = ReturnType<typeof config>;
