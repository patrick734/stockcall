"use client";

import { useEffect, useRef } from "react";

/// Quiet concentric ripples behind the home hero. Static under reduced motion; pauses while the tab is hidden.
export function Ripple() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let raf = 0;
    let t = 0;

    const size = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = canvas.clientWidth * dpr;
      canvas.height = canvas.clientHeight * dpr;
    };
    const draw = () => {
      const { width: w, height: h } = canvas;
      ctx.clearRect(0, 0, w, h);
      const cx = w * 0.55;
      const cy = h * 0.5;
      const max = Math.min(w, h) * 0.6;
      const rings = 9;
      for (let i = 0; i < rings; i++) {
        const p = (i / rings + t) % 1;
        ctx.beginPath();
        ctx.ellipse(cx, cy, p * max, p * max * 0.42, 0, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(31, 79, 216, ${(1 - p) * 0.28})`;
        ctx.lineWidth = 1.2 * (window.devicePixelRatio || 1);
        ctx.stroke();
      }
    };
    const loop = () => {
      t = (t + 0.0016) % 1;
      draw();
      raf = requestAnimationFrame(loop);
    };
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduce) raf = requestAnimationFrame(loop);
    };

    size();
    if (reduce) draw();
    else raf = requestAnimationFrame(loop);
    window.addEventListener("resize", size);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", size);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  return <canvas ref={ref} className="hero-canvas" aria-hidden />;
}
