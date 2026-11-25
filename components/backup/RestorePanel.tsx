'use client';

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Eye,
  Loader2,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useConfirm } from '@/components/ConfirmDialog';
import { usePolling } from '@/components/usePolling';
import { useMountedLoad } from '@/components/useMountedLoad';
import { SkeletonDetail } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import RunStepList from '@/components/runs/RunStepList';
import { openRun, startRun, subscribeRunFinished } from '@/components/runs/runs';
import { formatBytes, formatDateTime, type Locale } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
// Nur Typen: die Dateien dahinter erreichen `lib/db` und `lib/docker`.
import type { RestoreOverview } from '@/lib/backup/restore';
import type { BackupFile } from '@/lib/backup/run';
import type { HaproxyStep } from '@/lib/types';

type RestoreRunView = RestoreOverview['runs'][number];
type Staged = NonNullable<RestoreOverview['staged']>;

const POLL_IDLE_MS = 30_000;
const POLL_RUNNING_MS = 2000;

/**
 * Ein Zeitpunkt ohne Zone (`JJJJ-MM-TTTHH:MM:SS`, aus einem Dateinamen) in der
 * Uhrzeit des Browsers gebaut und so wieder ausgegeben, damit er zum Namen
 * daneben passt.
 */
function localTime(value: string | null, locale: Locale): string {
  const match = value ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value) : null;
  if (!match) return formatDateTime(locale, null);
  const [, year, month, day, hour, minute] = match.map(Number);
  return formatDateTime(locale, new Date(year, month - 1, day, hour, minute));
}

function archiveTime(createdAt: string | null, createdLocal: string | null, locale: Locale): string {
  return createdAt ? formatDateTime(locale, createdAt) : localTime(createdLocal, locale);
}

/** `hapm-backup-20261124-023000(-vor-ruecksicherung).tar.gz` */
function fileLocal(name: string): string | null {
  const match = /^hapm-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}`;
}

function LastRun({ run }: { run: RestoreRunView }) {
  const { t, locale } = useT();
  const [open, setOpen] = useState(false);
  const steps = JSON.parse(run.steps || '[]') as HaproxyStep[];
  const variant = run.status === 'success' ? 'alert-success' : run.status === 'warning' ? 'alert-warning' : 'alert-danger';
  return (
    <div className={`alert ${variant} hapm-flag`}>
      {run.status === 'success' ? <Check size={16} strokeWidth={1.5} /> : <AlertTriangle size={16} strokeWidth={1.5} />}
      <div className="hapm-flag-body">
        <strong>
          {run.status === 'error'
            ? t('Zurückspielen fehlgeschlagen: {name}', { name: run.fileName })
            : t('Zurückgespielt: {name}', { name: run.fileName })}
        </strong>
        <span>
          {t('Begonnen am {date} von {user}.', { date: formatDateTime(locale, run.startedAt), user: run.triggeredBy })}
        </span>
        {run.error && <span>{t(run.error)}</span>}
        {(run.beforeBackupHost || run.beforeBackup) && (
          <span>
            {t('Der Stand von vorher liegt in {path}.', { path: run.beforeBackupHost ?? run.beforeBackup ?? '' })}
          </span>
        )}
      </div>
      <div className="hapm-flag-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}
          {open ? t('Schritte ausblenden') : t('Schritte anzeigen')}
        </button>
      </div>
      {open && (
        <div className="hapm-flag-detail">
          <RunStepList steps={steps} />
        </div>
      )}
    </div>
  );
}

interface Props {
  /** Die Archive im Ordner, wie die Sicherung sie zuletzt gesehen hat. `null` vor dem ersten Lauf. */
  files: BackupFile[] | null;
  filesAsOf: string | null;
  /** Der Ordner, aus dem die Liste stammt. Er kann ein früherer sein. */
  listedPath: string | null;
  hostPath: string | null;
}

/**
 * Die Karte „Sicherung zurückspielen" auf der Seite „Sicherung". Der Ablauf
 * steht in `lib/backup/restore.ts`. Der laufende Vorgang steht im Fenster der
 * Läufe (`components/runs/`): dort wartet er auch auf den Neustart von HAPM und
 * lädt danach die Seite neu. Ohne Sitzung führt das Neuladen zur Anmeldung.
 */
export default function RestorePanel({ files, filesAsOf, listedPath, hostPath }: Props) {
  const { apiFetch } = useApp();
  const confirm = useConfirm();
  const { t, locale } = useT();

  const [data, setData] = useState<RestoreOverview | null>(null);
  const [offline, setOffline] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [formError, setFormError] = useState('');
  const [password, setPassword] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/backup/restore', { cache: 'no-store' });
      const body = await res.json();
      if (body.success) {
        setData(body.data as RestoreOverview);
        setOffline(false);
      }
    } catch {
      setOffline(true);
    }
  }, [apiFetch]);

  useMountedLoad(load);

  const active = data?.active ?? null;
  const running = Boolean(active && !active.done);
  usePolling(load, running || offline || busy === 'start' ? POLL_RUNNING_MS : POLL_IDLE_MS);

  useEffect(
    () =>
      subscribeRunFinished((run) => {
        if (run.kind === 'restore') void load();
      }),
    [load]
  );

  /** Gibt bei Erfolg `data` der Antwort zurück, sonst `null`. */
  async function send(url: string, init: RequestInit, label: string): Promise<{ data: unknown } | null> {
    setFormError('');
    setBusy(label);
    try {
      const res = await apiFetch(url, init);
      const body = await res.json();
      if (!body.success) {
        setFormError(body.error || t('Das hat nicht geklappt.'));
        return null;
      }
      if (body.data && 'staged' in body.data) setData(body.data as RestoreOverview);
      return { data: body.data };
    } catch {
      setFormError(t('HAPM hat nicht geantwortet. Bitte versuchen Sie es erneut.'));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function checkFromFolder(name: string) {
    setPassword('');
    await send(
      '/api/backup/restore/check',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) },
      `check:${name}`
    );
  }

  async function upload(file: File) {
    if (fileInput.current) fileInput.current.value = '';
    setPassword('');
    if (data && file.size > data.maxBytes) {
      setFormError(t('Das Archiv ist größer als {max}. So groß wird eine Sicherung von HAPM nicht.', { max: '512 MB' }));
      return;
    }
    await send(
      `/api/backup/restore/upload?name=${encodeURIComponent(file.name)}`,
      // Roh und gestreamt: die Datei, nicht ihr Inhalt im Speicher der Seite.
      { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body: file },
      'upload'
    );
  }

  async function discard() {
    setPassword('');
    await send('/api/backup/restore', { method: 'DELETE' }, 'discard');
  }

  async function start(event: FormEvent, staged: Staged) {
    event.preventDefault();
    if (!data) return;
    const where =
      data.beforeTarget.kind === 'folder'
        ? t('Vorher sichert HAPM den aktuellen Stand in den Ordner {path}. Diese Sicherung räumt die Aufbewahrung nicht weg.', {
            path: data.beforeTarget.path,
          })
        : t('Vorher sichert HAPM den aktuellen Stand nach {path}. Eine frühere Datei dort wird ersetzt.', {
            path: data.beforeTarget.path,
          });
    const confirmed = await confirm({
      title: t('Sicherung zurückspielen?'),
      message: `${t(
        'Konten, Einstellungen, Ziele, Zertifikate und die Konfiguration von HAProxy werden durch den Stand der Sicherung ersetzt. Alle Sitzungen enden, danach melden Sie sich mit einem Konto aus der Sicherung an. HAPM startet dafür kurz neu.'
      )} ${where}`,
      confirmLabel: t('Zurückspielen'),
      variant: 'warning',
      requireText: t('ZURÜCKSPIELEN'),
    });
    if (!confirmed) return;

    const started = await send(
      '/api/backup/restore/start',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: staged.id, password }),
      },
      'start'
    );
    if (started) {
      setPassword('');
      startRun({ kind: 'restore', id: (started.data as { runId: string }).runId });
      await load();
    }
  }

  const header = (
    <div className="card-header">
      <div>
        <h2 className="card-title">
          <RotateCcw size={17} strokeWidth={1.5} />
          {t('Sicherung zurückspielen')}
        </h2>
        <p className="card-subtitle">
          {t('Ein Archiv aus dem Ordner oder hochgeladen, etwa beim Umzug von einem anderen Server.')}
        </p>
      </div>
    </div>
  );

  if (!data) {
    return (
      <div className="card sys-block">
        {header}
        <div className="card-body">
          {offline ? (
            <div className="alert alert-warning">
              <AlertTriangle size={16} strokeWidth={1.5} />
              <span>{t('HAPM antwortet gerade nicht. Die Seite versucht es weiter.')}</span>
            </div>
          ) : (
            <SkeletonDetail />
          )}
        </div>
      </div>
    );
  }

  const staged = data.staged;
  const locked = running || busy !== null || data.busy || !data.available;
  const lastRun = data.runs[0] ?? null;

  return (
    <div className="card sys-block">
      {header}
      <div className="card-body">
        {!data.available && (
          <div className="alert alert-warning">
            <AlertTriangle size={16} strokeWidth={1.5} />
            <span>{t('Das Zurückspielen braucht Docker. HAPM läuft gerade nicht in einem Container.')}</span>
          </div>
        )}

        {active && running && (
          <div className="hapm-inline-actions">
            <span className="form-hint">
              {t('Gerade wird {name} zurückgespielt. Der Fortschritt steht im Fenster des Laufs.', {
                name: active.archive.name,
              })}
            </span>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              onClick={() => openRun({ kind: 'restore', id: active.runId })}
            >
              <Eye size={14} strokeWidth={1.5} />
              {t('Fortschritt ansehen')}
            </button>
          </div>
        )}

        {!running && lastRun && <LastRun run={lastRun} />}

        {formError && <div className="alert alert-danger">{formError}</div>}

        {!running && staged && (
          <form onSubmit={(event) => void start(event, staged)} className="card-body">
            <div className="form-section-title">{t('Geprüft: {name}', { name: staged.name })}</div>
            <dl className="detail-grid">
              <dt>{t('Quelle')}</dt>
              <dd>{staged.source === 'folder' ? t('Aus dem Ordner {path}', { path: hostPath ?? '' }) : t('Hochgeladen')}</dd>
              <dt>{t('Gesichert am')}</dt>
              <dd>{archiveTime(staged.check.createdAt, staged.check.createdLocal, locale)}</dd>
              <dt>{t('Fassung von HAPM')}</dt>
              <dd>
                {staged.check.version ?? (
                  <span className="hapm-muted">
                    {staged.check.manifest ? t('Unbekannt') : t('Unbekannt. Ältere Sicherungen nennen ihre Fassung nicht.')}
                  </span>
                )}
              </dd>
              <dt>{t('Größe')}</dt>
              <dd>{formatBytes(locale, staged.sizeBytes)}</dd>
              <dt>{t('Enthalten')}</dt>
              <dd>
                {t('Datenbank ({size}), Schlüssel, HAProxy mit {files} Dateien und {certs} Zertifikaten, acme.sh mit {acme} Dateien.', {
                  size: formatBytes(locale, staged.check.contents.databaseBytes),
                  files: staged.check.contents.haproxyFiles,
                  certs: staged.check.contents.certificates,
                  acme: staged.check.contents.acmeFiles,
                })}
              </dd>
            </dl>

            {staged.check.warnings.map((warning) => (
              <div key={warning.text} className="alert alert-warning">
                <AlertTriangle size={16} strokeWidth={1.5} />
                <span>{t(warning)}</span>
              </div>
            ))}

            {staged.check.blockers.length > 0 ? (
              <div className="alert alert-danger">
                <AlertTriangle size={16} strokeWidth={1.5} />
                <span>{staged.check.blockers.map((blocker) => t(blocker)).join(' ')}</span>
              </div>
            ) : (
              <>
                <div className="alert alert-warning">
                  <AlertTriangle size={16} strokeWidth={1.5} />
                  <span>
                    {t(
                      'Konten, Einstellungen, Ziele, Zertifikate und die Konfiguration von HAProxy werden durch den Stand der Sicherung ersetzt. Alle Sitzungen enden, danach melden Sie sich mit einem Konto aus der Sicherung an. HAPM startet dafür kurz neu.'
                    )}{' '}
                    {data.beforeTarget.kind === 'folder'
                      ? t('Vorher sichert HAPM den aktuellen Stand in den Ordner {path}. Diese Sicherung räumt die Aufbewahrung nicht weg.', {
                          path: data.beforeTarget.path,
                        })
                      : t('Vorher sichert HAPM den aktuellen Stand nach {path}. Eine frühere Datei dort wird ersetzt.', {
                          path: data.beforeTarget.path,
                        })}{' '}
                    {t('Scheitert diese Sicherung, wird nichts zurückgespielt.')}
                  </span>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="restore-password">
                    {t('Ihr Passwort')}
                  </label>
                  <input
                    id="restore-password"
                    className="form-input"
                    type="password"
                    required
                    value={password}
                    disabled={locked}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                  />
                </div>
              </>
            )}

            <div className="hapm-form-actions">
              {staged.check.blockers.length === 0 && (
                <button className="btn btn-danger" type="submit" disabled={locked || !password}>
                  {busy === 'start' ? (
                    <Loader2 size={16} strokeWidth={1.5} className="spin" />
                  ) : (
                    <RotateCcw size={16} strokeWidth={1.5} />
                  )}
                  {t('Zurückspielen')}
                </button>
              )}
              <button className="btn btn-secondary" type="button" disabled={locked} onClick={() => void discard()}>
                {busy === 'discard' ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Trash2 size={16} strokeWidth={1.5} />}
                {t('Verwerfen')}
              </button>
            </div>
          </form>
        )}

        {!running && !staged && (
          <>
            <div>
              <div className="form-section-title">
                {t('Im Ordner')}
                {files && <span className="section-count">{files.length}</span>}
              </div>
              {files && (
                <span className="form-hint">
                  {t('Stand nach dem letzten Lauf')}
                  {filesAsOf ? ` ${t('vom {date}', { date: formatDateTime(locale, filesAsOf) })}` : ''}
                  {listedPath ? ` ${t('in {path}', { path: listedPath })}` : ''}.
                  <InfoHint
                    text={t(
                      'HAPM liest den Ordner nicht laufend. Die Liste stammt aus dem letzten Lauf. Was danach von Hand gelöscht oder dazugelegt wurde, steht hier nicht.'
                    )}
                  />
                </span>
              )}
            </div>
            {files && files.length > 0 ? (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('Name')}</th>
                      <th>{t('Zeitpunkt')}</th>
                      <th className="sys-th-num">{t('Größe')}</th>
                      <th aria-label={t('Zurückspielen')} />
                    </tr>
                  </thead>
                  <tbody>
                    {files.map((file) => (
                      <tr key={file.name}>
                        <td data-label="primary">
                          <span className="ranking-mono">{file.name}</span>
                        </td>
                        <td data-label={t('Zeitpunkt')}>{localTime(fileLocal(file.name), locale)}</td>
                        <td data-label={t('Größe')} className="sys-td-num">
                          <span className="sys-num">{formatBytes(locale, file.sizeBytes)}</span>
                        </td>
                        <td data-label="actions">
                          <div className="actions hapm-actions-end">
                            <button
                              type="button"
                              className="btn btn-secondary btn-sm"
                              disabled={locked || !hostPath || listedPath !== hostPath}
                              data-tooltip={
                                hostPath && listedPath !== hostPath
                                  ? t('Die Liste stammt aus einem früheren Ordner.')
                                  : undefined
                              }
                              data-tooltip-pos="left"
                              onClick={() => void checkFromFolder(file.name)}
                            >
                              {busy === `check:${file.name}` ? (
                                <Loader2 size={14} strokeWidth={1.5} className="spin" />
                              ) : (
                                <RotateCcw size={14} strokeWidth={1.5} />
                              )}
                              {t('Zurückspielen')}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-state">
                <Archive size={32} strokeWidth={1.5} />
                <h3>{files === null ? t('Noch keine Sicherung geschrieben') : t('Keine Sicherung im Ordner')}</h3>
                <p>
                  {files === null
                    ? t('Nach dem ersten erfolgreichen Lauf steht hier, was im Ordner liegt.')
                    : t('Nach dem letzten Lauf lag dort kein Archiv.')}{' '}
                  {t('Ein Archiv lässt sich auch hochladen, etwa von einem anderen Server.')}
                </p>
              </div>
            )}

            <input
              ref={fileInput}
              type="file"
              accept=".gz,.tgz,application/gzip"
              style={{ display: 'none' }}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
              }}
            />
            <div className="hapm-form-actions">
              <button
                type="button"
                className="btn btn-secondary"
                disabled={locked}
                onClick={() => fileInput.current?.click()}
              >
                {busy === 'upload' ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Upload size={16} strokeWidth={1.5} />}
                {t('Archiv hochladen')}
              </button>
              <span className="form-hint">{t('Ein Archiv von HAPM (.tar.gz), höchstens 512 MB. Es wird vor allem anderen geprüft.')}</span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
