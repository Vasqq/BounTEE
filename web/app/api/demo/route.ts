// The mainnet demo bounty as the landing page tells it, read live on each request (D4, R15.6).
import { readDemo } from "@/lib/demo.ts";
import { respond } from "@/lib/respond.ts";

export async function GET() {
  return respond("the demo bounty", async () => ({ demo: await readDemo() }));
}
