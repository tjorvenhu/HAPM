'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { Loader2, RefreshCw, ChevronUp, Network } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useNow } from '@/components/useNow';
import UpdateRunOverlay from '@/components/UpdateRunOverlay';
import { HAPROXY_PHASES, HAPROXY_PHASE_LABELS } from '@/components/runPhases';
import type { ActivityJob } from '@/app/api/activity/route';

function elapsedLabel(startedAt: string, now: number): string {
  const sec = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Die Pille unten rechts: was gerade im Hintergrund läuft.
 *
 * Ein Vorgang am Reverse-Proxy (Anlegen, Ändern, Löschen) dauert Minuten und
 * läuft abgekoppelt: der Dialog schließt sich sofort, das Weitere steht hier,
 * und ein Klick zeigt die Schritte. Ein Update führt auf seine Seite: dort
 * stehen die Schritte neben dem Stand der Versionen.
 */
export default function ActivityIndicator() {
  const { apiFetch } = useApp();
  const [jobs, setJobs] = useState<ActivityJob[]>([]);
  const [open, setOpen] = useState(false);
  const now = useNow();
  const [openRun, setOpenRun] = useState<string | null>(null);
  // Von den Handlern hochgezählt, damit sofort neu gelesen wird (etwa nach dem Ende eines Laufs).
  const [refreshKey, setRefreshKey] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const data = await apiFetch('/api/activity')
        .then((r) => r.json())
        .catch(() => null);
      if (!cancelled && data?.success) setJobs(data.data.jobs);
    };

    poll();
    const interval = setInterval(poll, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [apiFetch, refreshKey]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const overlay = openRun ? (
    <UpdateRunOverlay
      runId={openRun}
      endpoint="/api/haproxy/runs"
      phases={HAPROXY_PHASES}
      phaseLabels={HAPROXY_PHASE_LABELS}
      noun="Reverse-Proxy"
      onClose={() => setOpenRun(null)}
      onFinished={() => setRefreshKey((k) => k + 1)}
    />
  ) : null;

  if (jobs.length === 0) {
    // Das Overlay bleibt stehen, während ein Lauf endet: sein Ergebnis soll zu
    // sehen sein, auch wenn der Vorgang schon aus der Liste gefallen ist.
    return overlay;
  }

  const label = jobs.length === 1 ? '1 Vorgang' : `${jobs.length} Vorgänge`;

  return (
    <div className="activity-indicator" ref={rootRef}>
      {open && (
        <div className="activity-panel" role="menu">
          <div className="activity-panel-head">Laufende Vorgänge</div>
          {jobs.map((job) => {
            const key = `${job.kind}-${job.id}`;
            const time = <span className="activity-row-time">{elapsedLabel(job.startedAt, now)}</span>;

            if (job.kind === 'update') {
              return (
                <Link
                  key={key}
                  href="/updates"
                  className="activity-row activity-row-clickable"
                  role="menuitem"
                  onClick={() => setOpen(false)}
                >
                  <RefreshCw size={15} className="spin" />
                  <div className="activity-row-text">
                    <span className="activity-row-name">{job.name}</span>
                    <span className="activity-row-sub">Update</span>
                  </div>
                  {time}
                </Link>
              );
            }

            return (
              <button
                key={key}
                className="activity-row activity-row-clickable"
                onClick={() => {
                  setOpenRun(job.id);
                  setOpen(false);
                }}
                role="menuitem"
              >
                <Network size={15} />
                <div className="activity-row-text">
                  <span className="activity-row-name">{job.name}</span>
                  <span className="activity-row-sub">
                    {(job.phase ? HAPROXY_PHASE_LABELS[job.phase] : null) ?? 'Reverse-Proxy'}
                  </span>
                </div>
                {time}
              </button>
            );
          })}
        </div>
      )}

      <button
        className="activity-pill"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="Laufende Vorgänge anzeigen"
      >
        <Loader2 size={15} className="spin" />
        <span>{label}</span>
        <ChevronUp size={14} className={open ? 'activity-chevron-open' : ''} />
      </button>

      {overlay}
    </div>
  );
}
