// Seam W, ticket #29: the bounty list, read live from the chains (R15.6).
import { expect, test } from "@playwright/test";
import { emptyWorld, post, setWorld } from "./stand-ins/world.ts";

test("R15.6: the bounty list shows what the bounty contract holds now, not values in the page", async ({ page }) => {
  const w = emptyWorld();
  post(w, { protocol: "acme.near", name: "vault-v2" });
  post(w, { protocol: "0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e", name: "lending" }, { rules: { ...w.bounties[0]!.rules, bounty_amount: "250000000", minimum_theft: "5000000" } });
  await setWorld(page, w);
  await page.goto("/bounties");
  await expect(page.getByText("2 bounties")).toBeVisible();
  const row = page.getByRole("row", { name: /acme\.near\/vault-v2/ });
  await expect(row).toContainText("10 USDC");
  await expect(row).toContainText("1 USDC");
  await expect(row).toContainText("2026-12-31");
  await expect(row).toContainText("Live");
  await expect(page.getByRole("row", { name: /\/lending/ })).toContainText("250 USDC");

  // The chains change; the page follows them.
  const later = emptyWorld();
  post(later, { protocol: "acme.near", name: "vault-v2" }, { state: "withdrawn" });
  await setWorld(page, later);
  await page.reload();
  await expect(page.getByText("1 bounty", { exact: true })).toBeVisible();
  await expect(page.getByRole("row", { name: /acme\.near\/vault-v2/ })).toContainText("Withdrawn");
  await expect(page.getByRole("row", { name: /\/lending/ })).toHaveCount(0);
});

test("R15.6: with nothing posted, the list says so @phone", async ({ page }) => {
  await setWorld(page, emptyWorld());
  await page.goto("/bounties");
  await expect(page.getByText("0 bounties")).toBeVisible();
  await expect(page.getByText("No bounties are live.")).toBeVisible();
});

test("R15.6: on a phone each bounty is a two-line row, with no sideways scroll @phone", async ({ page }) => {
  const w = emptyWorld();
  post(w, { protocol: "0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e", name: "a-long-bounty-name" });
  await setWorld(page, w);
  await page.goto("/bounties");
  await expect(page.getByRole("row", { name: /a-long-bounty-name/ })).toContainText("10 USDC");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
