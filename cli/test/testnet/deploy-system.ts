// Deploys the BounTEE system to NEAR testnet or mainnet (#16, #43; NETWORK, default testnet),
// and records it in $BOUNTEE_DAY3 (default ~/.bountee-<network>/day3-deployment.json):
//
// 0. Builds the attested judge (no features), pinned to the bounty contract's account as its
//    only caller (BOUNTEE_BOUNTY_CONTRACT; a `.near` contract makes it a mainnet build), and
//    the contract. Then reports the NEAR the deployment needs, and stops before spending
//    anything, naming what to top up, if it would run dry (exit status 3; PREFLIGHT_ONLY=1
//    stops here either way).
// 1. Creates the bounty contract's account (a sub-account of its parent, whose key is in
//    ~/.near-credentials/<network>) if it doesn't exist yet. On mainnet the account is made
//    beforehand, so the parent's key never needs to be on disk.
// 2. Uploads the judge's wasm to OutLayer's FastFS, signed by the contract account itself.
// 3. Deploys the bounty contract keyless in one transaction (deploy + `new` + delete every
//    key), with the network's real OutLayer and MPC signer, and its USDC.
//
// USDC: Circle's on mainnet; on testnet `ft.bountee-spike4.testnet` ("sUSDC", stock NEP-141,
// 6 decimals, supply held by `bountee-spike4.testnet`): Circle's NEAR-testnet USDC needs its
// browser faucet.
//
// Env: NETWORK, CONTRACT (account id, e.g. day3.bountee-spike2.testnet or bounty.bountee.near),
// USDC, CONTRACT_NEAR (NEAR given to a new contract account, default 5), NEAR_RPC,
// PREFLIGHT_ONLY.
// Run: [NETWORK=mainnet] node cli/test/testnet/deploy-system.ts
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { actions, KeyPair } from "near-api-js";
import { credentialsDir, formatNear, loadKey, milliNear, saveKey } from "../../src/near.ts";
import { buildContract, buildJudge, contractConfig, DEFAULT_USDC, deployKeyless, near, need, network, stopIfShort, upload } from "./deploy.ts";

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`set ${k}`); })();
const CONTRACT = env("CONTRACT");
const USDC = process.env.USDC ?? DEFAULT_USDC[network];
const OUT = process.env.BOUNTEE_DAY3 ?? join(homedir(), `.bountee-${network}`, "day3-deployment.json");

const parent = CONTRACT.slice(CONTRACT.indexOf(".") + 1);
const judge = buildJudge(CONTRACT);
const code = buildContract(CONTRACT);

// ---- Preflight -----------------------------------------------------------------------------
// The contract account locks storage for its code and state (state ~12 KB on testnet, Nov 5)
// at 1e19 yoctoNEAR a byte, attaches 0.0125 NEAR to `new`, and burns some gas on the upload
// and the deployment (~0.01 NEAR measured): 0.05 NEAR covers both.
const existing = await near.balance(CONTRACT);
const deployed = existing !== null && (await near.provider.viewAccessKeyList({ accountId: CONTRACT })).keys.length === 0;
if (!deployed) {
  const contractNear = milliNear(1000 * Number(process.env.CONTRACT_NEAR ?? 5));
  const locked = BigInt(code.length + 20_000) * 10n ** 19n + milliNear(62.5);
  const showNear = (y: bigint) => `${formatNear(y)} NEAR`;
  const chain = `near-${network}`;
  stopIfShort(
    existing === null
      ? [
          need(parent, chain, "NEAR", (await near.balance(parent)) ?? 0n, contractNear + milliNear(10), showNear),
          need(`${CONTRACT} (CONTRACT_NEAR)`, chain, "NEAR", contractNear, locked, showNear),
        ]
      : [need(CONTRACT, chain, "NEAR", existing, locked, showNear)],
  );
} else if (process.env.PREFLIGHT_ONLY === "1") process.exit(0);

let createTx: string | undefined;
if (existing === null) {
  // The key is saved before the account exists, so a crash never loses it.
  const keyFile = join(credentialsDir(network), `${CONTRACT}.json`);
  const key = existsSync(keyFile) ? KeyPair.fromString(loadKey(network, CONTRACT)) : KeyPair.fromRandom("ed25519");
  if (!existsSync(keyFile)) saveKey(network, CONTRACT, key);
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

// Signed by the contract account while it still has a key; a contract deployed already
// names the URL its judge was uploaded to.
const uploaded = deployed
  ? { url: (await near.view(CONTRACT, "config")).judge_wasm_url as string, tx: undefined }
  : await upload(CONTRACT, judge.wasm, judge.hash);
console.error(`judge ${judge.hash} at ${uploaded.url}${uploaded.tx ? ` (upload tx ${uploaded.tx})` : ""}`);

// Keyless from its first transaction (R2.1, R5.7).
const deployTx = await deployKeyless(CONTRACT, contractConfig({ usdc: USDC, judgeHash: judge.hash, judgeUrl: uploaded.url }), code);
const config = await near.view(CONTRACT, "config");
if (config.judge_build_hash !== `0x${judge.hash}`) {
  throw new Error(`${CONTRACT} pins judge ${config.judge_build_hash}, but this checkout builds 0x${judge.hash}`);
}

const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : {};
const deployment = {
  ...previous,
  network,
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
