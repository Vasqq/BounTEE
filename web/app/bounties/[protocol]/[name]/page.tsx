// A bounty's public page (DESIGN.md, Bounty page). The page reads the bounty live from the
// chains in the browser's session (components/BountyLive.tsx); nothing about it is baked in.
import { AppNav } from "@/components/AppNav.tsx";
import { BountyLive } from "@/components/BountyLive.tsx";

export async function generateMetadata({ params }: { params: Promise<{ protocol: string; name: string }> }) {
  const { protocol, name } = await params;
  return { title: `${decodeURIComponent(protocol)}/${decodeURIComponent(name)} · BounTEE` };
}

export default async function BountyPage({ params }: { params: Promise<{ protocol: string; name: string }> }) {
  const { protocol, name } = await params;
  return (
    <>
      <AppNav />
      <main className="app wrap" id="main">
        <BountyLive id={{ protocol: decodeURIComponent(protocol), name: decodeURIComponent(name) }} />
      </main>
    </>
  );
}
