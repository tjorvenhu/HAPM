'use client';

import { useEffect, useRef } from 'react';

/**
 * Re-run a data loader on an interval so a page reflects server-side changes
 * without a manual reload.
 *
 * Two rules that keep this from becoming a load problem:
 *  - It pauses while the tab is hidden. The database is the bottleneck, and
 *    nobody is looking at a background tab, so there is no reason to keep
 *    hitting it.
 *  - The loader must only refresh DATA, never `loading`/modal/form state. This
 *    hook fires blindly; a loader that resets a spinner or clears a form on every
 *    tick would flicker the page. Pass a loader that just re-fetches and setState.
 *
 * The loader is held in a ref so a caller can pass an inline async function
 * without the interval resetting on every render.
 */
export function usePolling(load: () => void | Promise<void>, intervalMs: number): void {
  const loadRef = useRef(load);
  useEffect(() => {
    loadRef.current = load;
  }, [load]);

  useEffect(() => {
    if (intervalMs <= 0) return;

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      void loadRef.current();
    };

    const id = setInterval(tick, intervalMs);
    // Catch up immediately when the tab becomes visible again, rather than
    // waiting out a full interval on a stale view.
    const onVisible = () => {
      if (!document.hidden) void loadRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
}
