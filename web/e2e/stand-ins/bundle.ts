// What a build sends the browser, checked in full as ADR-0022 scopes the D30 and D4 checks for
// the other network's values: every page's HTML and every static file, with one thing left out
// of the text first. In a file no public page loads (the signing pages' wallet code), RainbowKit's
// chain metadata table (`chainMetadataByName` in RainbowKit 2.2.11) is removed before the check:
// the object literal whose every entry is `<name>:{chainId:<number>`, an optional `name:"<text>"`,
// and an icon (a spread of an icon object, or Turbopack's async icon import), and nothing else.
// Nothing more is removed, so the app's own signing code, which Turbopack bundles into the same
// chunk, is checked in full.
//
// Why (ticket #91's trial build): that table names every chain RainbowKit has an icon for, test
// chains included ("arbitrumSepolia", "bscTestnet"); the app never reads, links or signs with
// them. A table of another shape, as a RainbowKit upgrade might make, isn't removed, so it fails
// the check rather than pass unread. The wallet SDKs the app never runs are left out of the
// build (next.config.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { Page } from "@playwright/test";
import { DEMO } from "./world.ts";

const bounty = `/bounties/${DEMO.protocol}/${DEMO.name}`;
/** The pages that need no wallet, and the two that sign. */
const PUBLIC_PAGES = ["/", "/bounties", bounty];
const SIGNING_PAGES = ["/post", `${bounty}/exploit`];

const ident = "[A-Za-z_$][\\w$]*";
/** One entry of RainbowKit's chain metadata table, as Turbopack minifies it: a chain ID, maybe a name, an icon. */
const chainEntry =
  `${ident}:\\{chainId:(?:0x[\\da-f]+|\\d+(?:e\\d+)?)(?:,name:"[^"\\\\]*")?` +
  `(?:,\\.\\.\\.${ident}|,iconBackground:"[^"\\\\]*",iconUrl:async\\(\\)=>\\(await ${ident}\\.A\\(\\d+\\)\\)\\.default)\\}`;
/** RainbowKit's chain metadata table: an object literal made of those entries alone. */
const CHAIN_METADATA = new RegExp(`\\{${chainEntry}(?:,${chainEntry})*\\}`, "g");

/** `text` with RainbowKit's chain metadata table emptied, every other character kept. */
const withoutRainbowKitChainMetadata = (text: string) => text.replace(CHAIN_METADATA, "{}");

/** Every file under `dir`, at any depth. */
export const filesUnder = (dir: string): string[] => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? filesUnder(join(dir, f)) : [join(dir, f)]));

/**
 * Visits every page of the build in `distDir`, served at `origin`, and checks what the browser
 * is sent against `passes` (the full check): `failing` names each page or static file that
 * fails it, a file no public page loads being checked without RainbowKit's chain metadata
 * table; `all` is everything, as sent.
 */
export async function sentToBrowser(page: Page, origin: string, distDir: string, passes: (text: string) => boolean) {
  const loadedByPublicPages = new Set<string>();
  const record = (r: { url(): string }) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith("/_next/static/")) loadedByPublicPages.add(path.slice("/_next/static/".length));
  };
  const sent: { path: string; text: string; checked: string }[] = [];
  const visit = async (path: string) => {
    await page.goto(origin + path, { waitUntil: "networkidle" });
    const text = await page.content();
    sent.push({ path, text, checked: text });
  };
  page.on("response", record);
  for (const path of PUBLIC_PAGES) await visit(path);
  page.off("response", record);
  for (const path of SIGNING_PAGES) await visit(path);
  const statics = join(distDir, "static");
  for (const file of filesUnder(statics)) {
    const path = relative(statics, file);
    const text = readFileSync(file, "utf8");
    sent.push({ path, text, checked: loadedByPublicPages.has(path) ? text : withoutRainbowKitChainMetadata(text) });
  }
  return {
    failing: sent.filter((f) => !passes(f.checked)).map((f) => f.path),
    all: sent.map((f) => f.text).join("\n"),
  };
}
