// Seam T, ticket #16: the Day-3 checkpoint, the core loop end to end on NEAR testnet and Base
// Sepolia, driven only through the committed scripts and the `bountee` command line; chain
// state is read back with `cast` and NEAR RPC.
//
//   fresh instance + posted bounty (D21) -> `bountee init` Whitehat (D18)
//   -> a cheat claimed through the tool: ZERO, nothing moves (R4.11, D2)
//   -> a job that can't confirm its block: claim pending in its place, no verdict (R2.6)
//   -> the real demo exploit claimed through the tool: PAYS, paid exactly once, vault paused
//      (R3.10, D2, R7.4)
//   -> its sealed exploit copied and sent straight to OutLayer: refused (R5.2)
//
// Runs only with BOUNTEE_DAY3_RUN=1 (it spends testnet NEAR and Base Sepolia ETH). Needs
// ~/.bountee-testnet/day3-deployment.json from `testnet/deploy-system.ts`, the
// Protocol's and attacker's keys in ~/.near-credentials/testnet, and the Base Sepolia
// deployer in ~/.bountee-testnet/base-sepolia-deployer.env. WHITEHAT=<account> uses an
// existing account instead of `init` (when NEAR's faucet is rate-limited); INSTANCE=<file> reuses
// an unclaimed instance fresh-instance.ts wrote, after a failure past that step. Every transaction
// hash is written to ~/.bountee-testnet/day3-evidence.json.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { actions } from "near-api-js";
import { describe, expect, test } from "vitest";
import { ensureClaimBalance } from "../src/claim-flow.ts";
import { Near, events, milliNear, tgas } from "../src/near.ts";
import { defaultRpc } from "../src/chains.ts";
import { withNumber } from "./testnet/header.ts";

const RUN = process.env.BOUNTEE_DAY3_RUN === "1";
const home = homedir();
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const freshInstance = fileURLToPath(new URL("./testnet/fresh-instance.ts", import.meta.url));
const RPC = defaultRpc(84532)!;
const ATTACKER = process.env.ATTACKER ?? "bts1-mallory-1104.testnet";
const evidenceFile = join(home, ".bountee-testnet", "day3-evidence.json");
const evidence: Record<string, unknown> = {};
const record = (k: string, v: unknown) => {
  evidence[k] = v;
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
};
const near = new Near("testnet");
const cast = (...args: string[]) => execFileSync("cast", args, { encoding: "utf8" }).trim();
const uint = (s: string) => BigInt(s.split(" ")[0]!);

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

describe.runIf(RUN)("Day-3 checkpoint on NEAR testnet and Base Sepolia", () => {
  const deployment = RUN ? JSON.parse(readFileSync(join(home, ".bountee-testnet", "day3-deployment.json"), "utf8")) : {};
  const contract: string = deployment.contract;
  const usdc: string = deployment.usdc;
  let instance: any;
  let whitehat = process.env.WHITEHAT ?? "";
  const ft = async (who: string) => BigInt(await near.view<string>(usdc, "ft_balance_of", { account_id: who }));
  const vaultUsdc = () => uint(cast("call", instance.evm_usdc, "balanceOf(address)(uint256)", instance.vault, "--rpc-url", RPC));
  const claimArgs = (script: string) => ["claim", join(repo, "demo/script", script), "--bounty", instance.bounty, "--contract", contract, "--as", whitehat, "--json"];

  test("D21: a script deploys a fresh demo instance (vault, pause-role grant, pause gas) and posts its bounty", async () => {
    // D18 first: the Whitehat the run claims as, so the preflight can check its balance.
    if (!whitehat) {
      const init = await bountee(["init", "--json"]);
      expect(init.code, init.stderr || init.stdout).toBe(0);
      const out = JSON.parse(init.stdout);
      expect(out.funded).toBe(true);
      whitehat = out.account_id;
      record("D18 init account", whitehat);
    }
    if (process.env.INSTANCE) {
      // Re-running after a failure past this step: reuse the unclaimed instance, spend no ETH.
      instance = JSON.parse(readFileSync(process.env.INSTANCE, "utf8"));
    } else {
      const r = await run(process.execPath, [freshInstance], { WHITEHAT: whitehat, CLAIMS: "3" });
      expect(r.code, `${r.stderr}\n${r.stdout}`).toBe(0);
      instance = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    }
    record("D21 instance", { bounty: instance.bounty, vault: instance.vault, pause_role: instance.pause_role });
    record("D21 vault deploy txs", instance.deploy_txs);
    record("D21 pause gas tx", instance.pause_gas_tx);
    record("D21 post tx", instance.post_tx);

    // Read back from the chains, not from the script's report.
    expect(cast("call", instance.vault, "pauser()(address)", "--rpc-url", RPC).toLowerCase()).toBe(instance.pause_role);
    expect(cast("call", instance.vault, "paused()(bool)", "--rpc-url", RPC)).toBe("false");
    expect(BigInt(cast("balance", instance.pause_role, "--rpc-url", RPC))).toBeGreaterThanOrEqual(200_000n * 10n ** 9n);
    expect(vaultUsdc()).toBe(1_000_000n * 10n ** 6n);
    const bounty = await near.view(contract, "bounty", { id: { protocol: instance.protocol, name: instance.name } });
    expect(bounty.state).toBe("live");
    expect(bounty.rules.covered_contracts).toStrictEqual([{ chain_id: 84532, address: instance.vault }]);
    expect((await near.view(contract, "pause_role", { id: bounty.id })).address).toBe(instance.pause_role);
  }, 600_000);

  test("R4.11, D2: a cheat (a fresh account's deposit-then-withdraw) claimed through the tool scores ZERO and moves nothing", async () => {
    const before = { whitehat: await ft(whitehat), contract: await ft(contract), vault: vaultUsdc() };
    // 5,000 test USDC minted, deposited and withdrawn: the account gains more than the
    // minimum theft, but nothing is taken from the covered vault.
    const r = await bountee(claimArgs("HonestUser.s.sol"), { VAULT: instance.vault, AMOUNT: "5000000000" });
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const out = JSON.parse(r.stdout);
    record("R4.11 cheat claim", { claim_id: out.claim_id, tx: out.tx_hash });
    expect(out.local_verdict).toStrictEqual({ outcome: "ZERO", reason: "below_minimum_theft" });
    expect(out.verdict).toStrictEqual(out.local_verdict); // D2
    const claim = await near.view(contract, "claim", { claim_id: out.claim_id });
    expect(claim.verdict).toStrictEqual({ outcome: "ZERO", reason: "below_minimum_theft" });
    expect((await near.view(contract, "bounty", { id: claim.bounty })).state).toBe("live");
    expect(await ft(whitehat)).toBe(before.whitehat);
    expect(await ft(contract)).toBe(before.contract);
    expect(vaultUsdc()).toBe(before.vault);
    expect(events(await near.txStatus(out.tx_hash, whitehat)).map((e) => e.event)).not.toContain("bounty_paid");
  }, 600_000);

  test("R2.6: a job that can't confirm its block keeps the claim pending in its place, with its submission time and no verdict", async () => {
    // A claim whose header hashes correctly and is recent, but names a block Base Sepolia
    // hasn't made yet: no pinned RPC can confirm it, so the job ends without a verdict.
    const tested = await bountee(["test", join(repo, "demo/script/HonestUser.s.sol"), "--bounty", instance.bounty, "--contract", contract, "--json"], { VAULT: instance.vault });
    expect(tested.code, tested.stderr).toBe(0);
    const job = JSON.parse(readFileSync(JSON.parse(tested.stdout).saved, "utf8")).replay;
    const head = Number(cast("block-number", "--rpc-url", RPC));
    const header = withNumber(job.header, head + 1_000_000);
    const block = { number: head + 1_000_000, hash: `0x${Buffer.from(keccak_256(Buffer.from(header.slice(2), "hex"))).toString("hex")}` };
    const { seal } = await import("../src/seal.ts");
    const { KEYSTORE_API } = await import("../src/endpoints.ts");
    const sealed = await seal({ api: KEYSTORE_API.testnet, judgeHash: deployment.judge.hash.startsWith("0x") ? deployment.judge.hash : `0x${deployment.judge.hash}`, bountyContract: contract, whitehat, exploit: job.exploit });
    await ensureClaimBalance(near, contract, whitehat, milliNear(1200));
    const sub = await near.account(whitehat).callFunction({
      contractId: contract,
      methodName: "submit_claim",
      args: { bounty: { protocol: instance.protocol, name: instance.name }, block, header, proofs: JSON.stringify(job.proofs), sealed_exploit: sealed },
      gas: tgas(300),
      deposit: 0n,
    });
    const claimId = Number(sub);
    const before = await near.view(contract, "claim", { claim_id: claimId });
    let claim = before;
    for (let i = 0; i < 60 && (claim.state === "storing" || claim.state === "judging"); i++) {
      await new Promise((r) => setTimeout(r, 3000));
      claim = await near.view(contract, "claim", { claim_id: claimId });
    }
    record("R2.6 failed-job claim", { claim_id: claimId, state: claim.state, submitted_at_ns: claim.submitted_at_ns });
    expect(claim.state).toBe("no_verdict");
    expect(claim.verdict).toBeNull();
    expect(claim.submitted_at_ns).toBe(before.submitted_at_ns);
    expect(claim.block).toStrictEqual(block);
    expect((await near.view(contract, "bounty", { id: claim.bounty })).state).toBe("live");
    // The earlier cheat claim is still there before it: the failed one kept its own place.
    expect((await near.view(contract, "claim", { claim_id: claimId - 1 }))?.bounty).toStrictEqual(claim.bounty);
  }, 600_000);

  let paysClaim: { claim_id: number; tx_hash: string; sealed_exploit: string } | undefined;

  test("R3.10, D2, R7.4: the real demo exploit claimed through the tool is paid exactly once, and the vault reads paused", async () => {
    const before = { whitehat: await ft(whitehat), contract: await ft(contract) };
    const r = await bountee(claimArgs("Exploit.s.sol"), { VAULT: instance.vault });
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const out = JSON.parse(r.stdout);
    paysClaim = out;
    record("R3.10 PAYS claim", { claim_id: out.claim_id, tx: out.tx_hash, sign_pauses_tx: out.sign_pauses_tx });
    expect(out.local_verdict).toStrictEqual({ outcome: "PAYS", reason: "minimum_theft_reached" });
    expect(out.verdict).toStrictEqual(out.local_verdict); // D2
    const bounty = await near.view(contract, "bounty", { id: { protocol: instance.protocol, name: instance.name } });
    expect(bounty.state).toBe("paid");
    expect(bounty.winning_claim).toBe(out.claim_id);
    const amount = BigInt(instance.rules.bounty_amount);
    expect(await ft(whitehat)).toBe(before.whitehat + amount);
    expect(await ft(contract)).toBe(before.contract - amount);

    // The pause the tool broadcast landed, from the bounty's pause-role address.
    const pause = out.broadcast.pauses[0];
    record("R7.4 pause tx (Base Sepolia)", pause.tx_hash);
    const receipt = JSON.parse(cast("receipt", pause.tx_hash, "--rpc-url", RPC, "--json"));
    expect(receipt.status).toBe("0x1");
    expect(receipt.from.toLowerCase()).toBe(instance.pause_role);
    expect(cast("call", instance.vault, "paused()(bool)", "--rpc-url", RPC)).toBe("true");

    // Exactly once: the tool won't claim a won bounty, and the contract refuses the same
    // claim filed again directly; nothing more is paid.
    const again = await bountee(claimArgs("Exploit.s.sol"), { VAULT: instance.vault });
    expect(again.code).not.toBe(0);
    expect(again.stderr).toMatch(/has been won/);
    const status = await near.txStatus(out.tx_hash, whitehat);
    const filed = JSON.parse(Buffer.from(status.transaction.actions[0].FunctionCall.args, "base64").toString("utf8"));
    const direct = await near.account(whitehat).signAndSendTransaction({
      receiverId: contract,
      actions: [actions.functionCall("submit_claim", filed, tgas(300), 0n)],
      throwOnFailure: false,
      waitUntil: "FINAL",
    });
    record("R3.10 second claim refused", direct.transaction.hash);
    expect(JSON.stringify(direct.status)).toMatch(/this bounty is closed/);
    expect(await ft(whitehat)).toBe(before.whitehat + amount);
    let paid = events(status).filter((e) => e.event === "bounty_paid").length;
    if (out.sign_pauses_tx) paid += events(await near.txStatus(out.sign_pauses_tx, whitehat)).filter((e) => e.event === "bounty_paid").length;
    expect(paid).toBe(1);
  }, 900_000);

  test("R5.2: the PAYS claim's sealed exploit, copied and sent straight to OutLayer, is refused", async () => {
    expect(paysClaim).toBeDefined();
    const claim = await near.view(contract, "claim", { claim_id: paysClaim!.claim_id });
    const status = await near.txStatus(paysClaim!.tx_hash, whitehat);
    const args = JSON.parse(Buffer.from(status.transaction.actions[0].FunctionCall.args, "base64").toString("utf8"));
    const copied: string = args.sealed_exploit;
    const bounty = await near.view(contract, "bounty", { id: claim.bounty });
    const input = JSON.stringify({ judge_claim: {
      rules: bounty.rules, bounty: claim.bounty, whitehat: ATTACKER, block: claim.block, header: claim.header,
      proofs_json: args.proofs, submitted_at_ns: claim.submitted_at_ns,
    } });
    const judge = { url: deployment.judge.url, hash: deployment.judge.hash.replace(/^0x/, "") };
    const job = async (label: string, secretsRef: object) => {
      const r = await near.account(ATTACKER).signAndSendTransaction({
        receiverId: "outlayer.testnet",
        actions: [actions.functionCall("request_execution", {
          source: { WasmUrl: { url: judge.url, hash: judge.hash, build_target: "wasm32-wasip2" } },
          resource_limits: { max_instructions: 100_000_000_000, max_memory_mb: 512, max_execution_seconds: 60 },
          input_data: input, secrets_ref: secretsRef, response_format: "Json", payer_account_id: null, params: null,
        }, tgas(300), milliNear(20) + BigInt(Math.max(0, Buffer.byteLength(input) - 32 * 1024)) * 10n ** 19n)],
        throwOnFailure: false,
        waitUntil: "FINAL",
      });
      const s = await near.txStatus(r.transaction.hash, ATTACKER);
      const all = JSON.stringify(s);
      record(label, r.transaction.hash);
      expect(all).not.toMatch(/\\?"outcome\\?":\\?"(PAYS|ZERO|INVALID)/);
      return all;
    };
    // The contract's own secret, asked for by another account: OutLayer's access rule refuses.
    expect(await job("R5.2 direct job on the contract's secret", { profile: claim.secret_profile, account_id: contract })).toMatch(/Access denied/i);
    // The ciphertext copied under the attacker's own account: it can't be decrypted there.
    const store = await near.account(ATTACKER).signAndSendTransaction({
      receiverId: "outlayer.testnet",
      actions: [actions.functionCall("store_secrets", {
        accessor: { WasmHash: { hash: judge.hash } }, profile: `d3copy${paysClaim!.claim_id}`, encrypted_secrets_base64: copied, access: "AllowAll", vault_id: null,
      }, tgas(50), milliNear(100))],
      waitUntil: "FINAL",
    });
    record("R5.2 copy stored under the attacker", store.transaction.hash);
    expect(await job("R5.2 job on the copy", { profile: `d3copy${paysClaim!.claim_id}`, account_id: ATTACKER })).toMatch(/decrypt/i);
  }, 600_000);
});
