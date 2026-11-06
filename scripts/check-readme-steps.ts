// Runs every "do X → see Y" step in the README and checks its output (R15.4).
//
//   node scripts/check-readme-steps.ts [--offline] [--strict] [--readme <file>] [--json]
//
// A step is a `$ <command>` line in a ```console block; the lines after it, up to the next `$ `
// line or the block's end, are what its output must show: each must appear in the command's
// stdout and stderr, compared with runs of spaces collapsed. The command runs from the repo root
// under bash, with `bountee` meaning `node cli/src/main.ts`, and must exit 0.
//
// A ```console online block needs the network (but no keys or funds); --offline skips it. A
// step that waits for mainnet data (a ```console pending block, or a command holding a
// `<MAINNET: …>` placeholder) is reported as pending and not run; --strict counts it as a
// failure. Exit status: 0 when every step run passed (and, under --strict, none is pending), 1
// otherwise, 2 for bad arguments.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type Status = "ok" | "FAIL" | "pending" | "skipped";
type Step = { command: string; expect: string[]; online: boolean; pending: boolean };

const repo = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const readmeAt = args.indexOf("--readme");
const readme = readmeAt >= 0 ? args[readmeAt + 1] : `${repo}README.md`;
if (!readme || args.some((a, i) => a.startsWith("--") && !["--offline", "--strict", "--json", "--readme"].includes(a) && args[i - 1] !== "--readme")) {
  console.error("usage: node scripts/check-readme-steps.ts [--offline] [--strict] [--readme <file>] [--json]");
  process.exit(2);
}

/** Every step in the README, in order. */
function steps(markdown: string): Step[] {
  const out: Step[] = [];
  for (const [, info, body] of markdown.matchAll(/^```(console[^\n]*)\n([\s\S]*?)^```/gm)) {
    const tags = info!.split(/\s+/);
    for (const line of body!.split("\n")) {
      if (line.startsWith("$ ")) {
        const command = line.slice(2).trim();
        out.push({ command, expect: [], online: tags.includes("online"), pending: tags.includes("pending") || command.includes("<MAINNET") });
      } else if (line.trim() && out.length) {
        out.at(-1)!.expect.push(line.trim());
      }
    }
  }
  return out;
}

const squash = (s: string) => s.replace(/[ \t]+/g, " ");
const bountee = `bountee() { node ${JSON.stringify(`${repo}cli/src/main.ts`)} "$@"; }`;

const results: { command: string; status: Status; missing?: string[]; output?: string }[] = [];
for (const step of steps(readFileSync(readme, "utf8"))) {
  if (step.pending) {
    results.push({ command: step.command, status: "pending" });
    continue;
  }
  if (step.online && flag("--offline")) {
    results.push({ command: step.command, status: "skipped" });
    continue;
  }
  const res = spawnSync("bash", ["-c", `${bountee}\n${step.command}`], { cwd: repo, encoding: "utf8", timeout: 600_000 });
  const output = squash(`${res.stdout ?? ""}${res.stderr ?? ""}`);
  const missing = step.expect.filter((e) => !output.includes(squash(e)));
  const ok = res.status === 0 && missing.length === 0;
  results.push(ok ? { command: step.command, status: "ok" } : { command: step.command, status: "FAIL", missing, output: `exit ${res.status}\n${output}` });
}

const failed = results.some((r) => r.status === "FAIL" || (r.status === "pending" && flag("--strict")));
if (flag("--json")) {
  console.log(JSON.stringify({ steps: results.map(({ command, status, missing }) => (missing ? { command, status, missing } : { command, status })) }));
} else {
  for (const r of results) {
    console.log(`${r.status.padEnd(8)} ${r.command}`);
    if (r.status === "FAIL") {
      for (const m of r.missing!) console.log(`         expected: ${m}`);
      console.log(r.output!.replace(/^/gm, "         | "));
    }
  }
  const count = (s: Status) => results.filter((r) => r.status === s).length;
  console.log(`\n${count("ok")} ok, ${count("FAIL")} failed, ${count("pending")} pending mainnet data, ${count("skipped")} skipped (online)`);
}
process.exit(failed ? 1 : 0);
