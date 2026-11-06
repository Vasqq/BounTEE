// Test stand-ins for the Protocol's side of opening a winning exploit: a MetaMask that signs
// with a known Ethereum key, and a release encrypted to that key's exploit key exactly as the
// judge's release job writes it (formats/src/job.rs, BounTEE release v1). The signing and key
// derivation are the command-line tool's own (cli/src/open-exploit.ts), so the page has to
// derive the same key the terminal does.
import { createCipheriv, createHash, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { deflateRawSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { exploitKeyFromWallet, personalSign, publicKeyText } from "../../../cli/src/open-exploit.ts";
import { CONTRACT, type BountyId } from "./world.ts";

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

/**
 * A MetaMask in the page: `eth_requestAccounts` answers one account, and `personal_sign`
 * signs with `walletKey` (or, with `unstable`, gives a different signature each time, as a
 * wallet that randomises its signatures would). Every request is recorded.
 */
export async function metamask(page: Page, walletKey: Uint8Array, o: { unstable?: boolean } = {}) {
  let n = 0;
  await page.exposeFunction("__personalSign", (hexMessage: string) => {
    const message = Buffer.from(hexMessage.replace(/^0x/, ""), "hex").toString("utf8");
    const sig = Buffer.from(personalSign(walletKey, o.unstable ? `${message}${n++}` : message));
    return `0x${sig.toString("hex")}`;
  });
  await page.addInitScript(() => {
    const w = window as any;
    w.__walletCalls = [];
    w.ethereum = {
      isMetaMask: true,
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        w.__walletCalls.push(method);
        if (method === "eth_requestAccounts" || method === "eth_accounts") return ["0x9f2c3e1a7b4d5c6e8f0a1b2c3d4e5f6a7b8c9d0e"];
        if (method === "personal_sign") return w.__personalSign(params![0]);
        if (method === "eth_chainId") return "0x2105";
        if (method === "wallet_requestPermissions" || method === "wallet_getPermissions") return [{ parentCapability: "eth_accounts" }];
        throw new Error(`stand-in MetaMask: ${method} isn't supported`);
      },
      on() {},
      removeListener() {},
    };
  });
}
