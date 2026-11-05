// Seam T, ticket #9: `bountee test` on the demo bounty, offline (D19, R2.9).
//
// The committed demo jobs (demo/fixtures/exploit.json, cheat.json) are the exact judge inputs
// `bountee claim` saved and submitted in #16's live Day-3 run on Base Sepolia (bounty
// bountee-spike4.testnet/demo-202611050342 on day3b.bountee-spike2.testnet): the demo exploit
// at block 54643662 (claim 7, enclave verdict PAYS) and the HonestUser cheat at block 54641451
// (claim 5, enclave verdict ZERO). Each holds the block header and proofs at its fixed block;
// the contract's `claim` view for both shows the same block, header and proofs_sha256.
//
// The tool runs inside an OS sandbox that denies all networking (offline.ts), so a test passes
// only if the verdict needs no RPC, keys or funds.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";
import { bounteeOffline, offline } from "./offline.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const target = readFileSync(`${repo}judge/wasm-target`, "utf8").trim();
const localJudge = `${repo}target/${target}/release/bountee-judge.wasm`;
const EXPLOIT = `${repo}demo/fixtures/exploit.json`;
const CHEAT = `${repo}demo/fixtures/cheat.json`;

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

beforeAll(() => {
  // The judge is built before networking is cut, as a Verifier's checkout would have it.
  const res = spawnSync("cargo", ["build", "--release", "-p", "bountee-judge", "--target", target], {
    cwd: repo,
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(res.stderr);
}, 600_000);

// The control: the sandbox really denies networking, so the tests below can't pass by reaching an RPC.
test("D19 control: a network request fails inside the sandbox", () => {
  const res = offline(process.execPath, [
    "-e",
    "fetch('https://sepolia.base.org',{method:'POST'}).then(()=>process.exit(0),()=>process.exit(7))",
  ]);
  expect(res.code).toBe(7);
});

// D19, R2.9, ticket criterion 1: the demo exploit, replayed from its committed header and
// proofs with no network, pays.
test("D19 R2.9: bountee test on the demo exploit returns PAYS offline", () => {
  const res = bounteeOffline(["test", "--job", EXPLOIT, "--json"]);
  expect(res.code, res.stderr).toBe(0);
  const out = JSON.parse(res.stdout);
  expect(out.verdict).toStrictEqual({ outcome: "PAYS", reason: "minimum_theft_reached" });
  expect(out.block).toStrictEqual({
    number: 54643662,
    hash: JSON.parse(readFileSync(EXPLOIT, "utf8")).replay.block.hash,
  });
});

// Ticket criterion 2, R4.2 (the R4.11 cheat, offline): a fresh account mints test USDC,
// deposits it and withdraws no more than it deposited. Replayed offline, it scores ZERO.
test("D19 R4.2: bountee test on the demo cheat (deposit then withdraw by a fresh account) returns ZERO offline", () => {
  const res = bounteeOffline(["test", "--job", CHEAT, "--json"]);
  expect(res.code, res.stderr).toBe(0);
  const out = JSON.parse(res.stdout);
  expect(out.verdict).toStrictEqual({ outcome: "ZERO", reason: "below_minimum_theft" });
  expect(out.block.number).toBe(54641451);
  expect(out.transactions).toBe(4); // mint, approve, deposit, withdraw
});

// D2 (ticket #9 criterion 3): the verdict comes from the compiled judge the enclave runs. By default
// that is the wasm32-wasip2 release build `cli/test/testnet/deploy.ts` uploads to OutLayer,
// named by its sha256, and the tool says whether it is the bounty's pinned build.
test("D2: test names the compiled judge it ran by its sha256, and whether it is the bounty's pinned build", () => {
  const out = JSON.parse(bounteeOffline(["test", "--job", EXPLOIT, "--json"]).stdout);
  expect(out.judge.wasm).toBe(localJudge);
  expect(out.judge.sha256).toBe(sha256(localJudge));
  // The demo bounty pinned day3b's build (attested by OutLayer for claim 7); a checkout's
  // default build is pinned to another contract, so it is never that exact build.
  expect(out.judge.bounty_build).toBe("0xc4222111c3523dae3bd7b3002fb63ddf254231bd9f437c497acf4d5962a1df45");
  expect(out.judge.same_as_bounty).toBe(false);
});

// D2, R3.9 (ticket #9 criterion 3): the enclave's build (pinned to the demo bounty's contract, built the
// way deploy.ts builds it) passed with --judge gives the same verdicts as the local build.
test("D2 R3.9: the enclave-pinned judge build, passed with --judge, gives the same verdicts offline", () => {
  const dir = `${repo}target/enclave-pinned`;
  const build = spawnSync("cargo", ["build", "--release", "-p", "bountee-judge", "--target", target], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, CARGO_TARGET_DIR: dir, BOUNTEE_BOUNTY_CONTRACT: "day3b.bountee-spike2.testnet" },
  });
  expect(build.status, build.stderr).toBe(0);
  const enclave = `${dir}/${target}/release/bountee-judge.wasm`;
  expect(sha256(enclave)).not.toBe(sha256(localJudge));
  for (const [job, outcome] of [[EXPLOIT, "PAYS"], [CHEAT, "ZERO"]] as const) {
    const res = bounteeOffline(["test", "--job", job, "--judge", enclave, "--json"]);
    expect(res.code, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.verdict.outcome).toBe(outcome);
    expect(out.judge).toMatchObject({ wasm: enclave, sha256: sha256(enclave) });
  }
}, 600_000);
