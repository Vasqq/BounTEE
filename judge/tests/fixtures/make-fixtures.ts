#!/usr/bin/env node
// Remake the judge's committed fixtures (ticket #8): `node judge/tests/fixtures/make-fixtures.ts`.
// Needs anvil, forge, wasmtime and the judge built for its WebAssembly target. The seam J
// tests never run this: they read the files it writes, offline (R15.3).
//
// 1. Start anvil and deploy the fixture chain (chain/src/Fixture.sol): a token and two
//    buggy vaults. The claim's block is the block after setup.
// 2. Dry-run each exploit script (chain/script/Fixture.s.sol) and turn its broadcast log
//    into the judge's exploit format: exploits/<name>.json.
// 3. Fetch, with cli/src/proofs.ts, the header and every proof each replay reads under
//    rules.json, and write their union to state.json: { block, header, proofs }.
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AccountProof } from "@bountee/formats";
import { collectReplay, exploitFromBroadcast, parseRules, rpc } from "../../../cli/src/proofs.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const chainDir = `${here}chain`;
const port = 8547;
const url = `http://127.0.0.1:${port}`;
// anvil's first two well-known development accounts; nothing of value.
const deployerKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const treasury = "0x70997970c51812dc3a224c62b88e8f8de8b57a35";
const exploits = ["drain", "viaContract", "seedOnly", "existingSender"];

const wasmTarget = readFileSync(`${repo}judge/wasm-target`, "utf8").trim();
const wasm = `${repo}target/${wasmTarget}/release/bountee-judge.wasm`;

function run(cmd: string, args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(cmd, args, { cwd: chainDir, encoding: "utf8", env: { ...process.env, ...env } });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")}\n${res.stdout}\n${res.stderr}`);
  return res.stdout;
}

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
  run("forge", ["script", "script/Fixture.s.sol:Setup", "--rpc-url", url, "--broadcast", "--slow"], {
    DEPLOYER_KEY: deployerKey,
  });
  const block = Number(BigInt(await rpc<string>(url, "eth_blockNumber", [])));
  const created = (n: number) => run("cast", ["compute-address", "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", "--nonce", String(n)]).trim().split(/\s+/).pop()!.toLowerCase();
  const [token, vault1, vault2] = [created(0), created(1), created(2)];
  const env = { DEPLOYER_KEY: deployerKey, TOKEN: token, VAULT_1: vault1, VAULT_2: vault2, TREASURY: treasury };

  const rules = parseRules(JSON.parse(readFileSync(`${here}rules.json`, "utf8")));
  const proofs = new Map<string, AccountProof>();
  for (const name of exploits) {
    run("forge", ["script", "script/Fixture.s.sol:Exploits", "--sig", `${name}()`, "--rpc-url", url], env);
    const log = JSON.parse(readFileSync(`${chainDir}/broadcast/Fixture.s.sol/31337/dry-run/${name}-latest.json`, "utf8"));
    const exploit = exploitFromBroadcast(log);
    writeFileSync(`${here}exploits/${name}.json`, `${JSON.stringify(exploit, null, 2)}\n`);
    const { replay, verdict, stderr } = await collectReplay({ rpc: url, block, rules, exploit, wasm });
    if (stderr) console.log(stderr.trim());
    console.log(name, JSON.stringify(verdict), `${replay.proofs.length} proofs`);
    for (const p of replay.proofs) {
      const have = proofs.get(p.address);
      const storage = [...(have?.storage ?? []), ...p.storage.filter((s) => !have?.storage.some((h) => h.key === s.key))];
      proofs.set(p.address, { ...p, storage: storage.sort((a, b) => a.key.localeCompare(b.key)) });
    }
    if (name === exploits.at(-1)) {
      const state = {
        about: "Ticket #8 judge fixture, made by make-fixtures.ts on anvil: the claim's block, its RLP header, and proofs of every account and slot the fixture exploits read under rules.json.",
        addresses: { token, vault1, vault2, treasury },
        block: replay.block,
        header: replay.header,
        proofs: [...proofs.values()].sort((a, b) => a.address.localeCompare(b.address)),
      };
      writeFileSync(`${here}state.json`, `${JSON.stringify(state, null, 1)}\n`);
    }
  }
} finally {
  anvil.kill();
}
