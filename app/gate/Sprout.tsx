'use client';

import { useEffect, useState } from 'react';
import { SPROUT_POSTER, SPROUT_GROUND } from '@/lib/sprout';

/**
 * Sprout, walking, behind the door.
 *
 * The still is server-rendered as a background image, so he is on screen before
 * any JavaScript runs and stays there for everyone the guards below turn away.
 * The video is 181 KB and only ever fetched when all three hold:
 *
 *   - the teacher has not asked their system for less motion
 *   - the browser is not in data-saver mode
 *   - the connection is not 2G, where 181 KB is a ten-second wait
 *
 * Connectivity is the top barrier at 75%, so the guard is about data, not
 * screen size - unlike Ambience, which guards on width because a canvas costs
 * battery. A phone is where this portrait video fits best, and it is not
 * excluded.
 */
export default function Sprout() {
  const [play, setPlay] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    // Not in every browser, and absence is not a slow connection.
    const link = (navigator as unknown as {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    if (link?.saveData) return;
    if (link?.effectiveType && ['slow-2g', '2g'].includes(link.effectiveType)) return;

    setPlay(true);
  }, []);

  return (
    <div className="sproutbg" aria-hidden
         style={{ backgroundColor: SPROUT_GROUND, backgroundImage: `url(${SPROUT_POSTER})` }}>
      {play && (
        <video src="/sprout-walk.mp4" poster={SPROUT_POSTER}
               autoPlay muted loop playsInline preload="auto" />
      )}
    </div>
  );
}
