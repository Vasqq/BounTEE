// NEAR transactions signed by the Protocol's Ethereum wallet as the Protocol's 0x… NEAR account (D13, NEP-518).
// Each NEAR action is one transaction on NEAR's Ethereum-compatible chain, calling the
// account's wallet contract; NEAR's relayer turns it into the NEAR transaction. The encoding
// is NEAR's own (@near-wallet-selector/ethereum-wallets 10.1.4): `functionCall(receiver,
// method, args, gas, yoctoNEAR)` sent to an address hashed from the receiver, with the NEAR
// deposit split into 18-decimal value and the 6 decimals below it. That module draws its own
// modal; the posting flow shows these steps in its own UI instead.
import { bytesToHex, keccak256, parseAbi, toHex, type Address } from "viem";
import { switchChain, waitForTransactionReceipt, writeContract } from "wagmi/actions";
import { base58 } from "@scure/base";
import { nearEvm, wagmiConfig } from "./wagmi.ts";

const ETHEREUM_ACCOUNT_ABI = parseAbi([
  "function functionCall(string receiver_id, string method_name, bytes args, uint64 gas, uint32 yoctoNear) payable",
  "function addKey(uint8 public_key_kind, bytes public_key, uint64 nonce, bool is_full_access, bool is_limited_allowance, uint128 allowance, string receiver_id, string[] method_names) external",
]);
/** The relayer adds this much overhead; NEAR's module caps a call's gas here. */
export const MAX_GAS = 270n * 10n ** 12n;
const RLP_EXECUTE = "rlp_execute";

/** The address a NEAR receiver is reached at: a 0x account itself, or the hash of its name. */
export function receiverAddress(receiverId: string, keyAction = false): Address {
  return (/^0x[0-9a-fA-F]{40}$/.test(receiverId) && !keyAction ? receiverId : `0x${keccak256(toHex(receiverId)).slice(26)}`) as Address;
}

/** Wait for NEAR's Ethereum RPC to execute the transaction; its receipt names the NEAR transaction. */
async function settle(hash: `0x${string}`): Promise<string> {
  const receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: nearEvm.id });
  const nearHash = (receipt as unknown as { nearTransactionHash?: string }).nearTransactionHash ?? hash;
  if (receipt.status !== "success") throw new Error(`NEAR refused the transaction (${nearHash})`);
  return nearHash;
}

async function onNear() {
  await switchChain(wagmiConfig, { chainId: nearEvm.id });
}

/**
 * Let NEAR's relayer submit this account's transactions: add its key, limited to the account's
 * own `rlp_execute`, with no allowance. It costs nothing (the relayer pays) and is done once.
 */
export async function enableNearSigning(account: Address, relayerKey: string): Promise<string> {
  await onNear();
  const accountId = account.toLowerCase();
  const hash = await writeContract(wagmiConfig, {
    chainId: nearEvm.id,
    abi: ETHEREUM_ACCOUNT_ABI,
    address: receiverAddress(accountId, true),
    functionName: "addKey",
    args: [0, bytesToHex(base58.decode(relayerKey.split(":")[1]!)), 0n, false, false, 0n, accountId, [RLP_EXECUTE]],
    gasPrice: 1n,
    type: "legacy",
  });
  return settle(hash);
}

/** One NEAR function call, signed in the Protocol's wallet. `deposit` in yoctoNEAR. */
export async function nearFunctionCall(o: { receiverId: string; method: string; args: unknown; gas: bigint; deposit: bigint }): Promise<string> {
  await onNear();
  const gas = o.gas <= MAX_GAS ? o.gas : MAX_GAS;
  const hash = await writeContract(wagmiConfig, {
    chainId: nearEvm.id,
    abi: ETHEREUM_ACCOUNT_ABI,
    address: receiverAddress(o.receiverId),
    functionName: "functionCall",
    args: [o.receiverId, o.method, toHex(new TextEncoder().encode(JSON.stringify(o.args))), gas, Number(o.deposit % 10n ** 6n)],
    value: o.deposit / 10n ** 6n,
    type: "legacy",
  });
  return settle(hash);
}
