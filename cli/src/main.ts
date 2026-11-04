#!/usr/bin/env node
// BounTEE's command-line tool. Scaffold only (ticket #6): `--version`. The commands
// (init, list, show, test, claim, status, broadcast, verify, balance, key, open-exploit,
// withdraw, post) land in the CLI tickets; each takes `--json` for machine-readable output.
import { readFileSync } from "node:fs";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const json = args.includes("--json");
const rest = args.filter((a) => a !== "--json");

if (rest[0] === "--version") {
  console.log(json ? JSON.stringify({ name: "bountee", version: pkg.version }) : `bountee ${pkg.version}`);
} else {
  const message = `unknown command: ${rest.join(" ") || "(none)"}`;
  console.error(json ? JSON.stringify({ error: message }) : message);
  process.exit(2);
}
