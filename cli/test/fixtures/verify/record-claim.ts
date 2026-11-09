// Records a paid testnet bounty's winning claim for verify.test.ts, as `bountee verify` reads
// it: the contract's views, the claim's transaction as FastNEAR's explorer lists it and as NEAR's
// archival RPC gives it (with the block its job was requested in), OutLayer's attestation of the
// job, and each signed pause's receipt on its chain. Read-only: no keys, nothing sent.
//
// Run: node cli/test/fixtures/verify/record-claim.ts <contract> <protocol>/<name> <tx hash> <prefix>
// writes <prefix>-views.json, <prefix>-tx.json, <prefix>-rpc.json and <prefix>-attestation.json
// next to this file.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defaultRpc } from "../../../src/chains.ts";
import { ARCHIVAL_RPC, KEYSTORE_API, TX_API } from "../../../src/endpoints.ts";
import { Near } from "../../../src/near.ts";
import { rpc as evm } from "../../../src/proofs.ts";

const [contract, bountyName, txHash, prefix] = process.argv.slice(2);
if (!contract || !bountyName || !txHash || !prefix) throw new Error("usage: record-claim.ts <contract> <protocol>/<name> <tx hash> <prefix>");
const [protocol, name] = bountyName.split("/");
const id = { protocol, name };
const near = new Near("testnet");
const archive = new Near("testnet", ARCHIVAL_RPC.testnet);
// NEAR RPC's record is kept compact, as RPC returns it (it is most of the recording).
const write = (part: string, x: unknown, compact = false) =>
  writeFileSync(fileURLToPath(new URL(`${prefix}-${part}.json`, import.meta.url)), `${compact ? JSON.stringify(x) : JSON.stringify(x, null, 2)}\n`);

const bounty = await near.view<any>(contract, "bounty", { id });
if (bounty?.state !== "paid") throw new Error(`${bountyName} is ${bounty?.state}, not paid`);
const claim = await near.view<any>(contract, "claim", { claim_id: bounty.winning_claim });
const config = await near.view<any>(contract, "config");
const pauseVerifications = await near.view<any>(contract, "pause_verifications", { id });
write("views", { contract, bounty, claim_id: bounty.winning_claim, claim, config, pause_verifications: pauseVerifications });

// The explorer's account, cut to what verify reads from it (explorer.ts): who signed, and each
// receipt's executor, logs and status.
const listed = await fetch(`${TX_API.testnet}/v0/transactions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ tx_hashes: [txHash] }),
}).then((r) => r.json() as Promise<{ transactions: any[] }>);
const t = listed.transactions[0];
write("tx", {
  transaction: { hash: t.transaction.hash, signer_id: t.transaction.signer_id, receiver_id: t.transaction.receiver_id },
  receipts: t.receipts.map((x: any) => ({
    execution_outcome: { id: x.execution_outcome.id, outcome: { executor_id: x.execution_outcome.outcome.executor_id, logs: x.execution_outcome.outcome.logs, status: x.execution_outcome.outcome.status } },
  })),
});

// NEAR RPC's account, and the height of each block a receipt that logged an OutLayer request ran in.
const status = await archive.rpc<any>("EXPERIMENTAL_tx_status", { tx_hash: txHash, sender_account_id: t.transaction.signer_id, wait_until: "FINAL" });
// The claim's sealed exploit rides in two calls' arguments as OutLayer ciphertext: `submit_claim`'s
// `sealed_exploit` and OutLayer's `store_secrets`. Neither is read by verify, and nothing sealed,
// even encrypted, goes in the repo: both are replaced here.
const REDACTED = "redacted: the sealed exploit, as OutLayer ciphertext";
const redact = (actions: any[] = []) => {
  for (const a of actions) {
    const call = a.FunctionCall;
    if (!call) continue;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(Buffer.from(call.args, "base64").toString("utf8"));
    } catch {
      continue; // not JSON arguments
    }
    if (!["sealed_exploit", "encrypted_secrets_base64"].some((f) => f in args)) continue;
    for (const field of ["sealed_exploit", "encrypted_secrets_base64"]) if (field in args) args[field] = REDACTED;
    call.args = Buffer.from(JSON.stringify(args)).toString("base64");
  }
};
redact(status.transaction.actions);
for (const r of status.receipts) redact(r.receipt?.Action?.actions);
const blocks: Record<string, { height: number }> = {};
for (const r of status.receipts_outcome) {
  if (r.outcome.executor_id !== config.outlayer || !r.outcome.logs.some((l: string) => l.includes("execution_requested"))) continue;
  blocks[r.block_hash] = { height: (await archive.rpc<any>("block", { block_id: r.block_hash })).header.height };
}
const evmReceipts: Record<string, unknown> = {};
for (const p of bounty.signed_pauses) {
  const receipt = await evm<any>(defaultRpc(p.chain_id)!, "eth_getTransactionReceipt", [p.tx_hash]);
  evmReceipts[p.tx_hash] = { status: receipt.status, blockNumber: receipt.blockNumber, to: receipt.to };
}
write("rpc", { tx_status: status, blocks, evm_receipts: evmReceipts }, true);

const attestation = await fetch(`${KEYSTORE_API.testnet}/attestations/by-tx/${txHash}`, { headers: { "User-Agent": "bountee-cli" } }).then((r) => {
  if (!r.ok) throw new Error(`OutLayer has no attestation for ${txHash}: ${r.status}`);
  return r.json();
});
write("attestation", attestation);
console.log(`recorded claim ${bounty.winning_claim} of ${bountyName} on ${contract} as ${prefix}-*.json`);
