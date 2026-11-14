"use client";
// A ring (or, with no inner radius, a dot) of Bayer dither that breathes out and back: the landing hero's green
// scan in miniature (components/landing/runtime.js draws the hero with the same 4x4 ordered dither). Verify's
// timeline puts a ring on the furthest proven check; the Live status chip holds a faint dot before its word.
// One still frame under reduced motion, and paused while off screen.
import { useEffect, useRef } from "react";

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);

/** proven: green, on what a chain has proven. grey: before any proof. faint: a pale green, for the Live chip. */
export type HaloTone = "proven" | "grey" | "faint";
const TONES: Record<HaloTone, { rgb: [number, number, number]; base: number; span: number }> = {
  proven: { rgb: [0, 236, 151], base: 0.35, span: 0.5 },
  grey: { rgb: [145, 147, 149], base: 0.35, span: 0.5 },
  faint: { rgb: [0, 236, 151], base: 0.3, span: 0.45 },
};

export function DitherHalo({
  tone = "grey",
  size = 56,
  cell = 2,
  inner = 7,
  rest = 14,
  reach = 26,
  className = "halo",
}: {
  tone?: HaloTone;
  /** Canvas width and height, css px. */
  size?: number;
  /** Dither cell, css px. */
  cell?: number;
  /** Radius kept clear for the node or dot it surrounds. */
  inner?: number;
  /** The ring's outer radius at its smallest: it breathes, it never fades to nothing. */
  rest?: number;
  /** The ring's outer radius at its fullest. */
  reach?: number;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = size * dpr;
    cv.height = size * dpr;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const { rgb, base, span } = TONES[tone];
    const [r, g, b] = rgb;
    const n = Math.ceil(size / cell);
    const c = size / 2;
    const draw = (t: number) => {
      // 0..1..0 over 2.4 s, eased at both ends
      const phase = (Math.sin((t / 2400) * Math.PI * 2 - Math.PI / 2) + 1) / 2;
      const R = rest + phase * (reach - rest);
      ctx.clearRect(0, 0, size, size);
      for (let y = 0; y < n; y++)
        for (let x = 0; x < n; x++) {
          const d = Math.hypot(x * cell + cell / 2 - c, y * cell + cell / 2 - c);
          if (d < inner || d > R) continue;
          // brightest just outside the centre, fading to nothing at the ring's edge
          const k = 1 - (d - inner) / Math.max(1, R - inner);
          const e = k * k * (3 - 2 * k) * (0.55 + 0.45 * (1 - phase));
          if (e > BAYER[(y & 3) * 4 + (x & 3)]) {
            ctx.fillStyle = `rgba(${r}, ${g}, ${b}, ${(base + e * span).toFixed(2)})`;
            ctx.fillRect(x * cell, y * cell, cell, cell);
          }
        }
    };
    // One frame at once, so the halo is there before (or without) the loop: off screen, under reduced motion.
    draw(1200);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    const loop = (t: number) => {
      draw(t);
      raf = requestAnimationFrame(loop);
    };
    const io = new IntersectionObserver(([e]) => {
      cancelAnimationFrame(raf);
      if (e.isIntersecting) raf = requestAnimationFrame(loop);
    });
    io.observe(cv);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [tone, size, cell, inner, rest, reach]);
  return <canvas ref={ref} className={className} style={{ width: size, height: size }} aria-hidden="true" />;
}
