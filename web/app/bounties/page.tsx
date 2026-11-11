// The bounty list (DESIGN.md, Bounty list): read live from the bounty contract on every request
// (R15.6), then kept current in the background and cut into tabs and sorted on the client
// (components/BountyTable.tsx), so switching never waits on a read. No filters or pagination.
import { connection } from "next/server";
import { AppNav } from "@/components/AppNav.tsx";
import { BountyTable } from "@/components/BountyTable.tsx";
import { ReadFailed } from "@/components/ReadFailed.tsx";
import { TryTestnet } from "@/components/TryTestnet.tsx";
import { listBounties, type BountyList } from "@/lib/bounties.ts";

export const metadata = { title: "Bounties · BounTEE" };

export default async function Bounties() {
  await connection();
  let list: BountyList | null = null;
  const readAt = Date.now();
  try {
    list = await listBounties();
  } catch {
    list = null;
  }
  return (
    <>
      <AppNav current="bounties" />
      <main className="app wrap" id="main">
        <h1 className="page-title">Bounties</h1>
        {list === null ? (
          <div className="block">
            <ReadFailed what="Couldn't read NEAR" />
          </div>
        ) : (
          <BountyTable initial={list} readAt={readAt} />
        )}
        <TryTestnet className="cross-site" />
      </main>
    </>
  );
}
