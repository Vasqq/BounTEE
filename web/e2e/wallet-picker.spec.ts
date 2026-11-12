// Seam W, tickets #92 and #93: the wallet picker offers exactly ADR-0022's wallets and says
// beneath its list why only those are shown (D34), the signing pages contact WalletConnect
// only once a wallet that needs it is picked (D36), and they prompt no wallet before a click
// (D13). The stand-in wallet presents as each real wallet by its provider flags, and can
// announce itself over EIP-6963; WalletConnect's hosts are blocked and every request and
// WebSocket to them recorded.
//
// What this seam misses: real extensions (two side by side, a real Rabby's dialogs) and a real
// MetaMask Mobile QR connection, which needs WalletConnect's relay: the recorded testnet run.
// The phone project may show RainbowKit's mobile list, so no test here is tagged @phone: they
// run in the desktop project only.
import { expect, test, type Page } from "@playwright/test";
import { emptyWorld, post, postingWorld, setWorld, win, type BountyId, type World } from "./stand-ins/world.ts";
import { addressOf, exploitPublicKey, PROTOCOL_KEY, pickWallet, release, resetWalletCalls, wallet, walletCalls, type Persona } from "./stand-ins/wallet.ts";

const ACCOUNT = addressOf(PROTOCOL_KEY).toLowerCase();
const ID: BountyId = { protocol: "0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e", name: "vault-v2" };
/** The wallets the picker lists in Chromium, by RainbowKit's labels and in the list's order (D34). */
const LISTED = ["MetaMask", "Rabby Wallet", "Zerion"];
/** What a wallet asks its user to approve: none may come before a click (D13). */
const PROMPTS = /^(eth_requestAccounts|wallet_requestPermissions|personal_sign|eth_sign.*|eth_sendTransaction|wallet_switchEthereumChain|wallet_addEthereumChain)$/;

/**
 * The two signing pages, each opened at its connect button, and what each may ask of a wallet
 * before a click (D13): /post reconnects a browser wallet with requests that prompt nothing,
 * and the open-exploit page asks nothing at all.
 */
const PAGES = {
  posting: {
    beforeClick: "nothing that prompts",
    async open(page: Page) {
      await setWorld(page, postingWorld(ACCOUNT, { onboarded: true }));
      await page.goto("/post#3");
    },
    connect: (page: Page) => page.getByRole("region", { name: /^3\. / }).getByRole("button", { name: "Connect wallet" }),
  },
  "open-exploit": {
    beforeClick: "nothing",
    async open(page: Page) {
      await setWorld(page, paidAndReleased());
      await page.goto(`/bounties/${ID.protocol}/${ID.name}/exploit`);
    },
    connect: (page: Page) => page.getByRole("button", { name: "Open with your wallet" }),
  },
} as const;

function paidAndReleased(): World {
  const w = emptyWorld();
  post(w, ID);
  w.bounties[0]!.rules.exploit_public_key = exploitPublicKey(PROTOCOL_KEY, ID);
  win(w, ID, 0, { landed: [8453, 42161] });
  w.releases[`${ID.protocol}/${ID.name}`] = { claim_id: 0, state: "released", released: release(w.bounties[0]!.rules.exploit_public_key, ID, 0) };
  return w;
}

/** WalletConnect's hosts, Reown's (WalletConnect's new name) and web3modal's. */
const walletConnectHost = (url: URL) => /(^|\.)(walletconnect\.(com|org)|reown\.com|web3modal\.(com|org))$/.test(url.hostname);

/**
 * Blocks every HTTP request and WebSocket to a WalletConnect host, and returns the list of
 * each one the page tried, as it grows.
 */
async function blockWalletConnect(page: Page): Promise<string[]> {
  const tried: string[] = [];
  await page.context().route(walletConnectHost, (route) => {
    tried.push(route.request().url());
    return route.abort();
  });
  await page.context().routeWebSocket(walletConnectHost, (ws) => {
    tried.push(ws.url());
    return ws.close();
  });
  return tried;
}

/**
 * Waits until anything the page would do on its own has had time to happen: the network goes
 * quiet, then a further second for anything started late (a timer, a retry), before a check
 * that something did NOT happen.
 */
async function settled(page: Page) {
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(1_000);
}

/** The wallet entries in the open picker: its buttons with a wallet icon, not the compact modal's Info button. */
const entries = (page: Page) => page.getByRole("dialog").getByRole("button").filter({ has: page.getByRole("img") }).filter({ hasNot: page.getByRole("img", { name: "Info", exact: true }) });

for (const [name, at] of Object.entries(PAGES)) {
  test(`D34, D36: on the ${name} page with no wallet injected, the picker lists exactly MetaMask, Rabby Wallet and Zerion, MetaMask enabled`, async ({ page }) => {
    await blockWalletConnect(page);
    await at.open(page);
    await at.connect(page).click();
    await expect(entries(page)).toHaveText(LISTED);
    await expect(entries(page).filter({ hasText: "MetaMask" })).toBeEnabled();
  });

  test(`D34: on the ${name} page with a Brave Wallet injected, the picker lists Brave Wallet too`, async ({ page }) => {
    await blockWalletConnect(page);
    await wallet(page, PROTOCOL_KEY, { as: "Brave Wallet" });
    await at.open(page);
    await at.connect(page).click();
    await expect(entries(page)).toHaveText(["MetaMask", "Rabby Wallet", "Brave Wallet", "Zerion"]);
  });

  test(`D34: on the ${name} page, a Phantom announced over EIP-6963 appears nowhere in the picker`, async ({ page }) => {
    await blockWalletConnect(page);
    await wallet(page, PROTOCOL_KEY, { as: "Phantom", announce: true });
    await at.open(page);
    await at.connect(page).click();
    await expect(entries(page)).toHaveText(LISTED);
    await expect(page.getByRole("dialog")).not.toContainText("Phantom");
  });

  test(`D34: on the ${name} page, the open picker says beneath its list that only wallets that can sign on NEAR are shown`, async ({ page }) => {
    await blockWalletConnect(page);
    await at.open(page);
    await at.connect(page).click();
    const line = page.getByRole("dialog").getByText("Only wallets that can sign on NEAR are shown.", { exact: true });
    await expect(entries(page)).toHaveText(LISTED);
    await expect(line).toBeVisible();
    // Measured once the picker's opening animation has finished, so both boxes are where they stay.
    await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
    const last = (await entries(page).last().boundingBox())!;
    expect((await line.boundingBox())!.y).toBeGreaterThanOrEqual(last.y + last.height);
  });
}

const posting = PAGES.posting;
const funding = (page: Page) => page.getByRole("region", { name: /^3\. / });

test("D34, D36: with a Zerion injected, picking Zerion connects its account, and WalletConnect is never contacted", async ({ page }) => {
  const tried = await blockWalletConnect(page);
  await wallet(page, PROTOCOL_KEY, { as: "Zerion" });
  await posting.open(page);
  await posting.connect(page).click();
  await pickWallet(page, "Zerion");
  await expect(funding(page)).toContainText(ACCOUNT);
  expect(await walletCalls(page)).toContain("eth_requestAccounts");
  // A browser wallet needs no WalletConnect, so picking one contacts it no more than loading does.
  await settled(page);
  expect(tried).toEqual([]);
});

// Each of these sets MetaMask's flag beside its own, so MetaMask's entry must not take it: the
// entry offers MetaMask Mobile instead, and picking it reaches for WalletConnect, not this wallet.
for (const as of ["Zerion", "Rabby", "Brave Wallet", "Trust"] as const satisfies Persona[]) {
  test(`D34: with a ${as} injected, picking MetaMask sends ${as} no request`, async ({ page }) => {
    const tried = await blockWalletConnect(page);
    await wallet(page, PROTOCOL_KEY, { as });
    await posting.open(page);
    await posting.connect(page).click();
    await expect(entries(page).first()).toBeVisible();
    // /post's reconnect may already have asked it for accounts: only what follows the pick counts.
    await resetWalletCalls(page);
    await pickWallet(page, "MetaMask");
    await expect.poll(() => tried.length).toBeGreaterThan(0);
    expect(await walletCalls(page)).toEqual([]);
    await expect(funding(page)).not.toContainText(ACCOUNT);
  });
}

/**
 * What a past WalletConnect connection leaves in local storage: wagmi's store naming the
 * WalletConnect connector (wagmi's id for it, which RainbowKit's MetaMask Mobile entry keeps)
 * as the current connection, RainbowKit's recent wallet, and WalletConnect's own session keys
 * (RainbowKit gives its client the `clientTwo` prefix; WalletConnect moves them into IndexedDB
 * when it starts).
 */
async function seedPastWalletConnectConnection(page: Page) {
  const uid = "f1e2d3c4b5a6";
  const store = {
    state: {
      connections: { __type: "Map", value: [[uid, { accounts: [addressOf(PROTOCOL_KEY)], chainId: 8453, connector: { id: "walletConnect", name: "WalletConnect", type: "walletConnect", uid } }]] },
      chainId: 8453,
      current: uid,
    },
    version: 2,
  };
  const topic = "a".repeat(64);
  const namespaces = { eip155: { chains: ["eip155:8453"], accounts: [`eip155:8453:${addressOf(PROTOCOL_KEY)}`], methods: ["personal_sign", "eth_sendTransaction"], events: ["accountsChanged", "chainChanged"] } };
  const session = {
    topic,
    pairingTopic: "b".repeat(64),
    relay: { protocol: "irn" },
    expiry: 4_102_444_800,
    acknowledged: true,
    controller: "e".repeat(64),
    namespaces,
    requiredNamespaces: {},
    optionalNamespaces: { eip155: { chains: ["eip155:8453"], methods: namespaces.eip155.methods, events: namespaces.eip155.events } },
    self: { publicKey: "f".repeat(64), metadata: { name: "BounTEE", description: "", url: "http://localhost", icons: [] } },
    peer: { publicKey: "e".repeat(64), metadata: { name: "MetaMask Wallet", description: "", url: "https://metamask.io", icons: [] } },
  };
  const seed: Record<string, unknown> = {
    "wagmi.store": store,
    "wagmi.recentConnectorId": "walletConnect",
    "rk-recent": ["metaMask"],
  };
  for (const prefix of ["", ":clientTwo"]) {
    seed[`wc@2:client:0.3${prefix}//session`] = [session];
    seed[`wc@2:core:0.3${prefix}//keychain`] = { [topic]: "c".repeat(64) };
    seed[`wc@2:core:0.3${prefix}//subscription`] = [{ id: "d".repeat(64), topic, relay: { protocol: "irn" } }];
    seed[`wc@2:core:0.3${prefix}//pairing`] = [{ topic: "b".repeat(64), expiry: 4_102_444_800, relay: { protocol: "irn" }, active: true }];
    seed[`wc@2:universal_provider:${prefix.slice(1)}/namespaces`] = namespaces;
    seed[`wc@2:ethereum_provider:${prefix.slice(1)}/chainId`] = 8453;
  }
  await page.addInitScript((entries: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(entries)) localStorage.setItem(key, JSON.stringify(value));
  }, seed);
}

for (const [name, at] of Object.entries(PAGES)) {
  for (const injected of [false, true]) {
    test(`D36: on the ${name} page ${injected ? "with" : "without"} a wallet injected, nothing reaches WalletConnect before a wallet is picked`, async ({ page }) => {
      const tried = await blockWalletConnect(page);
      if (injected) await wallet(page, PROTOCOL_KEY, { as: "MetaMask" });
      await at.open(page);
      await at.connect(page).click();
      await expect(entries(page)).toHaveText(LISTED);
      await settled(page);
      expect(tried).toEqual([]);
    });
  }
}

test("D36: /post loaded after a past WalletConnect connection reaches WalletConnect only once MetaMask is picked", async ({ page }) => {
  const tried = await blockWalletConnect(page);
  await seedPastWalletConnectConnection(page);
  await posting.open(page);
  await expect(posting.connect(page)).toBeVisible();
  await settled(page);
  await posting.connect(page).click();
  await expect(entries(page).first()).toBeVisible();
  await settled(page);
  expect(tried).toEqual([]);
  // With no wallet injected, MetaMask's entry is MetaMask Mobile: picking it reaches for the relay.
  await pickWallet(page, "MetaMask");
  await expect.poll(() => tried.length).toBeGreaterThan(0);
});

for (const [name, at] of Object.entries(PAGES)) {
  test(`D36: on the ${name} page with no wallet injected, picking MetaMask reaches for WalletConnect's relay`, async ({ page }) => {
    const tried = await blockWalletConnect(page);
    await at.open(page);
    await at.connect(page).click();
    await pickWallet(page, "MetaMask");
    await expect.poll(() => tried.length).toBeGreaterThan(0);
  });
}

for (const [name, at] of Object.entries(PAGES)) {
  for (const as of ["MetaMask", "Rabby", "Zerion", "Brave Wallet"] as const satisfies Persona[]) {
    test(`D13: the ${name} page asks a ${as} for ${at.beforeClick} before a click`, async ({ page }) => {
      await wallet(page, PROTOCOL_KEY, { as });
      await at.open(page);
      await expect(at.connect(page)).toBeEnabled();
      await settled(page);
      const calls = await walletCalls(page);
      expect(at.beforeClick === "nothing" ? calls : calls.filter((m) => PROMPTS.test(m))).toEqual([]);
    });
  }
}

test("D13: /post reloaded after a browser wallet connected restores it with no prompt", async ({ page }) => {
  await wallet(page, PROTOCOL_KEY, { as: "Rabby" });
  await posting.open(page);
  await posting.connect(page).click();
  await pickWallet(page, "Rabby Wallet");
  await expect(funding(page)).toContainText(ACCOUNT);
  await page.reload();
  await expect(funding(page)).toContainText(ACCOUNT);
  expect((await walletCalls(page)).filter((m) => PROMPTS.test(m))).toEqual([]);
});
