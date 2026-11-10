// The landing page: the finished mainnet demo bounty, told as a story (D4). No wallet.
import { Landing } from "@/components/landing/Landing.tsx";
import { config } from "@/lib/config.ts";

export default function Home() {
  return <Landing nearExplorer={config().nearExplorer} />;
}
