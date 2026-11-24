'use client';

import { useState } from 'react';
import { FileWarning, Loader2, Paintbrush } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { SkeletonRows } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import type { ErrorPageEntry, ErrorPageState } from '@/lib/haproxy/error-pages';

/**
 * Die Fehlerdateien von HAProxy: was dort liegt, und der Knopf, der sie auf den
 * Stand des gespeicherten Designs bringt.
 *
 * Die Karte zeigt, was `haproxy.cfg` an Fehlerdateien NENNT, mit dem Status,
 * den jede Datei selbst trägt. Sie legt keine an und schreibt keine
 * `errorfile`-Zeile: welche Fehler eine Maschine mit einer eigenen Seite
 * beantwortet, ist eine Einrichtung und keine Nebenwirkung eines Klicks. Die
 * Gründe im Einzelnen stehen in `lib/haproxy/error-pages.ts`.
 *
 * Gebraucht wird der Knopf, wenn eine Datei von dem abweicht, was aus dem
 * gespeicherten Design entstünde: nach einem Update von HAPM mit einer neuen
 * Fassung der Vorlage, nach einer Änderung von Hand, oder wenn das Ausliefern
 * beim Speichern gescheitert ist. Geladen wird die Liste von der Seite
 * (`/reverse-proxy/fehlerseiten`), die sie auch nach dem Speichern erneuert.
 */

export interface ErrorPagesRow {
  $id: string;
  name: string;
  entries: ErrorPageEntry[];
  error: string | null;
}

/* Die Klassennamen stehen ausgeschrieben, weil `tests/ui/css-classes.test.ts`
   sie aus dem Quelltext liest. */
const STATE: Record<ErrorPageState, { label: string; className: string; hint: string }> = {
  current: {
    label: 'Aktuell',
    className: 'badge-success',
    hint: 'Die Datei trägt das gespeicherte Design.',
  },
  other: {
    label: 'Andere Seite',
    className: 'badge-warning',
    hint: 'Eine eigene Seite, die von HAProxy oder ein älterer Stand. Wird beim Schreiben ersetzt, das Original bleibt daneben liegen.',
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

interface ErrorPagesPanelProps {
  /** `null`, solange die Liste lädt. */
  row: ErrorPagesRow | null;
  /** Was die Maschine nach dem Schreiben über ihre Dateien sagt. */
  onWritten: (entries: ErrorPageEntry[]) => void;
}

export default function ErrorPagesPanel({ row, onWritten }: ErrorPagesPanelProps) {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);

  async function write(target: ErrorPagesRow, count: number) {
    const ok = await confirm({
      title: 'Fehlerseiten neu schreiben?',
      message:
        `${count} Fehlerdatei(en) werden durch die Seite im gespeicherten Design ` +
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
        body: JSON.stringify({ serverId: target.$id }),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Schreiben fehlgeschlagen');

      const steps = data.data.steps as { label: string; ok: boolean; detail?: string }[];
      const failed = steps.find((step) => !step.ok);
      onWritten(data.data.entries as ErrorPageEntry[]);
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

  const writable = row ? row.entries.filter((entry) => entry.state === 'other').length : 0;

  return (
    <div className="card sys-block">
      <div className="card-header">
        <div>
          <h2 className="card-title">
            <FileWarning size={16} />
            Dateien auf dem Server
            <InfoHint text="Geschrieben wird nur, was haproxy.cfg mit einer errorfile-Zeile nennt und unter /etc/haproxy liegt. HAPM legt keine Datei an und schreibt keine solche Zeile. Welchen Status eine Seite trägt, steht in der Datei selbst und bleibt beim Schreiben derselbe." />
          </h2>
          <p className="card-subtitle">Was die Konfiguration von HAProxy an Fehlerdateien nennt.</p>
        </div>
        {row && writable > 0 && (
          <button className="btn btn-primary btn-sm" onClick={() => write(row, writable)} disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <Paintbrush size={15} />}
            {writable} auf den gespeicherten Stand bringen
          </button>
        )}
      </div>

      {!row ? (
        <SkeletonRows count={3} />
      ) : row.error ? (
        <div className="alert alert-danger">{row.error}</div>
      ) : row.entries.length === 0 ? (
        <span className="form-hint">
          In der Konfiguration steht keine errorfile-Zeile. HAProxy zeigt seine eigenen Seiten, und
          hier gibt es nichts zu schreiben.
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
                  <td>{entry.status ?? 'Unbekannt'}</td>
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
  );
}
