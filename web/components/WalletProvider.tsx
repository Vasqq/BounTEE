"use client";
// The Protocol wallet, for the pages that sign: posting (D13) and opening the winning exploit
// (R6.2). RainbowKit's picker (D34) sits inside wagmi, as RainbowKit's docs set it up; TanStack
// Query's provider is the root one (app/providers.tsx). Its stylesheet is imported here, so only
// these pages load it.
//
// wagmi never reconnects on mount: its reconnect asks every connector for its provider, which
// would start WalletConnect (D36). With `reconnect`, the page reconnects only the browser
// wallets (injected connectors), which ask nothing that prompts; without it, the page asks
// nothing of a wallet until the Protocol clicks (D13).
import "@rainbow-me/rainbowkit/styles.css";
import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { useEffect, type ReactNode } from "react";
import { useConfig, useReconnect, WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi.ts";

export function WalletProvider({ children, reconnect }: { children: ReactNode; reconnect: boolean }) {
  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
      <RainbowKitProvider>
        {reconnect && <ReconnectBrowserWallets />}
        {children}
      </RainbowKitProvider>
    </WagmiProvider>
  );
}

/**
 * Restores a browser wallet's account after a reload, with no click. On mount, WagmiProvider
 * rehydrates wagmi's stored state from localStorage and then, with reconnect on mount off,
 * clears its connections: a reconnect before that clear is wiped. Both happen in promise
 * callbacks started by WagmiProvider's own effect, which runs after this child's, so the
 * reconnect waits for the next task, when both have run.
 */
function ReconnectBrowserWallets() {
  const config = useConfig();
  const { reconnect } = useReconnect();
  useEffect(() => {
    const timer = setTimeout(() => reconnect({ connectors: config.connectors.filter((c) => c.type === "injected") }));
    return () => clearTimeout(timer);
  }, [config, reconnect]);
  return null;
}
