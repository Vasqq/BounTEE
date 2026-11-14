"use client";
// Live-data provider for every page: TanStack Query for the chain reads (each page asks the
// app's server, which reads the chains, R15.6). The wallet is not here: only the pages that
// need a wallet mount it (components/WalletProvider.tsx), so public pages never touch it.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          // Live data: always re-read, retry a failed read twice, and keep the last good value on screen meanwhile.
          queries: { staleTime: 0, retry: 2, refetchOnWindowFocus: true },
        },
      }),
  );
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
