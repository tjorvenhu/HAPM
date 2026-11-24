'use client';

import { useCallback, useRef, useState } from 'react';
import { Globe, Upload, Loader2, ExternalLink, RotateCcw, Check, RefreshCw } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { useMountedLoad } from '@/components/useMountedLoad';
import { usePolling } from '@/components/usePolling';
import { SkeletonRows } from '@/components/Skeleton';
import type { GeoipOverview } from '@/lib/geoip/fetch';

/**
 * Die Länder-Tabelle der Statistik: ihr Stand, und dass HAPM sie selbst holt.
 *
 * ── Warum das hier steht und nicht bei den Systemeinstellungen ──
 *
 * Weil es genau eine Sache betrifft: die Länderverteilung auf
 * `/reverse-proxy/statistiken`. Unter „Einstellungen" der Anwendung stünde eine
 * Datei, deren Zweck man von dort aus nicht sieht.
 *
 * ── Warum der Zustand vorn steht und der Upload hinten ──
 *
 * Früher war diese Karte ein Formular: Datei bei DB-IP holen, hier hochladen,
 * jeden Monat. Das unterblieb. Jetzt holt HAPM die Datei selbst
 * (`lib/geoip/fetch.ts`), und die Karte sagt, ob das klappt. Der Upload bleibt
 * für Server, die nicht nach außen dürfen.
 *
 * ── Warum der Stand beim Upload aus dem Dateinamen kommt ──
 *
 * DB-IP liefert `dbip-country-lite-2026-08.csv.gz`, und der Monat darin ist die
 * einzige Stelle, an der steht, von wann der Datensatz ist — in der CSV selbst
 * steht er nicht. Er wird deshalb hier ausgelesen und mitgeschickt, und die
 * Route lehnt ab, was ihn nicht hat. Das Hochladedatum stattdessen zu nehmen
 * wäre die bequeme und falsche Lösung: wer eine ein Jahr alte Datei von heute
 * hochlädt, hätte danach einen grünen Haken ohne Deckung.
 */

const ORIGIN_LABELS: Record<GeoipOverview['origin'], string> = {
  fetched: 'Von db-ip.com geholt',
  uploaded: 'Von Hand hochgeladen',
  bundled: 'Mit HAPM mitgeliefert',
  none: 'Keine',
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

/** Der eine Satz unter dem Titel: was gilt, und ob es sich von selbst erneuert. */
function summary(status: GeoipOverview): string {
  const renewal = status.autoRefresh
    ? 'Wird jeden Monat selbsttätig erneuert.'
    : 'Das selbsttätige Erneuern ist abgeschaltet.';
  if (status.origin === 'none') return `Keine Tabelle vorhanden. ${renewal}`;
  return `Stand ${status.version ?? 'unbekannt'}. ${renewal}`;
}

export default function GeoipPanel() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();

  const [status, setStatus] = useState<GeoipOverview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<'refresh' | 'switch' | 'upload' | 'reset' | null>(null);
  const [formError, setFormError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/geoip');
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setStatus(data.data as GeoipOverview);
      setLoadFailed(false);
    } catch {
      // Nur der erste Fehlschlag wird gezeigt (siehe unten): danach steht der
      // letzte bekannte Zustand da, und der nächste Takt versucht es wieder.
      setLoadFailed(true);
    }
  }, [apiFetch]);

  useMountedLoad(load);
  // Der Scheduler holt nachts. Ein offener Tab soll das am Morgen zeigen.
  usePolling(load, 60_000);

  async function refresh() {
    setBusy('refresh');
    try {
      const res = await apiFetch('/api/geoip/refresh', { method: 'POST' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const next = data.data as GeoipOverview & { changed: boolean };
      setStatus(next);
      notify(
        next.changed
          ? {
              variant: 'success',
              title: `Länder-Tabelle auf Stand ${next.version ?? 'unbekannt'}`,
              message:
                next.v4Count !== null && next.v6Count !== null
                  ? `${next.v4Count.toLocaleString('de-DE')} IPv4- und ` +
                    `${next.v6Count.toLocaleString('de-DE')} IPv6-Bereiche von db-ip.com geholt.`
                  : 'Von db-ip.com geholt.',
            }
          : {
              variant: 'info',
              title: 'Länder-Tabelle ist aktuell',
              message: `Stand ${next.version ?? 'unbekannt'}. Eine neuere Datei gibt es bei DB-IP noch nicht.`,
            }
      );
    } catch (err) {
      notify({
        variant: 'error',
        title: 'Erneuern fehlgeschlagen',
        message: err instanceof Error && err.message ? err.message : 'Unbekannter Fehler.',
      });
      // Der gescheiterte Versuch steht jetzt am Zustand, und der soll dastehen.
      await load();
    } finally {
      setBusy(null);
    }
  }

  async function setAutoRefresh(enabled: boolean) {
    setBusy('switch');
    try {
      const res = await apiFetch('/api/geoip', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoRefresh: enabled }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setStatus(data.data as GeoipOverview);
      notify({
        variant: 'success',
        message: enabled
          ? 'HAPM erneuert die Länder-Tabelle wieder selbst.'
          : 'HAPM lädt die Länder-Tabelle nicht mehr selbst.',
      });
    } catch (err) {
      notify({
        variant: 'error',
        title: 'Umschalten fehlgeschlagen',
        message: err instanceof Error && err.message ? err.message : 'Unbekannter Fehler.',
      });
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File) {
    setFormError('');
    const version = /(\d{4}-\d{2})/.exec(file.name)?.[1];
    if (!version) {
      // Vor dem Hochladen und nicht danach: 4,5 MB durch die Leitung zu
      // schicken, um dann am Dateinamen zu scheitern, ist eine Wartezeit für
      // nichts.
      setFormError(
        `„${file.name}" nennt keinen Stand. Erwartet wird der Monat im Dateinamen, ` +
          'so wie DB-IP ihn ausliefert: dbip-country-lite-2026-08.csv.gz'
      );
      return;
    }

    setBusy('upload');
    try {
      const res = await apiFetch(`/api/geoip?version=${encodeURIComponent(version)}`, {
        method: 'POST',
        // Roh und nicht als FormData: es ist eine Datei und kein Formular.
        headers: { 'Content-Type': 'application/octet-stream' },
        body: await file.arrayBuffer(),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      const next = data.data as GeoipOverview;
      setStatus(next);
      notify({
        variant: 'success',
        title: `Länder-Tabelle auf Stand ${version}`,
        message:
          `${(next.v4Count ?? 0).toLocaleString('de-DE')} IPv4- und ` +
          `${(next.v6Count ?? 0).toLocaleString('de-DE')} IPv6-Bereiche übernommen.`,
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Die Datei konnte nicht gelesen werden.');
    } finally {
      setBusy(null);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  async function reset() {
    const ok = await confirm({
      title: 'Auf die mitgelieferte Tabelle zurück?',
      message: status?.autoRefresh
        ? 'Danach gilt die mitgelieferte Fassung. Sie ist in der Regel älter. Beim nächsten ' +
          'selbsttätigen Abruf holt HAPM wieder die aktuelle.'
        : 'Danach gilt wieder die mitgelieferte Fassung. Sie ist in der Regel älter, die Länder ' +
          'in der Statistik werden dadurch ungenauer. Sonst ändert sich nichts.',
      confirmLabel: 'Zurücksetzen',
    });
    if (!ok) return;

    setBusy('reset');
    try {
      const res = await apiFetch('/api/geoip', { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setStatus(data.data as GeoipOverview);
      notify({ variant: 'success', message: 'Es gilt wieder die mitgelieferte Tabelle.' });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Das hat nicht geklappt.');
    } finally {
      setBusy(null);
    }
  }

  const overridden = status?.origin === 'fetched' || status?.origin === 'uploaded';

  return (
    <div className="card sys-block">
      <div className="card-header">
        <div>
          <h2 className="card-title">
            <Globe size={16} style={{ marginRight: 6, verticalAlign: '-2px' }} />
            Länder-Tabelle
            <InfoHint text="Aus ihr macht die Statistik aus einer Adresse ein Land. Nachgeschlagen wird in HAPM selbst: keine Besucheradresse geht an einen fremden Dienst." />
          </h2>
          {status && <p className="card-subtitle">{summary(status)}</p>}
        </div>
        {status && (
          <button className="btn btn-primary btn-sm" onClick={refresh} disabled={busy !== null}>
            {busy === 'refresh' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            Jetzt erneuern
          </button>
        )}
      </div>

      {!status ? (
        loadFailed ? (
          <div className="alert alert-danger">
            Der Zustand der Länder-Tabelle konnte nicht geladen werden.
          </div>
        ) : (
          <SkeletonRows count={2} />
        )
      ) : (
        <>
          {status.lastAttemptError ? (
            <div className="alert alert-danger sys-block">
              <span>
                <strong>
                  Der letzte Abruf
                  {status.lastAttemptAt ? ` am ${formatTime(status.lastAttemptAt)}` : ''} ist
                  gescheitert.
                </strong>{' '}
                {status.lastAttemptError}
                {status.autoRefresh ? ' HAPM versucht es einmal am Tag wieder.' : ''}
              </span>
            </div>
          ) : (
            status.stale &&
            status.origin !== 'none' && (
              <div className="alert alert-warning sys-block">
                <span>
                  <strong>Die Tabelle ist veraltet.</strong> Adressbereiche werden laufend neu
                  vergeben, die Länder in der Statistik stimmen mit der Zeit seltener.
                </span>
              </div>
            )
          )}

          <dl className="detail-grid">
            <div>
              <dt>Stand</dt>
              <dd>{status.version ?? 'Unbekannt'}</dd>
            </div>
            <div>
              <dt>Herkunft</dt>
              <dd>{ORIGIN_LABELS[status.origin]}</dd>
            </div>
            <div>
              <dt>Alter</dt>
              <dd>
                {status.ageDays === null ? (
                  'Unbekannt'
                ) : status.stale ? (
                  <span style={{ color: 'var(--warning)' }}>{status.ageDays} Tage, veraltet</span>
                ) : (
                  <span
                    style={{
                      color: 'var(--success)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <Check size={13} /> {status.ageDays} Tage
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>Bereiche</dt>
              <dd>
                {status.v4Count === null || status.v6Count === null
                  ? 'Unbekannt'
                  : `${status.v4Count.toLocaleString('de-DE')} IPv4 · ${status.v6Count.toLocaleString('de-DE')} IPv6`}
              </dd>
            </div>
            <div>
              <dt>Letzter Versuch</dt>
              <dd>
                {status.lastAttemptAt === null
                  ? 'Noch keiner'
                  : `${formatTime(status.lastAttemptAt)}, ${status.lastAttemptError ? 'gescheitert' : 'ohne Fehler'}`}
              </dd>
            </div>
            {overridden && status.uploadedAt && (
              <div>
                <dt>{status.origin === 'fetched' ? 'Geholt' : 'Hochgeladen'}</dt>
                <dd>
                  {formatTime(status.uploadedAt)}
                  {status.uploadedBy
                    ? ` von ${status.uploadedBy}`
                    : status.origin === 'fetched'
                      ? ', selbsttätig'
                      : ''}
                </dd>
              </div>
            )}
          </dl>

          <div className="detail-block">
            <label className="form-subsection" style={{ cursor: 'pointer' }}>
              <div className="form-subsection-head">
                <div>
                  <div className="form-section-title">
                    Selbsttätig erneuern
                    <InfoHint text="Solange die Tabelle nicht vom laufenden Monat ist, fragt HAPM einmal am Tag bei db-ip.com nach der neuen Datei. DB-IP stellt sie am Monatsanfang ein. Abgeschaltet bleibt die Tabelle auf ihrem Stand, bis sie von Hand erneuert wird." />
                  </div>
                  <div className="form-section-sub">
                    HAPM lädt einmal im Monat eine Datei von db-ip.com. Besucheradressen verlassen
                    den Server dabei nicht.
                  </div>
                </div>
                <span className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={status.autoRefresh}
                    disabled={busy !== null}
                    onChange={(event) => void setAutoRefresh(event.target.checked)}
                  />
                  <span className="toggle-slider" />
                </span>
              </div>
            </label>
          </div>

          <div className="detail-block">
            <div className="form-group">
              <label className="form-label">
                Von Hand hochladen
                <InfoHint text="Der Datensatz „IP to Country Lite“ von DB-IP, monatlich und kostenlos. Die Datei wird genommen, wie sie kommt: gepackt (.csv.gz) oder ausgepackt. Der Monat muss im Dateinamen stehen, nur dort ist der Stand des Datensatzes vermerkt." />
              </label>
              <span className="form-hint">Für Server ohne Zugang nach außen.</span>

              {formError && <div className="alert alert-danger">{formError}</div>}

              <input
                ref={fileInput}
                type="file"
                accept=".gz,.csv"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void upload(file);
                }}
              />
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => fileInput.current?.click()}
                  disabled={busy !== null}
                >
                  {busy === 'upload' ? <Loader2 size={15} className="spin" /> : <Upload size={15} />}
                  Datei wählen
                </button>
                <a
                  className="btn btn-ghost btn-sm"
                  href={status.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Datensatz bei DB-IP
                  <ExternalLink size={15} />
                </a>
                {overridden && (
                  <button className="btn btn-ghost btn-sm" onClick={reset} disabled={busy !== null}>
                    {busy === 'reset' ? <Loader2 size={15} className="spin" /> : <RotateCcw size={15} />}
                    Auf mitgelieferte zurück
                  </button>
                )}
              </div>
            </div>
          </div>

          <p className="form-hint" style={{ marginTop: 16 }}>
            Länderdaten:{' '}
            <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
              IP Geolocation by DB-IP
            </a>
            , Lizenz CC BY 4.0.
          </p>
        </>
      )}
    </div>
  );
}
