// D25: a bounty's pause-role address. TypeScript twin of formats/src/pause_role.rs, where
// the derivation and its sources are documented:
//   tweak   = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + predecessor + "," + path)
//   key     = root + tweak·G   (secp256k1)
//   address = keccak256(key's 64 uncompressed bytes)[12..]
// with path = "<protocol account>/<bounty name>" and predecessor = the bounty contract.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3.js";
import { base58 } from "@scure/base";
import type { BountyId } from "./formats.ts";
import { accountId, FormatError } from "./primitives.ts";

export const TESTNET_ROOT_PUBLIC_KEY =
  "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";
export const MAINNET_ROOT_PUBLIC_KEY =
  "secp256k1:3tFRbMqmoa6AAALMrEFAYCEoHcqKxeW38YptwowBVBtXK1vo36HDbUWuR6EZmoK4JcH6HDkNMGGqP1ouV7VZUWya";

const TWEAK_DERIVATION_PREFIX = "near-mpc-recovery v0.1.0 epsilon derivation:";
const { Point } = secp256k1;
const N = Point.CURVE().n;

// Plain hex, so the derivation also runs in a browser (the web app checks pause-role addresses with it).
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** The Chain Signatures path for a bounty's pause signatures: `<protocol>/<name>`. */
export const path = (bounty: BountyId): string => `${bounty.protocol}/${bounty.name}`;

function parseRoot(root: string) {
  const bad = () => new FormatError(`invalid secp256k1 root key: ${JSON.stringify(root)}`);
  if (!root.startsWith("secp256k1:")) throw bad();
  let raw: Uint8Array;
  try {
    raw = base58.decode(root.slice("secp256k1:".length));
  } catch {
    throw bad();
  }
  if (raw.length !== 64) throw bad();
  try {
    return Point.fromHex(`04${toHex(raw)}`);
  } catch {
    throw bad();
  }
}

function derivePoint(root: string, predecessor: string, path: string) {
  const rootPoint = parseRoot(root);
  accountId(predecessor);
  const digest = sha3_256(new TextEncoder().encode(`${TWEAK_DERIVATION_PREFIX}${predecessor},${path}`));
  const tweak = BigInt(`0x${toHex(digest)}`);
  if (tweak >= N) throw new FormatError("derivation tweak is not a valid scalar");
  return tweak === 0n ? rootPoint : Point.BASE.multiply(tweak).add(rootPoint);
}

/** The key the MPC network signs with, spelled as its `derived_public_key` view returns it. */
export function derivePublicKey(root: string, predecessor: string, path: string): string {
  const uncompressed = derivePoint(root, predecessor, path).toBytes(false);
  return `secp256k1:${base58.encode(uncompressed.slice(1))}`;
}

/** The EVM address of `bounty`'s pause role, signed for by `bountyContract`. */
export function address(root: string, bountyContract: string, bounty: BountyId): string {
  const uncompressed = derivePoint(root, bountyContract, path(bounty)).toBytes(false);
  return `0x${toHex(keccak_256(uncompressed.slice(1)).slice(12))}`;
}
