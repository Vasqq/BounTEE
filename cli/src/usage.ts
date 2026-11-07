// Every command's usage, and the flags that take no value. The parsers (main.ts, claim.ts) read
// BARE_FLAGS to tell a bare flag from one followed by its value; `bountee help` prints USAGES.
const NEAR_FLAGS = "[--contract <account>] [--network testnet|mainnet] [--near-rpc <url>]";
/** Every command and its usage; `bountee help` prints them. */
export const USAGES: Record<string, string> = {
  "--version": "bountee --version [--json]",
  help: "bountee help [--json]",
  init: "bountee init [--network testnet|mainnet] [--account <name>.testnet] [--json]",
  list: `bountee list ${NEAR_FLAGS} [--json]`,
  show: `bountee show <protocol>/<name> ${NEAR_FLAGS} [--json]`,
  test: "bountee test <foundry-script>[:<contract>] --bounty <rules.json | protocol/name> [--sig <fn>] [--out <job.json>] [--rpc <url>] [--block <n>] [--judge <wasm>] [--contract <account>] [--network testnet|mainnet] [--near-rpc <url>] [--json]  |  bountee test --job <saved job.json> [--judge <wasm>] [--json]",
  claim:
    "bountee claim [<foundry-script>[:<contract>]] --contract <account> --bounty <protocol>/<name> --as <account> [--sig <fn>] [--job <job.json>] [--exploit <exploit.json> --evidence <evidence.json>] [--network testnet|mainnet] [--rpc <NEAR rpc>] [--proof-rpc <url>] [--chain-rpc <chain id>=<url>[,...]] [--outlayer-api <url>] [--tx-api <url>] [--timeout <secs>] [--interval <secs>] [--no-wait] [--no-broadcast] [--no-verify] [--verify-wait <secs>] [--dry-run] [--json]  |  bountee claim --retry <claim id> --contract <account> --as <account> [--bounty <protocol>/<name>] [--tx <hash>[,...] | --job <job.json> | --evidence <evidence.json>] [--network testnet|mainnet] [--rpc <NEAR rpc>] [--timeout <secs>] [--no-wait] [--no-broadcast] [--no-verify] [--json]",
  status: `bountee status <claim id> ${NEAR_FLAGS} [--rpc <chain id>=<url>[,...]] [--tx <hash>[,...]] [--outlayer-api <url>] [--tx-api <url>] [--watch [--timeout <secs>] [--interval <secs>]] [--json]`,
  post: "bountee post <protocol>/<name> --rules <rules.json> --contract <account> [--network testnet|mainnet] [--near-rpc <url>] [--chain-rpc <chain id>=<url>[,...]] [--no-preflight] [--json]",
  "open-exploit": `bountee open-exploit <protocol>/<name> (--wallet <Ethereum key file> | --key-file <saved exploit key>) [--public-key] [--as <account>] [--out <file>] ${NEAR_FLAGS} [--json]`,
  broadcast: "bountee broadcast <protocol>/<name> [--contract <account>] [--network testnet|mainnet] [--near-rpc <url>] [--rpc <chain id>=<url>[,...]] [--wait <secs>] [--json]",
  key: "bountee key add --contract <account> --as <account> [--allowance <NEAR>] [--out-dir <dir>] [--network testnet|mainnet] [--near-rpc <url>] [--json]  |  bountee key revoke [<public key>] --as <account> [--out-dir <dir>] [--network testnet|mainnet] [--near-rpc <url>] [--json]",
  "verify-pause": `bountee verify-pause <protocol>/<name> --as <account> ${NEAR_FLAGS} [--chain <chain id>] [--rpc <chain id>=<url>[,...]] [--wait <secs>] [--json]`,
  publish: `bountee publish <protocol>/<name> --as <account> [--proofs <saved job.json | proofs.json>] ${NEAR_FLAGS} [--json]`,
  rerun: `bountee rerun <protocol>/<name> [--judge <wasm>] [--out <job.json>] [--proofs <saved job.json | proofs.json>] ${NEAR_FLAGS} [--json]`,
  "sign-pauses": `bountee sign-pauses <protocol>/<name> --as <account> ${NEAR_FLAGS} [--json]`,
  "retry-payout": `bountee retry-payout <protocol>/<name> --as <account> ${NEAR_FLAGS} [--json]`,
  withdraw: `bountee withdraw <USDC> --to <chain>:<address> --as <account> [--network mainnet] [--near-rpc <url>] [--intents-api <url>] [--timeout <secs>] [--json]`,
  balance: `bountee balance [top-up <NEAR> | withdraw [<NEAR>]] --as <account> ${NEAR_FLAGS} [--json]`,
  build: "bountee build --contract <account> [--rev <commit>] [--only judge|contract] [--out-dir <dir>] [--json]",
  verify: `bountee verify <protocol>/<name> ${NEAR_FLAGS} [--rev <commit>] [--judge-wasm <wasm> --contract-wasm <wasm>] [--rpc <chain id>=<url>[,...]] [--tx <hash>[,...]] [--outlayer-api <url>] [--tx-api <url>] [--json]`,
};

/** The flags that take no value; every other `--name` takes the argument after it. */
export const BARE_FLAGS: ReadonlySet<string> = new Set([
  "--help",
  "--version",
  "--json",
  "--watch",
  "--public-key",
  "--no-preflight",
  "--no-wait",
  "--no-broadcast",
  "--no-verify",
  "--dry-run",
]);
