#!/usr/bin/env node
// BounTEE's command-line tool. Commands so far: `--version`, `help`, `init` (#16), `test`
// (ticket #11), `broadcast` (ticket #13), `claim` (sealing and filing, #15; script path,
// verdict, payout and pauses, #16; live progress and receipt, #26), `list`, `show` and
// `status` (#26), `post` (#17), `verify-pause` (#21), `open-exploit` (#22), `publish` and
// `rerun` (#23), `key` (#25), `verify` and `build` (#24), `balance`, `sign-pauses`,
// `retry-payout` and `claim --retry` (review fixes). The rest (withdraw) land in the CLI tickets.
// Every command takes `--json` for
// machine-readable output (R14.5): the result
// as one JSON document on stdout, an error as `{"error": …}` on stderr, and a claim's live
// stages as one JSON line each on stderr.
import { readFileSync } from "node:fs";
import { balanceCommand, formatBalanceResult } from "./balance.ts";
import { formatBounty, formatList, listBounties, parseBountyId, showBounty } from "./bounties.ts";
import { formatBuildResult, reproducibleBuild } from "./build.ts";
import { broadcastCommand, formatBroadcastResult, parseRpcFlags } from "./broadcast.ts";
import { claim, formatClaimResult } from "./claim.ts";
import { initCommand } from "./init.ts";
import { formatKeyAdd, formatKeyRevoke, keyAdd, keyRevoke } from "./keys.ts";
import { NEAR_RPC } from "./endpoints.ts";
import { Near, parseNetwork } from "./near.ts";
import { exploitPublicKey, formatOpenExploit, openExploit } from "./open-exploit.ts";
import { claimStatus, formatStage, formatStatus, loadClaimTxs, watchClaim } from "./status.ts";
import { formatRetryResult, retryPayout, signPauses } from "./payout.ts";
import { formatPostResult, post } from "./post.ts";
import { formatPublishResult, formatRerunResult, publishExploit, rerunPublished } from "./publish.ts";
import { formatReplayResult, formatTestResult, replayJob, testCommand } from "./test.ts";
import { formatVerifyResult as formatVerifyPauses, verifyPauses } from "./verify-pause.ts";
import { formatVerifyResult, verify } from "./verify.ts";

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
  test: "bountee test <foundry-script>[:<contract>] --bounty <rules.json | protocol/name> [--sig <fn>] [--out <job.json>] [--rpc <url>] [--block <n>] [--judge <wasm>] [--contract <account>] [--network testnet|mainnet] [--near-rpc <url>] [--json]  |  bountee test --job <saved job.json> [--judge <wasm>] [--json]",
  claim:
    "bountee claim [<foundry-script>[:<contract>]] --contract <account> --bounty <protocol>/<name> --as <account> [--sig <fn>] [--job <job.json>] [--exploit <exploit.json> --evidence <evidence.json>] [--network testnet|mainnet] [--rpc <NEAR rpc>] [--proof-rpc <url>] [--chain-rpc <chain id>=<url>[,...]] [--outlayer-api <url>] [--timeout <secs>] [--interval <secs>] [--no-wait] [--no-broadcast] [--no-verify] [--verify-wait <secs>] [--dry-run] [--json]  |  bountee claim --retry <claim id> --contract <account> --as <account> [--bounty <protocol>/<name>] [--tx <hash>[,...] | --job <job.json> | --evidence <evidence.json>] [--network testnet|mainnet] [--rpc <NEAR rpc>] [--timeout <secs>] [--no-wait] [--no-broadcast] [--no-verify] [--json]",
  status: `bountee status <claim id> ${NEAR_FLAGS} [--rpc <chain id>=<url>[,...]] [--tx <hash>[,...]] [--outlayer-api <url>] [--watch [--timeout <secs>] [--interval <secs>]] [--json]`,
  post: "bountee post <protocol>/<name> --rules <rules.json> --contract <account> [--network testnet|mainnet] [--near-rpc <url>] [--chain-rpc <chain id>=<url>[,...]] [--no-preflight] [--json]",
  "open-exploit": `bountee open-exploit <protocol>/<name> (--wallet <Ethereum key file> | --key-file <saved exploit key>) [--public-key] [--as <account>] [--out <file>] ${NEAR_FLAGS} [--json]`,
  broadcast: "bountee broadcast <protocol>/<name> [--contract <account>] [--network testnet|mainnet] [--near-rpc <url>] [--rpc <chain id>=<url>[,...]] [--wait <secs>] [--json]",
  key: "bountee key add --contract <account> --as <account> [--allowance <NEAR>] [--out-dir <dir>] [--network testnet|mainnet] [--near-rpc <url>] [--json]  |  bountee key revoke [<public key>] --as <account> [--out-dir <dir>] [--network testnet|mainnet] [--near-rpc <url>] [--json]",
  "verify-pause": `bountee verify-pause <protocol>/<name> --as <account> ${NEAR_FLAGS} [--chain <chain id>] [--rpc <chain id>=<url>[,...]] [--wait <secs>] [--json]`,
  publish: `bountee publish <protocol>/<name> --as <account> [--proofs <saved job.json | proofs.json>] ${NEAR_FLAGS} [--json]`,
  rerun: `bountee rerun <protocol>/<name> [--judge <wasm>] [--out <job.json>] [--proofs <saved job.json | proofs.json>] ${NEAR_FLAGS} [--json]`,
  "sign-pauses": `bountee sign-pauses <protocol>/<name> --as <account> ${NEAR_FLAGS} [--json]`,
  "retry-payout": `bountee retry-payout <protocol>/<name> --as <account> ${NEAR_FLAGS} [--json]`,
  balance: `bountee balance [top-up <NEAR> | withdraw [<NEAR>]] --as <account> ${NEAR_FLAGS} [--json]`,
  build: "bountee build --contract <account> [--rev <commit>] [--only judge|contract] [--out-dir <dir>] [--json]",
  verify: `bountee verify <protocol>/<name> ${NEAR_FLAGS} [--rev <commit>] [--judge-wasm <wasm> --contract-wasm <wasm>] [--rpc <chain id>=<url>[,...]] [--tx <hash>[,...]] [--outlayer-api <url>] [--tx-api <url>] [--json]`,
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

/** The NEAR connection `--network` and `--near-rpc` name: every command's one way to NEAR. */
function nearConnection(flags: Record<string, string>): Near {
  const network = parseNetwork(flags.network);
  return new Near(network, flags["near-rpc"] ?? NEAR_RPC[network]);
}

/** The bounty contract and NEAR connection the read commands share. */
function nearFor(command: string, flags: Record<string, string>) {
  const contract = flags.contract ?? process.env.BOUNTEE_CONTRACT;
  if (!contract) fail(`${command} needs the bounty contract's account: pass --contract or set BOUNTEE_CONTRACT\n${usage(command)}`, 2);
  const near = nearConnection(flags);
  return { contract, network: near.network, near };
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
      near: nearConnection(flags),
    });
    print(result, formatTestResult(result));
  } else if (command === "broadcast") {
    const { positional, flags } = parse(rest.slice(1));
    const bounty = positional[0];
    if (!bounty) fail(`broadcast needs a bounty id\n${usage(command)}`, 2);
    const result = await broadcastCommand({
      bounty,
      contract: flags.contract,
      near: nearConnection(flags),
      rpcs: flags.rpc === undefined ? undefined : parseRpcFlags(flags.rpc.split(",")),
      waitSecs: flags.wait === undefined ? undefined : Number(flags.wait),
    });
    print(result, formatBroadcastResult(result));
    if (result.pauses.some((p) => p.sent === "failed")) process.exit(1);
  } else if (command === "verify-pause") {
    const { positional, flags } = parse(rest.slice(1));
    if (!positional[0] || !flags.as) fail(`verify-pause needs a bounty id and --as\n${usage(command)}`, 2);
    const bounty = parseBountyId(positional[0]);
    const { near, contract } = nearFor(command, flags);
    const result = await verifyPauses({
      near,
      contract,
      bounty,
      signer: flags.as,
      rpcs: flags.rpc === undefined ? undefined : parseRpcFlags(flags.rpc.split(",")),
      chains: flags.chain === undefined ? undefined : [Number(flags.chain)],
      waitSecs: flags.wait === undefined ? undefined : Number(flags.wait),
    });
    print(result, formatVerifyPauses(result));
    if (result.chains.some((c) => !c.verified)) process.exit(1);
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
  } else if (command === "key") {
    const { positional, flags } = parse(rest.slice(1));
    const near = nearConnection(flags);
    if (positional[0] === "add") {
      const contract = flags.contract ?? process.env.BOUNTEE_CONTRACT;
      if (!contract || !flags.as) fail(`key add needs --contract and --as\n${usage(command)}`, 2);
      const r = await keyAdd({ near, contract, account: flags.as, allowance: flags.allowance, outDir: flags["out-dir"] });
      print(r, formatKeyAdd(r));
    } else if (positional[0] === "revoke") {
      if (!flags.as) fail(`key revoke needs --as\n${usage(command)}`, 2);
      const r = await keyRevoke({ near, account: flags.as, publicKey: positional[1], outDir: flags["out-dir"] });
      print(r, formatKeyRevoke(r));
    } else fail(`key takes add or revoke\n${usage(command)}`, 2);
  } else if (command === "publish") {
    const { positional, flags } = parse(rest.slice(1));
    if (!positional[0] || !flags.as) fail(`publish needs a bounty id and --as\n${usage(command)}`, 2);
    const { near, contract } = nearFor(command, flags);
    const r = await publishExploit({ near, contract, bounty: parseBountyId(positional[0]), as: flags.as, proofs: flags.proofs });
    print(r, formatPublishResult(r));
  } else if (command === "rerun") {
    const { positional, flags } = parse(rest.slice(1));
    if (!positional[0]) fail(`rerun needs a bounty id\n${usage(command)}`, 2);
    const { near, contract } = nearFor(command, flags);
    const r = await rerunPublished({ near, contract, bounty: parseBountyId(positional[0]), judge: flags.judge, out: flags.out, proofs: flags.proofs });
    print(r, formatRerunResult(r));
    if (!r.same_verdict) process.exit(1);
  } else if (command === "sign-pauses" || command === "retry-payout") {
    const { positional, flags } = parse(rest.slice(1));
    if (!positional[0] || !flags.as) fail(`${command} needs a bounty id and --as\n${usage(command)}`, 2);
    const bounty = parseBountyId(positional[0]);
    const { near, contract } = nearFor(command, flags);
    const o = { near, contract, bounty, signer: flags.as };
    const r = command === "sign-pauses" ? await signPauses(o) : await retryPayout(o);
    print(r, formatRetryResult(command === "sign-pauses" ? "sign_pauses" : "retry_payout", r));
    if (r.refused) process.exit(1);
  } else if (command === "balance") {
    const { positional, flags } = parse(rest.slice(1));
    const [sub, amount] = positional;
    const action = sub === undefined ? "show" : sub === "top-up" ? "top_up" : sub === "withdraw" ? "withdraw" : undefined;
    if (!action || !flags.as || (action === "top_up" && amount === undefined) || (action === "show" && amount !== undefined)) {
      fail(`balance takes nothing, top-up <NEAR> or withdraw [<NEAR>], and --as\n${usage(command)}`, 2);
    }
    const { near, contract } = nearFor(command, flags);
    const r = await balanceCommand({ near, contract, account: flags.as, action, amount });
    print(r, formatBalanceResult(r));
  } else if (command === "build") {
    const { flags } = parse(rest.slice(1));
    const pin = flags.contract ?? process.env.BOUNTEE_CONTRACT;
    if (!pin) fail(`build needs the bounty contract the judge answers to: pass --contract\n${usage(command)}`, 2);
    if (flags.only !== undefined && flags.only !== "judge" && flags.only !== "contract") fail(`--only is judge or contract\n${usage(command)}`, 2);
    const r = reproducibleBuild({ pin, rev: flags.rev, outDir: flags["out-dir"], only: flags.only as "judge" | "contract" | undefined });
    print(r, formatBuildResult(r));
  } else if (command === "verify") {
    const { positional, flags } = parse(rest.slice(1));
    if (!positional[0]) fail(`verify needs a bounty id\n${usage(command)}`, 2);
    const { near, contract, network } = nearFor(command, flags);
    const r = await verify({
      near,
      network,
      contract,
      bounty: parseBountyId(positional[0]),
      rev: flags.rev,
      judgeWasm: flags["judge-wasm"],
      contractWasm: flags["contract-wasm"],
      rpcs: flags.rpc ? parseRpcFlags(flags.rpc.split(",")) : undefined,
      txs: flags.tx ? flags.tx.split(",") : undefined,
      outlayerApi: flags["outlayer-api"],
      txApi: flags["tx-api"],
    });
    print(r, formatVerifyResult(r));
    if (!r.passed) process.exit(1);
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
