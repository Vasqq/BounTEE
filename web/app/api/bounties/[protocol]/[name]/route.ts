// One bounty as its public page shows it, read live from the chains on each request (R15.6).
import { readBounty } from "@/lib/bounties.ts";

export async function GET(_req: Request, ctx: { params: Promise<{ protocol: string; name: string }> }) {
  const { protocol, name } = await ctx.params;
  try {
    return Response.json({ bounty: await readBounty({ protocol, name }) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
