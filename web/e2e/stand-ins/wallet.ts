// Test stand-ins for the Protocol's side of opening a winning exploit: a browser wallet (MetaMask,
// or another wallet by its provider flags) that signs with a known Ethereum key, and a release encrypted to that key's exploit key exactly as the
// judge's release job writes it (formats/src/job.rs, BounTEE release v1). The signing and key
// derivation are the command-line tool's own (cli/src/open-exploit.ts), so the page has to
// derive the same key the terminal does.
import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { exploitKeyFromWallet, personalSign, publicKeyText } from "../../../cli/src/open-exploit.ts";
import { privateKeyToAccount } from "viem/accounts";
import { NETWORKS, STAND_IN, type BountyId, type Network } from "./world.ts";

/** Ethereum keys for tests only, derived from fixed labels so no key is written down; they never hold funds. */
const testKey = (label: string) => createHash("sha256").update(`bountee web test key: ${label}`).digest();
export const PROTOCOL_KEY = testKey("protocol");
export const OTHER_KEY = testKey("another wallet");

/** The exploit public key a wallet's signature derives for this bounty, as the rules spell it. */
export const exploitPublicKey = (walletKey: Uint8Array, id: BountyId, network: Network = "mainnet") => publicKeyText(exploitKeyFromWallet(walletKey, NETWORKS[network].contract, id));

export const EXPLOIT = {
  transactions: [
    {
      from: "0xa6ba2df5a5988dcecead124cb6dfb29e72009aba",
      to: "0x8e01c52f1b2bbedd8b714b9ae168d022b52e74c1",
      value: "0",
      input: "0xbcada9b6000000000000000000000000a6ba2df5a5988dcecead124cb6dfb29e72009aba000000000000000000000000000000000000000000000000000000e8d4a51000",
      gas: 81459,
    },
  ],
};

/** The release of claim `claimId`'s exploit, encrypted to the exploit key in `publicKey` (`x25519:<base58>`). */
export function release(publicKey: string, id: BountyId, claimId: number, whitehat = "whitehat.near"): string {
  const raw = Buffer.from(base58Decode(publicKey.replace(/^x25519:/, "")));
  const recipient = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), raw]), format: "der", type: "spki" });
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), "bountee-release-v1", 32));
  const nonce = randomBytes(12);
  const plain = deflateRawSync(Buffer.from(JSON.stringify({ bounty: id, claim_id: claimId, whitehat, exploit: EXPLOIT })));
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const ephRaw = eph.publicKey.export({ format: "der", type: "spki" }).subarray(12);
  return Buffer.concat([Buffer.from([1]), ephRaw, nonce, body]).toString("base64");
}

function base58Decode(s: string): Uint8Array {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(A.indexOf(ch));
  const hex = n.toString(16).padStart(64, "0");
  return Buffer.from(hex, "hex");
}

/** The 0x address of a test key: the Protocol's NEAR account is this address, lowercased (NEP-518). */
export const addressOf = (walletKey: Uint8Array) => privateKeyToAccount(`0x${Buffer.from(walletKey).toString("hex")}`).address;

/**
 * The wallets the stand-in can present as, each by the injected provider flags the real one sets
 * (D34): Rabby, Brave Wallet, Zerion and Trust set MetaMask's flag too, as the real ones do;
 * Zerion also injects `window.zerionWallet`, and Phantom `window.phantom.ethereum`. `rdns` is
 * the real wallet's EIP-6963 identifier, under which the stand-in can announce itself.
 */
export const PERSONAS = {
  MetaMask: { flags: ["isMetaMask"], rdns: "io.metamask" },
  Rabby: { flags: ["isRabby", "isMetaMask"], rdns: "io.rabby" },
  "Brave Wallet": { flags: ["isBraveWallet", "isMetaMask"], rdns: "com.brave.wallet" },
  Zerion: { flags: ["isZerion", "isMetaMask"], rdns: "io.zerion.wallet", namespace: "zerionWallet" },
  Phantom: { flags: ["isPhantom"], rdns: "app.phantom", namespace: "phantom.ethereum" },
  Trust: { flags: ["isTrust", "isMetaMask"], rdns: "com.trustwallet.app" },
} as const satisfies Record<string, { flags: readonly string[]; rdns: string; namespace?: string }>;
export type Persona = keyof typeof PERSONAS;

type WalletOptions = { unstable?: boolean; rejectFirstSign?: boolean; network?: Network };

/** A MetaMask in the page, holding `walletKey`: the stand-in wallet presenting as MetaMask. */
export const metamask = (page: Page, walletKey: Uint8Array, o: WalletOptions = {}) => wallet(page, walletKey, { ...o, as: "MetaMask" });

/**
 * A browser wallet in the page, holding `walletKey`, presenting as `as` (PERSONAS) on
 * `window.ethereum` and, with `announce`, over EIP-6963 as well. It answers what wagmi asks of an injected
 * wallet: accounts, the current chain and switching it, `personal_sign` (or, with `unstable`, a
 * different signature each time, as a wallet that randomises its signatures would; with
 * `rejectFirstSign`, the Protocol rejecting the first signature asked for), and
 * `eth_sendTransaction`, which the chain stand-in applies as the chain would. Every request's
 * method is recorded, and so is each chain it is asked to switch to or add. It starts on the
 * network's Base-family chain.
 */
export async function wallet(page: Page, walletKey: Uint8Array, o: WalletOptions & { as: Persona; announce?: boolean }) {
  const persona: { flags: readonly string[]; rdns: string; namespace?: string } = PERSONAS[o.as];
  let n = 0;
  let rejectNextSign = !!o.rejectFirstSign;
  const address = addressOf(walletKey);
  await page.exposeFunction("__personalSign", (hexMessage: string) => {
    if (rejectNextSign) {
      rejectNextSign = false;
      return null;
    }
    const message = Buffer.from(hexMessage.replace(/^0x/, ""), "hex").toString("utf8");
    const sig = Buffer.from(personalSign(walletKey, o.unstable ? `${message}${n++}` : message));
    return `0x${sig.toString("hex")}`;
  });
  await page.exposeFunction("__sendTransaction", async (chainId: number, tx: Record<string, string>) => {
    const r = await page.request.post(`${STAND_IN}/apply`, { data: { chainId, from: address, to: tx.to, data: tx.data, value: tx.value } });
    return (await r.json()).hash as string;
  });
  type Init = { account: string; start: string; name: string; flags: readonly string[]; rdns: string; namespace?: string; announce: boolean };
  await page.addInitScript(({ account, start, name, flags, rdns, namespace, announce }: Init) => {
    const w = window as any;
    w.__walletCalls = [];
    w.__chainsAsked = [];
    let chainId = start;
    const known = new Set([start]);
    const listeners: Record<string, ((x: unknown) => void)[]> = {};
    const provider: Record<string, unknown> = {
      ...Object.fromEntries(flags.map((flag) => [flag, true])),
      request: async ({ method, params }: { method: string; params?: any[] }) => {
        w.__walletCalls.push(method);
        switch (method) {
          // As MetaMask: accounts only once this site has been allowed to see them.
          case "eth_requestAccounts":
            sessionStorage.setItem("__authorized", "1");
            return [account];
          case "eth_accounts":
            return sessionStorage.getItem("__authorized") ? [account] : [];
          case "eth_chainId":
            return chainId;
          case "wallet_requestPermissions":
          case "wallet_getPermissions":
            return [{ parentCapability: "eth_accounts" }];
          // As MetaMask: a chain it hasn't been given yet must be added, with its name and RPC,
          // before it can be switched to (EIP-3326's 4902).
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            w.__chainsAsked.push({ method, ...params![0] });
            if (method === "wallet_switchEthereumChain" && !known.has(params![0].chainId)) {
              throw Object.assign(new Error(`Unrecognized chain ID ${params![0].chainId}`), { code: 4902 });
            }
            known.add(params![0].chainId);
            chainId = params![0].chainId;
            (listeners.chainChanged ?? []).forEach((f) => f(chainId));
            return null;
          case "personal_sign": {
            const sig = await w.__personalSign(params![0]);
            // EIP-1193's 4001: the Protocol rejected the request in the wallet.
            if (sig === null) throw Object.assign(new Error("User rejected the request."), { code: 4001 });
            return sig;
          }
          case "eth_sendTransaction":
            return w.__sendTransaction(parseInt(chainId, 16), params![0]);
          default:
            throw Object.assign(new Error(`stand-in ${name}: ${method} isn't supported`), { code: 4200 });
        }
      },
      on(event: string, f: (x: unknown) => void) {
        (listeners[event] ??= []).push(f);
      },
      removeListener(event: string, f: (x: unknown) => void) {
        listeners[event] = (listeners[event] ?? []).filter((g) => g !== f);
      },
    };
    w.ethereum = provider;
    // The wallet's own namespace too, where the real one injects it.
    if (namespace) {
      const path = namespace.split(".");
      let at = w;
      for (const key of path.slice(0, -1)) at = at[key] ??= {};
      at[path.at(-1)!] = provider;
    }
    // EIP-6963: announced once loaded, and again whenever the page asks.
    if (announce) {
      const info = Object.freeze({ uuid: crypto.randomUUID(), name, icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E", rdns });
      const detail = Object.freeze({ info, provider });
      const announceProvider = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail }));
      window.addEventListener("eip6963:requestProvider", announceProvider);
      announceProvider();
    }
  }, { account: address, start: `0x${NETWORKS[o.network ?? "mainnet"].base.toString(16)}`, name: o.as, flags: persona.flags, rdns: persona.rdns, namespace: persona.namespace, announce: !!o.announce });
}

/**
 * Picks `wallet` in RainbowKit's wallet picker, which a page's connect button has just opened
 * (D34): the page goes on once the wallet connects.
 */
export async function pickWallet(page: Page, wallet = "MetaMask") {
  await page.getByRole("dialog").getByRole("button", { name: new RegExp(`^${wallet}`) }).click();
}

/** Each chain the page asked MetaMask to switch to or add, in order, with what it said of the chain. */
export async function chainsAsked(page: Page): Promise<{ method: string; chainId: string; chainName?: string; rpcUrls?: string[] }[]> {
  return page.evaluate(() => (window as any).__chainsAsked);
}

/** Every method the page has asked the stand-in wallet for since the page loaded (or resetWalletCalls), in order. */
export async function walletCalls(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as any).__walletCalls);
}

/** Empties the stand-in wallet's call log, so walletCalls then returns only what follows. */
export async function resetWalletCalls(page: Page) {
  await page.evaluate(() => ((window as any).__walletCalls = []));
}

/** Whether the page has asked the stand-in MetaMask to connect (eth_requestAccounts). */
export async function walletConnected(page: Page): Promise<boolean> {
  return page.evaluate(() => sessionStorage.getItem("__authorized") === "1");
}

/** Every transaction the stand-in MetaMask sent, by chain ID. */
export async function walletSent(page: Page): Promise<Record<number, { to?: string; data?: string; value?: string; hash: string }[]>> {
  return (await page.request.get(`${STAND_IN}/wallet-sent`)).json();
}
