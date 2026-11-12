// Seam T, ticket #83: the README checker finds placeholders and checks every link (R15.4).
//
// Seams this ticket uses (written before the first test, per the /tdd agreement):
//
//   T (sandboxed) — `node scripts/check-readme-steps.ts`, spawned inside the OS sandbox that
//     denies all networking (cli/test/offline.ts), against a small README written for each test.
//       Catches: a placeholder (`<!-- PENDING: … -->`) in prose, a table, a link or a console
//       block that isn't reported pending, or that --strict lets through; a link to a repo path
//       that doesn't exist; an --offline run that reaches for the network, or that skips the
//       chain and URL checks without saying so.
//       Misses: whether chain and URL links resolve (they need the network, below).
//
//   T (stand-in chains) — the same checker run outside the sandbox (it also blocks loopback),
//     with every endpoint it uses (NEAR_RPC, TX_API, EVM_RPC_8453, EVM_RPC_42161) pointed at the
//     web tests' stand-in chain server (web/e2e/stand-ins/chains.ts), put in a known world.
//       Catches: an explorer link to a NEAR transaction or account, an EVM transaction or an EVM
//       address on Base or Arbitrum One that the chain doesn't know, passing; one it knows,
//       failing; an explorer link checked on the explorer instead of the chain; another URL that
//       answers with an error, passing.
//       Misses: whether the real nearblocks, basescan and arbiscan pages render (they refuse
//       automated requests); whether the real FastNEAR and RPC endpoints still answer in the
//       shapes the stand-in copies (the online run against mainnet is the check for that).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { offline } from "./offline.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const CHECKER = `${repo}scripts/check-readme-steps.ts`;

type Report = {
  steps: { command: string; status: string }[];
  links: { target: string; status: string; reason?: string }[];
  placeholders: { line: number; what: string; status: string }[];
};

/** A README holding `markdown`, in a fresh folder; returns its path. */
function readmeWith(markdown: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bountee-readme-"));
  writeFileSync(join(dir, "README.md"), markdown);
  return join(dir, "README.md");
}

describe("offline (network denied)", () => {
  test("R15.4: a placeholder anywhere in the README is reported pending, and --strict fails on one", () => {
    const readme = readmeWith(
      [
        "# Title",
        "",
        "Watch the demo video: <!-- PENDING: demo video URL -->.",
        "",
        "| Step | Transaction |",
        "| --- | --- |",
        "| Withdrawn | <!-- PENDING: withdraw tx --> |",
        "",
        "[Live site](<!-- PENDING: live site URL -->)",
        "",
        "```console online",
        "$ bountee verify <!-- PENDING: demo bounty id --> --network mainnet",
        "pass contract_code",
        "```",
        "",
      ].join("\n"),
    );
    const lax = offline(process.execPath, [CHECKER, "--offline", "--readme", readme, "--json"]);
    expect(lax.code, lax.stdout + lax.stderr).toBe(0);
    const report = JSON.parse(lax.stdout) as Report;
    expect(report.placeholders).toStrictEqual([
      { line: 3, what: "demo video URL", status: "pending" },
      { line: 7, what: "withdraw tx", status: "pending" },
      { line: 9, what: "live site URL", status: "pending" },
      { line: 12, what: "demo bounty id", status: "pending" },
    ]);
    // The placeholder's slot is pending, not a broken link, and its step isn't run.
    expect(report.links).toStrictEqual([]);
    expect(report.steps).toStrictEqual([{ command: "bountee verify <!-- PENDING: demo bounty id --> --network mainnet", status: "pending" }]);

    const strict = offline(process.execPath, [CHECKER, "--offline", "--readme", readme, "--strict"]);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toMatch(/pending\s+placeholder line 3: demo video URL/);

    // One placeholder alone is enough to fail --strict.
    const one = readmeWith("All done but this: <!-- PENDING: live site URL -->\n");
    expect(offline(process.execPath, [CHECKER, "--offline", "--readme", one, "--strict"]).code).toBe(1);
    expect(offline(process.execPath, [CHECKER, "--offline", "--readme", one]).code).toBe(0);
  });

  test("R15.4: a link to a missing repo path fails; the same README with the path present passes", () => {
    const readme = readmeWith("See [the audit](docs/audit.md#findings) and ![logo](assets/logo.svg).\n");
    const dir = join(readme, "..");
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "assets/logo.svg"), "<svg/>");

    const missing = offline(process.execPath, [CHECKER, "--offline", "--readme", readme]);
    expect(missing.code).toBe(1);
    expect(missing.stdout).toMatch(/FAIL\s+link docs\/audit\.md#findings/);
    expect(missing.stdout).toMatch(/ok\s+link assets\/logo\.svg/);

    mkdirSync(join(dir, "docs"));
    writeFileSync(join(dir, "docs/audit.md"), "# Audit\n");
    const present = offline(process.execPath, [CHECKER, "--offline", "--readme", readme, "--json"]);
    expect(present.code, present.stdout).toBe(0);
    expect((JSON.parse(present.stdout) as Report).links).toStrictEqual([
      { target: "docs/audit.md#findings", status: "ok" },
      { target: "assets/logo.svg", status: "ok" },
    ]);
  });

  test("R15.4: --offline checks repo paths, skips chain and URL links, and says so in its summary", () => {
    const readme = readmeWith(
      [
        "[Spec](README.md)",
        "[Contract](https://nearblocks.io/address/bounty3.bountee.near)",
        "[Pause](https://basescan.org/tx/0x1111111111111111111111111111111111111111111111111111111111111111)",
        "[Foundry](https://getfoundry.sh)",
        "",
      ].join("\n"),
    );
    const res = offline(process.execPath, [CHECKER, "--offline", "--readme", readme, "--json"]);
    expect(res.code, res.stdout + res.stderr).toBe(0);
    expect((JSON.parse(res.stdout) as Report).links.map((l) => l.status)).toStrictEqual(["ok", "skipped", "skipped", "skipped"]);
    const text = offline(process.execPath, [CHECKER, "--offline", "--readme", readme]);
    expect(text.stdout).toMatch(/3 chain and URL links skipped \(--offline\)/);
  });
});

describe("online, against the stand-in chains", () => {
  const port = 41_000 + Math.floor(Math.random() * 2_000);
  const chains = `http://127.0.0.1:${port}`;
  let server: ChildProcess;

  const NEAR_TX = "9xQmZ3dV7bKpL2nW4yR8sT6uH1jF5gC3eA9kM7oP2qN";
  const NEAR_TX_UNKNOWN = "4hT8sR2qP6nM1kL9jH3gF7dC5bA2zY8xW4vU6tS1rQe";
  const BASE_TX = `0x${"ab".repeat(32)}`;
  const ARB_TX = `0x${"cd".repeat(32)}`;
  const REVERTED_TX = `0x${"ef".repeat(32)}`;
  const UNKNOWN_TX = `0x${"12".repeat(32)}`;
  const VAULT_BASE = "0x8e01c52f1b2bbedd8b714b9ae168d022b52e74c1";
  const VAULT_ARB = "0x3f6a9e2d4c1b8a7e5d0f9c3b2a1e8d7c6b5a4f3e";
  const PAUSE_ROLE = "0x5a1c6a3e0c1f5b8e2d7f4a9b3c6d8e0f1a2b3c4d";
  const EMPTY = "0x00000000000000000000000000000000000000aa";

  const world = {
    network: "mainnet",
    contract: "bounty3.bountee.near",
    config: {},
    fees: {},
    accounts: { "bounty3.bountee.near": { amount: "1", code_hash: "FFwgGfYh11111111111111111111111111111111111" } },
    bounties: [],
    claims: [],
    pauseRoles: {},
    verifications: {},
    publications: {},
    releases: {},
    nearTxs: [{ hash: NEAR_TX, signer: "agent.bountee.near", receipts: [{ executor: "bounty3.bountee.near", logs: [], ok: true }] }],
    evm: {
      8453: { balances: { [PAUSE_ROLE]: "1000" }, receipts: { [BASE_TX]: { ok: true, block: 1, to: VAULT_BASE }, [REVERTED_TX]: { ok: false, block: 1, to: VAULT_BASE } } },
      42161: { balances: {}, receipts: { [ARB_TX]: { ok: true, block: 1, to: VAULT_ARB } } },
    },
    pausers: { [`8453:${VAULT_BASE}`]: [PAUSE_ROLE], [`42161:${VAULT_ARB}`]: [PAUSE_ROLE] },
  };

  /** The checker, outside the sandbox, with every endpoint pointed at the stand-in. */
  function check(markdown: string) {
    const res = spawnSync(process.execPath, [CHECKER, "--readme", readmeWith(markdown), "--json"], {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        NEAR_RPC: `${chains}/near`,
        NEAR_ARCHIVAL_RPC: `${chains}/near`,
        TX_API: `${chains}/txapi`,
        EVM_RPC_8453: `${chains}/evm/8453`,
        EVM_RPC_42161: `${chains}/evm/42161`,
      },
    });
    return { code: res.status, report: JSON.parse(res.stdout) as Report, stderr: res.stderr };
  }
  const statuses = (markdown: string) => check(markdown).report.links.map((l) => l.status);

  beforeAll(async () => {
    server = spawn(process.execPath, ["e2e/stand-ins/chains.ts"], { cwd: `${repo}web`, env: { ...process.env, STAND_IN_PORT: String(port) }, stdio: "ignore" });
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${chains}/health`)).ok) break;
      } catch {}
      if (i > 100) throw new Error("the stand-in chain server didn't start");
      await new Promise((r) => setTimeout(r, 100));
    }
    const put = await fetch(`${chains}/world`, { method: "PUT", body: JSON.stringify(world) });
    expect(put.ok).toBe(true);
  }, 30_000);
  afterAll(() => {
    server?.kill();
  });

  test("R15.4: a NEAR transaction link passes when the chain knows its hash, and fails when it doesn't", () => {
    expect(statuses(`[Claim](https://nearblocks.io/txns/${NEAR_TX})\n`)).toStrictEqual(["ok"]);
    const unknown = check(`[Claim](https://nearblocks.io/txns/${NEAR_TX_UNKNOWN}#execution)\n`);
    expect(unknown.code).toBe(1);
    expect(unknown.report.links[0]!.status).toBe("FAIL");
  });

  test("R15.4: a NEAR account link passes when the account exists on NEAR RPC, and fails when it doesn't", () => {
    expect(statuses("[Contract](https://nearblocks.io/address/bounty3.bountee.near)\n")).toStrictEqual(["ok"]);
    expect(statuses("[Contract](https://nearblocks.io/address/nobody.bountee.near)\n")).toStrictEqual(["FAIL"]);
  });

  test("R15.4: an EVM transaction link passes only with a successful receipt on its own chain, Base or Arbitrum One", () => {
    expect(statuses(`[Base pause](https://basescan.org/tx/${BASE_TX})\n[Arbitrum pause](https://arbiscan.io/tx/${ARB_TX})\n`)).toStrictEqual(["ok", "ok"]);
    // Unknown, reverted, and a real Base transaction linked on the Arbitrum explorer.
    expect(
      statuses(`[a](https://basescan.org/tx/${UNKNOWN_TX})\n[b](https://basescan.org/tx/${REVERTED_TX})\n[c](https://arbiscan.io/tx/${BASE_TX})\n[d](https://arbiscan.io/tx/${UNKNOWN_TX})\n`),
    ).toStrictEqual(["FAIL", "FAIL", "FAIL", "FAIL"]);
  });

  test("R15.4: an EVM address link (a vault, the pause-role address) passes when it has code or a balance on its chain", () => {
    expect(
      statuses(
        `[Base vault](https://basescan.org/address/${VAULT_BASE})\n[Arbitrum vault](https://arbiscan.io/address/${VAULT_ARB})\n[Pause role](https://basescan.org/address/${PAUSE_ROLE})\n`,
      ),
    ).toStrictEqual(["ok", "ok", "ok"]);
    expect(statuses(`[Empty](https://basescan.org/address/${EMPTY})\n[Wrong chain](https://arbiscan.io/address/${VAULT_BASE})\n`)).toStrictEqual(["FAIL", "FAIL"]);
  });

  test("R15.4: any other absolute URL must answer with a success status", () => {
    expect(statuses(`[Up](${chains}/health)\n`)).toStrictEqual(["ok"]);
    const down = check(`[Down](${chains}/no-such-page)\n`);
    expect(down.code).toBe(1);
    expect(down.report.links).toStrictEqual([{ target: `${chains}/no-such-page`, status: "FAIL", reason: "HTTP 404" }]);
  });
});
