// Seam T, ticket #24 (live half, read-only): `bountee verify` and `bountee build` against NEAR
// testnet, OutLayer testnet and Base Sepolia, with no keys and nothing spent.
// Run: BOUNTEE_VERIFY_RUN=1 [BOUNTEE_T24=~/.bountee-testnet/t24-deployment.json] pnpm --filter @bountee/cli exec vitest run test/verify-testnet.test.ts
//
// Seams (written before the first test; also in the ticket's findings): T here catches R15.1
// against the real services: on t21 (#21's deployment: bounty demo-202611050519, paid to claim
// 0, its Base Sepolia pause landed and verified by the MPC network), the claim's job and payout
// are found from the contract's history alone, the attestation is OutLayer's real Intel-signed
// quote, and the pause is read from Base Sepolia; and R15.2: `bountee build` rebuilds, from the
// commit a fresh keyless deployment names in its NEP-330 metadata, the code hash NEAR shows for
// it and the judge hash it pins. Misses: a live re-run (a disclosure delay is at least a day;
// verify.test.ts re-runs the judge's real publication offline), and another machine's rebuild.
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { Near } from "../src/near.ts";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const T24 = process.env.BOUNTEE_T24 ?? join(homedir(), ".bountee-testnet", "t24-deployment.json");
const near = new Near("testnet");

/**
 * Run the tool from an empty directory. `keyless`: with an empty home too, so no keys and no
 * saved claims exist (the build keeps the real home: rustup, cargo and Docker live there).
 */
function bountee(args: string[], timeout = 120_000, keyless = true) {
  const home = mkdtempSync(join(tmpdir(), "bountee-verify-live-"));
  const res = spawnSync(process.execPath, [entry, ...args, "--json"], {
    encoding: "utf8",
    timeout,
    cwd: home,
    maxBuffer: 64 << 20,
    env: keyless ? { ...process.env, HOME: home, BOUNTEE_CREDENTIALS_DIR: join(home, "none") } : process.env,
  });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr, result: res.stdout ? JSON.parse(res.stdout) : null };
}

const statuses = (r: any) => Object.fromEntries(r.checks.map((c: any) => [c.check, c.status]));
const check = (r: any, name: string) => r.checks.find((c: any) => c.check === name);

describe.skipIf(!process.env.BOUNTEE_VERIFY_RUN)("verify on testnet", () => {
  test("R15.1: a paid bounty's attestation, payout, pause landing and verified record pass live, with no keys or funds", () => {
    // t21 predates the reproducible build, so its own artefacts can't be rebuilt; this test
    // gives verify this checkout's judge and a stand-in contract wasm, and expects those two
    // layers to fail by name (R15.2 is the next test, on a reproducible deployment).
    const dir = mkdtempSync(join(tmpdir(), "bountee-verify-art-"));
    const fake = join(dir, "contract.wasm");
    writeFileSync(fake, "not t21's code");
    const target = readFileSync(join(repo, "judge/wasm-target"), "utf8").trim();
    const judge = join(repo, `target/${target}/release/bountee-judge.wasm`);
    expect(existsSync(judge)).toBe(true);
    const r = bountee([
      "verify", "bountee-spike4.testnet/demo-202611050519", "--contract", "t21.bountee-spike3.testnet",
      "--judge-wasm", judge, "--contract-wasm", fake,
    ]);
    expect(r.result, r.stderr).toMatchObject({ state: "paid", winning_claim: 0 });
    expect(statuses(r.result)).toEqual({
      contract_code: "fail",
      judge_build: "fail",
      attestation: "pass",
      payout: "pass",
      pause_landed: "pass",
      pause_verified: "pass",
      rerun: "not_yet_published",
    });
    // Found from the contract's history alone (no --tx, no saved claim): #21's claim 0.
    expect(check(r.result, "payout").tx_hash).toBe("Dr8wMQ5UciRWq2N2xRLSKGgTgkXQrot4dhvzVJezz8bs");
    expect(check(r.result, "attestation")).toMatchObject({
      transaction_hash: "Dr8wMQ5UciRWq2N2xRLSKGgTgkXQrot4dhvzVJezz8bs",
      wasm_hash: "8a443085820ad19922eb6f04320969bcaff9a97d73b3d9d71698c4c841b2c0d6",
    });
    expect(check(r.result, "pause_landed")).toMatchObject({ tx_hash: "0x24eb1be79293a749ca3695a459db4be89f2fd4e1f18e9c699831d25eebdb6edf", block: 54671065 });
    expect(check(r.result, "judge_build").detail).toMatch(/pins judge 8a443085/);
    expect(r.code).toBe(1);
    console.log(JSON.stringify(r.result, null, 2));
  }, 300_000);

  test.skipIf(!existsSync(T24))("R15.2: the repo's build reproduces the deployed contract's code hash and the judge's pinned hash", async () => {
    const deployment = JSON.parse(readFileSync(T24, "utf8"));
    const contract: string = deployment.contract;
    const meta = await near.view<any>(contract, "contract_source_metadata");
    const rev = /rev=([0-9a-f]{40})/.exec(meta.build_info.source_code_snapshot)![1]!;
    const account = await near.rpc<{ code_hash: string }>("query", { request_type: "view_account", finality: "final", account_id: contract });
    const config = await near.view<any>(contract, "config");
    const keys = await near.rpc<{ keys: unknown[] }>("query", { request_type: "view_access_key_list", finality: "final", account_id: contract });
    expect(keys.keys).toEqual([]); // keyless: the code can't change after this

    const out = mkdtempSync(join(tmpdir(), "bountee-rebuild-"));
    const r = bountee(["build", "--contract", contract, "--rev", rev, "--out-dir", out], 1_800_000, false);
    expect(r.code, r.stderr.slice(-3000)).toBe(0);
    expect(r.result.rev).toBe(rev);
    expect(r.result.contract.code_hash).toBe(account.code_hash);
    expect(`0x${r.result.judge.sha256}`).toBe(config.judge_build_hash);
    // OutLayer serves, under that hash, the bytes the rebuild made.
    const served = Buffer.from(await (await fetch(config.judge_wasm_url)).arrayBuffer());
    expect(served.equals(readFileSync(r.result.judge.wasm))).toBe(true);
    console.log(JSON.stringify({ contract, rev, code_hash: account.code_hash, judge: config.judge_build_hash, build: r.result }, null, 2));
  }, 1_900_000);
});
