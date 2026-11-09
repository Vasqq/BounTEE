// Seam T, ticket #24 (offline): a Verifier runs `bountee verify <protocol>/<name>` with no keys
// and no funds and gets pass, fail, "not yet" or "not yet published" for each layer (R15.1).
//
// Seams (written before the first test; also in the ticket's findings): T here drives the
// tool against local stand-ins for NEAR's RPC (the bounty contract's views, the account's code
// hash, OutLayer's register contract, transactions and blocks), FastNEAR's explorer API (the
// contract's transactions: an indexer, which may lie), an EVM RPC (pause receipts) and
// OutLayer's attestation API. Deployment 1 is the #67 testnet gate's real record
// (fixtures/verify/rehearsal-win-*.json, written by record-claim.ts): the winning claim, proven
// on Arbitrum Sepolia on a bounty covering Base Sepolia too (a chained block, ADR-0020), its
// views, its transaction as the explorer lists it and as NEAR's archival RPC gives it
// (`EXPERIMENTAL_tx_status`, with the block its job was requested in), OutLayer's attestation
// (an Intel-signed TDX quote) and both chains' pause receipts, as read from testnet on Nov 9.
// Deployment "bounty.bountee.testnet" is the judge's
// committed fixture, with a publication the compiled judge's `publish` action wrote. The
// rebuilt artefacts are passed in (`--judge-wasm`, `--contract-wasm`), so no Docker build runs
// here; the live test (verify-testnet.test.ts) runs the real rebuild. Catches: R15.1 per layer,
// each passing and failing (attestation: quote chain, report data, measurements, pinned build,
// secret, output; rebuilt judge hash; payout; each pause landed and verified; the re-run, and
// "not yet published" before publication; a re-run under another build than the pinned one
// fails; a lying explorer can make neither the payout nor the attestation pass, since what it
// lists is read again from NEAR RPC), with no keys on disk and no transaction sent; R15.2's
// comparison of the code hash; R14.5. Misses: real chains, OutLayer and the Docker rebuild
// (live test).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58 } from "@scure/base";
import { afterAll, beforeAll, expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const judgeFixtures = new URL("../../judge/tests/fixtures/", import.meta.url);
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`fixtures/verify/${name}`, import.meta.url), "utf8"));
const dir = mkdtempSync(join(tmpdir(), "bountee-verify-"));
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const codeHash = (b: Buffer) => base58.encode(createHash("sha256").update(b).digest());

// ---- Deployment 1: the #67 gate's record (the win proven on Arbitrum Sepolia, paid, both chains' pauses landed) ----
const win = fixture("rehearsal-win-views.json");
const WIN = win.contract as string;
const WIN_BOUNTY = win.bounty.id;
const CLAIM = win.claim_id as number;
const winTx = fixture("rehearsal-win-tx.json");
const winRpc = fixture("rehearsal-win-rpc.json");
const winAttestation = fixture("rehearsal-win-attestation.json");
const [REQUEST_BLOCK, REQUEST_HEIGHT] = Object.entries(winRpc.blocks as Record<string, { height: number }>).map(([b, { height }]) => [b, height] as const)[0]!;
// Another height than the one NEAR gives for the job request's block.
const OTHER_HEIGHT = REQUEST_HEIGHT - 1;
const BASE = 84532;
const ARBITRUM = 421614;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pauseOn = (chain: number) => win.bounty.signed_pauses.find((p: any) => p.chain_id === chain);
// The variants below change the pause on the proof chain; Base's stays as recorded.
const PAUSE = pauseOn(ARBITRUM);
const BASE_PAUSE = pauseOn(BASE);
const MEASUREMENTS = {
  mrtd: "7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173",
  rtmr0: "573aadb4d478839c803c4b1d3e03dd748976b63a89622f377e32a54dd60546e88ec2097f595ceafc324f48a0d0d31db6",
  rtmr1: "e7b3ffa0e72b50557d85f7ecd8dc98a4ffc3dd6f82d01f122ef522d61361abeac310d70d2877e56be9c9408d9bcc320c",
  rtmr2: "764489f277a8540189761e72b4238ba36d4d647e11bd958d8ab5522af2a4867b0ff63e06b0c4967f1857236244040a5d",
  rtmr3: "b1773e4dd9db7e54c2564f15913872cb6a8acd6ce6d4e28dc4008c6b90f6dfec43eae5021d3055a1917fe7360d73dcc9",
};

// ---- Deployment 2: the judge's committed fixture, published (default judge build's contract) ----
const FIXTURE = "bounty.bountee.testnet";
const PROTOCOL = "protocol.testnet";
const WHITEHAT = "alice.testnet";
const rules = JSON.parse(readFileSync(new URL("rules.json", judgeFixtures), "utf8"));
const state = JSON.parse(readFileSync(new URL("state.json", judgeFixtures), "utf8"));
const proofsText = JSON.stringify(state.proofs);
const PAYS = { outcome: "PAYS", reason: "minimum_theft_reached" };

function judgeWasm(): string {
  const target = readFileSync(join(repo, "judge/wasm-target"), "utf8").trim();
  const wasm = join(repo, `target/${target}/release/bountee-judge.wasm`);
  const env = { ...process.env };
  delete env.BOUNTEE_BOUNTY_CONTRACT;
  const b = spawnSync("cargo", ["build", "--release", "-p", "bountee-judge", "--target", target], { cwd: repo, stdio: "inherit", env });
  expect(b.status).toBe(0);
  expect(existsSync(wasm)).toBe(true);
  return wasm;
}

/** The judge's publication of the drain exploit, as OutLayer runs it for the bounty contract. */
function publish(wasm: string, name: string): string {
  const secret = readFileSync(new URL("sealed/alice-drain.txt", judgeFixtures), "utf8").trim();
  const job = { publish: { bounty: { protocol: PROTOCOL, name }, claim_id: 3, whitehat: WHITEHAT } };
  const run = spawnSync("wasmtime", ["run", "-S", "http", "--env", `NEAR_PREDECESSOR_ID=${FIXTURE}`, "--env", `BOUNTEE_SEALED_EXPLOIT=${secret}`, "--", wasm], {
    input: JSON.stringify(job),
    encoding: "utf8",
  });
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout).published;
}

/** The same program with one more custom section: another build, with another hash. */
function anotherBuild(wasm: string): string {
  const name = Buffer.from("bountee-test");
  const payload = Buffer.from("another build");
  const section = Buffer.concat([Buffer.from([0, 1 + name.length + payload.length, name.length]), name, payload]);
  const out = join(dir, "another-judge.wasm");
  writeFileSync(out, Buffer.concat([readFileSync(wasm), section]));
  return out;
}

// ---- The stand-ins -------------------------------------------------------------------------

/** account → view method → (args) → result. */
const views: Record<string, Record<string, (args: any) => unknown>> = {};
const codeHashes: Record<string, string> = {};
/** account → transaction hashes in its history, newest first. */
const histories: Record<string, string[]> = {};
const transactions: Record<string, unknown> = {};
/** What NEAR RPC holds: transactions by hash (`EXPERIMENTAL_tx_status`) and blocks by hash. */
const nearTxs: Record<string, any> = {};
const blocks: Record<string, { height: number }> = {};
const receipts: Record<string, unknown> = {};
const attestations: Record<string, unknown> = {};
let measurementsApproved = true;
/** Anything the tool tried to send: verify must send nothing (no funds). */
const sent: string[] = [];

let base: string;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const reply = (x: unknown, status = 200) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(x));
    };
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/attestations/by-tx/")) {
      const a = attestations[url.slice("/attestations/by-tx/".length)];
      return a ? reply(a) : reply({ error: "not found" }, 404);
    }
    const msg = JSON.parse(body || "{}");
    if (url === "/v0/account") return reply({ account_txs: (histories[msg.account_id] ?? []).map((h) => ({ transaction_hash: h })) });
    if (url === "/v0/transactions") return reply({ transactions: msg.tx_hashes.map((h: string) => transactions[h] ?? null) });
    if (url === "/evm") return reply({ jsonrpc: "2.0", id: msg.id, result: receipts[msg.params[0]] ?? null });
    // NEAR RPC
    const p = msg.params;
    if (msg.method === "EXPERIMENTAL_tx_status") {
      const t = nearTxs[p.tx_hash];
      if (!t || t.transaction.signer_id !== p.sender_account_id) {
        return reply({ jsonrpc: "2.0", id: msg.id, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_TRANSACTION" } } });
      }
      return reply({ jsonrpc: "2.0", id: msg.id, result: t });
    }
    if (msg.method === "block") {
      const b = blocks[p.block_id];
      if (!b) return reply({ jsonrpc: "2.0", id: msg.id, error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } });
      return reply({ jsonrpc: "2.0", id: msg.id, result: { header: { hash: p.block_id, height: b.height } } });
    }
    if (msg.method !== "query") {
      sent.push(msg.method);
      return reply({ jsonrpc: "2.0", id: msg.id, error: { name: "REFUSED", cause: { name: "the stand-in sends nothing" } } });
    }
    if (p.request_type === "view_account") return reply({ jsonrpc: "2.0", id: msg.id, result: { amount: "0", code_hash: codeHashes[p.account_id] } });
    const args = JSON.parse(Buffer.from(p.args_base64, "base64").toString("utf8"));
    const f = views[p.account_id]?.[p.method_name];
    if (!f) return reply({ jsonrpc: "2.0", id: msg.id, error: { name: "HANDLER_ERROR", cause: { name: "MethodNotFound" } } });
    reply({ jsonrpc: "2.0", id: msg.id, result: { result: [...Buffer.from(JSON.stringify(f(args) ?? null))], logs: [] } });
  });
});

let judge: string;
let fakeContract: string;

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  judge = judgeWasm();
  fakeContract = join(dir, "contract.wasm");
  writeFileSync(fakeContract, Buffer.from("the bounty contract's rebuilt wasm"));

  // OutLayer's register contract approves the recorded worker's measurements (when the test says so).
  views["worker.outlayer.testnet"] = {
    is_measurements_approved: (a) => measurementsApproved && JSON.stringify(a.measurements) === JSON.stringify(MEASUREMENTS),
  };

  // Deployment 1, the gate's record. Variants of the bounty share the winning claim but differ
  // in the pause on the proof chain (Arbitrum Sepolia).
  const bountyNamed = (name: string, pause = PAUSE) => ({ ...win.bounty, id: { ...WIN_BOUNTY, name }, signed_pauses: [BASE_PAUSE, pause] });
  const pauses: Record<string, any> = {
    [WIN_BOUNTY.name]: PAUSE,
    "unverified": { ...PAUSE, tx_hash: `0x${"11".repeat(32)}` },
    "unlanded": { ...PAUSE, tx_hash: `0x${"22".repeat(32)}` },
    "reverted": { ...PAUSE, tx_hash: `0x${"33".repeat(32)}` },
  };
  views[WIN] = {
    bounty: (a) => (pauses[a.id.name] ? bountyNamed(a.id.name, pauses[a.id.name]) : null),
    claim: (a) => (a.claim_id === CLAIM ? win.claim : null),
    config: () => win.config,
    pause_verifications: (a) => [
      { chain_id: BASE, verified: true, verified_pauses: [BASE_PAUSE.tx_hash] },
      { chain_id: ARBITRUM, verified: true, verified_pauses: a.id.name === "unverified" ? [] : [pauses[a.id.name].tx_hash] },
    ],
    published_exploit: () => ({ claim_id: CLAIM, state: "delayed", publishable_from_ns: "1796442141731000000", proofs: null, published: null }),
  };
  codeHashes[WIN] = codeHash(readFileSync(fakeContract));
  histories[WIN] = ["SomeOtherTx111111111111111111111111111111111", winTx.transaction.hash];
  transactions[winTx.transaction.hash] = winTx;
  nearTxs[winTx.transaction.hash] = winRpc.tx_status;
  Object.assign(blocks, winRpc.blocks);
  transactions["SomeOtherTx111111111111111111111111111111111"] = { transaction: { hash: "SomeOtherTx111111111111111111111111111111111" }, receipts: [] };
  attestations[winTx.transaction.hash] = winAttestation;
  Object.assign(receipts, winRpc.evm_receipts);
  receipts[pauses.unverified.tx_hash] = { ...winRpc.evm_receipts[PAUSE.tx_hash], blockNumber: "0x1" };
  receipts[pauses.reverted.tx_hash] = { ...winRpc.evm_receipts[PAUSE.tx_hash], status: "0x0" };

  // Deployment 2, the judge's fixture: rules pin the judge this checkout builds; published.
  const pinned = { ...rules, judge_build_hash: `0x${sha256(readFileSync(judge))}` };
  const fixtureBounty = (name: string, s: string, winner: number | null) => ({ id: { protocol: PROTOCOL, name }, rules: pinned, state: s, winning_claim: winner, signed_pauses: [] });
  const published = publish(judge, "vault");
  views[FIXTURE] = {
    bounty: (a) => (a.id.name === "vault" ? fixtureBounty("vault", "paid", 3) : a.id.name === "open" ? fixtureBounty("open", "live", null) : null),
    claim: () => ({ bounty: { protocol: PROTOCOL, name: "vault" }, whitehat: WHITEHAT, secret_profile: "c3", state: "judged", verdict: PAYS }),
    config: () => ({ usdc: "usdc.testnet", judge_build_hash: pinned.judge_build_hash }),
    pause_verifications: () => [],
    published_exploit: (a) =>
      a.id.name === "vault"
        ? {
            claim_id: 3,
            state: "published",
            publishable_from_ns: "0",
            block: state.block,
            header: state.header,
            proofs_sha256: `0x${sha256(proofsText)}`,
            proofs: proofsText,
            verdict: PAYS,
            published,
          }
        : null,
  };
  codeHashes[FIXTURE] = "11111111111111111111111111111111"; // not the rebuilt contract
  histories[FIXTURE] = [];
}, 600_000);
afterAll(() => server.close());

/** `bountee verify`, with an empty home and credentials directory: no keys anywhere. */
function verify(bounty: string, contract: string, extra: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string; result: any }> {
  const home = mkdtempSync(join(tmpdir(), "bountee-verify-home-"));
  const args = [
    entry, "verify", bounty, "--contract", contract, "--near-rpc", `${base}/near`, "--rpc", `${BASE}=${base}/evm,${ARBITRUM}=${base}/evm`,
    "--outlayer-api", base, "--tx-api", base, "--judge-wasm", judge, "--contract-wasm", fakeContract, ...extra, "--json",
  ];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { env: { ...process.env, HOME: home, BOUNTEE_CREDENTIALS_DIR: join(home, "none") }, cwd: home });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr, result: stdout ? JSON.parse(stdout) : null }));
  });
}

/** Each check's status; a pause's checks keyed by their chain, as `pause_landed@84532`. */
const statuses = (r: any) => Object.fromEntries(r.checks.map((c: any) => [c.chain_id ? `${c.check}@${c.chain_id}` : c.check, c.status]));
const check = (r: any, name: string, chain?: number) => r.checks.find((c: any) => c.check === name && (chain === undefined || c.chain_id === chain));

test("R15.1, R15.2, R14.5, D1: verify checks every layer of a win proven on the second chain, with no keys or funds", async () => {
  const r = await verify(`${WIN_BOUNTY.protocol}/${WIN_BOUNTY.name}`, WIN);
  expect(r.result, r.stderr).toMatchObject({ contract: WIN, bounty: WIN_BOUNTY, state: "paid", winning_claim: CLAIM });
  // The attestation's input hash binds the claim's block, chain included (ADR-0020).
  expect(win.claim.block.chain_id).toBe(ARBITRUM);
  expect(statuses(r.result)).toEqual({
    contract_code: "pass",
    // The bounty pins the gate deployment's build; this checkout's judge (pinned to no
    // contract) is another.
    judge_build: "fail",
    attestation: "pass",
    payout: "pass",
    [`pause_landed@${BASE}`]: "pass",
    [`pause_landed@${ARBITRUM}`]: "pass",
    [`pause_verified@${BASE}`]: "pass",
    [`pause_verified@${ARBITRUM}`]: "pass",
    rerun: "not_yet_published",
  });
  expect(check(r.result, "judge_build").detail).toMatch(new RegExp(`pins judge ${win.config.judge_build_hash.slice(2, 18)}.*the rebuild gives [0-9a-f]{64}`));
  expect(check(r.result, "attestation")).toMatchObject({ task_id: winAttestation.task_id, request_id: winAttestation.request_id, transaction_hash: winTx.transaction.hash, measurements: MEASUREMENTS });
  expect(check(r.result, "payout")).toMatchObject({ tx_hash: winTx.transaction.hash });
  for (const p of [BASE_PAUSE, PAUSE]) {
    expect(check(r.result, "pause_landed", p.chain_id)).toMatchObject({ tx_hash: p.tx_hash, block: Number(winRpc.evm_receipts[p.tx_hash].blockNumber) });
  }
  expect(check(r.result, "rerun").detail).toMatch(/not yet published/);
  expect(r.result.passed).toBe(false);
  expect(r.code).toBe(1);
  expect(sent).toEqual([]);
}, 120_000);

test("R15.1: a pause not yet verified or landed is 'not yet'; a reverted one fails", async () => {
  const unverified = (await verify(`${WIN_BOUNTY.protocol}/unverified`, WIN)).result;
  // Each chain's pause is checked on its own: Base's, as recorded, still passes.
  const base = { [`pause_landed@${BASE}`]: "pass", [`pause_verified@${BASE}`]: "pass" };
  expect(statuses(unverified)).toMatchObject({ ...base, [`pause_landed@${ARBITRUM}`]: "pass", [`pause_verified@${ARBITRUM}`]: "not_yet" });
  const unlanded = (await verify(`${WIN_BOUNTY.protocol}/unlanded`, WIN)).result;
  expect(statuses(unlanded)).toMatchObject({ ...base, [`pause_landed@${ARBITRUM}`]: "not_yet" });
  const reverted = (await verify(`${WIN_BOUNTY.protocol}/reverted`, WIN)).result;
  expect(statuses(reverted)).toMatchObject({ ...base, [`pause_landed@${ARBITRUM}`]: "fail" });
  expect(check(reverted, "pause_landed", ARBITRUM).detail).toMatch(/reverted/);
  expect(sent).toEqual([]);
}, 120_000);

test("R15.1: an attestation that isn't Intel-signed over this job, from an approved worker, fails", async () => {
  const bounty = `${WIN_BOUNTY.protocol}/${WIN_BOUNTY.name}`;
  const cases: [string, (a: any) => any, RegExp][] = [
    // Another verdict claimed for the job: the quote was made over the real output, and the
    // output isn't the contract's recorded verdict.
    ["output", (a) => ({ ...a, output_hash: sha256('{"outcome":"ZERO","reason":"below_minimum_theft"}') }), /report_data differs.*output isn't the recorded verdict/],
    // Another secret named: the job wasn't the claim's.
    ["secret", (a) => ({ ...a, secrets_ref: `${WIN}/c8` }), /report_data differs.*not the claim's/],
    // Another judge named.
    ["wasm", (a) => ({ ...a, wasm_hash: "ab".repeat(32) }), /report_data differs.*not the bounty's pinned build/],
    // A quote whose signature is broken.
    ["signature", (a) => {
      const q = Buffer.from(a.tdx_quote, "base64");
      q.writeUInt8(q.readUInt8(48 + 584 + 4 + 10) ^ 0xff, 48 + 584 + 4 + 10);
      return { ...a, tdx_quote: q.toString("base64") };
    }, /quote's signature doesn't verify/],
    // OutLayer's dev mode: no hardware quote at all.
    ["dev mode", (a) => ({ ...a, tdx_quote: Buffer.from("no-attestation-dev-mode").toString("base64") }), /not an Intel TDX quote/],
  ];
  for (const [, tamper, why] of cases) {
    attestations[winTx.transaction.hash] = tamper(winAttestation);
    const r = (await verify(bounty, WIN)).result;
    expect(check(r, "attestation").status).toBe("fail");
    expect(check(r, "attestation").detail).toMatch(why);
  }
  attestations[winTx.transaction.hash] = winAttestation;
  measurementsApproved = false;
  const unapproved = (await verify(bounty, WIN)).result;
  measurementsApproved = true;
  expect(check(unapproved, "attestation")).toMatchObject({ status: "fail", detail: expect.stringMatching(/measurements aren't approved/) });
}, 300_000);

test("R15.1: the rebuilt judge passes, and the published exploit re-runs under it to the enclave's verdict", async () => {
  const r = await verify(`${PROTOCOL}/vault`, FIXTURE);
  expect(r.result, r.stderr).toBeTruthy();
  expect(statuses(r.result)).toMatchObject({ contract_code: "fail", judge_build: "pass", rerun: "pass" });
  expect(check(r.result, "rerun")).toMatchObject({ verdict: PAYS, enclave_verdict: PAYS, judge_sha256: sha256(readFileSync(judge)) });
  // No transaction on record holds this claim's job: its attestation can't be shown.
  expect(check(r.result, "attestation").status).toBe("fail");
  expect(check(r.result, "contract_code").detail).toMatch(/code hash is 1111.*rebuild gives/);
  expect(sent).toEqual([]);
}, 300_000);

test("R15.1 (#23's open point): the same verdict under another judge build than the pinned one fails", async () => {
  const other = anotherBuild(judge);
  const r = (await verify(`${PROTOCOL}/vault`, FIXTURE, ["--judge-wasm", other])).result;
  expect(statuses(r)).toMatchObject({ judge_build: "fail", rerun: "fail" });
  expect(check(r, "rerun")).toMatchObject({ verdict: PAYS, enclave_verdict: PAYS, judge_sha256: sha256(readFileSync(other)) });
  expect(check(r, "rerun").detail).toMatch(/not the bounty's pinned build/);
}, 300_000);

test("R15.1: before anyone wins, the attestation and payout are 'not yet' and the re-run 'not yet published'", async () => {
  const r = await verify(`${PROTOCOL}/open`, FIXTURE);
  expect(statuses(r.result)).toEqual({
    contract_code: "fail",
    judge_build: "pass",
    attestation: "not_yet",
    payout: "not_yet",
    rerun: "not_yet_published",
  });
  expect(check(r.result, "rerun").detail).toMatch(/not yet published/);
}, 120_000);

test("R15.1: a lying explorer can't make the payout or the attestation pass: NEAR RPC is read again", async () => {
  const bounty = `${WIN_BOUNTY.protocol}/${WIN_BOUNTY.name}`;
  const hash = winTx.transaction.hash;
  const truth = winRpc.tx_status;
  const logged = (t: any, event: string) => t.receipts_outcome.find((o: any) => o.outcome.logs.some((l: string) => l.includes(`"event":"${event}"`)));

  // It lists the real transaction, with the USDC transfer succeeding where NEAR says it failed.
  const failed = structuredClone(truth);
  logged(failed, "ft_transfer").outcome.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "refused" } } } } };
  nearTxs[hash] = failed;
  const unpaid = (await verify(bounty, WIN)).result;
  nearTxs[hash] = truth;
  expect(check(unpaid, "payout")).toMatchObject({ status: "fail", detail: expect.stringMatching(new RegExp(`no .* transfer of ${win.bounty.rules.bounty_amount} .* succeeded`)) });

  // It lists the real transaction, with the job requested by the bounty contract where NEAR
  // says another account requested it.
  const other = structuredClone(truth);
  const request = logged(other, "execution_requested");
  request.outcome.logs = request.outcome.logs.map((l: string) => l.replaceAll(`\\"predecessor_id\\":\\"${WIN}\\"`, `\\"predecessor_id\\":\\"evil.testnet\\"`));
  other.receipts.find((x: any) => x.receipt_id === request.id).predecessor_id = "evil.testnet";
  nearTxs[hash] = other;
  const misattributed = (await verify(bounty, WIN)).result;
  nearTxs[hash] = truth;
  expect(check(misattributed, "attestation")).toMatchObject({ status: "fail", detail: expect.stringMatching(/requested by evil\.testnet, not the bounty contract/) });

  // It hides the real transaction and lists a forged one NEAR never saw, holding the verdict,
  // the job (attested, as OutLayer's API is asked for the forged hash) and the payout.
  const FORGED = "Forged1111111111111111111111111111111111111";
  const history = histories[WIN]!;
  histories[WIN] = [FORGED];
  transactions[FORGED] = { ...winTx, transaction: { ...winTx.transaction, hash: FORGED } };
  attestations[FORGED] = { ...winAttestation, transaction_hash: FORGED };
  const forged = (await verify(bounty, WIN)).result;
  histories[WIN] = history;
  expect(statuses(forged)).toMatchObject({ attestation: "fail", payout: "fail" });
  expect(sent).toEqual([]);
}, 300_000);

test("R15.1: the attestation's TD is not in debug mode, its QE is Intel's, and it names the claim's caller, block and input", async () => {
  const bounty = `${WIN_BOUNTY.protocol}/${WIN_BOUNTY.name}`;
  const hash = winTx.transaction.hash;
  // Offsets in the quote: a 48-byte header, the 584-byte TD report, the signature data's
  // length (4), then the signature (64), attestation key (64), certification header (6) and
  // the Quoting Enclave's 384-byte SGX report.
  const TD_ATTRIBUTES = 48 + 120;
  const QE_REPORT = 48 + 584 + 4 + 128 + 6;
  const tamperQuote = (change: (q: Buffer) => void) => (a: any) => {
    const q = Buffer.from(a.tdx_quote, "base64");
    change(q);
    return { ...a, tdx_quote: q.toString("base64") };
  };
  const failsWith = async (why: RegExp) => {
    const r = (await verify(bounty, WIN)).result;
    expect(check(r, "attestation").status).toBe("fail");
    expect(check(r, "attestation").detail).toMatch(why);
  };

  // The real quote passes every one of these checks (the first test); each tampered one fails.
  const quoteCases: [(a: any) => any, RegExp][] = [
    [tamperQuote((q) => q.writeUInt8(q.readUInt8(TD_ATTRIBUTES) | 1, TD_ATTRIBUTES)), /debug mode/],
    [tamperQuote((q) => q.writeUInt8(q.readUInt8(QE_REPORT + 128) ^ 0xff, QE_REPORT + 128)), /Quoting Enclave isn't Intel's TDX QE/],
    [tamperQuote((q) => q.writeUInt16LE(1, QE_REPORT + 256)), /Quoting Enclave isn't Intel's TDX QE/],
    [(a) => ({ ...a, caller_account_id: WIN }), new RegExp(`report_data differs.*caller ${esc(WIN)}, not the transaction's signer ${esc(winTx.transaction.signer_id)}`)],
    [(a) => ({ ...a, block_height: a.block_height + 1 }), new RegExp(`report_data differs.*NEAR block ${REQUEST_HEIGHT + 1}, but job ${winAttestation.request_id} was requested in block ${REQUEST_HEIGHT}`)],
    [(a) => ({ ...a, input_hash: "cd".repeat(32) }), new RegExp(`report_data differs.*input isn't claim ${CLAIM}'s job input`)],
  ];
  for (const [tamper, why] of quoteCases) {
    attestations[hash] = tamper(winAttestation);
    await failsWith(why);
  }
  attestations[hash] = winAttestation;

  // An untampered attestation, but NEAR says the request ran in another block.
  blocks[REQUEST_BLOCK] = { height: OTHER_HEIGHT };
  await failsWith(new RegExp(`NEAR block ${REQUEST_HEIGHT}, but job ${winAttestation.request_id} was requested in block ${OTHER_HEIGHT}`));
  blocks[REQUEST_BLOCK] = winRpc.blocks[REQUEST_BLOCK];

  // An untampered attestation, but the claim's recorded data isn't the job's input.
  const claim = win.claim;
  win.claim = { ...claim, submitted_at_ns: String(BigInt(claim.submitted_at_ns) + 1n) };
  await failsWith(new RegExp(`input isn't claim ${CLAIM}'s job input`));
  win.claim = { ...claim, proofs_sha256: `0x${"ee".repeat(32)}` };
  await failsWith(new RegExp(`the job's input carries other proofs than claim ${CLAIM}'s`));
  win.claim = claim;
  expect(sent).toEqual([]);
}, 300_000);
