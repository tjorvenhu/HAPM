'use client';

import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, CheckCircle2, Loader2, Minimize2, XCircle } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useNow } from '@/components/useNow';
import { HAPROXY_PHASE_LABELS, haproxyPhases } from '@/components/runPhases';
import { useT } from '@/lib/i18n/react';
import RunStepList from './RunStepList';
import { emitRunFinished, type RunRef } from './runs';
import { firstFailedStep, loadRun, runContext, runTitle, type LoadResult, type RunView } from './sources';

const POLL_MS = 2000;

/** Ab hier sagt das Fenster, dass der Tausch von HAPM länger dauert als üblich. */
const HANDOVER_SLOW_MS = 3 * 60 * 1000;

function formatDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

interface Props {
  run: RunRef;
  /** Schließt nur das Fenster. Der Lauf geht auf dem Server weiter, die Pille zeigt ihn. */
  onClose: () => void;
}

/**
 * Das Fenster eines Laufs: Reverse-Proxy, Update, Sicherung, Zurückspielen.
 *
 * Es holt sich den Lauf selbst und fragt, bis er fertig ist. Ein Reverse-Proxy-
 * Vorgang zeigt seine Phasen als Reihe aus Kreisen und das Protokoll darunter,
 * die anderen ihre Schritte untereinander (jeder trägt einen Text, der gelesen
 * werden soll).
 *
 * Antwortet HAPM nicht, bleibt das Fenster stehen und fragt weiter: beim Tausch
 * von HAPM oder HAProxy und beim Zurückspielen ist die Oberfläche kurz weg. Das
 * Neuladen danach übernimmt `ActivityIndicator`, nicht das Fenster.
 */
export default function RunOverlay({ run, onClose }: Props) {
  const { apiFetch } = useApp();
  const { t } = useT();
  const now = useNow();
  const [view, setView] = useState<RunView | null>(null);
  const [state, setState] = useState<LoadResult['state'] | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let cancelled = false;
    let done = false;
    let busy = false;
    let sawRunning = false;

    const poll = async () => {
      if (busy || done) return;
      busy = true;
      try {
        const result = await loadRun(apiFetch, run);
        if (cancelled) return;
        setState(result.state);
        if (result.state === 'missing') {
          done = true;
          return;
        }
        if (result.state !== 'ok') return;
        setView(result.view);
        if (result.view.status === 'running') {
          sawRunning = true;
        } else {
          done = true;
          // Wer zugesehen hat, wie er fertig wurde, lädt nach (etwa die Historie).
          if (sawRunning) emitRunFinished(run);
        }
      } finally {
        busy = false;
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [run, apiFetch]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [view?.output]);

  const running = !view || view.status === 'running';
  const offline = state === 'offline' || state === 'signed-out';
  const elapsedSec = !view
    ? 0
    : ((view.completedAt ? Date.parse(view.completedAt) : now) - Date.parse(view.startedAt)) / 1000;
  const failedStep = view && !running ? firstFailedStep(view) : null;
  const context = run.context ?? runContext(view);
  const haproxy = run.kind === 'haproxy';
  const phases = haproxyPhases(view?.action);
  const currentIndex = view?.phase ? phases.indexOf(view.phase) : -1;

  const statusIcon = !view ? null : view.status === 'success' ? (
    <CheckCircle2 size={28} style={{ color: 'var(--success)' }} />
  ) : view.status === 'warning' ? (
    <AlertTriangle size={28} style={{ color: 'var(--warning)' }} />
  ) : (
    <XCircle size={28} style={{ color: 'var(--danger)' }} />
  );

  return (
    <div className="modal-overlay">
      <div className="modal" style={{ maxWidth: 760 }} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2 className="modal-title">
            {runTitle(view, run, t)}
            {context && <span className="modal-subject">{context}</span>}
          </h2>
        </div>

        <div className="modal-body">
          {state === 'missing' ? (
            <div className="alert alert-warning">
              <AlertTriangle size={16} strokeWidth={1.5} />
              <span>{t('Diesen Lauf gibt es nicht.')}</span>
            </div>
          ) : (
            <>
              {offline && running && <OfflineNote run={run} view={view} now={now} />}

              {running ? (
                <>
                  {haproxy && (
                    <div className="run-steps">
                      {phases.map((phase, i) => {
                        const done = currentIndex >= 0 && i < currentIndex;
                        const active = i === currentIndex;
                        const stateClass = done ? 'run-step-done' : active ? 'run-step-active' : '';
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
                            <span className="run-step-label">{t(HAPROXY_PHASE_LABELS[phase] ?? phase)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  <div className="run-status-line">
                    <span className="run-timer">{formatDuration(elapsedSec)}</span>
                    <span className="run-phase-name">
                      {haproxy
                        ? view?.phase
                          ? t(HAPROXY_PHASE_LABELS[view.phase] ?? view.phase)
                          : t('Wird gestartet')
                        : t('Der Lauf geht weiter, auch wenn diese Seite geschlossen wird.')}
                    </span>
                  </div>
                </>
              ) : (
                <div className="run-result">
                  {statusIcon}
                  <div>
                    <strong>
                      {view?.status === 'success'
                        ? t('Erfolgreich')
                        : view?.status === 'warning'
                          ? t('Mit Hinweisen abgeschlossen')
                          : t('Fehlgeschlagen')}
                    </strong>
                    <span className="run-result-meta">{formatDuration(elapsedSec)}</span>
                  </div>
                </div>
              )}

              {failedStep && (
                <div className="alert alert-danger hapm-flag">
                  <XCircle size={16} strokeWidth={1.5} />
                  <div className="hapm-flag-body">
                    <strong>{t('Fehlgeschlagen bei: {step}', { step: t(failedStep.label) })}</strong>
                    {view?.error && <span>{t(view.error)}</span>}
                  </div>
                </div>
              )}

              {view?.error && !failedStep && (
                <div className={`alert ${view.status === 'error' ? 'alert-danger' : 'alert-warning'}`}>
                  {t(view.error)}
                </div>
              )}

              {haproxy ? (
                <pre className="run-log" ref={logRef}>
                  {view?.output || t('Warte auf Ausgabe...')}
                </pre>
              ) : view ? (
                <RunStepList steps={view.steps} pending={view.pending} />
              ) : (
                <p className="form-hint">{t('Wird gestartet')}</p>
              )}
            </>
          )}
        </div>

        <div className="modal-footer">
          {/* Der Lauf hängt nicht an diesem Fenster: Schließen ist immer sicher. */}
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            <Minimize2 size={16} />
            {running && state !== 'missing' ? t('Im Hintergrund weiterlaufen lassen') : t('Schließen')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Was das Fenster sagt, solange HAPM nicht antwortet. */
function OfflineNote({ run, view, now }: { run: RunRef; view: RunView | null; now: number }) {
  const { t } = useT();
  if (run.kind === 'restore') {
    return (
      <div className="alert alert-info hapm-flag">
        <Loader2 size={16} strokeWidth={1.5} className="spin" />
        <div className="hapm-flag-body">
          <strong>{t('HAPM startet mit dem Stand der Sicherung neu')}</strong>
          <span>
            {t(
              'Die Oberfläche ist kurz nicht erreichbar. Diese Seite lädt neu, sobald HAPM wieder antwortet. Danach melden Sie sich mit einem Konto aus der Sicherung an.'
            )}
          </span>
        </div>
      </div>
    );
  }
  if (run.kind === 'update' && view?.component === 'hapm') {
    const elapsed = now - Date.parse(view.startedAt);
    return (
      <div className="alert alert-info hapm-flag">
        <Loader2 size={16} strokeWidth={1.5} className="spin" />
        <div className="hapm-flag-body">
          <strong>{t('HAPM wird ersetzt')}</strong>
          <span>
            {t(
              'Ein Helfer aus dem neuen Abbild tauscht gerade den Container. Die Oberfläche ist kurz nicht erreichbar. Diese Seite lädt neu, sobald HAPM wieder antwortet.'
            )}
          </span>
          {elapsed > HANDOVER_SLOW_MS && (
            <span>{t('Das dauert länger als üblich. Die Ausgabe des Containers auf dem Server zeigt, woran es hängt.')}</span>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="alert alert-warning">
      <AlertTriangle size={16} strokeWidth={1.5} />
      <span>
        {t('HAPM antwortet gerade nicht. Die Seite versucht es weiter.')}
        {run.kind === 'update' &&
          view?.component === 'haproxy' &&
          ` ${t('Läuft die Oberfläche über HAProxy, ist das beim Tausch zu erwarten.')}`}
      </span>
    </div>
  );
}
