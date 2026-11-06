// Seam T, ticket #33 rehearsal finding: every command answers `--help` with its usage, in text or
// JSON (R14.5). Motivation: an agent given only the instructions file (R14.6) tries `--help` first.
//
// Catches a command that refuses `--help`, answers with another command's usage, or reads a flag
// its usage shows bare as one taking a value (the bare-flag list drifting from the usages).
// Misses whether a command's usage is complete or accurate: a flag the code takes but the usage
// leaves out goes unnoticed, as does any wrong behaviour of the flags themselves.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const bountee = (args: string[]) => spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 30_000 });

test("R14.5: every command answers --help with its own usage, in text and JSON", () => {
  const help = bountee(["help", "--json"]);
  expect(help.status, help.stderr).toBe(0);
  const { commands } = JSON.parse(help.stdout) as { commands: { name: string; usage: string }[] };
  for (const c of commands) {
    const text = bountee([c.name, "--help"]);
    expect(text.status, `${c.name}: ${text.stderr}`).toBe(0);
    expect(text.stdout, c.name).toContain(c.usage);

    // After other arguments too, and in JSON: the command's usage alone.
    const asJson = bountee([c.name, "demo/x", "--contract", "c.testnet", "--help", "--json"]);
    expect(asJson.status, `${c.name}: ${asJson.stderr}`).toBe(0);
    expect(JSON.parse(asJson.stdout), c.name).toEqual({ command: c.name, usage: c.usage });
  }
  const top = bountee(["--help"]);
  expect(top.status, top.stderr).toBe(0);
  expect(top.stdout).toContain(commands.find((c) => c.name === "test")!.usage);
}, 120_000);

test("R14.5: every flag a usage shows bare is parsed as taking no value", () => {
  const { commands } = JSON.parse(bountee(["help", "--json"]).stdout) as { commands: { name: string; usage: string }[] };
  let checked = 0;
  for (const c of commands) {
    // A flag with no value after it in the usage: `[--json]`, `[--watch [--timeout …]]`.
    for (const [, flag] of c.usage.matchAll(/(--[a-z][a-z-]*)(?=$|[\])|]| [[(|]| --)/g)) {
      if (flag === c.name) continue;
      // Read as taking a value, it would swallow `--help` and fail.
      const r = bountee([c.name, flag!, "--help", "--json"]);
      expect(r.status, `${c.name} ${flag}: ${r.stderr}`).toBe(0);
      expect(JSON.parse(r.stdout), `${c.name} ${flag}`).toEqual({ command: c.name, usage: c.usage });
      checked++;
    }
  }
  expect(checked).toBeGreaterThan(20);
}, 120_000);
