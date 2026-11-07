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
// $BOUNTEE_DAY3 (default ~/.bountee-testnet/day3-deployment.json) from `testnet/deploy-system.ts`, the
// Protocol's and attacker's keys in ~/.near-credentials/testnet, and the Base Sepolia
// deployer in ~/.bountee-testnet/base-sepolia-deployer.env. WHITEHAT=<account> uses an
// existing account instead of `init` (when NEAR's faucet is rate-limited); INSTANCE=<file> reuses
// an unclaimed instance fresh-instance.ts wrote, after a failure past that step. Every transaction
// hash is written to ~/.bountee-testnet/day3-evidence.json. The PAYS claim runs with `--no-verify`:
// verifying its pause on NEAR waits for Base Sepolia's safe head (R7.10, verify-pause-testnet.test.ts).
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
const copiedExploit = fileURLToPath(new URL("./testnet/copied-exploit.ts", import.meta.url));
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
  // The file fresh-instance.ts reads too, so the bounty is posted on the contract this test checks.
  const deploymentFile = process.env.BOUNTEE_DAY3 ?? join(home, ".bountee-testnet", "day3-deployment.json");
  const deployment = RUN ? JSON.parse(readFileSync(deploymentFile, "utf8")) : {};
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
      const r = await run(process.execPath, [freshInstance], { WHITEHAT: whitehat, CLAIMS: "3", BOUNTEE_DAY3: deploymentFile });
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
    const r = await bountee([...claimArgs("Exploit.s.sol"), "--no-verify", "--timeout", "600"], { VAULT: instance.vault });
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const out = JSON.parse(r.stdout);
    paysClaim = out;
    record("R3.10 PAYS claim", { claim_id: out.claim_id, tx: out.tx_hash, sign_pauses_tx: out.sign_pauses_tx });
    expect(out.local_verdict).toStrictEqual({ outcome: "PAYS", reason: "minimum_theft_reached" });
    expect(out.verdict).toStrictEqual(out.local_verdict); // D2
    const id = { protocol: instance.protocol, name: instance.name };
    let bounty = await near.view(contract, "bounty", { id });
    // R2.6's earlier no-verdict claim holds its place for `claim_place_hold_ns` (R3.6), so the
    // payout waits until then; afterwards anyone retries it through the tool.
    let retryTx: string | undefined;
    if (bounty.state === "paying" && bounty.payout_waits_until_ns) {
      const waitMs = Number(BigInt(bounty.payout_waits_until_ns) / 1_000_000n) - Date.now() + 20_000;
      record("R3.6 payout waits for the earlier claim until", new Date(Number(BigInt(bounty.payout_waits_until_ns) / 1_000_000n)).toISOString());
      if (waitMs > 0) await new Promise((res) => setTimeout(res, waitMs));
      const retried = await bountee(["retry-payout", instance.bounty, "--contract", contract, "--as", whitehat, "--json"]);
      expect(retried.code, retried.stderr || retried.stdout).toBe(0);
      retryTx = JSON.parse(retried.stdout).tx_hash;
      record("R3.10 retry-payout tx", retryTx);
      bounty = await near.view(contract, "bounty", { id });
    }
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
    for (const tx of [out.sign_pauses_tx, retryTx]) {
      if (tx) paid += events(await near.txStatus(tx, whitehat)).filter((e) => e.event === "bounty_paid").length;
    }
    expect(paid).toBe(1);
  }, 5_400_000);

  test("R5.2: the PAYS claim's sealed exploit, copied and sent straight to OutLayer, is refused", async () => {
    expect(paysClaim).toBeDefined();
    // The same driver #35 runs on mainnet (testnet/copied-exploit.ts), signed by the attacker.
    const r = await run(process.execPath, [copiedExploit], {
      CONTRACT: contract, CLAIM: String(paysClaim!.claim_id), CLAIM_TX: paysClaim!.tx_hash, SIGNER: ATTACKER,
    });
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1) || "{}");
    record("R5.2 direct job on the contract's secret", out.direct_job?.tx);
    record("R5.2 copy stored under the attacker", out.copy_stored);
    record("R5.2 job on the copy", out.job_on_copy?.tx);
    expect(r.code, `${r.stderr}\n${r.stdout}`).toBe(0);
    expect(out.outlayer).toBe("outlayer.testnet");
    expect(out.direct_job).toMatchObject({ refused: true, verdict: false });
    expect(out.job_on_copy).toMatchObject({ refused: true, verdict: false });
  }, 600_000);
});
