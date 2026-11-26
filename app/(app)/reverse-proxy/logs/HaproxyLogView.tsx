'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import ErrorNote from '@/components/ErrorNote';
import { FileText, Loader2, RefreshCw, Search, X } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import Select from '@/components/Select';
import { SkeletonRows } from '@/components/Skeleton';
import { MISSING, formatBytes, formatCount, formatDate, formatDateTime, formatMs, formatTime, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import {
  LOG_FILTERS,
  LOG_LINE_STEPS,
  DEFAULT_LOG_LINES,
  type HaproxyLogView as LogView,
  type LogEntry,
  type LogFilter,
  type LogLevel,
} from '@/lib/haproxy/log-view';

/**
 * Der Reiter „HAProxy-Log": die letzten Zeilen, die HAProxy selbst
 * geschrieben hat, also jede Anfrage und jede Meldung des Prozesses.
 *
 * `@/lib/haproxy/log-view` ist rein (nur `lib/shell` dahinter), deshalb
 * dürfen die Konstanten von dort hierher. Gelesen wird die Datei in der Route
 * `/api/haproxy/log`.
 *
 * Die Seite pollt, solange „Mitlaufen" an ist. Wer eine Zeile liest, schaltet
 * es ab, damit sie nicht unter dem Blick wegrutscht.
 */

const POLL_MS = 10_000;
const SEARCH_DELAY_MS = 350;

const FILTER_LABELS: Record<LogFilter, string> = {
  all: msgid('Alle Zeilen'),
  requests: msgid('Alle Anfragen'),
  '2xx': msgid('2xx: erfolgreich'),
  '3xx': msgid('3xx: Weiterleitung'),
  '4xx': msgid('4xx: Fehler des Clients'),
  '5xx': msgid('5xx: Fehler des Servers'),
  system: msgid('Meldungen von HAProxy'),
  problems: msgid('Nur Warnungen und Fehler'),
};

const LEVEL_LABELS: Record<LogLevel, string> = {
  notice: msgid('Hinweis'),
  warning: msgid('Warnung'),
  alert: msgid('Fehler'),
};

const LEVEL_CLASS: Record<LogLevel, string> = {
  notice: 'badge-neutral',
  warning: 'badge-warning',
  alert: 'badge-danger',
};

function statusClass(status: number | null): string {
  if (status === null) return 'badge-neutral';
  if (status >= 500) return 'badge-danger';
  if (status >= 400) return 'badge-warning';
  if (status >= 200 && status < 300) return 'badge-success';
  return 'badge-neutral';
}

/** Gekürzt auf eine Zeile, der volle Text im Tooltip. */
function Trunc({ value, className }: { value: string; className?: string }) {
  return (
    <span className="logs-tip" data-tooltip={value}>
      <span className={className ? `sys-trunc ${className}` : 'sys-trunc'}>{value}</span>
    </span>
  );
}

export default function HaproxyLogView() {
  const { apiFetch } = useApp();
  const { t, locale } = useT();

  const [log, setLog] = useState<LogView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [filter, setFilter] = useState<LogFilter>('all');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [lines, setLines] = useState<number>(DEFAULT_LOG_LINES);
  const [live, setLive] = useState(true);

  // Tippen, Filter und Polling können sich überholen. Es zählt die Antwort auf
  // die letzte Anfrage, nicht die, die zuletzt ankommt.
  const requestId = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const load = useCallback(
    async (quiet = false) => {
      const id = ++requestId.current;
      if (!quiet) setLoading(true);
      try {
        const params = new URLSearchParams({ lines: String(lines), filter });
        if (query) params.set('q', query);
        const res = await apiFetch(`/api/haproxy/log?${params}`);
        const data = await res.json();
        if (id !== requestId.current) return;
        if (data.success) {
          setLog(data.data);
          setError('');
        } else {
          setError(data.error ?? t('Das HAProxy-Log konnte nicht gelesen werden.'));
        }
      } catch {
        if (id === requestId.current) setError(t('Das HAProxy-Log konnte nicht gelesen werden.'));
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    },
    [apiFetch, lines, filter, query, t]
  );

  useEffect(() => {
    // Wie in jeder `page.tsx` (dort ist die Regel in eslint.config.mjs aus):
    // `load` setzt den Zustand erst nach dem Laden.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  usePolling(() => (live ? load(true) : undefined), POLL_MS);

  const narrowed = filter !== 'all' || query !== '';
  const nextStep = LOG_LINE_STEPS.find((step) => step > lines);

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
            aria-label={t('Im Log suchen')}
            autoComplete="off"
            maxLength={200}
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
        <div className="form-group">
          <label className="form-label" htmlFor="logFilter">{t('Anzeigen')}</label>
          <Select
            id="logFilter"
            value={filter}
            onChange={(value) => setFilter(value)}
            options={LOG_FILTERS.map((value) => ({ value, label: t(FILTER_LABELS[value]) }))}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="logLines">{t('Zeilen')}</label>
          <Select
            id="logLines"
            value={String(lines)}
            onChange={(value) => setLines(Number(value))}
            options={LOG_LINE_STEPS.map((step) => ({
              value: String(step),
              label: t('Die letzten {count}', { count: formatCount(locale, step) }),
            }))}
          />
        </div>
        <div className="logs-toolbar-end">
          <label className="logs-live">
            <span className="toggle-switch">
              <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} />
              <span className="toggle-slider" />
            </span>
            {t('Mitlaufen')}
          </label>
          <button className="btn btn-secondary" onClick={() => load()} disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            {t('Aktualisieren')}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block"><ErrorNote text={error} /></div>}

      {loading && !log ? (
        <SkeletonRows />
      ) : log ? (
        <LogBody
          log={log}
          narrowed={narrowed}
          onMore={nextStep ? () => setLines(nextStep) : null}
        />
      ) : null}
    </>
  );
}

function LogBody({
  log,
  narrowed,
  onMore,
}: {
  log: LogView;
  narrowed: boolean;
  onMore: (() => void) | null;
}) {
  const { t, plural, locale } = useT();
  if (!log.exists) {
    const reason = !log.follower.started
      ? t('Der Mitschnitt des Logs läuft nicht, und die Datei {file} gibt es nicht. HAPM startet den Mitschnitt mit dem Server und liest das Log über die Docker-Engine aus dem HAProxy-Container.', { file: log.file })
      : !log.follower.connected
        ? t('Der Mitschnitt ist nicht mit dem HAProxy-Container verbunden, und die Datei {file} gibt es noch nicht. Läuft HAProxy, und ist die Docker-Engine erreichbar?', { file: log.file })
        : t('Der Mitschnitt ist verbunden, HAProxy hat aber noch keine Zeile geschrieben. Die Datei {file} entsteht mit der ersten Zeile.', { file: log.file });
    return (
      <div className="empty-state">
        <FileText size={40} />
        <h3>{t('Kein HAProxy-Log')}</h3>
        <p>{reason}</p>
      </div>
    );
  }

  return (
    <>
      {!log.follower.connected && (
        <div className="alert alert-warning sys-block">
          {log.follower.started
            ? t('Der Mitschnitt ist gerade nicht mit dem HAProxy-Container verbunden. Die Zeilen unten sind der letzte Stand der Datei. Neue kommen erst wieder an, wenn er sich verbunden hat.')
            : t('Der Mitschnitt läuft nicht. Die Zeilen unten sind der letzte Stand der Datei, neue kommen nicht hinzu.')}
        </div>
      )}

      <div className="logs-meta">
        <span className={`badge-status ${log.follower.connected ? 'badge-success' : 'badge-warning'}`}>
          <span className="dot" />
          {log.follower.connected ? t('Mitschnitt verbunden') : t('Mitschnitt getrennt')}
        </span>
        <span>
          <span className="mono">{log.file}</span>
          {log.size !== null && <> · {formatBytes(locale, log.size)}</>}
        </span>
        <span>
          {narrowed
            ? plural(
                log.matched,
                {
                  one: 'Ein Treffer in den letzten {scanned} Zeilen',
                  other: '{count} Treffer in den letzten {scanned} Zeilen',
                },
                { scanned: formatCount(locale, log.scanned) }
              )
            : plural(log.scanned, { one: 'Die letzte Zeile', other: 'Die letzten {count} Zeilen' })}
        </span>
        {log.modifiedAt && (
          <span>{t('Zuletzt geschrieben: {time}', { time: formatDateTime(locale, log.modifiedAt) })}</span>
        )}
      </div>

      {log.scanned === 0 ? (
        <div className="empty-state">
          <FileText size={40} />
          <h3>{t('Das Log ist leer')}</h3>
          <p>{t('Die Datei {file} ist da, enthält aber noch keine Zeile.', { file: log.file })}</p>
        </div>
      ) : log.entries.length === 0 ? (
        <div className="empty-state">
          <Search size={40} />
          <h3>{t('Keine passende Zeile')}</h3>
          <p>
            {t('In den letzten {scanned} Zeilen passt keine zu Suche und Filter.', {
              scanned: formatCount(locale, log.scanned),
            })}
          </p>
        </div>
      ) : (
        <>
          <div className="table-wrap logs-table-wrap">
            <table className="table logs-table logs-lines">
              <colgroup>
                <col className="logs-col-time" />
                <col className="logs-col-client" />
                <col className="logs-col-flow" />
                <col />
                <col className="logs-col-code" />
                <col className="logs-col-duration" />
              </colgroup>
              <thead>
                <tr>
                  <th>{t('Zeit')}</th>
                  <th>{t('Client')}</th>
                  <th>{t('Frontend und Backend')}</th>
                  <th>{t('Anfrage')}</th>
                  <th>{t('Status')}</th>
                  <th className="logs-end">{t('Dauer')}</th>
                </tr>
              </thead>
              <tbody>
                {log.entries.map((entry, index) => (
                  <LogRow key={`${entry.time ?? ''}-${index}`} entry={entry} />
                ))}
              </tbody>
            </table>
          </div>

          {onMore && log.scanned >= log.limit && (
            <div className="logs-more">
              <button type="button" className="btn btn-secondary btn-sm" onClick={onMore}>
                {t('Mehr laden')}
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function TimeCell({ time }: { time: string | null }) {
  const { t, locale } = useT();
  if (!time) {
    return (
      <td data-label={t('Zeit')}>
        <span className="logs-muted">{MISSING}</span>
      </td>
    );
  }
  const today = formatDate(locale, new Date()) === formatDate(locale, time);
  return (
    <td data-label={t('Zeit')}>
      <span className="logs-tip" data-tooltip={formatDateTime(locale, time)}>
        {formatTime(locale, time, true)}
      </span>
      {!today && <div className="detail-sub">{formatDate(locale, time)}</div>}
    </td>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const { t, locale } = useT();
  if (entry.kind === 'system' || entry.kind === 'raw') {
    return (
      <tr>
        <TimeCell time={entry.time} />
        <td colSpan={5} data-label={t('Meldung')}>
          <div className="logs-message">
            <span className={`badge-status ${entry.kind === 'system' ? LEVEL_CLASS[entry.level] : 'badge-neutral'}`}>
              {entry.kind === 'system' ? t(LEVEL_LABELS[entry.level]) : t('Meldung')}
            </span>
            <span className="logs-mono">{entry.kind === 'system' ? entry.message : entry.text}</span>
          </div>
        </td>
      </tr>
    );
  }

  const flow =
    entry.kind === 'connection'
      ? entry.frontend
      : `${entry.frontend} → ${entry.backend ?? MISSING}${entry.server ? `/${entry.server}` : ''}`;

  return (
    <tr>
      <TimeCell time={entry.time} />
      <td data-label={t('Client')}>
        <Trunc value={entry.clientIp} className="logs-mono" />
      </td>
      <td data-label={t('Frontend und Backend')}>
        <Trunc value={flow} />
      </td>
      <td data-label={t('Anfrage')}>
        {entry.kind === 'request' ? (
          <span className="logs-tip" data-tooltip={entry.text}>
            <span className="sys-trunc">
              {entry.method && <span className="logs-method">{entry.method}</span>}
              {entry.path ?? MISSING}
            </span>
          </span>
        ) : entry.kind === 'tcp' ? (
          <span className="logs-tip" data-tooltip={entry.text}>
            <span className="sys-trunc">
              <span className="logs-method">TCP</span>
              {entry.bytes !== null ? formatBytes(locale, entry.bytes) : MISSING}
            </span>
          </span>
        ) : (
          <Trunc value={entry.message} />
        )}
      </td>
      <td data-label={t('Status')}>
        {entry.kind === 'request' && entry.status !== null ? (
          <span className={`badge-status ${statusClass(entry.status)}`}>{entry.status}</span>
        ) : entry.kind === 'connection' ? (
          <span className="badge-status badge-danger">{t('Fehler')}</span>
        ) : (
          <span className="logs-muted">{MISSING}</span>
        )}
      </td>
      <td data-label={t('Dauer')} className="logs-end">
        {entry.kind !== 'connection' && entry.durationMs !== null ? (
          formatMs(locale, entry.durationMs)
        ) : (
          <span className="logs-muted">{MISSING}</span>
        )}
      </td>
    </tr>
  );
}
