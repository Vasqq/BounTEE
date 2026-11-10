// Seam W, ticket #31: a Protocol posts a bounty from the browser with MetaMask. The stand-in
// MetaMask holds a test key; the chain stand-in applies what it sends, as each chain would.
import { expect, test, type Page } from "@playwright/test";
import { decodeFunctionData, keccak256, parseAbi, toHex } from "viem";
import { pauseRole } from "@bountee/formats";
import { ARBITRUM, BASE, CONTRACT, currentWorld, fundNear, NEAR_EVM, PAUSE_GAS_PER_PAUSE, postingWorld, setWorld, USDC, VAULT_ARB, VAULT_BASE } from "./stand-ins/world.ts";
import { addressOf, exploitPublicKey, metamask, PROTOCOL_KEY, walletSent } from "./stand-ins/wallet.ts";

const ACCOUNT = addressOf(PROTOCOL_KEY).toLowerCase();
const NAME = "vault-v2";
const NEAR = 10n ** 24n;
/** The pause-role address the MPC network signs this bounty's pauses from (D25). */
const PAUSE_ROLE = pauseRole.address(pauseRole.MAINNET_ROOT_PUBLIC_KEY, CONTRACT, { protocol: ACCOUNT, name: NAME });
const step = (page: Page, n: number) => page.getByRole("region", { name: new RegExp(`^${n}\\. `) });
const item = (page: Page, title: RegExp) => page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: title }) });

async function connect(page: Page) {
  await page.goto("/post");
  await page.getByRole("button", { name: "Connect MetaMask" }).click();
  await expect(page.getByText(ACCOUNT).first()).toBeVisible();
}

async function fillRules(page: Page) {
  const s = step(page, 2);
  await s.getByLabel("Bounty name").fill(NAME);
  await s.getByLabel("Chain").first().selectOption("Base");
  await s.getByLabel("Contract address").first().fill(VAULT_BASE);
  await s.getByRole("button", { name: "Add a contract" }).click();
  await s.getByLabel("Chain").nth(1).selectOption("Arbitrum One");
  await s.getByLabel("Contract address").nth(1).fill(VAULT_ARB);
  await s.getByLabel("Bounty amount").fill("10");
  await s.getByLabel("Minimum theft").fill("1");
  await s.getByLabel("End date").fill("2026-12-31");
  await s.getByLabel("Disclosure delay").fill("1");
  await s.getByRole("button", { name: "Continue" }).click();
}

test("D13, D5, D17, D20, D15: one MetaMask grants the pause roles, tops up pause gas and posts on NEAR as the Protocol's 0x… account", async ({ page }) => {
  // Every step, end to end: eleven wallet prompts and their receipts.
  test.setTimeout(120_000);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await metamask(page, PROTOCOL_KEY);
  await setWorld(page, postingWorld(ACCOUNT, { near: "0", usdc: "10000000" }));
  await connect(page);

  // 1. Connect: the NEAR account is the wallet's address; NEAR signing is enabled once, for free.
  await page.getByRole("button", { name: "Enable NEAR signing" }).click();
  await expect(step(page, 1)).toContainText("done");
  await page.getByRole("button", { name: "Continue" }).click();

  // 2. Rules, with the coverage limit stated (R4.12).
  await expect(step(page, 2)).toContainText("Only contracts that pay nothing to callers by design can be covered.");
  await fillRules(page);

  // 3. Pause role, per covered contract, ticked off as each grant lands (D5).
  await expect(item(page, /Base/)).toContainText("not yet");
  await item(page, /Base/).getByRole("button", { name: "Grant on Base" }).click();
  await expect(item(page, /Base/)).toContainText("done");
  await item(page, /Arbitrum One/).getByRole("button", { name: "Grant on Arbitrum One" }).click();
  await expect(item(page, /Arbitrum One/)).toContainText("done");
  const sent = await walletSent(page);
  const role = parseAbi(["function grantRole(bytes32 role, address account)"]);
  for (const [chain, vault] of [[BASE, VAULT_BASE], [ARBITRUM, VAULT_ARB]] as const) {
    const grant = sent[chain]!.find((t) => t.to?.toLowerCase() === vault)!;
    expect(decodeFunctionData({ abi: role, data: grant.data as `0x${string}` }).args).toEqual([keccak256(toHex("PAUSER_ROLE")), expect.stringMatching(new RegExp(PAUSE_ROLE, "i"))]);
  }
  await page.getByRole("button", { name: "Continue" }).click();

  // 4. Pause gas, with the plain explanation (D5), ticked off per chain.
  const gas = step(page, 4);
  await expect(gas).toContainText("The pause is a real transaction on that chain, paid by the pause-role address");
  await expect(gas).toContainText("BounTEE's funds on NEAR can't pay gas there");
  await expect(gas).toContainText("nobody, the Protocol included, can take that gas back");
  await expect(gas).toContainText("Nobody presses the pause button: a proven exploit triggers it.");
  await item(page, /Base/).getByRole("button", { name: "Top up on Base" }).click();
  await expect(item(page, /Base/)).toContainText("done");
  await item(page, /Arbitrum One/).getByRole("button", { name: "Top up on Arbitrum One" }).click();
  await expect(item(page, /Arbitrum One/)).toContainText("done");
  const topUp = (await walletSent(page))[BASE]!.find((t) => t.to?.toLowerCase() === PAUSE_ROLE)!;
  expect(BigInt(topUp.value!)).toBe(BigInt(PAUSE_GAS_PER_PAUSE));
  await page.getByRole("button", { name: "Continue" }).click();

  // 5. A little NEAR: the address with Copy, ticked off once it arrives (D17). No faucet on mainnet.
  const near = step(page, 5);
  await expect(near).toContainText(ACCOUNT);
  await expect(near).toContainText("0.7 NEAR");
  await expect(near.getByRole("link", { name: /faucet/i })).toHaveCount(0);
  await expect(near).toContainText("not yet");
  await fundNear(page, ACCOUNT, String(NEAR));
  await expect(near).toContainText("done", { timeout: 15_000 });
  await page.getByRole("button", { name: "Continue" }).click();

  // 6. The exploit key, from one MetaMask signature (asked twice to check it repeats) (D20).
  const key = exploitPublicKey(PROTOCOL_KEY, { protocol: ACCOUNT, name: NAME });
  await page.getByRole("button", { name: "Sign with MetaMask" }).click();
  await expect(step(page, 6)).toContainText(key);
  await page.getByRole("button", { name: "Continue" }).click();

  // 7. The rules read back, the risk panel beside the two prompts (D5, D15), then post.
  const post = step(page, 7);
  await expect(post).toContainText("Pays 10 USDC to the first Whitehat whose claim takes at least 1 USDC");
  const risk = page.getByRole("complementary", { name: "What you're risking" });
  await expect(risk).toBeVisible();
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
  await connect(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await fillRules(page);
  await item(page, /Base/).getByRole("button", { name: "Copy for your multisig" }).click();
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
  await connect(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await fillRules(page);
  await page.getByRole("navigation", { name: "Posting steps" }).getByRole("button", { name: "6. Exploit key" }).click();
  await page.getByRole("button", { name: "Sign with MetaMask" }).click();
  await expect(step(page, 6)).toContainText("gave two different signatures");
  // The fallback: a saved X25519 key, 32 bytes as hex.
  await step(page, 6).getByLabel("Exploit key file").setInputFiles({ name: "exploit-key.hex", mimeType: "text/plain", buffer: Buffer.from("11".repeat(32)) });
  await expect(step(page, 6)).toContainText(/x25519:[1-9A-HJ-NP-Za-km-z]{43,44}/);
});

test("D32: on mainnet the posting flow shows the Protocol's USDC balance with no faucet link", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY);
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true, usdc: "0" }));
  await connect(page);
  await page.getByRole("button", { name: "Continue" }).click();
  await fillRules(page);
  const dock = page.getByRole("navigation", { name: "Posting steps" });
  await dock.getByRole("button", { name: "6. Exploit key" }).click();
  await page.getByRole("button", { name: "Sign with MetaMask" }).click();
  await expect(step(page, 6)).toContainText(/x25519:/);
  await dock.getByRole("button", { name: "7. Post" }).click();
  await expect(step(page, 7)).toContainText("Your account holds 0 USDC on NEAR; the bounty needs more.");
  await expect(page.getByRole("link", { name: /faucet/i })).toHaveCount(0);
});

test("R4.12: the posting flow states the coverage limit @phone", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY);
  await setWorld(page, postingWorld(ACCOUNT, { onboarded: true }));
  await page.goto("/post#2");
  await expect(page.getByText("Only contracts that pay nothing to callers by design can be covered.")).toBeVisible();
});

test("R12.1: a mistyped address with no code never ticks as granted", async ({ page }) => {
  await metamask(page, PROTOCOL_KEY);
  const w = postingWorld(ACCOUNT, { onboarded: true });
  await setWorld(page, w);
  await connect(page);
  await page.getByRole("button", { name: "Continue" }).click();
  const s = step(page, 2);
  await s.getByLabel("Bounty name").fill(NAME);
  await s.getByLabel("Contract address").first().fill("0x00000000000000000000000000000000000000aa");
  await s.getByLabel("Bounty amount").fill("10");
  await s.getByLabel("Minimum theft").fill("1");
  await s.getByLabel("End date").fill("2026-12-31");
  await s.getByLabel("Disclosure delay").fill("1");
  await s.getByRole("button", { name: "Continue" }).click();
  await expect(item(page, /Base/)).toContainText("not yet");
  await page.waitForTimeout(5_000);
  await expect(item(page, /Base/)).toContainText("not yet");
});
