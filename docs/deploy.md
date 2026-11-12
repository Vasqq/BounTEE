# Deploying the web app

The web app (`web/`) is hosted on Vercel as two projects built from the same repo. The network is fixed when the site is built (ADR-0021), so each network needs its own build.

| Project | Site | Network |
|---|---|---|
| `bountee` | the landing page and the mainnet app | mainnet (`NEXT_PUBLIC_NETWORK` unset) |
| `bountee-testnet` | the testnet app; `/` redirects to `/bounties` | testnet |

Both projects belong to the Vercel team `bountee` (Hobby plan) and are connected to GitHub `Vasqq/bountee`.

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
| `NEXT_PUBLIC_SITE_URL` | the mainnet site's URL | the testnet site's URL | Base for absolute social-card image links (production only). |
| `NEXT_PUBLIC_TESTNET_SITE` | the testnet site's URL | unset | Mainnet's "Try it on testnet" links. |
| `NEXT_PUBLIC_MAINNET_SITE` | unset | the mainnet site's URL | Testnet badge and the nav's Verify link. |

When a custom domain replaces the `*.vercel.app` addresses, update the last three variables on both projects and redeploy both.

Optional overrides, if a public RPC rate-limits (`web/.env.testnet.example` lists them all):

- `EVM_RPC_<chain ID>` and `NEAR_RPC` are read by the server when a request comes in.
- `NEXT_PUBLIC_EVM_RPC_<chain ID>` is built into the browser bundle.

An RPC URL that carries an API key is a secret. Set it only as a server variable, never as `NEXT_PUBLIC_`.

## Custom domain

The apex domain goes on `bountee` and `testnet.<domain>` on `bountee-testnet`. Add each under the project's Settings → Domains, and add `www.<domain>` as a redirect to the apex.

If the domain was bought outside Vercel, create the A record (apex) and CNAME records (`testnet`, `www`) that the Domains page shows. Vercel issues the certificates automatically.
