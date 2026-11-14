// Seam T, ticket #9 (from #10's finding): the gas each exploit transaction carries.
//
// forge's gas estimate for a deep reentrancy is too low (each call keeps 1/64 of its gas
// back, so the limit a transaction needs is far above the gas it uses). Taken as the
// exploit's gas limit, the replay runs out of gas and a real exploit scores ZERO. This runs
// `bountee test` on a local anvil chain (no network beyond localhost): a Pot holding 1 ETH,
// drained only through a 100-deep reentrancy.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./fixtures/deep-reentry/", import.meta.url));
const POT = "0x00000000000000000000000000000000000b0771";
const CHAIN = 31337;

let anvil: ChildProcess;
let url: string;
let rules: string;
let dir: string;

async function call(method: string, params: unknown[]) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const port = () =>
  new Promise<number>((ok) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => ok(p));
    });
  });

beforeAll(async () => {
  const build = spawnSync("forge", ["build", "--root", fixture], { encoding: "utf8" });
  if (build.status !== 0) throw new Error(build.stderr);
  const code = JSON.parse(readFileSync(`${fixture}out/Pot.sol/Pot.json`, "utf8")).deployedBytecode.object;

  const p = await port();
  url = `http://127.0.0.1:${p}`;
  anvil = spawn("anvil", ["--port", String(p), "--chain-id", String(CHAIN), "--silent"], { stdio: "ignore" });
  for (let i = 0; ; i++) {
    try {
      await call("eth_blockNumber", []);
      break;
    } catch (e) {
      if (i > 100) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await call("anvil_setCode", [POT, code]);
  await call("anvil_setBalance", [POT, "0xde0b6b3a7640000"]); // 1 ETH
  await call("anvil_mine", ["0x5"]);

  dir = mkdtempSync(join(tmpdir(), "bountee-gas-"));
  rules = join(dir, "rules.json");
  writeFileSync(
    rules,
    JSON.stringify({
      covered_contracts: [{ chain_id: CHAIN, address: POT }],
      recency_limit_secs: 300,
      listed_tokens: [{ chain_id: CHAIN, token: "native", price: "1" }],
      seed: { native: "1000000000000000000", tokens: [] },
      bounty_amount: "1000000",
      minimum_theft: "500000000000000000",
      end_date_ns: "1794268800000000000",
      disclosure_delay_days: 30,
      exploit_public_key: "x25519:6W7B3sSYk1p2DZ7FXyRbJWDNiaRfVTj1hm6k8Cqnq6wA",
      judge_build_hash: "0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
    }),
  );
}, 300_000);

afterAll(() => anvil?.kill());

// D3, D2 (local half): a real exploit whose gas forge under-estimates still pays; the
// exploit's transactions carry enough gas for the replay, not forge's estimate.
test("D3 D2: a deep-reentrancy exploit that drains the pot PAYS, whatever forge estimates its gas at", () => {
  const res = spawnSync(
    process.execPath,
    [entry, "test", `${fixture}script/Dig.s.sol`, "--bounty", rules, "--rpc", url, "--out", join(dir, "job.json"), "--json"],
    { encoding: "utf8", timeout: 300_000, env: { ...process.env, POT } },
  );
  expect(res.status, res.stderr).toBe(0);
  expect(JSON.parse(res.stdout).verdict).toStrictEqual({ outcome: "PAYS", reason: "minimum_theft_reached" });
}, 300_000);
