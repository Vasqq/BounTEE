// Seam W, ticket #29: the public bounty page, read live from the chains.
import { expect, test, type Page } from "@playwright/test";
import { ARBITRUM, BASE, claimInProgress, emptyWorld, judge, PAUSE_GAS_PER_PAUSE, PAUSE_ROLE, post, setWorld, win, type BountyId } from "./stand-ins/world.ts";

const ID: BountyId = { protocol: "acme.near", name: "vault-v2" };
const open = (page: Page, id = ID) => page.goto(`/bounties/${id.protocol}/${id.name}`);
const chainRow = (page: Page, chain: string) => page.getByRole("region", { name: `Pause on ${chain}` });
const step = (page: Page, chain: string, label: string) => chainRow(page, chain).getByRole("listitem").filter({ hasText: label });

test("D22, R7.7: the page counts the claims judged and shows no claim in progress", async ({ page }) => {
  const w = emptyWorld();
  post(w, ID);
  judge(w, ID, 0, "ZERO");
  judge(w, ID, 1, "ZERO");
  judge(w, ID, 2, "ZERO");
  claimInProgress(w, ID, 3);
  // Another bounty's claims aren't this one's.
  post(w, { protocol: "other.near", name: "pool" });
  judge(w, { protocol: "other.near", name: "pool" }, 4, "ZERO");
  await setWorld(page, w);
  await open(page);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("acme.near/vault-v2");
  await expect(page.getByTestId("claims-judged")).toHaveText("3");
  await expect(page.getByText("Live", { exact: true })).toBeVisible();
  // Nothing about claim 3: no "judging", no Whitehat, no in-progress state.
  await expect(page.getByText(/judging|in progress|hunter\.near/i)).toHaveCount(0);
});

test("R7.7: a chain shows landed only once its pause has landed, verified only once the contract records it", async ({ page }) => {
  const w = emptyWorld();
  post(w, ID);
  // Paid: both pauses signed; Base's has landed and NEAR records it verified; Arbitrum One's hasn't landed.
  win(w, ID, 0, { landed: [BASE], verified: [BASE] });
  await setWorld(page, w);
  await open(page);
  await expect(page.getByText("Paid", { exact: true }).first()).toBeVisible();

  await expect(step(page, "Base", "1. Signed")).toContainText("done");
  await expect(step(page, "Base", "2. Landed")).toContainText("done");
  await expect(step(page, "Base", "2. Landed").getByRole("link", { name: /0x/ })).toHaveAttribute("href", /^https:\/\/basescan\.org\/tx\/0x/);
  await expect(step(page, "Base", "3. Verified")).toContainText("done");

  await expect(step(page, "Arbitrum One", "1. Signed")).toContainText("done");
  await expect(step(page, "Arbitrum One", "2. Landed")).toContainText("not yet");
  await expect(step(page, "Arbitrum One", "3. Verified")).toContainText("not yet");

  // Arbitrum One's pause lands; NEAR doesn't record it verified yet.
  const landed = emptyWorld();
  post(landed, ID);
  win(landed, ID, 0, { landed: [BASE, ARBITRUM], verified: [BASE] });
  await setWorld(page, landed);
  await page.reload();
  await expect(step(page, "Arbitrum One", "2. Landed")).toContainText("done");
  await expect(step(page, "Arbitrum One", "3. Verified")).toContainText("not yet");
});

test("R7.7: a pause that landed but reverted, or hit another contract, doesn't show landed", async ({ page }) => {
  const w = emptyWorld();
  post(w, ID);
  win(w, ID, 0, { landed: [BASE] });
  const b = w.bounties[0]!;
  const base = b.signed_pauses.find((p) => p.chain_id === BASE)!;
  w.evm[BASE]!.receipts[base.tx_hash] = { ok: false, block: 22_000_000, to: base.contract };
  await setWorld(page, w);
  await open(page);
  await expect(step(page, "Base", "2. Landed")).toContainText("not yet");
});

test("D8: a warning shows when a chain's pause gas is below what its signed pause needs", async ({ page }) => {
  const w = emptyWorld();
  post(w, ID);
  // Base holds less than one pause needs at its fee limit; Arbitrum One holds exactly enough.
  w.evm[BASE]!.balances[PAUSE_ROLE] = String(BigInt(PAUSE_GAS_PER_PAUSE) - 1n);
  w.evm[ARBITRUM]!.balances[PAUSE_ROLE] = PAUSE_GAS_PER_PAUSE;
  await setWorld(page, w);
  await open(page);
  const warn = chainRow(page, "Base").getByRole("note");
  await expect(warn).toContainText("Low pause gas");
  await expect(warn).toContainText("Pause gas on Base: 0.000209999999999999 ETH. The signed pause needs 0.00021 ETH. Top up the pause-role address.");
  await expect(warn).toContainText(PAUSE_ROLE);
  await expect(chainRow(page, "Arbitrum One").getByText("Low pause gas")).toHaveCount(0);

  // Topped up: the warning goes.
  w.evm[BASE]!.balances[PAUSE_ROLE] = "1000000000000000";
  await setWorld(page, w);
  await page.reload();
  await expect(chainRow(page, "Base")).toBeVisible();
  await expect(page.getByText("Low pause gas")).toHaveCount(0);
});

test("R15.6: the rules and amounts shown are the chain's", async ({ page }) => {
  const w = emptyWorld();
  post(w, ID);
  w.bounties[0]!.rules = { ...w.bounties[0]!.rules, bounty_amount: "42000000", minimum_theft: "3500000", disclosure_delay_days: 14 };
  await setWorld(page, w);
  await open(page);
  await expect(page.getByTestId("bounty-amount")).toHaveText("42 USDC");
  await expect(page.getByTestId("minimum-theft")).toHaveText("3.5 USDC");
  await expect(page.getByText(/14 days after the payout/)).toBeVisible();
});

test("R15.6: a bounty the contract doesn't hold says so @phone", async ({ page }) => {
  await setWorld(page, emptyWorld());
  await open(page, { protocol: "nobody.near", name: "nothing" });
  await expect(page.getByText("The bounty contract holds no bounty nobody.near/nothing.")).toBeVisible();
});

test("D8: the warning shows for a signed pause that hasn't landed, and goes once it lands", async ({ page }) => {
  const w = emptyWorld();
  post(w, ID);
  win(w, ID, 0, { landed: [BASE] });
  w.evm[ARBITRUM]!.balances[PAUSE_ROLE] = "1";
  w.evm[BASE]!.balances[PAUSE_ROLE] = "1";
  await setWorld(page, w);
  await open(page);
  await expect(chainRow(page, "Arbitrum One").getByRole("note")).toContainText("Low pause gas");
  // Base's pause has landed: its gas no longer matters.
  await expect(chainRow(page, "Base").getByText("Low pause gas")).toHaveCount(0);
});
