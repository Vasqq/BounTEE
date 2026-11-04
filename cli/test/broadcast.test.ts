// Seam T, ticket #13: `bountee broadcast` sends the pause the bounty contract stored.
//
// The pause is a REAL one: bounty `bountee-t13-1104.testnet/pause-proof-1` on the throwaway
// deployment `bounty.bountee-t13-1104.testnet` (NEAR testnet, real `v1.signer-prod.testnet`,
// OutLayer and USDC test stand-ins) scored PAYS on Nov 4, and the MPC network signed its pause
// of the demo vault at 0x4242…fa89 on chain 84532. The tool reads it from NEAR testnet.
//
// The chain is a local anvil with Base Sepolia's chain ID, where the demo vault is deployed
// by `demo/script/Deploy.s.sol` from the Base Sepolia deployer's address at nonce 0 (so at
// the address the pause names), with the bounty's pause-role address as its pauser and
// funded with its pause gas. The live Base Sepolia run is ticket #16.
//
// Catches: the stored pause is a valid transaction from the bounty's D25 address that lands
// and leaves the vault paused (R7.3, R7.4); machine-readable output (R14.5). Misses:
// inclusion on the public chain, and verification on NEAR (#21).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pauseRole } from "@bountee/formats";
import { afterAll, beforeAll, expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const demo = fileURLToPath(new URL("../../demo/", import.meta.url));
const CONTRACT = "bounty.bountee-t13-1104.testnet";
const BOUNTY = { protocol: "bountee-t13-1104.testnet", name: "pause-proof-1" };
const DEPLOYER = "0x1ffd85c2270f97183b9b254b3269845f47ebc9ba";
const VAULT = "0x424216bdc8128c7af8164d5e245e31507005fa89";
const PORT = 18_645;
const RPC = `http://127.0.0.1:${PORT}`;
// The pause's gas limit times its fee limit, as the bounty contract's fees() view states.
const PAUSE_GAS = (200_000n * 1_000_000_000n).toString(16);

const pauser = pauseRole.address(pauseRole.TESTNET_ROOT_PUBLIC_KEY, CONTRACT, BOUNTY);

function run(cmd: string, args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const res = spawnSync(cmd, args, { encoding: "utf8", cwd: opts.cwd, env: { ...process.env, ...opts.env }, timeout: 300_000 });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${res.stdout}\n${res.stderr}`);
  return res.stdout.trim();
}

const cast = (args: string[]) => run("cast", [...args, "--rpc-url", RPC]);

function bountee(args: string[]) {
  const res = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 120_000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

let anvil: ChildProcess;

beforeAll(async () => {
  anvil = spawn("anvil", ["--chain-id", "84532", "--port", String(PORT), "--silent"], { stdio: "ignore" });
  for (let i = 0; ; i++) {
    try {
      cast(["chain-id"]);
      break;
    } catch (e) {
      if (i > 50) throw e;
      await new Promise((ok) => setTimeout(ok, 200));
    }
  }
  cast(["rpc", "anvil_setBalance", DEPLOYER, "0xde0b6b3a7640000"]);
  cast(["rpc", "anvil_impersonateAccount", DEPLOYER]);
  run("forge", ["soldeer", "install"], { cwd: demo });
  run("forge", ["script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast", "--unlocked", "--sender", DEPLOYER], {
    cwd: demo,
    env: { PAUSE_ROLE: pauser },
  });
  cast(["rpc", "anvil_setBalance", pauser, `0x${PAUSE_GAS}`]);
}, 300_000);

afterAll(() => {
  anvil?.kill();
});

test("R7.3, R7.4, R14.5: broadcast sends the stored pause and the vault reads as paused", () => {
  expect(cast(["call", VAULT, "paused()(bool)"])).toBe("false");
  const { code, stdout, stderr } = bountee([
    "broadcast",
    `${BOUNTY.protocol}/${BOUNTY.name}`,
    "--contract",
    CONTRACT,
    "--rpc",
    `84532=${RPC}`,
    "--wait",
    "30",
    "--json",
  ]);
  expect(code, stderr).toBe(0);
  const out = JSON.parse(stdout);
  expect(out.state).toBe("paid");
  expect(out.pauses).toHaveLength(1);
  const [pause] = out.pauses;
  expect(pause).toMatchObject({ chain_id: 84532, contract: VAULT, sent: "sent", receipt: { status: "success" } });

  expect(cast(["call", VAULT, "paused()(bool)"])).toBe("true");
  const tx = JSON.parse(cast(["tx", pause.tx_hash, "--json"]));
  expect(tx.from.toLowerCase()).toBe(pauser);
  expect(tx.to.toLowerCase()).toBe(VAULT);
  expect(tx.input).toBe("0x8456cb59");
  expect(Number(tx.chainId)).toBe(84532);

  // Sending it again is harmless: someone else may already have.
  const again = bountee(["broadcast", `${BOUNTY.protocol}/${BOUNTY.name}`, "--contract", CONTRACT, "--rpc", `84532=${RPC}`, "--json"]);
  expect(again.code, again.stderr).toBe(0);
  expect(JSON.parse(again.stdout).pauses[0].sent).toBe("known");
}, 180_000);
