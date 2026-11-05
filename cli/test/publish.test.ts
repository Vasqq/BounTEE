// Seam T, ticket #23 (offline): anyone re-runs a published winning exploit from the terminal
// with `bountee rerun`, to the verdict the enclave gave; `bountee publish` asks for the
// publication only once it can succeed.
//
// Seams (written before the first test; also in the ticket's findings): T here drives the
// tool against a local stand-in for NEAR's RPC that serves the bounty contract's `bounty`,
// `claim` and `published_exploit` views. The publication it serves is the real judge's
// output: the test runs the compiled judge's `publish` action under wasmtime, as OutLayer
// runs it for the bounty contract, on a bundle the tool's own sealing code made, beside the
// judge's committed fixture block, header and proofs. Catches D7.1 (a published exploit
// re-runs, from its own header and proofs under the compiled judge, to the enclave's
// verdict; one whose proofs aren't the claim's, or whose verdict differs, is named as such;
// before publication it is "not yet published"), D7 at the tool (`publish` is refused
// before the delay, and with proofs other than the claim's, before any transaction), and
// R14.5 (JSON). Misses: the real contract (seam C proves the gate and what is kept) and
// OutLayer; no live run, since a disclosure delay is at least a day.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const repo = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = new URL("../../judge/tests/fixtures/", import.meta.url);
/** The bounty contract a default build of the judge is pinned to (judge/src/sealed.rs). */
const CONTRACT = "bounty.bountee.testnet";
const PROTOCOL = "protocol.testnet";
const WHITEHAT = "alice.testnet";
const DAY_NS = 86_400_000_000_000n;

const dir = mkdtempSync(join(tmpdir(), "bountee-publish-"));
const readFixture = (path: string) => JSON.parse(readFileSync(new URL(path, fixtures), "utf8"));
const rules = readFixture("rules.json");
const state = readFixture("state.json");
/** The proofs as the claim's `submit_claim` carried them: the array as JSON text. */
const proofsText = JSON.stringify(state.proofs);
const sha256 = (text: string) => `0x${createHash("sha256").update(text).digest("hex")}`;
/** What the enclave gave for the drain exploit on this fixture (seam J's `drain` test). */
const PAYS = { outcome: "PAYS", reason: "minimum_theft_reached" };

// ---- The judge's publication, as OutLayer runs it for the bounty contract ------------------

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

function publish(name: string, claimId: number): string {
  const secret = readFileSync(new URL("sealed/alice-drain.txt", fixtures), "utf8").trim();
  const job = { publish: { bounty: { protocol: PROTOCOL, name }, claim_id: claimId, whitehat: WHITEHAT } };
  const run = spawnSync(
    "wasmtime",
    ["run", "-S", "http", "--env", `NEAR_PREDECESSOR_ID=${CONTRACT}`, "--env", `BOUNTEE_SEALED_EXPLOIT=${secret}`, "--", judgeWasm()],
    { input: JSON.stringify(job), encoding: "utf8" },
  );
  expect(run.status, run.stderr).toBe(0);
  return JSON.parse(run.stdout).published;
}

// ---- A stand-in for NEAR's RPC: the bounty contract's views ------------------------------

const views: Record<string, { bounty: unknown; published_exploit: unknown }> = {};
const bountyView = (name: string, s: string) => ({ id: { protocol: PROTOCOL, name }, rules, state: s, winning_claim: 3 });
const now = BigInt(Date.now()) * 1_000_000n;
const publication = (o: { state: string; from?: bigint; proofs?: string | null; published?: string | null; verdict?: unknown }) => ({
  claim_id: 3,
  state: o.state,
  publishable_from_ns: String(o.from ?? now - DAY_NS),
  block: state.block,
  header: state.header,
  proofs_sha256: sha256(proofsText),
  proofs: o.proofs === undefined ? proofsText : o.proofs,
  verdict: o.verdict ?? PAYS,
  published: o.published ?? null,
});

let rpc: string;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { id, params } = JSON.parse(body);
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
    const view = views[args.id.name]?.[params.method_name as "bounty" | "published_exploit"] ?? null;
    const result = [...Buffer.from(JSON.stringify(view))];
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: { result, logs: [] } }));
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rpc = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const published = publish("vault", 3);
  views.vault = { bounty: bountyView("vault", "paid"), published_exploit: publication({ state: "published", published }) };
  // Published, but its proofs aren't the ones the claim was filed with.
  const otherProofs = JSON.stringify(state.proofs.slice(1));
  views["vault-tampered"] = {
    bounty: bountyView("vault-tampered", "paid"),
    published_exploit: publication({ state: "published", published: publish("vault-tampered", 3), proofs: otherProofs }),
  };
  // Published, but the verdict on record isn't the one the exploit re-runs to.
  views["vault-zero"] = {
    bounty: bountyView("vault-zero", "paid"),
    published_exploit: publication({ state: "published", published: publish("vault-zero", 3), verdict: { outcome: "ZERO", reason: "below_minimum_theft" } }),
  };
  // Paid, but the disclosure delay hasn't passed.
  views["vault-delayed"] = {
    bounty: bountyView("vault-delayed", "paid"),
    published_exploit: publication({ state: "delayed", from: now + DAY_NS, proofs: null }),
  };
  views["vault-live"] = { bounty: bountyView("vault-live", "live"), published_exploit: null };
}, 600_000);
afterAll(() => server.close());

function bountee(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args, "--contract", CONTRACT, "--near-rpc", rpc, "--json"]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("D7.1, R14.5: a published exploit re-runs from its own header and proofs to the enclave's verdict", async () => {
  const out = join(dir, "rerun-job.json");
  const r = await bountee(["rerun", `${PROTOCOL}/vault`, "--out", out]);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  const result = JSON.parse(r.stdout);
  expect(result).toMatchObject({
    bounty: { protocol: PROTOCOL, name: "vault" },
    claim_id: 3,
    whitehat: WHITEHAT,
    block: state.block,
    verdict: PAYS,
    enclave_verdict: PAYS,
    same_verdict: true,
  });
  // The saved job is a plain replay anyone can run again with `bountee test --job`.
  const job = JSON.parse(readFileSync(out, "utf8"));
  expect(job.replay.header).toBe(state.header);
  expect(job.replay.proofs).toEqual(state.proofs);
  expect(job.replay.exploit).toEqual(readFixture("exploits/drain.json"));
  const again = await bountee(["test", "--job", out]);
  expect(JSON.parse(again.stdout).verdict).toEqual(PAYS);
}, 300_000);

test("D7.1: a verdict that differs from the enclave's, or proofs that aren't the claim's, are named", async () => {
  const zero = await bountee(["rerun", `${PROTOCOL}/vault-zero`]);
  expect(zero.code).toBe(1);
  expect(JSON.parse(zero.stdout)).toMatchObject({ verdict: PAYS, enclave_verdict: { outcome: "ZERO" }, same_verdict: false });

  const tampered = await bountee(["rerun", `${PROTOCOL}/vault-tampered`]);
  expect(tampered.code).toBe(1);
  expect(tampered.stdout).toBe("");
  expect(JSON.parse(tampered.stderr).error).toMatch(/proofs .*aren't the ones the claim was filed with/);
}, 300_000);

test("D7: before publication there is nothing to re-run, and publish is refused before the delay", async () => {
  for (const name of ["vault-delayed", "vault-live"]) {
    const r = await bountee(["rerun", `${PROTOCOL}/${name}`]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(JSON.parse(r.stderr).error).toMatch(/not yet published/);
  }
  const proofsFile = join(dir, "proofs.json");
  writeFileSync(proofsFile, proofsText);
  const early = await bountee(["publish", `${PROTOCOL}/vault-delayed`, "--as", "anyone.testnet", "--proofs", proofsFile]);
  expect(early.code).toBe(1);
  expect(JSON.parse(early.stderr).error).toMatch(/disclosure delay hasn't passed/);
  const unpaid = await bountee(["publish", `${PROTOCOL}/vault-live`, "--as", "anyone.testnet", "--proofs", proofsFile]);
  expect(unpaid.code).toBe(1);
  expect(JSON.parse(unpaid.stderr).error).toMatch(/not been paid/);
}, 120_000);

test("D7.1: publish takes only the proofs the winning claim was filed with, checked before any transaction", async () => {
  views["vault-ready"] = { bounty: bountyView("vault-ready", "paid"), published_exploit: publication({ state: "publishable", proofs: null }) };
  const wrong = join(dir, "wrong-proofs.json");
  writeFileSync(wrong, JSON.stringify(state.proofs.slice(1)));
  const r = await bountee(["publish", `${PROTOCOL}/vault-ready`, "--as", "anyone.testnet", "--proofs", wrong]);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stderr).error).toMatch(/aren't the proofs the winning claim was filed with/);
}, 120_000);
