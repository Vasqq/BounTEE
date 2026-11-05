#!/usr/bin/env node
// BounTEE's command-line tool. Commands so far: `--version`, `help`, `init` (#16), `test`
// (ticket #11), `broadcast` (ticket #13), `claim` (sealing and filing, #15; script path,
// verdict, payout and pauses, #16; live progress and receipt, #26), `list`, `show` and
// `status` (#26), `post` (#17), `open-exploit` (#22). The rest (verify, balance, key,
// withdraw) land in the
// CLI tickets. Every command takes `--json` for machine-readable output (R14.5): the result
// as one JSON document on stdout, an error as `{"error": …}` on stderr, and a claim's live
// stages as one JSON line each on stderr.
import { readFileSync } from "node:fs";
import { formatBounty, formatList, listBounties, parseBountyId, showBounty } from "./bounties.ts";
import { broadcastCommand, formatBroadcastResult, parseRpcFlags } from "./broadcast.ts";
import { claim, formatClaimResult } from "./claim.ts";
import { initCommand } from "./init.ts";
import { Near, NEAR_RPC, parseNetwork } from "./near.ts";
import { exploitPublicKey, formatOpenExploit, openExploit } from "./open-exploit.ts";
import { claimStatus, formatStage, formatStatus, loadClaimTxs, watchClaim } from "./status.ts";
import { formatPostResult, post } from "./post.ts";
import { formatReplayResult, formatTestResult, replayJob, testCommand } from "./test.ts";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const args = process.argv.slice(2);
const json = args.includes("--json");
const watch = args.includes("--watch");
const publicKey = args.includes("--public-key");
const rest = args.filter((a) => a !== "--json" && a !== "--watch" && a !== "--public-key");
const noPreflight = rest.includes("--no-preflight");

const NEAR_FLAGS = "[--contract <account>] [--network testnet|mainnet] [--near-rpc <url>]";
/** Every command and its usage; `bountee help` prints them. */
const USAGES: Record<string, string> = {
  "--version": "bountee --version [--json]",
  help: "bountee help [--json]",
  init: "bountee init [--network testnet|mainnet] [--account <name>.testnet] [--json]",
  list: `bountee list ${NEAR_FLAGS} [--json]`,
  show: `bountee show <protocol>/<name> ${NEAR_FLAGS} [--json]`,
  test: "bountee test <foundry-script>[:<contract>] --bounty <rules.json | protocol/name> [--sig <fn>] [--out <job.json>] [--rpc <url>] [--block <n>] [--judge <wasm>] [--contract <account>] [--json]  |  bountee test --job <saved job.json> [--judge <wasm>] [--json]",
  claim:
    "bountee claim [<foundry-script>[:<contract>]] --contract <account> --bounty <protocol>/<name> --as <account> [--sig <fn>] [--job <job.json>] [--exploit <exploit.json> --evidence <evidence.json>] [--network testnet|mainnet] [--rpc <NEAR rpc>] [--proof-rpc <url>] [--chain-rpc <chain id>=<url>[,...]] [--outlayer-api <url>] [--timeout <secs>] [--interval <secs>] [--no-wait] [--no-broadcast] [--dry-run] [--json]",
  status: `bountee status <claim id> ${NEAR_FLAGS} [--rpc <chain id>=<url>[,...]] [--tx <hash>[,...]] [--outlayer-api <url>] [--watch [--timeout <secs>] [--interval <secs>]] [--json]`,
  post: "bountee post <protocol>/<name> --rules <rules.json> --contract <account> [--network testnet|mainnet] [--near-rpc <url>] [--chain-rpc <chain id>=<url>[,...]] [--no-preflight] [--json]",
  "open-exploit": `bountee open-exploit <protocol>/<name> (--wallet <Ethereum key file> | --key-file <saved exploit key>) [--public-key] [--as <account>] [--out <file>] ${NEAR_FLAGS} [--json]`,
  broadcast: "bountee broadcast <protocol>/<name> [--contract <account>] [--near-rpc <url>] [--rpc <chain id>=<url>[,...]] [--wait <secs>] [--json]",
};
const usage = (command: string) => `usage: ${USAGES[command]}`;

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

/** The bounty contract and NEAR connection the read commands share. */
function nearFor(command: string, flags: Record<string, string>) {
  const contract = flags.contract ?? process.env.BOUNTEE_CONTRACT;
  if (!contract) fail(`${command} needs the bounty contract's account: pass --contract or set BOUNTEE_CONTRACT\n${usage(command)}`, 2);
  const network = parseNetwork(flags.network);
  return { contract, network, near: new Near(network, flags["near-rpc"] ?? NEAR_RPC[network]) };
}

const print = (result: unknown, text: string) => console.log(json ? JSON.stringify(result) : text);
const showStage = (s: Parameters<typeof formatStage>[0]) => console.error(json ? JSON.stringify(s) : formatStage(s));

try {
  const command = rest[0];
  if (command === "--version") {
    print({ name: "bountee", version: pkg.version }, `bountee ${pkg.version}`);
  } else if (command === "help" || command === undefined) {
    const commands = Object.entries(USAGES).map(([name, u]) => ({ name, usage: u }));
    print({ commands }, commands.map((c) => c.usage).join("\n"));
  } else if (command === "init") {
    const { flags } = parse(rest.slice(1));
    const result = await initCommand({ network: parseNetwork(flags.network), account: flags.account });
    print(result, result.message);
  } else if (command === "list") {
    const { flags } = parse(rest.slice(1));
    const { near, contract } = nearFor(command, flags);
    const result = await listBounties(near, contract);
    print(result, formatList(result));
  } else if (command === "show") {
    const { positional, flags } = parse(rest.slice(1));
    if (!positional[0]) fail(`show needs a bounty id\n${usage(command)}`, 2);
    const { near, contract } = nearFor(command, flags);
    const result = await showBounty(near, contract, parseBountyId(positional[0]));
    print(result, formatBounty(result));
  } else if (command === "test") {
    const { positional, flags } = parse(rest.slice(1));
    if (flags.job !== undefined) {
      // A saved job (e.g. the demo's demo/fixtures/exploit.json), replayed offline (D19).
      if (positional.length > 0 || flags.bounty !== undefined) fail(`test --job takes no script or --bounty\n${usage(command)}`, 2);
      const result = replayJob({ job: flags.job, judge: flags.judge });
      print(result, formatReplayResult(result));
      process.exit(0);
    }
    const script = positional[0];
    if (!script || !flags.bounty) fail(`test needs a script and --bounty\n${usage(command)}`, 2);
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
    print(result, formatTestResult(result));
  } else if (command === "broadcast") {
    const { positional, flags } = parse(rest.slice(1));
    const bounty = positional[0];
    if (!bounty) fail(`broadcast needs a bounty id\n${usage(command)}`, 2);
    const result = await broadcastCommand({
      bounty,
      contract: flags.contract,
      nearRpc: flags["near-rpc"],
      rpcs: flags.rpc === undefined ? undefined : parseRpcFlags(flags.rpc.split(",")),
      waitSecs: flags.wait === undefined ? undefined : Number(flags.wait),
    });
    print(result, formatBroadcastResult(result));
    if (result.pauses.some((p) => p.sent === "failed")) process.exit(1);
  } else if (command === "status") {
    const { positional, flags } = parse(rest.slice(1));
    const claimId = Number(positional[0]);
    if (!positional[0] || !Number.isSafeInteger(claimId) || claimId < 0) fail(`status needs a claim id\n${usage(command)}`, 2);
    const { near, contract, network } = nearFor(command, flags);
    const o = {
      contract,
      claimId,
      network,
      near,
      rpcs: flags.rpc === undefined ? undefined : parseRpcFlags(flags.rpc.split(",")),
      outlayerApi: flags["outlayer-api"],
      txs: flags.tx === undefined ? loadClaimTxs(contract, claimId) : flags.tx.split(","),
    };
    // Followed live (--watch), each stage goes to stderr as it's reached; stdout carries the
    // final status alone.
    const status = watch
      ? await watchClaim(o, showStage, {
          timeoutSecs: flags.timeout === undefined ? 1800 : Number(flags.timeout),
          intervalSecs: flags.interval === undefined ? undefined : Number(flags.interval),
        })
      : await claimStatus(o);
    print(status, formatStatus(status));
  } else if (command === "post") {
    const { positional, flags } = parse(rest.slice(1).filter((a) => a !== "--no-preflight"));
    const bounty = positional[0];
    if (!bounty || !flags.rules || !flags.contract) fail(`post needs a bounty id, --rules and --contract\n${usage(command)}`, 2);
    const result = await post({
      bounty,
      rules: flags.rules,
      contract: flags.contract,
      network: parseNetwork(flags.network),
      nearRpc: flags["near-rpc"],
      chainRpcs: flags["chain-rpc"] === undefined ? undefined : parseRpcFlags(flags["chain-rpc"].split(",")),
      preflight: !noPreflight,
    });
    print(result, formatPostResult(result));
    if (result.state !== "live") process.exit(1);
  } else if (command === "open-exploit") {
    const { positional, flags } = parse(rest.slice(1));
    if (!positional[0]) fail(`open-exploit needs a bounty id\n${usage(command)}`, 2);
    const { near, contract } = nearFor(command, flags);
    const o = { near, contract, bounty: parseBountyId(positional[0]), wallet: flags.wallet, keyFile: flags["key-file"], as: flags.as, out: flags.out };
    if (publicKey) {
      const r = exploitPublicKey(o);
      print(r, r.exploit_public_key);
    } else {
      const r = await openExploit(o);
      print(r, formatOpenExploit(r));
    }
  } else if (command === "claim") {
    const r = await claim(rest.slice(1), showStage);
    print(r, formatClaimResult(r));
    // A claim with no verdict, or a PAYS whose pause didn't go out, isn't done.
    if (r.state && r.state !== "judged") process.exit(1);
    if (r.broadcast?.pauses.some((p) => p.sent === "failed")) process.exit(1);
  } else {
    fail(`unknown command: ${rest.join(" ")}\n${Object.values(USAGES).join("\n")}`, 2);
  }
} catch (e) {
  fail((e as Error).message);
}
