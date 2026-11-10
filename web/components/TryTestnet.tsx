// The mainnet site's link to the testnet site (D31), shown only when its address is set
// (NEXT_PUBLIC_TESTNET_SITE). Rendered on the server, so the mainnet browser bundle carries
// no testnet wording. A testnet build's other site is mainnet's, which its badge links to.
import { net } from "@/lib/network.ts";

export function TryTestnet({ className }: { className?: string }) {
  return net.network === "mainnet" && net.otherSite ? (
    <a className={className} href={net.otherSite}>
      Try it on testnet
    </a>
  ) : null;
}
