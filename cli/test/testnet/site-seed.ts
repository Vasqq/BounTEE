// Seeds the testnet site's bounty contract (D33, ADR-0021): one bounty from each of six fictional
// Protocols, one per lasting public state, so the testnet site's bounty list reads like a product
// in use. Every bounty covers a fresh PositionVault on each of its chains (the D21 fresh-instance
// script, run once per bounty): four cover Base Sepolia and Arbitrum Sepolia, tallowfen-swap Base
// Sepolia only and lindquay-vaults Arbitrum Sepolia only (Liam's call, Nov 10). Each is worth 1 to
// 3 of Circle's testnet USDC, 12 in all, moved to each Protocol from the funder, and names its own
// minimum theft. Testnet only: nothing here is evidence (ADR-0017).
//
//   lindquay-vaults  Ended unclaimed  its end date a few minutes out, then waited out
//   osterwick-dex    Withdrawn        the same, then `withdraw_bounty` by the Protocol (R10.1)
//   tallowfen-swap   Live             no claims
//   pellmar-stable   Check failed     its vaults never grant the pause role (SKIP_GRANT): the
//                                     posting check fails and its USDC is refunded (R1.6)
//   corvane-perps    Live, 2 judged   a cheat (HonestUser.s.sol) scored ZERO, and the same cheat
//                                     filed from a job over 5 minutes old, scored INVALID
//                                     (stale_block, R2.8)
//   brassmoor-lend   Paid             the sealed exploit proven on Base Sepolia: paid, both
//                                     chains' pauses landed and verified (R7.3)
//
// 0. Preflight (D21's, for every bounty not yet posted, added up): the deployer's ETH on each
//    chain, the funder's USDC (each Protocol's bounty amount, less what it holds) and its NEAR
//    (registering each Protocol on the USDC, and the transfers' gas), each Protocol's NEAR
//    (posting, and withdrawing for the Withdrawn one) and the Whitehat's (its claims, and on the
//    win the pauses' signing and verification). A Protocol or Whitehat not yet created is made by
//    `bountee init`, which NEAR's faucet funds. If any balance is short it stops before anything is
//    created or spent, naming each top-up (exit status 3); PREFLIGHT_ONLY=1 stops here either way.
// 1. Creates the missing accounts with `bountee init`.
// 2. From the funder, registers each Protocol on the USDC and sends it its bounty amount.
// 3. Posts each bounty with fresh-instance.ts (Ended and Withdrawn first, so their end dates pass
//    while the rest run), then files the claims with `bountee test` and `bountee claim`, withdraws,
//    and waits out the end dates.
//
// Each step's result goes into $BOUNTEE_SEED as it lands, and a re-run skips every step already
// there, so a failure part-way never repeats a spend. Each bounty's instance is its own file
// (~/.bountee-testnet/<SITE_PREFIX>-<protocol>-instance.json), and its exploit key and rules are
// <SITE_PREFIX>-<name>-exploit-key.pem and -rules.json; none of the rehearsals' day3-* files is
// read or written.
//
// Env: SITE_PREFIX (names this site's record files, default site2: bounty2.bountee.testnet's; the
// first site's site-* files, on bounty.bountee.testnet, stay as they are), BOUNTEE_SITE
// (deploy-system.ts's record of the site's contract, default
// ~/.bountee-testnet/<SITE_PREFIX>-deployment.json), BOUNTEE_SEED (this run's record, default
// ~/.bountee-testnet/<SITE_PREFIX>-seed.json), FUNDER (holds the USDC, default bountee.testnet), WHITEHAT
// (files the claims, default quellford-sec.testnet), SEALED_EXPLOIT (the sealed exploit script,
// never in this repo; needed for the Paid bounty), DEPLOYER_ENV, CHAIN_RPCS, NEAR_RPC (passed
// to fresh-instance.ts), PREFLIGHT_ONLY=1.
// Run, after deploying the contract keyless from the commit mainnet's is built from:
//   CONTRACT=bounty2.bountee.testnet USDC=<Circle's, below> REV=<commit> \
//     BOUNTEE_DAY3=~/.bountee-testnet/site2-deployment.json node cli/test/testnet/deploy-system.ts
//   node cli/test/testnet/site-seed.ts
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { actions } from "near-api-js";
import { formatNear, roundUpNear, tgas, type PricedCall } from "../../src/near.ts";
import { near, network, need, stopIfShort, type Need } from "./deploy.ts";
import { sealedExploit } from "./sealed-exploit.ts";

if (network !== "testnet") throw new Error("the site seed runs on testnet only (ADR-0021: a testnet site, never evidence)");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const main = join(root, "cli/src/main.ts");
const freshInstance = join(root, "cli/test/testnet/fresh-instance.ts");
const honestUser = join(root, "demo/script/HonestUser.s.sol");
const dir = join(homedir(), ".bountee-testnet");
const PREFIX = process.env.SITE_PREFIX ?? "site2";
const SITE = process.env.BOUNTEE_SITE ?? join(dir, `${PREFIX}-deployment.json`);
const RECORD = process.env.BOUNTEE_SEED ?? join(dir, `${PREFIX}-seed.json`);
for (const f of [SITE, RECORD]) if (basename(f).startsWith("day3-")) throw new Error(`${f}: the seed never touches the rehearsals' day3-* files`);
const deployment = JSON.parse(readFileSync(SITE, "utf8"));
if (deployment.network !== "testnet") throw new Error(`${SITE} is on ${deployment.network}, not testnet`);
const CONTRACT: string = deployment.contract;
/** Circle's USDC on NEAR testnet (spec #71, read Nov 10): what visitors get from Circle's faucet. */
const CIRCLE_TESTNET_USDC = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
const USDC: string = deployment.usdc;
// deploy-system.ts falls back to the rehearsals' stand-in token; the site's contract must take Circle's.
if (USDC !== CIRCLE_TESTNET_USDC) throw new Error(`${SITE} names USDC ${USDC}, not Circle's testnet USDC ${CIRCLE_TESTNET_USDC}`);
const FUNDER = process.env.FUNDER ?? "bountee.testnet";
const WHITEHAT = process.env.WHITEHAT ?? "quellford-sec.testnet";
const BASE_SEPOLIA = 84532;
const ARBITRUM_SEPOLIA = 421614;
const BOTH = [BASE_SEPOLIA, ARBITRUM_SEPOLIA];
/** Claims are proven on Base Sepolia, the chain testnet wins have run on (spec #71). */
const PROOF_CHAIN = BASE_SEPOLIA;
/**
 * The USDC each testnet vault is seeded with (demo/script/Deploy.s.sol's SEED_USDC default, which
 * fresh-instance.ts leaves on testnet): the sealed exploit drains it all, so the Paid bounty's
 * minimum theft must not exceed it.
 */
const TESTNET_VAULT_SEED = 1_000_000n * 1_000_000n;
/** The Ended and Withdrawn bounties' end date, after their posting is built: a few minutes. */
const END_SOON_SECS = 300;
/**
 * What NEAR's faucet service gives an account `bountee init` creates: 10 testnet NEAR, as it gave
 * bountee.testnet on Nov 10.
 */
const FAUCET_NEAR = 10n * 10n ** 24n;
/**
 * 30 days, as the testnet rehearsals of the sealed exploit used (#67): the Paid bounty's exploit
 * must not be publishable on testnet before the mainnet run.
 */
const DISCLOSURE_DELAY_DAYS = "30";
/** How old a job's block must be for the enclave to find it stale (R2.8's 300 s), with margin. */
const STALE_SECS = 360;

type State = "ended" | "withdrawn" | "live" | "check_failed" | "claims_judged" | "paid";
interface Bounty { state: State; protocol: string; name: string; usdc: number; chains: number[]; minimumUsdc: number; claims: number; instance: string }
const bounty = (state: State, protocol: string, name: string, usdc: number, chains: number[], minimumUsdc: number, claims = 0): Bounty => ({
  state, protocol, name, usdc, chains, minimumUsdc, claims, instance: join(dir, `${PREFIX}-${protocol.replace(/\.testnet$/, "")}-instance.json`),
});
// Ended and Withdrawn first: their end dates pass while the rest are posted and claimed. The
// minimum thefts differ, as real Protocols' would: the corvane-perps cheat steals nothing, so it
// stays ZERO under any of them, and the brassmoor-lend win drains its vault's whole seed.
const PLAN: Bounty[] = [
  bounty("ended", "lindquay-vaults.testnet", "yield-vault-q4", 2, [ARBITRUM_SEPOLIA], 1_000),
  bounty("withdrawn", "osterwick-dex.testnet", "orderbook-v2", 2, BOTH, 5_000),
  bounty("live", "tallowfen-swap.testnet", "amm-router", 2, [BASE_SEPOLIA], 500),
  bounty("check_failed", "pellmar-stable.testnet", "stable-reserve", 1, BOTH, 250),
  bounty("claims_judged", "corvane-perps.testnet", "perps-margin", 2, BOTH, 2_500, 2),
  bounty("paid", "brassmoor-lend.testnet", "lending-pool-v3", 3, BOTH, 10_000, 1),
];
const byState = (s: State) => PLAN.find((b) => b.state === s)!;
const id = (b: Bounty) => ({ protocol: b.protocol, name: b.name });
/** The bounty as the command line names it: `<protocol>/<name>`. */
const ref = (b: Bounty) => `${b.protocol}/${b.name}`;
/** The state the contract holds once each is seeded: Ended unclaimed is a live bounty past its end date. */
const CONTRACT_STATE: Record<State, string> = {
  ended: "live", withdrawn: "withdrawn", live: "live", check_failed: "check_failed", claims_judged: "live", paid: "paid",
};
const usdcUnits = (b: Bounty) => BigInt(b.usdc) * 1_000_000n;
const minimumUnits = (b: Bounty) => BigInt(b.minimumUsdc) * 1_000_000n;
// Claims are filed on Base Sepolia, so each bounty that takes one covers it.
for (const b of PLAN.filter((b) => b.claims > 0)) {
  if (!b.chains.includes(PROOF_CHAIN)) throw new Error(`${b.protocol} takes claims proven on chain ${PROOF_CHAIN}, which it doesn't cover`);
}
if (minimumUnits(byState("paid")) > TESTNET_VAULT_SEED) throw new Error("the Paid bounty's minimum theft exceeds what its vault holds: the win would score ZERO");

const record: Record<string, any> = existsSync(RECORD) ? JSON.parse(readFileSync(RECORD, "utf8")) : {};
const save = () => {
  mkdirSync(dirname(RECORD), { recursive: true });
  writeFileSync(RECORD, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
};
/** Run a step once: its result is recorded, and a re-run returns the recorded one. */
async function step<T>(key: string, run: () => Promise<T>): Promise<T> {
  if (record[key] !== undefined) return record[key];
  const result = await run();
  record[key] = result;
  save();
  console.error(`${key}: done`);
  return result;
}

/**
 * Run a node script and read the last JSON line it printed. Its stderr is passed through live,
 * unless `quiet` (a D21 preflight, whose own "SHORT" lines judge one bounty, not the seed's
 * totals): then it is kept for the error if the script fails.
 */
function node(args: string[], env: Record<string, string> = {}, quiet = false): Promise<{ status: number | null; out: any; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (quiet ? (stderr += c) : process.stderr.write(c)));
    child.on("close", (status) => {
      let out: any = {};
      try {
        out = JSON.parse(stdout.trim().split("\n").pop() || "{}");
      } catch {}
      resolve({ status, out, stdout, stderr });
    });
  });
}

/** fresh-instance.ts for `b`: its D21 preflight alone, or the whole run. */
const fresh = (b: Bounty, preflightOnly: boolean) =>
  node([freshInstance], {
    NETWORK: "testnet",
    BOUNTEE_DAY3: SITE,
    BOUNTEE_INSTANCE: b.instance,
    // Its exploit key and rules files, beside the first site's of the same bounty names.
    FILE_PREFIX: `${PREFIX}-`,
    PROTOCOL: b.protocol,
    BOUNTY_NAME: b.name,
    BOUNTY_AMOUNT: usdcUnits(b).toString(),
    MINIMUM_THEFT: minimumUnits(b).toString(),
    CHAINS: b.chains.join(","),
    DISCLOSURE_DELAY_DAYS,
    END_IN_SECS: b.state === "ended" || b.state === "withdrawn" ? String(END_SOON_SECS) : "",
    SKIP_GRANT: b.state === "check_failed" ? "1" : "",
    // The Whitehat's claims are budgeted with the bounty they're filed on.
    WHITEHAT: b.claims > 0 ? WHITEHAT : "",
    CLAIMS: String(b.claims),
    PREFLIGHT_ONLY: preflightOnly ? "1" : "",
  }, preflightOnly);

const posted = (b: Bounty) => existsSync(b.instance) && JSON.parse(readFileSync(b.instance, "utf8")).post_tx !== undefined;
const showNear = (y: bigint) => `${formatNear(y)} NEAR`;
const showUsdc = (x: bigint) => `${Number(x) / 1e6} USDC`;
const showEth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} ETH`;
const show = (asset: string) => (asset === "ETH" ? showEth : asset === "NEAR" ? showNear : showUsdc);

// ---- 0. Preflight ------------------------------------------------------------------------------

// What is left to do, so a re-run checks what its remaining steps spend: a bounty not yet posted
// needs everything; one posted with its claims still to file needs only the Whitehat's share.
const todo = PLAN.filter((b) => !posted(b));
const claimsDone: Partial<Record<State, string>> = { claims_judged: "invalid claim", paid: "paid verified" };
const claimsLeft = (b: Bounty) => b.claims > 0 && record[claimsDone[b.state]!] === undefined;
const exists = new Map<string, boolean>();
for (const who of [...new Set([...PLAN.map((b) => b.protocol), WHITEHAT])]) exists.set(who, (await near.balance(who)) !== null);
const createdByFaucet = [...exists].filter(([, e]) => !e).map(([who]) => who);

const fees = await near.view(CONTRACT, "fees");
/** Each balance the bounties' D21 preflights ask for, added up per payer, chain and asset. */
const totals = new Map<string, { who: string; chain: string; asset: string; have: bigint; need: bigint }>();
/**
 * `withdraw_bounty`'s gas. fees()'s `min_withdraw_bounty_gas` is what the payout's own calls take;
 * the method refuses unless that much is left after its own run and a 10 Tgas tail ("attach more
 * gas", seen live Nov 10 with exactly the minimum), so 30 Tgas more, as `retry_payout` (payout.ts).
 */
const WITHDRAW_GAS = BigInt(fees.min_withdraw_bounty_gas) + tgas(30);
const add = (who: string, chain: string, asset: string, have: bigint, want: bigint) => {
  const key = `${who}|${chain}|${asset}`;
  const t = totals.get(key) ?? { who, chain, asset, have, need: 0n };
  t.need += want;
  totals.set(key, t);
};
/** What each Protocol is sent from the funder: its bounty amount less what it holds. */
const moves: { protocol: string; usdc: bigint; register: boolean }[] = [];
for (const b of PLAN.filter((b) => todo.includes(b) || claimsLeft(b))) {
  const r = await fresh(b, true);
  if (r.status !== 0 && r.status !== 3) throw new Error(`fresh-instance.ts's preflight for ${b.protocol} failed (exit ${r.status}): ${r.stdout}${r.stderr}`);
  // What fresh-instance.ts will post: this bounty's own chains and minimum theft.
  if (r.out.run?.chains?.join(",") !== b.chains.join(",") || r.out.run?.minimum_theft !== minimumUnits(b).toString()) {
    throw new Error(`fresh-instance.ts would post ${b.protocol} on ${r.out.run?.chains} with minimum theft ${r.out.run?.minimum_theft}, not ${b.chains} and ${minimumUnits(b)}`);
  }
  // D21's preflight budgets a cheat and a win for CLAIMS=2; Live with claims judged files two
  // cheats, each drawing less than a win, so its budget errs high.
  for (const n of (r.out.balances as Need[]).filter((n) => todo.includes(b) || n.who === WHITEHAT)) {
    const have = BigInt(n.units.have);
    const want = BigInt(n.units.need);
    if (n.who === b.protocol && n.asset.includes("USDC")) {
      const registered = (await near.view(USDC, "storage_balance_of", { account_id: b.protocol })) !== null;
      moves.push({ protocol: b.protocol, usdc: want > have ? want - have : 0n, register: !registered });
      continue;
    }
    // An account init will create holds what the faucet gives it.
    add(n.who, n.chain, n.asset, n.asset === "NEAR" && exists.get(n.who) === false ? FAUCET_NEAR : have, want);
  }
}
const nearChain = "near-testnet";
const nearOf = (who: string) => [...totals.values()].find((t) => t.who === who && t.asset === "NEAR");
// The Withdrawn bounty's Protocol also calls `withdraw_bounty`, with the gas fees() names.
const withdrawn = byState("withdrawn");
if (record[`withdraw ${withdrawn.protocol}`] === undefined) {
  const gas = roundUpNear(await near.upfrontNear([{ method: "withdraw_bounty", gas: WITHDRAW_GAS, deposit: 0n, argsBytes: 80 }]));
  const free = exists.get(withdrawn.protocol) ? ((await near.freeNear(withdrawn.protocol)) ?? 0n) : FAUCET_NEAR;
  add(withdrawn.protocol, nearChain, "NEAR", free, gas);
}
// The win's pauses: `sign_pauses` if the verdict's callback left them, and one `verify_pause` per chain.
if (claimsLeft(byState("paid")) && nearOf(WHITEHAT)) {
  const contracts = BigInt(byState("paid").chains.length);
  const pauseCalls: PricedCall[] = [
    { method: "sign_pauses", gas: BigInt(fees.min_sign_pauses_gas_base) + BigInt(fees.min_sign_pauses_gas_per_contract) * contracts + tgas(40), deposit: 0n, argsBytes: 80 },
    ...byState("paid").chains.map(() => ({ method: "verify_pause", gas: BigInt(fees.min_verify_pause_gas_base) + BigInt(fees.min_verify_pause_gas_per_pause) + tgas(20), deposit: 0n, argsBytes: 200 })),
  ];
  nearOf(WHITEHAT)!.need += roundUpNear(await near.upfrontNear(pauseCalls));
}
const needs: Need[] = [...totals.values()].map((t) => need(t.who, t.chain, t.asset, t.have, t.need, show(t.asset)));
// The funder: every Protocol's USDC, and each registration's storage deposit and both calls' gas.
const storageMin = BigInt((await near.view<{ min: string }>(USDC, "storage_balance_bounds")).min);
const funderCalls: PricedCall[] = moves.flatMap((m) => [
  ...(m.register ? [{ method: "storage_deposit", gas: tgas(30), deposit: storageMin, argsBytes: 80 }] : []),
  ...(m.usdc > 0n ? [{ method: "ft_transfer", gas: tgas(30), deposit: 1n, argsBytes: 100 }] : []),
]);
needs.push(
  need(FUNDER, nearChain, `test USDC (${USDC})`, BigInt(await near.view<string>(USDC, "ft_balance_of", { account_id: FUNDER })), moves.reduce((s, m) => s + m.usdc, 0n), showUsdc),
  need(FUNDER, nearChain, "NEAR", (await near.freeNear(FUNDER)) ?? 0n, funderCalls.length ? roundUpNear(await near.upfrontNear(funderCalls)) : 0n, showNear),
);
stopIfShort(needs, {
  contract: CONTRACT,
  bounties: PLAN.map((b) => ({ state: b.state, protocol: b.protocol, name: b.name, usdc: b.usdc, chains: b.chains, minimum_theft: minimumUnits(b).toString(), posted: posted(b) })),
  created_by_faucet: createdByFaucet,
  moves: moves.map((m) => ({ ...m, usdc: showUsdc(m.usdc) })),
});
// The win needs the sealed exploit: checked before anything is spent.
if (record["paid claim"] === undefined) sealedExploit();

// ---- 1. Accounts -------------------------------------------------------------------------------

for (const who of createdByFaucet) {
  await step(`init ${who}`, async () => {
    const r = await node([main, "init", "--network", "testnet", "--account", who, "--json"]);
    if (r.status !== 0) throw new Error(`bountee init ${who} failed: ${r.stdout}`);
    return { account_id: r.out.account_id, balance_near: r.out.balance_near };
  });
}

// ---- 2. Each Protocol's USDC, from the funder --------------------------------------------------

for (const m of moves) {
  await step(`usdc ${m.protocol}`, async () => {
    const calls = [
      ...(m.register ? [actions.functionCall("storage_deposit", { account_id: m.protocol, registration_only: true }, tgas(30), storageMin)] : []),
      ...(m.usdc > 0n ? [actions.functionCall("ft_transfer", { receiver_id: m.protocol, amount: m.usdc.toString() }, tgas(30), 1n)] : []),
    ];
    if (calls.length === 0) return { tx: null };
    const r = await near.account(FUNDER).signAndSendTransaction({ receiverId: USDC, actions: calls, waitUntil: "FINAL" });
    return { tx: r.transaction.hash, usdc: m.usdc.toString(), registered: m.register };
  });
}

// ---- 3. The bounties ---------------------------------------------------------------------------

const instance = (s: State) => JSON.parse(readFileSync(byState(s).instance, "utf8"));
const usdcOf = async (who: string) => BigInt(await near.view<string>(USDC, "ft_balance_of", { account_id: who }));
const baseVault = (s: State) => instance(s).chains.find((c: any) => c.chain_id === PROOF_CHAIN).vault as string;
const view = (b: Bounty) => near.view(CONTRACT, "bounty", { id: id(b) });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bountee = (args: string[], env: Record<string, string> = {}) =>
  node([main, ...args, "--contract", CONTRACT, "--network", "testnet", "--json"], env);
const claimAs = ["--as", WHITEHAT, "--chain", String(PROOF_CHAIN)];

for (const b of PLAN) {
  await step(`post ${b.protocol}`, async () => {
    if (!posted(b)) {
      const r = await fresh(b, false);
      if (r.status !== 0) throw new Error(`fresh-instance.ts for ${b.protocol} failed (exit ${r.status})`);
    }
    const i = JSON.parse(readFileSync(b.instance, "utf8"));
    // Check failed sends the bounty amount back to the Protocol in full (R1.6).
    if (b.state === "check_failed" && (await usdcOf(b.protocol)) < usdcUnits(b)) {
      throw new Error(`${ref(b)} failed its check but ${b.protocol} holds ${await usdcOf(b.protocol)} of its ${usdcUnits(b)} USDC units`);
    }
    return { bounty: i.bounty, state: i.state, post_tx: i.post_tx, instance: b.instance };
  });

  if (b.state === "claims_judged") {
    // The stale claim's job, taken now and filed once its block is over 5 minutes old.
    await step("stale job", async () => {
      const job = join(dir, `${PREFIX}-corvane-perps-stale-job.json`);
      const r = await bountee(["test", honestUser, "--bounty", ref(b), "--chain", String(PROOF_CHAIN), "--out", job], { VAULT: baseVault(b.state), AMOUNT: "5000000000" });
      if (r.status !== 0) throw new Error(`bountee test of the cheat failed: ${r.stdout}`);
      return { job, local_verdict: r.out.verdict, block: r.out.block, taken_at_ms: Date.now() };
    });
    // A cheat (a fresh account's deposit then redeem: no theft) scores ZERO (R4.11).
    await step("zero claim", async () => {
      const r = await bountee(["claim", honestUser, "--bounty", ref(b), ...claimAs], { VAULT: baseVault(b.state), AMOUNT: "5000000000" });
      if (r.status !== 0 || r.out.verdict?.outcome !== "ZERO") throw new Error(`the cheat's claim didn't score ZERO: ${r.stdout}`);
      return { claim_id: r.out.claim_id, tx: r.out.tx_hash, verdict: r.out.verdict };
    });
  }
}

// The win, proven on Base Sepolia: paid, and each chain's pause landed and verified (R7.3).
const paid = byState("paid");
const win = await step("paid claim", async () => {
  const r = await bountee(["claim", sealedExploit(), "--bounty", ref(paid), ...claimAs], { VAULT: baseVault("paid") });
  if (r.status !== 0 || r.out.paid !== true) throw new Error(`the winning claim wasn't paid: ${r.stdout}`);
  return { claim_id: r.out.claim_id, tx: r.out.tx_hash, verdict: r.out.verdict, receipt: r.out.receipt, verification: r.out.verification };
});
await step("paid verified", async () => {
  const done = (v: any) => v?.chains?.length === paid.chains.length && v.chains.every((c: any) => c.verified);
  if (done(win.verification)) return win.verification;
  const r = await bountee(["verify-pause", ref(paid), "--as", WHITEHAT, "--wait", "3600"]);
  if (!done(r.out)) throw new Error(`both chains' pauses aren't verified yet: ${r.stdout}`);
  return r.out;
});

// The cheat again, from the job taken at posting: its block is now stale, so INVALID (R2.8).
const judged = byState("claims_judged");
await step("invalid claim", async () => {
  const stale = record["stale job"];
  const wait = stale.taken_at_ms + STALE_SECS * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  const { replay } = JSON.parse(readFileSync(stale.job, "utf8"));
  const exploit = join(dir, `${PREFIX}-corvane-perps-stale-exploit.json`);
  const evidence = join(dir, `${PREFIX}-corvane-perps-stale-evidence.json`);
  writeFileSync(exploit, `${JSON.stringify(replay.exploit)}\n`);
  writeFileSync(evidence, `${JSON.stringify({ block: replay.block, header: replay.header, proofs: replay.proofs })}\n`);
  const r = await bountee(["claim", "--exploit", exploit, "--evidence", evidence, "--bounty", ref(judged), ...claimAs]);
  if (r.status !== 0 || r.out.verdict?.outcome !== "INVALID") throw new Error(`the stale claim didn't score INVALID: ${r.stdout}`);
  return { claim_id: r.out.claim_id, tx: r.out.tx_hash, verdict: r.out.verdict };
});

/** Wait until NEAR's clock passes `b`'s end date. */
async function ended(b: Bounty): Promise<any> {
  for (;;) {
    const v = await view(b);
    const block = await near.rpc<{ header: { timestamp_nanosec: string } }>("block", { finality: "final" });
    if (BigInt(block.header.timestamp_nanosec) > BigInt(v.rules.end_date_ns)) return v;
    await sleep(15_000);
  }
}
await step(`withdraw ${withdrawn.protocol}`, async () => {
  await ended(withdrawn);
  const r = await near.account(withdrawn.protocol).signAndSendTransaction({
    receiverId: CONTRACT,
    actions: [actions.functionCall("withdraw_bounty", { id: id(withdrawn) }, WITHDRAW_GAS, 0n)],
    waitUntil: "FINAL",
  });
  for (let i = 0; (await view(withdrawn)).state !== "withdrawn"; i++) {
    if (i > 40) throw new Error(`${ref(withdrawn)} isn't withdrawn after ${r.transaction.hash}`);
    await sleep(3000);
  }
  return { tx: r.transaction.hash };
});
const unclaimed = byState("ended");
await step(`end ${unclaimed.protocol}`, async () => {
  const v = await ended(unclaimed);
  if (v.state !== "live" || v.winning_claim !== null) throw new Error(`${ref(unclaimed)} is ${v.state}, not ended unclaimed`);
  return { end_date_ns: v.rules.end_date_ns };
});

// ---- What the site shows -----------------------------------------------------------------------

const summary = [];
for (const b of PLAN) {
  const v = await view(b);
  summary.push({ seeded: b.state, bounty: ref(b), chains: b.chains, minimum_theft: v.rules.minimum_theft, contract_state: v.state, end_date_ns: v.rules.end_date_ns, winning_claim: v.winning_claim });
}
record.summary = summary;
save();
const wrong = summary.filter((s) => s.contract_state !== CONTRACT_STATE[s.seeded]);
console.log(JSON.stringify({ ok: wrong.length === 0, contract: CONTRACT, record: RECORD, bounties: summary }));
if (wrong.length > 0) {
  console.error(wrong.map((s) => `${s.bounty} was seeded ${s.seeded} but the contract holds it ${s.contract_state}`).join("\n"));
  process.exit(1);
}
