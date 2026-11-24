'use client';

import { useCallback, useState } from 'react';
import { FileWarning, Loader2, Paintbrush } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { useMountedLoad } from '@/components/useMountedLoad';
import type { ErrorPageEntry, ErrorPageState } from '@/lib/haproxy/error-pages';

/**
 * Die Fehlerseiten von HAProxy: was dort liegt, und der Knopf, der sie ins
 * Aussehen von HAPM bringt.
 *
 * Die Karte zeigt, was `haproxy.cfg` an Fehlerdateien NENNT, mit dem Status,
 * den jede Datei selbst trägt. Sie legt keine an und schreibt keine
 * `errorfile`-Zeile: welche Fehler eine Maschine mit einer eigenen Seite
 * beantwortet, ist eine Einrichtung und keine Nebenwirkung eines Klicks. Die
 * Gründe im Einzelnen stehen in `lib/haproxy/error-pages.ts`.
 *
 * Das Aussehen selbst steht in `ui/static/page.ts`. Eine neue Fassung
 * dort zeigt sich hier als „Andere Seite" und kommt mit dem Knopf auf die
 * Maschine.
 */

interface ErrorPagesRow {
  $id: string;
  name: string;
  entries: ErrorPageEntry[];
  error: string | null;
}

/* Die Klassennamen stehen ausgeschrieben, weil `tests/ui/css-classes.test.ts`
   sie aus dem Quelltext liest. */
const STATE: Record<ErrorPageState, { label: string; className: string; hint: string }> = {
  current: {
    label: 'HAPM-Design',
    className: 'badge-success',
    hint: 'Die Datei trägt die aktuelle Seite.',
  },
  other: {
    label: 'Andere Seite',
    className: 'badge-warning',
    hint: 'Eine eigene Seite, die von HAProxy oder eine ältere Fassung. Wird beim Schreiben ersetzt, das Original bleibt daneben liegen.',
  },
  foreign: {
    label: 'Wird nicht angefasst',
    className: 'badge-neutral',
    hint: 'Liegt außerhalb von /etc/haproxy oder heißt ungewöhnlich.',
  },
  unreadable: {
    label: 'Nicht lesbar',
    className: 'badge-danger',
    hint: 'Die Datei fehlt oder beginnt nicht mit einer Statuszeile. Sie bleibt, wie sie ist.',
  },
  unsupported: {
    label: 'Keine Vorlage',
    className: 'badge-neutral',
    hint: 'Für diesen Status gibt es keine Seite. Die Datei bleibt, wie sie ist.',
  },
};

export default function ErrorPagesPanel() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();

  const [rows, setRows] = useState<ErrorPagesRow[] | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/haproxy/error-pages');
      const data = await res.json();
      if (data.success) setRows(data.data as ErrorPagesRow[]);
    } catch {
      // Still: der Rest der Seite funktioniert ohne diese Karte.
    }
  }, [apiFetch]);

  useMountedLoad(load);

  async function write(row: ErrorPagesRow) {
    const targets = row.entries.filter((entry) => entry.state === 'other');
    const ok = await confirm({
      title: 'Fehlerseiten neu schreiben?',
      message:
        `${targets.length} Fehlerdatei(en) werden durch die Seite im HAPM-Design ` +
        'ersetzt, danach lädt HAProxy neu. Der Status jeder Datei bleibt derselbe. Die bisherige ' +
        'Fassung bleibt als .hapm-original daneben liegen.',
      confirmLabel: 'Schreiben',
    });
    if (!ok) return;

    setBusy(true);
    try {
      const res = await apiFetch('/api/haproxy/error-pages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: row.$id }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Schreiben fehlgeschlagen');

      const steps = data.data.steps as { label: string; ok: boolean; detail?: string }[];
      const failed = steps.find((step) => !step.ok);
      setRows((current) =>
        (current ?? []).map((entry) =>
          entry.$id === row.$id ? { ...entry, entries: data.data.entries as ErrorPageEntry[] } : entry
        )
      );
      notify(
        failed
          ? {
              variant: 'error',
              title: 'Fehlerseiten',
              message: `${failed.label}: ${failed.detail ?? 'fehlgeschlagen'}`,
            }
          : {
              variant: 'success',
              title: 'Fehlerseiten',
              message: 'Geschrieben, geprüft und HAProxy neu geladen.',
            }
      );
    } catch (err) {
      notify({
        variant: 'error',
        title: 'Schreiben fehlgeschlagen',
        message: err instanceof Error ? err.message : 'Unbekannter Fehler.',
      });
    } finally {
      setBusy(false);
    }
  }

  // Bis die Antwort da ist, steht hier nichts: die Karte ist eine Zugabe unter
  // den Einstellungen und soll deren Aufbau nicht verschieben.
  const row = rows?.[0];
  if (!row) return null;

  const writable = row.entries.filter((entry) => entry.state === 'other').length;

  return (
    <div className="card sys-block">
      <div className="card-header">
        <div>
          <h2 className="card-title">
            <FileWarning size={16} />
            Fehlerseiten
          </h2>
          <p className="card-subtitle">
            Was Besucher sehen, wenn ein Ziel nicht antwortet oder eine Sperre greift.
          </p>
        </div>
        {writable > 0 && (
          <button className="btn btn-primary btn-sm" onClick={() => write(row)} disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <Paintbrush size={15} />}
            {writable} im HAPM-Design schreiben
          </button>
        )}
      </div>

      <div className="form-group" style={{ marginBottom: 16 }}>
        {row.error ? (
          <div className="alert alert-danger">{row.error}</div>
        ) : row.entries.length === 0 ? (
          <span className="form-hint">
            In der Konfiguration steht keine errorfile-Zeile. HAProxy zeigt seine eigenen
            Seiten, und hier gibt es nichts zu schreiben.
          </span>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Datei</th>
                  <th>Status der Seite</th>
                  <th>Gezeigt bei</th>
                  <th>Zustand</th>
                </tr>
              </thead>
              <tbody>
                {row.entries.map((entry) => (
                  <tr key={entry.path}>
                    <td className="mono">{entry.path}</td>
                    <td>{entry.status ?? '–'}</td>
                    <td>{entry.codes.join(', ')}</td>
                    <td>
                      <span
                        className={`badge-status ${STATE[entry.state].className}`}
                        data-tooltip={STATE[entry.state].hint}
                        data-tooltip-pos="left"
                      >
                        <span className="dot" />
                        {STATE[entry.state].label}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
