"use client";
// A chain picker with each chain's mark, in place of the system <select>. It follows the
// WAI-ARIA select-only combobox: focus stays on the button, arrows move through the list,
// Enter, Space or Tab picks, Escape closes, and typing a letter jumps to the chain it starts.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

const MARKS: Record<number, string> = {
  8453: "/brand/Base_mark.svg",
  42161: "/brand/Arbitrum_mark.svg",
};

function Mark({ id }: { id: number }) {
  const src = MARKS[id];
  return src ? <img className="chain-mark" src={src} alt="" width={20} height={20} /> : <span className="chain-mark" aria-hidden="true" />;
}

export function ChainSelect({ label, value, options, onChange, help }: { label: string; value: number; options: { id: number; name: string }[]; onChange: (id: number) => void; help?: string }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const at = Math.max(
    0,
    options.findIndex((o) => o.id === value),
  );
  const current = options[at];

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => root.current?.contains(e.target as Node) || setOpen(false);
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);

  const show = (i: number) => (setActive(i), setOpen(true));
  const pick = (i: number) => (options[i] && onChange(options[i].id), setOpen(false));
  const onKey = (e: KeyboardEvent) => {
    const last = options.length - 1;
    const keys: Record<string, () => void> = open
      ? {
          ArrowDown: () => setActive(Math.min(active + 1, last)),
          ArrowUp: () => setActive(Math.max(active - 1, 0)),
          Home: () => setActive(0),
          End: () => setActive(last),
          Enter: () => pick(active),
          " ": () => pick(active),
          Escape: () => setOpen(false),
        }
      : {
          ArrowDown: () => show(at),
          ArrowUp: () => show(at),
          Enter: () => show(at),
          " ": () => show(at),
          Home: () => show(0),
          End: () => show(last),
        };
    if (e.key === "Tab" && open) return pick(active);
    const k = keys[e.key];
    if (k) return (e.preventDefault(), k());
    if (e.key.length === 1 && /\S/.test(e.key)) {
      const i = options.findIndex((o) => o.name.toLowerCase().startsWith(e.key.toLowerCase()));
      if (i >= 0) open ? setActive(i) : onChange(options[i]!.id);
    }
  };

  return (
    <div className="field chain-select" ref={root}>
      <span id={`${id}-label`}>{label}</span>
      <div className="chain-box">
        <button
          type="button"
          role="combobox"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          aria-labelledby={`${id}-label`}
          aria-activedescendant={open ? `${id}-${active}` : undefined}
          onClick={() => (open ? setOpen(false) : show(at))}
          onKeyDown={onKey}
        >
          {current && <Mark id={current.id} />}
          <span className="chain-name">{current?.name ?? "Choose a chain"}</span>
          <svg className="chev" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
            <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        {open && (
          <ul role="listbox" id={`${id}-list`} aria-labelledby={`${id}-label`} tabIndex={-1}>
            {options.map((o, i) => (
              <li key={o.id} id={`${id}-${i}`} role="option" aria-selected={i === at} data-active={i === active || undefined} onPointerEnter={() => setActive(i)} onClick={() => pick(i)}>
                <Mark id={o.id} />
                <span className="chain-name">{o.name}</span>
                {i === at && (
                  <svg className="tick" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                    <path d="m2.5 6.5 2.5 2.5 4.5-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {help && <small>{help}</small>}
    </div>
  );
}
