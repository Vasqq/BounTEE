import type { NextConfig } from "next";
import { PHASE_PRODUCTION_BUILD } from "next/constants";

// The build's network (D30, ADR-0021): `mainnet` or `testnet`, mainnet when unset. Anything
// else fails the build, so a mistyped setting can never put a visitor on the wrong network.
// lib/network.ts reads the same variable to pick its row.
const network = process.env.NEXT_PUBLIC_NETWORK;
if (network && network !== "mainnet" && network !== "testnet") {
  throw new Error(`NEXT_PUBLIC_NETWORK is "${network}": it must be mainnet or testnet (unset means mainnet).`);
}

const config: NextConfig = {
  // @bountee/formats and @bountee/cli ship TypeScript source; Next compiles them with the
  // app. The server runs the command-line tool's own verify checks (lib/verify.ts).
  transpilePackages: ["@bountee/formats", "@bountee/cli"],
  // Always set, so Next inlines it into every bundle (it leaves an unset variable to be read at
  // run time) and the build drops the other network's row. The other site's address (D31) is
  // always set too, empty when unset, so an unset one leaves no lookup naming the other network.
  env: {
    NEXT_PUBLIC_NETWORK: network || "mainnet",
    NEXT_PUBLIC_MAINNET_SITE: process.env.NEXT_PUBLIC_MAINNET_SITE ?? "",
    NEXT_PUBLIC_TESTNET_SITE: process.env.NEXT_PUBLIC_TESTNET_SITE ?? "",
  },
  // Where the build goes: the test suite builds mainnet and testnet side by side (playwright.config.ts).
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // Wallet code the app never runs, aliased to an empty module so it isn't built (ADR-0022):
  // - WalletConnect's own QR modal (Reown's AppKit), which its provider loads only when asked to
  //   show it; RainbowKit never asks, and draws its own QR code.
  // - The SDKs wagmi's MetaMask SDK, Safe and Base Account connectors load only when their
  //   wallet is used. RainbowKit imports those connectors, but the app's list (lib/wallets.ts)
  //   never creates them: its MetaMask entry uses an injected or WalletConnect connector, and
  //   a smart account (Safe, Base Account) can't sign on NEAR. Base Account's server build also
  //   imports optional packages that aren't installed, which fails the build; the MetaMask and
  //   Safe SDKs name the other network's chains, which the D30 and D4 checks look for.
  // Every build reads this file, so the suite's builds and both sites' are built alike.
  turbopack: {
    resolveAlias: {
      "@reown/appkit/core": "./lib/absent-module.ts",
      "@base-org/account": "./lib/absent-module.ts",
      "@metamask/sdk": "./lib/absent-module.ts",
      "@safe-global/safe-apps-sdk": "./lib/absent-module.ts",
      "@safe-global/safe-apps-provider": "./lib/absent-module.ts",
    },
  },
};

// The WalletConnect project ID (D36, ADR-0022): the wallet picker needs it for MetaMask Mobile's
// QR code and throws without it, server rendering included, so a build without it fails here,
// naming it, rather than ship a picker that crashes. Only a production build checks: `next start`
// serves what was already built with it, and `next dev` doesn't check (the README says it needs
// the variable too).
export default function nextConfig(phase: string): NextConfig {
  if (phase === PHASE_PRODUCTION_BUILD && !process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID) {
    throw new Error(
      "NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set: every build needs a WalletConnect project ID (Reown's dashboard), e.g. in web/.env.local.",
    );
  }
  return config;
}
