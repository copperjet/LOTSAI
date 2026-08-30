'use client';

import { useEffect, useRef } from 'react';

/**
 * A few dots, drifting, behind everything.
 *
 * The guards are the point. On a low-end Android in a classroom this component
 * does nothing at all: no canvas, no loop, no paint. It runs only on a wide
 * screen, only when the tab is visible, and never when the teacher has asked
 * their system for less motion.
 */

const COUNT = 40;
const MIN_WIDTH = 880;   // where .today and .meter already hide
const MAX_DPR = 2;       // a 3x phone would cost three times the fill for nothing

export default function Ambience() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (reduced.matches || window.innerWidth < MIN_WIDTH) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let w = 0, h = 0, dpr = 1;
    let colour = 'rgba(29,88,41,.5)';

    // Read from the live custom properties, so the dots follow the palette
    // rather than duplicating it.
    const readColour = () => {
      const s = getComputedStyle(document.documentElement);
      colour = (s.getPropertyValue('--forest-light') || s.getPropertyValue('--forest') || '#31773F').trim();
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };

    resize();
    readColour();

    const dots = Array.from({ length: COUNT }, () => ({
      x: Math.random() * w,
      y: Math.random() * h,
      r: 1 + Math.random() * 1.5,
      // well under a pixel a frame: at 60fps this is a drift, not a movement
      vx: (Math.random() - 0.5) * 0.16,
      vy: (Math.random() - 0.5) * 0.16,
      a: 0.1 + Math.random() * 0.16,
    }));

    const frame = () => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = colour;
      for (const d of dots) {
        d.x += d.vx; d.y += d.vy;
        if (d.x < -4) d.x = w + 4; else if (d.x > w + 4) d.x = -4;
        if (d.y < -4) d.y = h + 4; else if (d.y > h + 4) d.y = -4;
        ctx.globalAlpha = d.a;
        ctx.beginPath();
        ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(frame);
    };

    const start = () => { if (!raf) raf = requestAnimationFrame(frame); };
    const stop = () => { if (raf) { cancelAnimationFrame(raf); raf = 0; } };

    // No work behind a background tab.
    const onVisibility = () => (document.hidden ? stop() : start());
    // A narrowed window stops costing anything, and clears what it drew.
    const onResize = () => {
      resize();
      if (window.innerWidth < MIN_WIDTH) { stop(); ctx.clearRect(0, 0, w, h); }
      else start();
    };
    const scheme = window.matchMedia('(prefers-color-scheme: dark)');

    start();
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('resize', onResize);
    scheme.addEventListener('change', readColour);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', onResize);
      scheme.removeEventListener('change', readColour);
    };
  }, []);

  return <canvas ref={ref} className="ambience" aria-hidden="true" />;
}
