// Seam W, ticket #94: the public pages name no wallet brand (D37), on the mainnet build; the
// testnet build's side is in wallet-brands.testnet.spec.ts. The brand list is pinned by spec #89.
import { expect, test, type Page } from "@playwright/test";
import { ARBITRUM, BASE, claimInProgress, finishedDemo, judge, post, rules, setWorld, win, type BountyId, type BountyView } from "./stand-ins/world.ts";

/** Spec #89's pinned brand list, matched case-sensitively. Its twins are in wallet-brands.testnet.spec.ts and signing-copy.spec.ts: keep them in step. */
const BRANDS = ["MetaMask", "Rabby", "Zerion", "Brave Wallet", "WalletConnect", "Reown", "Coinbase", "Phantom", "Rainbow", "Trust Wallet", "OKX", "Ledger Live"];

/**
 * Every wallet brand the page names, with the text that names it: in its text, shown or not
 * (a closed FAQ answer, a hint's tooltip), its title and head meta tags, and every element's aria-*, title, alt and
 * placeholder attributes. Scripts and styles are code, not copy. Kept in this file (and copied
 * in its testnet twin, since a spec can't import a spec) so the shared stand-ins stay untouched.
 */
async function brandsNamed(page: Page): Promise<string[]> {
  return page.evaluate((brands) => {
    const texts = [document.title, ...[...document.head.querySelectorAll("meta[content]")].map((m) => m.getAttribute("content") ?? "")];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.parentElement?.closest("script, style, noscript, template")) texts.push(n.textContent ?? "");
    }
    for (const el of document.querySelectorAll("*")) {
      for (const a of el.attributes) if (/^(aria-|title$|alt$|placeholder$)/.test(a.name)) texts.push(a.value);
    }
    return texts.flatMap((t) => brands.filter((b) => t.includes(b)).map((b) => `${b}: ${t.trim().slice(0, 120)}`));
  }, BRANDS);
}

const PAID: BountyId = { protocol: "acme.near", name: "vault-v2" };
const LIVE: BountyId = { protocol: "0x4b1d9e2a7c3f5b8d0e6a1c4f7b2d9e3a5c8f1b6d", name: "pool" };
/** Long gone, so a live bounty with it reads "Ended, unclaimed". */
const PAST_END = "1700000000000000000";
/** The bounty states not yet named above, each with its own page: still checking, ended unclaimed, withdrawn, and not posted (its check failed). */
const OTHER_STATES: [BountyId, Partial<BountyView>][] = [
  [{ protocol: "acme.near", name: "checking" }, { state: "checking" }],
  [{ protocol: "acme.near", name: "ended" }, { rules: rules({ end_date_ns: PAST_END }) }],
  [{ protocol: "acme.near", name: "withdrawn" }, { state: "withdrawn" }],
  [{ protocol: "acme.near", name: "setup" }, { state: "check_failed" }],
];

test("D37: the landing page, the bounty list (both tabs), every bounty state's page and its Verify checks name no wallet brand", async ({ page }) => {
  // The finished demo the landing page tells, a paid bounty, a Live one with claims judged, and one in each other state.
  const w = finishedDemo();
  post(w, PAID);
  win(w, PAID, 2, { landed: [BASE, ARBITRUM], verified: [BASE] });
  post(w, LIVE);
  judge(w, LIVE, 3, "ZERO");
  for (const [id, over] of OTHER_STATES) post(w, id, over);
  claimInProgress(w, LIVE, 4);
  await setWorld(page, w);

  const pages: [string, (p: Page) => Promise<void>][] = [
    ["/", (p) => expect(p.locator("#panels > li").nth(4)).toContainText("10 USDC went to the Whitehat's account, once.")],
    ["/bounties", (p) => expect(p.getByRole("link", { name: `${LIVE.protocol}/${LIVE.name}` })).toBeVisible()],
    ["/bounties?tab=past", (p) => expect(p.getByRole("link", { name: `${PAID.protocol}/${PAID.name}` })).toBeVisible()],
    [`/bounties/${PAID.protocol}/${PAID.name}`, (p) => expect(p.getByRole("region", { name: "Verify" }).getByText("PASS").first()).toBeVisible()],
    [`/bounties/${LIVE.protocol}/${LIVE.name}`, (p) => expect(p.getByText("Live", { exact: true }).first()).toBeVisible()],
    ...OTHER_STATES.map(([id]): [string, (p: Page) => Promise<void>] => [`/bounties/${id.protocol}/${id.name}`, (p) => expect(p.getByRole("heading", { level: 1 })).toHaveText(`${id.protocol}/${id.name}`)]),
  ];
  for (const [path, ready] of pages) {
    await page.goto(path);
    await ready(page);
    expect(await brandsNamed(page), path).toEqual([]);
  }
});

test("D37: the landing page says posting connects your wallet", async ({ page }) => {
  await setWorld(page, finishedDemo());
  await page.goto("/");
  await expect(page.getByText("Posting connects your wallet. Reading and verifying never do.")).toBeVisible();
  await expect(page.getByText("post from the Ethereum wallet you already use")).toBeVisible();
});
