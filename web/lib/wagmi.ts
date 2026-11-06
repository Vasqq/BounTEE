// The app's one wallet setup (wagmi v2: NEAR's Ethereum-wallet support, which the posting
// flow uses to sign as the Protocol's 0x… NEAR account, is built on wagmi v2). MetaMask is the
// only wallet (D13): the injected MetaMask connector, plus whatever the browser announces
// through EIP-6963. Reading and verifying never touch it (DESIGN.md, Voice and copy): only the
// pages that sign mount it (components/WalletProvider.tsx).
import { cookieStorage, createConfig, createStorage, http } from "wagmi";
import { arbitrum, base } from "wagmi/chains";
import { injected } from "wagmi/connectors";

export const wagmiConfig = createConfig({
  chains: [base, arbitrum],
  connectors: [injected({ target: "metaMask" })],
  transports: { [base.id]: http(), [arbitrum.id]: http() },
  // Rendered on the server first: keep wallet state out of the first paint, restore it after.
  ssr: true,
  storage: createStorage({ storage: cookieStorage }),
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
