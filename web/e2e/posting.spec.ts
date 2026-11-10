// Seam W, ticket #31: a Protocol posts a bounty from the browser with MetaMask. The stand-in
// MetaMask holds a test key; the chain stand-in applies what it sends, as each chain would.
import { expect, test, type Page } from "@playwright/test";
import { decodeFunctionData, keccak256, parseAbi, toHex } from "viem";
import { pauseRole } from "@bountee/formats";
import { ARBITRUM, BASE, CONTRACT, currentWorld, fundNear, NEAR_EVM, PAUSE_GAS_PER_PAUSE, post, postingWorld, setWorld, USDC, VAULT_ARB, VAULT_BASE } from "./stand-ins/world.ts";
import { addressOf, exploitPublicKey, metamask, PROTOCOL_KEY, walletConnected, walletSent } from "./stand-ins/wallet.ts";

const ACCOUNT = addressOf(PROTOCOL_KEY).toLowerCase();
const NAME = "vault-v2";
const NEAR = 10n ** 24n;
/** The pause-role address the MPC network signs this bounty's pauses from (D25). */
const PAUSE_ROLE = pauseRole.address(pauseRole.MAINNET_ROOT_PUBLIC_KEY, CONTRACT, { protocol: ACCOUNT, name: NAME });
const step = (page: Page, n: number) => page.getByRole("region", { name: new RegExp(`^${n}\\. `) });
const item = (page: Page, title: RegExp) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });
/** An item's state, as its title row shows it ("not granted", "ready", "received"…). */
const state = (page: Page, title: RegExp) => item(page, title).getByRole("heading").locator(".item-state");
/** A row inside a chain card: its pause-role grant or its pause gas, and that row's state. */
const task = (page: Page, chain: RegExp, row: RegExp) => item(page, chain).locator(".task").filter({ has: page.locator(".task-label", { hasText: row }) });
const taskState = (page: Page, chain: RegExp, row: RegExp) => task(page, chain, row).locator(".item-state");

/** The chain picker is a listbox: open it, then choose. */
async function pickChain(page: Page, n: number, chain: string) {
  await step(page, 1).getByRole("combobox", { name: "Chain" }).nth(n).click();
  await page.getByRole("option", { name: chain }).click();
}

/** The rules need no wallet; MetaMask connects at the pause-role step, the first that needs its address. */
async function connect(page: Page) {
  await step(page, 2).getByRole("button", { name: "Connect MetaMask" }).click();
  await expect(step(page, 2)).toContainText(PAUSE_ROLE, { ignoreCase: true });
}

async function fillRules(page: Page) {
  const s = step(page, 1);
  await s.getByLabel("What does this bounty protect?").fill("Vault V2");
  await pickChain(page, 0, "Base");
  await s.getByLabel("Contract address").first().fill(VAULT_BASE);
  await s.getByRole("button", { name: "Add a contract" }).click();
  await pickChain(page, 1, "Arbitrum One");
  await s.getByLabel("Contract address").nth(1).fill(VAULT_ARB);
  await s.getByLabel("Bounty amount").fill("10");
  await s.getByLabel("Smallest theft that counts").fill("1");
  await s.getByRole("radio", { name: "Custom" }).check();
  await s.getByLabel("Exact end date").fill("2026-12-31");
  await s.getByLabel("Keep the exploit private for").fill("1");
  await s.getByRole("button", { name: "Continue" }).click();
}

test("D13, D5, D17, D20, D15: one MetaMask sets up the pause, adds funds and posts on NEAR as the Protocol's 0x… account", async ({ page }) => {
  // Every step, end to end: eleven wallet prompts and their receipts.
  test.setTimeout(120_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await metamask(page, PROTOCOL_KEY);
  await setWorld(page, postingWorld(ACCOUNT, { near: "0", usdc: "10000000" }));
  await page.goto("/post");

  // 1. Set rules, with the coverage limit stated (R4.12).
  await expect(step(page, 1)).toContainText("Skip any that pay callers");
  await fillRules(page);

  // 2. Set up pause: a card per chain, its grant and its pause gas each ticked off as it lands (D5).
  // MetaMask connects here.
  await connect(page);
  await expect(taskState(page, /Base/, /Pause role/)).toHaveText("not granted");
  await task(page, /Base/, /Pause role/).getByRole("button", { name: "Grant", exact: true }).click();
  await expect(taskState(page, /Base/, /Pause role/)).toHaveText("granted", { timeout: 15_000 });
  await task(page, /Arbitrum One/, /Pause role/).getByRole("button", { name: "Grant", exact: true }).click();
  await expect(taskState(page, /Arbitrum One/, /Pause role/)).toHaveText("granted", { timeout: 15_000 });
  const sent = await walletSent(page);
  const role = parseAbi(["function grantRole(bytes32 role, address account)"]);
  for (const [chain, vault] of [[BASE, VAULT_BASE], [ARBITRUM, VAULT_ARB]] as const) {
    const grant = sent[chain]!.find((t) => t.to?.toLowerCase() === vault)!;
    expect(decodeFunctionData({ abi: role, data: grant.data as `0x${string}` }).args).toEqual([keccak256(toHex("PAUSER_ROLE")), expect.stringMatching(new RegExp(PAUSE_ROLE, "i"))]);
  }
  // The pause gas, with D5's plain explanation behind its phrase.
  const gas = task(page, /Base/, /Pause gas/);
  await expect(gas).toContainText("Pausing is a real Base transaction, paid from the address above");
  await expect(gas).toContainText("your bounty's funds on NEAR can't pay for it");
  await expect(gas).toContainText("nobody can take the gas back, you included");
  await expect(gas).toContainText("Nobody presses pause: a proven exploit triggers it.");
  await gas.getByRole("button", { name: /^Send / }).click();
  await expect(taskState(page, /Base/, /Pause gas/)).toHaveText("funded", { timeout: 15_000 });
  await task(page, /Arbitrum One/, /Pause gas/).getByRole("button", { name: /^Send / }).click();
  await expect(taskState(page, /Arbitrum One/, /Pause gas/)).toHaveText("funded", { timeout: 15_000 });
  await expect(state(page, /Base/)).toHaveText("ready");
  await expect(state(page, /Arbitrum One/)).toHaveText("ready");
  const topUp = (await walletSent(page))[BASE]!.find((t) => t.to?.toLowerCase() === PAUSE_ROLE)!;
  expect(BigInt(topUp.value!)).toBe(BigInt(PAUSE_GAS_PER_PAUSE));
  await page.getByRole("button", { name: "Continue" }).click();

  // 3. Add funds: the NEAR account with Copy, the bounty's USDC and the NEAR fees, each ticked off
  // once it arrives (D17). No faucet on mainnet.
  const funds = step(page, 3);
  await expect(funds).toContainText(ACCOUNT);
  await expect(state(page, /Bounty/)).toHaveText("received");
  await expect(item(page, /Fees/)).toContainText("0.7 NEAR");
  await expect(funds.getByRole("link", { name: /faucet/i })).toHaveCount(0);
  await expect(state(page, /Fees/)).not.toHaveText("received");
  await fundNear(page, ACCOUNT, String(NEAR));
  await expect(state(page, /Fees/)).toHaveText("received", { timeout: 15_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  // 4. Post bounty: the rules read back, the risk panel beside the prompts (D5, D15), the exploit
  // key from one MetaMask signature (asked twice to check it repeats) (D20), then post. NEAR
  // signing is enabled once, for free, just before the first NEAR transaction.
  const post = step(page, 4);
  await expect(post).toContainText("Pays 10 USDC to the first Whitehat whose claim takes at least 1 USDC");
  const risk = page.getByRole("complementary", { name: "What you're risking" });
  await expect(risk).toBeVisible();
  const key = exploitPublicKey(PROTOCOL_KEY, { protocol: ACCOUNT, name: NAME });
  await post.getByRole("button", { name: "Sign with MetaMask" }).click();
  await expect(state(page, /Your exploit key/)).toHaveText("signed");
  await post.getByRole("button", { name: "Enable NEAR signing" }).click();
  await expect(state(page, /Enable NEAR signing/)).toHaveText("done");
  await post.getByRole("button", { name: "Prepay the posting fee" }).click();
  await post.getByRole("button", { name: "Post the bounty" }).click();
  await expect(post).toContainText("Your bounty is live.", { timeout: 15_000 });

  // On NEAR: posted by the 0x… account, with the exploit key from the signature in its rules.
  const w = await currentWorld(page);
  const b = w.bounties.find((x) => x.id.name === NAME)!;
  expect(b.id.protocol).toBe(ACCOUNT);
  expect(b.rules.exploit_public_key).toBe(key);
  expect(b.rules.covered_contracts).toEqual([{ chain_id: BASE, address: VAULT_BASE }, { chain_id: ARBITRUM, address: VAULT_ARB }]);
  expect(b.rules.bounty_amount).toBe("10000000");
  expect(b.rules.minimum_theft).toBe("1000000");
  expect(b.rules.disclosure_delay_days).toBe(1);
  // Every NEAR transaction went through NEAR's Ethereum-compatible chain, from the same wallet,
  // encoded as NEP-518 has it: onboarding to the account itself, then the two posting prompts.
  const nearTxs = (await walletSent(page))[NEAR_EVM]!;
  expect(nearTxs).toHaveLength(3);
  const hashed = (account: string) => `0x${keccak256(toHex(account)).slice(26)}`;
  expect(nearTxs.map((t) => t.to?.toLowerCase())).toEqual([hashed(ACCOUNT), hashed(CONTRACT), hashed(USDC)]);
  const call = parseAbi(["function functionCall(string receiver_id, string method_name, bytes args, uint64 gas, uint32 yoctoNear) payable"]);
  const [, method, , nearGas, yocto] = decodeFunctionData({ abi: call, data: nearTxs[2]!.data as `0x${string}` }).args;
  expect([method, nearGas, yocto, BigInt(nearTxs[2]!.value!)]).toEqual(["ft_transfer_call", 270n * 10n ** 12n, 1, 0n]);
  await expect(post.getByRole("link", { name: "See your bounty" })).toHaveAttribute("href", `/bounties/${ACCOUNT}/${NAME}`);
});

test("D14: each grant can be copied for a multisig", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await metamask(page, PROTOCOL_KEY);
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true }));
  await page.goto("/post");
  await fillRules(page);
  await connect(page);
  await task(page, /Base/, /Pause role/).getByRole("button", { name: "Copy for multisig" }).click();
  const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
  expect(copied).toMatchObject({ chainId: BASE, to: VAULT_BASE, value: "0" });
  expect(copied.data).toMatch(/^0x2f2ff15d/);
  expect(await walletSent(page)).toEqual({});
});

test("D15: the risk panel states every point before anything is signed", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY);
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true }));
  await page.goto("/post");
  const risk = page.getByRole("complementary", { name: "What you're risking" });
  for (const text of [
    "stops being claimable 5 minutes after the fix lands",
    "locked until the end date and paid in full to the first proven theft of at least the minimum theft",
    "The posting fee isn't refunded and pause gas can't be recovered",
    "The worst a wrong verdict can do is pause the covered contracts",
    "BounTEE can never move your funds",
    "published after the disclosure delay",
    "OutLayer",
    "Intel",
    "NEAR's MPC network",
  ]) {
    await expect(risk).toContainText(text);
  }
});

test("D20: a wallet whose signatures differ falls back to a saved key file", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY, { unstable: true });
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true }));
  await page.goto("/post");
  await fillRules(page);
  await connect(page);
  await page.getByRole("navigation", { name: "Posting steps" }).getByRole("button", { name: "4. Post bounty" }).click();
  await page.getByRole("button", { name: "Sign with MetaMask" }).click();
  await expect(step(page, 4)).toContainText("gave two different signatures");
  // The fallback: a saved X25519 key, 32 bytes as hex.
  await step(page, 4).getByLabel("Exploit key file").setInputFiles({ name: "exploit-key.hex", mimeType: "text/plain", buffer: Buffer.from("11".repeat(32)) });
  await expect(state(page, /Your exploit key/)).toHaveText("signed");
});

test("R4.12: the posting flow states the coverage limit @phone", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY);
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true }));
  await page.goto("/post");
  await expect(page.getByText("Skip any that pay callers")).toBeVisible();
});

test("R12.1: a mistyped address with no code never ticks as granted", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY);
  const w = postingWorld(ACCOUNT, { onboarded: true });
  await setWorld(page, w);
  await page.goto("/post");
  const s = step(page, 1);
  await s.getByLabel("What does this bounty protect?").fill("Vault V2");
  await s.getByLabel("Contract address").first().fill("0x00000000000000000000000000000000000000aa");
  await s.getByLabel("Bounty amount").fill("10");
  await s.getByRole("button", { name: "Continue" }).click();
  await connect(page);
  await expect(taskState(page, /Base/, /Pause role/)).toHaveText("not granted");
  await page.waitForTimeout(5_000);
  await expect(taskState(page, /Base/, /Pause role/)).toHaveText("not granted");
});

test("D13: the rules are filled in before any wallet connects; MetaMask is asked only at the first step that needs it", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY);
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true }));
  await page.goto("/post");
  const rules = step(page, 1);
  await expect(rules.getByRole("button", { name: "Connect MetaMask" })).toHaveCount(0);
  await rules.getByRole("combobox", { name: "Chain" }).first().click();
  await expect(page.getByRole("option")).toHaveText(["Base", "Arbitrum One"]);
  await page.keyboard.press("Escape");
  await fillRules(page);
  expect(await walletConnected(page)).toBe(false);
  await connect(page);
  expect(await walletConnected(page)).toBe(true);
});

test("D25: a name the Protocol already used is named as the reason once the wallet connects, with a fresh one a click away", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY);
  const w = postingWorld(ACCOUNT, { onboarded: true });
  post(w, { protocol: ACCOUNT, name: NAME });
  // Its pause-role address as the contract derives it, which the page checks before trusting the status.
  delete w.pauseRoles[`${ACCOUNT}/${NAME}`];
  await setWorld(page, w);
  await page.goto("/post");
  await fillRules(page);
  await step(page, 2).getByRole("button", { name: "Connect MetaMask" }).click();
  await expect(step(page, 2)).toContainText(`You've posted a bounty named ${NAME} before, and a name is never reused.`);
  await expect(step(page, 2).getByRole("button", { name: "Grant", exact: true })).toHaveCount(0);
  // One click takes the next free name, and the pause role for it follows.
  await step(page, 2).getByRole("button", { name: `Use ${NAME}-2` }).click();
  await expect(step(page, 2)).toContainText(pauseRole.address(pauseRole.MAINNET_ROOT_PUBLIC_KEY, CONTRACT, { protocol: ACCOUNT, name: `${NAME}-2` }), { ignoreCase: true });
});

test("D25: the bounty's name is asked in plain words and shown as the link Whitehats will use", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY);
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true }));
  await page.goto("/post");
  await step(page, 1).getByLabel("What does this bounty protect?").fill("Lending Pool v1!");
  await expect(step(page, 1)).toContainText("Whitehats find it at /bounties/your-address/lending-pool-v1");
});
