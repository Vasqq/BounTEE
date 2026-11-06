"use client";
// MetaMask, for the pages that sign: posting (D13) and opening the winning exploit (R6.2).
// With `reconnect` off, the page asks nothing of the wallet until the Protocol clicks.
import type { ReactNode } from "react";
import { WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi.ts";

export function WalletProvider({ children, reconnect }: { children: ReactNode; reconnect: boolean }) {
  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount={reconnect}>
      {children}
    </WagmiProvider>
  );
}
