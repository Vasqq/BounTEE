// Seam W, ticket #29: the landing page tells the mainnet demo bounty as a story (D4), read
// live from the chains (R15.6), with no wallet.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ARBITRUM, BASE, DEMO, emptyWorld, finishedDemo, judge, post, setWorld, win } from "./stand-ins/world.ts";
import { SITES } from "./stand-ins/sites.ts";

const ORDER = ["Posted", "Sealed", "Checked", "Signed", "Paid", "Landed", "Verified", "Published"];
const panel = (page: Page, i: number) => page.locator("#panels > li").nth(i);
const hrefs = (page: Page, i: number) => panel(page, i).locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")));

/** Every call a page makes to an injected wallet, so a spec can assert there are none. */
async function watchWallet(page: Page) {
  await page.addInitScript(() => {
    (window as any).__walletCalls = [];
    (window as any).ethereum = { isMetaMask: true, request: async (a: unknown) => ((window as any).__walletCalls.push(a), []), on() {}, removeListener() {} };
  });
}

test("D4: the landing page tells the demo bounty in order, each step linking its real transaction, with no wallet", async ({ page }) => {
  await watchWallet(page);
  const w = finishedDemo();
  await setWorld(page, w);
  await page.goto("/");
  await expect(panel(page, 4)).toContainText("10 USDC went to the Whitehat's account, once.");

  // The eight steps, in the order things happened.
  await expect(page.locator("#panels > li h3")).toHaveText(ORDER.map((s, i) => `${i + 1}.${s}`));

  const hashOf = (event: string) => w.nearTxs.find((t) => t.receipts.some((r) => r.logs.some((l) => l.includes(`"event":"${event}"`))))!.hash;
  const near = (i: number, event: string) => expect(panel(page, i).locator("a[href^='https://nearblocks.io/txns/']")).toHaveAttribute("href", `https://nearblocks.io/txns/${hashOf(event)}`);
  await near(0, "bounty_posted");
  // Sealed and checked are the winning claim's (1), not the cheat claim's (0).
  await expect(panel(page, 1).locator("a").first()).toHaveAttribute("href", `https://nearblocks.io/txns/${w.nearTxs.find((t) => t.hash.startsWith("submit1"))!.hash}`);
  await expect(panel(page, 2).locator("a").first()).toHaveAttribute("href", `https://nearblocks.io/txns/${w.nearTxs.find((t) => t.hash.startsWith("judged1"))!.hash}`);
  await expect(panel(page, 2)).toContainText("Verdict PAYS");
  await expect(panel(page, 2)).toContainText("Cheat claim: ZERO");
  await near(3, "pauses_signed");
  await near(4, "bounty_paid");
  const pauses = w.bounties[0]!.signed_pauses;
  expect(await hrefs(page, 5)).toEqual([
    `https://basescan.org/tx/${pauses.find((p) => p.chain_id === 8453)!.tx_hash}`,
    `https://arbiscan.io/tx/${pauses.find((p) => p.chain_id === 42161)!.tx_hash}`,
  ]);
  await expect(panel(page, 6).locator("a")).toHaveCount(2);
  await expect(panel(page, 6)).toContainText("2 of 2 verified");
  await near(7, "exploit_published");
  // Every link is a transaction: none is left pending.
  await expect(page.locator("#panels")).not.toContainText("tx pending");

  // No wallet: nothing asked for one.
  expect(await page.evaluate(() => (window as any).__walletCalls.length)).toBe(0);
});

test("D4: a step that hasn't happened yet links no transaction: it says tx pending", async ({ page }) => {
  const w = emptyWorld();
  post(w, DEMO);
  await setWorld(page, w);
  await page.goto("/");
  await expect(panel(page, 0).locator("a").first()).toHaveAttribute("href", /^https:\/\/nearblocks\.io\/txns\//);
  for (const i of [1, 2, 3, 4]) {
    await expect(panel(page, i)).toContainText("tx pending");
    await expect(panel(page, i).locator("a")).toHaveAttribute("href", "https://nearblocks.io/");
  }
  expect(await hrefs(page, 5)).toEqual(["https://basescan.org/", "https://arbiscan.io/"]);
  await expect(panel(page, 2)).not.toContainText("Verdict PAYS");
  await expect(panel(page, 7)).toContainText("pending · after 1 day");
});

test("R15.6: the story's amounts and delay are the bounty's on chain", async ({ page }) => {
  const w = finishedDemo();
  const b = w.bounties[0]!;
  b.rules = { ...b.rules, bounty_amount: "25000000", minimum_theft: "2000000", disclosure_delay_days: 3 };
  await setWorld(page, w);
  await page.goto("/");
  await expect(panel(page, 0)).toContainText("locked 25 USDC behind rules nobody can change");
  await expect(panel(page, 2)).toContainText("more than the 2 USDC minimum theft");
  await expect(panel(page, 7)).toContainText("After the 3-day disclosure delay");
  await expect(page.getByRole("definition").filter({ hasText: "25 USDC" })).toContainText("25 USDC, once");
});

test("D4, ADR-0017: no testnet string or explorer link ships in the mainnet build", async ({ page }) => {
  await setWorld(page, finishedDemo());
  await page.goto("/");
  await expect(panel(page, 0).locator("a").first()).toHaveAttribute("href", /nearblocks/);
  // The one exception is D31's link to the testnet site: its address (set on this build) and its words.
  const withoutTheLink = (text: string) => text.replaceAll(SITES.testnet, "").replaceAll("Try it on testnet", "");
  const html = await page.content();
  expect(html).toContain(SITES.testnet);
  expect(withoutTheLink(html)).not.toMatch(/testnet|sepolia/i);
  // And none in any file the browser is sent.
  const files: string[] = [];
  const walk = (dir: string) => readdirSync(dir).forEach((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : files.push(join(dir, f))));
  walk(join(import.meta.dirname, "../.next/static"));
  walk(join(import.meta.dirname, "../public"));
  const hits = files.filter((f) => /testnet|sepolia/i.test(withoutTheLink(readFileSync(f, "utf8"))));
  expect(hits).toEqual([]);
});

test("D6, D30: the landing page's Verify lists the demo bounty's checks, read live, under a command naming mainnet's contract", async ({ page }) => {
  await setWorld(page, finishedDemo());
  await page.goto("/");
  await page.locator("#verify").scrollIntoViewIfNeeded();
  const run = page.getByRole("list", { name: "Check results" });
  await expect(run.getByRole("listitem").filter({ hasText: "Payout on NEAR" })).toContainText("PASS");
  await expect(run.getByRole("listitem").filter({ hasText: "Pauses verified on NEAR" })).toContainText("PASS");
  await expect(page.locator("#cmd")).toHaveText(`$bountee verify ${DEMO.protocol}/${DEMO.name} --contract bounty.bountee.near --network mainnet`);
});

test("D4, R15.6: the story says an AI agent won with a claim key only when NEAR shows the claim was filed with one", async ({ page }) => {
  // Won, but the winning claim was signed with the Whitehat's full-access key.
  const w = emptyWorld();
  post(w, DEMO);
  win(w, DEMO, 1, { landed: [BASE, ARBITRUM], verified: [BASE, ARBITRUM] });
  await setWorld(page, w);
  await page.goto("/");
  await expect(panel(page, 4)).toContainText("went to the Whitehat's account, once.");
  await expect(page.locator("#panels")).not.toContainText("claim key");
  await expect(page.getByRole("definition").filter({ hasText: "claim key" })).toHaveCount(0);
  await expect(page.locator("#a5")).not.toContainText("The demo bounty was won by one.");

  // The same win, filed with a claim key.
  await setWorld(page, finishedDemo());
  await page.reload();
  await expect(panel(page, 1)).toContainText("holding only a claim key");
  await expect(page.getByText("a Whitehat's AI agent, with a claim key")).toBeVisible();
  await expect(page.locator("#a5")).toContainText("The demo bounty was won by one.");
});

test("R15.6: a ZERO claim on another bounty isn't this bounty's cheat claim", async ({ page }) => {
  const w = emptyWorld();
  post(w, { protocol: "other.near", name: "pool" });
  judge(w, { protocol: "other.near", name: "pool" }, 0, "ZERO");
  post(w, DEMO);
  win(w, DEMO, 1, { landed: [BASE, ARBITRUM] });
  await setWorld(page, w);
  await page.goto("/");
  await expect(panel(page, 2)).toContainText("Verdict PAYS");
  await expect(panel(page, 2)).not.toContainText("Cheat claim");
  await expect(panel(page, 2)).not.toContainText("cheat claim");
});

test("R15.6: a ZERO claim filed after the win isn't the earlier cheat claim", async ({ page }) => {
  const w = emptyWorld();
  post(w, DEMO);
  win(w, DEMO, 1, { landed: [BASE, ARBITRUM] });
  judge(w, DEMO, 2, "ZERO");
  await setWorld(page, w);
  await page.goto("/");
  await expect(panel(page, 2)).toContainText("Verdict PAYS");
  await expect(panel(page, 2)).not.toContainText("cheat claim");
});
