// Seam T, ticket #26 (live half, read-only): `bountee status`, `list` and `show` against the
// Day-3 deployment on NEAR testnet, OutLayer testnet and Base Sepolia. No keys, nothing spent.
//
// Seams (written before the first test): T here catches the receipt built from what the real
// services answer (D24: the payout's USDC transfer inside the claim's transaction, OutLayer's
// attestation of the claim's job, the pause transaction that landed on Base Sepolia, read back
// with `cast`), `list` and `show` against the real contract, and JSON output (R14.5). It misses
// "verified" (#21 isn't deployed) and stages appearing while a claim runs: `status.test.ts`
// drives that through a stand-in, step by step.
//
// Claim 7 on `day3b.bountee-spike2.testnet` is the Day-3 run's PAYS claim (#16 findings): the
// demo exploit, paid 100 sUSDC, its pause 0xd186…7846 sent to the demo vault on Base Sepolia.
// Claim 5 is the run's cheat, judged ZERO.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { defaultRpc } from "../src/chains.ts";
import { Near } from "../src/near.ts";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const CONTRACT = "day3b.bountee-spike2.testnet";
const PAYS_CLAIM = 7;
const PAYS_TX = "Fo5BHTaGDpWWU5eMQn8A1e1ukrPjPMXErLzUbazAcyqe";
const PAYS_BOUNTY = { protocol: "bountee-spike4.testnet", name: "demo-202611050342" };
const WHITEHAT = "bts1-white-1104.testnet";
const PAUSE_TX = "0xd186466b87bc2fb785c2d4aed14682a60747d9ebe43c29b656cb31958ba37846";
const VAULT = "0xc4da6cc0546a3225ad6da2fe38b928f9ed4ba094";

function bountee(args: string[]) {
  const res = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 120_000 });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

function cast(args: string[]) {
  const res = spawnSync("cast", [...args, "--rpc-url", defaultRpc(84532)!], { encoding: "utf8" });
  if (res.status !== 0) throw new Error(`cast ${args.join(" ")}: ${res.stderr}`);
  return res.stdout.trim();
}

describe("status on the Day-3 deployment", () => {
  test("D24 R14.5: a paid claim's receipt names the payout transaction, the attestation and the pause transaction", async () => {
    const r = bountee(["status", String(PAYS_CLAIM), "--contract", CONTRACT, "--tx", PAYS_TX, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.claim_id).toBe(PAYS_CLAIM);
    expect(out.verdict).toStrictEqual({ outcome: "PAYS", reason: "minimum_theft_reached" });
    const receipt = out.receipt;
    expect(receipt.bounty).toStrictEqual(PAYS_BOUNTY);
    expect(receipt.whitehat).toBe(WHITEHAT);
    expect(receipt.amount).toBe("100000000");

    // The payout: the transaction and the receipt where USDC moved to the Whitehat. Read back
    // independently from NEAR RPC: that receipt logged a NEP-141 transfer of the bounty to them.
    expect(receipt.payout.tx_hash).toBe(PAYS_TX);
    const near = new Near("testnet");
    const tx = await near.txStatus(PAYS_TX, WHITEHAT);
    const payoutReceipt = tx.receipts_outcome.find((o: any) => o.id === receipt.payout.receipt_id);
    const transfer = payoutReceipt.outcome.logs.map((l: string) => l.startsWith("EVENT_JSON:") && JSON.parse(l.slice(11))).find((e: any) => e?.event === "ft_transfer");
    expect(transfer.data[0]).toMatchObject({ old_owner_id: CONTRACT, new_owner_id: WHITEHAT, amount: "100000000" });
    expect(receipt.payout.link).toContain(PAYS_TX);

    // The attestation: OutLayer's record of the claim's job, run by the judge build the contract pins.
    const config = await near.view(CONTRACT, "config");
    expect(`0x${receipt.attestation.wasm_hash}`).toBe(config.judge_build_hash);
    expect(receipt.attestation.transaction_hash).toBe(PAYS_TX);
    expect(receipt.attestation.task_id).toBeGreaterThan(0);
    expect(receipt.attestation.url).toMatch(/^https:\/\/testnet-api\.outlayer\.ai\/attestations\//);
    const fetched = await (await fetch(receipt.attestation.url, { headers: { "User-Agent": "bountee-test" } })).json();
    expect(fetched.task_id).toBe(receipt.attestation.task_id);
    expect(fetched.secrets_ref).toBe(`${CONTRACT}/c${PAYS_CLAIM}`);

    // Each pause's transaction, landed on its chain (read back with cast).
    expect(receipt.pauses).toHaveLength(1);
    expect(receipt.pauses[0]).toMatchObject({ chain_id: 84532, contract: VAULT, tx_hash: PAUSE_TX });
    expect(receipt.pauses[0].landed.status).toBe("success");
    expect(cast(["receipt", PAUSE_TX, "status"])).toMatch(/^1/);
    expect(receipt.pauses[0].link).toContain(PAUSE_TX);
  }, 120_000);

  test("D23 R14.5: a paid claim's stages read sealed, checking, verdict, pauses signed, paid, then landed", () => {
    const r = bountee(["status", String(PAYS_CLAIM), "--contract", CONTRACT, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const stages = JSON.parse(r.stdout).stages.map((s: any) => s.stage);
    expect(stages).toStrictEqual(["sealed", "checking", "verdict", "pauses_signed", "paid", "landed"]);
  }, 120_000);

  test("R14.5: list names every bounty the contract holds, with its state, as JSON", async () => {
    const r = bountee(["list", "--contract", CONTRACT, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    // The three bounties #16 posted on this deployment (findings/ticket-16.md).
    const ids = out.bounties.map((b: any) => `${b.id.protocol}/${b.id.name}`).sort();
    expect(ids).toStrictEqual([
      "bountee-spike4.testnet/day3-side",
      "bountee-spike4.testnet/demo-202611050339",
      "bountee-spike4.testnet/demo-202611050342",
    ]);
    // Each one's state and terms as the contract's own `bounty` view gives them.
    const near = new Near("testnet");
    for (const b of out.bounties) {
      const view = await near.view(CONTRACT, "bounty", { id: b.id });
      expect(b).toMatchObject({ state: view.state, bounty_amount: view.rules.bounty_amount, minimum_theft: view.rules.minimum_theft });
    }
    expect(out.bounties.find((b: any) => b.id.name === "demo-202611050342").state).toBe("paid");
  }, 120_000);

  test("R14.5: show gives a bounty's rules, covered contracts and trusted parties as JSON", async () => {
    const r = bountee(["show", `${PAYS_BOUNTY.protocol}/${PAYS_BOUNTY.name}`, "--contract", CONTRACT, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    const near = new Near("testnet");
    const view = await near.view(CONTRACT, "bounty", { id: PAYS_BOUNTY });
    expect(out.rules).toStrictEqual(view.rules); // every rule exactly as posted
    expect(out.state).toBe("paid");
    expect(out.covered_contracts).toStrictEqual([{ chain_id: 84532, chain: "Base Sepolia", address: VAULT }]);
    // D25's pause-role address for this bounty, as #16's run granted it on the vault.
    expect(out.pause_role).toBe("0x3bf97d48e10369739b5e8c54c6d6471d22aaeb52");
    expect(cast(["call", VAULT, "pauser()(address)"]).toLowerCase()).toBe(out.pause_role);
    // The trusted parties the README names (ADR-0010), as this deployment pins them.
    const parties = Object.fromEntries(out.trusted_parties.map((p: any) => [p.party, p]));
    expect(parties.OutLayer.account).toBe("outlayer.testnet");
    expect(parties["NEAR MPC network"].account).toBe("v1.signer-prod.testnet");
    expect(parties.USDC.account).toBe("ft.bountee-spike4.testnet");
    expect(parties.Intel).toBeDefined();
    expect(parties["Proof-chain RPCs"].rpcs).toStrictEqual({
      84532: ["https://sepolia.base.org", "https://base-sepolia-rpc.publicnode.com", "https://base-sepolia.gateway.tenderly.co"],
    });
    expect(out.judge_build_hash).toBe("0xc4222111c3523dae3bd7b3002fb63ddf254231bd9f437c497acf4d5962a1df45");
  }, 120_000);

  test("D23 R14.5: a ZERO claim stops at its verdict and has no receipt", () => {
    const r = bountee(["status", "5", "--contract", CONTRACT, "--json"]);
    expect(r.code, r.stderr).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.verdict).toStrictEqual({ outcome: "ZERO", reason: "below_minimum_theft" });
    expect(out.stages.map((s: any) => s.stage)).toStrictEqual(["sealed", "checking", "verdict"]);
    expect(out.receipt).toBeUndefined();
  }, 120_000);
});
