"use client";
// A wide field of faint green Bayer dither that drifts slowly, behind the Bounties title: the landing hero's
// scan, quieter. Decorative only (it carries no data and no proof, so it stays faint). One still frame under
// reduced motion, redrawn at about 20 frames a second, and paused while off screen.
import { useEffect, useRef } from "react";

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16);
const CELL = 3;

export function DitherBand({ className = "dither-band" }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let cols = 0;
    let rows = 0;
    const size = () => {
      const { width, height } = cv.getBoundingClientRect();
      cols = Math.ceil(width / CELL);
      rows = Math.ceil(height / CELL);
      cv.width = cols;
      cv.height = rows;
    };
    size();
    // One ImageData write per frame, not a fillStyle string per dot: a phone isn't churning tens of thousands a second.
    const draw = (t: number) => {
      // A canvas measured at zero (hidden, printing, a thumbnail renderer) has nothing to draw, and createImageData would throw.
      if (!cols || !rows) return;
      const img = ctx.createImageData(cols, rows);
      const px = img.data;
      for (let y = 0; y < rows; y++)
        for (let x = 0; x < cols; x++) {
          // Two slow diagonal waves and a drift down the page; the CSS mask fades the left and the bottom.
          const a = Math.sin(x * 0.045 + y * 0.03 - t * 0.0005);
          const b = Math.sin(x * 0.02 - y * 0.05 + t * 0.00032);
          const e = (0.5 + 0.25 * a + 0.25 * b) * (1 - (y / rows) * 0.5);
          if (e * 0.85 > BAYER[(y & 3) * 4 + (x & 3)]) {
            const i = (y * cols + x) * 4;
            px[i + 1] = 236;
            px[i + 2] = 151;
            px[i + 3] = Math.round((0.18 + e * 0.3) * 255);
          }
        }
      ctx.putImageData(img, 0, 0);
    };
    draw(4000);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let raf = 0;
    let last = 0;
    const loop = (t: number) => {
      if (t - last > 50) {
        last = t;
        draw(t);
      }
      raf = requestAnimationFrame(loop);
    };
    const io = new IntersectionObserver(([e]) => {
      cancelAnimationFrame(raf);
      if (e.isIntersecting) raf = requestAnimationFrame(loop);
    });
    io.observe(cv);
    const ro = new ResizeObserver(() => {
      size();
      draw(performance.now());
    });
    ro.observe(cv);
    return () => {
      io.disconnect();
      ro.disconnect();
      cancelAnimationFrame(raf);
    };
  }, []);
  return <canvas ref={ref} className={className} style={{ imageRendering: "pixelated" }} aria-hidden="true" />;
}
