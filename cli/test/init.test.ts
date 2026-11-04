// Seam T: `bountee init` (D18, R14.5), spawned from the terminal as a Whitehat or agent runs it.
// The chain is read back with plain NEAR RPC, never through the tool.
//
// The mainnet case runs offline every time. The testnet case asks NEAR's faucet service
// for a real account, so it runs only with BOUNTEE_TESTNET_INIT=1 (and in the Day-3 run,
// `day3-testnet.test.ts`, whose Whitehat `init` creates).
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { base58 } from "@scure/base";
import { expect, test } from "vitest";

const entry = fileURLToPath(new URL("../src/main.ts", import.meta.url));

function bountee(args: string[], env: Record<string, string> = {}) {
  const res = spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { code: res.status, stdout: res.stdout, stderr: res.stderr };
}

async function nearRpc(method: string, params: unknown): Promise<any> {
  const res = await fetch("https://test.rpc.fastnear.com", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result;
}

test("D18 R14.5: on mainnet, init makes a local account and states how much NEAR to add and where", () => {
  const dir = mkdtempSync(join(tmpdir(), "bountee-init-"));
  const { code, stdout, stderr } = bountee(["init", "--network", "mainnet", "--json"], { BOUNTEE_CREDENTIALS_DIR: dir });
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const out = JSON.parse(stdout);
  expect(out.network).toBe("mainnet");
  expect(out.funded).toBe(false);
  // The address to send to is the account itself: an implicit account, 64 hex digits.
  expect(out.account_id).toMatch(/^[0-9a-f]{64}$/);
  expect(out.send_to).toBe(out.account_id);
  expect(Number(out.add_near)).toBeGreaterThan(0);
  expect(out.message).toContain(out.add_near);
  expect(out.message).toContain(out.account_id);

  // The key is kept locally, readable only by its owner, and the implicit account is that
  // key's public half in hex (NEAR's implicit-account rule).
  const file = join(dir, `${out.account_id}.json`);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  expect(saved.account_id).toBe(out.account_id);
  const pub = base58.decode(String(saved.public_key).replace(/^ed25519:/, ""));
  expect(Buffer.from(pub).toString("hex")).toBe(out.account_id);
  expect(stdout).not.toContain(saved.private_key);
});

test.runIf(process.env.BOUNTEE_TESTNET_INIT === "1")(
  "D18 R14.5: on testnet, init creates a named account funded by NEAR's faucet service, no sign-up",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "bountee-init-"));
    const { code, stdout, stderr } = bountee(["init", "--json"], { BOUNTEE_CREDENTIALS_DIR: dir });
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const out = JSON.parse(stdout);
    expect(out.network).toBe("testnet");
    expect(out.funded).toBe(true);
    expect(out.account_id).toMatch(/\.testnet$/);

    const saved = JSON.parse(readFileSync(join(dir, `${out.account_id}.json`), "utf8"));
    const account = await nearRpc("query", { request_type: "view_account", finality: "final", account_id: out.account_id });
    expect(BigInt(account.amount)).toBeGreaterThan(10n ** 24n); // over 1 NEAR, from the faucet
    const key = await nearRpc("query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: out.account_id,
      public_key: saved.public_key,
    });
    expect(key.permission).toBe("FullAccess");
  },
  120_000,
);
