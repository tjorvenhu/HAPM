'use client';

import { useMemo, useState } from 'react';
import { FileText, Loader2, RefreshCw, Search, X } from 'lucide-react';
import Select from '@/components/Select';
import { SkeletonRows } from '@/components/Skeleton';
import { parseCrowdsecLogLine, type CrowdsecLogLine, type LogLevel } from '@/lib/crowdsec/log-lines';
import { formatDate, formatDateTime, formatMs, formatNumber, formatTime, msgid, type Locale } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { useCrowdsecData } from './useCrowdsecData';

type Which = 'crowdsec' | 'bouncer';
const LINES = ['300', '1000', '2000'] as const;
type Lines = (typeof LINES)[number];
type LevelFilter = 'all' | 'warning' | 'error';

const SOURCES: { value: Which; label: string }[] = [
  { value: 'crowdsec', label: 'CrowdSec' },
  { value: 'bouncer', label: msgid('Bouncer für HAProxy') },
];

const LEVEL_FILTERS: { value: LevelFilter; label: string }[] = [
  { value: 'all', label: msgid('Alle Meldungen') },
  { value: 'warning', label: msgid('Warnungen und Fehler') },
  { value: 'error', label: msgid('Nur Fehler') },
];

const LEVEL_BADGE: Record<LogLevel, { label: string; cls: string }> = {
  trace: { label: 'trace', cls: 'badge-neutral' },
  debug: { label: 'debug', cls: 'badge-neutral' },
  info: { label: 'info', cls: 'badge-neutral' },
  warning: { label: 'warn', cls: 'badge-warning' },
  error: { label: 'error', cls: 'badge-danger' },
  fatal: { label: 'fatal', cls: 'badge-danger' },
  panic: { label: 'panic', cls: 'badge-danger' },
};

const RANK: Record<LogLevel, number> = { trace: 0, debug: 1, info: 2, warning: 3, error: 4, fatal: 5, panic: 5 };

/** Die Felder, die als „Bereich" taugen, in dieser Reihenfolge. */
function areaOf(line: CrowdsecLogLine): string | null {
  return line.fields.module ?? line.fields.component ?? line.fields.type ?? null;
}

/** Die übrigen Felder als kurze Zeile, ohne den Bereich. */
function extraFields(line: CrowdsecLogLine): string {
  const area = areaOf(line);
  return Object.entries(line.fields)
    .filter(([key, value]) => value !== area && !['module', 'component', 'type'].includes(key))
    .map(([key, value]) => `${key}=${value}`)
    .join('  ');
}

/** `crowdsec-spoa-bouncer/v0.3.1-4705eac0452d…` mit der Kennung des Commits auf sieben Zeichen. */
function shortAgent(agent: string): string {
  return agent.replace(/-([0-9a-f]{7})[0-9a-f]{8,}/, '-$1');
}

function requestDuration(locale: Locale, ms: number): string {
  return ms < 10 ? `${formatNumber(locale, ms, 1)} ms` : formatMs(locale, ms);
}

function statusClass(status: number): string {
  if (status >= 500) return 'badge-danger';
  if (status >= 400) return 'badge-warning';
  return 'badge-success';
}

/**
 * Reverse-Proxy → Logs → CrowdSec: die Ausgabe eines der beiden Container als
 * Tabelle, neueste Zeile oben. Anfragen an die lokale API ohne Fehler sind der
 * Normalbetrieb (der Bouncer fragt alle zehn Sekunden) und stehen nur auf
 * Wunsch da. Was CrowdSec erkannt hat, steht unter CrowdSec, Ereignisse.
 */
export default function CrowdsecLogView() {
  const { t, plural, locale } = useT();
  const [which, setWhich] = useState<Which>('crowdsec');
  const [lines, setLines] = useState<Lines>('300');
  const [level, setLevel] = useState<LevelFilter>('all');
  const [routine, setRoutine] = useState(false);
  const [search, setSearch] = useState('');
  const { data, error, loading, reload } = useCrowdsecData<{ container: string; exists: boolean; lines: string[] }>(
    `/api/crowdsec/log?container=${which}&tail=${lines}`,
    15_000
  );

  const parsed = useMemo(() => (data?.lines ?? []).map(parseCrowdsecLogLine), [data]);
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const minimum = level === 'error' ? RANK.error : level === 'warning' ? RANK.warning : -1;
    return parsed.filter((line) => {
      if (!routine && line.routine) return false;
      if (minimum >= 0 && (line.level === null || RANK[line.level] < minimum)) return false;
      if (!needle) return true;
      return (
        line.message.toLowerCase().includes(needle) ||
        Object.values(line.fields).some((value) => value.toLowerCase().includes(needle))
      );
    });
  }, [parsed, routine, level, search]);
  const hiddenRoutine = parsed.filter((line) => line.routine).length;
  const today = formatDate(locale, new Date());

  return (
    <>
      <div className="logs-toolbar">
        <div className="page-search">
          <Search size={15} />
          <input
            className="form-input"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('Im Log suchen…')}
            aria-label={t('Im Log suchen…')}
          />
          {search && (
            <button type="button" className="btn btn-ghost btn-icon btn-sm" onClick={() => setSearch('')} aria-label={t('Suche leeren')}>
              <X size={14} />
            </button>
          )}
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="csLogSource">{t('Container')}</label>
          <Select<Which>
            id="csLogSource"
            value={which}
            onChange={setWhich}
            options={SOURCES.map((s) => ({ value: s.value, label: t(s.label) }))}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="csLogLevel">{t('Anzeigen')}</label>
          <Select<LevelFilter>
            id="csLogLevel"
            value={level}
            onChange={setLevel}
            options={LEVEL_FILTERS.map((f) => ({ value: f.value, label: t(f.label) }))}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="csLogLines">{t('Zeilen')}</label>
          <Select<Lines> id="csLogLines" value={lines} onChange={setLines} options={LINES.map((n) => ({ value: n, label: n }))} />
        </div>
        <div className="logs-toolbar-end">
          <label className="logs-live">
            <span className="toggle-switch">
              <input type="checkbox" checked={routine} onChange={(e) => setRoutine(e.target.checked)} />
              <span className="toggle-slider" />
            </span>
            {t('Routine-Anfragen')}
          </label>
          <button className="btn btn-secondary" onClick={() => void reload()} disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            {t('Aktualisieren')}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {!data ? (
        loading ? <SkeletonRows /> : null
      ) : !data.exists ? (
        <div className="empty-state">
          <FileText size={40} />
          <h3>{t('Den Container gibt es nicht')}</h3>
          <p>{t('{name} läuft auf diesem Server nicht. Ist CrowdSec bei der Installation abgewählt worden?', { name: data.container })}</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-state">
          <FileText size={40} />
          <h3>{t('Keine passenden Zeilen')}</h3>
          <p>
            {hiddenRoutine > 0 && !routine
              ? plural(hiddenRoutine, {
                  one: '{count} Routine-Anfrage an die lokale API ist ausgeblendet.',
                  other: '{count} Routine-Anfragen an die lokale API sind ausgeblendet.',
                })
              : t('Im gelesenen Teil des Logs steht nichts, das zu den Filtern passt.')}
          </p>
        </div>
      ) : (
        <>
          <p className="logs-meta">
            <span>
              {plural(shown.length, { one: '{count} Zeile', other: '{count} Zeilen' })}
              {hiddenRoutine > 0 && !routine
                ? ` · ${plural(hiddenRoutine, { one: '{count} Routine-Anfrage ausgeblendet', other: '{count} Routine-Anfragen ausgeblendet' })}`
                : ''}
            </span>
            <span className="mono">{data.container}</span>
          </p>
          <div className="table-wrap logs-table-wrap">
            <table className="table logs-table logs-lines">
              <colgroup>
                <col className="logs-col-time" />
                <col className="logs-col-code" />
                <col />
                <col className="logs-col-client" />
              </colgroup>
              <thead>
                <tr>
                  <th>{t('Zeit')}</th>
                  <th>{t('Stufe')}</th>
                  <th>{t('Meldung')}</th>
                  <th>{t('Bereich')}</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((line, index) => {
                  const extra = extraFields(line);
                  return (
                    <tr key={index}>
                      <td data-label={t('Zeit')}>
                        {line.time ? (
                          <>
                            <span className="logs-tip" data-tooltip={formatDateTime(locale, line.time)}>
                              {formatTime(locale, line.time, true)}
                            </span>
                            {formatDate(locale, line.time) !== today && (
                              <div className="detail-sub">{formatDate(locale, line.time)}</div>
                            )}
                          </>
                        ) : (
                          <span className="logs-muted">–</span>
                        )}
                      </td>
                      <td data-label={t('Stufe')}>
                        {line.level ? (
                          <span className={`badge-status ${LEVEL_BADGE[line.level].cls}`}>{LEVEL_BADGE[line.level].label}</span>
                        ) : (
                          <span className="logs-muted">–</span>
                        )}
                      </td>
                      <td data-label={t('Meldung')}>
                        {line.request ? (
                          <div className="logs-message">
                            <span className={`badge-status ${statusClass(line.request.status)}`}>{line.request.status}</span>
                            <span className="logs-mono">
                              <span className="logs-method">{line.request.method}</span> {line.request.path}
                              <div className="detail-sub">
                                {[
                                  line.request.client,
                                  line.request.agent && shortAgent(line.request.agent),
                                  line.request.durationMs !== null && requestDuration(locale, line.request.durationMs),
                                ]
                                  .filter(Boolean)
                                  .join(' · ')}
                              </div>
                            </span>
                          </div>
                        ) : (
                          <span className="logs-mono">
                            {line.message}
                            {extra && <div className="detail-sub">{extra}</div>}
                          </span>
                        )}
                      </td>
                      <td data-label={t('Bereich')}>
                        {areaOf(line) ? <span className="logs-mono">{areaOf(line)}</span> : <span className="logs-muted">–</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}
