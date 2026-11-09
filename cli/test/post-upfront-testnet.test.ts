// Seam T, ticket #57: a posting never fails for want of NEAR after something has been spent.
// NEAR takes a transaction's attached gas up front at max(gas price, min_gas_purchase_price),
// 1e9 yoctoNEAR on testnet as on mainnet, and refunds what's unused only afterwards; Nov 7's
// mainnet post failed holding 0.0903 NEAR for the 0.2709 its 270 Tgas transfer-and-call wanted.
//
// Seams (written before the first test): T, `bountee post` and the fresh-instance script against
// NEAR testnet's real runtime, the one judge of whether a transaction's gas is covered.
//   Catches: the posting's figure (`postingNeed`: the fee, its first balance entry's storage and
//   both calls' gas in hand) being neither short (the post at exactly the figure would be
//   refused by NEAR) nor ignored (an account just under it is refused before anything is sent).
//   Misses: mainnet's own prices (the same runtime config on both networks, read live; the
//   mainnet figures are a recorded analysis), and the preflight's arithmetic on stand-in
//   balances (`fresh-instance-preflight.test.ts`, in CI).
//
//   NEAR's own refusal of a 270 Tgas transfer-and-call from an account too poor for it states
//     its cost, which is exactly what `upfrontNear` prices for that call, to the yoctoNEAR
//     (the analysis of NEAR's up-front pricing, checked on the runtime itself) (D21)
//   an account just under the figure: `bountee post` refuses, naming the NEAR to add, and its
//     NEAR and prepaid posting fee are unchanged (D21)
//   the same account topped up to exactly the figure the fresh-instance script states (figures
//     are rounded up to the 0.00001 NEAR shown): a fresh instance posts and goes live (D21)
//
// Runs only with BOUNTEE_UPFRONT_RUN=1 (it spends testnet NEAR and Base Sepolia ETH). Needs the
// deployment file of `testnet/deploy-system.ts` in BOUNTEE_DAY3, the Protocol's key (PROTOCOL,
// default bountee-spike4.testnet; the figure counts any posting fee it has prepaid) and a second
// testnet account's key (SINK) in ~/.near-credentials/testnet, which holds the Protocol's NEAR
// above the figure meanwhile. Evidence goes to ~/.bountee-testnet/upfront-evidence.json.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { actions } from "near-api-js";
import { describe, expect, test } from "vitest";
import { parseRules } from "@bountee/formats";
import { formatNear, Near, roundUpNear } from "../src/near.ts";
import { postingNeed } from "../src/post.ts";

const RUN = process.env.BOUNTEE_UPFRONT_RUN === "1";
const home = homedir();
const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const freshInstance = fileURLToPath(new URL("./testnet/fresh-instance.ts", import.meta.url));
const PROTOCOL = process.env.PROTOCOL ?? "bountee-spike4.testnet";
const SINK = process.env.SINK ?? "bountee-a54-1108.testnet";
/** Day-3 run 1's vault, any covered contract will do: the NEAR check comes before the pause-gas one. */
const VAULT = "0x424216bdc8128c7af8164d5e245e31507005fa89";
const evidenceFile = join(home, ".bountee-testnet", "upfront-evidence.json");
const evidence: Record<string, unknown> = {};
const record = (k: string, v: unknown) => {
  evidence[k] = v;
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  console.log(`${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`);
};
const near = new Near("testnet");
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);
const YOCTO = 10n ** 24n;

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

/** Moves NEAR between `account` and `sink` until `account` holds exactly `target` free. */
async function moveTo(account: string, sink: string, target: bigint) {
  const free = (await near.freeNear(account))!;
  if (free > target) await transfer(account, sink, free - target);
  if (free < target) await transfer(sink, account, target - free);
}

/** Moves `amount` yoctoNEAR from `from` to `to` and waits for it to land. */
async function transfer(from: string, to: string, amount: bigint): Promise<string> {
  const r = await near.account(from).signAndSendTransaction({ receiverId: to, actions: [actions.transfer(amount)], waitUntil: "FINAL" });
  return r.transaction.hash;
}

describe.skipIf(!RUN)("a posting holds its NEAR before spending (#57)", () => {
  const deploymentFile = process.env.BOUNTEE_DAY3 ?? join(home, ".bountee-testnet", "day3-deployment.json");
  const deployment = RUN ? JSON.parse(readFileSync(deploymentFile, "utf8")) : {};
  const CONTRACT: string = deployment.contract;
  const feeBalance = async () => BigInt(await near.view<string>(CONTRACT, "posting_fee_balance", { account_id: PROTOCOL }));
  const name = `upfront-${stamp}`;
  const rules = {
    covered_contracts: [{ chain_id: 84532, address: VAULT }],
    proof_chain: 84532,
    listed_tokens: [{ token: "native", price: "1" }],
    bounty_amount: "1000000",
    minimum_theft: "1000000000",
    end_date_ns: String(BigInt(Date.now() + 30 * 86_400_000) * 1_000_000n),
    disclosure_delay_days: 30,
    exploit_public_key: "x25519:6W7B3sSYk1p2DZ7FXyRbJWDNiaRfVTj1hm6k8Cqnq6wA",
  };
  let figure: bigint;

  test("D21: NEAR's own refusal of a 270 Tgas transfer-and-call states exactly the cost the figure prices for it", async () => {
    await moveTo(PROTOCOL, SINK, YOCTO / 5n);
    const args = { receiver_id: CONTRACT, amount: "1", msg: "{}" };
    const predicted = await near.upfrontNear([{ method: "ft_transfer_call", gas: 270_000_000_000_000n, deposit: 1n, argsBytes: JSON.stringify(args).length }]);
    const refused = await near
      .account(PROTOCOL)
      .signAndSendTransaction({ receiverId: deployment.usdc, actions: [actions.functionCall("ft_transfer_call", args, 270_000_000_000_000n, 1n)], waitUntil: "FINAL" })
      .then(() => null, (e: any) => e);
    expect(refused?.message).toMatch(/^Not enough balance for /);
    expect(BigInt(refused.cost)).toBe(predicted);
    record("d21_near_cost", { predicted: predicted.toString(), near_says: String(refused.cost), message: refused.message });
  }, 300_000);

  test("D21: a Protocol just under the posting's NEAR is refused before anything is sent, told what to add", async () => {
    const config = await near.view(CONTRACT, "config");
    const full = parseRules({ ...rules, recency_limit_secs: 300, seed: config.seed, judge_build_hash: config.judge_build_hash });
    figure = (await postingNeed(near, CONTRACT, { protocol: PROTOCOL, name }, full)).need;
    // At least what the prepaid fee lacks and both calls' 300 Tgas of gas at 1e9 (0.3 NEAR).
    const fee = BigInt((await near.view(CONTRACT, "fees")).posting_fee);
    expect(figure).toBeGreaterThan(fee - (await feeBalance()) + (3n * YOCTO) / 10n);
    await moveTo(PROTOCOL, SINK, figure - YOCTO / 100n);
    const before = { near: (await near.freeNear(PROTOCOL))!, fee: await feeBalance() };
    // The transfer's own gas comes off too: the account sits between 0.02 and 0 NEAR under the figure.
    expect(before.near).toBeLessThan(figure);
    expect(before.near).toBeGreaterThan(figure - YOCTO / 50n);
    const file = join(home, ".bountee-testnet", `${name}-rules.json`);
    writeFileSync(file, `${JSON.stringify(rules)}\n`, { mode: 0o600 });
    const r = await run([entry, "post", `${PROTOCOL}/${name}`, "--rules", file, "--contract", CONTRACT, "--json"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(`add ${formatNear(roundUpNear(figure - before.near))} NEAR (nothing was spent)`);
    expect(await near.view(CONTRACT, "bounty", { id: { protocol: PROTOCOL, name } })).toBeNull();
    expect((await near.freeNear(PROTOCOL))!).toBe(before.near);
    expect(await feeBalance()).toBe(before.fee);
    record("d21_refused", { figure: formatNear(figure), held: formatNear(before.near), stderr: lastJson(r.stderr).error ?? r.stderr.trim() });
  }, 300_000);

  test("D21: topped up to exactly the posting's NEAR, a fresh instance posts and goes live", async () => {
    expect(figure).toBeDefined();
    const out = join(home, ".bountee-testnet", `upfront-instance-${stamp}.json`);
    const live = `upfront-live-${stamp}`;
    const env = { BOUNTEE_DAY3: deploymentFile, BOUNTEE_INSTANCE: out, BOUNTY_NAME: live, BOUNTY_AMOUNT: "1000000", CLAIMS: "0", PROTOCOL };
    // The figure the script states for this posting (its own rules' size), exactly as shown.
    const plan = lastJson((await run([freshInstance], { ...env, PREFLIGHT_ONLY: "1" })).stdout);
    const stated = plan.balances.find((b: any) => b.who === PROTOCOL && b.asset === "NEAR").need as string;
    const [whole, frac = ""] = stated.replace(/ NEAR$/, "").split(".");
    const statedYocto = (BigInt(whole!) * 100_000n + BigInt(frac.padEnd(5, "0"))) * 10n ** 19n;
    const topUp = await transfer(SINK, PROTOCOL, statedYocto - (await near.freeNear(PROTOCOL))!);
    expect((await near.freeNear(PROTOCOL))!).toBe(statedYocto);
    const r = await run([freshInstance], env);
    expect(r.code, r.stderr).toBe(0);
    const instance = lastJson(r.stdout);
    expect((await near.view(CONTRACT, "bounty", { id: { protocol: PROTOCOL, name: live } })).state).toBe("live");
    record("d21_live", { stated, top_up_tx: topUp, bounty: instance.bounty, vault: instance.vault, post_tx: instance.post_tx, left: formatNear((await near.freeNear(PROTOCOL))!) });
  }, 900_000);
});
