// `bountee claim`: seal the exploit on this machine, file it with the bounty contract, and
// see it through (#15: sealing and submission; #16: the Foundry-script path, the verdict,
// the payout and the pauses).
//
//   bountee claim [<foundry-script>[:<contract>]] --contract <bounty contract>
//                 --bounty <protocol>/<name> --as <account>
//                 [--sig <fn>] [--job <saved test job.json>]
//                 [--exploit <exploit.json> --evidence <{block, header, proofs}.json>]
//                 [--network testnet|mainnet] [--rpc <NEAR rpc>] [--proof-rpc <chain rpc>]
//                 [--outlayer-api <url>] [--chain-rpc <chain id>=<url>[,...]]
//                 [--timeout <secs>] [--interval <secs>]
//                 [--no-wait] [--no-broadcast] [--no-verify] [--verify-wait <secs>]
//                 [--dry-run] [--json]
//
// With a Foundry script (or `--job`, a job `bountee test` saved), claim runs `test`'s
// collection and submits exactly the inputs it judged, re-running it if the saved block is
// too old to still be recent when the claim lands (D2, D3, R2.8). The exploit is sealed for
// the account filing the claim, to the judge build the bounty contract pins (read from its
// `config`), with the contract as the secret's owner (R5.1, R5.3, R5.4). Only the sealed text
// is sent. The claim balance is topped up with what the claim draws if it's short. Then it
// waits for the verdict; on PAYS it sees the pauses signed and the bounty paid, and
// broadcasts every signed pause, then has each chain's pause verified on NEAR once that chain
// reports it safe, which takes minutes (R7.3; `--no-verify` skips it, `bountee verify-pause`
// does it later; `--verify-wait`, default 3600 s, bounds the wait for the safe head).
// `--dry-run` seals and prints without filing.
//
// From filing on, each stage of the claim is shown the moment the chains show it (D23:
// sealed, checking, the verdict, and on PAYS pauses signed, paid, then each pause landed and
// verified), until nothing more will happen or `--timeout` (default 30 min: a pause is
// verified only once its chain's safe head passes it). A paid claim ends with its receipt
// (D24). The transactions sent are saved under `.bountee/claims/`, so `bountee status` can
// build the receipt again later.
import { readFileSync } from "node:fs";
import { actions } from "near-api-js";
import { parseBlockRef, parseExploit, parseAccountProof, type BountyId, type Exploit, type Verdict } from "@bountee/formats";
import { parseRpcFlags } from "./broadcast.ts";
import { claimCost, ensureClaimBalance, prepareClaim, settle, type Settlement } from "./claim-flow.ts";
import { formatNear, Near, NEAR_RPC, parseNetwork } from "./near.ts";
import { KEYSTORE_API, seal } from "./seal.ts";
import { claimStatus, formatReceipt, saveClaimTxs, watchClaim, type ClaimStatus, type Receipt, type Stage, type StatusOptions } from "./status.ts";

/** `submit_claim` needs at least 200 Tgas; the rest goes to storing the secret, the job and, on PAYS, signing the pauses. */
const CLAIM_GAS = 300_000_000_000_000n;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function required(args: string[], name: string): string {
  const v = flag(args, name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

/** The first argument that is neither a flag nor a flag's value. */
function positional(args: string[]): string | undefined {
  const bare = new Set(["--json", "--watch", "--dry-run", "--no-wait", "--no-broadcast", "--no-verify"]);
  for (let i = 0; i < args.length; i++) {
    if (bare.has(args[i]!)) continue;
    if (args[i]!.startsWith("--")) { i++; continue; }
    return args[i];
  }
  return undefined;
}

function parseBounty(text: string): BountyId {
  const slash = text.lastIndexOf("/");
  if (slash < 1) throw new Error("--bounty is <protocol account>/<bounty name>");
  return { protocol: text.slice(0, slash), name: text.slice(slash + 1) };
}

export interface ClaimResult {
  bounty_contract: string;
  judge_build_hash: string;
  sealed_exploit: string;
  /** The verdict `bountee test` gave these exact inputs (D2); null when claiming from --exploit/--evidence or an unre-run --job. */
  local_verdict?: Verdict | null;
  saved?: string;
  block?: { number: number; hash: string };
  block_age_secs?: number;
  topped_up_near?: string;
  claim_id?: number;
  tx_hash?: string;
  /** The enclave's verdict, once the claim is judged. */
  verdict?: Verdict | null;
  state?: string;
  submitted_at_ns?: string;
  bounty_state?: string;
  paid?: boolean;
  sign_pauses_tx?: string;
  broadcast?: Settlement["broadcast"];
  verification?: Settlement["verification"];
  /** Every stage the claim reached, as shown live (D23). */
  stages?: Stage[];
  /** On a paid claim: the payout, attestation and each pause's transaction (D24). */
  receipt?: Receipt;
}

export async function claim(args: string[], onStage: (s: Stage) => void = () => {}): Promise<ClaimResult> {
  const network = parseNetwork(flag(args, "network"));
  const contract = required(args, "contract");
  const bountyText = required(args, "bounty");
  const bounty = parseBounty(bountyText);
  const whitehat = required(args, "as");
  const near = new Near(network, flag(args, "rpc") ?? NEAR_RPC[network]);

  const live = args.includes("--dry-run") ? { state: "live" } : await near.view<{ state: string } | null>(contract, "bounty", { id: bounty });
  if (!live) throw new Error(`no bounty ${bountyText} on ${contract}`);
  if (live.state !== "live") throw new Error(`bounty ${bountyText} is ${live.state}: it takes no claims${live.state === "paid" || live.state === "signing" || live.state === "paying" ? " (it has been won)" : ""}`);

  let exploit: Exploit;
  let block, header: string, proofs;
  const result: Partial<ClaimResult> = {};
  const script = positional(args);
  if (script || flag(args, "job")) {
    const prepared = await prepareClaim({
      job: flag(args, "job"),
      rpc: flag(args, "proof-rpc"),
      test: script
        ? { script, bounty: bountyText, sig: flag(args, "sig"), rpc: flag(args, "proof-rpc"), contract, nearRpc: near.url }
        : undefined,
    });
    ({ exploit, block, header, proofs } = prepared.replay);
    Object.assign(result, { local_verdict: prepared.local, saved: prepared.saved, block, block_age_secs: prepared.block_age_secs });
  } else {
    exploit = parseExploit(JSON.parse(readFileSync(required(args, "exploit"), "utf8")));
    const evidence = JSON.parse(readFileSync(required(args, "evidence"), "utf8"));
    block = parseBlockRef(evidence.block);
    proofs = (evidence.proofs as unknown[]).map(parseAccountProof);
    header = String(evidence.header);
  }

  const config = await near.provider.callFunction<{ judge_build_hash: string }>({ contractId: contract, method: "config", args: {} });
  if (!config?.judge_build_hash) throw new Error(`${contract} has no judge build pinned`);
  const sealed = await seal({
    api: flag(args, "outlayer-api") ?? KEYSTORE_API[network],
    judgeHash: config.judge_build_hash,
    bountyContract: contract,
    whitehat,
    exploit,
  });
  const out: ClaimResult = { bounty_contract: contract, judge_build_hash: config.judge_build_hash, sealed_exploit: sealed, ...result };
  if (args.includes("--dry-run")) return out;
  // Filing waits for the whole claim transaction, often the verdict too: say it's sealed first.
  onStage({ stage: "sealed", claim_id: null });

  const proofsJson = JSON.stringify(proofs);
  const fees = await near.view(contract, "fees");
  const cost = claimCost(fees, proofsJson.length + header.length + JSON.stringify(block).length + 4096, sealed.length);
  const added = await ensureClaimBalance(near, contract, whitehat, cost);
  if (added > 0n) out.topped_up_near = formatNear(added);

  const outcome = await near.account(whitehat).signAndSendTransaction({
    receiverId: contract,
    actions: [actions.functionCall("submit_claim", { bounty, block, header, proofs: proofsJson, sealed_exploit: sealed }, CLAIM_GAS, 0n)],
    waitUntil: "EXECUTED_OPTIMISTIC",
    throwOnFailure: false,
  });
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
  if (status.SuccessValue === undefined) {
    throw new Error(`the claim was refused: ${JSON.stringify(status.Failure ?? status)}`);
  }
  out.claim_id = Number(JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8")));
  out.tx_hash = outcome.transaction.hash;
  saveClaimTxs(contract, out.claim_id, [out.tx_hash]);
  if (args.includes("--no-wait")) return out;

  // See the claim through (settle) while following it (watchClaim), side by side.
  const chainRpc = flag(args, "chain-rpc");
  const chainRpcs = chainRpc === undefined ? undefined : parseRpcFlags(chainRpc.split(","));
  const statusOptions: StatusOptions = {
    contract,
    claimId: out.claim_id,
    network,
    near,
    rpcs: chainRpcs,
    outlayerApi: flag(args, "outlayer-api"),
    txs: [out.tx_hash],
  };
  let failed = false;
  const settling = settle(near, {
    contract,
    bounty,
    claimId: out.claim_id,
    txHash: out.tx_hash,
    whitehat,
    broadcast: !args.includes("--no-broadcast"),
    verify: !args.includes("--no-broadcast") && !args.includes("--no-verify"),
    verifyWaitSecs: flag(args, "verify-wait") === undefined ? undefined : Number(flag(args, "verify-wait")),
    rpcs: chainRpcs,
  }).catch((e) => {
    failed = true;
    throw e;
  });
  const following = watchClaim(statusOptions, onStage, {
    timeoutSecs: flag(args, "timeout") === undefined ? 1800 : Number(flag(args, "timeout")),
    intervalSecs: flag(args, "interval") === undefined ? undefined : Number(flag(args, "interval")),
    stop: () => failed,
    seen: new Set(["sealed"]), // shown above, before filing
  });
  const [s, followed] = await Promise.all([settling, following]);
  let last: ClaimStatus = followed;
  if (s.sign_pauses_tx) {
    // The payout may sit in the `sign_pauses` retry's transaction rather than the claim's.
    statusOptions.txs = [out.tx_hash, s.sign_pauses_tx];
    saveClaimTxs(contract, out.claim_id, statusOptions.txs);
    if (last.receipt && !last.receipt.payout) last = await claimStatus(statusOptions);
  }
  return {
    ...out,
    verdict: s.verdict,
    state: s.state,
    submitted_at_ns: s.submitted_at_ns,
    bounty_state: s.bounty_state,
    ...(s.paid !== undefined ? { paid: s.paid } : {}),
    ...(s.sign_pauses_tx ? { sign_pauses_tx: s.sign_pauses_tx } : {}),
    ...(s.broadcast ? { broadcast: s.broadcast } : {}),
    ...(s.verification ? { verification: s.verification } : {}),
    stages: last.stages,
    ...(last.receipt ? { receipt: last.receipt } : {}),
  };
}

export function formatClaimResult(r: ClaimResult): string {
  if (r.claim_id === undefined) return `sealed for ${r.bounty_contract} (judge ${r.judge_build_hash}); not filed (--dry-run)`;
  const lines = [`claim ${r.claim_id} filed: ${r.tx_hash}`];
  if (r.local_verdict) lines.push(`bountee test said: ${r.local_verdict.outcome} (${r.local_verdict.reason})`);
  if (r.topped_up_near) lines.push(`claim balance topped up by ${r.topped_up_near} NEAR`);
  if (r.state) lines.push(`enclave: ${r.state}${r.verdict ? ` ${r.verdict.outcome} (${r.verdict.reason})` : " (no verdict)"}`);
  if (r.bounty_state) lines.push(`bounty: ${r.bounty_state}${r.paid ? " (paid to you)" : ""}`);
  if (r.sign_pauses_tx) lines.push(`pauses signed by retry: ${r.sign_pauses_tx}`);
  for (const p of r.broadcast?.pauses ?? []) lines.push(`pause on ${p.chain_id} ${p.contract}: ${p.sent} ${p.tx_hash}${p.receipt ? ` (${p.receipt.status})` : ""}`);
  for (const c of r.verification?.chains ?? []) lines.push(`pause on ${c.chain_id}: ${c.verified ? "verified on NEAR" : `not verified (${c.error ?? "unknown"})`}`);
  if (r.receipt) lines.push(formatReceipt(r.receipt));
  return lines.join("\n");
}
