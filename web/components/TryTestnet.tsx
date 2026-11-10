// The mainnet site's link to the testnet site (D31), shown only when its address is set
// (NEXT_PUBLIC_TESTNET_SITE). Rendered on the server, so the mainnet browser bundle carries
// no testnet wording. A testnet build has no `trySite`, so shows none.
import { net } from "@/lib/network.ts";

export function TryTestnet({ className }: { className?: string }) {
  return net.trySite ? (
    <a className={className} href={net.trySite}>
      Try it on testnet
    </a>
  ) : null;
}
