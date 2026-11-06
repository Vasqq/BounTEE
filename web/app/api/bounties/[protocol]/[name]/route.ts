// One bounty as its public page shows it, read live from the chains on each request (R15.6).
import { readBounty } from "@/lib/bounties.ts";
import { respond } from "@/lib/respond.ts";

export async function GET(_req: Request, ctx: { params: Promise<{ protocol: string; name: string }> }) {
  const { protocol, name } = await ctx.params;
  return respond("the bounty", async () => ({ bounty: await readBounty({ protocol, name }) }));
}
