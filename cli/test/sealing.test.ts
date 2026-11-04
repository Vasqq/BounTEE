// Seam T, ticket #15 (offline half): `bountee claim` seals the exploit on the Whitehat's
// machine. A local stand-in plays OutLayer's keystore and NEAR's RPC and records every
// request the tool makes, so the test sees all that leaves the machine.
//
// Seams (written before the first test): T here catches what the tool sends (R5.1: no
// plaintext exploit in any request) and what it seals (the exploit bound to the claimant,
// to the judge build the bounty contract pins and the contract as owner, R5.3, R5.4).
// It misses whether real OutLayer opens it only for the pinned build in the contract's own
// jobs: `sealing-testnet.test.ts` runs that against OutLayer testnet (R5.2, R5.3).
import { spawn } from "node:child_process";
import { createDecipheriv, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";
import { afterAll, beforeAll, expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const judgeFixtures = new URL("../../judge/tests/fixtures/", import.meta.url);
const JUDGE_HASH = "0x" + "5a".repeat(32);
const CONTRACT = "bounty.example.testnet";

function bountee(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// The stand-in keystore's X25519 key pair; the test opens what the tool sealed with it.
const keystore = generateKeyPairSync("x25519");
const keystorePub = keystore.publicKey.export({ format: "der", type: "spki" }).subarray(12);
const requests: { url: string; body: string }[] = [];
let base = "";

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => resolve(body));
  });

const server = createServer(async (req, res) => {
  const body = await readBody(req);
  requests.push({ url: req.url ?? "", body });
  res.setHeader("Content-Type", "application/json");
  if (req.url === "/secrets/pubkey") {
    res.end(JSON.stringify({ pubkey: keystorePub.toString("hex") }));
    return;
  }
  const rpc = JSON.parse(body);
  if (rpc.method === "query" && rpc.params?.method_name === "config") {
    const config = { outlayer: "outlayer.testnet", judge_build_hash: JUDGE_HASH, judge_wasm_url: "https://x.test/j.wasm" };
    const result = [...Buffer.from(JSON.stringify(config))];
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { result, logs: [], block_height: 1, block_hash: "11111111111111111111111111111111" } }));
    return;
  }
  res.statusCode = 400;
  res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { message: "not in the stand-in" } }));
});

beforeAll(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});
afterAll(() => server.close());

/** Open OutLayer's ECIES v1 as its keystore does (spec, "Sealing"). */
function open(sealed: string): string {
  const raw = Buffer.from(sealed, "base64");
  expect(raw[0]).toBe(1);
  const eph = createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), raw.subarray(1, 33)]),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey: keystore.privateKey, publicKey: eph });
  const key = Buffer.from(hkdfSync("sha256", shared, Buffer.alloc(0), "outlayer-keystore-v1", 32));
  const nonce = raw.subarray(33, 45);
  const body = raw.subarray(45);
  const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  d.setAuthTag(body.subarray(body.length - 16));
  return Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]).toString("utf8");
}

test("R5.1, R5.3, R5.4: claim seals the exploit locally, bound to the claimant, to the pinned build and the bounty contract", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bountee-seal-"));
  const exploitText = readFileSync(new URL("exploits/drain.json", judgeFixtures), "utf8");
  const exploit = JSON.parse(exploitText);
  const state = JSON.parse(readFileSync(new URL("state.json", judgeFixtures), "utf8"));
  writeFileSync(join(dir, "exploit.json"), exploitText);
  writeFileSync(join(dir, "evidence.json"), JSON.stringify({ block: state.block, header: state.header, proofs: state.proofs }));

  const { code, stdout, stderr } = await bountee([
    "claim", "--contract", CONTRACT, "--bounty", "protocol.testnet/vault", "--as", "alice.testnet",
    "--exploit", join(dir, "exploit.json"), "--evidence", join(dir, "evidence.json"),
    "--rpc", base, "--outlayer-api", base, "--dry-run", "--json",
  ]);
  expect(code, stderr).toBe(0);
  const out = JSON.parse(stdout);
  expect(out.judge_build_hash).toBe(JUDGE_HASH);

  // R5.1: nothing that left the machine carries the exploit: no transaction's calldata,
  // and only the secret's name, with an empty value, went to the keystore.
  expect(requests.length).toBeGreaterThan(0);
  const sent = requests.map((r) => r.body).join("\n");
  for (const tx of exploit.transactions) {
    expect(sent).not.toContain(tx.input.slice(2));
    expect(sent).not.toContain(tx.from.slice(2));
  }
  const keyRequests = requests.filter((r) => r.url === "/secrets/pubkey");
  expect(keyRequests).toHaveLength(1);
  const keyRequest = JSON.parse(keyRequests[0]!.body);
  // R5.3: sealed to the judge build the bounty contract pins, with the contract as owner.
  expect(keyRequest.accessor).toStrictEqual({ type: "WasmHash", hash: JUDGE_HASH.slice(2) });
  expect(keyRequest.owner).toBe(CONTRACT);
  expect(JSON.parse(keyRequest.secrets_json)).toStrictEqual({ BOUNTEE_SEALED_EXPLOIT: "" });

  // What was sealed opens to the exploit bound to the claimant (R5.4).
  const secrets = JSON.parse(open(out.sealed_exploit));
  expect(Object.keys(secrets)).toStrictEqual(["BOUNTEE_SEALED_EXPLOIT"]);
  const bundle = JSON.parse(inflateRawSync(Buffer.from(secrets.BOUNTEE_SEALED_EXPLOIT, "base64")).toString("utf8"));
  expect(bundle).toStrictEqual({ whitehat: "alice.testnet", exploit });
  // The sealed text itself shows nothing of the exploit.
  expect(out.sealed_exploit).not.toContain(exploit.transactions[0].input.slice(2, 40));
});
