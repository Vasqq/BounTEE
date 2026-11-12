// The app's one wallet setup (wagmi v2: NEAR's Ethereum-wallet support is built on wagmi v2).
// The Protocol wallet (D13) is any wallet RainbowKit's picker offers from lib/wallets.ts's list
// (D34, ADR-0022), and no other: wagmi's EIP-6963 discovery is off, so a wallet the browser
// announces never becomes a connector. Reading and verifying never touch it (DESIGN.md, Voice
// and copy): only the pages that sign mount it (components/WalletProvider.tsx).
//
// Chains, from the network table (D30): the chains a bounty can cover, where the Protocol
// grants pause roles and tops up pause gas, and NEAR's Ethereum-compatible chain (NEP-518),
// through which the same wallet signs NEAR transactions as the Protocol's 0x… NEAR account.
// Each RPC can be pointed elsewhere at build time (the Playwright build points them at the
// test stand-in).
import { defineChain, type Transport } from "viem";
import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { createConfig, http } from "wagmi";
import { net, type CoveredChainId, type EvmChain } from "./network.ts";
import { walletList } from "./wallets.ts";

/** NEAR's Ethereum-compatible chain, as NEAR's ethereum-wallets module defines it. */
export const nearEvm = defineChain({
  id: net.nearEvm.id,
  name: net.nearEvm.name,
  nativeCurrency: { decimals: 18, name: "NEAR", symbol: "NEAR" },
  rpcUrls: { default: { http: [net.nearEvm.browserRpc ?? net.nearEvm.rpc] } },
  blockExplorers: { default: { name: "NEAR Explorer", url: net.nearEvm.explorer } },
});

/**
 * A covered chain, as the wallet is asked to add it. Built from the table's plain values rather
 * than taken from viem/chains, so the build carries only its own network's chains: the other
 * row is dropped as dead code, and an import from viem/chains would not be (e2e/build.spec.ts
 * and e2e/landing.spec.ts check each build's bundle for the other network's values).
 * The app only sends plain transactions there (grants and top-ups), so no chain formatters.
 */
const coveredEvm = (c: EvmChain) =>
  defineChain({
    id: c.id,
    name: c.name,
    nativeCurrency: { decimals: 18, name: "Ether", symbol: c.gasToken },
    rpcUrls: { default: { http: [c.browserRpc ?? c.rpc] } },
    blockExplorers: { default: { name: `${c.name} explorer`, url: c.explorer } },
  });

// wagmi types its chains as a non-empty tuple and its transports by those chains' IDs: built
// from the table, both need saying so.
const [first, ...rest] = net.chains.map(coveredEvm);

export const wagmiConfig = createConfig({
  chains: [first, ...rest, nearEvm],
  // The WalletConnect project ID is inlined at build time, and every build has one (next.config.ts, D36).
  connectors: connectorsForWallets(walletList, { appName: "BounTEE", projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID! }),
  // No EIP-6963 discovery: the picker lists only lib/wallets.ts's wallets (D34).
  multiInjectedProviderDiscovery: false,
  transports: Object.fromEntries([...net.chains, net.nearEvm].map((c) => [c.id, http()])) as Record<CoveredChainId | typeof nearEvm.id, Transport>,
  // Rendered on the server first: keep wallet state out of the first paint, restore it after.
  // Its storage stays in the browser (localStorage), never in a cookie sent to the server.
  ssr: true,
  // Receipts are read every second, so a grant or top-up ticks off as soon as it lands.
  pollingInterval: 1_000,
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
