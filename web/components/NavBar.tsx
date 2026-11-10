"use client";
// The nav bar's frame (DESIGN.md, Nav bar): fixed, transparent at the top, solid with a blur
// once scrolled more than 8px. What it holds is rendered on the server (AppNav.tsx).
import { useEffect, useState, type ReactNode } from "react";

export function NavBar({ children }: { children: ReactNode }) {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const on = () => setSolid(window.scrollY > 8);
    on();
    window.addEventListener("scroll", on, { passive: true });
    return () => window.removeEventListener("scroll", on);
  }, []);
  return (
    <header className={`nav${solid ? " solid" : ""}`}>
      <div className="wrap">{children}</div>
    </header>
  );
}
