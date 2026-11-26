'use client';

import { useEffect, useState } from 'react';
import ErrorNote from '@/components/ErrorNote';
import { Check, ChevronDown, ChevronUp, Download, Loader2 } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import Select from '@/components/Select';
import { SkeletonRows } from '@/components/Skeleton';
import { usePolling } from '@/components/usePolling';
import { subscribeRunFinished, watchRun } from '@/components/runs/runs';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { MISSING, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { useCrowdsecData, useCrowdsecSend } from './useCrowdsecData';
import type { CrowdsecAppRules, CrowdsecRules, CrsMode } from './types';

const CRS_OPTIONS: { value: CrsMode; label: string; hint: string }[] = [
  { value: 'off', label: msgid('Aus'), hint: msgid('Nur virtuelle Patches und allgemeine Regeln.') },
  { value: 'detect', label: msgid('Nur melden'), hint: msgid('Treffer erscheinen als Ereignis, die Anfrage geht durch.') },
  { value: 'block', label: msgid('Treffer sperren'), hint: msgid('Treffer werden mit 403 abgelehnt.') },
];

const BASE_LABELS: Record<string, string> = {
  'crowdsecurity/haproxy': msgid('Log von HAProxy: Scanner, Raten von Passwörtern, bekannte Lücken'),
  'crowdsecurity/appsec-virtual-patching': msgid('WAF: virtuelle Patches für bekannte Lücken'),
  'crowdsecurity/appsec-generic-rules': msgid('WAF: allgemeine Angriffsmuster'),
};

/** So viele Anwendungen zeigt die Liste, bis man sie aufklappt. Eingeschaltete stehen immer da. */
const COLLAPSED_APPS = 4;
/** Womit die zugeklappte Liste aufgefüllt wird: was hinter HAPM am häufigsten läuft. */
const FEATURED_APPS = ['nextcloud', 'wordpress', 'jellyfin', 'immich'];

/** So oft liest die Seite nach, solange eine Änderung aussteht. */
const PENDING_POLL_MS = 4000;

const KIND_LABELS: Record<CrowdsecAppRules['kinds'][number], { label: string; hint: string }> = {
  log: { label: msgid('Log'), hint: msgid('Ausnahmen für die Erkennung im Log von HAProxy') },
  waf: { label: msgid('WAF'), hint: msgid('Virtuelle Patches in der WAF') },
  owasp: { label: msgid('OWASP'), hint: msgid('Ausnahmen für die OWASP-Regeln') },
};

/**
 * Welche Regeln CrowdSec anwendet. Die Grundausstattung bringt Compose mit,
 * dazuschalten lassen sich das OWASP Core Rule Set, Regeln je Anwendung
 * (`APP_RULES`) und eine feste Auswahl weiterer Sammlungen
 * (`OPTIONAL_COLLECTIONS`).
 *
 * Eine Änderung holt Regeln aus dem Hub und dauert. Sie reiht sich deshalb als
 * Lauf im Hintergrund ein (`lib/crowdsec/rule-jobs.ts`): der Schalter zeigt
 * sofort den gewünschten Zustand und ist gesperrt, bis CrowdSec neu geladen
 * hat, die übrigen bleiben bedienbar. Den Stand zeigt die Pille unten rechts,
 * das Ende meldet der Rahmen.
 */
export default function RulesPanel() {
  const { notify } = useToast();
  const confirm = useConfirm();
  const send = useCrowdsecSend();
  const { t, locale } = useT();
  const { data, error, loading, reload } = useCrowdsecData<CrowdsecRules>('/api/crowdsec/rules', 120_000);
  // Eben geklickt, die Route hat noch nicht geantwortet: der Schalter zeigt den Wunsch schon.
  const [sent, setSent] = useState<Record<string, boolean | string>>({});
  const [allApps, setAllApps] = useState(false);
  // Was hier geschaltet wurde, bleibt sichtbar, auch wenn es wieder aus ist:
  // sonst verschwindet die Zeile unter dem Mauszeiger.
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());

  // Was aussteht, weiß der Server (`pending`), auch nach einem Neuladen der
  // Seite. Nach einem Fehler beim Lesen ist der Stand alt: dann gilt er nicht.
  const pending: Record<string, boolean | string> = { ...(error ? null : data?.pending), ...sent };
  const waiting = Object.keys(pending).length > 0;

  usePolling(() => void reload(), waiting ? PENDING_POLL_MS : 0);

  useEffect(
    () =>
      subscribeRunFinished((run) => {
        if (run.kind === 'crowdsec') void reload();
      }),
    [reload]
  );

  async function change(key: string, body: unknown, wanted: boolean | string) {
    setSent((prev) => ({ ...prev, [key]: wanted }));
    try {
      const queued = await send<{ runId: string }>('/api/crowdsec/rules', 'PATCH', body);
      watchRun({ kind: 'crowdsec', id: queued.runId });
    } catch (err) {
      notify({ variant: 'error', title: t('Ändern fehlgeschlagen'), message: err instanceof Error ? err.message : String(err) });
    } finally {
      // Erst lesen, dann den eigenen Merker fallen lassen: sonst spränge der Schalter kurz zurück.
      await reload();
      setSent((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  }

  /** Der Zustand eines Schalters: der gewünschte, solange seine Änderung aussteht. */
  function shown(key: string, installed: boolean): boolean {
    return key in pending ? pending[key] === true : installed;
  }

  function setCrs(mode: CrsMode) {
    if (mode === 'block') {
      void confirm({
        title: t('OWASP-Regeln sperren lassen?'),
        message: t(
          'Das OWASP Core Rule Set ist streng und sperrt auch harmlose Anfragen, etwa Formulare mit Code oder SQL im Text. Besser erst einige Tage „Nur melden“ und die Ereignisse ansehen.'
        ),
        confirmLabel: t('Sperren lassen'),
        variant: 'warning',
        onConfirm: () => change('crs', { crs: mode }, mode),
      });
      return;
    }
    void change('crs', { crs: mode }, mode);
  }

  function switchApp(id: string, on: boolean) {
    setTouched((prev) => new Set(prev).add(id));
    return change(`app:${id}`, { app: id, installed: on }, on);
  }

  if (loading && !data) return <SkeletonRows />;

  const sortedApps = [...(data?.apps ?? [])].sort((a, b) => t(a.label).localeCompare(t(b.label), locale));
  // Zugeklappt: was an ist oder gerade geschaltet wurde, aufgefüllt mit den
  // häufigsten bis COLLAPSED_APPS. Die Reihenfolge bleibt alphabetisch.
  const pinned = new Set(
    sortedApps
      .filter((app) => app.installed || app.partial || touched.has(app.id) || `app:${app.id}` in pending)
      .map((app) => app.id)
  );
  for (const id of [...FEATURED_APPS, ...sortedApps.map((app) => app.id)]) {
    if (pinned.size >= COLLAPSED_APPS) break;
    pinned.add(id);
  }
  const shownApps = allApps ? sortedApps : sortedApps.filter((app) => pinned.has(app.id));

  return (
    <>
      {error && <div className="alert alert-danger sys-block"><ErrorNote text={error} /></div>}
      {data && (
        <>
          <div className="card sys-block">
            <div className="card-header">
              <div>
                <h2 className="card-title">
                  {t('OWASP Core Rule Set')}
                  <InfoHint
                    text={t(
                      'Eine freie Regelsammlung für Web Application Firewalls, gepflegt vom OWASP-Projekt. Sie prüft jede Anfrage auf typische Angriffsmuster: SQL-Injection, Cross-Site-Scripting (XSS), Zugriffe auf Systemdateien, Befehle im Text. Die virtuellen Patches, die immer an sind, fangen nur bekannte Lücken bestimmter Programme ab. Das Rule Set erkennt auch Angriffe, für die es noch keinen Patch gibt, trifft dafür aber manchmal harmlose Anfragen, etwa ein Formular mit Code im Text. Deshalb ist es aus, bis Sie es einschalten. Empfehlung: einige Tage „Nur melden“ und unter Ereignisse ansehen, was es fände. Dann für Anwendungen mit Fehltreffern die Ausnahmen unten einschalten und erst danach „Treffer sperren“.'
                    )}
                  />
                </h2>
                <p className="card-subtitle">{t('Zusätzliche, strengere Prüfung jeder Anfrage auf typische Angriffe.')}</p>
              </div>
            </div>
            <div className="card-body cs-form">
              <div className="form-group cs-form-wide">
                <label className="form-label form-label-row" htmlFor="cs-crs">
                  {t('Modus')}
                  {'crs' in pending && <Loader2 size={14} className="spin" />}
                </label>
                <Select<CrsMode>
                  id="cs-crs"
                  value={CRS_OPTIONS.find((o) => o.value === pending.crs)?.value ?? data.crs}
                  onChange={setCrs}
                  disabled={'crs' in pending}
                  options={CRS_OPTIONS.map((o) => ({ value: o.value, label: t(o.label), hint: t(o.hint) }))}
                />
              </div>
            </div>
          </div>

          <div className="card sys-block">
            <div className="card-header">
              <div>
                <h2 className="card-title">
                  {t('Anwendungen')}
                  <InfoHint
                    text={t(
                      'Der normale Betrieb mancher Anwendungen sieht für CrowdSec wie ein Angriff aus, etwa viele Antworten mit 404 in kurzer Zeit. Dann sperrt es die eigenen Nutzer. Die Ausnahmen nehmen diese bekannten Fälle aus der Prüfung. Für WordPress kommen virtuelle Patches gegen bekannte Lücken dazu.'
                    )}
                  />
                </h2>
                <p className="card-subtitle">{t('Ausnahmen gegen bekannte Fehlsperren einzelner Anwendungen.')}</p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="table cs-rules">
                <thead>
                  <tr>
                    <th>{t('Anwendung')}</th>
                    <th>{t('Wirkt auf')}</th>
                    <th>{t('Aktiv')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownApps.map((app) => (
                    <tr key={app.id}>
                      <td data-label="primary">
                        <span className="form-label-row">
                          <strong>{t(app.label)}</strong>
                          <InfoHint text={t(app.hint)} />
                        </span>
                        <div className="detail-sub mono">{app.items.join(', ')}</div>
                      </td>
                      <td data-label={t('Wirkt auf')}>
                        <span className="cs-kinds">
                          {app.kinds.map((kind) => {
                            const idle = kind === 'owasp' && data.crs === 'off';
                            return (
                              <span
                                key={kind}
                                className={`badge-status ${idle ? 'badge-warning' : 'badge-neutral'}`}
                                data-tooltip={idle ? t('Wirkt erst, wenn die OWASP-Regeln an sind.') : t(KIND_LABELS[kind].hint)}
                              >
                                {t(KIND_LABELS[kind].label)}
                              </span>
                            );
                          })}
                        </span>
                      </td>
                      <td data-label={t('Aktiv')}>
                        <span className="cs-kinds">
                          <label className="toggle-switch">
                            <input
                              type="checkbox"
                              checked={shown(`app:${app.id}`, app.installed)}
                              disabled={`app:${app.id}` in pending}
                              onChange={(e) => switchApp(app.id, e.target.checked)}
                              aria-label={t(app.label)}
                            />
                            <span className="toggle-slider" />
                          </label>
                          {app.partial && !(`app:${app.id}` in pending) && (
                            <span className="badge-status badge-warning" data-tooltip={t('Nur ein Teil ist installiert. Einschalten holt den Rest.')}>
                              {t('Teilweise')}
                            </span>
                          )}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {sortedApps.length > COLLAPSED_APPS && (
              <div className="cs-more">
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAllApps((open) => !open)} aria-expanded={allApps}>
                  {allApps ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                  {allApps
                    ? t('Weniger anzeigen')
                    : t('Alle {count} Anwendungen anzeigen', { count: sortedApps.length })}
                </button>
              </div>
            )}
          </div>

          <div className="card sys-block">
            <div className="card-header">
              <div>
                <h2 className="card-title">{t('Regelsammlungen')}</h2>
                <p className="card-subtitle">{t('Aus dem Hub von CrowdSec.')}</p>
              </div>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                disabled={'hub' in pending}
                onClick={() => change('hub', { upgrade: true }, true)}
              >
                {'hub' in pending ? <Loader2 size={14} className="spin" /> : <Download size={14} />}
                {t('Regeln aktualisieren')}
              </button>
            </div>
            <div className="table-wrap">
              <table className="table cs-rules">
                <thead>
                  <tr>
                    <th>{t('Sammlung')}</th>
                    <th>{t('Version')}</th>
                    <th>{t('Aktiv')}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.base.map((entry) => (
                    <tr key={entry.name}>
                      <td data-label="primary">
                        <strong>{t(BASE_LABELS[entry.name] ?? entry.name)}</strong>
                        <div className="detail-sub mono">{entry.name}</div>
                      </td>
                      <td data-label={t('Version')}>{entry.version ?? MISSING}</td>
                      <td data-label={t('Aktiv')}>
                        {entry.installed ? (
                          <span className="badge-status badge-success">
                            <Check size={12} />
                            {t('Immer an')}
                          </span>
                        ) : (
                          <span className="badge-status badge-danger">{t('Fehlt')}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {data.optional.map((entry) => (
                    <tr key={entry.name}>
                      <td data-label="primary">
                        <span className="form-label-row">
                          <strong>{t(entry.label)}</strong>
                          <InfoHint text={t(entry.hint)} />
                        </span>
                        <div className="detail-sub mono">{entry.name}</div>
                      </td>
                      <td data-label={t('Version')}>{entry.version ?? MISSING}</td>
                      <td data-label={t('Aktiv')}>
                        <span className="cs-kinds">
                          <label className="toggle-switch">
                            <input
                              type="checkbox"
                              checked={shown(entry.name, entry.installed)}
                              disabled={entry.name in pending}
                              onChange={(e) => change(entry.name, { name: entry.name, installed: e.target.checked }, e.target.checked)}
                              aria-label={t(entry.label)}
                            />
                            <span className="toggle-slider" />
                          </label>
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </>
  );
}
