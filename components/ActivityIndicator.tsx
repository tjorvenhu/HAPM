'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Archive, ChevronUp, Loader2, Network, RefreshCw, RotateCcw } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useNow } from '@/components/useNow';
import { useT } from '@/lib/i18n/react';
import RunOverlay from '@/components/runs/RunOverlay';
import { HAPROXY_PHASE_LABELS } from '@/components/runPhases';
import {
  clearReopenRun,
  emitRunFinished,
  peekReopenRun,
  reloadKeepingRun,
  runKey,
  subscribeOpenRun,
  type RunKind,
  type RunRef,
  type RunRequest,
} from '@/components/runs/runs';
import { finishedToast, handedOver, loadRun, replacesHapm } from '@/components/runs/sources';
import type { ActivityJob } from '@/app/api/activity/route';

const POLL_MS = 4000;

const KIND_ICONS: Record<RunKind, ReactNode> = {
  haproxy: <Network size={15} />,
  update: <RefreshCw size={15} className="spin" />,
  backup: <Archive size={15} />,
  restore: <RotateCcw size={15} />,
};

function elapsedLabel(startedAt: string, now: number): string {
  const sec = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/**
 * Die Pille unten rechts und das Fenster der Läufe (`components/runs/`).
 *
 * Die Pille zeigt, was gerade im Hintergrund läuft, ein Klick auf einen Lauf
 * öffnet sein Fenster. Eine Seite, die einen Lauf startet, ruft `startRun`:
 * das Fenster geht auf, und sein Ende kommt als Meldung. Ein Neuladen der Seite
 * öffnet kein Fenster von selbst, wie beim Reverse-Proxy: dann zeigt die Pille
 * den Lauf.
 *
 * Gemeldet wird das Ende eines Laufs, den diese Seite gestartet hat, und das
 * jedes Updates, jeder Sicherung und jedes Zurückspielens, das die Pille hat
 * laufen sehen. Vorgänge am Reverse-Proxy melden ihre Seiten selbst.
 *
 * Beim Tausch von HAPM und beim Zurückspielen antwortet danach ein anderer
 * Prozess: die Seite lädt neu, sobald HAPM wieder antwortet, und das Fenster
 * geht danach wieder auf.
 */
export default function ActivityIndicator() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const { t, plural } = useT();
  const now = useNow();
  const [jobs, setJobs] = useState<ActivityJob[]>([]);
  const [open, setOpen] = useState(false);
  // Nach dem Neuladen mitten im Tausch wieder offen (`reloadKeepingRun`).
  const [modal, setModal] = useState<RunRequest | null>(() => {
    const reopen = peekReopenRun();
    return reopen?.open ? reopen.request : null;
  });
  const [refreshKey, setRefreshKey] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const modalRef = useRef(modal);
  const jobsRef = useRef<ActivityJob[]>([]);
  /** Läufe, deren Ende als Meldung kommt. */
  const watched = useRef(new Map<string, RunRef>());
  const checking = useRef(new Set<string>());
  /** Läufe, die diese Seite laufen gesehen hat. Nur nach ihrem Ende wird neu geladen, sonst nach jedem Neuladen wieder. */
  const seenRunning = useRef(new Set<string>());
  /** HAPM hat seit der letzten Antwort nicht geantwortet. */
  const sawDown = useRef(false);

  useEffect(() => {
    modalRef.current = modal;
  }, [modal]);

  useEffect(() => {
    const reopened = peekReopenRun()?.request;
    clearReopenRun();
    if (reopened?.watch) watched.current.set(runKey(reopened), reopened);
  }, []);

  useEffect(
    () =>
      subscribeOpenRun((request) => {
        setModal(request);
        setOpen(false);
        if (request.watch) {
          watched.current.set(runKey(request), request);
          setRefreshKey((key) => key + 1);
        }
      }),
    []
  );

  const show = useCallback((ref: RunRef) => setModal({ ...ref, watch: false }), []);

  /** Ob gerade ein Lauf HAPM ersetzt. Dann heißt „antwortet wieder": neu laden. */
  const replacing = useCallback(() => {
    return jobsRef.current.some((job) => replacesHapm(job.kind, job.component));
  }, []);

  /**
   * Neu laden und danach weitermachen: das offene Fenster geht wieder auf, und
   * der Lauf, der HAPM ersetzt, bleibt verfolgt, damit sein Ende als Meldung kommt.
   */
  const reload = useCallback((fallback?: RunRef) => {
    const current = modalRef.current;
    const job = jobsRef.current.find((entry) => replacesHapm(entry.kind, entry.component));
    const target: RunRef | null = current ?? fallback ?? (job ? { kind: job.kind, id: job.id } : null);
    if (!target) {
      reloadKeepingRun(null);
      return;
    }
    // Updates, Sicherung und Zurückspielen meldet die Pille immer, Reverse-Proxy nur, wenn hier gestartet.
    const watch = target.kind !== 'haproxy' || current?.watch === true;
    reloadKeepingRun({ request: { ...target, watch }, open: current !== null });
  }, []);

  const finish = useCallback(
    async (ref: RunRef) => {
      const key = runKey(ref);
      if (checking.current.has(key)) return;
      checking.current.add(key);
      try {
        const result = await loadRun(apiFetch, ref);
        if (result.state === 'missing') {
          watched.current.delete(key);
          return;
        }
        if (result.state !== 'ok' || result.view.status === 'running') return;
        watched.current.delete(key);
        emitRunFinished(ref);
        if (
          ref.kind === 'update' &&
          result.view.component === 'hapm' &&
          handedOver(result.view) &&
          seenRunning.current.has(key)
        ) {
          // Die Seite stammt noch aus dem alten Abbild. Die Meldung kommt nach dem Neuladen.
          reload(ref);
          return;
        }
        const toast = finishedToast(result.view, ref, t);
        notify({ ...toast, action: { label: t('Schritte ansehen'), onClick: () => show(ref) } });
      } finally {
        checking.current.delete(key);
      }
    },
    [apiFetch, notify, reload, show, t]
  );

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      let res: Response;
      let data: { success?: boolean; data?: { jobs: ActivityJob[] } } | null;
      try {
        res = await apiFetch('/api/activity', { cache: 'no-store' });
        data = await res.json();
      } catch {
        // Keine Antwort, oder eine Fehlerseite von HAProxy statt JSON.
        sawDown.current = true;
        return;
      }
      if (cancelled) return;
      if (res.status === 401) {
        // Nach dem Zurückspielen sind alle Sitzungen weg: neu laden führt zur Anmeldung.
        if (sawDown.current || replacing()) reload();
        return;
      }
      if (!data?.success || !data.data) {
        sawDown.current = true;
        return;
      }
      if (sawDown.current && replacing()) {
        reload();
        return;
      }
      sawDown.current = false;

      const next = data.data.jobs;
      jobsRef.current = next;
      setJobs(next);
      for (const job of next) {
        seenRunning.current.add(runKey(job));
        if (job.kind !== 'haproxy') watched.current.set(runKey(job), { kind: job.kind, id: job.id });
      }
      const running = new Set(next.map(runKey));
      for (const [key, ref] of watched.current) {
        if (!running.has(key)) void finish(ref);
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [apiFetch, finish, reload, replacing, refreshKey]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // Neben der Pille, nicht in ihr: so bleibt das Fenster stehen, wenn der Lauf
  // aus der Liste fällt und die Pille verschwindet. Sein Ergebnis soll zu sehen sein.
  const overlay = modal ? <RunOverlay key={runKey(modal)} run={modal} onClose={() => setModal(null)} /> : null;

  const label = plural(jobs.length, { one: '{count} Vorgang', other: '{count} Vorgänge' });

  function subline(job: ActivityJob): string {
    switch (job.kind) {
      case 'update':
        return t('Update');
      case 'backup':
        return t('Sicherung');
      case 'restore':
        return t('Zurückspielen');
      default:
        return job.phase && HAPROXY_PHASE_LABELS[job.phase] ? t(HAPROXY_PHASE_LABELS[job.phase]) : t('Reverse-Proxy');
    }
  }

  return (
    <>
      {jobs.length > 0 && (
        <div className="activity-indicator" ref={rootRef}>
          {open && (
            <div className="activity-panel" role="menu">
              <div className="activity-panel-head">{t('Laufende Vorgänge')}</div>
              {jobs.map((job) => (
                <button
                  key={runKey(job)}
                  type="button"
                  className="activity-row activity-row-clickable"
                  onClick={() => {
                    show({ kind: job.kind, id: job.id });
                    setOpen(false);
                  }}
                  role="menuitem"
                >
                  {KIND_ICONS[job.kind]}
                  <div className="activity-row-text">
                    <span className="activity-row-name">{job.name}</span>
                    <span className="activity-row-sub">{subline(job)}</span>
                  </div>
                  <span className="activity-row-time">{elapsedLabel(job.startedAt, now)}</span>
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            className="activity-pill"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={t('Laufende Vorgänge anzeigen')}
          >
            <Loader2 size={15} className="spin" />
            <span>{label}</span>
            <ChevronUp size={14} className={open ? 'activity-chevron-open' : ''} />
          </button>
        </div>
      )}
      {overlay}
    </>
  );
}
