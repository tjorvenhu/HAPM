'use client';

import { useCallback, useRef, useState } from 'react';
import { Globe, Upload, Loader2, ExternalLink, RotateCcw, Check, RefreshCw } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { errorText } from '@/components/errorText';
import { useMountedLoad } from '@/components/useMountedLoad';
import { usePolling } from '@/components/usePolling';
import { SkeletonRows } from '@/components/Skeleton';
import type { GeoipOverview } from '@/lib/geoip/fetch';
import { formatDateTimeMedium, formatNumber, msgid, type Locale, type Translator } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

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
  fetched: msgid('Von db-ip.com geholt'),
  uploaded: msgid('Von Hand hochgeladen'),
  bundled: msgid('Mit HAPM mitgeliefert'),
  none: msgid('Keine'),
};

/** Der eine Satz unter dem Titel: was gilt, und ob es sich von selbst erneuert. */
function summary(status: GeoipOverview, t: Translator['t']): string {
  const renewal = t(
    status.autoRefresh ? 'Wird jeden Monat selbsttätig erneuert.' : 'Das selbsttätige Erneuern ist abgeschaltet.'
  );
  if (status.origin === 'none') return t('Keine Tabelle vorhanden. {renewal}', { renewal });
  return t('Stand {version}. {renewal}', { version: status.version ?? t('unbekannt'), renewal });
}

function ranges(locale: Locale, t: Translator['t'], v4: number, v6: number): string {
  return t('{v4} IPv4 · {v6} IPv6', { v4: formatNumber(locale, v4), v6: formatNumber(locale, v6) });
}

export default function GeoipPanel() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t, plural, rich, locale } = useT();
  const formatTime = (iso: string) => formatDateTimeMedium(locale, iso);

  const [status, setStatus] = useState<GeoipOverview | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState<'refresh' | 'switch' | 'upload' | 'reset' | null>(null);
  /** Nur die Prüfung des Dateinamens vor dem Senden. Was der Server antwortet, ist eine Meldung. */
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
      setFormError('');
      notify(
        next.changed
          ? {
              variant: 'success',
              title: t('Länder-Tabelle auf Stand {version}', { version: next.version ?? t('unbekannt') }),
              message:
                next.v4Count !== null && next.v6Count !== null
                  ? t('{v4} IPv4- und {v6} IPv6-Bereiche von db-ip.com geholt.', {
                      v4: formatNumber(locale, next.v4Count),
                      v6: formatNumber(locale, next.v6Count),
                    })
                  : t('Von db-ip.com geholt.'),
            }
          : {
              variant: 'info',
              title: t('Länder-Tabelle ist aktuell'),
              message: t('Stand {version}. Eine neuere Datei gibt es bei DB-IP noch nicht.', {
                version: next.version ?? t('unbekannt'),
              }),
            }
      );
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Erneuern fehlgeschlagen'),
        message: errorText(err, t('Unbekannter Fehler.')),
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
      setFormError('');
      notify({
        variant: 'success',
        message: t(
          enabled ? 'HAPM erneuert die Länder-Tabelle wieder selbst.' : 'HAPM lädt die Länder-Tabelle nicht mehr selbst.'
        ),
      });
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Umschalten fehlgeschlagen'),
        message: errorText(err, t('Unbekannter Fehler.')),
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
        t(
          '„{file}“ nennt keinen Stand. Erwartet wird der Monat im Dateinamen, so wie DB-IP ihn ausliefert: dbip-country-lite-2026-08.csv.gz',
          { file: file.name }
        )
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
        title: t('Länder-Tabelle auf Stand {version}', { version }),
        message: t('{v4} IPv4- und {v6} IPv6-Bereiche übernommen.', {
          v4: formatNumber(locale, next.v4Count ?? 0),
          v6: formatNumber(locale, next.v6Count ?? 0),
        }),
      });
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Hochladen fehlgeschlagen'),
        message: errorText(err, t('Die Datei konnte nicht gelesen werden.')),
      });
    } finally {
      setBusy(null);
    }
  }

  async function reset() {
    const ok = await confirm({
      title: t('Auf die mitgelieferte Tabelle zurück?'),
      message: t(
        status?.autoRefresh
          ? 'Danach gilt die mitgelieferte Fassung. Sie ist in der Regel älter. Beim nächsten selbsttätigen Abruf holt HAPM wieder die aktuelle.'
          : 'Danach gilt wieder die mitgelieferte Fassung. Sie ist in der Regel älter, die Länder in der Statistik werden dadurch ungenauer. Sonst ändert sich nichts.'
      ),
      confirmLabel: t('Zurücksetzen'),
      variant: 'warning',
    });
    if (!ok) return;

    setBusy('reset');
    try {
      const res = await apiFetch('/api/geoip', { method: 'DELETE' });
      const data = await res.json();
      if (!data.success) throw new Error(data.error);
      setStatus(data.data as GeoipOverview);
      setFormError('');
      notify({ variant: 'success', message: t('Es gilt wieder die mitgelieferte Tabelle.') });
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Zurücksetzen fehlgeschlagen'),
        message: errorText(err, t('Das hat nicht geklappt.')),
      });
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
            {t('Länder-Tabelle')}
            <InfoHint
              text={t(
                'Aus ihr macht die Statistik aus einer Adresse ein Land. Nachgeschlagen wird in HAPM selbst: keine Besucheradresse geht an einen fremden Dienst.'
              )}
            />
          </h2>
          {status && <p className="card-subtitle">{summary(status, t)}</p>}
        </div>
        {status && (
          <button className="btn btn-primary btn-sm" onClick={refresh} disabled={busy !== null}>
            {busy === 'refresh' ? <Loader2 size={15} className="spin" /> : <RefreshCw size={15} />}
            {t('Jetzt erneuern')}
          </button>
        )}
      </div>

      {!status ? (
        loadFailed ? (
          <div className="alert alert-danger">
            {t('Der Zustand der Länder-Tabelle konnte nicht geladen werden.')}
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
                  {status.lastAttemptAt
                    ? t('Der letzte Abruf am {time} ist gescheitert.', { time: formatTime(status.lastAttemptAt) })
                    : t('Der letzte Abruf ist gescheitert.')}
                </strong>{' '}
                {t(status.lastAttemptError)}
                {status.autoRefresh ? ` ${t('HAPM versucht es einmal am Tag wieder.')}` : ''}
              </span>
            </div>
          ) : (
            status.stale &&
            status.origin !== 'none' && (
              <div className="alert alert-warning sys-block">
                <span>
                  <strong>{t('Die Tabelle ist veraltet.')}</strong>{' '}
                  {t('Adressbereiche werden laufend neu vergeben, die Länder in der Statistik stimmen mit der Zeit seltener.')}
                </span>
              </div>
            )
          )}

          <dl className="detail-grid">
            <div>
              <dt>{t('Stand')}</dt>
              <dd>{status.version ?? t('Unbekannt')}</dd>
            </div>
            <div>
              <dt>{t('Herkunft')}</dt>
              <dd>{t(ORIGIN_LABELS[status.origin])}</dd>
            </div>
            <div>
              <dt>{t('Alter')}</dt>
              <dd>
                {status.ageDays === null ? (
                  t('Unbekannt')
                ) : status.stale ? (
                  <span style={{ color: 'var(--warning)' }}>
                    {plural(status.ageDays, { one: '{count} Tag, veraltet', other: '{count} Tage, veraltet' })}
                  </span>
                ) : (
                  <span
                    style={{
                      color: 'var(--success)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                    }}
                  >
                    <Check size={13} /> {plural(status.ageDays, { one: '{count} Tag', other: '{count} Tage' })}
                  </span>
                )}
              </dd>
            </div>
            <div>
              <dt>{t('Bereiche')}</dt>
              <dd>
                {status.v4Count === null || status.v6Count === null
                  ? t('Unbekannt')
                  : ranges(locale, t, status.v4Count, status.v6Count)}
              </dd>
            </div>
            <div>
              <dt>{t('Letzter Versuch')}</dt>
              <dd>
                {status.lastAttemptAt === null
                  ? t('Noch keiner')
                  : status.lastAttemptError
                    ? t('{time}, gescheitert', { time: formatTime(status.lastAttemptAt) })
                    : t('{time}, ohne Fehler', { time: formatTime(status.lastAttemptAt) })}
              </dd>
            </div>
            {overridden && status.uploadedAt && (
              <div>
                <dt>{t(status.origin === 'fetched' ? 'Geholt' : 'Hochgeladen')}</dt>
                <dd>
                  {status.uploadedBy
                    ? t('{time} von {user}', { time: formatTime(status.uploadedAt), user: status.uploadedBy })
                    : status.origin === 'fetched'
                      ? t('{time}, selbsttätig', { time: formatTime(status.uploadedAt) })
                      : formatTime(status.uploadedAt)}
                </dd>
              </div>
            )}
          </dl>

          <div className="detail-block">
            <label className="form-subsection" style={{ cursor: 'pointer' }}>
              <div className="form-subsection-head">
                <div>
                  <div className="form-section-title">
                    {t('Selbsttätig erneuern')}
                    <InfoHint
                      text={t(
                        'Solange die Tabelle nicht vom laufenden Monat ist, fragt HAPM einmal am Tag bei db-ip.com nach der neuen Datei. DB-IP stellt sie am Monatsanfang ein. Abgeschaltet bleibt die Tabelle auf ihrem Stand, bis sie von Hand erneuert wird.'
                      )}
                    />
                  </div>
                  <div className="form-section-sub">
                    {t('HAPM lädt einmal im Monat eine Datei von db-ip.com. Besucheradressen verlassen den Server dabei nicht.')}
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
                {t('Von Hand hochladen')}
                <InfoHint
                  text={t(
                    'Der Datensatz „IP to Country Lite“ von DB-IP, monatlich und kostenlos. Die Datei wird genommen, wie sie kommt: gepackt (.csv.gz) oder ausgepackt. Der Monat muss im Dateinamen stehen, nur dort ist der Stand des Datensatzes vermerkt.'
                  )}
                />
              </label>
              <span className="form-hint">{t('Für Server ohne Zugang nach außen.')}</span>

              {formError && <div className="alert alert-danger">{formError}</div>}

              <input
                ref={fileInput}
                type="file"
                accept=".gz,.csv"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  // Sonst meldet der Browser keine Änderung, wenn dieselbe Datei noch einmal gewählt wird.
                  event.target.value = '';
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
                  {t('Datei wählen')}
                </button>
                <a
                  className="btn btn-ghost btn-sm"
                  href={status.sourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('Datensatz bei DB-IP')}
                  <ExternalLink size={15} />
                </a>
                {overridden && (
                  <button className="btn btn-ghost btn-sm" onClick={reset} disabled={busy !== null}>
                    {busy === 'reset' ? <Loader2 size={15} className="spin" /> : <RotateCcw size={15} />}
                    {t('Auf mitgelieferte zurück')}
                  </button>
                )}
              </div>
            </div>
          </div>

          <p className="form-hint" style={{ marginTop: 16 }}>
            {rich('Länderdaten: {link}, Lizenz CC BY 4.0.', {
              link: (
                // Der Wortlaut der Namensnennung ist durch die Lizenz vorgegeben.
                <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer">
                  {'IP Geolocation by DB-IP'}
                </a>
              ),
            })}
          </p>
        </>
      )}
    </div>
  );
}
