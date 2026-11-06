// A bounty's Verify checks, run on each request from public chain data (D6, R15.6).
import { respond } from "@/lib/respond.ts";
import { readVerify } from "@/lib/verify.ts";

export async function GET(_req: Request, ctx: { params: Promise<{ protocol: string; name: string }> }) {
  const { protocol, name } = await ctx.params;
  return respond("the checks", async () => ({ verify: await readVerify({ protocol, name }) }));
}
