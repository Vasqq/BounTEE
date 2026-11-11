// D30, ticket #73: the build's one network setting. `next build` refuses any value but mainnet
// or testnet, builds mainnet when it is unset, and builds the testnet site from
// web/.env.testnet.example alone. Each runs `next build` with no other variable, into its own
// folder (.next-check), beside the suite's two running builds.
// D31, ticket #74: those two builds know no other site's address, so each is then started
// (Seam W) and shows no link to the other site: the testnet badge is plain text.
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { pauseRole } from "@bountee/formats";
import { emptyWorld, NETWORKS, setWorld, STAND_IN } from "./stand-ins/world.ts";
import { nearEndpoints, PORTS } from "./stand-ins/sites.ts";

const WEB = join(import.meta.dirname, "..");
const DIST = ".next-check";

/** `next build` with no variables but these (and what a shell needs to find pnpm). */
function build(vars: Record<string, string>) {
  rmSync(join(WEB, DIST), { recursive: true, force: true });
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production" as const, NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: DIST, ...vars };
  return spawnSync("pnpm", ["exec", "next", "build"], { cwd: WEB, env, encoding: "utf8", timeout: 300_000 });
}

/**
 * Start the build in .next-check, run `check` against it, then stop it. Only the server's own
 * endpoints point at the stand-in, read when it runs; nothing changes what was built.
 */
async function served(check: (origin: string) => Promise<void>) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production" as const, NEXT_TELEMETRY_DISABLED: "1", NEXT_DIST_DIR: DIST, ...nearEndpoints(STAND_IN) };
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

const staticText = (dir: string): string =>
  readdirSync(dir)
    .map((f) => join(dir, f))
    .map((p) => (statSync(p).isDirectory() ? staticText(p) : readFileSync(p, "utf8")))
    .join("\n");

test("D30: next build with NEXT_PUBLIC_NETWORK=foo exits non-zero, naming the setting", () => {
  const r = build({ NEXT_PUBLIC_NETWORK: "foo" });
  expect(r.status).not.toBe(0);
  expect(r.stdout + r.stderr).toContain('NEXT_PUBLIC_NETWORK is "foo": it must be mainnet or testnet');
});

test("D30, D31: next build with only web/.env.testnet.example succeeds, and builds the testnet site, whose badge is plain text with no mainnet address set", async ({ page }) => {
  test.setTimeout(420_000);
  const vars = dotenv(readFileSync(join(WEB, ".env.testnet.example"), "utf8"));
  expect(vars).toEqual({ NEXT_PUBLIC_NETWORK: "testnet" });
  const r = build(vars);
  expect(r.status, r.stdout + r.stderr).toBe(0);
  // What the browser is sent pins testnet's contract and asks MetaMask for NEAR testnet's chain,
  // and carries none of mainnet's signing values: its USDC, root key, RPCs or NEAR's chain 397.
  // (The landing page's script, mainnet's story, names mainnet's contract and explorers.)
  const sent = staticText(join(WEB, DIST, "static"));
  expect(sent).toContain("bounty3.bountee.testnet");
  expect(sent).toContain("NEAR Protocol Testnet");
  for (const mainnet of [NETWORKS.mainnet.usdc, pauseRole.MAINNET_ROOT_PUBLIC_KEY, "eth-rpc.mainnet.near.org", "mainnet.base.org", "arb1.arbitrum.io"]) expect(sent).not.toContain(mainnet);
  // D31: with no mainnet address, the badge links nowhere and the nav has no Verify link.
  await setWorld(page, emptyWorld("testnet"));
  await served(async (origin) => {
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
  const sent = staticText(join(WEB, DIST, "static"));
  expect(sent).toContain(NETWORKS.mainnet.usdc);
  expect(sent).toContain("eth-rpc.mainnet.near.org");
  expect(sent).not.toMatch(/testnet|sepolia/i);
  // D31: no link to the testnet site on the bounty list or in the landing page's footer.
  await setWorld(page, emptyWorld());
  await served(async (origin) => {
    await page.goto(`${origin}/bounties`);
    await expect(page.getByText("No bounties are live.")).toBeVisible();
    await expect(page.getByRole("link", { name: "Try it on testnet" })).toHaveCount(0);
    await page.goto(origin);
    await expect(page.getByRole("contentinfo").getByRole("link", { name: "Source" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Try it on testnet" })).toHaveCount(0);
  });
  rmSync(join(WEB, DIST), { recursive: true, force: true });
});
