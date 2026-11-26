'use client';

import { useCallback, useEffect, useState } from 'react';
import { ClipboardList, Download, Loader2, RefreshCw, Search, X } from 'lucide-react';
import ErrorNote from '@/components/ErrorNote';
import Select from '@/components/Select';
import { SkeletonRows } from '@/components/Skeleton';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { usePolling } from '@/components/usePolling';
import { errorText } from '@/components/errorText';
import { MISSING, formatDateTime, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
// Rein: nur die Texte und Bereiche der Handlungen.
import { AUDIT_AREAS, AUDIT_AREA_LABELS, labelOf, type AuditArea } from '@/lib/audit-log/labels';
// Nur Typen: die Dateien dahinter erreichen `lib/db`.
import type { AuditEntry, AuditPage } from '@/lib/audit-log/read';
import type { ExportFormat } from '@/lib/audit-log/export';

/**
 * Der Reiter „Einträge": wer was wann getan hat, das Neueste oben.
 *
 * Gefiltert und geblättert wird auf dem Server (`/api/audit`). Geblättert wird
 * über die Kennung des letzten Eintrags und nicht über eine Seitenzahl: im
 * Protokoll kommt ständig etwas dazu, eine gezählte Seite verschöbe sich beim
 * Lesen. `trail` hält die Marken der Seiten davor, damit „Zurück" dorthin
 * führt, wo man herkam.
 */

const PAGE_SIZE = 50;
const DAY_MS = 24 * 60 * 60 * 1000;

type Range = 'all' | 'day' | 'week' | 'month' | 'custom';
type ActorFilter = '' | AuditEntry['actorType'];

const RANGE_LABELS: Record<Range, string> = {
  all: msgid('Gesamter Zeitraum'),
  day: msgid('Letzte 24 Stunden'),
  week: msgid('Letzte 7 Tage'),
  month: msgid('Letzte 30 Tage'),
  custom: msgid('Eigener Zeitraum'),
};

const RANGE_DAYS: Partial<Record<Range, number>> = { day: 1, week: 7, month: 30 };

const ACTOR_LABELS: Record<AuditEntry['actorType'], string> = {
  user: msgid('Konto'),
  service: msgid('API-Key'),
  system: msgid('System'),
};

/** Einzelheiten über dieser Länge werden gekürzt und lassen sich aufklappen. */
const DETAILS_SHORT = 220;

interface Filters {
  range: Range;
  /** `JJJJ-MM-TT`, nur bei `custom`. */
  fromDay: string;
  toDay: string;
  actor: ActorFilter;
  area: '' | AuditArea;
  q: string;
}

const NO_FILTERS: Filters = { range: 'all', fromDay: '', toDay: '', actor: '', area: '', q: '' };

/** Der Filter als Parameter der Abfrage. Die Tage eines eigenen Zeitraums gelten in der Zeit des Browsers. */
function filterParams(filters: Filters, now: number): Record<string, string> {
  const params: Record<string, string> = {};
  const days = RANGE_DAYS[filters.range];
  if (days) params.from = new Date(now - days * DAY_MS).toISOString();
  if (filters.range === 'custom') {
    const from = filters.fromDay ? new Date(`${filters.fromDay}T00:00:00`) : null;
    const to = filters.toDay ? new Date(`${filters.toDay}T23:59:59.999`) : null;
    if (from && !Number.isNaN(from.getTime())) params.from = from.toISOString();
    if (to && !Number.isNaN(to.getTime())) params.to = to.toISOString();
  }
  if (filters.actor) params.actor = filters.actor;
  if (filters.area) params.area = filters.area;
  if (filters.q.trim()) params.q = filters.q.trim();
  return params;
}

function Details({ text }: { text: string | null }) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  if (!text) return <span className="logs-muted">{MISSING}</span>;
  if (text.length <= DETAILS_SHORT) return <span>{text}</span>;
  return (
    <span>
      {open ? text : `${text.slice(0, DETAILS_SHORT)}…`}{' '}
      <button type="button" className="audit-more" onClick={() => setOpen(!open)}>
        {open ? t('Kürzen') : t('Ganz anzeigen')}
      </button>
    </span>
  );
}

export default function EntriesView() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const { t, locale } = useT();

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  /** Die Suche, wie sie getippt wird. In den Filter geht sie kurz danach. */
  const [typed, setTyped] = useState('');
  /** Die Marken der Seiten vor dieser: leer heißt erste Seite. */
  const [trail, setTrail] = useState<string[]>([]);
  const [page, setPage] = useState<AuditPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState<ExportFormat | null>(null);

  const before = trail.length > 0 ? trail[trail.length - 1] : null;

  const change = useCallback((patch: Partial<Filters>) => {
    setFilters((current) => ({ ...current, ...patch }));
    setTrail([]);
  }, []);

  // Nicht bei jedem Buchstaben fragen.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (typed !== filters.q) change({ q: typed });
    }, 350);
    return () => clearTimeout(timer);
  }, [typed, filters.q, change]);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const params = new URLSearchParams({ ...filterParams(filters, Date.now()), limit: String(PAGE_SIZE) });
        if (before) params.set('before', before);
        const res = await apiFetch(`/api/audit?${params}`, { cache: 'no-store' });
        const body = await res.json();
        if (!res.ok || !body.success) throw new Error(body.error);
        setPage(body.data as AuditPage);
        setError('');
      } catch (err: unknown) {
        setError(errorText(err, t('Das Protokoll konnte nicht geladen werden.')));
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, filters, before, t]
  );

  useEffect(() => {
    // Wie in jeder `page.tsx` (dort ist die Regel in eslint.config.mjs aus):
    // `load` setzt den Zustand erst nach dem Laden.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  // Das Protokoll wächst, während die Seite offen ist.
  usePolling(() => load(true), 20_000);

  async function download(format: ExportFormat) {
    setExporting(format);
    try {
      const res = await apiFetch('/api/audit/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ format, ...filterParams(filters, Date.now()) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1];
      const url = URL.createObjectURL(await res.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = name ?? `hapm-protokoll.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      notify({ variant: 'success', message: t('Der Export ist heruntergeladen.') });
      void load(true);
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Export fehlgeschlagen'),
        message: errorText(err, t('Das Protokoll ließ sich nicht exportieren.')),
      });
    } finally {
      setExporting(null);
    }
  }

  const entries = page?.entries ?? [];
  const filtered = filters.range !== 'all' || filters.actor !== '' || filters.area !== '' || filters.q.trim() !== '';

  return (
    <>
      <div className="logs-toolbar">
        <div className="page-search">
          <Search size={15} />
          <input
            className="form-input"
            value={typed}
            maxLength={200}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={t('Suchen: Name, Adresse, Text')}
            aria-label={t('Protokoll durchsuchen')}
            autoComplete="off"
            spellCheck={false}
          />
          {typed && (
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              data-tooltip={t('Suche leeren')}
              aria-label={t('Suche leeren')}
              onClick={() => setTyped('')}
            >
              <X size={15} />
            </button>
          )}
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="audit-range">{t('Zeitraum')}</label>
          <Select
            id="audit-range"
            value={filters.range}
            onChange={(value) => change({ range: value })}
            options={(Object.keys(RANGE_LABELS) as Range[]).map((value) => ({ value, label: t(RANGE_LABELS[value]) }))}
          />
        </div>
        {filters.range === 'custom' && (
          <>
            <div className="form-group">
              <label className="form-label" htmlFor="audit-from">{t('Von')}</label>
              <input
                id="audit-from"
                className="form-input"
                type="date"
                value={filters.fromDay}
                max={filters.toDay || undefined}
                onChange={(event) => change({ fromDay: event.target.value })}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="audit-to">{t('Bis')}</label>
              <input
                id="audit-to"
                className="form-input"
                type="date"
                value={filters.toDay}
                min={filters.fromDay || undefined}
                onChange={(event) => change({ toDay: event.target.value })}
              />
            </div>
          </>
        )}
        <div className="form-group">
          <label className="form-label" htmlFor="audit-actor">{t('Wer')}</label>
          <Select
            id="audit-actor"
            value={filters.actor}
            onChange={(value) => change({ actor: value })}
            options={[
              { value: '' as ActorFilter, label: t('Alle') },
              ...(Object.keys(ACTOR_LABELS) as AuditEntry['actorType'][]).map((value) => ({
                value: value as ActorFilter,
                label: t(ACTOR_LABELS[value]),
              })),
            ]}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="audit-area">{t('Bereich')}</label>
          <Select
            id="audit-area"
            value={filters.area}
            onChange={(value) => change({ area: value })}
            options={[
              { value: '' as '' | AuditArea, label: t('Alle Bereiche') },
              ...AUDIT_AREAS.map((value) => ({ value: value as '' | AuditArea, label: t(AUDIT_AREA_LABELS[value]) })),
            ]}
          />
        </div>
        <div className="logs-toolbar-end">
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => void download('csv')}
            disabled={exporting !== null}
            data-tooltip={t('Die gefilterten Einträge als Tabelle')}
          >
            {exporting === 'csv' ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
            CSV
          </button>
          <button
            className="btn btn-secondary"
            type="button"
            onClick={() => void download('jsonl')}
            disabled={exporting !== null}
            data-tooltip={t('Die gefilterten Einträge, je Zeile ein JSON-Objekt')}
          >
            {exporting === 'jsonl' ? <Loader2 size={16} className="spin" /> : <Download size={16} />}
            JSON Lines
          </button>
          {/* Nicht onClick={load}: der Klick würde sein MouseEvent als `quiet` übergeben. */}
          <button className="btn btn-secondary" type="button" onClick={() => void load()} disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            {t('Aktualisieren')}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block"><ErrorNote text={error} /></div>}

      {loading && !page ? (
        <SkeletonRows />
      ) : entries.length === 0 ? (
        // Nach einem gescheiterten Laden steht nur die Meldung oben: ob es Einträge gibt, ist dann unbekannt.
        error ? null : (
          <div className="empty-state">
            <ClipboardList size={40} />
            <h3>{trail.length > 0 ? t('Keine weiteren Einträge') : t('Keine Einträge')}</h3>
            <p>
              {trail.length > 0
                ? t('Das Protokoll endet auf einer früheren Seite.')
                : filtered
                  ? t('Für diesen Filter gibt es keine Einträge.')
                  : t('Sobald sich jemand anmeldet oder etwas ändert, steht es hier.')}
            </p>
          </div>
        )
      ) : (
        <div className="table-wrap logs-table-wrap">
          <table className="table logs-table logs-runs">
            <colgroup>
              <col className="logs-col-when" />
              <col className="audit-col-who" />
              <col className="audit-col-action" />
              <col />
              <col className="audit-col-ip" />
            </colgroup>
            <thead>
              <tr>
                <th>{t('Zeitpunkt')}</th>
                <th>{t('Wer')}</th>
                <th>{t('Handlung')}</th>
                <th>{t('Einzelheiten')}</th>
                <th>{t('Adresse')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const label = labelOf(entry.action);
                return (
                  <tr key={entry.id}>
                    <td data-label={t('Zeitpunkt')}>{formatDateTime(locale, entry.timestamp)}</td>
                    <td data-label={t('Wer')}>
                      {entry.actorType === 'system' ? t('System') : entry.actor || MISSING}
                      {entry.actorType !== 'system' && <div className="detail-sub">{t(ACTOR_LABELS[entry.actorType])}</div>}
                    </td>
                    <td data-label={t('Handlung')}>
                      {entry.outcome === 'failure' ? (
                        <span className="badge-status badge-danger">{label ? t(label) : entry.action}</span>
                      ) : (
                        <span>{label ? t(label) : entry.action}</span>
                      )}
                      {(entry.resource || entry.resourceId) && (
                        <div className="detail-sub logs-mono" data-tooltip={t('Gegenstand')}>
                          {[entry.resource, entry.resourceId].filter(Boolean).join(' · ')}
                        </div>
                      )}
                    </td>
                    <td data-label={t('Einzelheiten')}>
                      <Details text={entry.details} />
                    </td>
                    <td data-label={t('Adresse')}>
                      {entry.ip ? <span className="logs-mono">{entry.ip}</span> : <span className="logs-muted">{MISSING}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Außerhalb der Tabelle: von einer leeren Seite hinter der ersten führt nur „Zurück“ wieder weg. */}
      {page && (entries.length > 0 || trail.length > 0) && (
        <div className="audit-pager">
          <span className="audit-pager-page">{t('Seite {page}', { page: trail.length + 1 })}</span>
          <div className="audit-pager-buttons">
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => setTrail((current) => current.slice(0, -1))}
              disabled={trail.length === 0}
            >
              {t('Zurück')}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              type="button"
              onClick={() => page.cursor && setTrail((current) => [...current, page.cursor as string])}
              disabled={!page.more || !page.cursor}
            >
              {t('Weiter')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
