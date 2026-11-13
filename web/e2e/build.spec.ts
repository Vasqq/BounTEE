// D30, ticket #73: the build's one network setting. `next build` refuses any value but mainnet
// or testnet, builds mainnet when it is unset, and builds the testnet site from
// web/.env.testnet.example's variables alone, its project ID filled in with a dummy. Each runs
// `next build` with no other variable, into its own folder (.next-check), beside the suite's two
// running builds.
// D36, ticket #90: every build needs the WalletConnect project ID and fails naming it without
// one; `next start` serves without it. Every build here sets it itself (see DUMMY_PROJECT_ID):
// the dummy, or empty to prove the failure.
// D31, ticket #74: those two builds know no other site's address, so each is then started
// (Seam W) and shows no link to the other site: the testnet badge is plain text.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { pauseRole } from "@bountee/formats";
import { emptyWorld, NETWORKS, setWorld, STAND_IN } from "./stand-ins/world.ts";
import { DUMMY_PROJECT_ID, nearEndpoints, PORTS } from "./stand-ins/sites.ts";
import { sentToBrowser } from "./stand-ins/bundle.ts";

const WEB = join(import.meta.dirname, "..");
const DIST = ".next-check";

/**
 * `next build` with no variables but these (and what a shell needs to find pnpm), the project ID
 * the dummy unless `vars` sets it.
 */
function build(vars: Record<string, string>) {
  rmSync(join(WEB, DIST), { recursive: true, force: true });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production" as const, NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: DIST, NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: DUMMY_PROJECT_ID, ...vars };
  return spawnSync("pnpm", ["exec", "next", "build"], { cwd: WEB, env, encoding: "utf8", timeout: 300_000 });
}

/**
 * Start the build in .next-check, run `check` against it, then stop it. Only the server's own
 * endpoints point at the stand-in, read when it runs; nothing changes what was built.
 */
async function served(check: (origin: string) => Promise<void>) {
  // The project ID is empty, so `next start` is shown serving without it (D36).
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production" as const, NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: DIST, NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "", ...nearEndpoints(STAND_IN) };
  const server = spawn("pnpm", ["exec", "next", "start", "-p", String(PORTS.check)], { cwd: WEB, env, detached: true, stdio: "ignore" });
  const origin = `http://localhost:${PORTS.check}`;
  try {
    await expect.poll(() => fetch(origin).then((r) => r.status, () => 0), { timeout: 60_000 }).toBeGreaterThan(0);
    await check(origin);
  } finally {
    process.kill(-server.pid!);
  }
}

/** A dotenv file's assignments: `KEY=value` lines, comments and blanks skipped. */
const dotenv = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );

test("D30: next build with NEXT_PUBLIC_NETWORK=foo exits non-zero, naming the setting", () => {
  const r = build({ NEXT_PUBLIC_NETWORK: "foo" });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain('NEXT_PUBLIC_NETWORK is "foo": it must be mainnet or testnet');
});

test("D36: next build with NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID empty exits non-zero, naming the variable", () => {
  const r = build({ NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "" });
  // 1, not just non-zero: a build killed by the timeout has no status and must not pass.
  expect(r.status, r.stdout + r.stderr).toBe(1);
  expect(r.stdout + r.stderr).toContain("NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set");
});

test("D30, D31, D36: next build with only web/.env.testnet.example's variables, its project ID filled in, succeeds, and builds the testnet site, whose badge is plain text with no mainnet address set", async ({ page }) => {
  test.setTimeout(420_000);
  const vars = dotenv(readFileSync(join(WEB, ".env.testnet.example"), "utf8"));
  expect(vars).toEqual({ NEXT_PUBLIC_NETWORK: "testnet", NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: "" });
  const r = build({ ...vars, NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID: DUMMY_PROJECT_ID });
  expect(r.status, r.stdout + r.stderr).toBe(0);
  await setWorld(page, emptyWorld("testnet"));
  await served(async (origin) => {
    // What the browser is sent pins testnet's contract and asks the wallet for NEAR testnet's
    // chain, and carries none of mainnet's signing values: its USDC, root key, RPCs or NEAR's
    // chain 397. (The landing page's script, mainnet's story, names mainnet's contract and
    // explorers.) Only RainbowKit's chain metadata table is left out (ADR-0022, see sentToBrowser()).
    const mainnetValues = [NETWORKS.mainnet.usdc, pauseRole.MAINNET_ROOT_PUBLIC_KEY, "eth-rpc.mainnet.near.org", "mainnet.base.org", "arb1.arbitrum.io"];
    const { failing, all } = await sentToBrowser(page, origin, join(WEB, DIST), (text) => !mainnetValues.some((v) => text.includes(v)));
    expect(all).toContain("bounty3.bountee.testnet");
    expect(all).toContain("NEAR Protocol Testnet");
    expect(failing).toEqual([]);
    // D31: with no mainnet address, the badge links nowhere and the nav has no Verify link.
    await page.goto(`${origin}/bounties`);
    const nav = page.getByRole("banner");
    await expect(nav.getByText("Testnet", { exact: true })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Testnet" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Bounties" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Verify" })).toHaveCount(0);
  });
  rmSync(join(WEB, DIST), { recursive: true, force: true });
});

test("D30, D31: next build with NEXT_PUBLIC_NETWORK unset builds mainnet, which links to no testnet site with no testnet address set", async ({ page }) => {
  test.setTimeout(420_000);
  const r = build({});
  expect(r.status, r.stdout + r.stderr).toBe(0);
  await setWorld(page, emptyWorld());
  await served(async (origin) => {
    // No testnet word in any page's HTML or any file the browser is sent, the app's signing code
    // included; only RainbowKit's chain metadata table is left out (ADR-0022, see sentToBrowser()).
    const { failing, all } = await sentToBrowser(page, origin, join(WEB, DIST), (text) => !/testnet|sepolia/i.test(text));
    expect(all).toContain(NETWORKS.mainnet.usdc);
    expect(all).toContain("eth-rpc.mainnet.near.org");
    expect(failing).toEqual([]);
    // D31: no link to the testnet site on the bounty list or in the landing page's footer.
    await page.goto(`${origin}/bounties`);
    await expect(page.getByText("No bounties are live.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Try it on testnet" })).toHaveCount(0);
    await page.goto(origin);
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Source" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Try it on testnet" })).toHaveCount(0);
  });
  rmSync(join(WEB, DIST), { recursive: true, force: true });
});
