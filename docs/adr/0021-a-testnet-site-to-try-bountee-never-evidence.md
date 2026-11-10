# A testnet site to try BounTEE, never cited as evidence

The web app is mainnet-only (ADR-0017), so its bounty list holds the one demo bounty and nobody can try posting without real USDC. Visitors and judges want to click through a bounty in every state and post one themselves at no cost. So the same web app also runs as a second site, built for NEAR testnet, Base Sepolia and Arbitrum Sepolia, on its own `testnet.` subdomain (Liam, Nov 10). The network stays a deployment setting: one environment variable picks it when the site is built, and no page offers a switch.

Amended Nov 10 (Liam): the site's contract is `bounty2.bountee.testnet`, deployed the same way. Its bounties vary their covered chains and minimum thefts, which posted bounties can't change, and `bounty.bountee.testnet` holds no keys, so it stays deployed, unlinked.

## Decisions

- **Two sites, one codebase.** `NEXT_PUBLIC_NETWORK` is `mainnet` (the default) or `testnet`. It picks one table of every network value the app reads or signs with: NEAR RPCs and explorers, the bounty contract, NEAR's USDC, the MPC root key the pause-role address is derived from, the EVM chains and their explorers and USDC, NEAR's Ethereum-compatible chain (397 or 398), and the network the Verify command names. Every per-endpoint override that exists today still wins over the table.
- **One badge is the only difference a visitor sees.** The testnet site looks and behaves exactly like the mainnet site, with one "Testnet" badge beside the wordmark in the nav, on every page; the badge links to the mainnet site (Liam, Nov 10). Its `/` goes to the bounty list, since the landing page tells only the mainnet demo bounty with mainnet transactions (D4) and is never built from testnet data; its nav's Verify link goes to that landing page's Verify section on the mainnet site. The mainnet site links to the testnet site from its bounty list and its landing page's footer, because its own list is nearly empty.
- **The switch is one table, not two apps.** Every page and component reads network values only from that table, so there is no testnet branch in page code beyond the badge, the cross-links, the `/` redirect, the nav's Verify link and the faucet links, and a change made for one network ships to both.
- **Its own bounty contract, on Circle's testnet USDC.** `bounty.bountee.testnet` is deployed from the same commit as the mainnet contract, so the site's list holds only its own bounties, not the rehearsals' leftovers. It takes Circle's USDC on NEAR testnet, which anyone can get from Circle's faucet, so a visitor can post just as on mainnet. Seeded bounties are small (a few USDC) as a result.
- **Seeded so it looks in use.** A script, built on the D21 fresh-instance script, posts bounties from fictional Protocols in every public state that lasts: Live, Live with claims judged, Paid, Ended unclaimed, Withdrawn and Check failed.
- **Visitors bring their own contract.** Posting on testnet works as on mainnet: the visitor covers a pausable contract they control on Base Sepolia or Arbitrum Sepolia. There is no one-click test vault.

## Considered Options

- **A network switcher on the page:** reverses ADR-0017's "deployment setting", and puts a mainnet signer one click from a testnet one.
- **Reuse a rehearsal contract on our mock sUSDC:** bigger numbers on the seeded bounties, but nobody outside the team can get sUSDC, so nobody could post.
- **A one-click test vault for visitors:** friendlier, but a new contract and flow the day before the freeze.

## Consequences

- ADR-0017 holds: nothing on the testnet site is cited in the README, the landing page or the video, and the README presents the site as a place to try BounTEE.
- The seed's testnet USDC comes from Circle's faucet, which a person must request; the script stops and names what to top up when a balance is short, as D21's does.
- Hosting (Vercel) and the domain come later. Until the other site's address is set, the cross-link is hidden.
