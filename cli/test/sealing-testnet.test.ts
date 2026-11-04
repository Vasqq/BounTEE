// Seam T, ticket #15 (testnet half): a sealed exploit against real OutLayer testnet and a
// keyless bounty contract deployed by `testnet/deploy-sealing.ts`.
//
// Seams (written before the first test): T here catches what OutLayer itself enforces: the
// contract's own job opens the sealed exploit and records only a coarse verdict (R5.5); a
// copied sealed exploit sent straight to OutLayer by another account is refused (R5.2);
// another judge build can't open it (R5.3). The claim is a live one on Base Sepolia, made
// by `bountee test` (#11) moments before it is filed, so the enclave confirms its block
// (#14). It misses live progress and the receipt (#16).
//
// Runs only when BOUNTEE_TESTNET_SEALING names the deployment file (it spends testnet
// NEAR and needs the accounts' keys in ~/.near-credentials/testnet). Every transaction hash
// is printed as the run's evidence.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actions } from "near-api-js";
import { beforeAll, describe, expect, test } from "vitest";
import { Near } from "../src/near.ts";

const near = new Near("testnet", process.env.NEAR_TESTNET_RPC);

const deploymentFile = process.env.BOUNTEE_TESTNET_SEALING;
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const harmless = fileURLToPath(new URL("./fixtures/usdc-zero/script/Harmless.s.sol", import.meta.url));
const tgas = (n: number) => BigInt(n) * 10n ** 12n;
const milliNear = (n: number) => BigInt(n) * 10n ** 21n;

function bountee(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

describe.skipIf(!deploymentFile)("sealing on OutLayer testnet", () => {
  const d = deploymentFile ? JSON.parse(readFileSync(deploymentFile, "utf8")) : {};
  let exploit: any;
  let evidence: any;
  const evidenceLog: Record<string, string> = {};
  let claimId = 0;
  let claimTx = "";
  let copied = ""; // the sealed exploit as anyone reads it from the claim's transaction
  let input = ""; // the claim's job input as anyone reads it from the chain

  /** Run a job straight on OutLayer as the attacker; return the whole outcome. */
  async function attackerJob(label: string, judge: { hash: string; url: string }, secretsRef: object) {
    const r = await near.account(d.attacker).signAndSendTransaction({
      receiverId: "outlayer.testnet",
      actions: [
        actions.functionCall(
          "request_execution",
          {
            source: { WasmUrl: { url: judge.url, hash: judge.hash, build_target: "wasm32-wasip2" } },
            resource_limits: { max_instructions: 100_000_000_000, max_memory_mb: 512, max_execution_seconds: 60 },
            input_data: input,
            secrets_ref: secretsRef,
            response_format: "Json",
            payer_account_id: null,
            params: null,
          },
          tgas(300),
          // As the bounty contract pays: the job, plus OutLayer's hold on input above 32 KiB.
          milliNear(20) + BigInt(Math.max(0, Buffer.byteLength(input) - 32 * 1024)) * 10n ** 19n,
        ),
      ],
      throwOnFailure: false,
      waitUntil: "FINAL",
    });
    evidenceLog[label] = r.transaction.hash;
    console.log(`${label}: ${r.transaction.hash}`);
    return near.txStatus(r.transaction.hash, d.attacker);
  }

  /** The attacker files the copied ciphertext as its own secret, open to anyone. */
  async function plantCopy(label: string, judgeHash: string, profile: string) {
    const r = await near.account(d.attacker).signAndSendTransaction({
      receiverId: "outlayer.testnet",
      actions: [
        actions.functionCall(
          "store_secrets",
          { accessor: { WasmHash: { hash: judgeHash } }, profile, encrypted_secrets_base64: copied, access: "AllowAll", vault_id: null },
          tgas(50),
          milliNear(100),
        ),
      ],
      waitUntil: "FINAL",
    });
    evidenceLog[label] = r.transaction.hash;
    console.log(`${label}: ${r.transaction.hash}`);
  }

  /** No verdict came out of the job: it was refused or failed. */
  function noVerdict(status: any): string {
    const all = JSON.stringify(status);
    const logs = status.receipts_outcome.flatMap((o: any) => o.outcome.logs).join(" | ");
    evidenceLog[`${status.transaction.hash} outcome`] = `${JSON.stringify(status.status).slice(0, 300)} logs: ${logs.slice(0, 600)}`;
    expect(all).not.toMatch(/\\"outcome\\":\\"(PAYS|ZERO|INVALID)\\"/);
    expect(all).not.toMatch(/"outcome":"(PAYS|ZERO|INVALID)"/);
    return all;
  }

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "bountee-claim-"));
    // A live claim: the bounty's own rules, the harmless script run by `bountee test` at a
    // recent Base Sepolia block, with its proofs.
    const name = d.bounty.split("/")[1];
    const rules = (await near.view(d.contract, "bounty", { id: { protocol: d.protocol, name } })).rules;
    writeFileSync(join(dir, "rules.json"), JSON.stringify(rules));
    const tested = await bountee(["test", harmless, "--bounty", join(dir, "rules.json"), "--out", join(dir, "job.json"), "--json"]);
    expect(tested.code, tested.stderr).toBe(0);
    const job = JSON.parse(readFileSync(join(dir, "job.json"), "utf8")).replay;
    exploit = job.exploit;
    evidence = { block: job.block, header: job.header, proofs: job.proofs };
    writeFileSync(join(dir, "exploit.json"), JSON.stringify(exploit));
    writeFileSync(join(dir, "evidence.json"), JSON.stringify(evidence));
    const { code, stdout, stderr } = await bountee([
      "claim", "--contract", d.contract, "--bounty", d.bounty, "--as", d.whitehat,
      "--exploit", join(dir, "exploit.json"), "--evidence", join(dir, "evidence.json"), "--json",
    ]);
    expect(code, stderr).toBe(0);
    const out = JSON.parse(stdout);
    claimId = out.claim_id;
    claimTx = out.tx_hash;
    evidenceLog.claim = claimTx;
    writeFileSync(`${deploymentFile}.evidence.json`, JSON.stringify({ claim_id: claimId, ...evidenceLog }, null, 2) + "\n");
    console.log(`claim ${claimId}: ${claimTx}`);
    const status = await near.txStatus(claimTx, d.whitehat);
    const args = JSON.parse(Buffer.from(status.transaction.actions[0].FunctionCall.args, "base64").toString("utf8"));
    copied = args.sealed_exploit;
    const claim = await near.view(d.contract, "claim", { claim_id: claimId });
    input = JSON.stringify({ judge_claim: {
      rules,
      bounty: claim.bounty, whitehat: d.attacker, block: claim.block, header: claim.header,
      proofs_json: JSON.stringify(evidence.proofs), submitted_at_ns: claim.submitted_at_ns,
    } });
  }, 240_000);

  test("R5.5, R5.1: the bounty contract's own job opens the sealed exploit; a ZERO claim records only its coarse reason, with no plaintext on chain", async () => {
    let claim: any;
    for (let i = 0; i < 40; i++) {
      claim = await near.view(d.contract, "claim", { claim_id: claimId });
      if (claim.state !== "storing" && claim.state !== "judging") break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    expect(claim.state).toBe("judged");
    expect(claim.verdict).toStrictEqual({ outcome: "ZERO", reason: "below_minimum_theft" });
    const onChain = JSON.stringify(await near.txStatus(claimTx, d.whitehat)) + JSON.stringify(claim);
    // No transaction's calldata appears (its sender's absence proof is public by design).
    for (const tx of exploit.transactions) expect(onChain).not.toContain(tx.input.slice(2));
  }, 240_000);

  test("R5.2: the copied sealed exploit, sent straight to OutLayer by another account with the pinned build, is refused", async () => {
    const direct = noVerdict(await attackerJob("R5.2 direct job, pinned build, contract's secret", d.pinned_judge, { profile: `c${claimId}`, account_id: d.contract }));
    expect(direct).toMatch(/Access denied/i);

    await plantCopy("R5.2 copy filed under the attacker", d.pinned_judge.hash, `copy${claimId}`);
    const copy = noVerdict(await attackerJob("R5.2 job on the copy", d.pinned_judge, { profile: `copy${claimId}`, account_id: d.attacker }));
    expect(copy).toMatch(/decrypt/i);
  }, 300_000);

  test("R5.3: another judge build can't open it, even one whose own checks the attacker passes", async () => {
    const other = noVerdict(await attackerJob("R5.3 other build, contract's secret", d.other_judge, { profile: `c${claimId}`, account_id: d.contract }));
    expect(other).not.toContain(exploit.transactions[0].input.slice(2));

    await plantCopy("R5.3 copy filed under the other build", d.other_judge.hash, `copy2${claimId}`);
    const copy = noVerdict(await attackerJob("R5.3 other build on the copy", d.other_judge, { profile: `copy2${claimId}`, account_id: d.attacker }));
    expect(copy).toMatch(/decrypt/i);
    // The run's evidence, kept beside the deployment file.
    writeFileSync(`${deploymentFile}.evidence.json`, JSON.stringify({ claim_id: claimId, ...evidenceLog }, null, 2) + "\n");
  }, 300_000);
});
