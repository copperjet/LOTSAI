'use client';

import { useEffect, useRef } from 'react';

/**
 * A field of dots, behind everything, pulsing outward in rings.
 *
 * The dots never move. A ring is a travelling band of brightness, so the only
 * thing animating is opacity — there is no position to integrate and no drift
 * to accumulate. At rest it is a static grid, which costs nothing.
 *
 * The guards are the point. On a low-end Android in a classroom this component
 * does nothing at all: no canvas, no loop, no paint. It runs only on a wide
 * screen, only when the tab is visible, and never when the teacher has asked
 * their system for less motion.
 */

const SPACING = 26;      // px between dots
const SIZE = 2;          // px per dot, drawn as a square
const MIN_WIDTH = 880;   // where .today and .meter already hide
const MAX_DPR = 2;       // a 3x phone would cost three times the fill for nothing
const FPS = 30;          // the motion is slow; 60 buys nothing and costs double

const FLOOR = 0.11;      // resting opacity, so the grid reads as texture
const PEAK = 0.5;        // brightest a dot gets as a ring passes through it
const BAND = 90;         // px — how wide the travelling band is
const SPEED = 0.16;      // px per ms
const EVERY = 3200;      // ms between rings
const MAX_RINGS = 3;

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
    let cols = 0, rows = 0;
    let ox = 0, oy = 0;      // the emitter
    let reach = 0;           // viewport diagonal — a ring is done past this
    let rgb = '49,119,63';

    // Read from the live custom properties, so the dots follow the palette
    // rather than duplicating it.
    const readColour = () => {
      const s = getComputedStyle(document.documentElement);
      const hex = (s.getPropertyValue('--forest-light') || s.getPropertyValue('--forest') || '#31773F').trim();
      const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
      if (m) rgb = `${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)}`;
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
      w = window.innerWidth; h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      cols = Math.ceil(w / SPACING) + 1;
      rows = Math.ceil(h / SPACING) + 1;
      // Slightly above centre: behind the greeting and the composer, which is
      // where the eye already is.
      ox = w / 2; oy = h * 0.42;
      reach = Math.hypot(Math.max(ox, w - ox), Math.max(oy, h - oy));
    };

    resize();
    readColour();

    let rings: number[] = [];      // birth times
    let last = 0;
    let nextRing = 0;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - last < 1000 / FPS) return;
      last = now;

      if (now >= nextRing && rings.length < MAX_RINGS) {
        rings.push(now);
        nextRing = now + EVERY;
      }
      rings = rings.filter(born => (now - born) * SPEED < reach + BAND);

      ctx.clearRect(0, 0, w, h);
      const radii = rings.map(born => (now - born) * SPEED);

      for (let iy = 0; iy < rows; iy++) {
        const y = iy * SPACING;
        for (let ix = 0; ix < cols; ix++) {
          const x = ix * SPACING;
          let a = FLOOR;

          for (const r of radii) {
            const d = Math.abs(Math.hypot(x - ox, y - oy) - r);
            if (d > BAND) continue;
            // Narrow band, and the whole ring fades as it travels out.
            const band = 1 - d / BAND;
            const life = 1 - r / (reach + BAND);
            a += (PEAK - FLOOR) * band * band * life;
          }

          ctx.fillStyle = `rgba(${rgb},${a.toFixed(3)})`;
          ctx.fillRect(x, y, SIZE, SIZE);
        }
      }
    };

    const start = () => { if (!raf) { last = 0; raf = requestAnimationFrame(frame); } };
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
