import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import "./app.css";
import { Providers } from "./providers.tsx";

const description =
  "Bug bounties that pay a Whitehat, human or AI agent, once an enclave proves the exploit, and pause the vulnerable contract on every chain the bounty covers.";

// The brand set's icons and link preview live in public/ (copied from brand/). Next makes the preview
// image absolute from the deployment's URL; set NEXT_PUBLIC_SITE_URL where that isn't Vercel.
export const metadata: Metadata = {
  ...(process.env.NEXT_PUBLIC_SITE_URL ? { metadataBase: new URL(process.env.NEXT_PUBLIC_SITE_URL) } : {}),
  title: "BounTEE · Bounties that pay themselves",
  description,
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "48x48" },
      { url: "/favicon.svg", type: "image/svg+xml" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    siteName: "BounTEE",
    title: "BounTEE · Bounties that pay themselves",
    description,
    images: [{ url: "/og-image.png", width: 1200, height: 630, alt: "BounTEE: Prove it. Get paid. Pause it everywhere." }],
  },
  twitter: { card: "summary_large_image", images: ["/og-image.png"] },
};

export const viewport: Viewport = { themeColor: "#121213" };

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
