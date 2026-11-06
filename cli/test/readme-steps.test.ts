// Seam T, ticket #34: the README's "do X → see Y" steps, run and checked by a script (R15.4).
//
// Seams this ticket uses (written before the first test, per the /tdd agreement):
//
//   T — `node scripts/check-readme-steps.ts`, spawned inside the OS sandbox that denies all
//     networking (the #9 offline harness), against the committed README.md. A step is a
//     ```console block: `$ <command>` lines, each followed by the lines its output must show.
//       Catches: a README step whose command fails or whose output no longer shows what the
//       README says (a verdict that changed, a fixture that moved, a renamed flag); a step the
//       checker skips without saying so (the steps it reports are counted against the README's
//       own); a checker that passes without comparing output (the wrong-expectation control);
//       an offline step that secretly needs the network, keys or funds.
//       Misses: the steps that need the network (`console online` blocks, run by the checker
//       without --offline) and those still waiting for mainnet data (reported pending, and
//       refused under --strict); whether the README's prose, threat model and evidence links
//       are true (R13.1, R15.5, R15.7, R4.12 and ADR-0017 are inspections, not tests).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, expect, test } from "vitest";
import { offline } from "./offline.ts";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const target = readFileSync(`${repo}judge/wasm-target`, "utf8").trim();
const CHECKER = `${repo}scripts/check-readme-steps.ts`;
const README = `${repo}README.md`;

/** The README's steps, read here independently of the checker: one per `$ ` line in a console block. */
function stepsIn(markdown: string): { command: string; online: boolean }[] {
  const steps: { command: string; online: boolean }[] = [];
  for (const [, info, body] of markdown.matchAll(/^```(console[^\n]*)\n([\s\S]*?)^```/gm)) {
    for (const line of body!.split("\n")) {
      if (line.startsWith("$ ")) steps.push({ command: line.slice(2).trim(), online: /\bonline\b/.test(info!) });
    }
  }
  return steps;
}

beforeAll(() => {
  // The judge and its scenario tests are built before networking is cut, as a Verifier's
  // checkout would have them after the README's setup.
  for (const args of [
    ["build", "--release", "-p", "bountee-judge", "--target", target],
    ["test", "-p", "bountee-judge", "--test", "seam_j_scenarios", "--no-run"],
  ]) {
    const res = spawnSync("cargo", args, { cwd: repo, encoding: "utf8" });
    if (res.status !== 0) throw new Error(res.stderr);
  }
}, 600_000);

test("R15.4 D19: the checker runs every offline README step with no network and each shows its expected output", () => {
  const res = offline(process.execPath, [CHECKER, "--offline", "--json"]);
  expect(res.code, res.stdout + res.stderr).toBe(0);
  const report = JSON.parse(res.stdout) as { steps: { command: string; status: string }[] };

  // Every step the README holds is reported, in order, and every offline one passed.
  const readme = stepsIn(readFileSync(README, "utf8"));
  expect(report.steps.map((s) => s.command)).toStrictEqual(readme.map((s) => s.command));
  readme.forEach((step, i) => {
    if (!step.online) expect(report.steps[i]!.status, step.command).toBe("ok");
  });

  // The no-keys, no-funds path the ticket names comes first and is among them.
  const ran = report.steps.filter((s) => s.status === "ok").map((s) => s.command);
  for (const job of [
    "demo/fixtures/exploit.json",
    "demo/fixtures/cheat.json",
    "demo/fixtures/dvd/truster-exploit.json",
    "cli/test/fixtures/historical/depusdt-levusdc.json",
  ]) {
    expect(ran, job).toContain(`bountee test --job ${job}`);
  }
  expect(report.steps[0]!.command).toBe("bountee test --job demo/fixtures/exploit.json");
}, 600_000);

// The control: a README whose step claims the wrong output fails the checker, naming the step.
test("R15.4 control: a step whose output differs from the README's fails the checker", () => {
  const dir = mkdtempSync(join(tmpdir(), "bountee-readme-"));
  const wrong = join(dir, "README.md");
  writeFileSync(
    wrong,
    readFileSync(README, "utf8").replace(
      /(\$ bountee test --job demo\/fixtures\/cheat\.json\n)verdict: ZERO/,
      "$1verdict: PAYS",
    ),
  );
  expect(readFileSync(wrong, "utf8")).not.toBe(readFileSync(README, "utf8"));
  const res = offline(process.execPath, [CHECKER, "--offline", "--readme", wrong]);
  expect(res.code).toBe(1);
  expect(res.stdout).toMatch(/FAIL\s+bountee test --job demo\/fixtures\/cheat\.json/);
  expect(res.stdout).toContain("verdict: PAYS");
}, 600_000);

// D21: no step offers a live winning claim, or anything else that signs: every step needs no keys.
test("D21: no README step files a claim, posts a bounty or signs anything", () => {
  const signing = /^bountee (claim|post|key|balance|publish|sign-pauses|retry-payout|verify-pause|open-exploit|init)\b/;
  for (const { command } of stepsIn(readFileSync(README, "utf8"))) {
    expect(command, command).not.toMatch(signing);
    expect(command, command).not.toContain("--as ");
  }
});

// Pending mainnet steps are reported, and --strict refuses them, so none can ship unfilled unnoticed.
test("R15.4 ADR-0017: --strict fails while a step waits for mainnet data", () => {
  const dir = mkdtempSync(join(tmpdir(), "bountee-readme-"));
  const pending = join(dir, "README.md");
  writeFileSync(pending, "```console online\n$ bountee verify <MAINNET: demo bounty id> --network mainnet\npass contract_code\n```\n");
  const lax = offline(process.execPath, [CHECKER, "--readme", pending, "--json"]);
  expect(lax.code, lax.stderr).toBe(0);
  expect(JSON.parse(lax.stdout).steps).toStrictEqual([
    { command: "bountee verify <MAINNET: demo bounty id> --network mainnet", status: "pending" },
  ]);
  const strict = offline(process.execPath, [CHECKER, "--readme", pending, "--strict"]);
  expect(strict.code).toBe(1);
  expect(strict.stdout).toMatch(/pending\s+bountee verify/);
});
