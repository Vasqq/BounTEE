#!/usr/bin/env node
// Remake the Damn Vulnerable DeFi fixtures (ticket #27): `node demo/dvd/make-fixtures.ts`.
// Needs anvil, forge, cast, wasmtime and the judge built for its WebAssembly target. The tests
// never run this: they read what it writes, offline (D19, R15.3).
//
// 1. Start anvil and deploy the three levels twice (script/Deploy.s.sol): unmodified, and
//    adapted with a pause role. The claim's block is the last block of setup.
// 2. For each level, run `bountee test` itself, as a Whitehat would, with the exploit script
//    against that block (the rules cover the level's pool; Puppet's Uniswap pool is a
//    dependency), saving its exact judge input with --out:
//    - unmodified: the exploit, to judge/tests/fixtures/dvd/<level>.json (R4.10 rows 22-24);
//    - adapted: the exploit and the cheat, to demo/fixtures/dvd/<level>-{exploit,cheat}.json
//      (the DVD bounties' offline `bountee test`, D19).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { rpc } from "../../cli/src/proofs.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const port = 8549;
const url = `http://127.0.0.1:${port}`;
// anvil's first development account and a stand-in pause-role address; nothing of value.
const deployerKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const pauser = "0x0000000000000000000000000000000000005a05";
const judgeOut = `${repo}judge/tests/fixtures/dvd/`;
const demoOut = `${repo}demo/fixtures/dvd/`;

const wasmTarget = readFileSync(`${repo}judge/wasm-target`, "utf8").trim();
const wasm = `${repo}target/${wasmTarget}/release/bountee-judge.wasm`;

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(cmd, args, { cwd: here, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 << 20 });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${res.stdout}\n${res.stderr}`);
  return res.stdout;
}

const levels = [
  { level: "truster", unmodified: "TrusterLenderPool", adapted: "PausableTrusterLenderPool", script: "Truster" },
  { level: "side-entrance", unmodified: "SideEntranceLenderPool", adapted: "PausableSideEntranceLenderPool", script: "SideEntrance" },
  { level: "puppet", unmodified: "PuppetPool", adapted: "PausablePuppetPool", script: "Puppet" },
];

const anvil = spawn("anvil", ["--port", String(port), "--hardfork", "prague", "--silent"], { stdio: "ignore" });
try {
  for (let i = 0; ; i++) {
    try {
      await rpc(url, "eth_blockNumber", []);
      break;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  run("forge", ["soldeer", "install"]);
  const out = run("forge", ["script", "script/Deploy.s.sol:Deploy", "--rpc-url", url, "--private-key", deployerKey, "--broadcast", "--slow"], { PAUSER: pauser });
  const made: Record<string, Record<string, string>> = { unmodified: {}, adapted: {} };
  for (const m of out.matchAll(/^\s*(unmodified|adapted)\.(\w+) (0x[0-9a-fA-F]{40})$/gm)) made[m[1]!]![m[2]!] = m[3]!.toLowerCase();
  const block = Number(BigInt(await rpc<string>(url, "eth_blockNumber", [])));

  const judgeHash = `0x${createHash("sha256").update(readFileSync(wasm)).digest("hex")}`;
  const rulesFor = (world: "unmodified" | "adapted", pool: string) => ({
    covered_contracts: [{ chain_id: 31337, address: made[world]![pool] }],
    recency_limit_secs: 300,
    // Per smallest unit, in 10^-18 USD: DVT at $1, ETH at $3,000.
    listed_tokens: [
      { chain_id: 31337, token: made[world]!.DamnValuableToken, price: "1" },
      { chain_id: 31337, token: "native", price: "3000" },
    ],
    seed: { native: "1000000000000000000", tokens: [] },
    bounty_amount: "100000000",
    minimum_theft: "1000000000000000000000", // $1,000
    end_date_ns: "1798761600000000000",
    disclosure_delay_days: 30,
    exploit_public_key: "x25519:6W7B3sSYk1p2DZ7FXyRbJWDNiaRfVTj1hm6k8Cqnq6wA",
    judge_build_hash: judgeHash,
  });

  const tmp = mkdtempSync(`${tmpdir()}/bountee-dvd-`);
  const bounteeTest = (world: "unmodified" | "adapted", pool: string, script: string, saveTo: string) => {
    const rules = `${tmp}/${world}-${pool}.json`;
    writeFileSync(rules, JSON.stringify(rulesFor(world, pool)));
    const res = JSON.parse(
      run(
        process.execPath,
        [`${repo}cli/src/main.ts`, "test", `${here}script/${script}`, "--bounty", rules, "--rpc", url, "--block", String(block), "--out", saveTo, "--json"],
        { POOL: made[world]![pool]! },
      ),
    );
    console.log(`${saveTo.replace(repo, "")}: ${res.verdict.outcome} (${res.verdict.reason}), ${res.transactions} tx, ${res.proofs} proofs`);
  };

  mkdirSync(judgeOut, { recursive: true });
  mkdirSync(demoOut, { recursive: true });
  for (const l of levels) {
    bounteeTest("unmodified", l.unmodified, `${l.script}.s.sol:${l.script}Exploit`, `${judgeOut}${l.level}.json`);
    bounteeTest("adapted", l.adapted, `${l.script}.s.sol:${l.script}Exploit`, `${demoOut}${l.level}-exploit.json`);
    bounteeTest("adapted", l.adapted, `${l.script}.s.sol:${l.script}Cheat`, `${demoOut}${l.level}-cheat.json`);
  }
  const addresses = `${JSON.stringify({ about: "Ticket #27: the Damn Vulnerable DeFi levels on the local anvil chain (31337) the jobs were made on, by demo/dvd/make-fixtures.ts.", block, pauser, ...made }, null, 1)}\n`;
  writeFileSync(`${judgeOut}addresses.json`, addresses);
  writeFileSync(`${demoOut}addresses.json`, addresses);
} finally {
  anvil.kill();
}
