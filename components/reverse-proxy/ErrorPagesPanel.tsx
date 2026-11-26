'use client';

import { useState } from 'react';
import ErrorNote from '@/components/ErrorNote';
import { FileWarning, Loader2, Paintbrush } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { errorText } from '@/components/errorText';
import { SkeletonRows } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useT } from '@/lib/i18n/react';
import { msgid } from '@/lib/i18n';
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
 * gespeicherten Design entstünde und HAPM sie nicht selbst nachzieht: nach
 * einer Änderung von Hand, oder wenn das Ausliefern gescheitert ist. Dateien,
 * die HAPM selbst geschrieben hat, zieht es nach einem Update und nach einer
 * geänderten Darstellung selbst nach (`followPageChanges`). Geladen wird die Liste von der Seite
 * (`/reverse-proxy/fehlerseiten`), die sie auch nach dem Speichern erneuert.
 */

export interface ErrorPagesRow {
  $id: string;
  name: string;
  entries: ErrorPageEntry[];
  error: string | null;
}

/* Die Klassennamen stehen ausgeschrieben, weil `tests/ui/css-classes.test.ts`
   sie aus dem Quelltext liest. Beschriftung und Hinweis sind Schlüssel (`msgid`). */
const STATE: Record<ErrorPageState, { label: string; className: string; hint: string }> = {
  current: {
    label: msgid('Aktuell'),
    className: 'badge-success',
    hint: msgid('Die Datei trägt das gespeicherte Design.'),
  },
  other: {
    label: msgid('Andere Seite'),
    className: 'badge-warning',
    hint: msgid('Eine Seite von Hand, die von HAProxy oder ein Stand, den HAPM nicht nachziehen konnte. Wird beim Schreiben ersetzt, das Original bleibt daneben liegen.'),
  },
  foreign: {
    label: msgid('Wird nicht angefasst'),
    className: 'badge-neutral',
    hint: msgid('Liegt außerhalb von /etc/haproxy oder heißt ungewöhnlich.'),
  },
  unreadable: {
    label: msgid('Nicht lesbar'),
    className: 'badge-danger',
    hint: msgid('Die Datei fehlt oder beginnt nicht mit einer Statuszeile. Sie bleibt, wie sie ist.'),
  },
  unsupported: {
    label: msgid('Keine Vorlage'),
    className: 'badge-neutral',
    hint: msgid('Für diesen Status gibt es keine Seite. Die Datei bleibt, wie sie ist.'),
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
  const { t, plural } = useT();
  const [busy, setBusy] = useState(false);

  async function write(target: ErrorPagesRow, count: number) {
    const ok = await confirm({
      title: t('Fehlerseiten neu schreiben?'),
      message: plural(count, {
        one: '{count} Fehlerdatei wird durch die Seite im gespeicherten Design ersetzt, danach lädt HAProxy neu. Der Status der Datei bleibt derselbe. Die bisherige Fassung bleibt als .hapm-original daneben liegen.',
        other: '{count} Fehlerdateien werden durch die Seite im gespeicherten Design ersetzt, danach lädt HAProxy neu. Der Status jeder Datei bleibt derselbe. Die bisherige Fassung bleibt als .hapm-original daneben liegen.',
      }),
      confirmLabel: t('Schreiben'),
      variant: 'warning',
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
      if (!data.success) throw new Error(data.error || t('Schreiben fehlgeschlagen'));

      const steps = data.data.steps as { label: string; ok: boolean; detail?: string }[];
      const failed = steps.find((step) => !step.ok);
      onWritten(data.data.entries as ErrorPageEntry[]);
      notify(
        failed
          ? {
              variant: 'error',
              title: t('Fehlerseiten'),
              message: `${t(failed.label)}: ${failed.detail ? t(failed.detail) : t('fehlgeschlagen')}`,
            }
          : {
              variant: 'success',
              title: t('Fehlerseiten'),
              message: t('Geschrieben, geprüft und HAProxy neu geladen.'),
            }
      );
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Schreiben fehlgeschlagen'),
        message: errorText(err, t('Unbekannter Fehler.')),
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
            {t('Dateien auf dem Server')}
            <InfoHint text={t('Geschrieben wird nur, was haproxy.cfg mit einer errorfile-Zeile nennt und unter /etc/haproxy liegt. HAPM legt keine Datei an und schreibt keine solche Zeile. Welchen Status eine Seite trägt, steht in der Datei selbst und bleibt beim Schreiben derselbe.')} />
          </h2>
          <p className="card-subtitle">{t('Was die Konfiguration von HAProxy an Fehlerdateien nennt.')}</p>
        </div>
        {row && writable > 0 && (
          <button className="btn btn-primary btn-sm" onClick={() => write(row, writable)} disabled={busy}>
            {busy ? <Loader2 size={15} className="spin" /> : <Paintbrush size={15} />}
            {t('{count} auf den gespeicherten Stand bringen', { count: writable })}
          </button>
        )}
      </div>

      {!row ? (
        <SkeletonRows count={3} />
      ) : row.error ? (
        <div className="alert alert-danger"><ErrorNote text={row.error} /></div>
      ) : row.entries.length === 0 ? (
        <span className="form-hint">{t('Keine errorfile-Zeile in haproxy.cfg. HAProxy zeigt eigene Seiten.')}</span>
      ) : (
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr>
                <th>{t('Datei')}</th>
                <th>{t('Status der Seite')}</th>
                <th>{t('Gezeigt bei')}</th>
                <th>{t('Zustand')}</th>
              </tr>
            </thead>
            <tbody>
              {row.entries.map((entry) => (
                <tr key={entry.path}>
                  <td className="mono" data-label="primary">{entry.path}</td>
                  <td data-label={t('Status der Seite')}>{entry.status ?? t('Unbekannt')}</td>
                  <td data-label={t('Gezeigt bei')}>{entry.codes.join(', ')}</td>
                  <td data-label={t('Zustand')}>
                    <span
                      className={`badge-status ${STATE[entry.state].className}`}
                      data-tooltip={t(STATE[entry.state].hint)}
                      data-tooltip-pos="left"
                    >
                      <span className="dot" />
                      {t(STATE[entry.state].label)}
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
