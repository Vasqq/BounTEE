// The app's one wallet setup (wagmi v2: NEAR's Ethereum-wallet support is built on wagmi v2).
// MetaMask is the only wallet (D13): the injected MetaMask connector, plus whatever the
// browser announces through EIP-6963. Reading and verifying never touch it (DESIGN.md, Voice
// and copy): only the pages that sign mount it (components/WalletProvider.tsx).
//
// Chains: Base and Arbitrum One, where the Protocol grants pause roles and tops up pause gas,
// and NEAR's Ethereum-compatible chain (NEP-518), through which the same MetaMask signs NEAR
// transactions as the Protocol's 0x… NEAR account. Each RPC can be pointed elsewhere at build
// time (the Playwright build points them at the test stand-in).
import { defineChain } from "viem";
import { createConfig, http } from "wagmi";
import { arbitrum, base } from "wagmi/chains";
import { injected } from "wagmi/connectors";

/** NEAR mainnet's Ethereum-compatible chain, as NEAR's ethereum-wallets module defines it. */
export const nearEvm = defineChain({
  id: 397,
  name: "NEAR Protocol",
  nativeCurrency: { decimals: 18, name: "NEAR", symbol: "NEAR" },
  rpcUrls: { default: { http: [process.env.NEXT_PUBLIC_NEAR_ETH_RPC || "https://eth-rpc.mainnet.near.org"] } },
  blockExplorers: { default: { name: "NEAR Explorer", url: "https://eth-explorer.near.org" } },
});

export const wagmiConfig = createConfig({
  chains: [base, arbitrum, nearEvm],
  connectors: [injected({ target: "metaMask" })],
  transports: {
    [base.id]: http(process.env.NEXT_PUBLIC_EVM_RPC_8453 || undefined),
    [arbitrum.id]: http(process.env.NEXT_PUBLIC_EVM_RPC_42161 || undefined),
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
