"use client";
// A phrase that explains itself on hover, focus or tap: in a field's hint, or a table header. The first tooltip
// waits a beat so passing the mouse over doesn't flash it; once one has shown, the next opens
// at once. It stays open while the pointer is on it and closes on Escape or a tap elsewhere
// (WCAG 1.4.13). Given an `href`, the phrase is a link instead (a sortable column's header):
// hover and focus still show the note, and a click follows the link.
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";

const WAIT = 250;
let lastClosed = 0;

export function Hint({ tip, href, onClick, children }: { tip: ReactNode; href?: string; onClick?: (e: MouseEvent<HTMLAnchorElement>) => void; children: ReactNode }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [instant, setInstant] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // Escape closes it wherever focus is, so a tooltip opened by hover can be dismissed too.
  useEffect(() => {
    if (!open) return;
    const esc = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  });

  const show = (now: boolean) => {
    clearTimeout(timer.current);
    const warm = now || Date.now() - lastClosed < 400;
    setInstant(warm);
    if (warm) setOpen(true);
    else timer.current = setTimeout(() => setOpen(true), WAIT);
  };
  const hide = () => {
    clearTimeout(timer.current);
    if (open) lastClosed = Date.now();
    setOpen(false);
  };

  return (
    <span className="hint" onPointerEnter={(e) => e.pointerType === "mouse" && show(false)} onPointerLeave={(e) => e.pointerType === "mouse" && hide()}>
      {href ? (
        <a className="hint-term" href={href} onClick={onClick} aria-describedby={id} onFocus={() => show(true)} onBlur={hide} onKeyDown={(e) => e.key === "Escape" && hide()}>
          {children}
        </a>
      ) : (
        <button
          type="button"
          className="hint-term"
          aria-describedby={id}
          onFocus={() => show(true)}
          onBlur={hide}
          onClick={() => show(true)}
          onKeyDown={(e) => e.key === "Escape" && hide()}
        >
          {children}
        </button>
      )}
      <span role="tooltip" id={id} className="hint-pop" data-open={open || undefined} data-instant={instant || undefined}>
        {tip}
      </span>
    </span>
  );
}
