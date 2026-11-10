// The posting flow (#31): post a bounty with MetaMask (D13). Cuttable (ADR-0011): `bountee post` is the fallback.
import { AppNav } from "@/components/AppNav.tsx";
import { PostFlow } from "@/components/post/PostFlow.tsx";
import { WalletProvider } from "@/components/WalletProvider.tsx";

export const metadata = { title: "Post a bounty · BounTEE" };

export default function PostPage() {
  return (
    <>
      <AppNav current="post" />
      <main className="app wrap post" id="main">
        <WalletProvider reconnect>
          <PostFlow />
        </WalletProvider>
      </main>
    </>
  );
}
