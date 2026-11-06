// Seam T, ticket #21: a winning claim's pause verified on NEAR by the real MPC network, driven
// through `bountee claim`, on NEAR testnet and Base Sepolia; chain state read back with `cast`
// and NEAR RPC views.
//
//   fresh instance + posted bounty (fresh-instance.ts)
//   -> `bountee claim` of the real demo exploit: paid, its pause broadcast (as in #16)
//   -> while the pause has landed but Base Sepolia's safe head hasn't reached it, anyone asks the
//      contract to verify it: the MPC network refuses (times out), nothing is recorded (R7.10)
//   -> `claim` itself waits for the safe head, then requests verification: the contract
//      records the pause verified, from the hash of the pause it stored (R7.3, R7.10)
//   -> the payout happened before any of it (R7.11)
//
// Runs only with BOUNTEE_T21_RUN=1 (it spends testnet NEAR and Base Sepolia ETH, and waits
// for Base Sepolia's safe head: 11-27 minutes). Needs BOUNTEE_DAY3 naming a deployment of this
// contract (`testnet/deploy-system.ts`), WHITEHAT=<account with ~1.2 NEAR>, the Protocol's key,
// and the Base Sepolia deployer in ~/.bountee-testnet/base-sepolia-deployer.env. VERIFIER is
// the "anyone" account (default bountee-spike3.testnet). INSTANCE=<file> reuses an unclaimed
// instance. Every transaction hash goes to ~/.bountee-testnet/t21-evidence.json.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actions } from "near-api-js";
import { beforeAll, describe, expect, test } from "vitest";
import { Near, events, tgas } from "../src/near.ts";
import { defaultRpc } from "../src/chains.ts";

const RUN = process.env.BOUNTEE_T21_RUN === "1";
const home = homedir();
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const freshInstance = fileURLToPath(new URL("./testnet/fresh-instance.ts", import.meta.url));
const RPC = defaultRpc(84532)!;
const VERIFIER = process.env.VERIFIER ?? "bountee-spike3.testnet";
const evidenceFile = join(home, ".bountee-testnet", "t21-evidence.json");
const evidence: Record<string, unknown> = {};
const record = (k: string, v: unknown) => {
  evidence[k] = v;
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
};
const near = new Near("testnet");
const cast = (...args: string[]) => execFileSync("cast", args, { encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

describe.runIf(RUN)("#21: a pause verified on NEAR by the MPC network", () => {
  const deploymentFile = process.env.BOUNTEE_DAY3 ?? join(home, ".bountee-testnet", "t21-deployment.json");
  const deployment = RUN ? JSON.parse(readFileSync(deploymentFile, "utf8")) : {};
  const contract: string = deployment.contract;
  const whitehat = process.env.WHITEHAT ?? "";
  let instance: any;

  // Setup, not a requirement: a fresh demo instance and its bounty, on this contract (D21).
  beforeAll(async () => {
    expect(whitehat, "set WHITEHAT").not.toBe("");
    if (process.env.INSTANCE) {
      instance = JSON.parse(readFileSync(process.env.INSTANCE, "utf8"));
    } else {
      const r = await run(process.execPath, [freshInstance], {
        WHITEHAT: whitehat,
        CLAIMS: "1",
        BOUNTEE_DAY3: deploymentFile,
        BOUNTEE_INSTANCE: join(home, ".bountee-testnet", "t21-instance.json"),
      });
      expect(r.code, `${r.stderr}\n${r.stdout}`).toBe(0);
      instance = JSON.parse(r.stdout.trim().split("\n").at(-1)!);
    }
    expect(instance.contract).toBe(contract);
    record("contract", contract);
    record("instance", { bounty: instance.bounty, vault: instance.vault, pause_role: instance.pause_role, post_tx: instance.post_tx });
    expect(cast("call", instance.vault, "paused()(bool)", "--rpc-url", RPC)).toBe("false");
  }, 600_000);

  test("R7.3, R7.10, R7.11: claim pays, broadcasts, waits for the safe head and has the pause verified; an early request is not", async () => {
    const id = { protocol: instance.protocol, name: instance.name };
    const claiming = run(process.execPath, [entry, "claim", join(repo, "demo/script/Exploit.s.sol"), "--bounty", instance.bounty, "--contract", contract, "--as", whitehat, "--verify-wait", "3600", "--timeout", "3600", "--json"], { VAULT: instance.vault });

    // R7.11: the bounty is paid while no chain's pause is verified, or even asked about.
    let bounty: any;
    for (let i = 0; i < 200; i++) {
      bounty = await near.view(contract, "bounty", { id });
      if (bounty.state === "paid") break;
      await sleep(3000);
    }
    expect(bounty.state).toBe("paid");
    const atPayout = await near.view(contract, "pause_verifications", { id });
    record("R7.11 verifications when paid", atPayout);
    expect(atPayout).toStrictEqual([{ chain_id: 84532, verified: false, verified_pauses: [], attempts: 0, prepaid_attempts_left: 3, verifying: false }]);
    const pause = bounty.signed_pauses[0];

    // The pause lands (claim broadcasts it); then, before the safe head reaches its block,
    // anyone asks for verification: the MPC network doesn't vouch for it.
    let receipt: any = null;
    for (let i = 0; i < 100 && !receipt; i++) {
      try {
        receipt = JSON.parse(cast("receipt", pause.tx_hash, "--rpc-url", RPC, "--json"));
      } catch {
        await sleep(3000);
      }
    }
    expect(receipt?.status).toBe("0x1");
    const landed = Number(receipt.blockNumber);
    const safeThen = Number(JSON.parse(cast("block", "safe", "--rpc-url", RPC, "--json")).number);
    record("pause landed (Base Sepolia)", { tx: pause.tx_hash, block: landed, safe_head_at_early_request: safeThen });
    expect(safeThen).toBeLessThan(landed);
    const fees = await near.view(contract, "fees");
    const early = await near.account(VERIFIER).signAndSendTransaction({
      receiverId: contract,
      actions: [actions.functionCall("verify_pause", { id, chain_id: 84532 }, BigInt(fees.min_verify_pause_gas_base) + BigInt(fees.min_verify_pause_gas_per_pause) + tgas(20), 0n)],
      waitUntil: "INCLUDED_FINAL",
    });
    const earlyStatus = await near.txStatus(early.transaction.hash, VERIFIER, 400);
    record("R7.10 early request (not yet safe)", { tx: early.transaction.hash, events: events(earlyStatus).map((e) => e.event) });
    const requested = events(earlyStatus).find((e) => e.event === "pause_verification_requested");
    // The hash asked about is the stored pause's.
    expect(requested?.data.tx_hashes).toStrictEqual([pause.tx_hash]);
    expect(events(earlyStatus).map((e) => e.event)).toContain("pause_verification_failed");
    const afterEarly = (await near.view(contract, "pause_verifications", { id }))[0];
    expect(afterEarly).toMatchObject({ verified: false, verified_pauses: [], attempts: 1 });

    // claim waits for the safe head, then requests: verified.
    const r = await claiming;
    expect(r.code, r.stderr || r.stdout).toBe(0);
    const out = JSON.parse(r.stdout);
    record("claim", { claim_id: out.claim_id, tx: out.tx_hash, paid: out.paid, pause: out.broadcast?.pauses?.[0]?.tx_hash });
    expect(out.paid).toBe(true);
    const chain = out.verification.chains[0];
    record("R7.3/R7.10 claim's verification", chain);
    expect(chain).toMatchObject({ chain_id: 84532, tx_hashes: [pause.tx_hash], requested: true, verified: true, attempts: 2, landed_block: landed });
    expect(chain.safe_block).toBeGreaterThanOrEqual(landed);
    const done = await near.view(contract, "pause_verifications", { id });
    record("verifications at the end", done);
    expect(done).toStrictEqual([{ chain_id: 84532, verified: true, verified_pauses: [pause.tx_hash], attempts: 2, prepaid_attempts_left: 1, verifying: false }]);
    const verifiedStatus = await near.txStatus(chain.near_tx, whitehat);
    expect(events(verifiedStatus).map((e) => e.event)).toContain("pause_verified");
    // The payout is as it was.
    expect((await near.view(contract, "bounty", { id })).state).toBe("paid");
  }, 4_200_000);
});
