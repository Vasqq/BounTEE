import type { ReactNode } from "react";
import "./globals.css";
import "./app.css";
import { Providers } from "./providers.tsx";

export const metadata = {
  title: "BounTEE · Bounties that pay themselves",
  description:
    "Bug bounties that pay a Whitehat, human or AI agent, once an enclave proves the exploit, and pause the vulnerable contract on every chain the bounty covers.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://api.fontshare.com" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        {/* The locked faces (DESIGN.md, Typography): Newsreader and IBM Plex Mono from Google Fonts, Switzer from Fontshare. */}
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link href="https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,200..800;1,6..72,200..800&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet" />
        <link href="https://api.fontshare.com/v2/css?f[]=switzer@400,500,600,700&display=swap" rel="stylesheet" />
        <script dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
