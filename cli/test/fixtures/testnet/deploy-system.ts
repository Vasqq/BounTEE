// Deploys the BounTEE system to NEAR testnet (#16), and records it in $BOUNTEE_DAY3
// (default ~/.bountee-testnet/day3-deployment.json):
//
// 1. Builds the attested judge (no features), pinned to the bounty contract's account as its
//    only caller (BOUNTEE_BOUNTY_CONTRACT), and uploads its wasm to OutLayer's FastFS.
// 2. Creates the bounty contract's account (a sub-account of its parent, whose key is in
//    ~/.near-credentials/testnet) if it doesn't exist yet.
// 3. Deploys the bounty contract keyless in one transaction (deploy + `new` + delete key),
//    with the real `outlayer.testnet` and `v1.signer-prod.testnet`, and the test USDC.
//
// Test USDC: `ft.bountee-spike4.testnet` ("sUSDC", stock NEP-141, 6 decimals, supply held
// by `bountee-spike4.testnet`): Circle's NEAR-testnet USDC needs its browser faucet.
//
// Env: CONTRACT (account id, e.g. day3.bountee-spike2.testnet), USDC, CONTRACT_NEAR (NEAR
// given to a new contract account, default 5).
// Run: node cli/test/fixtures/testnet/deploy-system.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actions, KeyPair, PublicKey } from "near-api-js";
import { pauseRole } from "@bountee/formats";
import { Near, loadKey, milliNear, saveKey, tgas } from "../../../src/near.ts";

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`set ${k}`); })();
const CONTRACT = env("CONTRACT");
const USDC = process.env.USDC ?? "ft.bountee-spike4.testnet";
const OUT = process.env.BOUNTEE_DAY3 ?? join(homedir(), ".bountee-testnet", "day3-deployment.json");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const near = new Near("testnet");

function buildJudge(pinnedTo: string): { wasm: Buffer; hash: string } {
  const target = readFileSync(join(root, "judge/wasm-target"), "utf8").trim();
  execFileSync("cargo", ["build", "--release", "-p", "bountee-judge", "--target", target], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, BOUNTEE_BOUNTY_CONTRACT: pinnedTo },
  });
  const wasm = readFileSync(join(root, `target/${target}/release/bountee-judge.wasm`));
  return { wasm, hash: createHash("sha256").update(wasm).digest("hex") };
}

/** FastFS upload (borsh `0u8 | path | Some(mime) | bytes`), failing on purpose with gas 1. */
async function upload(signer: string, wasm: Buffer, hash: string): Promise<{ url: string; tx?: string }> {
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
  for (let i = 0; i < 60; i++) {
    if (await served()) return { url, tx: r.transaction.hash };
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${url} is not served`);
}

const parent = CONTRACT.slice(CONTRACT.indexOf(".") + 1);
const judge = buildJudge(CONTRACT);
const uploaded = await upload(parent, judge.wasm, judge.hash);
console.error(`judge ${judge.hash} at ${uploaded.url}${uploaded.tx ? ` (upload tx ${uploaded.tx})` : ""}`);

let createTx: string | undefined;
if ((await near.balance(CONTRACT)) === null) {
  // The key is saved before the account exists, so a crash never loses it.
  const keyFile = join(homedir(), ".near-credentials", "testnet", `${CONTRACT}.json`);
  const key = existsSync(keyFile) ? KeyPair.fromString(loadKey("testnet", CONTRACT)) : KeyPair.fromRandom("ed25519");
  if (!existsSync(keyFile)) saveKey("testnet", CONTRACT, key);
  const r = await near.account(parent).signAndSendTransaction({
    receiverId: CONTRACT,
    actions: [
      actions.createAccount(),
      actions.transfer(milliNear(1000 * Number(process.env.CONTRACT_NEAR ?? 5))),
      actions.addFullAccessKey(key.getPublicKey()),
    ],
    waitUntil: "FINAL",
  });
  createTx = r.transaction.hash;
  console.error(`created ${CONTRACT}: ${createTx}`);
}

// Keyless from its first transaction (R2.1, R5.7): deploy, initialise, delete the only key.
const keys = await near.provider.viewAccessKeyList({ accountId: CONTRACT });
let deployTx: string | undefined;
if (keys.keys.length > 0) {
  execFileSync("cargo", ["near", "build", "non-reproducible-wasm"], { cwd: join(root, "contract"), stdio: "inherit" });
  const code = readFileSync(join(root, "contract/target/near/bountee_contract.wasm"));
  const config = {
    outlayer: "outlayer.testnet",
    mpc: "v1.signer-prod.testnet",
    mpc_root_public_key: pauseRole.TESTNET_ROOT_PUBLIC_KEY,
    usdc: USDC,
    judge_build_hash: `0x${judge.hash}`,
    judge_wasm_url: uploaded.url,
    seed: { native: "1000000000000000000", tokens: [] },
  };
  const r = await near.account(CONTRACT).signAndSendTransaction({
    receiverId: CONTRACT,
    actions: [
      actions.deployContract(code),
      actions.functionCall("new", { config }, tgas(100), milliNear(12.5)),
      actions.deleteKey(PublicKey.fromString(keys.keys[0]!.public_key)),
    ],
    waitUntil: "FINAL",
  });
  deployTx = r.transaction.hash;
  console.error(`deployed keyless: ${deployTx}`);
}
const config = await near.view(CONTRACT, "config");
if (config.judge_build_hash !== `0x${judge.hash}`) {
  throw new Error(`${CONTRACT} pins judge ${config.judge_build_hash}, but this checkout builds 0x${judge.hash}`);
}
const remaining = await near.provider.viewAccessKeyList({ accountId: CONTRACT });
if (remaining.keys.length > 0) throw new Error(`${CONTRACT} still has an access key`);

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const deployment = {
  ...previous,
  network: "testnet",
  contract: CONTRACT,
  outlayer: config.outlayer,
  mpc: config.mpc,
  usdc: config.usdc,
  judge: { hash: judge.hash, url: uploaded.url, upload_tx: uploaded.tx ?? previous.judge?.upload_tx },
  create_tx: createTx ?? previous.create_tx,
  deploy_tx: deployTx ?? previous.deploy_tx,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(deployment, null, 2)}\n`, { mode: 0o600 });
console.log(JSON.stringify(deployment));
