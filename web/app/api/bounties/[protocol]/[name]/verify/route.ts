// A bounty's Verify checks, run on each request from public chain data (D6, R15.6).
import { readVerify } from "@/lib/verify.ts";

export async function GET(_req: Request, ctx: { params: Promise<{ protocol: string; name: string }> }) {
  const { protocol, name } = await ctx.params;
  try {
    return Response.json({ verify: await readVerify({ protocol, name }) }, { headers: { "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502, headers: { "cache-control": "no-store" } });
  }
}
