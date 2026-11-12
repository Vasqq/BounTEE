// What a build sends the browser, checked as ADR-0022 scopes the D30 and D4 checks for the other
// network's values: every page's HTML and every static file are checked in full, except a file
// that no public page loads, carries RainbowKit's or WalletConnect's code, and fails the full
// check. Such a file is checked instead for the other network table's values that are BounTEE's
// alone: its bounty contract, NEAR's USDC, the MPC root key and NEAR's Ethereum RPC.
//
// Why (ticket #91's trial build): RainbowKit's chunk names the other network's chains in its own
// chain metadata ("arbitrumSepolia", "bscTestnet"), which the app never reads, links or signs
// with. Turbopack puts some of the app's signing code in that chunk too; the narrower check
// still covers it. The wallet SDKs the app never runs are left out of the build (next.config.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Page } from "@playwright/test";
import { pauseRole } from "@bountee/formats";
import { DEMO, NETWORKS, type Network } from "./world.ts";

const bounty = `/bounties/${DEMO.protocol}/${DEMO.name}`;
/** The pages that need no wallet, and the two that sign. */
const PUBLIC_PAGES = ["/", "/bounties", bounty];
const SIGNING_PAGES = ["/post", `${bounty}/exploit`];
/** Code RainbowKit's and WalletConnect's builds carry, as the trial build found it. */
const WALLET_LIBRARY = /wallet_connectors\.|@walletconnect\//;

/** A network table's values that are BounTEE's alone, as a build would carry them. */
export const bounteeOnly = (network: Network) => [
  NETWORKS[network].contract,
  NETWORKS[network].usdc,
  network === "mainnet" ? pauseRole.MAINNET_ROOT_PUBLIC_KEY : pauseRole.TESTNET_ROOT_PUBLIC_KEY,
  `eth-rpc.${network}.near.org`,
];

/** Every file under `dir`, at any depth. */
export const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? filesUnder(join(dir, f)) : [join(dir, f)]));

/**
 * Visits every page of the build in `distDir`, served at `origin`, and checks what the browser
 * is sent against `passes` (the full check): `failing` names each page or static file that
 * fails it and isn't a wallet library's file; `walletLibraries` is the text of the wallet
 * library files that fail it, for the narrower check; `all` is everything.
 */
export async function sentToBrowser(page: Page, origin: string, distDir: string, passes: (text: string) => boolean) {
  const loadedByPublicPages = new Set<string>();
  const record = (r: { url(): string }) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith("/_next/static/")) loadedByPublicPages.add(path.slice("/_next/static/".length));
  };
  const sent: { path: string; text: string; walletLibrary: boolean }[] = [];
  const visit = async (path: string) => {
    await page.goto(origin + path, { waitUntil: "networkidle" });
    sent.push({ path, text: await page.content(), walletLibrary: false });
  };
  page.on("response", record);
  for (const path of PUBLIC_PAGES) await visit(path);
  page.off("response", record);
  for (const path of SIGNING_PAGES) await visit(path);
  const statics = join(distDir, "static");
  for (const file of filesUnder(statics)) {
    const path = relative(statics, file);
    const text = readFileSync(file, "utf8");
    sent.push({ path, text, walletLibrary: !loadedByPublicPages.has(path) && WALLET_LIBRARY.test(text) });
  }
  const failed = sent.filter((f) => !passes(f.text));
  return {
    failing: failed.filter((f) => !f.walletLibrary).map((f) => f.path),
    walletLibraries: failed.filter((f) => f.walletLibrary).map((f) => f.text).join("\n"),
    all: sent.map((f) => f.text).join("\n"),
  };
}
