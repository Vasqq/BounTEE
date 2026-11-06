// D25: the pause-role address, derived as NEAR Chain Signatures (v1.signer-prod.testnet)
// derives it. Expected keys came from the MPC contract's own derived_public_key view.
import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { pauseRole } from "../src/index.ts";

interface Vector {
  bounty_contract: string;
  protocol: string;
  name: string;
  path: string;
  derived_public_key: string;
  evm_address: string;
}
const fixture: { root_public_key: string; vectors: Vector[] } = JSON.parse(
  readFileSync(new URL("../../fixtures/pause-role.json", import.meta.url), "utf8"),
);

test("D25 the testnet root key is the one the MPC contract publishes", () => {
  expect(pauseRole.TESTNET_ROOT_PUBLIC_KEY).toBe(fixture.root_public_key);
});

for (const v of fixture.vectors) {
  test(`D25 pause-role address for ${v.bounty_contract} + ${v.path}`, () => {
    const bounty = { protocol: v.protocol, name: v.name };
    expect(pauseRole.path(bounty)).toBe(v.path);
    expect(pauseRole.derivePublicKey(pauseRole.TESTNET_ROOT_PUBLIC_KEY, v.bounty_contract, v.path)).toBe(
      v.derived_public_key,
    );
    expect(pauseRole.address(pauseRole.TESTNET_ROOT_PUBLIC_KEY, v.bounty_contract, bounty)).toBe(v.evm_address);
  });
}

test("D25 a malformed root key is refused", () => {
  expect(() => pauseRole.derivePublicKey("ed25519:abc", "bountee.testnet", "a/b")).toThrow();
  expect(() => pauseRole.derivePublicKey("secp256k1:111", "bountee.testnet", "a/b")).toThrow();
});
