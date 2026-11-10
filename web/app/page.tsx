// The landing page: the finished mainnet demo bounty, told as a story (D4). No wallet.
// A testnet build has no story to tell: its / is the bounty list (D31, ADR-0021).
import { redirect } from "next/navigation";
import { Landing } from "@/components/landing/Landing.tsx";
import { TryTestnet } from "@/components/TryTestnet.tsx";
import { config } from "@/lib/config.ts";
import { net } from "@/lib/network.ts";

export default function Home() {
  if (net.network === "testnet") redirect("/bounties");
  return <Landing nearExplorer={config().nearExplorer} footerLinks={<TryTestnet />} />;
}
