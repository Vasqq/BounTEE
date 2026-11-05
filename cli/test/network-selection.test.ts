// Seam T, ticket #43: every command of the tool (the commands R14.5 lists) given `--network
// mainnet` reads NEAR mainnet and the mainnet chains, with no testnet default left (ADR-0017).
//
// Seams (written before the first test): T, the `bountee` command line run as a process with
// `fetch` replaced by a recorder (`fetch-recorder.mjs`) that notes every URL asked and answers
// each with an error, so nothing is read or sent anywhere.
//   Catches: a command that reaches NEAR testnet, a testnet API or a testnet chain when given
//   `--network mainnet` (`test` and `broadcast` did), or that asks nothing at all.
//   Misses: what each command does with a real answer (the per-command tests, and the mainnet
//   run itself, #35), and chain reads that come only after a NEAR answer the recorder never gives.
// - A seam outside the five, at the judge's pinned table (`judge/src/confirm.rs` `MAINNET`): the
//   tool names the RPCs a mainnet judge build trusts (`judgeRpcs`, shown as a trusted party), so
//   both sides must list the same ones; the Rust source is the only place that list lives.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair } from "near-api-js";
import { expect, test } from "vitest";
import { CHAINS } from "../src/chains.ts";
import { ARCHIVAL_RPC, KEYSTORE_API, NEAR_RPC, TX_API } from "../src/endpoints.ts";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const recorder = fileURLToPath(new URL("./fetch-recorder.mjs", import.meta.url));
const confirmRs = fileURLToPath(new URL("../../judge/src/confirm.rs", import.meta.url));
const rulesFile = fileURLToPath(new URL("../../judge/tests/fixtures/rules.json", import.meta.url));

const CONTRACT = "bounty.bountee.near";
const BOUNTY = "protocol.near/vault";
const WHITEHAT = "whitehat.near";
const MAINNET = ["--contract", CONTRACT, "--network", "mainnet"];

/** Every mainnet origin the tool may reach: NEAR's RPCs and APIs, and the mainnet chains' RPCs. */
const mainnetOrigins = new Set(
  [
    NEAR_RPC.mainnet,
    ARCHIVAL_RPC.mainnet,
    TX_API.mainnet,
    KEYSTORE_API.mainnet,
    ...[8453, 42161].flatMap((id) => [...CHAINS[id]!.rpcs, ...CHAINS[id]!.proofRpcs]),
  ].map((u) => new URL(u).origin),
);

/** Each command, given `--network mainnet`, as far as its first answer. */
const COMMANDS: [string, string[]][] = [
  ["list", ["list", ...MAINNET]],
  ["show", ["show", BOUNTY, ...MAINNET]],
  ["test", ["test", "Exploit.s.sol", "--bounty", BOUNTY, ...MAINNET]],
  ["claim", ["claim", "Exploit.s.sol", "--bounty", BOUNTY, "--as", WHITEHAT, ...MAINNET]],
  ["status", ["status", "0", "--tx", "9Ld3WhcY2ZVDS6fZyZW4o7Nc9Y5dPhWv4tyUfEhVvBVa", ...MAINNET]],
  ["post", ["post", BOUNTY, "--rules", rulesFile, ...MAINNET, "--no-preflight"]],
  ["open-exploit", ["open-exploit", BOUNTY, "--key-file", rulesFile, ...MAINNET]],
  ["broadcast", ["broadcast", BOUNTY, ...MAINNET]],
  ["key add", ["key", "add", "--as", WHITEHAT, ...MAINNET]],
  ["key revoke", ["key", "revoke", "--as", WHITEHAT, "--network", "mainnet"]],
  ["verify-pause", ["verify-pause", BOUNTY, "--as", WHITEHAT, ...MAINNET]],
  ["publish", ["publish", BOUNTY, "--as", WHITEHAT, ...MAINNET]],
  ["rerun", ["rerun", BOUNTY, ...MAINNET]],
  ["sign-pauses", ["sign-pauses", BOUNTY, "--as", WHITEHAT, ...MAINNET]],
  ["retry-payout", ["retry-payout", BOUNTY, "--as", WHITEHAT, ...MAINNET]],
  ["balance", ["balance", "--as", WHITEHAT, ...MAINNET]],
  ["verify", ["verify", BOUNTY, ...MAINNET]],
];

/** Run `bountee <args>` under the recorder; the URLs it asked for. */
function asked(args: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "bountee-network-"));
  const log = join(dir, "fetch.log");
  writeFileSync(log, "");
  // A key for the Whitehat, so signing commands get as far as their first read; `key revoke`
  // reads it where `key add` saves a claim key (which refuses to overwrite one).
  const key = KeyPair.fromRandom("ed25519");
  const file = JSON.stringify({ account_id: WHITEHAT, public_key: key.getPublicKey().toString(), private_key: key.toString() });
  const keyDir = args[1] === "revoke" ? join(dir, ".bountee", "claim-keys", "mainnet") : dir;
  mkdirSync(keyDir, { recursive: true });
  writeFileSync(join(keyDir, `${WHITEHAT}.json`), file);
  spawnSync(process.execPath, ["--import", recorder, entry, ...args, "--json"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, BOUNTEE_FETCH_LOG: log, BOUNTEE_CREDENTIALS_DIR: dir, HOME: dir, BOUNTEE_CONTRACT: "" },
  });
  return readFileSync(log, "utf8").split("\n").filter(Boolean);
}

for (const [name, args] of COMMANDS) {
  /** R14.5's commands (#43; ADR-0017): the command reads NEAR mainnet, and nothing on testnet. */
  test(`${name} --network mainnet reads mainnet only`, () => {
    const urls = asked(args);
    expect(urls.map((u) => new URL(u).origin)).toContain(new URL(NEAR_RPC.mainnet).origin);
    for (const url of urls) expect(mainnetOrigins, url).toContain(new URL(url).origin);
  });
}

/** D18: `init --network mainnet` makes a local key and asks nothing of testnet's faucet. */
test("init --network mainnet asks nothing of testnet", () => {
  expect(asked(["init", "--network", "mainnet"])).toEqual([]);
});

/** R2.8: the tool shows the judge's pinned RPCs for Base and Arbitrum One, as the mainnet build pins them. */
test("the mainnet chains carry the judge build's pinned RPCs", () => {
  const source = readFileSync(confirmRs, "utf8");
  const mainnet = source.slice(source.indexOf("const MAINNET"), source.indexOf("];", source.indexOf("const MAINNET")));
  for (const id of [8453, 42161]) {
    const entry = mainnet.slice(mainnet.indexOf(`${id},`));
    const pinned = [...entry.matchAll(/"(https:[^"]+)"/g)].slice(0, 3).map((m) => m[1]);
    expect(CHAINS[id]!.judgeRpcs).toEqual(pinned);
  }
});
