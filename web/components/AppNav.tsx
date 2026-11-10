// The app bar: wordmark, "Bounties", "Verify" and "Post a bounty" (DESIGN.md, Nav bar:
// Extension). On a testnet build the wordmark carries the "Testnet" badge, linking to the
// mainnet site when its address is set (D31). Rendered on the server, so the mainnet browser
// bundle carries no testnet wording.
import { net } from "@/lib/network.ts";
import { NavBar } from "./NavBar.tsx";
import { Wordmark } from "./Wordmark.tsx";

function TestnetBadge() {
  return net.mainnetSite ? (
    <a className="net-badge" href={net.mainnetSite}>
      Testnet
    </a>
  ) : (
    <span className="net-badge">Testnet</span>
  );
}

/** The landing page's Verify section: this site's own on mainnet; on testnet, the mainnet site's, or none when its address is unset (D31). */
const verifyHref = net.network === "testnet" ? net.mainnetSite && new URL("/#verify", net.mainnetSite).href : "/#verify";

export function AppNav({ current }: { current?: "bounties" | "post" }) {
  return (
    <NavBar>
      <span className="brand">
        <Wordmark href="/" label="BounTEE, home" />
        {net.network === "testnet" && <TestnetBadge />}
      </span>
      <ul className="app-links">
        <li>
          <a href="/bounties" aria-current={current === "bounties" ? "page" : undefined}>
            Bounties
          </a>
        </li>
        {verifyHref && (
          <li className="verify">
            <a href={verifyHref}>Verify</a>
          </li>
        )}
      </ul>
      <a className="btn btn-ink" href="/post" aria-current={current === "post" ? "page" : undefined}>
        Post a bounty
      </a>
    </NavBar>
  );
}
