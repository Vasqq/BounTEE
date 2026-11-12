// Seam W, ticket #29: the landing page tells the mainnet demo bounty as a story (D4), read
// live from the chains (R15.6), with no wallet.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { ARBITRUM, BASE, CONTRACT, DEMO, emptyWorld, finishedDemo, judge, nearHash, post, setWorld, win, type World } from "./stand-ins/world.ts";
import { APPS, SITES } from "./stand-ins/sites.ts";
import { bounteeOnly, filesUnder, sentToBrowser } from "./stand-ins/bundle.ts";

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

test("R15.6, D28: the story's amounts and delay are the bounty's on chain, and the checked step names the chain and block the win was proven on", async ({ page }) => {
  const w = finishedDemo();
  const b = w.bounties[0]!;
  b.rules = { ...b.rules, bounty_amount: "25000000", minimum_theft: "2000000", disclosure_delay_days: 3 };
  await setWorld(page, w);
  await page.goto("/");
  await expect(panel(page, 0)).toContainText("locked 25 USDC behind rules nobody can change");
  await expect(panel(page, 2)).toContainText("The Enclave replayed the exploit with revm against Base at block 38,000,001. It took more than the 2 USDC minimum theft.");
  await expect(panel(page, 7)).toContainText("After the 3-day disclosure delay");
  await expect(page.getByRole("definition").filter({ hasText: "25 USDC" })).toContainText("25 USDC, once");
});

test("D4, ADR-0017, ADR-0022: no testnet string or explorer link ships in the mainnet build", async ({ page }) => {
  test.setTimeout(60_000);
  await setWorld(page, finishedDemo());
  await page.goto("/");
  await expect(panel(page, 0).locator("a").first()).toHaveAttribute("href", /nearblocks/);
  // The one exception is D31's link to the testnet site: its address (set on this build) and its words.
  const withoutTheLink = (text: string) => text.replaceAll(SITES.testnet, "").replaceAll("Try it on testnet", "");
  expect(await page.content()).toContain(SITES.testnet);
  // None in any page's HTML or any file the browser is sent, but RainbowKit's chain metadata,
  // which carries none of testnet's own values (ADR-0022, see sentToBrowser()).
  const noTestnet = (text: string) => !/testnet|sepolia/i.test(withoutTheLink(text));
  const { failing, walletLibraries } = await sentToBrowser(page, APPS.mainnet, join(import.meta.dirname, "../.next"), noTestnet);
  expect(failing).toEqual([]);
  for (const testnet of bounteeOnly("testnet")) expect(walletLibraries).not.toContain(testnet);
  expect(filesUnder(join(import.meta.dirname, "../public")).filter((f) => !noTestnet(readFileSync(f, "utf8")))).toEqual([]);
});

test("D6, D30: the landing page's Verify lists the demo bounty's checks, read live, under a command naming mainnet's contract", async ({ page }) => {
  await setWorld(page, finishedDemo());
  await page.goto("/");
  await page.locator("#verify").scrollIntoViewIfNeeded();
  const run = page.getByRole("list", { name: "Check results" });
  await expect(run.getByRole("listitem").filter({ hasText: "Payout on NEAR" })).toContainText("PASS");
  await expect(run.getByRole("listitem").filter({ hasText: "Pauses verified on NEAR" })).toContainText("PASS");
  await expect(page.locator("#cmd")).toHaveText(`$bountee verify ${DEMO.protocol}/${DEMO.name} --contract ${CONTRACT} --network mainnet`);
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

/** The winning claim filed, judged, signed and paid in one NEAR transaction, as the mainnet run was. */
function oneTransactionWin(w: World) {
  const parts = ["submit1", "judged1", "signed1"].map((seed) => w.nearTxs.find((t) => t.hash === nearHash(seed))!);
  const one = { ...parts[0]!, receipts: parts.flatMap((t) => t.receipts) };
  w.nearTxs = [...w.nearTxs.filter((t) => !parts.includes(t)), one];
  return one;
}

test("D4: steps 2–5 say they ran in one NEAR transaction only when they link the same one", async ({ page }) => {
  await setWorld(page, finishedDemo());
  await page.goto("/");
  await expect(panel(page, 1)).toContainText("holding only a claim key");
  await expect(panel(page, 1)).not.toContainText("one NEAR transaction");

  const w = finishedDemo();
  const one = oneTransactionWin(w);
  await setWorld(page, w);
  await page.reload();
  await expect(panel(page, 1)).toContainText("Filing, judging, signing and payout ran in this one NEAR transaction.");
  for (const i of [1, 2, 3, 4]) await expect(panel(page, i).locator("a").first()).toHaveAttribute("href", `https://nearblocks.io/txns/${one.hash}`);
});

test("R15.6: the cheat claim links the transaction that judged it ZERO, and names the Whitehat's own key only when NEAR shows it", async ({ page }) => {
  // Filed by another account: the cheat is linked, and nobody's key is named.
  await setWorld(page, finishedDemo());
  await page.goto("/");
  await expect(panel(page, 2).locator(`a[href="https://nearblocks.io/txns/${nearHash("judged0")}"]`)).toHaveCount(1);
  await expect(panel(page, 2)).toContainText("Cheat claim: ZERO");
  await expect(panel(page, 2)).not.toContainText("their own key");

  // Filed by the winning Whitehat with their full-access key, as on mainnet.
  const w = emptyWorld();
  post(w, DEMO);
  judge(w, DEMO, 0, "ZERO", "whitehat.near");
  win(w, DEMO, 1, { landed: [BASE, ARBITRUM], verified: [BASE, ARBITRUM] });
  await setWorld(page, w);
  await page.reload();
  await expect(panel(page, 2)).toContainText("An earlier cheat claim, filed by the Whitehat with their own key, passed off as theft, scored zero and nothing moved.");
});

test("R15.6, R15.1: before publication, the story and Verify say when the exploit becomes publishable, as the contract records it", async ({ page }) => {
  const w = emptyWorld();
  post(w, DEMO);
  win(w, DEMO, 1, { landed: [BASE, ARBITRUM], verified: [BASE, ARBITRUM] });
  // The contract's own value on the mainnet run: payout + 1 day.
  w.publications[`${DEMO.protocol}/${DEMO.name}`] = { claim_id: 1, state: "delayed", publishable_from_ns: "1794458244692574994", published: null };
  await setWorld(page, w);
  await page.goto("/");
  await expect(panel(page, 7)).toContainText("pending · from 2026-11-12 04:37 UTC");
  await expect(panel(page, 7).locator("a")).toHaveCount(0);
  await page.locator("#verify").scrollIntoViewIfNeeded();
  await expect(page.getByRole("list", { name: "Check results" }).getByRole("listitem").filter({ hasText: "Re-run of the published exploit" })).toContainText("not yet published · publishable from 2026-11-12 04:37 UTC");
});

test("D4, R15.6: the page's HTML, before any script runs, lists every step's transactions", async ({ page }) => {
  const w = finishedDemo();
  await setWorld(page, w);
  const html = await (await page.request.get("/")).text();
  const hashes = [
    nearHash("postmainnet-demo"),
    nearHash("submit1"),
    nearHash("judged1"),
    nearHash("judged0"),
    nearHash("signed1"),
    ...w.bounties[0]!.signed_pauses.map((p) => p.tx_hash),
    nearHash(`verified${BASE}`),
    nearHash(`verified${ARBITRUM}`),
    nearHash("published1"),
  ];
  for (const h of hashes) expect(html, h).toContain(h);
  expect(html).toContain('href="/api/demo"');

  // In the page, the list is closed under the story and opens to the same links.
  await page.goto("/");
  const all = page.locator("details.all-tx");
  await expect(all.locator("summary")).toHaveText("All eight steps' transactions");
  await all.locator("summary").click();
  await expect(all.locator("li")).toHaveCount(8);
  await expect(all.locator("li").nth(5).locator("a")).toHaveCount(2);
});

test("D4: the page still tells the story when it is laid out with no size", async ({ page }) => {
  await setWorld(page, finishedDemo());
  await page.setContent(`<iframe src="${APPS.mainnet}/" style="width:0;height:0;border:0"></iframe>`);
  const frame = page.frameLocator("iframe");
  await expect(frame.locator("#panels > li")).toHaveCount(8);
  await expect(frame.locator("#panels > li").nth(4)).toContainText("10 USDC went to the Whitehat's account, once.");
});
