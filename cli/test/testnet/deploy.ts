// What the deploy scripts share (deploy-system.ts, deploy-sealing.ts): build the judge and
// upload it to OutLayer's FastFS, the bounty contract's configuration, and its keyless
// deployment, on the network NETWORK names (testnet, the default, or mainnet).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { actions, PublicKey } from "near-api-js";
import { pauseRole } from "@bountee/formats";
import { reproducibleBuild } from "../../src/build.ts";
import { Near, milliNear, parseNetwork, tgas } from "../../src/near.ts";

export const root = fileURLToPath(new URL("../../../", import.meta.url));
export const network = parseNetwork(process.env.NETWORK);
export const near = new Near(network, process.env.NEAR_RPC);

/**
 * The gas a fresh demo instance's deploy burns on one chain, with ~18% slack:
 * demo/script/Deploy.s.sol (the mock USDC on testnet, the PositionVault, and the seed's mint,
 * approve and deposit) plus the pause-gas transfer. fresh-instance.ts budgets the deployer's
 * ETH from it. Measured on Nov 8, 2026 (ticket #52) from the receipts: 2,199,437 gas on Base
 * Sepolia (five deploy transactions and the transfer); 1,387,416 on a local fork of Base with
 * Circle's USDC (vault, approve, deposit and the transfer; no mock, no mint).
 */
export const DEMO_DEPLOY_GAS = 2_600_000n;

/**
 * How much of Circle's USDC each mainnet demo vault starts with: 2 on every chain, since a
 * claim may be proven on any of them (ADR-0020); testnet mints a mock.
 */
export const VAULT_USDC = 2_000_000n;

/** OutLayer and NEAR's MPC signer on each network (spec, external services). */
const OUTLAYER = { testnet: "outlayer.testnet", mainnet: "outlayer.near" } as const;
const MPC = { testnet: "v1.signer-prod.testnet", mainnet: "v1.signer" } as const;
export const MPC_ROOT = { testnet: pauseRole.TESTNET_ROOT_PUBLIC_KEY, mainnet: pauseRole.MAINNET_ROOT_PUBLIC_KEY } as const;
/** Circle's USDC on NEAR mainnet; on testnet a stock NEP-141 stand-in (Circle's needs a browser faucet). */
export const DEFAULT_USDC = { testnet: "ft.bountee-spike4.testnet", mainnet: "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1" } as const;

/**
 * Build the attested judge (no features), pinned to `pinnedTo` as its only caller, with the
 * reproducible build (`bountee build`, R15.2) of the checkout's HEAD commit, so anyone
 * rebuilds the hash the deployment pins.
 */
export function buildJudge(pinnedTo: string): { wasm: Buffer; hash: string } {
  const built = reproducibleBuild({ pin: pinnedTo, only: "judge" }).judge!;
  return { wasm: readFileSync(built.wasm), hash: built.sha256 };
}

/**
 * Upload the judge's wasm to FastFS (borsh `0u8 | path | Some(mime) | bytes`, a call that
 * fails on purpose with gas 1: FastFS indexes the transaction's arguments), unless it is
 * already served. Returns its URL and the upload transaction, if one was sent.
 */
export async function upload(signer: string, wasm: Buffer, hash: string): Promise<{ url: string; tx?: string }> {
  const str = (b: Buffer) => Buffer.concat([Buffer.from(new Uint32Array([b.length]).buffer), b]);
  const args = Buffer.concat([
    Buffer.from([0]), str(Buffer.from(`${hash}.wasm`)), Buffer.from([1]), str(Buffer.from("application/wasm")), str(wasm),
  ]);
  const outlayer = OUTLAYER[network];
  // FastFS serves a file at `<host>/<signer>/<receiver>/<file>` (testnet's host is test.fastfs.io,
  // read as mainnet's main.fastfs.io) and at `<signer>.fastfs.io/<receiver>/<file>`, which
  // OutLayer's docs show but which fails for a signer with three labels (bounty.bountee.near).
  // The first that serves the very bytes is the URL; nothing is pinned until one does.
  const urls = [
    `https://${network === "mainnet" ? "main" : "test"}.fastfs.io/${signer}/${outlayer}/${hash}.wasm`,
    `https://${signer}.fastfs.io/${outlayer}/${hash}.wasm`,
  ];
  const served = async () => {
    for (const url of urls) {
      const r = await fetch(url).catch(() => undefined);
      if (r?.ok && createHash("sha256").update(Buffer.from(await r.arrayBuffer())).digest("hex") === hash) return url;
    }
    return undefined;
  };
  const already = await served();
  if (already) return { url: already };
  const r = await near.account(signer).signAndSendTransaction({
    receiverId: outlayer,
    actions: [actions.functionCall("__fastdata_fastfs", args, 1n, 0n)],
    throwOnFailure: false,
    waitUntil: "FINAL",
  });
  console.error(`FastFS upload of ${hash}: tx ${r.transaction.hash}`);
  for (let i = 0; i < 60; i++) {
    const url = await served();
    if (url) return { url, tx: r.transaction.hash };
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`${hash}.wasm is not served at ${urls.join(" or ")}`);
}

/** The bounty contract's configuration on the network: real OutLayer and MPC, the given USDC. */
export function contractConfig(o: { usdc: string; judgeHash: string; judgeUrl: string }) {
  return {
    outlayer: OUTLAYER[network],
    mpc: MPC[network],
    mpc_root_public_key: MPC_ROOT[network],
    usdc: o.usdc,
    judge_build_hash: `0x${o.judgeHash}`,
    judge_wasm_url: o.judgeUrl,
    seed: { native: "1000000000000000000", tokens: [] },
  };
}

/** One balance a run needs, as the preflights report it. */
export interface Need { who: string; chain: string; asset: string; have: string; need: string; ok: boolean; top_up?: string }

/** A whole-number setting from the environment, or `fallback` when unset; anything else stops the script. */
export function wholeNumber(name: string, fallback?: number): number {
  const text = process.env[name];
  if (text === undefined || text === "") {
    if (fallback === undefined) throw new Error(`set ${name}`);
    return fallback;
  }
  if (!/^\d+$/.test(text)) throw new Error(`${name} must be a whole number, not ${JSON.stringify(text)}`);
  return Number(text);
}

/** `who`'s balance of `asset` on `chain` against what the run needs, each shown with `show`. */
export function need(who: string, chain: string, asset: string, have: bigint, want: bigint, show: (x: bigint) => string): Need {
  return { who, chain, asset, have: show(have), need: show(want), ok: have >= want, ...(have < want ? { top_up: show(want - have) } : {}) };
}

/**
 * The preflight's end (spec, Testing Decisions): every balance to stderr; if any is short, a
 * JSON line naming each top-up and exit status 3, before anything is spent; with
 * PREFLIGHT_ONLY=1, a JSON line and exit status 0 either way. `plan` (what the run will do,
 * such as its claim count) goes into both JSON lines.
 */
export function stopIfShort(needs: Need[], plan: Record<string, unknown> = {}): void {
  console.error(needs.map((n) => `${n.ok ? "ok   " : "SHORT"} ${n.who} (${n.chain}) ${n.asset}: has ${n.have}, needs ${n.need}`).join("\n"));
  const short = needs.filter((n) => !n.ok);
  if (short.length > 0) {
    console.log(JSON.stringify({ ok: false, ...plan, balances: needs, top_up: short.map((n) => `${n.top_up} to ${n.who} on ${n.chain}`) }));
    process.exit(3);
  }
  if (process.env.PREFLIGHT_ONLY === "1") {
    console.log(JSON.stringify({ ok: true, ...plan, balances: needs }));
    process.exit(0);
  }
}

/** The reproducible build of HEAD's bounty contract (R15.2); its NEP-330 metadata names the commit. */
export function buildContract(contract: string): Buffer {
  return readFileSync(reproducibleBuild({ pin: contract, only: "contract" }).contract!.wasm);
}

/**
 * Deploy the bounty contract keyless (R2.1): one transaction deploys the code (built here
 * unless given), calls `new` and deletes every access key the account has, signed by one of
 * them. Does nothing if the account has no key left (it is deployed already). Checks no key
 * remains either way.
 */
export async function deployKeyless(contract: string, config: ReturnType<typeof contractConfig>, built?: Buffer): Promise<string | undefined> {
  const keys = await near.provider.viewAccessKeyList({ accountId: contract });
  let tx: string | undefined;
  if (keys.keys.length > 0) {
    const code = built ?? buildContract(contract);
    const r = await near.account(contract).signAndSendTransaction({
      receiverId: contract,
      actions: [
        actions.deployContract(code),
        actions.functionCall("new", { config }, tgas(100), milliNear(12.5)),
        ...keys.keys.map((k) => actions.deleteKey(PublicKey.fromString(k.public_key))),
      ],
      waitUntil: "FINAL",
    });
    tx = r.transaction.hash;
    console.error(`deployed keyless: ${tx}`);
  }
  const remaining = await near.provider.viewAccessKeyList({ accountId: contract });
  if (remaining.keys.length > 0) throw new Error(`${contract} still has ${remaining.keys.length} access key(s)`);
  return tx;
}
