// Every bounty, as the bounty list shows it, read live from the bounty contract on each request
// (R15.6). The list page re-reads it in the background to stay current while it is open.
import { listBounties } from "@/lib/bounties.ts";
import { respond } from "@/lib/respond.ts";

export async function GET() {
  return respond("the bounty list", async () => ({ list: await listBounties() }));
}
