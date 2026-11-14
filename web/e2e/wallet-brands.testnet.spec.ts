// Seam W, ticket #94: the public pages name no wallet brand (D37), on the testnet build; the
// mainnet build's side is in wallet-brands.spec.ts. The brand list, pinned by spec #89, and the
// scan are in stand-ins/brands.ts.
import { expect, test, type Page } from "@playwright/test";
import { brandsNamed } from "./stand-ins/brands.ts";
import { claimInProgress, emptyWorld, judge, NETWORKS, post, rules, setWorld, win, type BountyId, type BountyView } from "./stand-ins/world.ts";

const T = NETWORKS.testnet;
const PAID: BountyId = { protocol: "brassmoor-lend.testnet", name: "pool" };
const LIVE: BountyId = { protocol: "0x4b1d9e2a7c3f5b8d0e6a1c4f7b2d9e3a5c8f1b6d", name: "vault" };
/** Long gone, so a live bounty with it reads "Ended, unclaimed". */
const PAST_END = "1700000000000000000";
/** The bounty states not yet named above, each with its own page: still checking, ended unclaimed, withdrawn, and not posted (its check failed). */
const OTHER_STATES: [BountyId, Partial<BountyView>][] = [
  [{ protocol: "brassmoor-lend.testnet", name: "checking" }, { state: "checking" }],
  [{ protocol: "brassmoor-lend.testnet", name: "ended" }, { rules: rules({ end_date_ns: PAST_END }, "testnet") }],
  [{ protocol: "brassmoor-lend.testnet", name: "withdrawn" }, { state: "withdrawn" }],
  [{ protocol: "brassmoor-lend.testnet", name: "setup" }, { state: "check_failed" }],
];

test("D37: on the testnet build, / (the bounty list, both tabs), every bounty state's page and its Verify checks name no wallet brand", async ({ page }) => {
  const w = emptyWorld("testnet");
  post(w, PAID);
  win(w, PAID, 0, { landed: [T.base, T.arbitrum], verified: [T.base] });
  post(w, LIVE);
  judge(w, LIVE, 1, "ZERO");
  for (const [id, over] of OTHER_STATES) post(w, id, over);
  claimInProgress(w, LIVE, 2);
  await setWorld(page, w);

  const pages: [string, (p: Page) => Promise<void>][] = [
    ["/", (p) => expect(p.getByRole("link", { name: `${LIVE.protocol}/${LIVE.name}` })).toBeVisible()],
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
