// Seam W, ticket #74: what tells the testnet site from the mainnet one (D31, D32). The testnet
// build (playwright.config.ts, project "testnet") is told the mainnet site's address; the
// mainnet build's side is in sites.spec.ts, and the builds with no address set in build.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import { emptyWorld, NETWORKS, post, setWorld, win, type BountyId } from "./stand-ins/world.ts";
import { SITES } from "./stand-ins/sites.ts";

const T = NETWORKS.testnet;
const ID: BountyId = { protocol: "brassmoor-lend.testnet", name: "pool" };
const bountyPage = `/bounties/${ID.protocol}/${ID.name}`;
/** Every app page the nav sits on: the bounty list, a bounty page, the posting flow and the open-exploit page. */
const PAGES = ["/bounties", bountyPage, "/post", `${bountyPage}/exploit`];

async function paidWorld(page: Page) {
  const w = emptyWorld("testnet");
  post(w, ID);
  win(w, ID, 0, { landed: [T.base, T.arbitrum], verified: [T.base, T.arbitrum] });
  await setWorld(page, w);
}

test("D31: on every app page the testnet badge sits beside the wordmark and links to the mainnet site", async ({ page }) => {
  await paidWorld(page);
  for (const path of PAGES) {
    await page.goto(path);
    const nav = page.getByRole("banner");
    const badge = nav.getByRole("link", { name: "Testnet" });
    await expect(badge, path).toHaveAttribute("href", SITES.mainnet);
    await expect(nav.getByText("Testnet"), path).toHaveCount(1);
    // Beside the wordmark: just right of it, on the same line.
    const mark = (await nav.getByRole("link", { name: "BounTEE, home" }).boundingBox())!;
    const b = (await badge.boundingBox())!;
    expect(b.x - (mark.x + mark.width), path).toBeGreaterThanOrEqual(0);
    expect(b.x - (mark.x + mark.width), path).toBeLessThanOrEqual(24);
    expect(Math.abs(b.y + b.height / 2 - (mark.y + mark.height / 2)), path).toBeLessThanOrEqual(2);
  }
});

test("D31: testnet / lands on the bounty list, never the demo story, and the nav's Verify link goes to the mainnet site's Verify section", async ({ page }) => {
  await paidWorld(page);
  const demo: string[] = [];
  page.on("request", (r) => void (new URL(r.url()).pathname === "/api/demo" && demo.push(r.url())));
  await page.goto("/");
  await expect(page).toHaveURL(/\/bounties$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Bounties");
  await expect(page.getByRole("banner").getByRole("link", { name: "Verify" })).toHaveAttribute("href", `${SITES.mainnet}/#verify`);
  expect(demo).toEqual([]);
});
