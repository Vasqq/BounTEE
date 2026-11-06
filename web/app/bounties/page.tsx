// The bounty list (DESIGN.md, Bounty list): a plain table, read live from the bounty
// contract on every request (R15.6). No sorting, filters or pagination.
import { connection } from "next/server";
import { AppNav } from "@/components/AppNav.tsx";
import { ChainMark } from "@/components/ChainMark.tsx";
import { StatusChip } from "@/components/Chips.tsx";
import { ReadFailed } from "@/components/ReadFailed.tsx";
import { listBounties, type BountyRow } from "@/lib/bounties.ts";
import { plural } from "@/lib/format.ts";

export const metadata = { title: "Bounties · BounTEE" };

const href = (r: BountyRow) => `/bounties/${encodeURIComponent(r.id.protocol)}/${encodeURIComponent(r.id.name)}`;

export default async function Bounties() {
  await connection();
  let rows: BountyRow[] | null = null;
  try {
    rows = await listBounties();
  } catch {
    rows = null;
  }
  return (
    <>
      <AppNav current="bounties" />
      <main className="app wrap" id="main">
        <h1 className="page-title">Bounties</h1>
        {rows === null ? (
          <div className="block">
            <ReadFailed what="Couldn't read NEAR" />
          </div>
        ) : (
          <>
            <p className="count">{plural(rows.length, "bounty", "bounties")}</p>
            {rows.length === 0 ? (
              <p className="empty">No bounties are live.</p>
            ) : (
              <table className="list">
                <thead>
                  <tr>
                    <th>Bounty</th>
                    <th>Covered chains</th>
                    <th className="r">Bounty amount</th>
                    <th className="r">Minimum theft</th>
                    <th className="r">Ends</th>
                    <th>State</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.id.protocol}/${r.id.name}`}>
                      <td>
                        <a className="id" href={href(r)}>
                          {r.id.protocol}/{r.id.name}
                        </a>
                        <span className="state-inline">
                          <StatusChip state={r.state} />
                        </span>
                        <span className="sub">
                          {r.amount} · ends {r.ends}
                          <span className="marks">
                            {r.chains.map((c) => (
                              <ChainMark key={c.id} chainId={c.id} name={c.name} />
                            ))}
                          </span>
                        </span>
                      </td>
                      <td>
                        <span className="marks">
                          {r.chains.map((c) => (
                            <ChainMark key={c.id} chainId={c.id} name={c.name} />
                          ))}
                        </span>
                      </td>
                      <td className="r">{r.amount}</td>
                      <td className="r">{r.minimumTheft}</td>
                      <td className="r">{r.ends}</td>
                      <td>
                        <StatusChip state={r.state} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </main>
    </>
  );
}
