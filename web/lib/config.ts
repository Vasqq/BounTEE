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
}

const env = (name: string, fallback: string) => process.env[name] || fallback;

/** The chains a bounty can cover: those NEAR's MPC network can sign and verify a pause on. */
export function chains(): Record<number, ChainInfo> {
  return {
    8453: { id: 8453, name: "Base", gasToken: "ETH", rpc: env("EVM_RPC_8453", "https://mainnet.base.org"), explorer: "https://basescan.org/", explorerTx: "https://basescan.org/tx/" },
    42161: { id: 42161, name: "Arbitrum One", gasToken: "ETH", rpc: env("EVM_RPC_42161", "https://arb1.arbitrum.io/rpc"), explorer: "https://arbiscan.io/", explorerTx: "https://arbiscan.io/tx/" },
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
    nearExplorer: "https://nearblocks.io/",
    nearExplorerTx: "https://nearblocks.io/txns/",
    contract: env("BOUNTY_CONTRACT", "bounty.bountee.near"),
    /** The mainnet demo bounty the landing page tells (ADR-0018), as `<protocol>/<name>`; unset until it is posted. */
    demoBounty: process.env.DEMO_BOUNTY || null,
    chains: chains(),
  };
}

export type Config = ReturnType<typeof config>;
