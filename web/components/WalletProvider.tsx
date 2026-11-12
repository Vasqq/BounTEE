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
//
// The picker is RainbowKit's compact modal in its dark theme, set to DESIGN.md's tokens, with
// one line beneath its list saying why only some wallets are shown (D34). The theme is passed
// as CSS on RainbowKit's own elements rather than as the provider's `theme`, which would wrap
// the page in a themed element and could move the signing pages' layout (RainbowKit's theming
// docs, custom theme selectors).
import "@rainbow-me/rainbowkit/styles.css";
import { cssStringFromTheme, darkTheme, RainbowKitProvider, type DisclaimerComponent } from "@rainbow-me/rainbowkit";
import { useEffect, type ReactNode } from "react";
import { useConfig, useReconnect, WagmiProvider } from "wagmi";
import { wagmiConfig } from "@/lib/wagmi.ts";

export function WalletProvider({ children, reconnect }: { children: ReactNode; reconnect: boolean }) {
  return (
    <WagmiProvider config={wagmiConfig} reconnectOnMount={false}>
      <RainbowKitProvider theme={null} modalSize="compact" appInfo={{ appName: "BounTEE", disclaimer: Disclaimer }}>
        <style>{`[data-rk]{${cssStringFromTheme(PICKER_THEME)}}`}</style>
        {reconnect && <ReconnectBrowserWallets />}
        {children}
      </RainbowKitProvider>
    </WagmiProvider>
  );
}

/** RainbowKit's dark theme on DESIGN.md's tokens: `surface` ground, `ink` text and accent, `line` borders, the body font, `rounded.sm`. */
const base = darkTheme({ accentColor: "var(--ink)", accentColorForeground: "var(--ground)", borderRadius: "small" });
const PICKER_THEME: typeof base = {
  ...base,
  colors: {
    ...base.colors,
    actionButtonBorder: "var(--line)",
    actionButtonBorderMobile: "var(--line)",
    actionButtonSecondaryBackground: "var(--ground-2)",
    closeButton: "var(--ink-2)",
    closeButtonBackground: "var(--ground-2)",
    generalBorder: "var(--line)",
    generalBorderDim: "var(--line)",
    menuItemBackground: "var(--ground-2)",
    modalBackground: "var(--surface)",
    modalBorder: "var(--line)",
    modalText: "var(--ink)",
    modalTextDim: "var(--ink-3)",
    modalTextSecondary: "var(--ink-2)",
    selectedOptionBorder: "var(--line-2)",
  },
  fonts: { body: "var(--text)" },
  radii: { actionButton: "var(--r-sm)", connectButton: "var(--r-sm)", menuButton: "var(--r-sm)", modal: "var(--r-sm)", modalMobile: "var(--r-sm)" },
};

/** Beneath the picker's list: why a wallet the Protocol has may not be there (D34, ADR-0022). */
const Disclaimer: DisclaimerComponent = ({ Text }) => <Text>Only wallets that can sign on NEAR are shown.</Text>;

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
