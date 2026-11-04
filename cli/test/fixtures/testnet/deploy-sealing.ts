// Sets up the testnet deployment `sealing-testnet.test.ts` runs against (#15), and writes
// it to $BOUNTEE_TESTNET_SEALING (default ~/.bountee-testnet/sealing-deployment.json):
//
// 1. Builds the judge twice: pinned to the bounty contract (the pinned build, H1) and pinned
//    to the attacker's account (another build, H2, whose caller check the attacker passes),
//    and uploads both wasm files to FastFS.
// 2. Deploys the bounty contract keyless (deploy + new + delete key, one transaction),
//    pinned to H1, with the USDC stand-in `ft.bountee-spike4.testnet`.
// 3. Posts a bounty (fixture rules) and tops up the Whitehat's claim balance.
//
// Accounts (keys in ~/.near-credentials/testnet, created with near-cli-rs
// `account create-account sponsor-by-faucet-service`): CONTRACT, PROTOCOL (holds the USDC
// stand-in), WHITEHAT, ATTACKER, all given as env vars.
// Run: node cli/test/fixtures/testnet/deploy-sealing.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actions, PublicKey } from "near-api-js";
import { account, provider, txStatus, view } from "./near.ts";

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`set ${k}`); })();
const CONTRACT = env("CONTRACT");
const PROTOCOL = env("PROTOCOL");
const WHITEHAT = env("WHITEHAT");
const ATTACKER = env("ATTACKER");
const USDC = process.env.USDC ?? "ft.bountee-spike4.testnet";
const OUT = process.env.BOUNTEE_TESTNET_SEALING ?? join(homedir(), ".bountee-testnet", "sealing-deployment.json");
const root = fileURLToPath(new URL("../../../../", import.meta.url));
const tgas = (n: number) => BigInt(n) * 10n ** 12n;
const microNear = (n: number) => BigInt(n) * 10n ** 18n;
const milliNear = (n: number) => microNear(n * 1000);

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
async function upload(signer: string, wasm: Buffer, hash: string): Promise<string> {
  const str = (b: Buffer) => Buffer.concat([Buffer.from(new Uint32Array([b.length]).buffer), b]);
  const args = Buffer.concat([
    Buffer.from([0]), str(Buffer.from(`${hash}.wasm`)), Buffer.from([1]), str(Buffer.from("application/wasm")), str(wasm),
  ]);
  const url = `https://test.fastfs.io/${signer}/outlayer.testnet/${hash}.wasm`;
  const served = async () => {
    const r = await fetch(url).catch(() => undefined);
    return r?.ok && createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest("hex") === hash;
  };
  if (await served()) return url;
  const r = await account(signer).signAndSendTransaction({
    receiverId: "outlayer.testnet",
    actions: [actions.functionCall("__fastdata_fastfs", args, 1n, 0n)],
    throwOnFailure: false,
    waitUntil: "FINAL",
  });
  console.log(`FastFS upload of ${hash}: tx ${r.transaction.hash}`);
  for (let i = 0; i < 40; i++) {
    if (await served()) return url;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${url} is not served`);
}

const pinned = buildJudge(CONTRACT);
const other = buildJudge(ATTACKER);
const pinnedUrl = await upload(PROTOCOL, pinned.wasm, pinned.hash);
const otherUrl = await upload(PROTOCOL, other.wasm, other.hash);
console.log({ pinned: pinned.hash, other: other.hash });

// The bounty contract, keyless from its first transaction (R2.1, R5.7).
const keys = await provider.viewAccessKeyList({ accountId: CONTRACT });
let deployTx: string | undefined;
if (keys.keys.length > 0) {
  execFileSync("cargo", ["near", "build", "non-reproducible-wasm"], { cwd: join(root, "contract"), stdio: "inherit" });
  const code = readFileSync(join(root, "contract/target/near/bountee_contract.wasm"));
  const config = {
    outlayer: "outlayer.testnet",
    mpc: "v1.signer-prod.testnet",
    usdc: USDC,
    judge_build_hash: `0x${pinned.hash}`,
    judge_wasm_url: pinnedUrl,
    seed: { native: "1000000000000000000", tokens: [] },
  };
  const c = account(CONTRACT);
  const r = await c.signAndSendTransaction({
    receiverId: CONTRACT,
    actions: [
      actions.deployContract(code),
      actions.functionCall("new", { config }, tgas(100), milliNear(12.5)),
      actions.deleteKey(PublicKey.fromString(keys.keys[0]!.public_key)),
    ],
    waitUntil: "FINAL",
  });
  deployTx = r.transaction.hash;
  console.log(`deployed keyless: ${deployTx}`);
}

// A live bounty under the fixture rules (#8's anvil block; #15's minimal judge_claim
// replays without block confirmation, which #14 adds).
const rules = JSON.parse(readFileSync(join(root, "judge/tests/fixtures/rules.json"), "utf8"));
rules.judge_build_hash = `0x${pinned.hash}`;
rules.end_date_ns = String(BigInt(Date.now() + 30 * 86400_000) * 1_000_000n);
const name = process.env.BOUNTY_NAME ?? "sealing";
let postTx: string | undefined;
const existing = await view(CONTRACT, "bounty", { id: { protocol: PROTOCOL, name } }).catch(() => null);
if (!existing) {
  const p = account(PROTOCOL);
  const fees = await view(CONTRACT, "fees");
  await p.callFunction({ contractId: CONTRACT, methodName: "prepay_posting_fee", args: {}, deposit: BigInt(fees.posting_fee) + milliNear(10), gas: tgas(30) });
  await p.callFunction({ contractId: USDC, methodName: "storage_deposit", args: { account_id: CONTRACT }, deposit: milliNear(12.5), gas: tgas(30) }).catch(() => {});
  const r = await p.signAndSendTransaction({
    receiverId: USDC,
    actions: [actions.functionCall("ft_transfer_call", { receiver_id: CONTRACT, amount: rules.bounty_amount, msg: JSON.stringify({ name, rules }) }, tgas(270), 1n)],
    waitUntil: "FINAL",
  });
  postTx = r.transaction.hash;
  await txStatus(postTx, PROTOCOL);
  console.log(`posted: ${postTx}`, await view(CONTRACT, "bounty", { id: { protocol: PROTOCOL, name } }).then((b) => b?.state));
}

await account(WHITEHAT).callFunction({ contractId: CONTRACT, methodName: "top_up_claim_balance", args: {}, deposit: milliNear(200), gas: tgas(30) });

const deployment = {
  contract: CONTRACT,
  protocol: PROTOCOL,
  bounty: `${PROTOCOL}/${name}`,
  whitehat: WHITEHAT,
  attacker: ATTACKER,
  pinned_judge: { hash: pinned.hash, url: pinnedUrl },
  other_judge: { hash: other.hash, url: otherUrl },
  deploy_tx: deployTx,
  post_tx: postTx,
};
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(deployment, null, 2) + "\n", { mode: 0o600 });
console.log(`wrote ${OUT}`, deployment);
