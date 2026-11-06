"use client";
// A command block (DESIGN.md, `terminal-mini`): one line of data plus Copy, on the terminal
// colour. With `prompt`, the line is a command and starts with a `$` that isn't copied.
import { useState } from "react";

export function CommandBlock({ text, prompt = false }: { text: string; prompt?: boolean }) {
  const [label, setLabel] = useState("Copy");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setLabel("Copied");
    } catch {
      setLabel("Copy failed");
    }
    setTimeout(() => setLabel("Copy"), 1600);
  };
  return (
    <div className="term-mini">
      <code>
        {prompt && (
          <span className="p" aria-hidden="true">
            $
          </span>
        )}
        {text}
      </code>
      <button className="copy" type="button" onClick={copy}>
        {label}
      </button>
    </div>
  );
}
