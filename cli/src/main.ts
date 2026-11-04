#!/usr/bin/env node
// BounTEE's command-line tool. Commands so far: `--version`, `init` (#16), `test` (ticket #11),
// `broadcast` (ticket #13). The rest (list, show, claim, status, verify, balance, key, open-exploit, withdraw,
// post) land in the CLI tickets; each takes `--json` for machine-readable output (R14.5).
import { readFileSync } from "node:fs";
import { broadcastCommand, formatBroadcastResult, parseRpcFlags } from "./broadcast.ts";
import { initCommand } from "./init.ts";
import { parseNetwork } from "./near.ts";
import { formatTestResult, testCommand } from "./test.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const json = args.includes("--json");
const rest = args.filter((a) => a !== "--json");

const BROADCAST_USAGE =
  "usage: bountee broadcast <protocol>/<name> [--contract <account>] [--near-rpc <url>] [--rpc <chain id>=<url>[,...]] [--wait <secs>] [--json]";
const USAGE = "usage: bountee test <foundry-script>[:<contract>] --bounty <rules.json | protocol/name> [--sig <fn>] [--out <job.json>] [--rpc <url>] [--block <n>] [--judge <wasm>] [--contract <account>] [--json]";

/** Positional arguments and `--name value` flags. */
function parse(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${a} needs a value`);
      flags[a.slice(2)] = v;
      i++;
    } else positional.push(a);
  }
  return { positional, flags };
}

function fail(message: string, code = 1): never {
  console.error(json ? JSON.stringify({ error: message }) : message);
  process.exit(code);
}

try {
  if (rest[0] === "--version") {
    console.log(json ? JSON.stringify({ name: "bountee", version: pkg.version }) : `bountee ${pkg.version}`);
  } else if (rest[0] === "init") {
    const { flags } = parse(rest.slice(1));
    const result = await initCommand({ network: parseNetwork(flags.network), account: flags.account });
    console.log(json ? JSON.stringify(result) : result.message);
  } else if (rest[0] === "test") {
    const { positional, flags } = parse(rest.slice(1));
    const script = positional[0];
    if (!script || !flags.bounty) fail(`test needs a script and --bounty\n${USAGE}`, 2);
    const result = await testCommand({
      script,
      bounty: flags.bounty,
      sig: flags.sig,
      out: flags.out,
      rpc: flags.rpc,
      block: flags.block === undefined ? undefined : Number(flags.block),
      judge: flags.judge,
      contract: flags.contract,
      nearRpc: flags["near-rpc"],
    });
    console.log(json ? JSON.stringify(result) : formatTestResult(result));
  } else if (rest[0] === "broadcast") {
    const { positional, flags } = parse(rest.slice(1));
    const bounty = positional[0];
    if (!bounty) fail(`broadcast needs a bounty id\n${BROADCAST_USAGE}`, 2);
    const result = await broadcastCommand({
      bounty,
      contract: flags.contract,
      nearRpc: flags["near-rpc"],
      rpcs: flags.rpc === undefined ? undefined : parseRpcFlags(flags.rpc.split(",")),
      waitSecs: flags.wait === undefined ? undefined : Number(flags.wait),
    });
    console.log(json ? JSON.stringify(result) : formatBroadcastResult(result));
    if (result.pauses.some((p) => p.sent === "failed")) process.exit(1);
  } else {
    fail(`unknown command: ${rest.join(" ") || "(none)"}`, 2);
  }
} catch (e) {
  fail((e as Error).message);
}
