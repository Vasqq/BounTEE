// Seam W, ticket #73: the testnet build (D30), the same app built with NEXT_PUBLIC_NETWORK=testnet
// and run on its own port (playwright.config.ts, project "testnet"), against a stand-in world
// for NEAR testnet, Base Sepolia and Arbitrum Sepolia. What the visitor sees and what MetaMask
// is asked to sign must name only testnet's chains, contract, USDC, explorers and root key.
import { expect, test, type Page } from "@playwright/test";
import { decodeFunctionData, keccak256, parseAbi, toHex } from "viem";
import { pauseRole } from "@bountee/formats";
import { currentWorld, emptyWorld, fundNear, NETWORKS, post, postingWorld, setWorld, VAULT_ARB, VAULT_BASE, win, type BountyId } from "./stand-ins/world.ts";
import { SITES } from "./stand-ins/sites.ts";
import { addressOf, chainsAsked, exploitPublicKey, metamask, PROTOCOL_KEY, walletSent } from "./stand-ins/wallet.ts";

const T = NETWORKS.testnet;
const M = NETWORKS.mainnet;
const ACCOUNT = addressOf(PROTOCOL_KEY).toLowerCase();
const NAME = "vault-v2";
/** The pause-role address NEAR testnet's MPC network signs this bounty's pauses from (D25), as the formats derive it. */
const PAUSE_ROLE = pauseRole.address(pauseRole.TESTNET_ROOT_PUBLIC_KEY, T.contract, { protocol: ACCOUNT, name: NAME });
/**
 * Every host a testnet page may link to: testnet's explorers, NEAR's and Circle's faucets, the
 * source repository, and the mainnet site, which the badge and the nav's Verify link go to (D31).
 */
const TESTNET_HOSTS = ["testnet.nearblocks.io", "sepolia.basescan.org", "sepolia.arbiscan.io", "eth-explorer-testnet.near.org", "docs.near.org", "faucet.circle.com", "github.com", new URL(SITES.mainnet).host];
const hex = (id: number) => `0x${id.toString(16)}`;

const step = (page: Page, n: number) => page.getByRole("region", { name: new RegExp(`^${n}\\. `) });
const item = (page: Page, title: RegExp) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });
/** An item's state, as its title row shows it. */
const state = (page: Page, title: RegExp) => item(page, title).getByRole("heading").locator(".item-state");
/** A row inside a chain card: its pause-role grant or its pause gas. */
const task = (page: Page, chain: RegExp, row: RegExp) => item(page, chain).locator(".task").filter({ has: page.locator(".task-label", { hasText: row }) });
const taskState = (page: Page, chain: RegExp, row: RegExp) => task(page, chain, row).locator(".item-state");

/** The hosts of every link on the page that leaves the site. */
const linkHosts = async (page: Page) =>
  (await page.locator("a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href)))
    .map((h) => new URL(h))
    .filter((u) => u.origin !== new URL(page.url()).origin)
    .map((u) => u.host);

async function pickChain(page: Page, n: number, chain: string) {
  await step(page, 1).getByRole("combobox", { name: "Chain" }).nth(n).click();
  await page.getByRole("option", { name: chain }).click();
}

async function fillRules(page: Page) {
  const s = step(page, 1);
  await s.getByLabel("What does this bounty protect?").fill("Vault V2");
  // Only testnet's chains are offered: Base and Arbitrum One can't be chosen.
  await s.getByRole("combobox", { name: "Chain" }).first().click();
  await expect(page.getByRole("option")).toHaveText(["Base Sepolia", "Arbitrum Sepolia"]);
  await page.getByRole("option", { name: "Base Sepolia" }).click();
  await s.getByLabel("Contract address").first().fill(VAULT_BASE);
  await s.getByRole("button", { name: "Add a contract" }).click();
  await pickChain(page, 1, "Arbitrum Sepolia");
  await s.getByLabel("Contract address").nth(1).fill(VAULT_ARB);
  await s.getByLabel("Bounty amount").fill("2");
  await s.getByLabel("Smallest theft that counts").fill("1");
  await s.getByRole("radio", { name: "Custom" }).check();
  await s.getByLabel("Exact end date").fill("2026-12-31");
  await s.getByLabel("Keep the exploit private for").fill("1");
  await s.getByRole("button", { name: "Continue" }).click();
}

/** MetaMask connects at the pause step, the first that needs its address. */
async function connect(page: Page) {
  await step(page, 2).getByRole("button", { name: "Connect MetaMask" }).click();
}

test("D30, D17: posting on testnet asks MetaMask for chain 398 and the Sepolia chains, grants to testnet's pause-role address and links NEAR's faucet", async ({ page }) => {
  test.setTimeout(120_000);
  await metamask(page, PROTOCOL_KEY, { network: "testnet" });
  await setWorld(page, postingWorld(ACCOUNT, { near: "0", usdc: "2000000", network: "testnet" }));
  await page.goto("/post");
  await fillRules(page);

  // 2. The pause-role address shown is the formats' derivation from testnet's root key and contract.
  await connect(page);
  await expect(step(page, 2)).toContainText(PAUSE_ROLE, { ignoreCase: true });
  await task(page, /Base Sepolia/, /Pause role/).getByRole("button", { name: "Grant", exact: true }).click();
  await expect(taskState(page, /Base Sepolia/, /Pause role/)).toHaveText("granted", { timeout: 15_000 });
  await task(page, /Arbitrum Sepolia/, /Pause role/).getByRole("button", { name: "Grant", exact: true }).click();
  await expect(taskState(page, /Arbitrum Sepolia/, /Pause role/)).toHaveText("granted", { timeout: 15_000 });
  const role = parseAbi(["function grantRole(bytes32 role, address account)"]);
  for (const [chain, vault] of [[T.base, VAULT_BASE], [T.arbitrum, VAULT_ARB]] as const) {
    const grant = (await walletSent(page))[chain]!.find((t) => t.to?.toLowerCase() === vault)!;
    expect(decodeFunctionData({ abi: role, data: grant.data as `0x${string}` }).args).toEqual([keccak256(toHex("PAUSER_ROLE")), expect.stringMatching(new RegExp(PAUSE_ROLE, "i"))]);
  }
  // Pause gas goes to the same address on each Sepolia chain.
  await task(page, /Base Sepolia/, /Pause gas/).getByRole("button", { name: /^Send / }).click();
  await expect(taskState(page, /Base Sepolia/, /Pause gas/)).toHaveText("funded", { timeout: 15_000 });
  await task(page, /Arbitrum Sepolia/, /Pause gas/).getByRole("button", { name: /^Send / }).click();
  await expect(taskState(page, /Arbitrum Sepolia/, /Pause gas/)).toHaveText("funded", { timeout: 15_000 });
  for (const chain of [T.base, T.arbitrum]) expect((await walletSent(page))[chain]!.some((t) => t.to?.toLowerCase() === PAUSE_ROLE.toLowerCase() && BigInt(t.value!) > 0n)).toBe(true);
  await page.getByRole("button", { name: "Continue" }).click();

  // 3. D17: NEAR's faucet, beside the NEAR the fees need.
  const funds = step(page, 3);
  await expect(funds.getByRole("link", { name: "Get NEAR from the faucet" })).toHaveAttribute("href", "https://docs.near.org/getting-started/faucet");
  await fundNear(page, ACCOUNT, String(10n ** 24n));
  await expect(state(page, /Fees/)).toHaveText("received", { timeout: 15_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  // 4. The exploit key is bound to testnet's contract; NEAR signing goes through NEAR testnet's
  // Ethereum-compatible chain, which MetaMask is asked to add by name; the bounty posts on NEAR testnet.
  const post4 = step(page, 4);
  await post4.getByRole("button", { name: "Sign with MetaMask" }).click();
  await expect(post4).toContainText(exploitPublicKey(PROTOCOL_KEY, { protocol: ACCOUNT, name: NAME }, "testnet"));
  await post4.getByRole("button", { name: "Enable NEAR signing" }).click();
  await expect(state(page, /Enable NEAR signing/)).toHaveText("done");
  expect(await chainsAsked(page)).toContainEqual(expect.objectContaining({ method: "wallet_addEthereumChain", chainId: hex(398), chainName: "NEAR Protocol Testnet" }));
  await post4.getByRole("button", { name: "Prepay the posting fee" }).click();
  await post4.getByRole("button", { name: "Post the bounty" }).click();
  await expect(post4).toContainText("Your bounty is live.", { timeout: 15_000 });

  const b = (await currentWorld(page)).bounties.find((x) => x.id.name === NAME)!;
  expect(b.rules.covered_contracts).toEqual([{ chain_id: T.base, address: VAULT_BASE }, { chain_id: T.arbitrum, address: VAULT_ARB }]);
  // Theft is valued in Circle's USDC on each Sepolia chain (D27).
  expect(b.rules.listed_tokens).toEqual([
    { chain_id: T.base, token: T.baseUsdc, price: "1" },
    { chain_id: T.arbitrum, token: T.arbitrumUsdc, price: "1" },
  ]);
  // Every NEAR transaction went through chain 398, to testnet's account, contract and USDC.
  const hashed = (account: string) => `0x${keccak256(toHex(account)).slice(26)}`;
  expect((await walletSent(page))[T.nearEvm]!.map((t) => t.to?.toLowerCase())).toEqual([hashed(ACCOUNT), hashed(T.contract), hashed(T.usdc)]);

  // MetaMask was never asked for a mainnet chain, and was asked for each Sepolia chain by name.
  const asked = await chainsAsked(page);
  for (const id of [M.base, M.arbitrum, M.nearEvm]) expect(asked.some((a) => a.chainId === hex(id))).toBe(false);
  expect(asked).toContainEqual(expect.objectContaining({ method: "wallet_addEthereumChain", chainId: hex(T.arbitrum), chainName: "Arbitrum Sepolia" }));
  expect(Object.keys(await walletSent(page)).map(Number).sort()).toEqual([T.base, T.nearEvm, T.arbitrum].sort());

  // Every link the posting flow showed is a testnet explorer's (or the faucet).
  for (const host of await linkHosts(page)) expect(TESTNET_HOSTS, host).toContain(host);
});

const MAINNET_ROLE = pauseRole.address(pauseRole.MAINNET_ROOT_PUBLIC_KEY, M.contract, { protocol: ACCOUNT, name: NAME });
for (const [what, swap] of [
  ["contract", { contract: M.contract }],
  ["USDC", { usdc: M.usdc }],
  ["pause-role address", { pauseRole: MAINNET_ROLE }],
] as const) {
  test(`D30, D13: on testnet a server answer naming mainnet's ${what} is refused before anything is signed`, async ({ page }) => {
    await metamask(page, PROTOCOL_KEY, { network: "testnet" });
    await setWorld(page, postingWorld(ACCOUNT, { onboarded: true, network: "testnet" }));
    await page.route("**/api/post", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const answer = await (await route.fetch()).json();
      await route.fulfill({ json: { status: { ...answer.status, ...swap } } });
    });
    await page.goto("/post");
    await fillRules(page);
    await connect(page);
    await expect(page.getByRole("alert").filter({ hasText: "nothing will be signed" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Grant", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /^Send / })).toHaveCount(0);
    expect(await walletSent(page)).toEqual({});
  });
}

test("D30: on testnet the posting flow refuses a covered contract on Base or Arbitrum One, even when the server offers one", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY, { network: "testnet" });
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true, network: "testnet" }));
  // The app's server, misconfigured or not, answers with grants and top-ups on mainnet's chains.
  const MAINNET_CHAINS = [[M.base, "Base", VAULT_BASE], [M.arbitrum, "Arbitrum One", VAULT_ARB]] as const;
  await page.route("**/api/post", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const { status } = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        status: {
          ...status,
          covered: MAINNET_CHAINS.map(([chainId, chain, address]) => ({ chainId, chain, address, granted: false, grant: { chainId, to: address, value: "0", data: "0x2f2ff15d" } })),
          gas: MAINNET_CHAINS.map(([chainId, chain]) => ({ chainId, chain, token: "ETH", held: "0", needed: "1", short: "1", ok: false })),
        },
      },
    });
  });
  await page.goto("/post");
  await fillRules(page);
  await connect(page);
  // 2. Each grant on a mainnet chain is refused, and so is each pause-gas send.
  for (const chain of [/^\d+\. Base\b/, /^\d+\. Arbitrum One\b/]) {
    await task(page, chain, /Pause role/).getByRole("button", { name: "Grant", exact: true }).click();
    await expect(task(page, chain, /Pause role/).getByRole("alert")).toContainText(`This app can't send on chain`);
    await task(page, chain, /Pause gas/).getByRole("button", { name: /^Send / }).click();
    await expect(task(page, chain, /Pause gas/).getByRole("alert")).toContainText(`This app can't send on chain`);
  }
  expect(await walletSent(page)).toEqual({});
  expect((await chainsAsked(page)).some((a) => [hex(M.base), hex(M.arbitrum)].includes(a.chainId))).toBe(false);
});

test("D32: on testnet the posting flow links to Circle's faucet beside the bounty's USDC", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY, { network: "testnet" });
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true, usdc: "0", network: "testnet" }));
  await page.goto("/post");
  await fillRules(page);
  await connect(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(state(page, /Bounty/)).toHaveText("0 received");
  await expect(item(page, /Bounty/).getByRole("link", { name: "Get test USDC from Circle's faucet" })).toHaveAttribute("href", "https://faucet.circle.com");
});

const ID: BountyId = { protocol: "brassmoor-lend.testnet", name: "pool" };

test("D30: on testnet every link on the bounty list and a bounty page is a testnet explorer's, the Sepolia chains show Base's and Arbitrum's marks, and Verify names testnet", async ({ page }) => {
  const w = emptyWorld("testnet");
  post(w, ID);
  // Paid: both Sepolia pauses landed and verified, so every link a bounty page can show is there.
  win(w, ID, 0, { landed: [T.base, T.arbitrum], verified: [T.base, T.arbitrum] });
  post(w, { protocol: "tallowfen-swap.testnet", name: "amm" });
  await setWorld(page, w);

  await page.goto("/bounties");
  await expect(page.getByText("2 bounties")).toBeVisible();
  const row = page.getByRole("row", { name: /brassmoor-lend\.testnet\/pool/ });
  await expect(row.locator("svg[role=img][aria-label='Base Sepolia'] path").first()).toHaveAttribute("fill", "#0000ff");
  await expect(row.locator("svg[role=img][aria-label='Arbitrum Sepolia'] rect").first()).toHaveAttribute("fill", "#213147");
  for (const host of await linkHosts(page)) expect(TESTNET_HOSTS, host).toContain(host);

  await page.goto(`/bounties/${ID.protocol}/${ID.name}`);
  const base = page.getByRole("region", { name: "Pause on Base Sepolia" });
  await expect(base.getByRole("listitem").filter({ hasText: "2. Landed" }).getByRole("link", { name: /0x/ })).toHaveAttribute("href", /^https:\/\/sepolia\.basescan\.org\/tx\/0x/);
  await expect(page.getByRole("region", { name: "Pause on Arbitrum Sepolia" }).getByRole("listitem").filter({ hasText: "2. Landed" }).getByRole("link", { name: /0x/ })).toHaveAttribute("href", /^https:\/\/sepolia\.arbiscan\.io\/tx\/0x/);
  await expect(base.locator("svg[role=img][aria-label='Base Sepolia'] path").first()).toHaveAttribute("fill", "#0000ff");
  const verify = page.getByRole("region", { name: "Verify" });
  await expect(verify.getByText(`bountee verify ${ID.protocol}/${ID.name} --contract bounty.bountee.testnet --network testnet`)).toBeVisible();
  await expect(verify.getByRole("listitem").filter({ hasText: "Payout on NEAR" }).getByRole("link").first()).toHaveAttribute("href", /^https:\/\/testnet\.nearblocks\.io\/txns\//);
  const hosts = await linkHosts(page);
  expect(hosts).toContain("testnet.nearblocks.io");
  for (const host of hosts) expect(TESTNET_HOSTS, host).toContain(host);
});

test("D27, D31: on testnet a bounty page's rules read as mainnet's: a theft proven on any covered chain wins", async ({ page }) => {
  const w = emptyWorld("testnet");
  post(w, ID);
  await setWorld(page, w);
  await page.goto(`/bounties/${ID.protocol}/${ID.name}`);
  const rules = page.getByRole("region", { name: "Rules" });
  await expect(rules).toContainText("A theft proven on any covered chain wins: the Enclave replays each claim against that chain's state at a block at most 5 minutes old, under the judge build fixed at posting.");
  await expect(rules).toContainText("Covers 2 contracts on Base Sepolia and Arbitrum Sepolia. A winning claim pauses every one of them.");
  await expect(rules).not.toContainText(/undefined|chain \d/);
});

test("D30: on testnet /api/demo answers 404: the mainnet demo story is never read", async ({ page }) => {
  // DEMO_BOUNTY is set for the testnet build too (playwright.config.ts), and the bounty is on chain.
  const w = emptyWorld("testnet");
  post(w, { protocol: "0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e", name: "mainnet-demo" });
  await setWorld(page, w);
  const res = await page.request.get("/api/demo");
  expect(res.status()).toBe(404);
});
