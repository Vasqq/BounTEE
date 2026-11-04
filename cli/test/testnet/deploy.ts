// What the testnet deploy scripts share (deploy-system.ts, deploy-sealing.ts): build the
// judge and upload it to OutLayer's FastFS, the bounty contract's configuration, and its
// keyless deployment.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actions, PublicKey } from "near-api-js";
import { pauseRole } from "@bountee/formats";
import { Near, milliNear, tgas } from "../../src/near.ts";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const near = new Near("testnet", process.env.NEAR_TESTNET_RPC);

/** Build the attested judge (no features), pinned to `pinnedTo` as its only caller. */
export function buildJudge(pinnedTo: string): { wasm: Buffer; hash: string } {
  const target = readFileSync(join(root, "judge/wasm-target"), "utf8").trim();
  execFileSync("cargo", ["build", "--release", "-p", "bountee-judge", "--target", target], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, BOUNTEE_BOUNTY_CONTRACT: pinnedTo },
  });
  const wasm = readFileSync(join(root, `target/${target}/release/bountee-judge.wasm`));
  return { wasm, hash: createHash("sha256").update(wasm).digest("hex") };
}

/**
 * Upload the judge's wasm to FastFS (borsh `0u8 | path | Some(mime) | bytes`, a call that
 * fails on purpose with gas 1: FastFS indexes the transaction's arguments), unless it is
 * already served. Returns its URL and the upload transaction, if one was sent.
 */
export async function upload(signer: string, wasm: Buffer, hash: string): Promise<{ url: string; tx?: string }> {
  const str = (b: Buffer) => Buffer.concat([Buffer.from(new Uint32Array([b.length]).buffer), b]);
  const args = Buffer.concat([
    Buffer.from([0]), str(Buffer.from(`${hash}.wasm`)), Buffer.from([1]), str(Buffer.from("application/wasm")), str(wasm),
  ]);
  const url = `https://test.fastfs.io/${signer}/outlayer.testnet/${hash}.wasm`;
  const served = async () => {
    const r = await fetch(url).catch(() => undefined);
    return r?.ok && createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest("hex") === hash;
  };
  if (await served()) return { url };
  const r = await near.account(signer).signAndSendTransaction({
    receiverId: "outlayer.testnet",
    actions: [actions.functionCall("__fastdata_fastfs", args, 1n, 0n)],
    throwOnFailure: false,
    waitUntil: "FINAL",
  });
  console.error(`FastFS upload of ${hash}: tx ${r.transaction.hash}`);
  for (let i = 0; i < 60; i++) {
    if (await served()) return { url, tx: r.transaction.hash };
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${url} is not served`);
}

/** The bounty contract's configuration on testnet: real OutLayer and MPC, the given USDC. */
export function contractConfig(o: { usdc: string; judgeHash: string; judgeUrl: string }) {
  return {
    outlayer: "outlayer.testnet",
    mpc: "v1.signer-prod.testnet",
    mpc_root_public_key: pauseRole.TESTNET_ROOT_PUBLIC_KEY,
    usdc: o.usdc,
    judge_build_hash: `0x${o.judgeHash}`,
    judge_wasm_url: o.judgeUrl,
    seed: { native: "1000000000000000000", tokens: [] },
  };
}

/**
 * Deploy the bounty contract keyless (R2.1): one transaction deploys the code, calls `new`
 * and deletes every access key the account has, signed by one of them. Does nothing if the
 * account has no key left (it is deployed already). Checks no key remains either way.
 */
export async function deployKeyless(contract: string, config: ReturnType<typeof contractConfig>): Promise<string | undefined> {
  const keys = await near.provider.viewAccessKeyList({ accountId: contract });
  let tx: string | undefined;
  if (keys.keys.length > 0) {
    execFileSync("cargo", ["near", "build", "non-reproducible-wasm"], { cwd: join(root, "contract"), stdio: "inherit" });
    const code = readFileSync(join(root, "contract/target/near/bountee_contract.wasm"));
    const r = await near.account(contract).signAndSendTransaction({
      receiverId: contract,
      actions: [
        actions.deployContract(code),
        actions.functionCall("new", { config }, tgas(100), milliNear(12.5)),
        ...keys.keys.map((k) => actions.deleteKey(PublicKey.fromString(k.public_key))),
      ],
      waitUntil: "FINAL",
    });
    tx = r.transaction.hash;
    console.error(`deployed keyless: ${tx}`);
  }
  const remaining = await near.provider.viewAccessKeyList({ accountId: contract });
  if (remaining.keys.length > 0) throw new Error(`${contract} still has ${remaining.keys.length} access key(s)`);
  return tx;
}
