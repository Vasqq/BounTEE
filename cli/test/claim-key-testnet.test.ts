// Seam T, ticket #25: a Whitehat's claim key for their AI agent, on NEAR testnet. Driven
// through the `bountee` command line; chain state read back with NEAR RPC and `cast`.
//
//   `bountee key add`: a function-call key on the Whitehat's own account, its permission on
//   chain equal to what the tool shows (R14.1)
//   -> each thing the key must not do, signed with it and sent to the network: refused, and
//      nothing about the account changed (R14.3)
//   -> `bountee claim` of the real demo exploit, run as an agent runs it, with only the claim
//      key in its credentials folder: judged by the enclave and paid to the Whitehat (R14.2)
//   -> `bountee key revoke`: the key is gone and a claim signed with it is refused (R14.4)
//
// Runs only with BOUNTEE_T25_RUN=1 (it spends testnet NEAR and Base Sepolia ETH). Needs
// BOUNTEE_DAY3 naming a deployment of this checkout's contract (`testnet/deploy-system.ts`;
// `withdraw_claim_balance` must exist on it), WHITEHAT=<account with ~1.3 NEAR, its full-access
// key in ~/.near-credentials/testnet>, the Protocol's key and the Base Sepolia deployer, as
// fresh-instance.ts says. INSTANCE=<file> reuses an unclaimed instance. Every transaction hash
// goes to ~/.bountee-testnet/t25-evidence.json.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { actions, baseDecode, createTransaction, KeyPair, KeyPairSigner, type KeyPairString } from "near-api-js";
import { defaultRpc } from "../src/chains.ts";
import { CLAIM_KEY_METHODS } from "../src/keys.ts";
import { Near, loadKey, milliNear, tgas } from "../src/near.ts";

const RUN = process.env.BOUNTEE_T25_RUN === "1";
const BASE = 84532;
const home = homedir();
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const freshInstance = fileURLToPath(new URL("./testnet/fresh-instance.ts", import.meta.url));
const evidenceFile = join(home, ".bountee-testnet", "t25-evidence.json");
const evidence: Record<string, unknown> = {};
const record = (k: string, v: unknown) => {
  evidence[k] = v;
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
};
const near = new Near("testnet");
const cast = (...args: string[]) => execFileSync("cast", args, { encoding: "utf8" }).trim();

function run(cmd: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const bountee = (args: string[], env: Record<string, string> = {}) => run(process.execPath, [entry, ...args], env);

/** The account's keys, as the chain lists them. */
async function keys(account: string): Promise<{ public_key: string; access_key: { permission: any } }[]> {
  return (await near.rpc<any>("query", { request_type: "view_access_key_list", finality: "final", account_id: account })).keys;
}

/**
 * Sign `actions` to `receiver` with `key` as `account` and hand them to the network as they
 * are: no client-side check stands between the signed transaction and the node, so a refusal
 * is the network's. Returns the node's answer: the outcome, or the error it gave.
 */
async function sendSigned(account: string, key: KeyPairString, receiver: string, acts: ReturnType<typeof actions.transfer>[]) {
  const pair = KeyPair.fromString(key);
  const publicKey = pair.getPublicKey();
  let nonce = 0n;
  try {
    const ak = await near.rpc<any>("query", { request_type: "view_access_key", finality: "final", account_id: account, public_key: publicKey.toString() });
    nonce = BigInt(ak.nonce);
  } catch {
    // a key the account doesn't hold: the network will say so
  }
  const block = await near.rpc<any>("block", { finality: "final" });
  const tx = createTransaction(account, publicKey, receiver, nonce + 1n, acts, baseDecode(block.header.hash));
  const { signedTransaction } = await new KeyPairSigner(pair).signTransaction(tx);
  const signed = Buffer.from(signedTransaction.encode()).toString("base64");
  try {
    const outcome = await near.rpc<any>("send_tx", { signed_tx_base64: signed, wait_until: "EXECUTED_OPTIMISTIC" });
    return { accepted: true, outcome, error: "" };
  } catch (e) {
    return { accepted: false, outcome: null, error: (e as Error).message };
  }
}

describe.runIf(RUN)("#25: a claim key files claims and does nothing else", () => {
  const deploymentFile = process.env.BOUNTEE_DAY3 ?? join(home, ".bountee-testnet", "t25-deployment.json");
  const deployment = RUN ? JSON.parse(readFileSync(deploymentFile, "utf8")) : {};
  const contract: string = deployment.contract;
  const usdc: string = deployment.usdc;
  const whitehat = process.env.WHITEHAT ?? "";
  // The agent's credentials folder: holds the claim key and nothing else.
  const agentDir = mkdtempSync(join(tmpdir(), "bountee-agent-"));
  let instance: any;
  let added: any;

  test("a fresh demo instance is posted and live", async () => {
    expect(whitehat, "set WHITEHAT").not.toBe("");
    if (process.env.INSTANCE) {
      instance = JSON.parse(readFileSync(process.env.INSTANCE, "utf8"));
    } else {
      const r = await run(process.execPath, [freshInstance], {
        WHITEHAT: whitehat,
        CLAIMS: "1",
        BOUNTEE_DAY3: deploymentFile,
        BOUNTEE_INSTANCE: join(home, ".bountee-testnet", "t25-instance.json"),
      });
      expect(r.code, `${r.stderr}\n${r.stdout}`).toBe(0);
      instance = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    }
    expect(instance.contract).toBe(contract);
    record("contract", contract);
    record("instance", { bounty: instance.bounty, pause_role: instance.pause_role, post_tx: instance.post_tx, chains: instance.chains });
    const bounty = await near.view(contract, "bounty", { id: { protocol: instance.protocol, name: instance.name } });
    expect(bounty.state).toBe("live");
  }, 900_000);

  test("R14.1: `bountee key add` puts a function-call key limited to the claim actions on the Whitehat's account, and shows what it can and can't do", async () => {
    const before = await keys(whitehat);
    const r = await bountee(["key", "add", "--contract", contract, "--as", whitehat, "--out-dir", agentDir, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    added = JSON.parse(r.stdout);
    record("R14.1 key add", added);

    // What the tool shows...
    expect(added.account).toBe(whitehat);
    expect(added.permission.receiver_id).toBe(contract);
    expect(added.permission.method_names).toStrictEqual(CLAIM_KEY_METHODS);
    expect(added.can.length).toBeGreaterThan(0);
    for (const word of [/transfer/i, /withdraw/i, /keys?/i, /other contract/i]) {
      expect(added.cannot.some((c: string) => word.test(c)), `cannot mentions ${word}`).toBe(true);
    }
    // ...is what the chain holds: a FunctionCall key, not a full-access one, on this account.
    const onChain = await near.rpc<any>("query", { request_type: "view_access_key", finality: "final", account_id: whitehat, public_key: added.public_key });
    record("R14.1 view_access_key", onChain.permission);
    expect(onChain.permission).toStrictEqual({
      FunctionCall: { receiver_id: contract, method_names: CLAIM_KEY_METHODS, allowance: added.permission.allowance },
    });
    expect((await keys(whitehat)).length).toBe(before.length + 1);
    // The agent's folder holds the key, for this account, readable only by its owner.
    expect(added.key_file).toBe(join(agentDir, `${whitehat}.json`));
    expect(statSync(added.key_file).mode & 0o777).toBe(0o600);
    const file = JSON.parse(readFileSync(added.key_file, "utf8"));
    expect(file).toMatchObject({ account_id: whitehat, public_key: added.public_key });
    expect(await near.txStatus(added.tx_hash, whitehat)).toBeTruthy();
  }, 120_000);

  test("R14.3: signed with the claim key, the network refuses transfers, withdrawals, keys and every other call", async () => {
    const claimKey = loadKey("testnet", whitehat, agentDir);
    const nearBefore = await near.balance(whitehat);
    const claimBalanceBefore = await near.view<string>(contract, "claim_balance", { account_id: whitehat });
    const usdcBefore = await near.view<string>(usdc, "ft_balance_of", { account_id: whitehat });
    const keysBefore = (await keys(whitehat)).map((k) => k.public_key).sort();

    const attempts: [string, string, ReturnType<typeof actions.transfer>[]][] = [
      ["transfer NEAR", contract, [actions.transfer(1n)]],
      ["withdraw the claim balance (1 yocto)", contract, [actions.functionCall("withdraw_claim_balance", {}, tgas(30), 1n)]],
      ["withdraw the claim balance (no deposit)", contract, [actions.functionCall("withdraw_claim_balance", {}, tgas(30), 0n)]],
      ["top up the claim balance", contract, [actions.functionCall("top_up_claim_balance", {}, tgas(30), milliNear(10))]],
      ["file a claim with a deposit", contract, [actions.functionCall("submit_claim", {}, tgas(30), 1n)]],
      ["add a full-access key", whitehat, [actions.addFullAccessKey(KeyPair.fromRandom("ed25519").getPublicKey())]],
      ["delete the Whitehat's full-access key", whitehat, [actions.deleteKey(KeyPair.fromString(loadKey("testnet", whitehat)).getPublicKey())]],
      ["call another contract (sUSDC ft_transfer)", usdc, [actions.functionCall("ft_transfer", { receiver_id: contract, amount: "1" }, tgas(30), 0n)]],
      ["call another method (prepay_posting_fee)", contract, [actions.functionCall("prepay_posting_fee", {}, tgas(30), 0n)]],
    ];
    const refused: Record<string, string> = {};
    for (const [what, receiver, acts] of attempts) {
      const r = await sendSigned(whitehat, claimKey, receiver, acts);
      refused[what] = r.error.slice(0, 300);
      expect(r.accepted, `${what} was accepted: ${JSON.stringify(r.outcome?.transaction?.hash)}`).toBe(false);
      // The node refused the transaction itself: nothing ran, nothing was charged.
      expect(r.error, what).toMatch(/InvalidTxError|InvalidAccessKeyError|RequiresFullAccess|ReceiverMismatch|MethodNameMismatch|DepositWithFunctionCall|NotEnoughAllowance/);
    }
    record("R14.3 refused", refused);
    expect(await near.balance(whitehat)).toBe(nearBefore);
    expect(await near.view<string>(contract, "claim_balance", { account_id: whitehat })).toBe(claimBalanceBefore);
    expect(await near.view<string>(usdc, "ft_balance_of", { account_id: whitehat })).toBe(usdcBefore);
    expect((await keys(whitehat)).map((k) => k.public_key).sort()).toStrictEqual(keysBefore);
  }, 300_000);

  test("R14.2: a claim the agent files with the claim key is judged like any other and paid to the Whitehat", async () => {
    // The claim key can't top the claim balance up (no deposit): the Whitehat does, once.
    const need = milliNear(1200);
    const have = BigInt(await near.view<string>(contract, "claim_balance", { account_id: whitehat }));
    if (have < need) {
      await near.account(whitehat).callFunction({ contractId: contract, methodName: "top_up_claim_balance", args: {}, deposit: need - have, gas: tgas(30) });
    }
    const usdcBefore = BigInt(await near.view<string>(usdc, "ft_balance_of", { account_id: whitehat }));
    const vault = instance.chains.find((c: any) => c.chain_id === BASE).vault;

    // The agent runs `bountee claim` exactly as a person does; its only key is the claim key.
    const r = await bountee(
      ["claim", join(repo, "demo/script/Exploit.s.sol"), "--bounty", instance.bounty, "--contract", contract, "--as", whitehat, "--no-verify", "--timeout", "900", "--json"],
      { VAULT: vault, BOUNTEE_CREDENTIALS_DIR: agentDir },
    );
    const out = JSON.parse(r.stdout || "{}");
    record("R14.2 claim", { code: r.code, claim_id: out.claim_id, tx: out.tx_hash, verdict: out.verdict, local_verdict: out.local_verdict, paid: out.paid, sign_pauses_tx: out.sign_pauses_tx, broadcast: out.broadcast, stderr: r.stderr.slice(-2000) });
    expect(r.code, r.stderr).toBe(0);

    // Signed by the claim key, filed by the Whitehat's account.
    const tx = await near.txStatus(out.tx_hash, whitehat);
    record("R14.2 claim tx signer", { signer_id: tx.transaction.signer_id, public_key: tx.transaction.public_key });
    expect(tx.transaction.signer_id).toBe(whitehat);
    expect(tx.transaction.public_key).toBe(added.public_key);
    const claim = await near.view(contract, "claim", { claim_id: out.claim_id });
    expect(claim.whitehat).toBe(whitehat);

    // Judged like any other: the enclave's verdict is the local test's.
    expect(out.local_verdict).toStrictEqual({ outcome: "PAYS", reason: "minimum_theft_reached" });
    expect(out.verdict).toStrictEqual(out.local_verdict);
    expect(claim.verdict).toStrictEqual(out.verdict);
    // Paid to the Whitehat's account.
    expect(out.paid).toBe(true);
    const bounty = await near.view(contract, "bounty", { id: { protocol: instance.protocol, name: instance.name } });
    expect(bounty.state).toBe("paid");
    const usdcAfter = BigInt(await near.view<string>(usdc, "ft_balance_of", { account_id: whitehat }));
    record("R14.2 paid", { usdc_before: usdcBefore.toString(), usdc_after: usdcAfter.toString(), amount: bounty.rules.bounty_amount });
    expect(usdcAfter - usdcBefore).toBe(BigInt(bounty.rules.bounty_amount));
    // And the vault is paused, as after any winning claim.
    expect(cast("call", vault, "paused()(bool)", "--rpc-url", defaultRpc(BASE)!)).toBe("true");
  }, 1_200_000);

  test("R14.4: `bountee key revoke` stops the claim key filing claims", async () => {
    const claimKey = loadKey("testnet", whitehat, agentDir);
    const r = await bountee(["key", "revoke", "--as", whitehat, "--out-dir", agentDir, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const revoked = JSON.parse(r.stdout);
    record("R14.4 key revoke", revoked);
    expect(revoked.public_key).toBe(added.public_key);
    expect(revoked.account).toBe(whitehat);
    expect((await keys(whitehat)).map((k) => k.public_key)).not.toContain(added.public_key);
    expect(existsSync(added.key_file)).toBe(false);

    // A claim signed with the revoked key never reaches the contract.
    const r2 = await sendSigned(whitehat, claimKey, contract, [actions.functionCall("submit_claim", {}, tgas(250), 0n)]);
    record("R14.4 claim after revoke", r2.error.slice(0, 300));
    expect(r2.accepted).toBe(false);
    expect(r2.error).toMatch(/AccessKeyNotFound|InvalidAccessKeyError|InvalidTxError/);
  }, 120_000);
});
