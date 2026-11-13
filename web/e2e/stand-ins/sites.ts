// Where the suite's two builds run, the addresses each is told the other site has (D31), and
// the project ID every test build is given (D36): playwright.config.ts and build.spec.ts build
// from these, and the specs check the links against them.
// The addresses are example domains, never ours, so no test can reach a real site.
const web = Number(process.env.WEB_PORT ?? 3100);

export const PORTS = {
  mainnet: web,
  testnet: Number(process.env.TESTNET_WEB_PORT ?? web + 2),
  /** The builds build.spec.ts makes from the environment alone, started one at a time. */
  check: web + 4,
} as const;

export const APPS = { mainnet: `http://localhost:${PORTS.mainnet}`, testnet: `http://localhost:${PORTS.testnet}` } as const;

/** The server's NEAR endpoints, each pointed at the stand-in at `chains`: read when the app runs (lib/config.ts). */
export const nearEndpoints = (chains: string) => ({
  NEAR_RPC: `${chains}/near`,
  NEAR_ARCHIVAL_RPC: `${chains}/near`,
  TX_API: `${chains}/txapi`,
  OUTLAYER_API: `${chains}/outlayer`,
});

/**
 * The WalletConnect project ID every test build is given (D36): the right shape, no real project's.
 * Each build sets it explicitly, since Next would otherwise load the real one from the ignored
 * web/.env.local.
 */
export const DUMMY_PROJECT_ID = "00000000000000000000000000000000";

/** NEXT_PUBLIC_MAINNET_SITE on the testnet build, NEXT_PUBLIC_TESTNET_SITE on the mainnet one. */
export const SITES = { mainnet: "https://bountee.example", testnet: "https://testnet.bountee.example" } as const;
