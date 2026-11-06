// Every public endpoint the command-line tool reads or writes by default, per NEAR network.
// Each can be overridden by a flag (`--near-rpc`, `--tx-api`, `--outlayer-api`, `--intents-api`).

/** NEAR RPC. FastNEAR: rpc.testnet.near.org now answers 429 "deprecated" (Nov 4). */
export const NEAR_RPC = { testnet: "https://test.rpc.fastnear.com", mainnet: "https://free.rpc.fastnear.com" } as const;
export type Network = keyof typeof NEAR_RPC;

/**
 * NEAR's archival RPC, for blocks and transactions an ordinary RPC no longer keeps (about
 * five epochs, some two and a half days): FastNEAR, checked Nov 5.
 */
export const ARCHIVAL_RPC = { testnet: "https://archival-rpc.testnet.fastnear.com", mainnet: "https://archival-rpc.mainnet.fastnear.com" } as const;

/**
 * FastNEAR's explorer API (`/v0/account`, `/v0/transactions`): an indexer, used only to
 * locate a contract's transactions; what they hold is read again from NEAR RPC.
 */
export const TX_API = { testnet: "https://tx.test.fastnear.com", mainnet: "https://tx.main.fastnear.com" } as const;

/** NEAR Intents' 1Click API (mainnet only: it has no testnet), for `withdraw` (ADR-0013). */
export const INTENTS_API = "https://1click.chaindefuser.com";

/** OutLayer's API: its keystore (sealing) and its attestations. */
export const KEYSTORE_API = { testnet: "https://testnet-api.outlayer.ai", mainnet: "https://api.outlayer.ai" } as const;

/** A NEAR transaction's page on the explorer, for receipts' links. */
export const NEAR_EXPLORER_TX = { testnet: "https://testnet.nearblocks.io/txns/", mainnet: "https://nearblocks.io/txns/" } as const;
