// The app's one wallet setup (wagmi v2: NEAR's Ethereum-wallet support is built on wagmi v2).
// MetaMask is the only wallet (D13): the injected MetaMask connector, plus whatever the
// browser announces through EIP-6963. Reading and verifying never touch it (DESIGN.md, Voice
// and copy): only the pages that sign mount it (components/WalletProvider.tsx).
//
// Chains, from the network table (D30): the chains a bounty can cover, where the Protocol
// grants pause roles and tops up pause gas, and NEAR's Ethereum-compatible chain (NEP-518),
// through which the same MetaMask signs NEAR transactions as the Protocol's 0x… NEAR account.
// Each RPC can be pointed elsewhere at build time (the Playwright build points them at the
// test stand-in).
import { defineChain, type Transport } from "viem";
import { createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { net, type CoveredChainId } from "./network.ts";

/** NEAR's Ethereum-compatible chain, as NEAR's ethereum-wallets module defines it. */
export const nearEvm = defineChain({
  id: net.nearEvm.id,
  name: net.nearEvm.name,
  nativeCurrency: { decimals: 18, name: "NEAR", symbol: "NEAR" },
  rpcUrls: { default: { http: [net.nearEvm.browserRpc ?? net.nearEvm.rpc] } },
  blockExplorers: { default: { name: "NEAR Explorer", url: net.nearEvm.explorer } },
});

// wagmi types its chains as a non-empty tuple and its transports by those chains' IDs: built
// from the table, both need saying so.
const [first, ...rest] = net.chains.map((c) => c.viem);

export const wagmiConfig = createConfig({
  chains: [first, ...rest, nearEvm],
  connectors: [injected({ target: "metaMask" })],
  transports: {
    ...(Object.fromEntries(net.chains.map((c) => [c.id, http(c.browserRpc)])) as Record<CoveredChainId, Transport>),
    [nearEvm.id]: http(),
  },
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
