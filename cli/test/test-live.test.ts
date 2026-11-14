// Seam T, ticket #11: `bountee test` against the proof chain as it is now.
//
// One live run on Base Sepolia: the Whitehat's Foundry script (a harmless 0-USDC transfer
// into Circle's test USDC, so ZERO) is run by `bountee test` on a fork at a recent block,
// and the tests check what it printed and saved against the chain, read back with `cast`,
// and against the compiled judge run by hand on the saved inputs.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";
import { proofRpcs } from "../src/chains.ts";
import { judgeWasm, type JudgeUsed } from "../src/test.ts";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/usdc-zero/", import.meta.url));
/** The checkout's default judge build, as the tool runs it. */
let wasm: string;
const PUBLIC_RPCS = proofRpcs(84532);
const PUBLIC_RPC = PUBLIC_RPCS[0]!;
const USDC = "0x036cbd53842c5426634e7929541ec2318f3dcf7e";
const KECCAK_EMPTY = "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470";

function bountee(args: string[]) {
  const res = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 600_000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function cast(args: string[]) {
  const res = spawnSync("cast", [...args, "--rpc-url", PUBLIC_RPC], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`cast ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

let out: {
  verdict: { outcome: string; reason: string };
  block: { chain_id: number; number: number; hash: string };
  attacker: string;
  rpc: string;
  saved: string;
  judge: JudgeUsed;
};
let latestBefore: number;
let code: number | null;
let stderr: string;

beforeAll(() => {
  wasm = judgeWasm();
  latestBefore = Number(cast(["block-number"]));
  const dir = mkdtempSync(join(tmpdir(), "bountee-test-"));
  const res = bountee([
    "test",
    `${fixture}script/Harmless.s.sol`,
    "--bounty",
    `${fixture}rules.json`,
    "--out",
    join(dir, "job.json"),
    "--json",
  ]);
  code = res.code;
  stderr = res.stderr;
  out = JSON.parse(res.stdout || "{}");
}, 600_000);

// D3, D2 (local half), R14.5: the script's run scores the verdict the payout rule gives a
// 0-USDC transfer, printed as JSON.
test("D3 D2 R14.5: a harmless Foundry script on live Base Sepolia prints ZERO as JSON", () => {
  expect(code, stderr).toBe(0);
  expect(out.verdict).toStrictEqual({ outcome: "ZERO", reason: "below_minimum_theft" });
});

// D2, R14.5 (#80): live test names the compiled judge it ran by its sha256, and whether that is
// the bounty's pinned build, as `test --job` and `rerun` do.
test("D2 R14.5: live test names the judge build it ran and whether it is the bounty's pinned build", () => {
  const rules = JSON.parse(readFileSync(`${fixture}rules.json`, "utf8"));
  const sha = createHash("sha256").update(readFileSync(wasm)).digest("hex");
  expect(out.judge).toStrictEqual({ wasm, sha256: sha, bounty_build: rules.judge_build_hash, same_as_bounty: `0x${sha}` === rules.judge_build_hash });
});

// R2.9, ADR-0014: the claim's block is a recent one of the real chain, named by its real hash.
test("R2.9: the judged block is recent and its hash is the chain's", () => {
  expect(out.block.number).toBeGreaterThan(latestBefore - 150); // 150 blocks = 300 s on Base
  expect(out.block.number).toBeLessThanOrEqual(latestBefore + 150);
  expect(out.block.hash).toBe(cast(["block", String(out.block.number), "-f", "hash"]).toLowerCase());
});

// D2 (local half), R2.9: what `test` saved is the judge's whole input; the same compiled
// judge, run by hand on it with no RPC, gives the same verdict.
test("D2 R2.9: the compiled judge on the saved inputs gives the verdict test printed", () => {
  const job = readFileSync(out.saved, "utf8");
  const res = spawnSync("wasmtime", ["run", "-S", "http", "--", wasm], { input: job, encoding: "utf8" });
  expect(res.status).toBe(0);
  expect(JSON.parse(res.stdout)).toStrictEqual(out.verdict);
});

// D3: the exploit is the script's broadcast: one call from the fresh account into USDC.
test("D3: the saved exploit is the script's transaction, sent by a fresh account", () => {
  const { replay } = JSON.parse(readFileSync(out.saved, "utf8"));
  expect(replay.exploit.transactions).toHaveLength(1);
  const [tx] = replay.exploit.transactions;
  expect(tx.from).toBe(out.attacker);
  expect(tx.to).toBe(USDC);
  expect(tx.input.slice(0, 10)).toBe("0xa9059cbb"); // transfer(address,uint256)
  expect(cast(["nonce", out.attacker, "--block", String(out.block.number)])).toBe("0");
});

// R4.5, ticket criterion 3: every proof comes from an ordinary public RPC, matches the
// chain at the claim's block, and the fresh sender is proven absent.
test("R4.5: the proofs come from a public RPC and match the chain at the claim's block", () => {
  expect(PUBLIC_RPCS).toContain(out.rpc);
  const { replay } = JSON.parse(readFileSync(out.saved, "utf8"));
  const usdc = replay.proofs.find((p: { address: string }) => p.address === USDC);
  const keys = usdc.storage.map((s: { key: string }) => s.key);
  expect(keys.length).toBeGreaterThan(0);
  const chain = JSON.parse(cast(["proof", USDC, ...keys, "--block", String(out.block.number), "--json"]));
  expect(usdc.storage_hash).toBe(chain.storageHash.toLowerCase());
  expect(usdc.storage.map((s: { value: string }) => BigInt(s.value))).toStrictEqual(
    chain.storageProof.map((s: { value: string }) => BigInt(s.value)),
  );
  const sender = replay.proofs.find((p: { address: string }) => p.address === out.attacker);
  expect({ nonce: sender.nonce, balance: sender.balance, code_hash: sender.code_hash }).toStrictEqual({
    nonce: "0",
    balance: "0",
    code_hash: KECCAK_EMPTY,
  });
});

// R14.5: a failure is machine-readable too.
test("R14.5: test with no --bounty fails with a JSON error", () => {
  const res = bountee(["test", `${fixture}script/Harmless.s.sol`, "--json"]);
  expect(res.code).not.toBe(0);
  expect(JSON.parse(res.stderr)).toHaveProperty("error");
});
