'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  ScrollText, Eye, RefreshCw, Loader2, Plus, Pencil, Trash2, Settings2, FolderPlus,
  FolderMinus, Cable, ShieldCheck, FileInput,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import { openRun, subscribeRunFinished } from '@/components/runs/runs';
import { errorText } from '@/components/errorText';
import Select from '@/components/Select';
import type { HaproxyAction, HaproxyStep, RunStatus } from '@/lib/types';
import { SkeletonRows } from '@/components/Skeleton';
import { MISSING, formatDateTime, msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/**
 * Was am Reverse-Proxy verändert wurde: der Reiter „Vorgänge".
 *
 * Die einzige Historie, die es dafür gibt. Die Zielliste daneben liest bei
 * jedem Aufruf `/etc/haproxy/haproxy.cfg` und zeigt damit den Stand von jetzt —
 * eine Weiche, die gestern gelöscht wurde, steht dort naturgemäß nicht mehr,
 * und dass sie je existiert hat, sagt danach nichts außer diesen Zeilen.
 * Deshalb tragen sie Domains und Ziele mit: nachschlagen ließe sich genau das
 * nicht mehr, worum es geht.
 *
 * Tabelle und keine Karten: hier wird verglichen und gefiltert, und ein Proxy
 * mit vierzig Diensten produziert im Jahr mehr Zeilen, als eine Kartenwand
 * trägt. Auf schmalem Platz wird jede Zeile trotzdem zur Karte
 * (`app/logs.css`): eine Tabelle, die seitlich scrollt, versteckt genau die
 * Spalte, nach der man sucht.
 */

interface RunView {
  $id: string;
  serverId: string;
  serverName: string;
  action: HaproxyAction;
  serviceId: string;
  renamedTo: string | null;
  domains: string | null;
  targets: string | null;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  duration: number | null;
  steps: HaproxyStep[];
  error: string | null;
  triggeredBy: string | null;
}

const ACTION_LABELS: Record<HaproxyAction, string> = {
  create: msgid('Angelegt'),
  update: msgid('Geändert'),
  delete: msgid('Gelöscht'),
  settings: msgid('Einstellungen'),
  'scope-add': msgid('Gruppe angelegt'),
  'scope-remove': msgid('Gruppe entfernt'),
  // Sie stehen als eigene Wörter da und nicht unter „Angelegt": in der Zeile
  // steht statt einer Domain ein Port, und wer die Historie liest, soll das am
  // Etikett sehen und nicht erst an der Spalte daneben.
  'stream-create': msgid('TCP angelegt'),
  'stream-update': msgid('TCP geändert'),
  'stream-delete': msgid('TCP gelöscht'),
  certificate: msgid('Zertifikat'),
  import: msgid('Import'),
};

const ACTION_ICONS: Record<HaproxyAction, React.ReactNode> = {
  create: <Plus size={14} />,
  update: <Pencil size={14} />,
  delete: <Trash2 size={14} />,
  settings: <Settings2 size={14} />,
  'scope-add': <FolderPlus size={14} />,
  'scope-remove': <FolderMinus size={14} />,
  'stream-create': <Cable size={14} />,
  'stream-update': <Cable size={14} />,
  'stream-delete': <Cable size={14} />,
  certificate: <ShieldCheck size={14} />,
  import: <FileInput size={14} />,
};

const STATUS_LABELS: Record<RunStatus, string> = {
  running: msgid('Läuft'),
  success: msgid('Erfolgreich'),
  warning: msgid('Mit Hinweisen'),
  error: msgid('Fehlgeschlagen'),
  cancelled: msgid('Abgebrochen'),
};

const STATUS_CLASS: Record<RunStatus, string> = {
  running: 'badge-neutral',
  success: 'badge-success',
  warning: 'badge-warning',
  error: 'badge-danger',
  cancelled: 'badge-neutral',
};

const PAGE_SIZE = 25;

function formatDuration(seconds: number | null): string {
  if (seconds === null) return MISSING;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/**
 * Eine Liste von Domains oder Zielen, wie der Lauf sie gespeichert hat
 * (`a, b, c`). Je Eintrag eine Zeile, gekürzt statt mitten in der Adresse
 * umgebrochen, höchstens zwei; die ganze Liste steht im Tooltip.
 */
const LIST_ROWS = 2;

function ItemList({ value }: { value: string | null }) {
  const { t } = useT();
  if (!value) return <span className="logs-muted">{MISSING}</span>;
  const items = value.split(/,\s*/).filter(Boolean);
  const rest = items.length - LIST_ROWS;
  return (
    <span className="logs-tip" data-tooltip={items.join('\n')}>
      {items.slice(0, LIST_ROWS).map((item, index) => (
        <span key={index} className="sys-trunc">
          {item}
        </span>
      ))}
      {rest > 0 && <span className="detail-sub">{t('{count} weitere', { count: rest })}</span>}
    </span>
  );
}

export default function RunsView() {
  const { apiFetch } = useApp();
  const { t, locale } = useT();

  const [runs, setRuns] = useState<RunView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [actionFilter, setActionFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(0);


  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const params = new URLSearchParams({
          limit: String(PAGE_SIZE),
          offset: String(page * PAGE_SIZE),
        });
        if (actionFilter) params.set('action', actionFilter);
        if (statusFilter) params.set('status', statusFilter);

        const res = await apiFetch(`/api/haproxy/runs?${params}`);
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error);
        setRuns(data.data);
        setError('');
      } catch (err: unknown) {
        setError(errorText(err, t('Die Protokolle konnten nicht geladen werden.')));
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, actionFilter, statusFilter, page, t]
  );

  useEffect(() => {
    // Wie in jeder `page.tsx` (dort ist die Regel in eslint.config.mjs aus):
    // `load` setzt den Zustand erst nach dem Laden.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Ein laufender Vorgang schreibt hierhin, während die Seite offen ist.
  usePolling(() => load(true), 20_000);

  // Das Fenster eines Laufs hat sein Ende gesehen: die Zeile gleich nachziehen.
  useEffect(
    () =>
      subscribeRunFinished((run) => {
        if (run.kind === 'haproxy') load(true);
      }),
    [load]
  );

  return (
    <>
      {error && <div className="alert alert-danger sys-block">{error}</div>}

      <div className="logs-toolbar">
        <div className="form-group">
          <label className="form-label" htmlFor="filterAction">{t('Vorgang')}</label>
          <Select
            id="filterAction"
            value={actionFilter}
            onChange={(v) => {
              setActionFilter(v);
              setPage(0);
            }}
            /* Aus derselben Karte wie die Etiketten in der Tabelle: zwei Listen
               für dieselben Wörter wären zwei, von denen eine einen neuen
               Vorgang nicht kennt — und der Filter zeigte ihn dann nie an. */
            options={[
              { value: '', label: t('Alle Vorgänge') },
              ...(Object.keys(ACTION_LABELS) as HaproxyAction[]).map((action) => ({
                value: action,
                label: t(ACTION_LABELS[action]),
              })),
            ]}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="filterStatus">{t('Status')}</label>
          <Select
            id="filterStatus"
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v);
              setPage(0);
            }}
            options={[
              { value: '', label: t('Alle Status') },
              ...(Object.keys(STATUS_LABELS) as RunStatus[]).map((status) => ({
                value: status,
                label: t(STATUS_LABELS[status]),
              })),
            ]}
          />
        </div>
        <div className="logs-toolbar-end">
          {/* Nicht onClick={load}: der Klick würde sein MouseEvent als `quiet`
              übergeben und den Ladezustand unterdrücken, den der Knopf zeigt. */}
          <button className="btn btn-secondary" onClick={() => load()} disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            {t('Aktualisieren')}
          </button>
        </div>
      </div>

      {loading ? (
        <SkeletonRows />
      ) : runs.length === 0 ? (
        // Nach einem gescheiterten Laden steht nur die Meldung oben: ob es Einträge gibt, ist dann unbekannt.
        error ? null : page > 0 ? (
          /* „Weiter“ kennt die Gesamtzahl nicht: ist sie ein Vielfaches der
             Seitengröße, führt der Knopf auf eine leere Seite. */
          <div className="empty-state">
            <ScrollText size={40} />
            <h3>{t('Keine weiteren Protokolle')}</h3>
            <p>{t('Die Einträge enden auf einer früheren Seite.')}</p>
          </div>
        ) : (
          <div className="empty-state">
            <ScrollText size={40} />
            <h3>{t('Keine Protokolle')}</h3>
            <p>
              {actionFilter || statusFilter
                ? t('Für diesen Filter gibt es keine Einträge.')
                : t('Sobald ein Ziel angelegt, geändert oder gelöscht wurde, steht der Vorgang hier.')}
            </p>
          </div>
        )
      ) : (
        <div className="table-wrap logs-table-wrap">
          <table className="table logs-table logs-runs">
            {/* „Ausgelöst von" steht unter dem Vorgang und die Dauer unter dem
                Zeitpunkt: neun Spalten passten neben der Seitenleiste nur mit
                seitlichem Scrollen in die Breite. */}
            <colgroup>
              <col className="logs-col-when" />
              <col className="logs-col-action" />
              <col />
              <col />
              <col />
              <col className="logs-col-status" />
              <col className="logs-col-details" />
            </colgroup>
            <thead>
              <tr>
                <th>{t('Zeitpunkt')}</th>
                <th>{t('Vorgang')}</th>
                <th>{t('Dienst')}</th>
                <th>{t('Domains')}</th>
                <th>{t('Ziele')}</th>
                <th>{t('Status')}</th>
                <th className="logs-end">
                  <span className="sr-only">{t('Details')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.$id}>
                  <td data-label={t('Zeitpunkt')}>
                    {formatDateTime(locale, run.startedAt)}
                    <div className="detail-sub">
                      {t('Dauer')}: {formatDuration(run.duration)}
                    </div>
                  </td>
                  <td data-label={t('Vorgang')}>
                    <span className="logs-action">
                      {ACTION_ICONS[run.action]}
                      {t(ACTION_LABELS[run.action])}
                    </span>
                    {run.triggeredBy && (
                      <div className="detail-sub" data-tooltip={t('Ausgelöst von')}>
                        {run.triggeredBy}
                      </div>
                    )}
                  </td>
                  <td data-label={t('Dienst')}>
                    <strong>{run.serviceId}</strong>
                    {/* Beim Umbenennen sind das zwei Namen, und der neue ist
                        der, unter dem der Eintrag jetzt in der Liste steht. */}
                    {run.renamedTo && <div className="detail-sub">→ {run.renamedTo}</div>}
                  </td>
                  <td data-label={t('Domains')}>
                    <ItemList value={run.domains} />
                  </td>
                  <td data-label={t('Ziele')}>
                    <ItemList value={run.targets} />
                  </td>
                  <td data-label={t('Status')}>
                    <span className={`badge-status ${STATUS_CLASS[run.status]}`}>
                      {t(STATUS_LABELS[run.status])}
                    </span>
                  </td>
                  <td data-label="actions" className="logs-end">
                    <button
                      className="btn btn-ghost btn-icon btn-sm"
                      data-tooltip={t('Schritte anzeigen')}
                      data-tooltip-pos="left"
                      aria-label={t('Schritte anzeigen')}
                      onClick={() => openRun({ kind: 'haproxy', id: run.$id })}
                    >
                      <Eye size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Außerhalb der Tabelle: von einer leeren Seite hinter der ersten führt nur „Zurück“ wieder weg. */}
      {!loading && (runs.length > 0 || page > 0) && (
        <div
          style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}
        >
          <span style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>
            {t('Seite {page}', { page: page + 1 })}
          </span>
          <div style={{ display: 'flex', gap: 8 }}>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
            >
              {t('Zurück')}
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => setPage((p) => p + 1)}
              disabled={runs.length < PAGE_SIZE}
            >
              {t('Weiter')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
