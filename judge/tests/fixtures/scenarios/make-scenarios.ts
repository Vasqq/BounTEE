#!/usr/bin/env node
// Remake the judge's scenario fixtures (ticket #10): `node judge/tests/fixtures/scenarios/make-scenarios.ts`.
// Needs anvil, forge, cast, wasmtime and the judge built for its WebAssembly target. The
// seam J tests never run this: they read the files it writes, offline (R15.3).
//
// 1. Start anvil and deploy the scenario chain (chain/script/Scenarios.s.sol:Setup): the
//    demo protocol beside one small contract per R4.10 scenario. The claim's block is the
//    last block of setup.
// 2. Dry-run each exploit script into the judge's exploit format (exploits/<name>.json);
//    the two whose transaction reverts are written here directly.
// 3. Fetch, with cli/src/proofs.ts, the header and every proof each replay reads, with
//    every scenario contract covered and every token listed (so any narrower rules read
//    less), and write their union to state.json.
// 4. The owner patches the second patchable vault (chain/script:LateFix); write the
//    proofs of `lateFix` at that later block to state-later.json (row 16, row 20).
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { AccountProof, Exploit } from "@bountee/formats";
import { collectReplay, exploitFromBroadcast, parseRules, rpc } from "../../../../cli/src/proofs.ts";

const here = fileURLToPath(new URL(".", import.meta.url));
const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const chainDir = `${here}chain`;
const port = 8548;
const url = `http://127.0.0.1:${port}`;
// anvil's first two well-known development accounts; nothing of value.
const deployerKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const treasury = "0x70997970c51812dc3a224c62b88e8f8de8b57a35";
const scripted = [
  "honest", "ownerImpersonation", "sweep", "swap", "liquidate", "arbitrage", "flashLoan",
  "reentrancySwept", "reentrancyKept", "mintOnly", "mintSwapCovered", "mintSellPool",
  "approvalTheft", "freeze", "inflation", "lateFix", "demoExploit", "demoExploitAndPump",
  "honestCoverAll",
];

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
  run("forge", ["script", "script/Scenarios.s.sol:Setup", "--rpc-url", url, "--broadcast", "--slow"], {
    DEPLOYER_KEY: deployerKey,
    TREASURY: treasury,
  });
  const block = Number(BigInt(await rpc<string>(url, "eth_blockNumber", [])));

  // Each deployed contract's address, by name, in deployment order.
  const setupLog = JSON.parse(readFileSync(`${chainDir}/broadcast/Scenarios.s.sol/31337/run-latest.json`, "utf8"));
  const deployed: Record<string, string[]> = {};
  for (const t of setupLog.transactions) {
    if (t.transactionType === "CREATE") (deployed[t.contractName] ??= []).push(t.contractAddress.toLowerCase());
  }
  const one = (name: string, i = 0) => deployed[name]![i]!;
  const fresh = run("cast", ["wallet", "address", "--private-key", `0x${"0".repeat(61)}b0b`]).trim().toLowerCase();
  const addresses = {
    usdc: one("MockUSDC"), demo: one("DemoVault"), pt: one("BuggyToken"), guarded: one("GuardedVault"),
    usdcPool: one("Pool", 0), cheapPool: one("Pool", 1), ptPool: one("Pool", 2), lender: one("Lender"),
    flash: one("FlashLender"), bank: one("EtherBank"), swapVault: one("SwapVault"), router: one("Router"),
    shareVault: one("ShareVault"), early: one("PatchableVault", 0), late: one("PatchableVault", 1),
    positionVault: one("PositionVault"), treasury, owner: "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266", fresh,
  };
  const env = {
    DEPLOYER_KEY: deployerKey, FRESH: fresh, USDC: addresses.usdc, DEMO: addresses.demo, PT: addresses.pt,
    GUARDED: addresses.guarded, USDC_POOL: addresses.usdcPool, CHEAP_POOL: addresses.cheapPool,
    PT_POOL: addresses.ptPool, LENDER: addresses.lender, FLASH: addresses.flash, BANK: addresses.bank,
    SWAP_VAULT: addresses.swapVault, ROUTER: addresses.router, SHARE_VAULT: addresses.shareVault,
    EARLY: addresses.early, LATE: addresses.late, POSITION_VAULT: addresses.positionVault,
  };

  // forge checks a dry run's value against the chain, not the script's `vm.deal`: give
  // the fresh accounts their seed for the dry runs only, then undo it, so at the claim's
  // block they are absent.
  const snapshot = await rpc<string>(url, "evm_snapshot", []);
  for (const key of ["b0b", "a11", "a12", "a13"]) {
    const who = run("cast", ["wallet", "address", "--private-key", `0x${key.padStart(64, "0")}`]).trim();
    await rpc(url, "anvil_setBalance", [who, "0xde0b6b3a7640000"]);
  }
  const exploits: Record<string, Exploit> = {};
  for (const name of scripted) {
    run("forge", ["script", "script/Scenarios.s.sol:Exploits", "--sig", `${name}()`, "--rpc-url", url, "--gas-estimate-multiplier", "400"], env);
    const log = JSON.parse(readFileSync(`${chainDir}/broadcast/Scenarios.s.sol/31337/dry-run/${name}-latest.json`, "utf8"));
    exploits[name] = exploitFromBroadcast(log);
  }
  await rpc(url, "evm_revert", [snapshot]);
  // Exploits whose one transaction reverts, which a script can't dry-run.
  const reverting = (to: string, sig: string, ...args: string[]): Exploit => ({
    transactions: [{ from: fresh, to, value: "0", input: run("cast", ["calldata", sig, ...args]).trim(), gas: 200000 }],
  });
  exploits.ownerRescue = reverting(addresses.guarded, "rescue(address,uint256)", fresh, "5000000000");
  exploits.fixedBug = reverting(addresses.early, "withdrawTo(address,uint256)", fresh, "5000000000");
  for (const [name, exploit] of Object.entries(exploits)) {
    writeFileSync(`${here}exploits/${name}.json`, `${JSON.stringify(exploit, null, 2)}\n`);
  }

  // Proof collection rules: every scenario contract covered, every token listed.
  const base = JSON.parse(readFileSync(`${here}rules.json`, "utf8"));
  const everything = (addr: typeof addresses) => parseRules({
    ...base,
    covered_contracts: [
      addr.demo, addr.guarded, addr.usdcPool, addr.cheapPool, addr.ptPool, addr.lender, addr.flash,
      addr.bank, addr.swapVault, addr.router, addr.shareVault, addr.early, addr.late, addr.positionVault,
    ].map((address) => ({ chain_id: 31337, address })),
    listed_tokens: [
      { token: addr.usdc, price: "1" },
      { token: addr.pt, price: "1" },
      { token: "native", price: "1" },
    ],
  });
  const rules = everything(addresses);

  const union = async (at: number, names: string[]) => {
    const proofs = new Map<string, AccountProof>();
    let replay;
    for (const name of names) {
      const r = await collectReplay({ rpc: url, block: at, rules, exploit: exploits[name]!, wasm });
      replay = r.replay;
      if (r.stderr) console.log(r.stderr.trim());
      console.log(name, JSON.stringify(r.verdict), `${r.replay.proofs.length} proofs`);
      for (const p of r.replay.proofs) {
        const have = proofs.get(p.address);
        const storage = [...(have?.storage ?? []), ...p.storage.filter((s) => !have?.storage.some((h) => h.key === s.key))];
        proofs.set(p.address, { ...p, storage: storage.sort((a, b) => a.key.localeCompare(b.key)) });
      }
    }
    return {
      block: replay!.block,
      header: replay!.header,
      proofs: [...proofs.values()].sort((a, b) => a.address.localeCompare(b.address)),
    };
  };

  const state = await union(block, Object.keys(exploits));
  writeFileSync(
    `${here}state.json`,
    `${JSON.stringify({ about: "Ticket #10 judge scenario fixture, made by make-scenarios.ts on anvil: the claim's block, its RLP header, and proofs of every account and slot the scenario exploits read.", addresses, ...state }, null, 1)}\n`,
  );

  run("forge", ["script", "script/Scenarios.s.sol:LateFix", "--rpc-url", url, "--broadcast"], env);
  const later = Number(BigInt(await rpc<string>(url, "eth_blockNumber", [])));
  const after = await union(later, ["lateFix"]);
  writeFileSync(
    `${here}state-later.json`,
    `${JSON.stringify({ about: "Ticket #10: the block after the owner patched the second patchable vault, with the proofs `lateFix` reads there.", ...after }, null, 1)}\n`,
  );
} finally {
  anvil.kill();
}
