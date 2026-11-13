# Deploying the web app

The web app (`web/`) is hosted on Vercel as two projects built from the same repo. The network is fixed when the site is built (ADR-0021), so each network needs its own build.

| Project | Address | Site | Network |
|---|---|---|---|
| `bountee` | https://bountee.dev | the landing page and the mainnet app (`/bounties`, `/post`) | mainnet (`NEXT_PUBLIC_NETWORK` unset) |
| `bountee-testnet` | https://testnet.bountee.dev | the testnet app; `/` redirects to `/bounties` | testnet |

The landing page's "Open the app" and "Post a bounty" open the testnet site, which has bounties to try (D31). The mainnet app stays reachable at https://bountee.dev/bounties, and the testnet badge links back to the mainnet site.

Both projects belong to the Vercel team `bountee` (Hobby plan) and are connected to GitHub `Vasqq/bountee`. Each also keeps its `*.vercel.app` address (`bountee-six.vercel.app`, `bountee-testnet.vercel.app`).

## Redeploying

- **Automatic:** a push to the production branch rebuilds both projects. A push to any other branch builds a preview of each, which only signed-in team members can open.
- **One project, by hand:** in the Vercel dashboard, open the project's Deployments, then choose Redeploy on the latest production deployment.
- **A branch to production, from the command line:**

  ```bash
  vercel api /v13/deployments --scope bountee -X POST --input deploy.json
  ```

  where `deploy.json` is `{"name":"bountee","project":"bountee","target":"production","gitSource":{"type":"github","repoId":1443595188,"ref":"integration/bountee"}}`. Do the same with `bountee-testnet` for the testnet site.

A changed `NEXT_PUBLIC_*` variable takes effect only after a redeploy, since Next fixes those values into the build.

## Project settings (both projects)

| Setting | Value | Why |
|---|---|---|
| Root Directory | `web` | The app lives there. |
| Include files outside the root directory | on | `web` imports `cli/` and `formats/ts` from the pnpm workspace. |
| Framework | Next.js | Detected from `web/package.json`. |
| Node.js version | 22.x | Matches CI. Vercel's default, 26.x, ships without Corepack. |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | Makes Vercel install with the root `packageManager` (pnpm 12.8.1). Without it, Vercel picks pnpm 9 or 10 from the lockfile. |
| Deployment Protection | Vercel Authentication on previews | Production is public; previews need a Vercel sign-in. |
| Production branch | Settings → Environments → Production → Branch Tracking | The branch whose pushes go live. |

## Environment variables

None of them are secrets. All are plain values that end up in the browser bundle.

| Variable | `bountee` | `bountee-testnet` | What it does |
|---|---|---|---|
| `NEXT_PUBLIC_NETWORK` | unset | `testnet` (all environments) | Picks the network row in `web/lib/network.ts`. |
| `NEXT_PUBLIC_SITE_URL` | `https://bountee.dev` (production) | `https://testnet.bountee.dev` (production) | Base for absolute social-card image links. |
| `NEXT_PUBLIC_TESTNET_SITE` | `https://testnet.bountee.dev` | unset | Mainnet's "Try it on testnet" links and the landing page's app buttons. |
| `NEXT_PUBLIC_MAINNET_SITE` | unset | `https://bountee.dev` | Testnet badge and the nav's Verify link. |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | the WalletConnect project ID | the same | The wallet connector's public project ID; the build fails without it (D36). |

If the domain changes, update the three site addresses on both projects and redeploy both.

Optional overrides, if a public RPC rate-limits (`web/.env.testnet.example` lists them all):

- `EVM_RPC_<chain ID>` and `NEAR_RPC` are read by the server when a request comes in.
- `NEXT_PUBLIC_EVM_RPC_<chain ID>` is built into the browser bundle.

An RPC URL that carries an API key is a secret. Set it only as a server variable, never as `NEXT_PUBLIC_`.

## Domain

`bountee.dev` was bought through Vercel (renews Nov 13 2027), so Vercel runs its DNS and certificates. `bountee.dev` is on `bountee`, `www.bountee.dev` redirects to it (308), and `testnet.bountee.dev` is on `bountee-testnet`; each is under the project's Settings → Domains.
