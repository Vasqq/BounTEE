// Seam T, ticket #27: `bountee test` on the Damn Vulnerable DeFi bounties, offline (D19, R2.9).
//
// Each DVD bounty covers one adapted level (demo/dvd/src/adapted: Truster, Side Entrance,
// Puppet's lending pool, each with BounTEE's standard pause). Its exploit and its cheat ship as
// saved jobs in demo/fixtures/dvd/: the exact judge input `bountee test` wrote when it ran the
// scripts in demo/dvd/script against one local anvil block (made by demo/dvd/make-fixtures.ts),
// with that block's header and proofs. Replayed here with networking denied, as in #9, so a
// test passes only if the verdict needs no RPC, keys or funds.
//
// Catches: each DVD bounty's exploit PAYS and its cheat scores ZERO, offline, from committed
// files. Misses: a live posted DVD bounty (the jobs come from anvil, chain 31337, not Base).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";
import { judgeWasm } from "../src/test.ts";
import { bounteeOffline, RUN_MS } from "./offline.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const job = (name: string) => `${repo}demo/fixtures/dvd/${name}.json`;

beforeAll(() => {
  judgeWasm();
}, 600_000);

const levels = [
  // [job prefix, covered contract the rules name, exploit transactions, cheat transactions]
  ["truster", "PausableTrusterLenderPool", 2, 2],
  ["side-entrance", "PausableSideEntranceLenderPool", 2, 2],
  ["puppet", "PausablePuppetPool", 1, 1],
] as const;

for (const [level, , exploitTxs, cheatTxs] of levels) {
  test(`D19 R2.9: bountee test on the DVD ${level} bounty's exploit returns PAYS offline`, () => {
    const res = bounteeOffline(["test", "--job", job(`${level}-exploit`), "--json"]);
    expect(res.code, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.verdict).toStrictEqual({ outcome: "PAYS", reason: "minimum_theft_reached" });
    expect(out.transactions).toBe(exploitTxs);
  }, RUN_MS);

  test(`D19 R4.2: bountee test on the DVD ${level} bounty's cheat returns ZERO offline`, () => {
    const res = bounteeOffline(["test", "--job", job(`${level}-cheat`), "--json"]);
    expect(res.code, res.stderr).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.verdict).toStrictEqual({ outcome: "ZERO", reason: "below_minimum_theft" });
    expect(out.transactions).toBe(cheatTxs);
  }, RUN_MS);
}

// The jobs judge the adapted levels (the bounties), each at the same fixed block, and the
// exploit and cheat of one bounty share its rules.
test("D19 R4.2: each DVD bounty's offline jobs judge its adapted level, its exploit and cheat at one block under one set of rules", () => {
  const made = JSON.parse(readFileSync(`${repo}demo/fixtures/dvd/addresses.json`, "utf8"));
  for (const [level, contract] of levels) {
    const exploit = JSON.parse(readFileSync(job(`${level}-exploit`), "utf8")).replay;
    const cheat = JSON.parse(readFileSync(job(`${level}-cheat`), "utf8")).replay;
    expect(exploit.rules.covered_contracts).toStrictEqual([{ chain_id: 31337, address: made.adapted[contract] }]);
    expect(cheat.rules).toStrictEqual(exploit.rules);
    expect(cheat.block).toStrictEqual(exploit.block);
  }
});
