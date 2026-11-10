import { defineConfig, devices } from "@playwright/test";
import { PORTS, SITES } from "./e2e/stand-ins/sites.ts";

const port = PORTS.mainnet;
const testnetPort = PORTS.testnet;
const standIn = Number(process.env.STAND_IN_PORT ?? 3199);
const chains = `http://localhost:${standIn}`;
/** The testnet specs: they run on the testnet build alone, and every other spec on the mainnet build alone. */
const TESTNET_SPECS = /testnet\.spec\.ts$/;
// The mainnet build is built with the network setting unset, as a mainnet deployment is (D30):
// a setting in the shell must not reach it. The testnet build sets its own. Each build is told
// the other site's address (D31) here alone.
for (const v of ["NEXT_PUBLIC_NETWORK", "NEXT_PUBLIC_MAINNET_SITE", "NEXT_PUBLIC_TESTNET_SITE"]) delete process.env[v];

/**
 * One build of the app, its endpoints pointed at the stand-in (a real build takes the network
 * table's, lib/config.ts): the server's at request time, the browser wallet's (lib/wagmi.ts) at
 * build time. DEMO_BOUNTY is set on both, so the testnet build shows it never tells it.
 */
function appServer(on: number, distDir: string, chain: { covered: number[]; nearEvm: number }, env: Record<string, string> = {}) {
  const evm = (id: number) => `${chains}/evm/${id}`;
  return {
    command: `pnpm exec next build && pnpm exec next start -p ${on}`,
    url: `http://localhost:${on}`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      NEXT_DIST_DIR: distDir,
      NEAR_RPC: `${chains}/near`,
      NEAR_ARCHIVAL_RPC: `${chains}/near`,
      TX_API: `${chains}/txapi`,
      OUTLAYER_API: `${chains}/outlayer`,
      DEMO_BOUNTY: "0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e/mainnet-demo",
      NEAR_ETH_RPC: evm(chain.nearEvm),
      NEXT_PUBLIC_NEAR_ETH_RPC: evm(chain.nearEvm),
      ...Object.fromEntries(chain.covered.flatMap((id) => [[`EVM_RPC_${id}`, evm(id)], [`NEXT_PUBLIC_EVM_RPC_${id}`, evm(id)]])),
      ...env,
    },
  };
}

// Seam W: the web app driven in a browser. Specs live in web/e2e/. The app reads every
// chain through the test stand-in (e2e/stand-ins/chains.ts), which each spec puts in the
// state it needs, so specs share it and run one at a time. Two builds run side by side, a
// mainnet one and a testnet one (D30), each in its own build folder and on its own port, both
// pointed at the one stand-in.
export default defineConfig({
  testDir: "./e2e",
  forbidOnly: !!process.env.CI,
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  projects: [
    { name: "desktop", testIgnore: TESTNET_SPECS, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, baseURL: `http://localhost:${port}` } },
    {
      name: "phone",
      testIgnore: TESTNET_SPECS,
      use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, baseURL: `http://localhost:${port}` },
      grep: /@phone/,
    },
    { name: "testnet", testMatch: TESTNET_SPECS, use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 }, baseURL: `http://localhost:${testnetPort}` } },
  ],
  webServer: [
    {
      command: `node e2e/stand-ins/chains.ts`,
      url: `${chains}/health`,
      env: { STAND_IN_PORT: String(standIn) },
      reuseExistingServer: !process.env.CI,
    },
    // The mainnet build, with the setting unset.
    appServer(port, ".next", { covered: [8453, 42161], nearEvm: 397 }, { NEXT_PUBLIC_TESTNET_SITE: SITES.testnet }),
    appServer(testnetPort, ".next-testnet", { covered: [84532, 421614], nearEvm: 398 }, { NEXT_PUBLIC_NETWORK: "testnet", NEXT_PUBLIC_MAINNET_SITE: SITES.mainnet }),
  ],
});
