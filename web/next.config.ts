import type { NextConfig } from "next";

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
  // run time) and the build drops the other network's row.
  env: { NEXT_PUBLIC_NETWORK: network || "mainnet" },
  // Where the build goes: the test suite builds mainnet and testnet side by side (playwright.config.ts).
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default config;
