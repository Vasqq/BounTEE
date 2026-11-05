// Seam T, ticket #24 (offline): a Verifier runs `bountee verify <protocol>/<name>` with no keys
// and no funds and gets pass, fail, "not yet" or "not yet published" for each layer (R15.1).
//
// Seams (written before the first test; also in the ticket's findings): T here drives the
// tool against local stand-ins for NEAR's RPC (the bounty contract's views, the account's code
// hash, OutLayer's register contract, transactions and blocks), FastNEAR's explorer API (the
// contract's transactions: an indexer, which may lie), an EVM RPC (pause receipts) and
// OutLayer's attestation API. Deployment "day3b" is the Day-3 run's real record: claim 7's
// views, its transaction as the explorer lists it and as NEAR's archival RPC gives it
// (`EXPERIMENTAL_tx_status`, with the block its job was requested in), and OutLayer's
// attestation (an Intel-signed TDX quote), as read from testnet on Nov 5. Deployment "bounty.bountee.testnet" is the judge's
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

// ---- Deployment 1: the Day-3 run's record (claim 7 on day3b, PAYS, paid, pause landed) ----
const day3 = fixture("claim7-views.json");
const DAY3 = day3.contract as string;
const DAY3_BOUNTY = day3.bounty.id;
const tx7 = fixture("claim7-tx.json");
const rpc7 = fixture("claim7-rpc.json");
const attestation7 = fixture("claim7-attestation.json");
const PAUSE = day3.bounty.signed_pauses[0];
const MEASUREMENTS = {
  mrtd: "7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173",
  rtmr0: "573aadb4d478839c803c4b1d3e03dd748976b63a89622f377e32a54dd60546e88ec2097f595ceafc324f48a0d0d31db6",
  rtmr1: "e7b3ffa0e72b50557d85f7ecd8dc98a4ffc3dd6f82d01f122ef522d61361abeac310d70d2877e56be9c9408d9bcc320c",
  rtmr2: "764489f277a8540189761e72b4238ba36d4d647e11bd958d8ab5522af2a4867b0ff63e06b0c4967f1857236244040a5d",
  rtmr3: "d513a9461c8c95bc23a0edc76dece52b65944f4063a3806b1a70b03502de7554a402813bdbd099f057a60f3496f3c231",
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

  // OutLayer's register contract approves the Day-3 worker's measurements (when the test says so).
  views["worker.outlayer.testnet"] = {
    is_measurements_approved: (a) => measurementsApproved && JSON.stringify(a.measurements) === JSON.stringify(MEASUREMENTS),
  };

  // Deployment 1, the Day-3 record. Variants of the bounty share claim 7 but differ in their pause.
  const bountyNamed = (name: string, pause = PAUSE) => ({ ...day3.bounty, id: { ...DAY3_BOUNTY, name }, signed_pauses: [pause] });
  const pauses: Record<string, any> = {
    [DAY3_BOUNTY.name]: PAUSE,
    "unverified": { ...PAUSE, tx_hash: `0x${"11".repeat(32)}` },
    "unlanded": { ...PAUSE, tx_hash: `0x${"22".repeat(32)}` },
    "reverted": { ...PAUSE, tx_hash: `0x${"33".repeat(32)}` },
  };
  views[DAY3] = {
    bounty: (a) => (pauses[a.id.name] ? bountyNamed(a.id.name, pauses[a.id.name]) : null),
    claim: (a) => (a.claim_id === 7 ? day3.claim : null),
    config: () => day3.config,
    pause_verifications: (a) => [{ chain_id: 84532, verified: true, verified_pauses: a.id.name === "unverified" ? [] : [pauses[a.id.name].tx_hash] }],
    published_exploit: () => ({ claim_id: 7, state: "delayed", publishable_from_ns: "1796442141731000000", proofs: null, published: null }),
  };
  codeHashes[DAY3] = codeHash(readFileSync(fakeContract));
  histories[DAY3] = ["SomeOtherTx111111111111111111111111111111111", tx7.transaction.hash];
  transactions[tx7.transaction.hash] = tx7;
  nearTxs[tx7.transaction.hash] = rpc7.tx_status;
  Object.assign(blocks, rpc7.blocks);
  transactions["SomeOtherTx111111111111111111111111111111111"] = { transaction: { hash: "SomeOtherTx111111111111111111111111111111111" }, receipts: [] };
  attestations[tx7.transaction.hash] = attestation7;
  receipts[PAUSE.tx_hash] = { status: "0x1", blockNumber: "0x341c4b9", to: PAUSE.contract };
  receipts[pauses.unverified.tx_hash] = { status: "0x1", blockNumber: "0x341c4ba", to: PAUSE.contract };
  receipts[pauses.reverted.tx_hash] = { status: "0x0", blockNumber: "0x341c4bb", to: PAUSE.contract };

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
    entry, "verify", bounty, "--contract", contract, "--near-rpc", `${base}/near`, "--rpc", `84532=${base}/evm`,
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

const statuses = (r: any) => Object.fromEntries(r.checks.map((c: any) => [c.check, c.status]));
const check = (r: any, name: string) => r.checks.find((c: any) => c.check === name);

test("R15.1, R15.2, R14.5: verify checks every layer of a paid bounty with no keys or funds", async () => {
  const r = await verify(`${DAY3_BOUNTY.protocol}/${DAY3_BOUNTY.name}`, DAY3);
  expect(r.result, r.stderr).toMatchObject({ contract: DAY3, bounty: DAY3_BOUNTY, state: "paid", winning_claim: 7 });
  expect(statuses(r.result)).toEqual({
    contract_code: "pass",
    // The bounty pins the Day-3 build (c4222111…); this checkout's judge is another.
    judge_build: "fail",
    attestation: "pass",
    payout: "pass",
    pause_landed: "pass",
    pause_verified: "pass",
    rerun: "not_yet_published",
  });
  expect(check(r.result, "judge_build").detail).toMatch(/pins judge c4222111c3523dae.*the rebuild gives [0-9a-f]{64}/);
  expect(check(r.result, "attestation")).toMatchObject({ task_id: 20742, request_id: 9405, transaction_hash: tx7.transaction.hash, measurements: MEASUREMENTS });
  expect(check(r.result, "payout")).toMatchObject({ tx_hash: tx7.transaction.hash });
  expect(check(r.result, "pause_landed")).toMatchObject({ chain_id: 84532, tx_hash: PAUSE.tx_hash, block: 0x341c4b9 });
  expect(check(r.result, "rerun").detail).toMatch(/not yet published/);
  expect(r.result.passed).toBe(false);
  expect(r.code).toBe(1);
  expect(sent).toEqual([]);
}, 120_000);

test("R15.1: a pause not yet verified or landed is 'not yet'; a reverted one fails", async () => {
  const unverified = (await verify(`${DAY3_BOUNTY.protocol}/unverified`, DAY3)).result;
  expect(statuses(unverified)).toMatchObject({ pause_landed: "pass", pause_verified: "not_yet" });
  const unlanded = (await verify(`${DAY3_BOUNTY.protocol}/unlanded`, DAY3)).result;
  expect(statuses(unlanded)).toMatchObject({ pause_landed: "not_yet" });
  const reverted = (await verify(`${DAY3_BOUNTY.protocol}/reverted`, DAY3)).result;
  expect(statuses(reverted)).toMatchObject({ pause_landed: "fail" });
  expect(check(reverted, "pause_landed").detail).toMatch(/reverted/);
  expect(sent).toEqual([]);
}, 120_000);

test("R15.1: an attestation that isn't Intel-signed over this job, from an approved worker, fails", async () => {
  const bounty = `${DAY3_BOUNTY.protocol}/${DAY3_BOUNTY.name}`;
  const cases: [string, (a: any) => any, RegExp][] = [
    // Another verdict claimed for the job: the quote was made over the real output, and the
    // output isn't the contract's recorded verdict.
    ["output", (a) => ({ ...a, output_hash: sha256('{"outcome":"ZERO","reason":"below_minimum_theft"}') }), /report_data differs.*output isn't the recorded verdict/],
    // Another secret named: the job wasn't the claim's.
    ["secret", (a) => ({ ...a, secrets_ref: `${DAY3}/c8` }), /report_data differs.*not the claim's/],
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
    attestations[tx7.transaction.hash] = tamper(attestation7);
    const r = (await verify(bounty, DAY3)).result;
    expect(check(r, "attestation").status).toBe("fail");
    expect(check(r, "attestation").detail).toMatch(why);
  }
  attestations[tx7.transaction.hash] = attestation7;
  measurementsApproved = false;
  const unapproved = (await verify(bounty, DAY3)).result;
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
  const bounty = `${DAY3_BOUNTY.protocol}/${DAY3_BOUNTY.name}`;
  const hash = tx7.transaction.hash;
  const truth = rpc7.tx_status;
  const logged = (t: any, event: string) => t.receipts_outcome.find((o: any) => o.outcome.logs.some((l: string) => l.includes(`"event":"${event}"`)));

  // It lists the real transaction, with the USDC transfer succeeding where NEAR says it failed.
  const failed = structuredClone(truth);
  logged(failed, "ft_transfer").outcome.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: "refused" } } } } };
  nearTxs[hash] = failed;
  const unpaid = (await verify(bounty, DAY3)).result;
  nearTxs[hash] = truth;
  expect(check(unpaid, "payout")).toMatchObject({ status: "fail", detail: expect.stringMatching(/no .* transfer of 100000000 .* succeeded/) });

  // It lists the real transaction, with the job requested by the bounty contract where NEAR
  // says another account requested it.
  const other = structuredClone(truth);
  const request = logged(other, "execution_requested");
  request.outcome.logs = request.outcome.logs.map((l: string) => l.replaceAll(`\\"predecessor_id\\":\\"${DAY3}\\"`, `\\"predecessor_id\\":\\"evil.testnet\\"`));
  other.receipts.find((x: any) => x.receipt_id === request.id).predecessor_id = "evil.testnet";
  nearTxs[hash] = other;
  const misattributed = (await verify(bounty, DAY3)).result;
  nearTxs[hash] = truth;
  expect(check(misattributed, "attestation")).toMatchObject({ status: "fail", detail: expect.stringMatching(/requested by evil\.testnet, not the bounty contract/) });

  // It hides the real transaction and lists a forged one NEAR never saw, holding the verdict,
  // the job (attested, as OutLayer's API is asked for the forged hash) and the payout.
  const FORGED = "Forged1111111111111111111111111111111111111";
  const history = histories[DAY3]!;
  histories[DAY3] = [FORGED];
  transactions[FORGED] = { ...tx7, transaction: { ...tx7.transaction, hash: FORGED } };
  attestations[FORGED] = { ...attestation7, transaction_hash: FORGED };
  const forged = (await verify(bounty, DAY3)).result;
  histories[DAY3] = history;
  expect(statuses(forged)).toMatchObject({ attestation: "fail", payout: "fail" });
  expect(sent).toEqual([]);
}, 300_000);

test("R15.1: the attestation's TD is not in debug mode, its QE is Intel's, and it names the claim's caller, block and input", async () => {
  const bounty = `${DAY3_BOUNTY.protocol}/${DAY3_BOUNTY.name}`;
  const hash = tx7.transaction.hash;
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
    const r = (await verify(bounty, DAY3)).result;
    expect(check(r, "attestation").status).toBe("fail");
    expect(check(r, "attestation").detail).toMatch(why);
  };

  // The real quote passes every one of these checks (the first test); each tampered one fails.
  const quoteCases: [(a: any) => any, RegExp][] = [
    [tamperQuote((q) => q.writeUInt8(q.readUInt8(TD_ATTRIBUTES) | 1, TD_ATTRIBUTES)), /debug mode/],
    [tamperQuote((q) => q.writeUInt8(q.readUInt8(QE_REPORT + 128) ^ 0xff, QE_REPORT + 128)), /Quoting Enclave isn't Intel's TDX QE/],
    [tamperQuote((q) => q.writeUInt16LE(1, QE_REPORT + 256)), /Quoting Enclave isn't Intel's TDX QE/],
    [(a) => ({ ...a, caller_account_id: DAY3 }), /report_data differs.*caller day3b\.bountee-spike2\.testnet, not the transaction's signer bts1-white-1104\.testnet/],
    [(a) => ({ ...a, block_height: a.block_height + 1 }), /report_data differs.*NEAR block 276289449, but job 9405 was requested in block 276289448/],
    [(a) => ({ ...a, input_hash: "cd".repeat(32) }), /report_data differs.*input isn't claim 7's job input/],
  ];
  for (const [tamper, why] of quoteCases) {
    attestations[hash] = tamper(attestation7);
    await failsWith(why);
  }
  attestations[hash] = attestation7;

  // An untampered attestation, but NEAR says the request ran in another block.
  const [block] = Object.keys(rpc7.blocks);
  blocks[block!] = { height: 276289000 };
  await failsWith(/NEAR block 276289448, but job 9405 was requested in block 276289000/);
  blocks[block!] = rpc7.blocks[block!];

  // An untampered attestation, but the claim's recorded data isn't the job's input.
  const claim = day3.claim;
  day3.claim = { ...claim, submitted_at_ns: "1793850608584544985" };
  await failsWith(/input isn't claim 7's job input/);
  day3.claim = { ...claim, proofs_sha256: `0x${"ee".repeat(32)}` };
  await failsWith(/the job's input carries other proofs than claim 7's/);
  day3.claim = claim;
  expect(sent).toEqual([]);
}, 300_000);
