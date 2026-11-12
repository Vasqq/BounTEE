// Seam W, ticket #93: the wallet picker says why only some wallets are listed (D34), and the
// two signing pages, the posting flow and the open-exploit page, name no wallet brand outside
// the open picker (D37): they say "your wallet". The public pages' side of D37 is in
// wallet-brands.spec.ts.
//
// What this seam misses: how the picker looks (its theme on DESIGN.md's tokens), which the
// front-end check-in's screenshots show, and real wallets' own windows, which name themselves.
// The phone project may show RainbowKit's mobile list, so the picker test runs in the desktop
// project only.
import { expect, test, type Page } from "@playwright/test";
import { emptyWorld, fundNear, post, postingWorld, setWorld, VAULT_ARB, VAULT_BASE, win, type BountyId, type World } from "./stand-ins/world.ts";
import { addressOf, exploitPublicKey, metamask, OTHER_KEY, pickWallet, PROTOCOL_KEY, release } from "./stand-ins/wallet.ts";

const ACCOUNT = addressOf(PROTOCOL_KEY).toLowerCase();
const ID: BountyId = { protocol: "0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e", name: "vault-v2" };
const NEAR = 10n ** 24n;
const DISCLAIMER = "Only wallets that can sign on NEAR are shown.";

/** Spec #89's pinned brand list, matched case-sensitively. Its twins are in wallet-brands.spec.ts and wallet-brands.testnet.spec.ts: keep them in step. */
const BRANDS = ["MetaMask", "Rabby", "Zerion", "Brave Wallet", "WalletConnect", "Reown", "Coinbase", "Phantom", "Rainbow", "Trust Wallet", "OKX", "Ledger Live"];

/**
 * Every wallet brand the page names outside the open picker, with the text that names it: in
 * its text, shown or not (a hint's tooltip), its title and head meta tags, and every element's
 * aria-*, title, alt and placeholder attributes. Scripts and styles are code, not copy. The
 * open picker (its dialog) is left out: listing wallets by name is its job (D34). As
 * wallet-brands.spec.ts's, but for the picker.
 */
async function brandsNamed(page: Page): Promise<string[]> {
  return page.evaluate((brands) => {
    const picker = (n: Node | null) => !!(n instanceof Element ? n : n?.parentElement)?.closest("[role=dialog]");
    const texts = [document.title, ...[...document.head.querySelectorAll("meta[content]")].map((m) => m.getAttribute("content") ?? "")];
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (!n.parentElement?.closest("script, style, noscript, template") && !picker(n)) texts.push(n.textContent ?? "");
    }
    for (const el of document.querySelectorAll("*")) {
      if (picker(el)) continue;
      for (const a of el.attributes) if (/^(aria-|title$|alt$|placeholder$)/.test(a.name)) texts.push(a.value);
    }
    return texts.flatMap((t) => brands.filter((b) => t.includes(b)).map((b) => `${b}: ${t.trim().slice(0, 120)}`));
  }, BRANDS);
}

/** Checks the page names no wallet brand outside the picker, naming the step in any failure. */
async function noBrand(page: Page, at: string) {
  expect(await brandsNamed(page), at).toEqual([]);
}

const step = (page: Page, n: number) => page.getByRole("region", { name: new RegExp(`^${n}\\. `) });
const item = (page: Page, title: RegExp) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });
const state = (page: Page, title: RegExp) => item(page, title).getByRole("heading").locator(".item-state");
const task = (page: Page, chain: RegExp, row: RegExp) => item(page, chain).locator(".task").filter({ has: page.locator(".task-label", { hasText: row }) });
const taskState = (page: Page, chain: RegExp, row: RegExp) => task(page, chain, row).locator(".item-state");
/** The wallet entries in the open picker: its buttons with a wallet icon, not the compact modal's Info button. */
const entries = (page: Page) => page.getByRole("dialog").getByRole("button").filter({ has: page.getByRole("img") }).filter({ hasNot: page.getByRole("img", { name: "Info", exact: true }) });

/** Step 1's rules, as posting.spec.ts fills them, then on to step 2. */
async function fillRules(page: Page) {
  const rules = step(page, 1);
  await rules.getByLabel("What does this bounty protect?").fill("Vault V2");
  await rules.getByRole("combobox", { name: "Chain" }).nth(0).click();
  await page.getByRole("option", { name: "Base" }).click();
  await rules.getByLabel("Contract address").first().fill(VAULT_BASE);
  await rules.getByRole("button", { name: "Add a contract" }).click();
  await rules.getByRole("combobox", { name: "Chain" }).nth(1).click();
  await page.getByRole("option", { name: "Arbitrum One" }).click();
  await rules.getByLabel("Contract address").nth(1).fill(VAULT_ARB);
  await rules.getByLabel("Bounty amount").fill("10");
  await rules.getByLabel("Smallest theft that counts").fill("1");
  await rules.getByRole("radio", { name: "Custom" }).check();
  await rules.getByLabel("Exact end date").fill("2026-12-31");
  await rules.getByLabel("Keep the exploit private for").fill("1");
  await rules.getByRole("button", { name: "Continue" }).click();
}

function paidAndReleased(): World {
  const w = emptyWorld();
  post(w, ID);
  w.bounties[0]!.rules.exploit_public_key = exploitPublicKey(PROTOCOL_KEY, ID);
  win(w, ID, 0, { landed: [8453, 42161] });
  w.releases[`${ID.protocol}/${ID.name}`] = { claim_id: 0, state: "released", released: release(w.bounties[0]!.rules.exploit_public_key, ID, 0) };
  return w;
}

/** The two signing pages, each opened at the button that opens the picker. */
const PAGES = {
  posting: {
    async open(page: Page) {
      await setWorld(page, postingWorld(ACCOUNT, { onboarded: true }));
      await page.goto("/post#3");
    },
    connect: (page: Page) => step(page, 3).getByRole("button", { name: "Connect wallet" }),
  },
  "open-exploit": {
    async open(page: Page) {
      await setWorld(page, paidAndReleased());
      await page.goto(`/bounties/${ID.protocol}/${ID.name}/exploit`);
    },
    connect: (page: Page) => page.getByRole("button", { name: "Open with your wallet" }),
  },
} as const;

for (const [name, at] of Object.entries(PAGES)) {
  test(`D34: on the ${name} page, the open picker says beneath its list that only wallets that can sign on NEAR are shown`, async ({ page }) => {
    await at.open(page);
    await at.connect(page).click();
    const picker = page.getByRole("dialog");
    await expect(entries(page)).toHaveText(["MetaMask", "Rabby Wallet", "Zerion"]);
    await expect(picker.getByText(DISCLAIMER, { exact: true })).toBeVisible();
    // Measured once the picker's opening animation has finished, so both boxes are where they stay.
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    const last = (await entries(page).last().boundingBox())!;
    const line = (await picker.getByText(DISCLAIMER, { exact: true }).boundingBox())!;
    expect(line.y).toBeGreaterThanOrEqual(last.y + last.height);
  });
}

test("D37: the posting flow names no wallet brand outside the picker, through every step and a rejected signature",async ({ page }) => {
  test.setTimeout(120_000);
  await metamask(page, PROTOCOL_KEY, { rejectFirstSign: true });
  await setWorld(page, postingWorld(ACCOUNT, { near: "0", usdc: "10000000" }));
  await page.goto("/post");
  await expect(step(page, 1).getByLabel("What does this bounty protect?")).toBeVisible();
  await noBrand(page, "1. Set rules");
  await expect(page.getByText("Everything signs with your wallet. No NEAR wallet needed.")).toBeVisible();

  // 1. The rules, then 2. Set up pause, where the wallet connects.
  await fillRules(page);
  await expect(step(page, 2).getByRole("button", { name: "Connect wallet" })).toBeVisible();
  await noBrand(page, "2. Set up pause, before connecting");
  await step(page, 2).getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await noBrand(page, "2. Set up pause, picker open");
  await pickWallet(page);
  await expect(task(page, /Base/, /Pause role/).getByRole("button", { name: "Grant", exact: true })).toBeVisible();
  await noBrand(page, "2. Set up pause, connected");
  for (const chain of [/Base/, /Arbitrum One/]) {
    await task(page, chain, /Pause role/).getByRole("button", { name: "Grant", exact: true }).click();
    await expect(taskState(page, chain, /Pause role/)).toHaveText("granted", { timeout: 15_000 });
    await task(page, chain, /Pause gas/).getByRole("button", { name: /^Send / }).click();
    await expect(taskState(page, chain, /Pause gas/)).toHaveText("funded", { timeout: 15_000 });
  }
  await noBrand(page, "2. Set up pause, done");
  await page.getByRole("button", { name: "Continue" }).click();

  // 3. Add funds: the account is the wallet's address.
  await expect(step(page, 3)).toContainText("Your wallet's address, on NEAR.");
  await noBrand(page, "3. Add funds");
  await fundNear(page, ACCOUNT, String(NEAR));
  await expect(state(page, /Fees/)).toHaveText("received", { timeout: 15_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  // 4. Post bounty: a rejected signature says the wallet didn't send it, then each prompt in turn.
  const post4 = step(page, 4);
  await expect(post4.getByText("Lets your wallet sign for your NEAR account. Free, and needed once.")).toBeVisible();
  await noBrand(page, "4. Post bounty");
  await post4.getByRole("button", { name: "Sign with your wallet" }).click();
  await expect(post4.getByRole("alert")).toHaveText("Your wallet didn't send it.");
  await noBrand(page, "4. Post bounty, signature rejected");
  await post4.getByRole("button", { name: "Sign with your wallet" }).click();
  await expect(state(page, /Your exploit key/)).toHaveText("signed");
  await post4.getByRole("button", { name: "Enable NEAR signing" }).click();
  await expect(state(page, /Enable NEAR signing/)).toHaveText("done");
  await post4.getByRole("button", { name: "Prepay the posting fee" }).click();
  await post4.getByRole("button", { name: "Post the bounty" }).click();
  await expect(post4).toContainText("Your bounty is live.", { timeout: 15_000 });
  await noBrand(page, "4. Post bounty, live");
});

test("D37, D20: the posting flow's key-file fallback names no wallet brand", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY, { unstable: true });
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true }));
  await page.goto("/post");
  await fillRules(page);
  await step(page, 2).getByRole("button", { name: "Connect wallet" }).click();
  await pickWallet(page);
  await page.getByRole("navigation", { name: "Posting steps" }).getByRole("button", { name: "4. Post bounty" }).click();
  await step(page, 4).getByRole("button", { name: "Sign with your wallet" }).click();
  await expect(step(page, 4)).toContainText("gave two different signatures");
  await noBrand(page, "4. Post bounty, signatures differ");
});

test("D37: the open-exploit page names no wallet brand, before the payout, before the release, and through opening it", async ({ page }) => {
  const open = () => page.goto(`/bounties/${ID.protocol}/${ID.name}/exploit`);
  const posted = emptyWorld();
  post(posted, ID);
  await setWorld(page, posted);
  await open();
  await expect(page.getByText("This exploit opens once the Whitehat is paid.")).toBeVisible();
  await noBrand(page, "before the payout");

  const paid = emptyWorld();
  post(paid, ID);
  win(paid, ID, 0, { landed: [8453, 42161] });
  await setWorld(page, paid);
  await open();
  await expect(page.getByText(/The Whitehat is paid/)).toBeVisible();
  await noBrand(page, "paid, not released");

  await metamask(page, PROTOCOL_KEY, { rejectFirstSign: true });
  await setWorld(page, paidAndReleased());
  await open();
  await expect(page.getByRole("button", { name: "Open with your wallet" })).toBeEnabled();
  await noBrand(page, "released");
  await page.getByRole("button", { name: "Open with your wallet" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await noBrand(page, "picker open");
  await pickWallet(page);
  await expect(page.getByText("User rejected the request.")).toBeVisible();
  await noBrand(page, "signature rejected");
  await page.getByRole("button", { name: "Open with your wallet" }).click();
  await expect(page.getByRole("region", { name: "Winning exploit" })).toBeVisible();
  await noBrand(page, "opened");
});

test("D37, D20: the open-exploit page's wrong-key and key-file messages name no wallet brand", async ({ page }) => {
  await metamask(page, OTHER_KEY, { unstable: true });
  await setWorld(page, paidAndReleased());
  await page.goto(`/bounties/${ID.protocol}/${ID.name}/exploit`);
  await page.getByRole("button", { name: "Open with your wallet" }).click();
  await pickWallet(page);
  await expect(page.getByLabel("Exploit key file")).toBeVisible();
  await noBrand(page, "signatures differ");
  await page.getByLabel("Exploit key file").setInputFiles({ name: "exploit-key.hex", mimeType: "text/plain", buffer: Buffer.from("11".repeat(32)) });
  await expect(page.getByText(/This wallet's key isn't this bounty's exploit key/)).toBeVisible();
  await noBrand(page, "wrong key");
});
