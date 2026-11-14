// What the wallet is asked to sign must not depend on the app's server alone (D13): the bounty
// contract, NEAR's USDC and each covered chain's USDC are fixed when the app is built, from
// the network table (D30), and a bounty's pause-role address is derived here, in the browser,
// the way the contract and the judge derive it (D25). A server answer that disagrees with
// these is refused before anything is signed.
import { pauseRole } from "@bountee/formats";
import { net } from "./network.ts";

// Literal reads, so Next inlines each override into the browser bundle.
export const BOUNTY_CONTRACT = process.env.NEXT_PUBLIC_BOUNTY_CONTRACT || net.bountyContract;
export const NEAR_USDC = process.env.NEXT_PUBLIC_NEAR_USDC || net.nearUsdc;

/** The pause-role address NEAR's MPC network signs this bounty's pauses from (the network's root key). */
export const pauseRoleOf = (protocol: string, name: string) => pauseRole.address(net.mpcRootPublicKey, BOUNTY_CONTRACT, { protocol, name });
