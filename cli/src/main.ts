#!/usr/bin/env node
// BounTEE's command-line tool. Commands so far: `--version`, `claim` (#15). The others
// (init, list, show, test, status, broadcast, verify, balance, key, open-exploit, withdraw,
// post) land in the CLI tickets; each takes `--json` for machine-readable output.
import { readFileSync } from "node:fs";
import { claim } from "./claim.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const json = args.includes("--json");
const rest = args.filter((a) => a !== "--json");

function fail(message: string): never {
  console.error(json ? JSON.stringify({ error: message }) : message);
  process.exit(2);
}

if (rest[0] === "--version") {
  console.log(json ? JSON.stringify({ name: "bountee", version: pkg.version }) : `bountee ${pkg.version}`);
} else if (rest[0] === "claim") {
  try {
    const r = await claim(rest.slice(1));
    console.log(
      json
        ? JSON.stringify(r)
        : r.claim_id === undefined
          ? `sealed for ${r.bounty_contract} (judge ${r.judge_build_hash}); not filed (--dry-run)`
          : `claim ${r.claim_id} filed: ${r.tx_hash}`,
    );
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  }
} else {
  fail(`unknown command: ${rest.join(" ") || "(none)"}`);
}
