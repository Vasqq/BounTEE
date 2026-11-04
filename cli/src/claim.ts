// `bountee claim`: seal the exploit on this machine and file it with the bounty contract
// (#15: sealing and submission; #16 adds the Foundry-script path, live progress and the
// receipt).
//
//   bountee claim --contract <bounty contract> --bounty <protocol>/<name> --as <account>
//                 --exploit <exploit.json> --evidence <{block, header, proofs}.json>
//                 [--network testnet|mainnet] [--rpc <url>] [--outlayer-api <url>]
//                 [--dry-run] [--json]
//
// The exploit is sealed for the account filing the claim, to the judge build the bounty
// contract pins (read from its `config`), with the contract as the secret's owner (R5.1,
// R5.3, R5.4). Only the sealed text is sent. `--dry-run` seals and prints it without filing.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Account, actions, JsonRpcProvider, type KeyPairString } from "near-api-js";
import { parseBlockRef, parseExploit, parseAccountProof, type BountyId } from "@bountee/formats";
import { KEYSTORE_API, seal } from "./seal.ts";

const NEAR_RPC = { testnet: "https://test.rpc.fastnear.com", mainnet: "https://free.rpc.fastnear.com" } as const;
/** `submit_claim` needs at least 200 Tgas; the rest goes to storing the secret and the job. */
const CLAIM_GAS = 300_000_000_000_000n;

type Network = keyof typeof NEAR_RPC;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function required(args: string[], name: string): string {
  const v = flag(args, name);
  if (!v) throw new Error(`--${name} is required`);
  return v;
}

function parseBounty(text: string): BountyId {
  const slash = text.lastIndexOf("/");
  if (slash < 1) throw new Error("--bounty is <protocol account>/<bounty name>");
  return { protocol: text.slice(0, slash), name: text.slice(slash + 1) };
}

/** The account's key as near-cli keeps it: ~/.near-credentials/<network>/<account>.json. */
function credentials(network: Network, account: string): KeyPairString {
  const dir = process.env.BOUNTEE_CREDENTIALS_DIR ?? join(homedir(), ".near-credentials", network);
  const file = JSON.parse(readFileSync(join(dir, `${account}.json`), "utf8"));
  const key = file.private_key ?? file.secret_key;
  if (typeof key !== "string") throw new Error(`no key for ${account} in ${dir}`);
  return key as KeyPairString;
}

export interface ClaimResult {
  bounty_contract: string;
  judge_build_hash: string;
  sealed_exploit: string;
  claim_id?: number;
  tx_hash?: string;
}

export async function claim(args: string[]): Promise<ClaimResult> {
  const network = (flag(args, "network") ?? "testnet") as Network;
  if (!(network in NEAR_RPC)) throw new Error("--network is testnet or mainnet");
  const contract = required(args, "contract");
  const bounty = parseBounty(required(args, "bounty"));
  const whitehat = required(args, "as");
  const exploit = parseExploit(JSON.parse(readFileSync(required(args, "exploit"), "utf8")));
  const evidence = JSON.parse(readFileSync(required(args, "evidence"), "utf8"));
  const block = parseBlockRef(evidence.block);
  const proofs = (evidence.proofs as unknown[]).map(parseAccountProof);
  const header = String(evidence.header);

  const provider = new JsonRpcProvider({ url: flag(args, "rpc") ?? NEAR_RPC[network] });
  const config = await provider.callFunction<{ judge_build_hash: string }>({
    contractId: contract,
    method: "config",
    args: {},
  });
  if (!config?.judge_build_hash) throw new Error(`${contract} has no judge build pinned`);

  const sealed = await seal({
    api: flag(args, "outlayer-api") ?? KEYSTORE_API[network],
    judgeHash: config.judge_build_hash,
    bountyContract: contract,
    whitehat,
    exploit,
  });
  const result: ClaimResult = {
    bounty_contract: contract,
    judge_build_hash: config.judge_build_hash,
    sealed_exploit: sealed,
  };
  if (args.includes("--dry-run")) return result;

  const account = new Account(whitehat, provider, credentials(network, whitehat));
  const outcome = await account.signAndSendTransaction({
    receiverId: contract,
    actions: [
      actions.functionCall(
        "submit_claim",
        { bounty, block, header, proofs: JSON.stringify(proofs), sealed_exploit: sealed },
        CLAIM_GAS,
        0n,
      ),
    ],
    waitUntil: "EXECUTED_OPTIMISTIC",
  });
  const status = outcome.status as { SuccessValue?: string; Failure?: unknown };
  if (status.SuccessValue === undefined) {
    throw new Error(`the claim was refused: ${JSON.stringify(status.Failure ?? status)}`);
  }
  result.claim_id = Number(JSON.parse(Buffer.from(status.SuccessValue, "base64").toString("utf8")));
  result.tx_hash = outcome.transaction.hash;
  return result;
}
