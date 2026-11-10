// The posting flow's live reads (D5, D17), on each request: GET, what every posting shares, for
// the rules before a wallet connects; POST, the status of one prospective bounty. Postings come
// from MetaMask, so the Protocol is a 0x… account; a bounty covers at most 8 contracts.
import { readBasics, readPosting } from "@/lib/posting.ts";
import { respond } from "@/lib/respond.ts";

/** What the rules step needs before any wallet connects. */
export async function GET() {
  return respond("the posting basics", async () => ({ basics: await readBasics() }));
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { protocol?: unknown; name?: unknown; covered?: unknown } | null;
  const protocol = typeof body?.protocol === "string" ? body.protocol.toLowerCase() : "";
  const covered = Array.isArray(body?.covered) ? (body!.covered as { chainId: number; address: string }[]) : [];
  const valid =
    /^0x[0-9a-f]{40}$/.test(protocol) &&
    typeof body?.name === "string" &&
    covered.length <= 8 &&
    covered.every((c) => Number.isInteger(c?.chainId) && /^0x[0-9a-fA-F]{40}$/.test(String(c?.address)));
  if (!valid) return Response.json({ error: "not a posting" }, { status: 400 });
  return respond("the posting status", async () => ({ status: await readPosting(protocol, body!.name as string, covered) }));
}
