// The network table (D30, ADR-0021): every network value the web app reads, links to or
// signs with comes from here, and nothing else in web/app, web/components or web/lib names
// a chain ID, an explorer, an RPC host or a NEAR account (e2e/network-table.spec.ts checks).
// The server's config (lib/config.ts) and the browser's pinned values (lib/pinned.ts) and
// wallet setup (lib/wagmi.ts) all start from it.
//
// It runs in the browser as well as on the server, so it holds only what the browser needs,
// and only this build's network: the browser bundle carries no other network's value
// (e2e/landing.spec.ts checks for testnet's). The one exception is the other site's address
// (`mainnetSite` on testnet, `trySite` on mainnet), which D31 links to; the wording around
// those links is rendered on the server (components/AppNav.tsx, components/TryTestnet.tsx). The NEAR endpoints only the server reads
// (RPC, archival RPC, FastNEAR's explorer API, OutLayer's API, the NEAR explorer) are the
// command-line tool's own (cli/src/endpoints.ts), looked up by this table's `network` in
// lib/config.ts, so the two can't drift. The EVM chains are listed here, since the tool's
// chain table (cli/src/chains.ts) reads Node-only modules.
//
// The rows are plain values and import nothing at run time: the build drops the other row as
// dead code, but a module a row imported (viem's chain definitions, the formats' other root
// key) would stay in the bundle. So the MPC root keys are written out here, and
// e2e/network-table.spec.ts checks each is the formats' key for its network.
//
// Each browser override below is read as a literal `process.env.NEXT_PUBLIC_*`, the only
// form Next inlines into the browser bundle; each still wins over the table. The server's
// overrides are read at request time in lib/config.ts.
import type { Network } from "@bountee/cli/src/endpoints.ts";
import type { BountyId } from "@bountee/formats";

/** A covered chain's mark is its family's (DESIGN.md, Brand marks): a test chain shows its mainnet's. */
export type ChainFamily = "base" | "arbitrum";

export interface EvmChain {
  id: number;
  /** Written in full, as the design system asks: "Arbitrum One", never "Arbitrum". */
  name: string;
  family: ChainFamily;
  /** The chain's gas token, for pause gas. */
  gasToken: string;
  /** The server's RPC for this chain, unless `EVM_RPC_<id>` is set. */
  rpc: string;
  /** The browser wallet's RPC override (`NEXT_PUBLIC_EVM_RPC_<id>`); the wallet's own when unset. */
  browserRpc: string | undefined;
  explorer: string;
  explorerTx: string;
  /** Circle's USDC there: what a bounty lists as theft valued one for one (D27). */
  usdc: string;
}

/** A network's row. Both rows are checked against it, so neither can lack a value the other has. */
interface Row {
  /** The network the command-line tool's `Near` client and the Verify command name. */
  network: Network;
  bountyContract: string;
  /**
   * The demo bounty the landing page tells (D4, ADR-0018), as `<protocol>/<name>` on
   * `bountyContract`; `DEMO_BOUNTY` overrides it. Only mainnet has one (testnet's / is the
   * bounty list, D31).
   */
  demoBounty: string | undefined;
  /** Circle's USDC on NEAR. */
  nearUsdc: string;
  /** The MPC network's root key a bounty's pause-role address is derived from (D25). */
  mpcRootPublicKey: string;
  /** The chains a bounty can cover: those NEAR's MPC network can sign and verify a pause on. */
  chains: readonly [EvmChain, ...EvmChain[]];
  /** NEAR's Ethereum-compatible chain (NEP-518), through which the Protocol's Ethereum wallet signs as a 0x… NEAR account. */
  nearEvm: { id: number; name: string; rpc: string; browserRpc: string | undefined; explorer: string };
  /** NEAR's faucet, linked beside the NEAR the posting flow asks for (D17): testnet's, or `NEXT_PUBLIC_NEAR_FAUCET`. */
  nearFaucet: string | undefined;
  /** Circle's faucet for test USDC, linked beside the Protocol's USDC balance (D32): testnet's only. */
  usdcFaucet: string | undefined;
  /**
   * The mainnet site (D31), which a testnet build's badge and nav Verify link go to
   * (`NEXT_PUBLIC_MAINNET_SITE`), linked only when set. Mainnet's row has none: its own pages are it.
   */
  mainnetSite: string | undefined;
  /**
   * The site to try BounTEE on, the testnet site (D31), which a mainnet build's bounty list and
   * landing footer link to (`NEXT_PUBLIC_TESTNET_SITE`), linked only when set. Named without the
   * network, since the mainnet bundle carries no testnet word but that link's. Testnet's row has none.
   */
  trySite: string | undefined;
}

const MAINNET = {
  network: "mainnet",
  /** The third mainnet deployment, which the Nov 10–11 demo run used (`bounty.bountee.near` and `bounty2.bountee.near` stay unused). */
  bountyContract: "bounty3.bountee.near",
  demoBounty: "demo.bountee.near/demo",
  nearUsdc: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  mpcRootPublicKey: "secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya",
  chains: [
    {
      id: 8453,
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
      id: 42161,
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
  nearEvm: {
    id: 397,
    /** As NEAR's ethereum-wallets module (and viem's `near`) names it. */
    name: "NEAR Protocol",
    rpc: "https://eth-rpc.mainnet.near.org",
    browserRpc: process.env.NEXT_PUBLIC_NEAR_ETH_RPC || undefined,
    explorer: "https://eth-explorer.near.org",
  },
  nearFaucet: process.env.NEXT_PUBLIC_NEAR_FAUCET || undefined,
  usdcFaucet: undefined,
  mainnetSite: undefined,
  trySite: process.env.NEXT_PUBLIC_TESTNET_SITE || undefined,
} as const satisfies Row;

const TESTNET = {
  network: "testnet",
  bountyContract: "bounty3.bountee.testnet",
  demoBounty: undefined,
  /** Circle's USDC on NEAR testnet (6 decimals, read Nov 10). */
  nearUsdc: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af",
  /** The root key `v1.signer-prod.testnet` derives from. */
  mpcRootPublicKey: "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3",
  chains: [
    {
      id: 84532,
      name: "Base Sepolia",
      family: "base",
      gasToken: "ETH",
      rpc: "https://sepolia.base.org",
      browserRpc: process.env.NEXT_PUBLIC_EVM_RPC_84532 || undefined,
      explorer: "https://sepolia.basescan.org/",
      explorerTx: "https://sepolia.basescan.org/tx/",
      /** Circle's test USDC (developers.circle.com, USDC contract addresses, read Nov 10), as are Arbitrum Sepolia's and NEAR's. */
      usdc: "0x036cbd53842c5426634e7929541ec2318f3dcf7e",
    },
    {
      id: 421614,
      name: "Arbitrum Sepolia",
      family: "arbitrum",
      gasToken: "ETH",
      rpc: "https://sepolia-rollup.arbitrum.io/rpc",
      browserRpc: process.env.NEXT_PUBLIC_EVM_RPC_421614 || undefined,
      explorer: "https://sepolia.arbiscan.io/",
      explorerTx: "https://sepolia.arbiscan.io/tx/",
      usdc: "0x75faf114eafb1bdbe2f0316df893fd58ce46aa4d",
    },
  ],
  nearEvm: {
    id: 398,
    /** As viem's `nearTestnet` names it. */
    name: "NEAR Protocol Testnet",
    rpc: "https://eth-rpc.testnet.near.org",
    browserRpc: process.env.NEXT_PUBLIC_NEAR_ETH_RPC || undefined,
    explorer: "https://eth-explorer-testnet.near.org",
  },
  nearFaucet: process.env.NEXT_PUBLIC_NEAR_FAUCET || "https://docs.near.org/getting-started/faucet",
  usdcFaucet: "https://faucet.circle.com",
  mainnetSite: process.env.NEXT_PUBLIC_MAINNET_SITE || undefined,
  trySite: undefined,
} as const satisfies Row;

/**
 * This build's network values. The setting is read here alone, as the literal Next inlines on
 * the server and in the browser alike; next.config.ts refuses any value but mainnet or
 * testnet, and unset is mainnet. The other row is dead code in the build and is dropped.
 */
export const net = process.env.NEXT_PUBLIC_NETWORK === "testnet" ? TESTNET : MAINNET;

/** A chain this build's bounties can cover, typed by the table's chain IDs. */
export type CoveredChainId = (typeof net.chains)[number]["id"];

/** The table's row for a chain ID, or undefined for a chain no bounty here can cover. */
export const coveredChain = (id: number): (typeof net.chains)[number] | undefined => net.chains.find((c) => c.id === id);

/** The command that checks a bounty from the terminal: the command-line tool needs the contract named. */
export const verifyCommand = (id: BountyId, contract: string) => `bountee verify ${id.protocol}/${id.name} --contract ${contract} --network ${net.network}`;
