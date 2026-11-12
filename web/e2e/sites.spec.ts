// Seam W, ticket #74: the mainnet build's side of the two sites (D31). It is told the testnet
// site's address (playwright.config.ts); the testnet build's side is in sites.testnet.spec.ts,
// and the builds with no address set in build.spec.ts.
import { expect, test } from "@playwright/test";
import { ARBITRUM, BASE, emptyWorld, finishedDemo, post, setWorld, win, type BountyId } from "./stand-ins/world.ts";
import { SITES } from "./stand-ins/sites.ts";

const ID: BountyId = { protocol: "brassmoor-lend.near", name: "pool" };
const bountyPage = `/bounties/${ID.protocol}/${ID.name}`;

test("D31: the mainnet build shows no testnet badge on any app page", async ({ page }) => {
  const w = emptyWorld();
  post(w, ID);
  win(w, ID, 0, { landed: [BASE, ARBITRUM], verified: [BASE, ARBITRUM] });
  await setWorld(page, w);
  for (const path of ["/bounties", bountyPage, "/post", `${bountyPage}/exploit`]) {
    await page.goto(path);
    await expect(page.getByRole("banner").getByRole("link", { name: "BounTEE, home" }), path).toBeVisible();
    await expect(page.getByRole("banner").getByText("Testnet"), path).toHaveCount(0);
    await expect(page.getByRole("banner").getByRole("link", { name: "Verify" }), path).toHaveAttribute("href", "/#verify");
  }
});

test("D31: the mainnet bounty list and the landing page's footer link to the testnet site", async ({ page }) => {
  await setWorld(page, emptyWorld());
  await page.goto("/bounties");
  await expect(page.getByRole("main").getByRole("link", { name: "Try it on testnet" })).toHaveAttribute("href", SITES.testnet);

  await setWorld(page, finishedDemo());
  await page.goto("/");
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Try it on testnet" })).toHaveAttribute("href", SITES.testnet);
});

test("D31: the mainnet landing page's Open the app and Post a bounty buttons open the testnet site", async ({ page }) => {
  await setWorld(page, finishedDemo());
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Open the app" })).toHaveAttribute("href", `${SITES.testnet}/bounties`);
  await expect(page.getByRole("link", { name: "Post a bounty" })).toHaveAttribute("href", `${SITES.testnet}/post`);
});
