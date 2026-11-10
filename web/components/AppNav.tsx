"use client";
// The app bar: wordmark, "Bounties", "Verify" and "Post a bounty" (DESIGN.md, Nav bar:
// Extension). Transparent at the top, solid with a blur once scrolled more than 8px.
import { useEffect, useState } from "react";
import { Wordmark } from "./Wordmark.tsx";

export function AppNav({ current }: { current?: "bounties" | "post" }) {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const on = () => setSolid(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className={`nav${solid ? " solid" : ""}`}>
      <div className="wrap">
        <Wordmark href="/" label="BounTEE, home" />
        <ul className="app-links">
          <li>
            <a href="/bounties" aria-current={current === "bounties" ? "page" : undefined}>
              Bounties
            </a>
          </li>
          <li className="verify">
            <a href="/#verify">Verify</a>
          </li>
        </ul>
        <a className="btn btn-ink" href="/post" aria-current={current === "post" ? "page" : undefined}>
          Post a bounty
        </a>
      </div>
    </header>
  );
}
