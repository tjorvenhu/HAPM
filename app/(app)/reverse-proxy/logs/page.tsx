'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  ScrollText, Eye, RefreshCw, Loader2, ArrowLeft, Plus, Pencil, Trash2, Settings2, FolderPlus,
  FolderMinus, Cable, ShieldCheck, FileInput,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import UpdateRunOverlay from '@/components/UpdateRunOverlay';
import { HAPROXY_PHASES, HAPROXY_PHASE_LABELS } from '@/components/runPhases';
import Select from '@/components/Select';
import type { HaproxyAction, HaproxyStep, RunStatus } from '@/lib/types';
import { SkeletonRows } from '@/components/Skeleton';

/**
 * Was am Reverse-Proxy verändert wurde.
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
 * trägt.
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
  create: 'Angelegt',
  update: 'Geändert',
  delete: 'Gelöscht',
  settings: 'Einstellungen',
  'scope-add': 'Gruppe angelegt',
  'scope-remove': 'Gruppe entfernt',
  // Sie stehen als eigene Wörter da und nicht unter „Angelegt": in der Zeile
  // steht statt einer Domain ein Port, und wer die Historie liest, soll das am
  // Etikett sehen und nicht erst an der Spalte daneben.
  'stream-create': 'TCP angelegt',
  'stream-update': 'TCP geändert',
  'stream-delete': 'TCP gelöscht',
  certificate: 'Zertifikat',
  import: 'Import',
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
  running: 'Läuft',
  success: 'Erfolgreich',
  warning: 'Mit Hinweisen',
  error: 'Fehlgeschlagen',
  cancelled: 'Abgebrochen',
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
  if (seconds === null) return '–';
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function ReverseProxyLogsPage() {
  const { apiFetch } = useApp();

  const [runs, setRuns] = useState<RunView[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [actionFilter, setActionFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [page, setPage] = useState(0);

  const [detailId, setDetailId] = useState<string | null>(null);

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
        if (data.success) setRuns(data.data);
        setError('');
      } catch {
        setError('Die Protokolle konnten nicht geladen werden.');
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, actionFilter, statusFilter, page]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Ein laufender Vorgang schreibt hierhin, während die Seite offen ist.
  usePolling(() => load(true), 20_000);

  return (
    <>
      <div className="page-header">
        <div>
          <Link
            href="/reverse-proxy"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8125rem' }}
          >
            <ArrowLeft size={14} />
            Reverse-Proxy
          </Link>
          <h1 className="page-title">Reverse-Proxy-Protokolle</h1>
          <p className="page-subtitle">
            Jeder Vorgang mit seinen Schritten: angelegt, geändert, gelöscht. Domains und Ziele
            stehen mit in der Zeile, damit auch ein entferntes Ziel noch lesbar ist.
          </p>
        </div>
        <div className="page-actions">
          {/* Nicht onClick={load}: der Klick würde sein MouseEvent als `quiet`
              übergeben und den Ladezustand unterdrücken, den der Knopf zeigt. */}
          <button className="btn btn-secondary" onClick={() => load()} disabled={loading}>
            {loading ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            Aktualisieren
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      <div className="form-row sys-block">
        <div className="form-group">
          <label className="form-label" htmlFor="filterAction">Vorgang</label>
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
              { value: '', label: 'Alle Vorgänge' },
              ...(Object.keys(ACTION_LABELS) as HaproxyAction[]).map((action) => ({
                value: action,
                label: ACTION_LABELS[action],
              })),
            ]}
          />
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="filterStatus">Status</label>
          <Select
            id="filterStatus"
            value={statusFilter}
            onChange={(v) => {
              setStatusFilter(v);
              setPage(0);
            }}
            options={[
              { value: '', label: 'Alle Status' },
              { value: 'success', label: 'Erfolgreich' },
              { value: 'error', label: 'Fehlgeschlagen' },
              { value: 'running', label: 'Läuft' },
            ]}
          />
        </div>
      </div>

      {loading ? (
        <SkeletonRows />
      ) : runs.length === 0 ? (
        <div className="empty-state">
          <ScrollText size={40} />
          <h3>Keine Protokolle</h3>
          <p>
            {actionFilter || statusFilter
              ? 'Für diesen Filter gibt es keine Einträge.'
              : 'Sobald ein Ziel angelegt, geändert oder gelöscht wurde, steht der Vorgang hier.'}
          </p>
        </div>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Zeitpunkt</th>
                  <th>Vorgang</th>
                  <th>Dienst</th>
                  <th>Domains</th>
                  <th>Ziele</th>
                  <th>Ausgelöst von</th>
                  <th>Status</th>
                  <th>Dauer</th>
                  <th style={{ textAlign: 'right' }}>Details</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.$id}>
                    <td style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
                      {new Date(run.startedAt).toLocaleString('de-DE')}
                    </td>
                    <td style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        {ACTION_ICONS[run.action]}
                        {ACTION_LABELS[run.action]}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.8125rem' }}>
                      <strong>{run.serviceId}</strong>
                      {/* Beim Umbenennen sind das zwei Namen, und der neue ist
                          der, unter dem der Eintrag jetzt in der Liste steht. */}
                      {run.renamedTo && (
                        <div style={{ fontSize: '0.75rem', color: 'var(--text-tertiary)' }}>
                          → {run.renamedTo}
                        </div>
                      )}
                    </td>
                    <td style={{ fontSize: '0.8125rem' }}>
                      {run.domains ?? <span style={{ color: 'var(--text-tertiary)' }}>–</span>}
                    </td>
                    <td style={{ fontSize: '0.8125rem' }}>
                      {run.targets ?? <span style={{ color: 'var(--text-tertiary)' }}>–</span>}
                    </td>
                    <td style={{ fontSize: '0.8125rem' }}>
                      {run.triggeredBy ?? <span style={{ color: 'var(--text-tertiary)' }}>–</span>}
                    </td>
                    <td>
                      <span className={`badge-status ${STATUS_CLASS[run.status]}`}>
                        {STATUS_LABELS[run.status]}
                      </span>
                    </td>
                    <td style={{ fontSize: '0.8125rem' }}>{formatDuration(run.duration)}</td>
                    <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                      <button
                        className="btn btn-ghost btn-icon btn-sm"
                        data-tooltip="Schritte anzeigen"
                        data-tooltip-pos="left"
                        onClick={() => setDetailId(run.$id)}
                      >
                        <Eye size={16} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div
            style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 }}
          >
            <span style={{ fontSize: '0.8125rem', color: 'var(--text-tertiary)' }}>
              Seite {page + 1}
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                Zurück
              </button>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => setPage((p) => p + 1)}
                disabled={runs.length < PAGE_SIZE}
              >
                Weiter
              </button>
            </div>
          </div>
        </>
      )}

      {/* Dasselbe Overlay wie in der Pille: bei einem noch laufenden Vorgang
          zeigt es den Fortschritt, bei einem fertigen das Protokoll. */}
      {detailId && (
        <UpdateRunOverlay
          runId={detailId}
          endpoint="/api/haproxy/runs"
          phases={HAPROXY_PHASES}
          phaseLabels={HAPROXY_PHASE_LABELS}
          noun="Reverse-Proxy"
          onClose={() => setDetailId(null)}
          onFinished={() => load(true)}
        />
      )}
    </>
  );
}
