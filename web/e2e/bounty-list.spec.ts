// Seam W, ticket #29: the bounty list, read live from the chains (R15.6). Its Live and Past
// tabs, its sort and its layout are DESIGN.md's (Bounty list, settled with Liam on Nov 10, 2026).
import { expect, test, type Page } from "@playwright/test";
import { emptyWorld, post, rules, setWorld } from "./stand-ins/world.ts";

/** The list's bounty IDs, top to bottom, retried until the page that was navigated to shows them. */
const expectIds = (page: Page, want: string[]) => expect(page.locator(".list tbody .id")).toHaveText(want);
const tab = (page: Page, name: RegExp) => page.getByRole("navigation", { name: "Bounties" }).getByRole("link", { name });
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
/** Long gone, so a live bounty with it reads "Ended, unclaimed". */
const PAST_END = "1700000000000000000";
/** An end date `days` from now, in nanoseconds, so a live bounty stays live whenever the suite runs. */
const inDays = (days: number) => String(BigInt(Date.now() + days * 86_400_000) * 1_000_000n);

test("R15.6: the bounty list shows what the bounty contract holds now, not values in the page", async ({ page }) => {
  const w = emptyWorld();
  post(w, { protocol: "acme.near", name: "vault-v2" });
  post(w, { protocol: "0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e", name: "lending" }, { rules: { ...w.bounties[0]!.rules, bounty_amount: "250000000", minimum_theft: "5000000" } });
  await setWorld(page, w);
  await page.goto("/bounties");
  // The list names the contract it read, linked to the explorer, so anyone can check it there.
  await expect(page.getByText("Read live from bounty.bountee.near")).toBeVisible();
  await expect(page.getByRole("link", { name: "bounty.bountee.near" })).toHaveAttribute("href", "https://nearblocks.io/address/bounty.bountee.near");
  await expect(tab(page, /^Live 2$/)).toHaveAttribute("aria-current", "page");
  const row = page.getByRole("row", { name: /acme\.near\/vault-v2/ });
  await expect(row).toContainText("10 USDC");
  await expect(row).toContainText("1 USDC");
  await expect(row).toContainText("2026-12-31");
  await expect(row).toContainText("Live");
  await expect(page.getByRole("row", { name: /\/lending/ })).toContainText("250 USDC");

  // The chains change; the page follows them: the withdrawn bounty moves to Past.
  const later = emptyWorld();
  post(later, { protocol: "acme.near", name: "vault-v2" }, { state: "withdrawn" });
  await setWorld(page, later);
  await page.reload();
  await expect(tab(page, /^Live 0$/)).toBeVisible();
  await expect(page.getByText("No bounties are live.")).toBeVisible();
  await tab(page, /^Past 1$/).click();
  await expect(page.getByRole("row", { name: /acme\.near\/vault-v2/ })).toContainText("Withdrawn");
  await expect(page.getByRole("row", { name: /\/lending/ })).toHaveCount(0);
});

test("R15.6: with nothing posted, the list says so @phone", async ({ page }) => {
  await setWorld(page, emptyWorld());
  await page.goto("/bounties");
  await expect(tab(page, /^Live 0$/)).toBeVisible();
  await expect(page.getByText("No bounties are live.")).toBeVisible();
  await page.goto("/bounties?tab=past");
  await expect(page.getByText("No bounties have ended yet.")).toBeVisible();
});

test("R15.6: on a phone each bounty is a two-line row, with no sideways scroll @phone", async ({ page }) => {
  const w = emptyWorld();
  post(w, { protocol: "0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e", name: "a-long-bounty-name" });
  await setWorld(page, w);
  await page.goto("/bounties");
  await expect(page.getByRole("row", { name: /a-long-bounty-name/ })).toContainText("10 USDC");
  expect(await noSidewaysScroll(page)).toBe(true);
});

test("R15.6: Live holds what can still be claimed, Past what is over, each state beside its bounty's name", async ({ page }) => {
  const w = emptyWorld();
  post(w, { protocol: "acme.near", name: "live" });
  post(w, { protocol: "acme.near", name: "checking" }, { state: "checking" });
  post(w, { protocol: "acme.near", name: "paid" }, { state: "paid" });
  post(w, { protocol: "acme.near", name: "ended" }, { rules: rules({ end_date_ns: PAST_END }) });
  post(w, { protocol: "acme.near", name: "withdrawn" }, { state: "withdrawn" });
  post(w, { protocol: "acme.near", name: "setup" }, { state: "check_failed" });
  await setWorld(page, w);
  await page.goto("/bounties");
  await expect(tab(page, /^Live 2$/)).toBeVisible();
  await expect(tab(page, /^Past 4$/)).toBeVisible();
  await expectIds(page, ["acme.near/checking", "acme.near/live"]);
  // The state is on the bounty's own cell, not a column of its own.
  await expect(page.getByRole("columnheader")).toHaveText(["Bounty", "Chains", "Pays", /^Minimum theft/, "Ends"]);
  await expect(page.getByRole("row", { name: /acme\.near\/live/ }).getByRole("cell").first().getByText("Live", { exact: true })).toBeVisible();

  await tab(page, /^Past 4$/).click();
  await expect(page).toHaveURL(/\?tab=past$/);
  // Latest end first; the three sharing an end date fall back to A to Z.
  await expectIds(page, ["acme.near/paid", "acme.near/setup", "acme.near/withdrawn", "acme.near/ended"]);
  await expect(page.getByRole("row", { name: /acme\.near\/ended/ })).toContainText("Ended, unclaimed");
  // A bounty whose posting check failed never took a claim: it reads "Not posted", in grey.
  await expect(page.getByRole("row", { name: /acme\.near\/setup/ }).getByText("Not posted", { exact: true })).toHaveClass(/\bmute\b/);
});

test("R15.6: each column sorts the list, the most useful end first, and a second click flips it", async ({ page }) => {
  const w = emptyWorld();
  // name, bounty amount, minimum theft, end date (all live, so all on Live)
  for (const [name, amount, theft, end] of [
    ["b-mid", "50000000", "5000000", inDays(20)],
    ["a-small", "10000000", "9000000", inDays(30)],
    ["c-big", "90000000", "1000000", inDays(10)],
  ]) post(w, { protocol: "acme.near", name }, { rules: rules({ bounty_amount: amount, minimum_theft: theft, end_date_ns: end }) });
  // Ended last is z, so latest-first puts it above y, against A to Z.
  post(w, { protocol: "acme.near", name: "z-over" }, { state: "paid", rules: rules({ end_date_ns: "1795000000000000000" }) });
  post(w, { protocol: "acme.near", name: "y-over" }, { state: "withdrawn", rules: rules({ end_date_ns: "1790000000000000000" }) });
  await setWorld(page, w);

  // Live opens on the highest bounty amount.
  await page.goto("/bounties");
  await expectIds(page, ["acme.near/c-big", "acme.near/b-mid", "acme.near/a-small"]);
  await expect(page.getByRole("columnheader", { name: "Pays" })).toHaveAttribute("aria-sort", "descending");
  await page.getByRole("columnheader", { name: "Pays" }).getByRole("link").click();
  await expect(page.getByRole("columnheader", { name: "Pays" })).toHaveAttribute("aria-sort", "ascending");
  await expectIds(page, ["acme.near/a-small", "acme.near/b-mid", "acme.near/c-big"]);
  // Ends: soonest first on Live.
  await page.getByRole("columnheader", { name: "Ends" }).getByRole("link").click();
  await expect(page.getByRole("columnheader", { name: "Ends" })).toHaveAttribute("aria-sort", "ascending");
  await expectIds(page, ["acme.near/c-big", "acme.near/b-mid", "acme.near/a-small"]);
  // Minimum theft: highest first, and its header still explains itself.
  const theft = page.getByRole("columnheader", { name: /^Minimum theft/ }).getByRole("link");
  await theft.focus();
  await expect(page.getByRole("tooltip")).toHaveText("Pays only for an exploit that could steal at least this much.");
  await theft.click();
  await expectIds(page, ["acme.near/a-small", "acme.near/b-mid", "acme.near/c-big"]);
  await page.getByRole("columnheader", { name: "Bounty" }).getByRole("link").click();
  // The view is in the URL, so it can be linked.
  await expect(page).toHaveURL(/sort=bounty&dir=asc/);
  await page.getByRole("columnheader", { name: "Bounty" }).getByRole("link").click();
  await expect(page).toHaveURL(/sort=bounty&dir=desc/);
  await expectIds(page, ["acme.near/c-big", "acme.near/b-mid", "acme.near/a-small"]);

  // Past opens on what ended last.
  await page.goto("/bounties?tab=past");
  await expectIds(page, ["acme.near/z-over", "acme.near/y-over"]);
  await expect(page.getByRole("columnheader", { name: "Ends" })).toHaveAttribute("aria-sort", "descending");
});

test("R15.6: on a phone the list sorts from one select @phone", async ({ page }) => {
  // The table's headers sort above 900px; this runs on desktop's project too, so it sets a phone's width.
  await page.setViewportSize({ width: 390, height: 844 });
  const w = emptyWorld();
  post(w, { protocol: "acme.near", name: "small" }, { rules: rules({ bounty_amount: "10000000" }) });
  post(w, { protocol: "acme.near", name: "big" }, { rules: rules({ bounty_amount: "90000000" }) });
  await setWorld(page, w);
  await page.goto("/bounties");
  await expectIds(page, ["acme.near/big", "acme.near/small"]);
  const sort = page.getByRole("combobox", { name: "Sort by" });
  await expect(sort).toHaveValue("pays:desc");
  await sort.selectOption({ label: "Pays, lowest first" });
  await expect(page).toHaveURL(/sort=pays&dir=asc/);
  await expectIds(page, ["acme.near/small", "acme.near/big"]);
  expect(await noSidewaysScroll(page)).toBe(true);
});

test.describe("without JavaScript", () => {
  test.use({ javaScriptEnabled: false });
  test("R15.6: the tabs, the headers and the phone's sort all still work @phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const w = emptyWorld();
    post(w, { protocol: "acme.near", name: "small" }, { rules: rules({ bounty_amount: "10000000" }) });
    post(w, { protocol: "acme.near", name: "big" }, { rules: rules({ bounty_amount: "90000000" }) });
    post(w, { protocol: "acme.near", name: "gone" }, { state: "withdrawn" });
    await setWorld(page, w);
    await page.goto("/bounties");
    await page.getByRole("combobox", { name: "Sort by" }).selectOption({ label: "Pays, lowest first" });
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    await expectIds(page, ["acme.near/small", "acme.near/big"]);
    await tab(page, /^Past 1$/).click();
    await expectIds(page, ["acme.near/gone"]);
  });
});

test("R15.6: from tablet to laptop width the list never scrolls sideways", async ({ page }) => {
  const w = emptyWorld();
  post(w, { protocol: "0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e", name: "a-long-bounty-name" }, { state: "live" });
  post(w, { protocol: "acme.near", name: "vault-v2" });
  await setWorld(page, w);
  for (const width of [800, 901, 1024, 1090]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/bounties");
    await expect(page.getByRole("row", { name: /a-long-bounty-name/ })).toContainText("10 USDC");
    expect(await noSidewaysScroll(page), `${width}px`).toBe(true);
  }
});
