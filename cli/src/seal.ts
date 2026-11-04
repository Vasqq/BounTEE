// Sealing an exploit on the Whitehat's machine (R5.1, ADR-0012; spec "Sealing").
//
// The exploit is bound to the Whitehat's account ([`SealedBundle`]), compressed, and
// encrypted to OutLayer's keystore key for the pair (pinned judge build, bounty contract
// as the secret's owner). Only the pinned judge build, in a job the bounty contract
// requests, can open it (R5.2, R5.3). The keystore is sent the secret's key name with an
// empty value, never the exploit: nothing plaintext leaves this machine.
import {
  createCipheriv,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { deflateRawSync } from "node:zlib";
import { parseSealedBundle, toJson, type Exploit } from "@bountee/formats";

/** The OutLayer secret the judge reads the sealed exploit from. */
export const SECRET_NAME = "BOUNTEE_SEALED_EXPLOIT";

/** OutLayer's keystore API (spec: testnet and mainnet hosts). */
export const KEYSTORE_API = {
  testnet: "https://testnet-api.outlayer.ai",
  mainnet: "https://api.outlayer.ai",
} as const;

/**
 * The secret's value: base64(raw DEFLATE(JSON of the SealedBundle)). Compressed because the
 * secret's storage deposit is 0.00001 NEAR per byte.
 */
export function bundle(whitehat: string, exploit: Exploit): string {
  const value = parseSealedBundle({ whitehat, exploit });
  return deflateRawSync(Buffer.from(toJson(value)), { level: 9 }).toString("base64");
}

/** 32 raw bytes of an X25519 public key, wrapped as SPKI DER for node:crypto. */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/**
 * OutLayer's ECIES v1, as its keystore expects: base64(0x01 | ephemeral X25519 public key
 * (32) | nonce (12) | ChaCha20-Poly1305 ciphertext and tag), keyed by
 * HKDF-SHA256(no salt, info "outlayer-keystore-v1") of the X25519 shared secret.
 */
export function encrypt(keystorePublicKey: Uint8Array, plaintext: string): string {
  if (keystorePublicKey.length !== 32) throw new Error("the keystore's key is not 32 bytes");
  const recipient = createPublicKey({
    key: Buffer.concat([X25519_SPKI_PREFIX, keystorePublicKey]),
    format: "der",
    type: "spki",
  });
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: recipient });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), "outlayer-keystore-v1", 32));
  const nonce = randomBytes(12);
  const cipher = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  const ephPub = eph.publicKey.export({ format: "der", type: "spki" }).subarray(X25519_SPKI_PREFIX.length);
  return Buffer.concat([Buffer.from([1]), ephPub, nonce, ct]).toString("base64");
}

/**
 * Ask OutLayer's keystore for the key of (judge build, owner). The key depends only on
 * those two; the endpoint checks key names, so it gets the secret's name with an empty value.
 */
export async function keystoreKey(api: string, judgeHash: string, owner: string): Promise<Uint8Array> {
  const res = await fetch(`${api}/secrets/pubkey`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "bountee-cli" },
    body: JSON.stringify({
      accessor: { type: "WasmHash", hash: judgeHash.replace(/^0x/, "") },
      owner,
      profile: "claim",
      secrets_json: JSON.stringify({ [SECRET_NAME]: "" }),
    }),
  });
  if (!res.ok) throw new Error(`OutLayer's keystore answered ${res.status}: ${await res.text()}`);
  const { pubkey } = (await res.json()) as { pubkey?: string };
  if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/.test(pubkey)) {
    throw new Error("OutLayer's keystore gave no X25519 key");
  }
  return Buffer.from(pubkey, "hex");
}

/** Seal `exploit` for `whitehat` to the judge build `judgeHash` and the bounty contract. */
export async function seal(opts: {
  api: string;
  judgeHash: string;
  bountyContract: string;
  whitehat: string;
  exploit: Exploit;
}): Promise<string> {
  const key = await keystoreKey(opts.api, opts.judgeHash, opts.bountyContract);
  return encrypt(key, JSON.stringify({ [SECRET_NAME]: bundle(opts.whitehat, opts.exploit) }));
}
