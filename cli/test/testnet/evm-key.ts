// An EVM private key for `forge` and `cast` without putting it on their command line, where it
// shows in `ps` and in the error text of a failed command (execFileSync prints the command).
//
// Foundry 1.0 reads no private key from the environment, but it does read an encrypted keystore
// from it: `ETH_KEYSTORE` (the keystore file) and `ETH_PASSWORD` (a file holding its password).
// So the key is written as a Web3 Secret Storage (v3) keystore under a fresh random password,
// both in a private temporary folder that is removed afterwards. And any error text the scripts
// print goes through `redact`, which blanks the key and any other 64-hex-digit secret.
import { createCipheriv, randomBytes, randomUUID, scryptSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3.js";

/** A 32-byte secret as hex, with or without 0x, standing alone (not inside a longer hex string). */
const SECRET = /(?<![0-9a-fA-F])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;

/** The text with every 64-hex-digit value blanked: keys, and (harmlessly) hashes too. */
export const redact = (text: string): string => text.replace(SECRET, "<redacted>");

/** The environment that makes forge and cast sign with `privateKey`, and a cleanup that removes it. */
export function keystoreEnv(privateKey: string): { env: Record<string, string>; cleanup: () => void } {
  const key = Buffer.from(privateKey.replace(/^0x/, ""), "hex");
  if (key.length !== 32) throw new Error("the deployer key is not 32 bytes of hex");
  const dir = mkdtempSync(join(tmpdir(), "bountee-evm-key-"));
  const password = randomBytes(32).toString("hex");
  const salt = randomBytes(32);
  const iv = randomBytes(16);
  const kdfparams = { dklen: 32, n: 8192, r: 8, p: 1, salt: salt.toString("hex") };
  const derived = scryptSync(password, salt, 32, { N: kdfparams.n, r: kdfparams.r, p: kdfparams.p });
  const cipher = createCipheriv("aes-128-ctr", derived.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
  const mac = Buffer.from(keccak_256(Buffer.concat([derived.subarray(16, 32), ciphertext]))).toString("hex");
  const keystore = {
    version: 3,
    id: randomUUID(),
    crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ciphertext.toString("hex"), kdf: "scrypt", kdfparams, mac },
  };
  const file = join(dir, "deployer.json");
  const passwordFile = join(dir, "password");
  writeFileSync(file, JSON.stringify(keystore), { mode: 0o600 });
  writeFileSync(passwordFile, password, { mode: 0o600 });
  return { env: { ETH_KEYSTORE: file, ETH_PASSWORD: passwordFile }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
