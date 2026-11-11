// Every endpoint and account the web app's server reads: the network table's (lib/network.ts)
// and, for its network, the command-line tool's NEAR endpoints (cli/src/endpoints.ts), each
// overridable from the environment at request time (ADR-0017). The network is a
// deployment setting, never a control on the page. Only server code imports this: the
// browser gets what it needs (an EVM RPC to send a signed pause to) inside the data the
// server hands it.
import { ARCHIVAL_RPC, KEYSTORE_API, NEAR_EXPLORER, NEAR_EXPLORER_TX, NEAR_RPC, TX_API } from "@bountee/cli/src/endpoints.ts";
import { net, type EvmChain } from "./network.ts";

export type ChainInfo = Omit<EvmChain, "browserRpc">;

const env = (name: string, fallback: string) => process.env[name] || fallback;

/** The chains a bounty can cover, each RPC overridable by `EVM_RPC_<chain ID>`. */
export function chains(): Record<number, ChainInfo> {
  return Object.fromEntries(
    net.chains.map(({ browserRpc: _, ...c }): [number, ChainInfo] => [c.id, { ...c, rpc: env(`EVM_RPC_${c.id}`, c.rpc) }]),
  );
}

export function config() {
  const contract = env("BOUNTY_CONTRACT", net.bountyContract);
  return {
    /** NEAR RPC: the command-line tool's (cli/src/endpoints.ts). */
    nearRpc: env("NEAR_RPC", NEAR_RPC[net.network]),
    /** For transactions an ordinary RPC no longer keeps (about two and a half days). */
    nearArchivalRpc: env("NEAR_ARCHIVAL_RPC", ARCHIVAL_RPC[net.network]),
    /** FastNEAR's explorer API: says which transactions to look at; trusted for nothing. */
    txApi: env("TX_API", TX_API[net.network]),
    /** OutLayer's API, for the winning claim's attestation. */
    outlayerApi: env("OUTLAYER_API", KEYSTORE_API[net.network]),
    nearExplorer: NEAR_EXPLORER[net.network],
    nearExplorerTx: NEAR_EXPLORER_TX[net.network],
    contract: env("BOUNTY_CONTRACT", net.bountyContract),
    /** The mainnet demo bounty the landing page tells (ADR-0018), as `<protocol>/<name>`; unset until it is posted. */
    demoBounty: process.env.DEMO_BOUNTY || null,
    chains: chains(),
    /** NEAR's Ethereum-compatible RPC (NEP-518), through which MetaMask signs as a 0x… NEAR account. */
    nearEth: { chainId: net.nearEvm.id, rpc: env("NEAR_ETH_RPC", net.nearEvm.rpc) },
    /** The bounty contract's page on the NEAR explorer, where anyone can check what the site shows. */
    contractHref: `${NEAR_EXPLORER[net.network]}address/${contract}`,
  };
}

export type Config = ReturnType<typeof config>;
