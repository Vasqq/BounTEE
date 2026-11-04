// Sets up the testnet deployment `sealing-testnet.test.ts` runs against (#15), and writes
// it to $BOUNTEE_TESTNET_SEALING (default ~/.bountee-testnet/sealing-deployment.json):
//
// 1. Builds the judge twice: pinned to the bounty contract (the pinned build, H1) and pinned
//    to the attacker's account (another build, H2, whose caller check the attacker passes),
//    and uploads both wasm files to FastFS.
// 2. Deploys the bounty contract keyless (deploy + new + delete every key, one
//    transaction), pinned to H1, with the USDC stand-in `ft.bountee-spike4.testnet`.
// 3. Posts a bounty on Base Sepolia (`usdc-zero/rules.json`) and tops up the Whitehat's
//    claim balance.
//
// Accounts (keys in ~/.near-credentials/testnet, created with near-cli-rs
// `account create-account sponsor-by-faucet-service`): CONTRACT, PROTOCOL (holds the USDC
// stand-in), WHITEHAT, ATTACKER, all given as env vars.
// Run: node cli/test/testnet/deploy-sealing.ts
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { actions } from "near-api-js";
import { milliNear, tgas } from "../../src/near.ts";
import { buildJudge, contractConfig, deployKeyless, near, root, upload } from "./deploy.ts";

const env = (k: string) => process.env[k] ?? (() => { throw new Error(`set ${k}`); })();
const CONTRACT = env("CONTRACT");
const PROTOCOL = env("PROTOCOL");
const WHITEHAT = env("WHITEHAT");
const ATTACKER = env("ATTACKER");
const USDC = process.env.USDC ?? "ft.bountee-spike4.testnet";
const OUT = process.env.BOUNTEE_TESTNET_SEALING ?? join(homedir(), ".bountee-testnet", "sealing-deployment.json");

const pinned = buildJudge(CONTRACT);
const other = buildJudge(ATTACKER);
const pinnedUrl = (await upload(PROTOCOL, pinned.wasm, pinned.hash)).url;
const otherUrl = (await upload(PROTOCOL, other.wasm, other.hash)).url;
console.log({ pinned: pinned.hash, other: other.hash });

// The bounty contract, keyless from its first transaction (R2.1, R5.7).
const deployTx = await deployKeyless(CONTRACT, contractConfig({ usdc: USDC, judgeHash: pinned.hash, judgeUrl: pinnedUrl }));

// A live bounty on Base Sepolia (#11's harmless-transfer rules), so the enclave confirms
// the claim's block through its pinned RPCs (#14).
const rules = JSON.parse(readFileSync(join(root, "cli/test/fixtures/usdc-zero/rules.json"), "utf8"));
rules.judge_build_hash = `0x${pinned.hash}`;
rules.end_date_ns = String(BigInt(Date.now() + 30 * 86400_000) * 1_000_000n);
const name = process.env.BOUNTY_NAME ?? "sealing";
let postTx: string | undefined;
const existing = await near.view(CONTRACT, "bounty", { id: { protocol: PROTOCOL, name } }).catch(() => null);
if (!existing) {
  const p = near.account(PROTOCOL);
  const fees = await near.view(CONTRACT, "fees");
  await p.callFunction({ contractId: CONTRACT, methodName: "prepay_posting_fee", args: {}, deposit: BigInt(fees.posting_fee) + milliNear(10), gas: tgas(30) });
  await p.callFunction({ contractId: USDC, methodName: "storage_deposit", args: { account_id: CONTRACT }, deposit: milliNear(12.5), gas: tgas(30) }).catch(() => {});
  const r = await p.signAndSendTransaction({
    receiverId: USDC,
    actions: [actions.functionCall("ft_transfer_call", { receiver_id: CONTRACT, amount: rules.bounty_amount, msg: JSON.stringify({ name, rules }) }, tgas(270), 1n)],
    waitUntil: "FINAL",
  });
  postTx = r.transaction.hash;
  await near.txStatus(postTx, PROTOCOL);
  const bounty = await near.view(CONTRACT, "bounty", { id: { protocol: PROTOCOL, name } });
  console.log(`posted: ${postTx}`, bounty?.state);
}

await near.account(WHITEHAT).callFunction({ contractId: CONTRACT, methodName: "top_up_claim_balance", args: {}, deposit: milliNear(200), gas: tgas(30) });

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
