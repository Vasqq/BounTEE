// Seam W, ticket #30: every bounty page's Verify section and per-chain pause, with
// "Send pause" for a signed pause that hasn't landed.
import { expect, test, type Page } from "@playwright/test";
import { ARBITRUM, BASE, emptyWorld, post, rawPause, sentTxs, setWorld, win, type BountyId } from "./stand-ins/world.ts";

const ID: BountyId = { protocol: "acme.near", name: "vault-v2" };
const open = (page: Page) => page.goto(`/bounties/${ID.protocol}/${ID.name}`);
const verify = (page: Page) => page.getByRole("region", { name: "Verify" });
const row = (page: Page, name: string) => verify(page).getByRole("listitem").filter({ hasText: name });
const chainRow = (page: Page, chain: string) => page.getByRole("region", { name: `Pause on ${chain}` });

test("D6, D30: Verify shows each check as passing, failing or not yet published, under a command naming mainnet's contract", async ({ page }) => {
  const w = emptyWorld();
  post(w, ID);
  // Paid; both pauses landed, only Base's recorded verified; OutLayer has no attestation for the verdict.
  win(w, ID, 0, { landed: [BASE, ARBITRUM], verified: [BASE] });
  await setWorld(page, w);
  await open(page);
  await expect(verify(page).getByText(`bountee verify ${ID.protocol}/${ID.name} --contract bounty.bountee.near --network mainnet`)).toBeVisible();
  await expect(row(page, "Payout on NEAR")).toContainText("PASS");
  await expect(row(page, "Payout on NEAR").getByRole("link")).toHaveAttribute("href", /^https:\/\/nearblocks\.io\/txns\//);
  await expect(row(page, "Pauses landed")).toContainText("PASS");
  await expect(row(page, "Enclave attestation")).toContainText("FAIL");
  await expect(row(page, "Enclave attestation")).toContainText("OutLayer has no attestation");
  await expect(row(page, "Re-run of the published exploit")).toContainText("WAIT");
  await expect(row(page, "Re-run of the published exploit")).toContainText("not yet published");
  // R7.7: verified only once the contract records it, so Arbitrum One's keeps this check waiting.
  await expect(row(page, "Pauses verified on NEAR")).toContainText("WAIT");
  await expect(verify(page).getByText(/1 failing/)).toBeVisible();
});

test("D6: before any claim wins, the checks that need a win wait for it", async ({ page }) => {
  const w = emptyWorld();
  post(w, ID);
  await setWorld(page, w);
  await open(page);
  await expect(row(page, "Payout on NEAR")).toContainText("WAIT");
  await expect(row(page, "Enclave attestation")).toContainText("WAIT");
  await expect(row(page, "Pauses landed")).toContainText("WAIT");
  await expect(row(page, "Re-run of the published exploit")).toContainText("not yet published");
  await expect(verify(page).getByText(/failing/)).toHaveCount(0);
});

test("R7.9: a signed pause that hasn't landed has Send pause, which sends it to its chain with no wallet", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__walletCalls = 0;
    (window as any).ethereum = { request: async () => ((window as any).__walletCalls++, []) };
  });
  const w = emptyWorld();
  post(w, ID);
  win(w, ID, 0, { landed: [BASE] });
  const arb = w.bounties[0]!.signed_pauses.find((p) => p.chain_id === ARBITRUM)!;
  // Arbitrum One takes the pause once it is sent.
  w.evm[ARBITRUM]!.landOnSend = { [arb.tx_hash]: { ok: true, block: 290_000_000, to: arb.contract } };
  await setWorld(page, w);
  await open(page);

  await expect(chainRow(page, "Base").getByRole("button", { name: "Send pause" })).toHaveCount(0);
  const send = chainRow(page, "Arbitrum One").getByRole("button", { name: "Send pause" });
  await expect(send).toBeEnabled();
  await send.click();

  // The stored signed pause, exactly, reached Arbitrum One and nothing else was sent.
  await expect.poll(async () => (await sentTxs(page))[ARBITRUM]).toEqual([rawPause(ARBITRUM)]);
  expect((await sentTxs(page))[BASE]).toBeUndefined();
  // It lands, and the row says so, linking the transaction.
  const landed = chainRow(page, "Arbitrum One").getByRole("listitem").filter({ hasText: "2. Landed" });
  await expect(landed).toContainText("done", { timeout: 15_000 });
  await expect(landed.getByRole("link")).toHaveAttribute("href", `https://arbiscan.io/tx/${arb.tx_hash}`);
  await expect(chainRow(page, "Arbitrum One").getByRole("button", { name: "Send pause" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__walletCalls)).toBe(0);
});
