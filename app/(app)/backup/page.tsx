'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FolderClock,
  Info,
  ListChecks,
  Loader2,
  Save,
  X,
} from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import { SkeletonDetail, SkeletonRows } from '@/components/Skeleton';
import { RUN_STATUS_CLASS, RUN_STATUS_LABELS, formatClock, formatDateTime } from '@/components/system/format';
import { fmtBytes } from '@/app/(app)/reverse-proxy/statistiken/format';
// Nur Typen: die Dateien dahinter erreichen `lib/db` und `lib/docker`.
import type { BackupOverview, BackupRunForClient } from '@/app/api/backup/route';
import type { BackupFile } from '@/lib/backup/run';
import type { HaproxyStep } from '@/lib/types';

type RunView = Omit<BackupRunForClient, 'steps'> & { steps: HaproxyStep[] };
type BackupData = Omit<BackupOverview, 'runs'> & { runs: RunView[] };

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
  'Datenbank herausschreiben',
  'Schlüssel dazulegen',
  'Archiv schreiben',
  'Alte Sicherungen aufräumen',
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

/**
 * Der Zeitpunkt aus dem Dateinamen. Er steht dort in der Uhrzeit des
 * Containers und wird nicht umgerechnet, damit er zum Namen daneben passt.
 */
function fileTime(name: string): string {
  const match = /^hapm-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\d{2}\.tar\.gz$/.exec(name);
  if (!match) return 'Unbekannt';
  const [, year, month, day, hour, minute] = match;
  return `${day}.${month}.${year}, ${hour}:${minute}`;
}

function triggeredByLabel(value: string | null): string {
  if (!value) return '';
  return value === 'scheduler' ? 'Zeitplan' : value;
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
  const pending = pendingSteps(run);
  if (run.steps.length === 0 && pending.length === 0) {
    return <p className="form-hint">Zu diesem Lauf sind keine Schritte festgehalten.</p>;
  }
  return (
    <ul className="hapm-steps">
      {run.steps.map((step, index) => (
        <li key={`${index}-${step.label}`} className={`hapm-step ${step.ok ? 'is-ok' : 'is-failed'}`}>
          {step.ok ? <Check size={14} strokeWidth={1.5} /> : <X size={14} strokeWidth={1.5} />}
          <span className="hapm-step-text">
            <span className="hapm-step-label">{step.label}</span>
            {step.detail && <span className="hapm-step-detail">{step.detail}</span>}
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
            <span className="hapm-step-label">{label}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function FileTable({ files }: { files: BackupFile[] }) {
  return (
    <div className="table-wrap sys-block">
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Zeitpunkt</th>
            <th className="sys-th-num">Größe</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file) => (
            <tr key={file.name}>
              <td data-label="primary">
                <span className="ranking-mono">{file.name}</span>
              </td>
              <td data-label="Zeitpunkt">{fileTime(file.name)}</td>
              <td data-label="Größe" className="sys-td-num">
                <span className="sys-num">{fmtBytes(file.sizeBytes)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function BackupPage() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
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
        setError(body.error || 'Die Sicherung konnte nicht geladen werden.');
      }
    } catch {
      setError('Die Sicherung konnte nicht geladen werden.');
    }
  }, [apiFetch]);

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
          title: 'Sicherung fehlgeschlagen',
          message: finished.error ?? 'Die Schritte stehen in der Historie.',
        });
      } else if (finished?.status === 'success') {
        notify({
          variant: 'success',
          title: 'Sicherung geschrieben',
          message: `${finished.hostPath}/${finished.fileName}`,
        });
      }
    }
    watchedRun.current = active?.$id ?? null;
  }, [data, notify]);

  async function start() {
    setStarting(true);
    try {
      const res = await apiFetch('/api/backup', { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        notify({ variant: 'error', message: body.error || 'Die Sicherung ließ sich nicht starten.' });
      }
      await load();
    } catch {
      notify({ variant: 'error', message: 'Die Sicherung ließ sich nicht starten.' });
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
        setFormError(body.error || 'Die Einstellungen ließen sich nicht speichern.');
        return null;
      }
      const next = body.data as BackupData;
      setData(next);
      setDraft(null);
      return next;
    } catch {
      setFormError('Die Einstellungen ließen sich nicht speichern.');
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
          ? `Gesichert wird täglich um ${next.settings.time} Uhr nach ${next.settings.hostPath}.`
          : 'Gespeichert. Täglich gesichert wird nicht. Von Hand geht es mit „Jetzt sichern".',
    });
  }

  /** Der Knopf im Formular: ein geänderter Ordner gilt schon für diesen Lauf. */
  async function saveAndStart() {
    const next = await persist();
    if (!next) return;
    if (!next.settings.hostPath) {
      setFormError('Bitte zuerst einen Ordner auf dem Server eintragen.');
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
        <h1 className="page-title">Sicherung</h1>
        <p className="page-subtitle">
          Datenbank, Schlüssel, Konfiguration und Zertifikate als Archiv in einem Ordner auf dem Server.
        </p>
      </div>
      <div className="page-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void start()}
          disabled={!canStart}
          data-tooltip={data && !data.settings.hostPath ? 'Erst einen Ordner eintragen und speichern.' : undefined}
          data-tooltip-pos="left"
        >
          {locked ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Archive size={16} strokeWidth={1.5} />}
          Jetzt sichern
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
          <span>Die Sicherung braucht Docker. HAPM läuft gerade nicht in einem Container.</span>
        </div>
      )}

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {activeRun && (
        <div className="card sys-block">
          <div className="card-header">
            <div>
              <h2 className="card-title">
                <Loader2 size={16} strokeWidth={1.5} className="spin" />
                Sicherung läuft
              </h2>
              <p className="card-subtitle">
                Ziel: {activeRun.hostPath}. Der Lauf geht weiter, auch wenn diese Seite geschlossen wird.
              </p>
            </div>
            <span className="run-timer">{runDuration(activeRun, now)}</span>
          </div>
          <RunSteps run={activeRun} />
        </div>
      )}

      <div className="card sys-block">
        <div className="card-header">
          <h2 className="card-title">
            <FolderClock size={17} strokeWidth={1.5} />
            Wohin und wann
          </h2>
        </div>

        <form className="card-body" onSubmit={save}>
          {formError && <div className="alert alert-danger">{formError}</div>}

          <div className="form-group">
            <label className="form-label" htmlFor="backup-path">
              Ordner auf dem Server
              <InfoHint text="Ein eingebundenes Netzlaufwerk geht genauso, wenn es auf dem Server unter diesem Pfad liegt." />
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
            <p className="form-hint">Liegt auf dem Server, nicht im Container. Fehlt er, wird er angelegt.</p>
          </div>

          <div className="hapm-auto">
            <label className="form-subsection hapm-auto-switch">
              <div className="form-subsection-head">
                <div>
                  <div className="form-section-title">Täglich sichern</div>
                  <div className="form-section-sub">Einmal am Tag zur eingestellten Uhrzeit.</div>
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
                Uhrzeit
                <InfoHint text="Es gilt die Zeitzone des Containers, gesetzt über die Variable TZ. Gesichert wird einmal am Tag zu dieser Minute." />
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
                Aufbewahren
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
              <p className="form-hint">Anzahl Sicherungen. Ältere löscht der nächste Lauf.</p>
            </div>
          </div>

          <div className="hapm-form-actions">
            <button className="btn btn-primary" type="submit" disabled={saving || !draft}>
              {saving ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Save size={16} strokeWidth={1.5} />}
              Speichern
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              disabled={saving || locked || !data.available || !form.hostPath.trim()}
              onClick={() => void saveAndStart()}
            >
              <Archive size={16} strokeWidth={1.5} />
              {draft ? 'Speichern und jetzt sichern' : 'Jetzt sichern'}
            </button>
          </div>
          <p className="form-hint">
            Eine Sicherung von Hand braucht nur den Ordner. Der Schalter „Täglich sichern“ kann aus bleiben.
          </p>
        </form>
      </div>

      <div className="card sys-block">
        <div className="card-header">
          <h2 className="card-title">
            <ListChecks size={17} strokeWidth={1.5} />
            Was gesichert wird
          </h2>
        </div>

        <div className="card-body">
          <dl className="detail-grid">
            <dt>Datenbank</dt>
            <dd>Die Datenbank von HAPM: Konten, Einstellungen, Historie.</dd>
            <dt>Schlüssel</dt>
            <dd>
              <code>secrets.json</code>, der Schlüssel zu den verschlüsselten Einstellungen.
            </dd>
            <dt>HAProxy</dt>
            <dd>
              <code>/etc/haproxy</code>: Konfiguration, Zertifikate, Fehlerseiten.
            </dd>
            <dt>acme.sh</dt>
            <dd>acme.sh mit Konto und Erneuerungseinträgen.</dd>
            <dt>Nicht gesichert</dt>
            <dd className="muted">Das Zugriffsprotokoll und die Abbilder.</dd>
          </dl>

          <div className="alert alert-warning">
            <AlertTriangle size={16} strokeWidth={1.5} />
            <span>
              Das Archiv enthält private Schlüssel und den Schlüssel zu den verschlüsselten Einstellungen. Es ist
              nicht verschlüsselt. Der Ordner gehört an einen Ort, an den nur Sie kommen.
            </span>
          </div>

          <div className="form-note">
            <Info size={14} strokeWidth={1.5} />
            <span>
              HAPM spielt eine Sicherung nicht selbst zurück. Die Schritte stehen in der README des Projekts,
              Abschnitt „Sicherung zurückspielen“.
            </span>
          </div>
        </div>
      </div>

      <div className="section-header">
        <h2 className="section-title">
          Im Ordner
          {data.files && <span className="section-count">{data.files.length}</span>}
        </h2>
        {data.files && (
          <span className="section-hint">
            Stand nach dem letzten Lauf
            {data.filesAsOf ? ` vom ${formatDateTime(data.filesAsOf)}` : ''}
            {listedRun ? ` in ${listedRun.hostPath}` : ''}.
            <InfoHint text="HAPM liest den Ordner nicht laufend. Die Liste stammt aus dem letzten Lauf. Was danach von Hand gelöscht oder dazugelegt wurde, steht hier nicht." />
          </span>
        )}
      </div>

      {data.files === null ? (
        <div className="empty-state sys-block">
          <Archive size={32} strokeWidth={1.5} />
          <h3>Noch keine Sicherung geschrieben</h3>
          <p>Nach dem ersten erfolgreichen Lauf steht hier, was im Ordner liegt.</p>
        </div>
      ) : data.files.length === 0 ? (
        <div className="empty-state sys-block">
          <Archive size={32} strokeWidth={1.5} />
          <h3>Keine Sicherung im Ordner</h3>
          <p>Nach dem letzten Lauf lag dort kein Archiv.</p>
        </div>
      ) : (
        <FileTable files={data.files} />
      )}

      <div className="section-header">
        <h2 className="section-title">
          Historie
          <span className="section-count">{data.runs.length}</span>
        </h2>
        <span className="section-hint">Die letzten Läufe, der neueste zuerst.</span>
      </div>

      {data.runs.length === 0 ? (
        <div className="empty-state">
          <Archive size={32} strokeWidth={1.5} />
          <h3>Noch kein Lauf</h3>
          <p>Hier steht jeder Lauf mit seinen Schritten, auch die nach Zeitplan.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Beginn</th>
                <th>Ergebnis</th>
                <th>Datei</th>
                <th className="sys-th-num">Größe</th>
                <th>Dauer</th>
                <th>Ausgelöst von</th>
                <th aria-label="Schritte" />
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => {
                const open = expanded.has(run.$id);
                return (
                  <Fragment key={run.$id}>
                    <tr>
                      <td data-label="primary">
                        <strong>{formatDateTime(run.startedAt)}</strong>
                      </td>
                      <td data-label="Ergebnis">
                        <span className={`badge-status ${RUN_STATUS_CLASS[run.status] ?? 'badge-neutral'}`}>
                          {run.status === 'running' && <Loader2 size={12} strokeWidth={1.5} className="spin" />}
                          {RUN_STATUS_LABELS[run.status] ?? run.status}
                        </span>
                        {run.error && <div className="detail-error">{run.error}</div>}
                      </td>
                      <td data-label="Datei">
                        {run.status === 'success' && run.fileName ? (
                          <span className="ranking-mono">{run.fileName}</span>
                        ) : run.status === 'running' ? (
                          <span className="hapm-muted">Wird geschrieben</span>
                        ) : (
                          <span className="hapm-muted">Keine</span>
                        )}
                      </td>
                      <td data-label="Größe" className="sys-td-num">
                        {run.sizeBytes !== null && <span className="sys-num">{fmtBytes(run.sizeBytes)}</span>}
                      </td>
                      <td data-label="Dauer">
                        <span className="sys-num">{runDuration(run, now)}</span>
                      </td>
                      <td data-label="Ausgelöst von">{triggeredByLabel(run.triggeredBy)}</td>
                      <td data-label="actions">
                        <div className="actions hapm-actions-end">
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-sm"
                            data-tooltip={open ? 'Schritte ausblenden' : 'Schritte anzeigen'}
                            data-tooltip-pos="left"
                            aria-label={open ? 'Schritte ausblenden' : 'Schritte anzeigen'}
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
  );
}
