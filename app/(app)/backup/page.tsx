'use client';

import { Fragment, Suspense, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FolderClock,
  History,
  ListChecks,
  Loader2,
  RotateCcw,
  Save,
  X,
} from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import { SkeletonDetail, SkeletonRows } from '@/components/Skeleton';
import AreaTabs, { useArea, type Area } from '@/components/AreaTabs';
import { RUN_STATUS_CLASS, RUN_STATUS_LABELS, formatClock } from '@/components/system/format';
import { formatBytes, formatDateTime, msgid, type Translator } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import RestorePanel from '@/components/backup/RestorePanel';
// Nur Typen: die Dateien dahinter erreichen `lib/db` und `lib/docker`.
import type { BackupOverview, BackupRunForClient } from '@/app/api/backup/route';
import type { HaproxyStep } from '@/lib/types';

type RunView = Omit<BackupRunForClient, 'steps'> & { steps: HaproxyStep[] };
type BackupData = Omit<BackupOverview, 'runs'> & { runs: RunView[] };

/**
 * Ein laufender Lauf steht über den Reitern, darunter je ein Thema: wohin und
 * wann gesichert wird, das Zurückspielen und die Läufe. Der gewählte steht als
 * `?bereich=` in der Adresse.
 */
type BackupArea = 'einstellungen' | 'zurueckspielen' | 'historie';

const AREAS: Area<BackupArea>[] = [
  { key: 'einstellungen', label: msgid('Einstellungen'), icon: FolderClock },
  { key: 'zurueckspielen', label: msgid('Zurückspielen'), icon: RotateCcw },
  { key: 'historie', label: msgid('Historie'), icon: History },
];

interface FormState {
  hostPath: string;
  enabled: boolean;
  time: string;
  keep: string;
}

const POLL_IDLE_MS = 30_000;
const POLL_RUNNING_MS = 2000;

// Dieselben Grenzen wie `BACKUP_KEEP_MIN`/`BACKUP_KEEP_MAX`. Von dort nicht
// importiert: `lib/backup/settings.ts` erreicht die Datenbank.
const KEEP_MIN = 1;
const KEEP_MAX = 365;

/**
 * Was ein Lauf der Reihe nach tut. `lib/backup/run.ts` meldet einen Schritt
 * erst, wenn er fertig ist: an der Zahl der gemeldeten zeigt sich, welcher
 * gerade läuft.
 */
const BACKUP_PLAN = [
  msgid('Datenbank herausschreiben'),
  msgid('Schlüssel dazulegen'),
  msgid('Archiv schreiben'),
  msgid('Alte Sicherungen aufräumen'),
];

function formFrom(settings: BackupData['settings']): FormState {
  return {
    hostPath: settings.hostPath ?? '',
    enabled: settings.enabled,
    time: settings.time,
    keep: String(settings.keep),
  };
}

/** Nur Ziffern und nichts über der Grenze. Leer bleibt erlaubt, solange getippt wird. */
function readKeepField(raw: string, previous: string): string {
  const digits = raw.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  if (digits === '') return '';
  return Number(digits) > KEEP_MAX ? previous : digits;
}

function triggeredByLabel(value: string | null, t: Translator['t']): string {
  if (!value) return '';
  return value === 'scheduler' ? t('Zeitplan') : value;
}

function runDuration(run: RunView, now: number): string {
  const start = Date.parse(run.startedAt);
  const end = run.completedAt ? Date.parse(run.completedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  return formatClock(end - start);
}

function pendingSteps(run: RunView): string[] {
  if (run.status !== 'running' || run.steps.some((step) => !step.ok)) return [];
  return BACKUP_PLAN.slice(run.steps.length);
}

function RunSteps({ run }: { run: RunView }) {
  const { t } = useT();
  const pending = pendingSteps(run);
  if (run.steps.length === 0 && pending.length === 0) {
    return <p className="form-hint">{t('Zu diesem Lauf sind keine Schritte festgehalten.')}</p>;
  }
  return (
    <ul className="hapm-steps">
      {run.steps.map((step, index) => (
        <li key={`${index}-${step.label}`} className={`hapm-step ${step.ok ? 'is-ok' : 'is-failed'}`}>
          {step.ok ? <Check size={14} strokeWidth={1.5} /> : <X size={14} strokeWidth={1.5} />}
          <span className="hapm-step-text">
            <span className="hapm-step-label">{t(step.label)}</span>
            {step.detail && <span className="hapm-step-detail">{t(step.detail)}</span>}
          </span>
        </li>
      ))}
      {pending.map((label, index) => (
        <li key={`pending-${label}`} className={`hapm-step ${index === 0 ? 'is-running' : 'is-pending'}`}>
          {index === 0 ? (
            <Loader2 size={14} strokeWidth={1.5} className="spin" />
          ) : (
            <Circle size={14} strokeWidth={1.5} />
          )}
          <span className="hapm-step-text">
            <span className="hapm-step-label">{t(label)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function BackupPage() {
  return (
    <Suspense fallback={<SkeletonDetail />}>
      <Backup />
    </Suspense>
  );
}

function Backup() {
  const { apiFetch } = useApp();
  const [area, selectArea] = useArea(AREAS, '/backup');
  const { notify } = useToast();
  const { t, rich, locale } = useT();
  const now = useNow(1000);

  const [data, setData] = useState<BackupData | null>(null);
  const [error, setError] = useState('');
  /** Nur was im Formular geändert wurde. So überschreibt eine Abfrage keine Eingabe. */
  const [draft, setDraft] = useState<FormState | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [starting, setStarting] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/backup', { cache: 'no-store' });
      const body = await res.json();
      if (body.success) {
        setData(body.data as BackupData);
        setError('');
      } else {
        setError(body.error || t('Die Sicherung konnte nicht geladen werden.'));
      }
    } catch {
      setError(t('Die Sicherung konnte nicht geladen werden.'));
    }
  }, [apiFetch, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const locked = Boolean(data?.running) || starting;
  usePolling(load, locked ? POLL_RUNNING_MS : POLL_IDLE_MS);

  /* Das Ende eines Laufs melden, den diese Seite hat laufen sehen. */
  const watchedRun = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const watched = watchedRun.current;
    const active = data.runs.find((run) => run.status === 'running') ?? null;
    if (watched && watched !== active?.$id) {
      const finished = data.runs.find((run) => run.$id === watched);
      if (finished?.status === 'error') {
        notify({
          variant: 'error',
          title: t('Sicherung fehlgeschlagen'),
          message: finished.error ? t(finished.error) : t('Die Schritte stehen in der Historie.'),
        });
      } else if (finished?.status === 'success') {
        notify({
          variant: 'success',
          title: t('Sicherung geschrieben'),
          message: `${finished.hostPath}/${finished.fileName}`,
        });
      }
    }
    watchedRun.current = active?.$id ?? null;
  }, [data, notify, t]);

  async function start() {
    setStarting(true);
    try {
      const res = await apiFetch('/api/backup', { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        notify({ variant: 'error', message: body.error || t('Die Sicherung ließ sich nicht starten.') });
      }
      await load();
    } catch {
      notify({ variant: 'error', message: t('Die Sicherung ließ sich nicht starten.') });
    } finally {
      setStarting(false);
    }
  }

  /** Speichert den Entwurf. Gibt den neuen Stand zurück, oder `null`, wenn es nicht ging. */
  async function persist(): Promise<BackupData | null> {
    if (!draft) return data;
    setFormError('');
    setSaving(true);
    try {
      const res = await apiFetch('/api/backup', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: draft.enabled,
          hostPath: draft.hostPath.trim() || null,
          time: draft.time,
          keep: Number(draft.keep),
        }),
      });
      const body = await res.json();
      if (!body.success) {
        setFormError(body.error || t('Die Einstellungen ließen sich nicht speichern.'));
        return null;
      }
      const next = body.data as BackupData;
      setData(next);
      setDraft(null);
      return next;
    } catch {
      setFormError(t('Die Einstellungen ließen sich nicht speichern.'));
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    const next = await persist();
    if (!next) return;
    notify({
      variant: 'success',
      message:
        next.settings.enabled && next.settings.hostPath
          ? t('Gesichert wird täglich um {time} Uhr nach {path}.', {
              time: next.settings.time,
              path: next.settings.hostPath,
            })
          : t('Gespeichert. Täglich gesichert wird nicht. Von Hand geht es mit „Jetzt sichern".'),
    });
  }

  /** Der Knopf im Formular: ein geänderter Ordner gilt schon für diesen Lauf. */
  async function saveAndStart() {
    const next = await persist();
    if (!next) return;
    if (!next.settings.hostPath) {
      setFormError(t('Bitte zuerst einen Ordner auf dem Server eintragen.'));
      return;
    }
    await start();
  }

  function toggleRun(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const canStart = Boolean(data?.available && data.settings.hostPath) && !locked;

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">{t('Sicherung')}</h1>
        <p className="page-subtitle">
          {t('Datenbank, Schlüssel, Konfiguration und Zertifikate als Archiv in einem Ordner auf dem Server.')}
        </p>
      </div>
      <div className="page-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void start()}
          disabled={!canStart}
          data-tooltip={data && !data.settings.hostPath ? t('Erst einen Ordner eintragen und speichern.') : undefined}
          data-tooltip-pos="left"
        >
          {locked ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Archive size={16} strokeWidth={1.5} />}
          {t('Jetzt sichern')}
        </button>
      </div>
    </div>
  );

  if (!data) {
    return (
      <>
        {header}
        {error ? (
          <div className="alert alert-danger sys-block">{error}</div>
        ) : (
          <>
            <div className="sys-block">
              <SkeletonDetail />
            </div>
            <SkeletonRows count={3} />
          </>
        )}
      </>
    );
  }

  const form = draft ?? formFrom(data.settings);
  const edit = (patch: Partial<FormState>) => setDraft({ ...form, ...patch });
  const activeRun = data.runs.find((run) => run.status === 'running') ?? null;
  /** Der Lauf, aus dem die Liste der Dateien stammt. Sein Ordner kann ein früherer sein. */
  const listedRun = data.files ? data.runs.find((run) => run.files.length > 0) : undefined;

  return (
    <>
      {header}

      {!data.available && (
        <div className="alert alert-warning sys-block">
          <AlertTriangle size={16} strokeWidth={1.5} />
          <span>{t('Die Sicherung braucht Docker. HAPM läuft gerade nicht in einem Container.')}</span>
        </div>
      )}

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {activeRun && (
        <div className="card sys-block">
          <div className="card-header">
            <div>
              <h2 className="card-title">
                <Loader2 size={16} strokeWidth={1.5} className="spin" />
                {t('Sicherung läuft')}
              </h2>
              <p className="card-subtitle">
                {t('Ziel: {path}.', { path: activeRun.hostPath })}{' '}
                {t('Der Lauf geht weiter, auch wenn diese Seite geschlossen wird.')}
              </p>
            </div>
            <span className="run-timer">{runDuration(activeRun, now)}</span>
          </div>
          <RunSteps run={activeRun} />
        </div>
      )}

      <AreaTabs areas={AREAS} value={area} onChange={selectArea} dirty={(key) => key === 'einstellungen' && draft !== null} />

      {area === 'einstellungen' && (
        <>
          <div className="card sys-block">
            <div className="card-header">
              <h2 className="card-title">
                <FolderClock size={17} strokeWidth={1.5} />
                {t('Wohin und wann')}
              </h2>
            </div>

            <form className="card-body" onSubmit={save}>
              {formError && <div className="alert alert-danger">{formError}</div>}

              <div className="form-group">
                <label className="form-label" htmlFor="backup-path">
                  {t('Ordner auf dem Server')}
                  <InfoHint
                    text={t('Ein eingebundenes Netzlaufwerk geht genauso, wenn es auf dem Server unter diesem Pfad liegt.')}
                  />
                </label>
                <input
                  id="backup-path"
                  className="form-input"
                  type="text"
                  placeholder="/srv/hapm-backup"
                  value={form.hostPath}
                  disabled={saving}
                  onChange={(event) => edit({ hostPath: event.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="form-hint">{t('Liegt auf dem Server, nicht im Container. Fehlt er, wird er angelegt.')}</p>
              </div>

              <div className="hapm-auto">
                <label className="form-subsection hapm-auto-switch">
                  <div className="form-subsection-head">
                    <div>
                      <div className="form-section-title">{t('Täglich sichern')}</div>
                      <div className="form-section-sub">{t('Einmal am Tag zur eingestellten Uhrzeit.')}</div>
                    </div>
                    <span className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={form.enabled}
                        disabled={saving}
                        onChange={(event) => edit({ enabled: event.target.checked })}
                      />
                      <span className="toggle-slider" />
                    </span>
                  </div>
                </label>
                <div className="form-group hapm-auto-time">
                  <label className="form-label" htmlFor="backup-time">
                    {t('Uhrzeit')}
                    <InfoHint
                      text={t(
                        'Es gilt die Zeitzone des Containers, gesetzt über die Variable TZ. Gesichert wird einmal am Tag zu dieser Minute.'
                      )}
                    />
                  </label>
                  <input
                    id="backup-time"
                    type="time"
                    className="form-input"
                    required
                    value={form.time}
                    disabled={saving || !form.enabled}
                    onChange={(event) => edit({ time: event.target.value })}
                  />
                </div>
                <div className="form-group hapm-auto-keep">
                  <label className="form-label" htmlFor="backup-keep">
                    {t('Aufbewahren')}
                  </label>
                  <input
                    id="backup-keep"
                    type="number"
                    className="form-input"
                    required
                    min={KEEP_MIN}
                    max={KEEP_MAX}
                    value={form.keep}
                    disabled={saving}
                    onChange={(event) => edit({ keep: readKeepField(event.target.value, form.keep) })}
                  />
                  <p className="form-hint">{t('Anzahl Sicherungen. Ältere löscht der nächste Lauf.')}</p>
                </div>
              </div>

              <div className="hapm-form-actions">
                <button className="btn btn-primary" type="submit" disabled={saving || !draft}>
                  {saving ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Save size={16} strokeWidth={1.5} />}
                  {t('Speichern')}
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  disabled={saving || locked || !data.available || !form.hostPath.trim()}
                  onClick={() => void saveAndStart()}
                >
                  <Archive size={16} strokeWidth={1.5} />
                  {draft ? t('Speichern und jetzt sichern') : t('Jetzt sichern')}
                </button>
              </div>
              <p className="form-hint">
                {t('Eine Sicherung von Hand braucht nur den Ordner. Der Schalter „Täglich sichern“ kann aus bleiben.')}
              </p>
            </form>
          </div>

          <div className="card sys-block">
            <div className="card-header">
              <h2 className="card-title">
                <ListChecks size={17} strokeWidth={1.5} />
                {t('Was gesichert wird')}
              </h2>
            </div>

            <div className="card-body">
              <dl className="detail-grid">
                <dt>{t('Datenbank')}</dt>
                <dd>{t('Die Datenbank von HAPM: Konten, Einstellungen, Historie.')}</dd>
                <dt>{t('Schlüssel')}</dt>
                <dd>
                  {rich('{file}, der Schlüssel zu den verschlüsselten Einstellungen.', {
                    file: <code>secrets.json</code>,
                  })}
                </dd>
                <dt>HAProxy</dt>
                <dd>{rich('{path}: Konfiguration, Zertifikate, Fehlerseiten.', { path: <code>/etc/haproxy</code> })}</dd>
                <dt>acme.sh</dt>
                <dd>{t('acme.sh mit Konto und Erneuerungseinträgen.')}</dd>
                <dt>{t('Nicht gesichert')}</dt>
                <dd className="muted">{t('Das Zugriffsprotokoll und die Abbilder.')}</dd>
              </dl>

              <div className="alert alert-warning">
                <AlertTriangle size={16} strokeWidth={1.5} />
                <span>
                  {t(
                    'Das Archiv enthält private Schlüssel und den Schlüssel zu den verschlüsselten Einstellungen. Es ist nicht verschlüsselt. Der Ordner gehört an einen Ort, an den nur Sie kommen.'
                  )}
                </span>
              </div>

            </div>
          </div>
        </>
      )}

      {/* Bleibt auf jedem Reiter eingehängt: während des Zurückspielens wartet die
          Karte auf den Neustart von HAPM und lädt danach die Seite neu. */}
      <div hidden={area !== 'zurueckspielen'}>
        <RestorePanel
          files={data.files}
          filesAsOf={data.filesAsOf}
          listedPath={listedRun?.hostPath ?? null}
          hostPath={data.settings.hostPath}
        />
      </div>

      {area === 'historie' && (
        <>
          <div className="section-header">
            <h2 className="section-title">
              {t('Historie')}
              <span className="section-count">{data.runs.length}</span>
            </h2>
            <span className="section-hint">{t('Die letzten Läufe, der neueste zuerst.')}</span>
          </div>

          {data.runs.length === 0 ? (
            <div className="empty-state">
              <Archive size={32} strokeWidth={1.5} />
              <h3>{t('Noch kein Lauf')}</h3>
              <p>{t('Hier steht jeder Lauf mit seinen Schritten, auch die nach Zeitplan.')}</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('Beginn')}</th>
                    <th>{t('Ergebnis')}</th>
                    <th>{t('Datei')}</th>
                    <th className="sys-th-num">{t('Größe')}</th>
                    <th>{t('Dauer')}</th>
                    <th>{t('Ausgelöst von')}</th>
                    <th aria-label={t('Schritte')} />
                  </tr>
                </thead>
                <tbody>
                  {data.runs.map((run) => {
                    const open = expanded.has(run.$id);
                    return (
                      <Fragment key={run.$id}>
                        <tr>
                          <td data-label="primary">
                            <strong>{formatDateTime(locale, run.startedAt)}</strong>
                          </td>
                          <td data-label={t('Ergebnis')}>
                            <span className={`badge-status ${RUN_STATUS_CLASS[run.status] ?? 'badge-neutral'}`}>
                              {run.status === 'running' && <Loader2 size={12} strokeWidth={1.5} className="spin" />}
                              {RUN_STATUS_LABELS[run.status] ? t(RUN_STATUS_LABELS[run.status]) : run.status}
                            </span>
                            {run.error && <div className="detail-error">{t(run.error)}</div>}
                          </td>
                          <td data-label={t('Datei')}>
                            {run.status === 'success' && run.fileName ? (
                              <span className="ranking-mono">{run.fileName}</span>
                            ) : run.status === 'running' ? (
                              <span className="hapm-muted">{t('Wird geschrieben')}</span>
                            ) : (
                              <span className="hapm-muted">{t('Keine')}</span>
                            )}
                          </td>
                          <td data-label={t('Größe')} className="sys-td-num">
                            {run.sizeBytes !== null && <span className="sys-num">{formatBytes(locale, run.sizeBytes)}</span>}
                          </td>
                          <td data-label={t('Dauer')}>
                            <span className="sys-num">{runDuration(run, now)}</span>
                          </td>
                          <td data-label={t('Ausgelöst von')}>{triggeredByLabel(run.triggeredBy, t)}</td>
                          <td data-label="actions">
                            <div className="actions hapm-actions-end">
                              <button
                                type="button"
                                className="btn btn-ghost btn-icon btn-sm"
                                data-tooltip={open ? t('Schritte ausblenden') : t('Schritte anzeigen')}
                                data-tooltip-pos="left"
                                aria-label={open ? t('Schritte ausblenden') : t('Schritte anzeigen')}
                                aria-expanded={open}
                                onClick={() => toggleRun(run.$id)}
                              >
                                {open ? (
                                  <ChevronDown size={16} strokeWidth={1.5} />
                                ) : (
                                  <ChevronRight size={16} strokeWidth={1.5} />
                                )}
                              </button>
                            </div>
                          </td>
                        </tr>
                        {open && (
                          <tr className="hapm-run-detail">
                            <td colSpan={7}>
                              <RunSteps run={run} />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </>
  );
}
