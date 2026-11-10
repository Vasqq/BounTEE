// What MetaMask is asked to sign must not depend on the app's server alone (D13): the bounty
// contract and NEAR's USDC are fixed when the app is built, and a bounty's pause-role address
// is derived here, in the browser, the way the contract and the judge derive it (D25). A
// server answer that disagrees with these is refused before anything is signed.
import { pauseRole } from "@bountee/formats";

export const BOUNTY_CONTRACT = process.env.NEXT_PUBLIC_BOUNTY_CONTRACT || "bounty.bountee.near";
/** Circle's USDC on NEAR mainnet. */
export const NEAR_USDC = process.env.NEXT_PUBLIC_NEAR_USDC || "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

/** The pause-role address NEAR's MPC network signs this bounty's pauses from (mainnet root key). */
export const pauseRoleOf = (protocol: string, name: string) => pauseRole.address(pauseRole.MAINNET_ROOT_PUBLIC_KEY, BOUNTY_CONTRACT, { protocol, name });
