// Seam W: the web app, driven in a browser. Add a W spec as web/e2e/<name>.spec.ts, name
// the requirement IDs it proves in the test title, and read only what the page shows.
import { expect, test } from "@playwright/test";

// Ticket #6 smoke: the app builds, serves, and renders in a real browser. A harness check,
// not a requirement test: it stays until W has requirement tests of its own (#29).
test("smoke: the home page renders", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("BounTEE");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("BounTEE");
});
