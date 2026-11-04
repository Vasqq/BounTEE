// Deploys the BounTEE system to NEAR testnet (#16), and records it in $BOUNTEE_DAY3
// (default ~/.bountee-testnet/day3-deployment.json):
//
// 1. Builds the attested judge (no features), pinned to the bounty contract's account as its
//    only caller (BOUNTEE_BOUNTY_CONTRACT), and uploads its wasm to OutLayer's FastFS.
// 2. Creates the bounty contract's account (a sub-account of its parent, whose key is in
//    ~/.near-credentials/testnet) if it doesn't exist yet.
// 3. Deploys the bounty contract keyless in one transaction (deploy + `new` + delete every
//    key), with the real `outlayer.testnet` and `v1.signer-prod.testnet`, and the test USDC.
//
// Test USDC: `ft.bountee-spike4.testnet` ("sUSDC", stock NEP-141, 6 decimals, supply held
// by `bountee-spike4.testnet`): Circle's NEAR-testnet USDC needs its browser faucet.
//
// Env: CONTRACT (account id, e.g. day3.bountee-spike2.testnet), USDC, CONTRACT_NEAR (NEAR
// given to a new contract account, default 5), NEAR_TESTNET_RPC.
// Run: node cli/test/testnet/deploy-system.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { actions, KeyPair } from "near-api-js";
import { credentialsDir, loadKey, milliNear, saveKey } from "../../src/near.ts";
import { buildJudge, contractConfig, deployKeyless, near, upload } from "./deploy.ts";

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`set ${k}`); })();
const CONTRACT = env("CONTRACT");
const USDC = process.env.USDC ?? "ft.bountee-spike4.testnet";
const OUT = process.env.BOUNTEE_DAY3 ?? join(homedir(), ".bountee-testnet", "day3-deployment.json");

const parent = CONTRACT.slice(CONTRACT.indexOf(".") + 1);
const judge = buildJudge(CONTRACT);
const uploaded = await upload(parent, judge.wasm, judge.hash);
console.error(`judge ${judge.hash} at ${uploaded.url}${uploaded.tx ? ` (upload tx ${uploaded.tx})` : ""}`);

let createTx: string | undefined;
if ((await near.balance(CONTRACT)) === null) {
  // The key is saved before the account exists, so a crash never loses it.
  const keyFile = join(credentialsDir("testnet"), `${CONTRACT}.json`);
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

// Keyless from its first transaction (R2.1, R5.7).
const deployTx = await deployKeyless(CONTRACT, contractConfig({ usdc: USDC, judgeHash: judge.hash, judgeUrl: uploaded.url }));
const config = await near.view(CONTRACT, "config");
if (config.judge_build_hash !== `0x${judge.hash}`) {
  throw new Error(`${CONTRACT} pins judge ${config.judge_build_hash}, but this checkout builds 0x${judge.hash}`);
}

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
