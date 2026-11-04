// `bountee init` (D18): a local NEAR account to claim from.
//
// Testnet: a named account `<name>.testnet` created and funded by NEAR's faucet service (the
// one near-cli-rs `sponsor-by-faucet-service` uses), with no sign-up. Mainnet: an implicit
// account (its address is its public key in hex), which exists once NEAR is sent to it, so
// init states how much to add and where.
//
// The key is saved where near-cli keeps keys (~/.near-credentials/<network>/<account>.json,
// mode 600, or BOUNTEE_CREDENTIALS_DIR) and is never printed.
import { randomBytes } from "node:crypto";
import { KeyPair } from "near-api-js";
import { Near, formatNear, saveKey, type Network } from "./near.ts";

const FAUCET_SERVICE = "https://helper.nearprotocol.com/account";

/** What a Whitehat needs on mainnet: one claim's balance (~0.9 NEAR with live proofs) plus gas and the account's own storage. */
export const MAINNET_START_NEAR = "1.5";

export interface InitOptions {
  network: Network;
  /** Testnet: the account name to ask the faucet for; a random `bountee-<hex>.testnet` otherwise. */
  account?: string;
}

export interface InitResult {
  network: Network;
  account_id: string;
  public_key: string;
  credentials: string;
  funded: boolean;
  /** Testnet: the balance the faucet gave, in NEAR. */
  balance_near?: string;
  /** Mainnet: how much NEAR to send, and where. */
  add_near?: string;
  send_to?: string;
  message: string;
}

export async function initCommand(o: InitOptions): Promise<InitResult> {
  const key = KeyPair.fromRandom("ed25519");
  const publicKey = key.getPublicKey().toString();

  if (o.network === "mainnet") {
    const accountId = Buffer.from(key.getPublicKey().data).toString("hex");
    const credentials = saveKey("mainnet", accountId, key);
    return {
      network: "mainnet",
      account_id: accountId,
      public_key: publicKey,
      credentials,
      funded: false,
      add_near: MAINNET_START_NEAR,
      send_to: accountId,
      message: `Send ${MAINNET_START_NEAR} NEAR to ${accountId} (your new account; it exists once it receives NEAR). That covers one claim and its gas.`,
    };
  }

  const accountId = o.account ?? `bountee-${randomBytes(6).toString("hex")}.testnet`;
  if (!/^[a-z0-9_-]+\.testnet$/.test(accountId)) throw new Error(`--account: ${accountId} is not <name>.testnet`);
  const near = new Near("testnet");
  if ((await near.balance(accountId)) !== null) throw new Error(`${accountId} already exists: pick another --account`);

  let res: Response | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(FAUCET_SERVICE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
    });
    if (res.status !== 429) break;
    await new Promise((r) => setTimeout(r, 3000 * (attempt + 1)));
  }
  if (!res!.ok) throw new Error(`NEAR's faucet service refused ${accountId}: HTTP ${res!.status} ${(await res!.text()).slice(0, 200)}`);
  // Saved as soon as the faucet accepts, so the account is never lost; a refused name leaves no file.
  const credentials = saveKey("testnet", accountId, key);
  let balance: bigint | null = null;
  for (let i = 0; i < 20 && balance === null; i++) {
    balance = await near.balance(accountId);
    if (balance === null) await new Promise((r) => setTimeout(r, 2000));
  }
  if (balance === null) throw new Error(`the faucet answered but ${accountId} never appeared on testnet`);
  return {
    network: "testnet",
    account_id: accountId,
    public_key: publicKey,
    credentials,
    funded: true,
    balance_near: formatNear(balance),
    message: `Created ${accountId} with ${formatNear(balance)} testnet NEAR from NEAR's faucet; key saved in ${credentials}.`,
  };
}
