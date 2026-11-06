// The mainnet demo bounty as the landing page tells it, read live on each request (D4, R15.6).
import { readDemo } from "@/lib/demo.ts";

export async function GET() {
  try {
    return Response.json({ demo: await readDemo() }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
