// D37's check that a page names no wallet brand, for wallet-brands.spec.ts and its testnet twin
// (the public pages) and signing-copy.spec.ts (the signing pages, outside the open picker).
import type { Page } from "@playwright/test";

/** Spec #89's pinned brand list, matched case-sensitively. */
export const BRANDS = ["MetaMask", "Rabby", "Zerion", "Brave Wallet", "WalletConnect", "Reown", "Coinbase", "Phantom", "Rainbow", "Trust Wallet", "OKX", "Ledger Live"];

/**
 * Every wallet brand the page names, with the text that names it: in its text, shown or not
 * (a closed FAQ answer, a hint's tooltip), its title and head meta tags, and every element's
 * aria-*, title, alt and placeholder attributes. Scripts and styles are code, not copy. With
 * `outsidePicker`, the open picker (its dialog) is left out: listing wallets by name is its job (D34).
 */
export async function brandsNamed(page: Page, { outsidePicker = false } = {}): Promise<string[]> {
  return page.evaluate(
    ({ brands, outsidePicker }) => {
      const picker = (n: Node | null) => outsidePicker && !!(n instanceof Element ? n : n?.parentElement)?.closest("[role=dialog]");
      const texts = [document.title, ...[...document.head.querySelectorAll("meta[content]")].map((m) => m.getAttribute("content") ?? "")];
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (!n.parentElement?.closest("script, style, noscript, template") && !picker(n)) texts.push(n.textContent ?? "");
      }
      for (const el of document.querySelectorAll("*")) {
        if (picker(el)) continue;
        for (const a of el.attributes) if (/^(aria-|title$|alt$|placeholder$)/.test(a.name)) texts.push(a.value);
      }
      return texts.flatMap((t) => brands.filter((b) => t.includes(b)).map((b) => `${b}: ${t.trim().slice(0, 120)}`));
    },
    { brands: BRANDS, outsidePicker },
  );
}
