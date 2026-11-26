'use client';

import { errorCodeIn, openErrorDetail } from '@/lib/error-code';
import { useT } from '@/lib/i18n/react';

/**
 * Der Text einer Fehlermeldung, die als Zustand auf der Seite steht (Laden
 * gescheitert). Trägt er die Kennung eines unbekannten Fehlers, steht
 * „Anzeigen" dahinter und öffnet die Einzelheiten (`ErrorDetails`). Für
 * Meldungen nach einer Handlung macht das der Toast selbst.
 */
export default function ErrorNote({ text }: { text: string }) {
  const { t } = useT();
  const code = errorCodeIn(text);
  if (!code) return <>{text}</>;
  return (
    <>
      {text}{' '}
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => openErrorDetail(code)}>
        {t('Anzeigen')}
      </button>
    </>
  );
}
