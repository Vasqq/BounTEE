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

/** The hosts of every link on the page that leaves the site. */
const linkHosts = async (page: Page) =>
  (await page.locator("a[href]").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href)))
    .map((h) => new URL(h))
    .filter((u) => u.origin !== new URL(page.url()).origin)
    .map((u) => u.host);

async function fillRules(page: Page) {
  const s = step(page, 2);
  await s.getByLabel("Bounty name").fill(NAME);
  // Only testnet's chains are offered: Base and Arbitrum One can't be chosen.
  await expect(s.getByLabel("Chain").first().locator("option")).toHaveText(["Base Sepolia", "Arbitrum Sepolia"]);
  await s.getByLabel("Chain").first().selectOption("Base Sepolia");
  await s.getByLabel("Contract address").first().fill(VAULT_BASE);
  await s.getByRole("button", { name: "Add a contract" }).click();
  await s.getByLabel("Chain").nth(1).selectOption("Arbitrum Sepolia");
  await s.getByLabel("Contract address").nth(1).fill(VAULT_ARB);
  await s.getByLabel("Bounty amount").fill("2");
  await s.getByLabel("Minimum theft").fill("1");
  await s.getByLabel("End date").fill("2026-12-31");
  await s.getByLabel("Disclosure delay").fill("1");
  await s.getByRole("button", { name: "Continue" }).click();
}

test("D30, D17: posting on testnet asks MetaMask for chain 398 and the Sepolia chains, grants to testnet's pause-role address and links NEAR's faucet", async ({ page }) => {
  test.setTimeout(120_000);
  await metamask(page, PROTOCOL_KEY, { network: "testnet" });
  await setWorld(page, postingWorld(ACCOUNT, { near: "0", usdc: "2000000", network: "testnet" }));
  await page.goto("/post");
  await expect(page.getByText("It signs every step, on Base Sepolia, Arbitrum Sepolia and NEAR.")).toBeVisible();
  await page.getByRole("button", { name: "Connect MetaMask" }).click();
  await expect(page.getByText(ACCOUNT).first()).toBeVisible();

  // 1. NEAR signing goes through NEAR testnet's Ethereum-compatible chain, which MetaMask is asked to add by name.
  await page.getByRole("button", { name: "Enable NEAR signing" }).click();
  await expect(step(page, 1)).toContainText("done");
  expect(await chainsAsked(page)).toContainEqual(expect.objectContaining({ method: "wallet_addEthereumChain", chainId: hex(398), chainName: "NEAR Protocol Testnet" }));
  await page.getByRole("button", { name: "Continue" }).click();
  await fillRules(page);

  // 3. The pause-role address shown is the formats' derivation from testnet's root key and contract.
  await expect(step(page, 3)).toContainText(PAUSE_ROLE);
  await item(page, /Base Sepolia/).getByRole("button", { name: "Grant on Base Sepolia" }).click();
  await expect(item(page, /Base Sepolia/)).toContainText("done");
  await item(page, /Arbitrum Sepolia/).getByRole("button", { name: "Grant on Arbitrum Sepolia" }).click();
  await expect(item(page, /Arbitrum Sepolia/)).toContainText("done");
  const role = parseAbi(["function grantRole(bytes32 role, address account)"]);
  for (const [chain, vault] of [[T.base, VAULT_BASE], [T.arbitrum, VAULT_ARB]] as const) {
    const grant = (await walletSent(page))[chain]!.find((t) => t.to?.toLowerCase() === vault)!;
    expect(decodeFunctionData({ abi: role, data: grant.data as `0x${string}` }).args).toEqual([keccak256(toHex("PAUSER_ROLE")), expect.stringMatching(new RegExp(PAUSE_ROLE, "i"))]);
  }
  await page.getByRole("button", { name: "Continue" }).click();

  // 4. Pause gas goes to the same address on each Sepolia chain.
  await item(page, /Base Sepolia/).getByRole("button", { name: "Top up on Base Sepolia" }).click();
  await expect(item(page, /Base Sepolia/)).toContainText("done");
  await item(page, /Arbitrum Sepolia/).getByRole("button", { name: "Top up on Arbitrum Sepolia" }).click();
  await expect(item(page, /Arbitrum Sepolia/)).toContainText("done");
  for (const chain of [T.base, T.arbitrum]) expect((await walletSent(page))[chain]!.some((t) => t.to?.toLowerCase() === PAUSE_ROLE.toLowerCase() && BigInt(t.value!) > 0n)).toBe(true);
  await page.getByRole("button", { name: "Continue" }).click();

  // 5. D17: NEAR's faucet, beside the address to fund.
  const near = step(page, 5);
  await expect(near.getByRole("link", { name: "Get NEAR from the faucet" })).toHaveAttribute("href", "https://docs.near.org/getting-started/faucet");
  await fundNear(page, ACCOUNT, String(10n ** 24n));
  await expect(near).toContainText("done", { timeout: 15_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  // 6–7. The exploit key is bound to testnet's contract; the bounty posts on NEAR testnet.
  await page.getByRole("button", { name: "Sign with MetaMask" }).click();
  await expect(step(page, 6)).toContainText(exploitPublicKey(PROTOCOL_KEY, { protocol: ACCOUNT, name: NAME }, "testnet"));
  await page.getByRole("button", { name: "Continue" }).click();
  await step(page, 7).getByRole("button", { name: "Prepay the posting fee" }).click();
  await step(page, 7).getByRole("button", { name: "Post the bounty" }).click();
  await expect(step(page, 7)).toContainText("Your bounty is live.", { timeout: 15_000 });

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
      const answer = await (await route.fetch()).json();
      await route.fulfill({ json: { status: { ...answer.status, ...swap } } });
    });
    await page.goto("/post");
    await page.getByRole("button", { name: "Connect MetaMask" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "nothing will be signed" })).toBeVisible();
    await page.goto("/post#3");
    await expect(page.getByRole("button", { name: /^Grant on/ })).toHaveCount(0);
    expect(await walletSent(page)).toEqual({});
  });
}

test("D30: on testnet the posting flow refuses a covered contract on Base or Arbitrum One, even when the server offers one", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY, { network: "testnet" });
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true, network: "testnet" }));
  // The app's server, misconfigured or not, answers with grants and top-ups on mainnet's chains.
  const MAINNET_CHAINS = [[M.base, "Base", VAULT_BASE], [M.arbitrum, "Arbitrum One", VAULT_ARB]] as const;
  await page.route("**/api/post", async (route) => {
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
  await page.getByRole("button", { name: "Connect MetaMask" }).click();
  await expect(page.getByText(ACCOUNT).first()).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await fillRules(page);
  // 3. Each grant on a mainnet chain is refused.
  for (const chain of ["Base", "Arbitrum One"]) {
    await step(page, 3).getByRole("button", { name: `Grant on ${chain}` }).click();
    await expect(item(page, new RegExp(`^\\d+\\. ${chain} · `)).getByRole("alert")).toContainText(`This app can't send on chain`);
  }
  // 4. So is each top-up.
  await page.goto("/post#4");
  for (const chain of ["Base", "Arbitrum One"]) {
    await step(page, 4).getByRole("button", { name: `Top up on ${chain}` }).click();
    await expect(item(page, new RegExp(`^\\d+\\. ${chain}`)).getByRole("alert")).toContainText(`This app can't send on chain`);
  }
  expect(await walletSent(page)).toEqual({});
  expect((await chainsAsked(page)).some((a) => [hex(M.base), hex(M.arbitrum)].includes(a.chainId))).toBe(false);
});

test("D32: on testnet the posting flow links to Circle's faucet beside the Protocol's USDC balance", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY, { network: "testnet" });
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true, usdc: "0", network: "testnet" }));
  await page.goto("/post");
  await page.getByRole("button", { name: "Connect MetaMask" }).click();
  await expect(page.getByText(ACCOUNT).first()).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();
  await fillRules(page);
  const dock = page.getByRole("navigation", { name: "Posting steps" });
  await dock.getByRole("button", { name: "6. Exploit key" }).click();
  await page.getByRole("button", { name: "Sign with MetaMask" }).click();
  await expect(step(page, 6)).toContainText(/x25519:/);
  await dock.getByRole("button", { name: "7. Post" }).click();
  const balance = step(page, 7).getByText("Your account holds 0 USDC on NEAR; the bounty needs more.");
  await expect(balance.getByRole("link", { name: "Get test USDC from Circle's faucet" })).toHaveAttribute("href", "https://faucet.circle.com");
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

test("D30: on testnet /api/demo answers 404: the mainnet demo story is never read", async ({ page }) => {
  // DEMO_BOUNTY is set for the testnet build too (playwright.config.ts), and the bounty is on chain.
  const w = emptyWorld("testnet");
  post(w, { protocol: "0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e", name: "mainnet-demo" });
  await setWorld(page, w);
  const res = await page.request.get("/api/demo");
  expect(res.status()).toBe(404);
});
