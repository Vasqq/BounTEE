import { defineConfig, devices } from "@playwright/test";

const port = Number(process.env.WEB_PORT ?? 3100);
const standIn = Number(process.env.STAND_IN_PORT ?? 3199);
const chains = `http://localhost:${standIn}`;

// Seam W: the web app driven in a browser. Specs live in web/e2e/. The app reads every
// chain through the test stand-in (e2e/stand-ins/chains.ts), which each spec puts in the
// state it needs, so specs share it and run one at a time.
export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env.CI,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  use: { baseURL: `http://localhost:${port}` },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }, grep: /@phone/ },
  ],
  webServer: [
    {
      command: `node e2e/stand-ins/chains.ts`,
      url: `${chains}/health`,
      env: { STAND_IN_PORT: String(standIn) },
      reuseExistingServer: !process.env.CI,
    },
    {
      command: `pnpm exec next build && pnpm exec next start -p ${port}`,
      url: `http://localhost:${port}`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      // The app's endpoints, pointed at the stand-in; a real build takes mainnet's (lib/config.ts).
      env: {
        NEAR_RPC: `${chains}/near`,
        NEAR_ARCHIVAL_RPC: `${chains}/near`,
        TX_API: `${chains}/txapi`,
        OUTLAYER_API: `${chains}/outlayer`,
        EVM_RPC_8453: `${chains}/evm/8453`,
        EVM_RPC_42161: `${chains}/evm/42161`,
        DEMO_BOUNTY: "0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e/mainnet-demo",
        NEAR_ETH_RPC: `${chains}/evm/397`,
        // Read at build time by the browser's wallet client (lib/wagmi.ts).
        NEXT_PUBLIC_NEAR_ETH_RPC: `${chains}/evm/397`,
        NEXT_PUBLIC_EVM_RPC_8453: `${chains}/evm/8453`,
        NEXT_PUBLIC_EVM_RPC_42161: `${chains}/evm/42161`,
      },
    },
  ],
});
