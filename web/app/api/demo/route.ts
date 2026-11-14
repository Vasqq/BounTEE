// The mainnet demo bounty as the landing page tells it, read live on each request (D4, R15.6).
// A testnet build never reads or tells it (ADR-0021): there the route answers 404.
import { readDemo } from "@/lib/demo.ts";
import { net } from "@/lib/network.ts";
import { respond } from "@/lib/respond.ts";

export async function GET() {
  if (net.network !== "mainnet") return Response.json({ error: "no demo bounty on this network" }, { status: 404 });
  return respond("the demo bounty", async () => ({ demo: await readDemo() }));
}
