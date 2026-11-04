// Seam T: the command-line tool driven from the terminal, as a Whitehat or an agent runs
// it. Tests spawn the real `bountee` entry point and read its output; chain state is read
// back with `cast` and NEAR RPC, never through the tool's own internals.
//
// Add a T test with `bountee([...args])` and assert on stdout / the exit code. Testnet
// scripts and fixtures go in cli/test/fixtures/.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

function bountee(args: string[]) {
  const res = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8" });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

// Ticket #6 smoke: the tool runs from the terminal and answers in machine-readable JSON
// (user story 46).
test("smoke: bountee --version --json prints its name and version as JSON", () => {
  const { code, stdout } = bountee(["--version", "--json"]);
  expect(code).toBe(0);
  expect(JSON.parse(stdout)).toStrictEqual({ name: "bountee", version: "0.1.0" });
});

test("smoke: an unknown command fails with a non-zero exit code", () => {
  const { code } = bountee(["no-such-command"]);
  expect(code).not.toBe(0);
});
