// Grows a saved claim job (`bountee test --out`) to a mainnet claim's size with real proofs,
// so a testnet run files what mainnet will (#35). On Nov 10 the mainnet demo's claims carried
// 141 KB (an Arbitrum One win), 156 KB (a Base win) and 286 KB (a Base cheat) of proofs, where
// Base Sepolia's carry about 50 KB; a contract gas reserve that held at 50 KB failed at 286 KB.
//
// It adds EIP-1186 proofs, fetched at the job's own block, of accounts the exploit never reads
// (addresses hashed from a counter). Each is checked against the block's state root like any
// other (judge `proofs.rs`), and an account the replay doesn't touch changes nothing it
// computes, so the verdict stays the job's own: check it with `bountee test --job <out>` (D2).
//
// Run: node cli/test/testnet/pad-job.ts <job.json> <target KB> <out.json> [proof RPC]
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fetchProof } from "../../src/proofs.ts";
import { CHAINS } from "../../src/chains.ts";

const [jobPath, targetKb, outPath, rpcArg] = process.argv.slice(2);
if (!jobPath || !targetKb || !outPath) throw new Error("usage: pad-job.ts <job.json> <target KB> <out.json> [proof RPC]");
const job = JSON.parse(readFileSync(jobPath, "utf8"));
const { block } = job.replay;
const rpc = rpcArg ?? CHAINS[block.chain_id]?.proofRpcs[0];
if (!rpc) throw new Error(`no proof RPC for chain ${block.chain_id}`);

const target = Number(targetKb) * 1024;
const size = () => JSON.stringify(job.replay.proofs).length;
const start = size();
for (let i = 0; size() < target; i++) {
  const address = `0x${createHash("sha256").update(`bountee-pad-${i}`).digest("hex").slice(0, 40)}`;
  job.replay.proofs.push(await fetchProof(rpc, address, [], block.number));
}
writeFileSync(outPath, `${JSON.stringify(job)}\n`);
console.log(JSON.stringify({ out: outPath, chain_id: block.chain_id, block: block.number, proofs_bytes_before: start, proofs_bytes: size() }));
