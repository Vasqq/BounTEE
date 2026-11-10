// Test stand-ins for the Protocol's side of opening a winning exploit: a MetaMask that signs
// with a known Ethereum key, and a release encrypted to that key's exploit key exactly as the
// judge's release job writes it (formats/src/job.rs, BounTEE release v1). The signing and key
// derivation are the command-line tool's own (cli/src/open-exploit.ts), so the page has to
// derive the same key the terminal does.
import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { exploitKeyFromWallet, personalSign, publicKeyText } from "../../../cli/src/open-exploit.ts";
import { privateKeyToAccount } from "viem/accounts";
import { CONTRACT, STAND_IN, type BountyId } from "./world.ts";

/** Ethereum keys for tests only, derived from fixed labels so no key is written down; they never hold funds. */
const testKey = (label: string) => createHash("sha256").update(`bountee web test key: ${label}`).digest();
export const PROTOCOL_KEY = testKey("protocol");
export const OTHER_KEY = testKey("another wallet");

/** The exploit public key a wallet's signature derives for this bounty, as the rules spell it. */
export const exploitPublicKey = (walletKey: Uint8Array, id: BountyId) => publicKeyText(exploitKeyFromWallet(walletKey, CONTRACT, id));

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
 * A MetaMask in the page, holding `walletKey`. It answers what wagmi asks of an injected
 * wallet: accounts, the current chain and switching it, `personal_sign` (or, with `unstable`, a
 * different signature each time, as a wallet that randomises its signatures would), and
 * `eth_sendTransaction`, which the chain stand-in applies as the chain would. Every request's
 * method is recorded.
 */
export async function metamask(page: Page, walletKey: Uint8Array, o: { unstable?: boolean } = {}) {
  let n = 0;
  const address = addressOf(walletKey);
  await page.exposeFunction("__personalSign", (hexMessage: string) => {
    const message = Buffer.from(hexMessage.replace(/^0x/, ""), "hex").toString("utf8");
    const sig = Buffer.from(personalSign(walletKey, o.unstable ? `${message}${n++}` : message));
    return `0x${sig.toString("hex")}`;
  });
  await page.exposeFunction("__sendTransaction", async (chainId: number, tx: Record<string, string>) => {
    const r = await page.request.post(`${STAND_IN}/apply`, { data: { chainId, from: address, to: tx.to, data: tx.data, value: tx.value } });
    return (await r.json()).hash as string;
  });
  await page.addInitScript((account: string) => {
    const w = window as any;
    w.__walletCalls = [];
    let chainId = "0x2105";
    const listeners: Record<string, ((x: unknown) => void)[]> = {};
    w.ethereum = {
      isMetaMask: true,
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
          case "wallet_switchEthereumChain":
          case "wallet_addEthereumChain":
            chainId = params![0].chainId;
            (listeners.chainChanged ?? []).forEach((f) => f(chainId));
            return null;
          case "personal_sign":
            return w.__personalSign(params![0]);
          case "eth_sendTransaction":
            return w.__sendTransaction(parseInt(chainId, 16), params![0]);
          default:
            throw Object.assign(new Error(`stand-in MetaMask: ${method} isn't supported`), { code: 4200 });
        }
      },
      on(event: string, f: (x: unknown) => void) {
        (listeners[event] ??= []).push(f);
      },
      removeListener(event: string, f: (x: unknown) => void) {
        listeners[event] = (listeners[event] ?? []).filter((g) => g !== f);
      },
    };
  }, address);
}

/** Whether the page has asked the stand-in MetaMask to connect (eth_requestAccounts). */
export async function walletConnected(page: Page): Promise<boolean> {
  return page.evaluate(() => sessionStorage.getItem("__authorized") === "1");
}

/** Every transaction the stand-in MetaMask sent, by chain ID. */
export async function walletSent(page: Page): Promise<Record<number, { to?: string; data?: string; value?: string; hash: string }[]>> {
  return (await page.request.get(`${STAND_IN}/wallet-sent`)).json();
}
