// Seam T, ticket #17: `bountee post` on NEAR testnet against the real OutLayer and the
// attested judge's posting check, reading Base Sepolia through the judge's pinned RPCs;
// chain state read back with `cast` and NEAR RPC.
//
// Seams for #17 (written before the first test): J (`judge/tests/seam_j_posting_check.rs`)
// decides each covered contract's pass or fail against test stand-in RPCs; C
// (`contract/tests/seam_c.rs`) acts on the answer; T (this file) catches what both miss:
// the real pinned RPCs answering the posting reads from inside an OutLayer job, a real
// contract's access control and a real revert, the tool's own preflight, and the USDC
// really coming back. It misses the second chain (`second-chain-testnet.test.ts`, #20) and
// the RPC-disagreement cases (J only: testnet RPCs can't be made to disagree at will).
//
//   a posting whose pause role has no pause gas: the tool refuses it before spending (R7.6)
//   a posting covering a contract the pause role can't pause (an already-paused Day-3
//     vault whose role is another bounty's): the check fails, the USDC comes back (R12.2,
//     R12.1, R1.6)
//   a fresh demo vault, its role granted and its pause gas funded with the L1 data fee on
//     top: `bountee post` makes it live (R7.6, R12.5)
//   the same vault posted again: refused, the USDC comes back (R12.3)
//
// Runs only with BOUNTEE_POST_RUN=1 (it spends testnet NEAR and Base Sepolia ETH). Needs the
// deployment file of `testnet/deploy-system.ts` in BOUNTEE_DAY3 (a contract with #17's code
// and its judge), the Protocol's key in ~/.near-credentials/testnet, and the Base Sepolia
// deployer in ~/.bountee-testnet/base-sepolia-deployer.env. Evidence goes to
// ~/.bountee-testnet/post-evidence.json.
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PAUSE_GAS_PER_PAUSE } from "@bountee/formats";
import { describe, expect, test } from "vitest";
import { defaultRpc } from "../src/chains.ts";
import { Near } from "../src/near.ts";

const RUN = process.env.BOUNTEE_POST_RUN === "1";
const home = homedir();
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const freshInstance = fileURLToPath(new URL("./testnet/fresh-instance.ts", import.meta.url));
const RPC = defaultRpc(84532)!;
const PROTOCOL = process.env.PROTOCOL ?? "bountee-spike4.testnet";
/** Day-3 run 1's vault: paused, its pause role another bounty's. */
const PAUSED_VAULT = process.env.PAUSED_VAULT ?? "0x424216bdc8128c7af8164d5e245e31507005fa89";
const evidenceFile = join(home, ".bountee-testnet", "post-evidence.json");
const evidence: Record<string, unknown> = {};
const record = (k: string, v: unknown) => {
  evidence[k] = v;
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
};
const near = new Near("testnet");
const cast = (...args: string[]) => execFileSync("cast", args, { encoding: "utf8" }).trim();
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);

function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
const lastJson = (text: string) => JSON.parse(text.trim().split("\n").pop()!);

describe.skipIf(!RUN)("bountee post on testnet (#17)", () => {
  const deploymentFile = process.env.BOUNTEE_DAY3 ?? join(home, ".bountee-testnet", "day3-deployment.json");
  const deployment = RUN ? JSON.parse(readFileSync(deploymentFile, "utf8")) : {};
  const CONTRACT: string = deployment.contract;
  const USDC: string = deployment.usdc;
  const usdc = async () => BigInt(await near.view<string>(USDC, "ft_balance_of", { account_id: PROTOCOL }));
  const feeBalance = async () => BigInt(await near.view<string>(CONTRACT, "posting_fee_balance", { account_id: PROTOCOL }));
  const rulesFile = (name: string, vault: string) => {
    const file = join(home, ".bountee-testnet", `${name}-rules.json`);
    const rules = {
      covered_contracts: [{ chain_id: 84532, address: vault }],
      proof_chain: 84532,
      listed_tokens: [{ token: "native", price: "1" }],
      bounty_amount: "1000000",
      minimum_theft: "1000000000",
      end_date_ns: String(BigInt(Date.now() + 30 * 86_400_000) * 1_000_000n),
      disclosure_delay_days: 30,
      exploit_public_key: "x25519:6W7B3sSYk1p2DZ7FXyRbJWDNiaRfVTj1hm6k8Cqnq6wA",
    };
    writeFileSync(file, `${JSON.stringify(rules)}\n`, { mode: 0o600 });
    return file;
  };
  const post = (name: string, file: string, ...extra: string[]) =>
    run([entry, "post", `${PROTOCOL}/${name}`, "--rules", file, "--contract", CONTRACT, "--json", ...extra]);

  test("R7.6: the tool refuses a posting whose pause role has no pause gas, before spending anything", async () => {
    const name = `t17-nogas-${stamp}`;
    const [before, fee] = [await usdc(), await feeBalance()];
    const r = await post(name, rulesFile(name, PAUSED_VAULT));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("needs pause gas before posting");
    expect(await near.view(CONTRACT, "bounty", { id: { protocol: PROTOCOL, name } })).toBeNull();
    expect(await usdc()).toBe(before);
    expect(await feeBalance()).toBe(fee);
    record("r7_6_preflight", r.stderr.trim());
  }, 120_000);

  test("R12.2, R12.1, R1.6: a contract the pause role can't pause fails the posting check, and the USDC comes back in full", async () => {
    const name = `t17-paused-${stamp}`;
    const held = async () => BigInt(await near.view<string>(USDC, "ft_balance_of", { account_id: CONTRACT }));
    const [before, heldBefore] = [await usdc(), await held()];
    expect(cast("call", PAUSED_VAULT, "paused()(bool)", "--rpc-url", RPC)).toBe("true");
    const r = await post(name, rulesFile(name, PAUSED_VAULT), "--no-preflight");
    expect(r.code, r.stderr).toBe(1);
    const out = lastJson(r.stdout);
    expect(out.state).toBe("check_failed");
    expect(out.failures).toEqual([{ index: 0, reason: "cannot_pause", contract: { chain_id: 84532, address: PAUSED_VAULT } }]);
    expect(await usdc()).toBe(before);
    expect(await held()).toBe(heldBefore);
    record("r12_2_r1_6_check_failed", { bounty: `${PROTOCOL}/${name}`, post_tx: out.post_tx, failures: out.failures, usdc_before: before.toString(), usdc_after: (await usdc()).toString() });
  }, 300_000);

  let instance: { vault: string; bounty: string; pause_role: string; post_tx: string; pause_gas_tx: string; deploy_txs: string[] };

  test("bountee post posts a bounty that goes live on testnet (R7.6, R12.1, R12.2, R12.5)", async () => {
    const out = join(home, ".bountee-testnet", `t17-instance-${stamp}.json`);
    const r = await run([freshInstance], { BOUNTEE_DAY3: deploymentFile, BOUNTEE_INSTANCE: out, BOUNTY_NAME: `t17-live-${stamp}`, BOUNTY_AMOUNT: "1000000", CLAIMS: "0" });
    expect(r.code, r.stderr).toBe(0);
    instance = lastJson(r.stdout);
    const [protocol, name] = instance.bounty.split("/");
    expect((await near.view(CONTRACT, "bounty", { id: { protocol, name } })).state).toBe("live");
    // The pause role holds exactly what the check asks: gas limit at fee limit plus the L1 fee.
    expect(BigInt(cast("balance", instance.pause_role, "--rpc-url", RPC))).toBe(PAUSE_GAS_PER_PAUSE);
    record("live", { bounty: instance.bounty, vault: instance.vault, pause_role: instance.pause_role, deploy_txs: instance.deploy_txs, pause_gas_tx: instance.pause_gas_tx, post_tx: instance.post_tx });
  }, 900_000);

  test("R12.3: a contract already covered by a live bounty is refused, and the USDC comes back", async () => {
    expect(instance).toBeDefined();
    const name = `t17-again-${stamp}`;
    const before = await usdc();
    const r = await post(name, rulesFile(name, instance.vault), "--no-preflight");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("already covered by a live or pending bounty");
    expect(await near.view(CONTRACT, "bounty", { id: { protocol: PROTOCOL, name } })).toBeNull();
    expect(await usdc()).toBe(before);
    record("r12_3_refused", lastJson(r.stderr).error);
  }, 300_000);
});
