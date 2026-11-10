// The network table (D30, ADR-0021): every network value the web app reads, links to or
// signs with comes from here, and nothing else in web/app, web/components or web/lib names
// a chain ID, an explorer, an RPC host or a NEAR account (e2e/network-table.spec.ts checks).
// The server's config (lib/config.ts) and the browser's pinned values (lib/pinned.ts) and
// wallet setup (lib/wagmi.ts) all start from it.
//
// It runs in the browser as well as on the server, so it holds only what the browser needs,
// and only this build's network: the browser bundle carries no other network's value
// (e2e/landing.spec.ts checks for testnet's). The NEAR endpoints only the server reads
// (RPC, archival RPC, FastNEAR's explorer API, OutLayer's API, the NEAR explorer) are the
// command-line tool's own (cli/src/endpoints.ts), looked up by this table's `network` in
// lib/config.ts, so the two can't drift. The EVM chains are listed here, since the tool's
// chain table (cli/src/chains.ts) reads Node-only modules.
//
// Each browser override below is read as a literal `process.env.NEXT_PUBLIC_*`, the only
// form Next inlines into the browser bundle; each still wins over the table. The server's
// overrides are read at request time in lib/config.ts.
import type { Network } from "@bountee/cli/src/endpoints.ts";
import { pauseRole } from "@bountee/formats";
import type { Chain } from "viem";
import { arbitrum, base } from "viem/chains";

/** A covered chain's mark is its family's (DESIGN.md, Brand marks): a test chain shows its mainnet's. */
export type ChainFamily = "base" | "arbitrum";

export interface EvmChain {
  /** The viem chain the wallet setup asks MetaMask for. */
  viem: Chain;
  id: number;
  /** Written in full, as the design system asks: "Arbitrum One", never "Arbitrum". */
  name: string;
  family: ChainFamily;
  /** The chain's gas token, for pause gas. */
  gasToken: string;
  /** The server's RPC for this chain, unless `EVM_RPC_<id>` is set. */
  rpc: string;
  /** The browser wallet's RPC override (`NEXT_PUBLIC_EVM_RPC_<id>`); MetaMask's own when unset. */
  browserRpc: string | undefined;
  explorer: string;
  explorerTx: string;
  /** Circle's USDC there: what a bounty lists as theft valued one for one (D27). */
  usdc: string;
}

const MAINNET = {
  /** The network the command-line tool's `Near` client and the Verify command name. */
  network: "mainnet",
  bountyContract: "bounty.bountee.near",
  /** Circle's USDC on NEAR. */
  nearUsdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  /** The MPC network's root key a bounty's pause-role address is derived from (D25). */
  mpcRootPublicKey: pauseRole.MAINNET_ROOT_PUBLIC_KEY,
  /** The chains a bounty can cover: those NEAR's MPC network can sign and verify a pause on. */
  chains: [
    {
      viem: base,
      id: base.id,
      name: "Base",
      family: "base",
      gasToken: "ETH",
      rpc: "https://mainnet.base.org",
      browserRpc: process.env.NEXT_PUBLIC_EVM_RPC_8453 || undefined,
      explorer: "https://basescan.org/",
      explorerTx: "https://basescan.org/tx/",
      usdc: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
    },
    {
      viem: arbitrum,
      id: arbitrum.id,
      name: "Arbitrum One",
      family: "arbitrum",
      gasToken: "ETH",
      rpc: "https://arb1.arbitrum.io/rpc",
      browserRpc: process.env.NEXT_PUBLIC_EVM_RPC_42161 || undefined,
      explorer: "https://arbiscan.io/",
      explorerTx: "https://arbiscan.io/tx/",
      usdc: "0xaf88d065e77c8cc2239327c5edb3a432268e5831",
    },
  ],
  /** NEAR's Ethereum-compatible chain (NEP-518), through which MetaMask signs as a 0x… NEAR account. */
  nearEvm: {
    id: 397,
    /** As NEAR's ethereum-wallets module names it. */
    name: "NEAR Protocol",
    rpc: "https://eth-rpc.mainnet.near.org",
    browserRpc: process.env.NEXT_PUBLIC_NEAR_ETH_RPC || undefined,
    explorer: "https://eth-explorer.near.org",
  },
} as const satisfies { network: Network; chains: readonly EvmChain[] } & Record<string, unknown>;

/** One row per network; T2 (#73) adds testnet's and picks the row with the build's setting. */
const TABLE = { mainnet: MAINNET } as const;

/** This build's network values. */
export const net = TABLE.mainnet;

/** A chain this build's bounties can cover, typed by the table's chain IDs. */
export type CoveredChainId = (typeof net.chains)[number]["id"];

/** The table's row for a chain ID, or undefined for a chain no bounty here can cover. */
export const coveredChain = (id: number): (typeof net.chains)[number] | undefined => net.chains.find((c) => c.id === id);

/** The command that checks a bounty from the terminal: the command-line tool needs the contract named. */
export const verifyCommand = (bounty: string, contract: string) => `bountee verify ${bounty} --contract ${contract} --network ${net.network}`;
