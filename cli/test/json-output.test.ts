// Seam T, ticket #26: every command of the command-line tool offers machine-readable output
// (R14.5), as an agent sees it from the terminal.
//
// Each command's successful JSON result is checked by its own test (init.test.ts, test-live,
// broadcast, sealing, status, status-testnet). This one catches a command added without a
// JSON mode: every command the tool lists takes `--json`, and its failures are JSON too.
// It misses the shape of each success, which those tests check.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const bountee = (args: string[]) => spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 30_000 });

test("R14.5: every command the tool lists takes --json, and fails in JSON", () => {
  const help = bountee(["help", "--json"]);
  expect(help.status, help.stderr).toBe(0);
  const { commands } = JSON.parse(help.stdout);
  // The commands built so far (spec, "The command-line tool"); later tickets add the rest.
  const names = commands.map((c: { name: string }) => c.name);
  expect(names).toEqual(expect.arrayContaining(["init", "list", "show", "test", "claim", "status", "broadcast"]));
  for (const c of commands) {
    expect(c.usage, c.name).toContain("--json");
    if (c.name === "help" || c.name === "--version") {
      const r = bountee([c.name, "--json"]);
      expect(r.status, c.name).toBe(0);
      expect(() => JSON.parse(r.stdout), c.name).not.toThrow();
      continue;
    }
    // A flag with no value: refused before anything leaves the machine, as JSON.
    const r = bountee([c.name, "--contract", "--json"]);
    expect(r.status, `${c.name}: ${r.stdout}`).not.toBe(0);
    expect(JSON.parse(r.stderr), c.name).toHaveProperty("error");
    expect(r.stdout, c.name).toBe("");
  }
  // One node start per command, about 20 of them: half a second each on a CI runner.
}, 120_000);
