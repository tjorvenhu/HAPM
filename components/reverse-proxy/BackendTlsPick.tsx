'use client';

import { Info } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import {
  BACKEND_TLS,
  HTTPS_PORT_HINTS,
  backendTlsParams,
  type BackendTls,
} from '@/lib/haproxy/config';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

const LABELS: Record<BackendTls, string> = {
  off: msgid('HTTP'),
  insecure: msgid('HTTPS'),
  verify: msgid('HTTPS, Zertifikat prüfen'),
};

/** Ein Satz je Art, sichtbar unter der Auswahl. Die lange Erklärung steht im „i". */
const SUMMARIES: Record<BackendTls, string> = {
  off: msgid('HAProxy spricht unverschlüsselt mit dem Ziel.'),
  insecure: msgid('Verschlüsselt. Das Zertifikat des Ziels wird nicht geprüft.'),
  verify: msgid('Verschlüsselt. Das Zertifikat muss von einer bekannten CA stammen.'),
};

/** Der Port einer Adresse `host:port`, sonst `null`. */
function portOf(target: string): number | null {
  const match = /:(\d{1,5})$/.exec(target.trim());
  return match ? Number(match[1]) : null;
}

interface Props {
  value: BackendTls;
  onChange: (value: BackendTls) => void;
  /** Die Beschriftung: „Ziel spricht" oder „Ziele sprechen". */
  label: string;
  /** Die eingetragenen Adressen, für den Hinweis auf einen typischen HTTPS-Port. */
  targets: string[];
  /**
   * Die Version von HAProxy, wenn sie `@system-ca` nicht kennt (vor 2.6). Dann
   * steht „Zertifikat prüfen" nicht zur Wahl, außer es ist schon gewählt: der
   * Eintrag soll sich öffnen lassen, auch wenn die Voraussetzung fehlt.
   */
  verifyUnsupported: string | null;
}

/**
 * Wie HAProxy mit den Zielen spricht. Im Reverse-Proxy- und im
 * Lastverteilungs-Formular für das Backend, und noch einmal je Pfad-Regel:
 * eine Regel zeigt auf einen anderen Port, und ob dort HTTPS spricht, ist eine
 * Eigenschaft dieses Ports (docs/reverse-proxy.md, „Ziele, die HTTPS sprechen").
 */
export default function BackendTlsPick({ value, onChange, label, targets, verifyUnsupported }: Props) {
  const { t } = useT();
  const httpsPort =
    value === 'off'
      ? (targets.map(portOf).find((port) => port !== null && HTTPS_PORT_HINTS.includes(port)) ?? null)
      : null;

  return (
    <div className="form-group">
      <div className="form-label-row">
        <label className="form-label">{t(label)}</label>
        <InfoHint
          text={t(
            'Für Ziele, die selbst verschlüsseln, etwa Proxmox auf 8006 oder TrueNAS. Ohne Prüfung passt das für selbst signierte Zertifikate. Mit Prüfung muss das Zertifikat von einer CA stammen, der das System vertraut, und für die aufgerufene Domain gelten. HAProxy schickt die Domain der Anfrage als SNI. In der Konfiguration: „{insecure}“ oder „{verify}“ an jeder server-Zeile.',
            { insecure: backendTlsParams('insecure'), verify: backendTlsParams('verify') }
          )}
        />
      </div>
      <div>
        <div className="segmented" role="group" aria-label={t(label)}>
          {BACKEND_TLS.map((mode) => (
            <button
              key={mode}
              type="button"
              className={value === mode ? 'active' : ''}
              aria-pressed={value === mode}
              disabled={mode === 'verify' && verifyUnsupported !== null && value !== 'verify'}
              onClick={() => onChange(mode)}
            >
              {t(LABELS[mode])}
            </button>
          ))}
        </div>
      </div>
      <span className="form-hint">{t(SUMMARIES[value])}</span>
      {verifyUnsupported !== null && (
        <span className="form-hint">
          {t('Die Prüfung des Zertifikats braucht HAProxy 2.6 oder neuer. Hier läuft {version}.', {
            version: verifyUnsupported,
          })}
        </span>
      )}
      {httpsPort !== null && (
        <div className="form-note">
          <Info size={14} />
          <span>{t('Auf Port {port} spricht ein Ziel meist HTTPS.', { port: httpsPort })}</span>
        </div>
      )}
    </div>
  );
}
