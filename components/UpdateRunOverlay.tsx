'use client';

import { useEffect, useState, useRef } from 'react';
import {
  Check, CheckCircle2, AlertTriangle, XCircle, Minimize2, Loader2,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useNow } from '@/components/useNow';
import { HAPROXY_PHASES, HAPROXY_PHASE_LABELS } from '@/components/runPhases';
import { useT } from '@/lib/i18n/react';
import type { RunStatus } from '@/lib/types';

interface RunView {
  /** Der Zusatz in der Überschrift. Bei einem Reverse-Proxy-Vorgang die Dienst-ID. */
  serverName: string;
  status: RunStatus;
  phase: string | null;
  startedAt: string;
  completedAt: string | null;
  duration: number | null;
  error: string | null;
  output: string;
}

interface Props {
  runId: string;
  /** Closes the overlay. The run keeps going server-side either way. */
  onClose: () => void;
  onFinished?: () => void;
  /** Poll endpoint base. The run's id is appended. */
  endpoint?: string;
  /** Ordered phase keys and their labels (German keys, shown via `t()`) for the stepper and the status line. */
  phases?: string[];
  phaseLabels?: Record<string, string>;
  /** Noun used in the modal title ("Reverse-Proxy läuft"). A German key, shown via `t()`. */
  noun?: string;
}

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export default function UpdateRunOverlay({
  runId,
  onClose,
  onFinished,
  endpoint = '/api/haproxy/runs',
  phases = HAPROXY_PHASES,
  phaseLabels = HAPROXY_PHASE_LABELS,
  noun = 'Reverse-Proxy',
}: Props) {
  const { apiFetch } = useApp();
  const { t } = useT();
  const [run, setRun] = useState<RunView | null>(null);
  // Gemeinsamer Uhren-Hook statt eines eigenen Intervalls je Komponente.
  const now = useNow();
  const logRef = useRef<HTMLPreElement>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      const data = await apiFetch(`${endpoint}/${runId}`)
        .then((r) => r.json())
        .catch(() => null);
      if (cancelled || !data?.success) return;

      setRun(data.data);
      if (data.data.status !== 'running' && !finishedRef.current) {
        finishedRef.current = true;
        onFinished?.();
      }
    };

    poll();
    const interval = setInterval(() => {
      if (finishedRef.current) return;
      poll();
    }, 2000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [runId, apiFetch, onFinished, endpoint]);

  // Follow the tail as new output arrives.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [run?.output]);

  const running = !run || run.status === 'running';

  // The elapsed time comes from startedAt, not a counter that resets to 0 every
  // time the overlay is reopened. A finished run shows its stored duration.
  const elapsedSec = !run
    ? 0
    : running
      ? (now - new Date(run.startedAt).getTime()) / 1000
      : (run.duration ?? 0);

  const currentIndex = run?.phase ? phases.indexOf(run.phase) : -1;

  const statusIcon = !run ? null : run.status === 'success' ? (
    <CheckCircle2 size={28} style={{ color: 'var(--success)' }} />
  ) : run.status === 'warning' ? (
    <AlertTriangle size={28} style={{ color: 'var(--warning)' }} />
  ) : run.status === 'error' ? (
    <XCircle size={28} style={{ color: 'var(--danger)' }} />
  ) : (
    <Loader2 size={28} className="spin" />
  );

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 760 }}>
        <div className="modal-header">
          <h2 className="modal-title">
            {running
              ? t('{noun} läuft', { noun: t(noun) })
              : run?.status === 'error'
                ? t('{noun} fehlgeschlagen', { noun: t(noun) })
                : t('{noun} abgeschlossen', { noun: t(noun) })}
            {run?.serverName ? `: ${run.serverName}` : ''}
          </h2>
        </div>

        <div className="modal-body">
          {running ? (
            <>
              <div className="run-steps">
                {phases.map((phase, i) => {
                  const done = currentIndex >= 0 && i < currentIndex;
                  const active = i === currentIndex;
                  const stateClass = done
                    ? 'run-step-done'
                    : active
                      ? 'run-step-active'
                      : '';
                  return (
                    <div key={phase} className={`run-step ${stateClass}`.trimEnd()}>
                      {i < phases.length - 1 && <span className="run-step-line" />}
                      <span className="run-step-marker">
                        {done ? (
                          <Check size={16} />
                        ) : active ? (
                          <Loader2 size={16} className="spin" />
                        ) : (
                          <span className="run-step-dot" />
                        )}
                      </span>
                      <span className="run-step-label">{t(phaseLabels[phase] ?? phase)}</span>
                    </div>
                  );
                })}
              </div>

              <div className="run-status-line">
                <span className="run-timer">{formatDuration(elapsedSec)}</span>
                <span className="run-phase-name">
                  {run?.phase ? t(phaseLabels[run.phase] ?? run.phase) : t('Wird gestartet')}
                </span>
              </div>
            </>
          ) : (
            <div className="run-result">
              {statusIcon}
              <div>
                <strong>
                  {run?.status === 'success'
                    ? t('Erfolgreich')
                    : run?.status === 'warning'
                      ? t('Mit Hinweisen abgeschlossen')
                      : t('Fehlgeschlagen')}
                </strong>
                <span className="run-result-meta">{formatDuration(elapsedSec)}</span>
              </div>
            </div>
          )}

          {run?.error && (
            <div
              className={`alert ${run.status === 'error' ? 'alert-danger' : 'alert-warning'}`}
            >
              {t(run.error)}
            </div>
          )}

          <pre className="run-log" ref={logRef}>
            {run?.output || t('Warte auf Ausgabe...')}
          </pre>
        </div>

        <div className="modal-footer">
          {/* The run is detached from this browser, so closing the overlay is
              genuinely safe. */}
          <button className="btn btn-secondary" onClick={onClose}>
            <Minimize2 size={16} />
            {running ? t('Im Hintergrund weiterlaufen lassen') : t('Schließen')}
          </button>
        </div>
      </div>
    </div>
  );
}
