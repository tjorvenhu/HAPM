'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import ErrorNote from '@/components/ErrorNote';
import { AlertTriangle, AppWindow, Check, ChevronDown, ChevronUp, Download, Loader2, Search, X } from 'lucide-react';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { SkeletonRows } from '@/components/Skeleton';
import { usePolling } from '@/components/usePolling';
import { subscribeRunFinished, watchRun } from '@/components/runs/runs';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { MISSING, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { useCrowdsecData, useCrowdsecSend } from './useCrowdsecData';
import type { CrowdsecAppRules, CrowdsecRules, CrsMode } from './types';

/** Was man vor dem Einschalten wissen muss. Sichtbar und nicht hinter dem „i": es sind die Folgen. */
const CRS_PROS: string[] = [
  msgid('Erkennt auch Angriffe, für die es noch keinen Patch gibt.'),
  msgid('Prüft auf SQL-Injection, XSS, eingeschleuste Befehle und Zugriffe auf Dateien.'),
  msgid('Ein Angriff wird abgewiesen, bevor er die Anwendung erreicht.'),
];
const CRS_CONS: string[] = [
  msgid('Weist auch harmlose Anfragen ab, etwa aus Editoren, Formularen mit Code oder GraphQL.'),
  msgid('Wen das trifft, sieht nur eine Fehlerseite (403) und kann die Anwendung nicht benutzen.'),
  msgid('Fehltreffer zeigen erst die Ereignisse. Abhilfe: Ausnahmen für Anwendungen oder Freigaben.'),
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
  const [search, setSearch] = useState('');
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

  function setCrs(on: boolean) {
    const mode: CrsMode = on ? 'block' : 'off';
    if (on) {
      void confirm({
        title: t('OWASP-Regeln einschalten?'),
        message: t(
          'Ab dann weist HAProxy jede Anfrage mit einem Treffer sofort ab, auch harmlose. Danach unter Ereignisse nachsehen, ob eigene Anwendungen betroffen sind.'
        ),
        confirmLabel: t('Einschalten'),
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
  // Eine Suche geht über alle, auch die zugeklappten.
  const query = search.trim().toLocaleLowerCase(locale);
  const shownApps = query
    ? sortedApps.filter((app) => [t(app.label), app.id, ...app.items].some((text) => text.toLocaleLowerCase(locale).includes(query)))
    : allApps
      ? sortedApps
      : sortedApps.filter((app) => pinned.has(app.id));

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
                      'Eine freie Regelsammlung für Web Application Firewalls, gepflegt vom OWASP-Projekt. Sie prüft jede Anfrage auf typische Angriffsmuster. Die virtuellen Patches, die immer an sind, fangen nur bekannte Lücken bestimmter Programme ab. Die OWASP-Regeln erkennen auch Unbekanntes, treffen dafür aber manchmal harmlose Anfragen. Deshalb sind sie aus, bis Sie sie einschalten.'
                    )}
                  />
                </h2>
                <p className="card-subtitle">{t('Zusätzliche, strengere Prüfung jeder Anfrage auf typische Angriffe.')}</p>
              </div>
              <div className="cs-all-switch">
                <span className="cs-all-switch-label">{t('OWASP-Regeln')}</span>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={(pending.crs ?? data.crs) === 'block'}
                    disabled={'crs' in pending}
                    onChange={(e) => setCrs(e.target.checked)}
                    aria-label={t('OWASP-Regeln')}
                  />
                  <span className="toggle-slider" />
                </label>
              </div>
            </div>
            <div className="card-body">
              <p className="cs-state-line">
                {data.crs === 'block'
                  ? t('An. Eine Anfrage mit Treffer weist HAProxy sofort mit 403 ab.')
                  : t('Aus. Es gelten nur die virtuellen Patches und die allgemeinen Regeln.')}
              </p>
              <div className="cs-crs-facts">
                <div>
                  <h3 className="cs-crs-facts-title">{t('Vorteile')}</h3>
                  <ul className="cs-crs-list">
                    {CRS_PROS.map((text) => (
                      <li key={text}>
                        <Check size={15} className="cs-crs-pro" />
                        <span>{t(text)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="cs-crs-facts-title">{t('Nachteile')}</h3>
                  <ul className="cs-crs-list">
                    {CRS_CONS.map((text) => (
                      <li key={text}>
                        <AlertTriangle size={15} className="cs-crs-con" />
                        <span>{t(text)}</span>
                      </li>
                    ))}
                  </ul>
                </div>
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
              <div className="page-search cs-app-search">
                <Search size={15} />
                <input
                  className="form-input"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('Anwendung suchen…')}
                  aria-label={t('Anwendung suchen')}
                  autoComplete="off"
                />
                {search && (
                  <button
                    type="button"
                    className="btn btn-ghost btn-icon btn-sm"
                    data-tooltip={t('Suche leeren')}
                    aria-label={t('Suche leeren')}
                    onClick={() => setSearch('')}
                  >
                    <X size={15} />
                  </button>
                )}
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
                        <div className="cs-app">
                          {app.logo ? (
                            <Image src={app.logo} alt="" width={28} height={28} className="cs-app-logo" unoptimized />
                          ) : (
                            <span className="cs-app-logo cs-app-logo-none">
                              <AppWindow size={16} />
                            </span>
                          )}
                          <div className="cs-app-text">
                            <span className="form-label-row">
                              <strong>{t(app.label)}</strong>
                              <InfoHint text={t(app.hint)} />
                            </span>
                            <div className="detail-sub mono">{app.items.join(', ')}</div>
                          </div>
                        </div>
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
                  {query && shownApps.length === 0 && (
                    <tr>
                      <td colSpan={3} data-label="primary" className="cs-app-empty">
                        {t('Keine Treffer für „{query}“.', { query: search.trim() })}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {!query && sortedApps.length > COLLAPSED_APPS && (
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
