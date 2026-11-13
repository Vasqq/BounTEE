// Seam T + analysis, ticket #28: the historical DEPUSDT / LEVUSDC hack replayed offline.
//
// Seams this ticket uses (written before the first test, per the /tdd agreement):
//
//   T (primary) — `node cli/src/main.ts test --job <committed historical job> --json`, spawned
//     inside an OS sandbox that denies all networking (the #9 offline harness). The job is the
//     committed replay of the June 15, 2023 DEPUSDT / LEVUSDC access-control hack against
//     Ethereum mainnet's real pre-hack state at block 17_484_161 (holding ~69,961 USDT and
//     ~36,142 USDC across the two covered proxies), built by fixtures/historical/make-job.ts
//     from a public archive RPC.
//       Catches: criterion 1 — a real-world theft, proven against a real historical block's
//       state root, returns PAYS with no RPC, keys or funds; the committed proofs stand on
//       their own. Also that the score clears the minimum and the covered loss is the drained
//       tokens.
//       Misses: whether the judge treats this exploit specially (that is D11, below); the
//       enclave's own verdict (the live claim pipeline, not this ticket); whether mainnet still
//       matches these proofs today (it need not — the block is fixed historical state).
//
//   Analysis (D11) — the SAME compiled judge that scores the demo scores this independent,
//     third-party exploit against real mainnet addresses, with no judge source change; and
//     judge/src contains none of this hack's addresses or token names. This is one strong
//     witness for D11 (the judge contains nothing specific to any exploit); #10's recorded
//     D11 inspection makes the general argument over all of judge/src.
//       Catches: a real hack the judge has never been told about still scores PAYS through the
//       identical wasm, and the hack's identifiers appear nowhere in the judge.
//       Misses: D11 over every possible exploit (that is the inspection's job, not a test's).
//
// Provenance: the exploit reproduces SunWeb3Sec/DeFiHackLabs
// src/test/2023-06/DEPUSDT_LEVUSDC_exp.sol (Apache-2.0).
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";
import { judgeWasm } from "../src/test.ts";
import { bounteeOffline } from "./offline.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const JOB = fileURLToPath(new URL("./fixtures/historical/depusdt-levusdc.json", import.meta.url));


beforeAll(() => {
  // Build the judge before networking is cut, as a Verifier's checkout would have it.
  judgeWasm();
}, 600_000);

// Criterion 1: the historical exploit, with committed proofs, returns PAYS offline.
test("ticket #28, D19, R2.9, R3.8: the DEPUSDT/LEVUSDC hack replays to PAYS offline", () => {
  const res = bounteeOffline(["test", "--job", JOB, "--json"]);
  expect(res.code, res.stderr).toBe(0);
  const out = JSON.parse(res.stdout);
  expect(out.verdict).toStrictEqual({ outcome: "PAYS", reason: "minimum_theft_reached" });
  expect(out.block.number).toBe(17_484_161);
  expect(out.block.hash).toBe(JSON.parse(readFileSync(JOB, "utf8")).replay.block.hash);
  expect(out.transactions).toBe(4); // approveToken + transferFrom for each of the two proxies
});

// Criterion 2 (D11): the judge needs no change for it. The same build that scores the demo
// scores this real hack, and nothing in judge/src names the hack.
test("ticket #28, D11: the unmodified judge scores the real hack, and judge/src never names it", () => {
  // The committed job pins the demo bounty's judge hash: this is not a judge built for the hack.
  const job = JSON.parse(readFileSync(JOB, "utf8")).replay;
  expect(job.rules.judge_build_hash).toBe("0xc4222111c3523dae3bd7b3002fb63ddf254231bd9f437c497acf4d5962a1df45");

  // D11 analysis: none of the hack's addresses or identifiers appears anywhere in judge/src.
  const needles = [
    "7b190a928aa76eece5cb3e0f6b3bdb24fcdd9b4f", // ProxyDEPUSDT
    "2a2b195558cf89aa617979ce28880bbf7e17bc45", // ProxyLEVUSDC
    "dac17f958d2ee523a2206206994597c13d831ec7", // USDT
    "a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", // USDC
    "approveToken",
    "depusdt",
    "levusdc",
  ];
  const sources: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".rs")) sources.push(readFileSync(p, "utf8").toLowerCase());
    }
  };
  walk(`${repo}judge/src`);
  const blob = sources.join("\n");
  for (const needle of needles) expect(blob.includes(needle.toLowerCase()), `judge/src names ${needle}`).toBe(false);
});
