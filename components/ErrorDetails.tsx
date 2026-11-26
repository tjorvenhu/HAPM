'use client';

import { useCallback, useEffect, useState } from 'react';
import { Copy, Loader2, X } from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { ERROR_DETAIL_EVENT } from '@/lib/error-code';
import { formatDateTime } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
// Nur der Typ: die Datei dahinter gehört dem Server.
import type { LoggedError } from '@/lib/error-log';

type Detail = { state: 'loading' } | { state: 'found'; entry: LoggedError } | { state: 'missing'; reason: string };

/**
 * Die Einzelheiten zu einem unbekannten Fehler.
 *
 * Eine Route nennt bei einem Fehler, den niemand als Meldung geworfen hat, nur
 * eine Kennung (`lib/error-log.ts`). Jede Meldung, die eine solche Kennung
 * trägt, bietet „Anzeigen" an (`ui/tool/Toast.tsx`, `ErrorNote`) und öffnet
 * dieses Fenster: dort steht der Text, den der Server dazu festgehalten hat.
 * Einmal im Rahmen eingehängt (`AppShell`), geöffnet über ein Ereignis, damit
 * weder die Meldungen noch die Seiten etwas davon wissen müssen.
 */
export default function ErrorDetails() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const { t, locale } = useT();
  const [code, setCode] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail>({ state: 'loading' });

  const load = useCallback(
    async (wanted: string) => {
      setDetail({ state: 'loading' });
      const body = await apiFetch(`/api/errors/${encodeURIComponent(wanted)}`, { cache: 'no-store' })
        .then((res) => res.json())
        .catch(() => null);
      setDetail(
        body?.success
          ? { state: 'found', entry: body.data as LoggedError }
          : { state: 'missing', reason: body?.error || t('HAPM hat nicht geantwortet.') }
      );
    },
    [apiFetch, t]
  );

  useEffect(() => {
    const open = (event: Event) => {
      const wanted = (event as CustomEvent<string>).detail;
      setCode(wanted);
      void load(wanted);
    };
    window.addEventListener(ERROR_DETAIL_EVENT, open);
    return () => window.removeEventListener(ERROR_DETAIL_EVENT, open);
  }, [load]);

  if (!code) return null;

  const text = detail.state === 'found' ? (detail.entry.stack ?? detail.entry.message) : '';

  async function copy() {
    try {
      await navigator.clipboard.writeText(`${code}\n${text}`);
      notify({ variant: 'success', message: t('Kopiert') });
    } catch {
      notify({ variant: 'error', message: t('Kopieren nicht möglich. Bitte von Hand markieren.') });
    }
  }

  return (
    <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && setCode(null)}>
      <div className="modal" style={{ maxWidth: 720 }} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h2 className="modal-title">
            {t('Unbekannter Fehler')}
            <span className="modal-subject mono">{code}</span>
          </h2>
          <button className="modal-close" type="button" onClick={() => setCode(null)} aria-label={t('Dialog schließen')}>
            <X size={18} />
          </button>
        </div>
        <div className="modal-body">
          {detail.state === 'loading' ? (
            <Loader2 size={18} className="spin" />
          ) : detail.state === 'missing' ? (
            <div className="alert alert-warning">{detail.reason}</div>
          ) : (
            <>
              <p className="form-hint">
                {t('Aufgetreten am {when}. Dasselbe steht im Log des Containers.', {
                  when: formatDateTime(locale, detail.entry.at),
                })}
              </p>
              <pre className="run-log">{text}</pre>
            </>
          )}
        </div>
        <div className="modal-footer">
          {detail.state === 'found' && (
            <button className="btn btn-secondary" type="button" onClick={() => void copy()}>
              <Copy size={16} />
              {t('Kopieren')}
            </button>
          )}
          <button className="btn btn-primary" type="button" onClick={() => setCode(null)}>
            {t('Schließen')}
          </button>
        </div>
      </div>
    </div>
  );
}
