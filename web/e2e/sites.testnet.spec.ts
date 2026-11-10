// Seam W, ticket #74: what tells the testnet site from the mainnet one (D31, D32). The testnet
// build (playwright.config.ts, project "testnet") is told the mainnet site's address; the
// mainnet build's side is in sites.spec.ts, and the builds with no address set in build.spec.ts.
import { expect, test, type Page } from "@playwright/test";
import { emptyWorld, NETWORKS, post, setWorld, win, type BountyId } from "./stand-ins/world.ts";
import { APPS, SITES } from "./stand-ins/sites.ts";

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

/** The headings, sections and table columns of the page's main content, indented as they nest. The Sepolia chains are named as their mainnet chains, since each build names its own (D30). */
async function outline(page: Page) {
  const tree = await page.getByRole("main").ariaSnapshot();
  return tree
    .split("\n")
    .filter((l) => /^\s*- (heading|region|columnheader)\b/.test(l))
    .map((l) => l.replaceAll("Base Sepolia", "Base").replaceAll("Arbitrum Sepolia", "Arbitrum One"));
}

test("D31: the bounty list, a bounty page and the posting flow have the same headings and sections on both builds", async ({ page }) => {
  // The same bounty on each network: posted by an implicit account, paid, both pauses landed and verified.
  const id: BountyId = { protocol: "0x4b1d9e2a7c3f5b8d0e6a1c4f7b2d9e3a5c8f1b6d", name: "pool" };
  const paid = (network: "mainnet" | "testnet") => {
    const n = NETWORKS[network];
    const w = emptyWorld(network);
    post(w, id);
    win(w, id, 0, { landed: [n.base, n.arbitrum], verified: [n.base, n.arbitrum] });
    return w;
  };
  const pages: [string, (p: Page) => Promise<void>][] = [
    ["/bounties", (p) => expect(p.getByText("1 bounty")).toBeVisible()],
    [`/bounties/${id.protocol}/${id.name}`, (p) => expect(p.getByRole("region", { name: "Verify" }).getByText("PASS").first()).toBeVisible()],
    // The rules step needs no wallet; it's ready once the chain picker shows the build's first chain.
    ["/post", (p) => expect(p.getByRole("combobox", { name: "Chain" })).toBeVisible()],
  ];
  for (const [path, ready] of pages) {
    await setWorld(page, paid("mainnet"));
    await page.goto(`${APPS.mainnet}${path}`);
    await ready(page);
    const mainnet = await outline(page);
    expect(mainnet.length, path).toBeGreaterThan(0);
    await setWorld(page, paid("testnet"));
    await page.goto(`${APPS.testnet}${path}`);
    await ready(page);
    await expect.poll(() => outline(page), { message: path }).toEqual(mainnet);
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
