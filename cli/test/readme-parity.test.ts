// Seam T, ticket #84: the README tells the landing page's story, in its words and with its
// transactions (D34, R15.4).
//
// Seams this ticket uses (written before the first test, per the /tdd agreement):
//
//   T (stand-in chains) — `node scripts/check-readme-steps.ts`, run outside the OS sandbox (it
//     also blocks loopback), against a small README written for each test, with the landing
//     page's demo reader (web/lib/demo.ts `readDemo`, which the checker imports) and the link
//     checks pointed at the web tests' stand-in chain server (web/e2e/stand-ins/chains.ts),
//     started as its own process and put in the finished-demo world the landing page's own
//     specs use.
//       Catches: a step table whose names differ from the landing page's `STEPS` (one renamed,
//       two swapped, one missing, one extra), passing; a step row citing a transaction the demo
//       reader doesn't return for that step (another step's, or none at all), passing; a step
//       row missing one of the reader's transactions, passing; the right table failing.
//       Misses: whether the real mainnet chains still answer in the shapes the stand-in copies
//       (the online run against mainnet is the check for that).
//
//   T (sandboxed) — the same checker inside the network-denying sandbox (cli/test/offline.ts).
//       Catches: a README with no step table in its Mainnet proof section reported pending, and
//       failed under --strict, rather than passing silently; the names checked with no network;
//       the page's two copies of its step names (its component and its browser script) disagreeing.
//       Misses: the transactions, which need the chains (above).
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { ARBITRUM, BASE, DEMO, finishedDemo, nearHash } from "../../web/e2e/stand-ins/world.ts";
import { offline } from "./offline.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const CHECKER = `${repo}scripts/check-readme-steps.ts`;

/** The landing page's eight steps, as #82 and D4 name them. */
const NAMES = ["Posted", "Sealed", "Checked", "Signed", "Paid", "Landed", "Verified", "Published"];

type Parity = { names: string; transactions: string; problems: string[] };
type Report = { links: { target: string; status: string }[]; parity: Parity };

function readmeWith(markdown: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bountee-readme-"));
  writeFileSync(join(dir, "README.md"), markdown);
  return join(dir, "README.md");
}

/** A README whose Mainnet proof section holds this step table (step name, its links). */
const proof = (rows: [string, string[]][]) =>
  [
    "# BounTEE",
    "",
    "## Mainnet proof",
    "",
    "| Account | Link |",
    "|---|---|",
    "| Contract | [bounty3.bountee.near](https://nearblocks.io/address/bounty3.bountee.near) |",
    "",
    "| Step | Transactions |",
    "|---|---|",
    ...rows.map(([name, links]) => `| ${name} | ${links.map((l, i) => `[tx ${i + 1}](${l})`).join(" · ")} |`),
    "",
    "## Threat model",
    "",
  ].join("\n");

describe("offline (network denied)", () => {
  test("D34: a README with no step table is reported pending, and --strict fails on it", () => {
    const readme = readmeWith("# BounTEE\n\n## Mainnet proof\n\nNothing here yet.\n");
    const lax = offline(process.execPath, [CHECKER, "--offline", "--readme", readme, "--json"]);
    expect(lax.code, lax.stdout + lax.stderr).toBe(0);
    const parity = (JSON.parse(lax.stdout) as Report).parity;
    expect(parity.names).toBe("pending");
    expect(parity.transactions).toBe("pending");
    expect(parity.problems.join("\n")).toMatch(/no step table/);

    const strict = offline(process.execPath, [CHECKER, "--offline", "--readme", readme, "--strict"]);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toMatch(/FAIL\s+parity: no step table/);
  });

  test("D34: with no network, the names are still checked and the transactions skipped", () => {
    const ok = offline(process.execPath, [CHECKER, "--offline", "--readme", readmeWith(proof(NAMES.map((n) => [n, []]))), "--json"]);
    expect(ok.code, ok.stdout + ok.stderr).toBe(0);
    expect((JSON.parse(ok.stdout) as Report).parity).toMatchObject({ names: "ok", transactions: "skipped" });

    const renamed = offline(process.execPath, [CHECKER, "--offline", "--readme", readmeWith(proof(NAMES.map((n) => [n === "Sealed" ? "Sealed in the enclave" : n, []])))]);
    expect(renamed.code).toBe(1);
    expect(renamed.stdout).toMatch(/FAIL\s+parity names/);
  });
});

test("D34: the landing page's two step lists disagreeing fails, whatever the README says", () => {
  const dir = mkdtempSync(join(tmpdir(), "bountee-steps-"));
  const list = (names: string[], q: string) => `const STEPS = [${names.map((n) => q + n + q).join(", ")}];\n`;
  writeFileSync(join(dir, "Landing.tsx"), list(NAMES, '"'));
  writeFileSync(join(dir, "runtime.js"), list(NAMES, "'"));
  writeFileSync(join(dir, "renamed.js"), list(NAMES.map((n) => (n === "Paid" ? "Paid out" : n)), "'"));
  const run = (second: string) =>
    spawnSync(process.execPath, [CHECKER, "--offline", "--readme", readmeWith(proof(NAMES.map((n) => [n, []])))], {
      encoding: "utf8",
      env: { ...process.env, LANDING_STEP_SOURCES: `${join(dir, "Landing.tsx")}:${join(dir, second)}` },
    });
  expect(run("runtime.js").status, run("runtime.js").stdout).toBe(0);
  const bad = run("renamed.js");
  expect(bad.status).not.toBe(0);
  expect(bad.stdout + bad.stderr).toMatch(/step names differ/);
});

describe("online, against the stand-in chains", () => {
  const port = 43_000 + Math.floor(Math.random() * 2_000);
  const chains = `http://127.0.0.1:${port}`;
  let server: ChildProcess;
  const world = finishedDemo();

  // Each step's transactions, read from the world itself, not through the reader.
  const nearTx = (seed: string) => `https://nearblocks.io/txns/${nearHash(seed)}`;
  const pause = (chain: number) => world.bounties[0]!.signed_pauses.find((p) => p.chain_id === chain)!.tx_hash;
  const RIGHT: [string, string[]][] = [
    ["Posted", [nearTx(`post${DEMO.name}`)]],
    ["Sealed", [nearTx("submit1")]],
    ["Checked", [nearTx("judged1"), nearTx("judged0")]],
    ["Signed", [nearTx("signed1")]],
    ["Paid", [nearTx("signed1")]],
    ["Landed", [`https://basescan.org/tx/${pause(BASE)}`, `https://arbiscan.io/tx/${pause(ARBITRUM)}`]],
    ["Verified", [nearTx(`verified${BASE}`), nearTx(`verified${ARBITRUM}`)]],
    ["Published", [nearTx("published1")]],
  ];

  function check(markdown: string) {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NEAR_RPC: `${chains}/near`,
      NEAR_ARCHIVAL_RPC: `${chains}/near`,
      TX_API: `${chains}/txapi`,
      OUTLAYER_API: `${chains}/outlayer`,
      EVM_RPC_8453: `${chains}/evm/8453`,
      EVM_RPC_42161: `${chains}/evm/42161`,
      DEMO_BOUNTY: `${DEMO.protocol}/${DEMO.name}`,
    };
    delete env.NEXT_PUBLIC_NETWORK;
    const res = spawnSync(process.execPath, [CHECKER, "--readme", readmeWith(markdown), "--json"], { encoding: "utf8", timeout: 120_000, env });
    return { code: res.status, report: JSON.parse(res.stdout) as Report, out: res.stdout + res.stderr };
  }

  beforeAll(async () => {
    server = spawn(process.execPath, ["e2e/stand-ins/chains.ts"], { cwd: `${repo}web`, env: { ...process.env, STAND_IN_PORT: String(port) }, stdio: "ignore" });
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${chains}/health`)).ok) break;
      } catch {}
      if (i > 100) throw new Error("the stand-in chain server didn't start");
      await new Promise((r) => setTimeout(r, 100));
    }
    expect((await fetch(`${chains}/world`, { method: "PUT", body: JSON.stringify(world) })).ok).toBe(true);
  }, 30_000);
  afterAll(() => {
    server?.kill();
  });

  test("D34: the landing page's eight names in order, each citing the reader's transactions, pass", () => {
    const res = check(proof(RIGHT));
    expect(res.code, res.out).toBe(0);
    expect(res.report.parity).toStrictEqual({ names: "ok", transactions: "ok", problems: [] });
    expect(res.report.links.every((l) => l.status === "ok"), res.out).toBe(true);
  });

  test("D34: one step renamed, two swapped, one missing or one extra fails the names", () => {
    const renamed = RIGHT.map(([n, l]): [string, string[]] => [n === "Landed" ? "Pauses landed" : n, l]);
    const swapped = [RIGHT[0]!, RIGHT[2]!, RIGHT[1]!, ...RIGHT.slice(3)];
    const missing = RIGHT.filter(([n]) => n !== "Published");
    const extra: [string, string[]][] = [...RIGHT, ["Withdrawn", []]];
    for (const table of [renamed, swapped, missing, extra]) {
      const res = check(proof(table));
      expect(res.code, table.map(([n]) => n).join(",")).toBe(1);
      expect(res.report.parity.names).toBe("FAIL");
    }
  });

  test("D34: a step citing a hash the reader doesn't return for it fails; the right hash passes", () => {
    // The Sealed row cites the cheat claim's verdict, which the reader returns for Checked, not Sealed.
    const wrong = RIGHT.map(([n, l]): [string, string[]] => [n, n === "Sealed" ? [nearTx("judged0")] : l]);
    const res = check(proof(wrong));
    expect(res.code).toBe(1);
    expect(res.report.parity.names).toBe("ok");
    expect(res.report.parity.transactions).toBe("FAIL");
    expect(res.report.parity.problems.join("\n")).toContain(nearHash("judged0"));

    // A step that leaves out one of the reader's transactions fails too: the two must be equal.
    const short = RIGHT.map(([n, l]): [string, string[]] => [n, n === "Landed" ? l.slice(0, 1) : l]);
    const res2 = check(proof(short));
    expect(res2.code).toBe(1);
    expect(res2.report.parity.transactions).toBe("FAIL");
    expect(res2.report.parity.problems.join("\n")).toContain(pause(ARBITRUM));
  });

  test("D34: a placeholder in a step row holds that row's transactions pending, not failed", () => {
    const table = proof(RIGHT).replace(`[tx 1](${nearTx("published1")})`, "<!-- PENDING: publish tx -->");
    const res = check(table);
    expect(res.code, res.out).toBe(0);
    expect(res.report.parity).toStrictEqual({ names: "ok", transactions: "pending", problems: [] });
  });
});
