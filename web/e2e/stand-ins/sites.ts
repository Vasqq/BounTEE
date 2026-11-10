// Where the suite's two builds run, and the addresses each is told the other site has (D31):
// playwright.config.ts starts the builds from these, and the specs check the links against them.
// The addresses are example domains, never ours, so no test can reach a real site.
const web = Number(process.env.WEB_PORT ?? 3100);

export const PORTS = {
  mainnet: web,
  testnet: Number(process.env.TESTNET_WEB_PORT ?? web + 2),
  /** The builds build.spec.ts makes from the environment alone, started one at a time. */
  check: web + 4,
} as const;

export const APPS = { mainnet: `http://localhost:${PORTS.mainnet}`, testnet: `http://localhost:${PORTS.testnet}` } as const;

/** NEXT_PUBLIC_MAINNET_SITE on the testnet build, NEXT_PUBLIC_TESTNET_SITE on the mainnet one. */
export const SITES = { mainnet: "https://bountee.example", testnet: "https://testnet.bountee.example" } as const;
