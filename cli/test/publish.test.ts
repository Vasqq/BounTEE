// Seam T, ticket #23 (offline): anyone re-runs a published winning exploit from the terminal
// with `bountee rerun`, to the verdict the enclave gave; `bountee publish` asks for the
// publication only once it can succeed.
//
// Seams (written before the first test; also in the ticket's findings): T here drives the
// tool against a local stand-in for NEAR's RPC that serves the bounty contract's `bounty`,
// `claim` and `published_exploit` views, and the blocks and chunks holding each claim's
// `submit_claim` transaction (code review of #23: the contract keeps only the proofs'
// sha256 and the claim's submission block). The publication it serves is the real judge's
// output: the test runs the compiled judge's `publish` action under wasmtime, as OutLayer
// runs it for the bounty contract, on a bundle the tool's own sealing code made, beside the
// judge's committed fixture block, header and proofs. Catches D7.1 (a published exploit
// re-runs, from its own header and the proofs fetched from its claim's transaction under the
// compiled judge, to the enclave's verdict; a transaction whose proofs aren't the claim's is
// passed over, none found is named, and a verdict that differs is named as such;
// before publication it is "not yet published"), D7 at the tool (`publish` is refused
// before the delay, and with proofs other than the claim's, before any transaction), and
// R14.5 (JSON), and (#80) that rerun names the judge build it ran and whether it is the bounty's
// pinned build, the program the enclave ran, pointing to `bountee verify` when it isn't. Misses: the real contract (seam C proves the gate and what is kept) and
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
/** The sha256 of the checkout's default judge build, as the tool reports it. */
let builtSha: string | undefined;
const localSha = () => (builtSha ??= createHash("sha256").update(readFileSync(judgeWasm())).digest("hex"));

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
/** The claims, by ID, and the transactions and receipts in each block's one chunk, by height. */
const claims: Record<number, unknown> = {};
const blocks: Record<number, unknown[]> = {};
const receiptsAt: Record<number, unknown[]> = {};
/** A `submit_claim` transaction to the contract carrying `proofs`, as a chunk lists it. */
const submitClaimTx = (proofs: string, receiver = CONTRACT) => ({
  hash: `tx-${sha256(proofs).slice(2, 10)}`,
  signer_id: WHITEHAT,
  receiver_id: receiver,
  actions: [
    { FunctionCall: { method_name: "submit_claim", args: Buffer.from(JSON.stringify({ bounty: {}, proofs, sealed_exploit: "AA==" })).toString("base64"), gas: 300e12, deposit: "0" } },
  ],
});
/**
 * A `submit_claim` receipt to the contract carrying `proofs`, as a chunk lists it: a claim
 * filed through a cross-contract call, by `relay` for a transaction signed by the Whitehat.
 */
const submitClaimReceipt = (proofs: string, relay: string) => ({
  predecessor_id: relay,
  receiver_id: CONTRACT,
  receipt_id: `receipt-${sha256(proofs).slice(2, 10)}`,
  receipt: {
    Action: {
      signer_id: WHITEHAT,
      actions: [
        { FunctionCall: { method_name: "submit_claim", args: Buffer.from(JSON.stringify({ bounty: {}, proofs, sealed_exploit: "AA==" })).toString("base64"), gas: 250e12, deposit: "0" } },
      ],
    },
  },
});
/** Claim `id`, filed with `proofs`, whose submission ran in block `at`. */
const claimAt = (id: number, at: number, proofs: string) => {
  claims[id] = { whitehat: WHITEHAT, proofs_sha256: sha256(proofs), submitted_at_block: String(at), state: "judged" };
};
const bountyView = (name: string, s: string) => ({ id: { protocol: PROTOCOL, name }, rules, state: s, winning_claim: 3 });
const now = BigInt(Date.now()) * 1_000_000n;
const publication = (o: { state: string; claim?: number; from?: bigint; published?: string | null; verdict?: unknown }) => {
  const claim = claims[o.claim ?? 3] as { proofs_sha256: string; submitted_at_block: string };
  return {
    claim_id: o.claim ?? 3,
    state: o.state,
    publishable_from_ns: String(o.from ?? now - DAY_NS),
    block: state.block,
    header: state.header,
    proofs_sha256: claim.proofs_sha256,
    submitted_at_block: claim.submitted_at_block,
    verdict: o.verdict ?? PAYS,
    published: o.published ?? null,
  };
};

let rpc: string;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { id, method, params } = JSON.parse(body);
    const reply = (r: object) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id, ...r }));
    };
    if (method === "block") {
      const height = params.block_id as number;
      // A height with no block, as NEAR answers a skipped one.
      if (height === 999) return reply({ error: { name: "HANDLER_ERROR", cause: { name: "UNKNOWN_BLOCK" } } });
      return reply({ result: { header: { height }, chunks: [{ chunk_hash: `chunk-${height}`, height_included: height }] } });
    }
    if (method === "chunk") {
      const height = Number(String(params.chunk_id).slice("chunk-".length));
      return reply({ result: { transactions: blocks[height] ?? [], receipts: receiptsAt[height] ?? [] } });
    }
    const args = JSON.parse(Buffer.from(params.args_base64, "base64").toString("utf8"));
    const view =
      params.method_name === "claim" ? (claims[args.claim_id] ?? null) : (views[args.id.name]?.[params.method_name as "bounty" | "published_exploit"] ?? null);
    reply({ result: { result: [...Buffer.from(JSON.stringify(view))], logs: [] } });
  });
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  rpc = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const otherProofs = JSON.stringify(state.proofs.slice(1));
  // Claim 3 ran in block 1000; its transaction sits three blocks before it, behind a skipped
  // height and a block holding a call with other proofs and one to another contract.
  claimAt(3, 1000, proofsText);
  blocks[998] = [submitClaimTx(otherProofs), submitClaimTx(proofsText, "other-contract.testnet")];
  blocks[997] = [submitClaimTx(proofsText)];
  const published = publish("vault", 3);
  views.vault = { bounty: bountyView("vault", "paid"), published_exploit: publication({ state: "published", published }) };
  // Published, but no transaction near its claim's block carries the claim's proofs.
  claimAt(4, 2000, proofsText);
  blocks[1999] = [submitClaimTx(otherProofs)];
  views["vault-tampered"] = {
    bounty: { ...bountyView("vault-tampered", "paid"), winning_claim: 4 },
    published_exploit: publication({ state: "published", claim: 4, published: publish("vault-tampered", 4) }),
  };
  // Published, but the verdict on record isn't the one the exploit re-runs to.
  views["vault-zero"] = {
    bounty: bountyView("vault-zero", "paid"),
    published_exploit: publication({ state: "published", published: publish("vault-zero", 3), verdict: { outcome: "ZERO", reason: "below_minimum_theft" } }),
  };
  // Claim 5 was filed through a cross-contract call: no transaction calls the bounty
  // contract; the relay's receipt to it, two blocks before the submission ran, does.
  claimAt(5, 3000, proofsText);
  blocks[2998] = [submitClaimTx(proofsText, "relay.testnet")];
  receiptsAt[2999] = [submitClaimReceipt(otherProofs, "relay.testnet"), submitClaimReceipt(proofsText, "relay.testnet")];
  views["vault-relayed"] = {
    bounty: { ...bountyView("vault-relayed", "paid"), winning_claim: 5 },
    published_exploit: publication({ state: "published", claim: 5, published: publish("vault-relayed", 5) }),
  };
  // Paid, but the disclosure delay hasn't passed.
  views["vault-delayed"] = {
    bounty: bountyView("vault-delayed", "paid"),
    published_exploit: publication({ state: "delayed", from: now + DAY_NS }),
  };
  views["vault-live"] = { bounty: bountyView("vault-live", "live"), published_exploit: null };
  // Published, on a bounty whose rules pin the checkout's own judge build.
  views["vault-pinned"] = {
    bounty: { ...bountyView("vault-pinned", "paid"), rules: { ...rules, judge_build_hash: `0x${localSha()}` } },
    published_exploit: publication({ state: "published", published: publish("vault-pinned", 3) }),
  };
}, 600_000);
afterAll(() => server.close());

function bountee(args: string[], o: { json?: boolean } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args, "--contract", CONTRACT, "--near-rpc", rpc, ...(o.json === false ? [] : ["--json"])]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("D7.1, R14.5: a published exploit re-runs from its own header and its claim's proofs to the enclave's verdict", async () => {
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
    judge: { sha256: localSha(), bounty_build: rules.judge_build_hash, same_as_bounty: false },
  });
  // The saved job is a plain replay anyone can run again with `bountee test --job`.
  const job = JSON.parse(readFileSync(out, "utf8"));
  expect(job.replay.header).toBe(state.header);
  expect(job.replay.proofs).toEqual(state.proofs);
  expect(job.replay.exploit).toEqual(readFixture("exploits/drain.json"));
  const again = await bountee(["test", "--job", out]);
  expect(JSON.parse(again.stdout).verdict).toEqual(PAYS);
}, 300_000);

test("D7.1: rerun under a build other than the bounty's pinned one says so, names the pinned build, and points to bountee verify", async () => {
  const r = await bountee(["rerun", `${PROTOCOL}/vault`], { json: false });
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  expect(r.stdout).toContain(`sha256 ${localSha()}`);
  expect(r.stdout).toContain(`not the bounty's pinned build ${rules.judge_build_hash}`);
  expect(r.stdout).toContain("bountee verify");
  expect(r.stdout).toContain("--judge");
  expect(r.stdout).not.toMatch(/differs only/);
}, 300_000);

test("D7.1, R14.5: rerun under the bounty's pinned build says it ran the program the enclave runs", async () => {
  const json = await bountee(["rerun", `${PROTOCOL}/vault-pinned`]);
  expect(json.code).toBe(0);
  expect(JSON.parse(json.stdout).judge).toMatchObject({ sha256: localSha(), bounty_build: `0x${localSha()}`, same_as_bounty: true });
  const text = await bountee(["rerun", `${PROTOCOL}/vault-pinned`], { json: false });
  expect(text.code).toBe(0);
  expect(text.stdout).toContain("the bounty's pinned build: the program the enclave runs");
  expect(text.stdout).not.toContain("not the bounty's pinned build");
}, 300_000);

test("D7.1: a claim filed through a cross-contract call re-runs too: its proofs are found in its receipt", async () => {
  const r = await bountee(["rerun", `${PROTOCOL}/vault-relayed`]);
  expect(r.stderr).toBe("");
  expect(r.code).toBe(0);
  expect(JSON.parse(r.stdout)).toMatchObject({ claim_id: 5, verdict: PAYS, enclave_verdict: PAYS, same_verdict: true });
}, 300_000);

test("D7.1: a verdict that differs from the enclave's, or a claim whose proofs can't be found, are named", async () => {
  const zero = await bountee(["rerun", `${PROTOCOL}/vault-zero`]);
  expect(zero.code).toBe(1);
  expect(JSON.parse(zero.stdout)).toMatchObject({ verdict: PAYS, enclave_verdict: { outcome: "ZERO" }, same_verdict: false });

  const tampered = await bountee(["rerun", `${PROTOCOL}/vault-tampered`]);
  expect(tampered.code).toBe(1);
  expect(tampered.stdout).toBe("");
  expect(JSON.parse(tampered.stderr).error).toMatch(/couldn't find claim 4's proofs \(sha256 0x[0-9a-f]{64}\) in a submit_claim call at NEAR blocks 1990-2000/);
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
  views["vault-ready"] = { bounty: bountyView("vault-ready", "paid"), published_exploit: publication({ state: "publishable" }) };
  const wrong = join(dir, "wrong-proofs.json");
  writeFileSync(wrong, JSON.stringify(state.proofs.slice(1)));
  const r = await bountee(["publish", `${PROTOCOL}/vault-ready`, "--as", "anyone.testnet", "--proofs", wrong]);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stderr).error).toMatch(/these proofs hash to 0x[0-9a-f]{64}, but claim 3 was filed with 0x[0-9a-f]{64}: give the proofs it was filed with/);
}, 120_000);
