'use client';

import { useId } from 'react';
import Link from 'next/link';
import { Info } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import Select, { type SelectOption } from '@/components/Select';
import {
  HTTPS_PORT_HINTS,
  backendCaName,
  backendCaTls,
  backendTlsKind,
  backendTlsParams,
  isValidVerifyHost,
  type BackendTls,
} from '@/lib/haproxy/config';
import { msgid } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/** Die drei Knöpfe. Wogegen „prüfen" prüft, steht in der Auswahl darunter. */
const MODES = ['off', 'insecure', 'verify'] as const;
type Mode = (typeof MODES)[number];

const LABELS: Record<Mode, string> = {
  off: msgid('HTTP'),
  insecure: msgid('HTTPS'),
  verify: msgid('HTTPS, Zertifikat prüfen'),
};

/** Ein Satz je Art, sichtbar unter der Auswahl. Die lange Erklärung steht im „i". */
const SUMMARIES: Record<Mode | 'ca', string> = {
  off: msgid('HAProxy spricht unverschlüsselt mit dem Ziel.'),
  insecure: msgid('Verschlüsselt. Das Zertifikat des Ziels wird nicht geprüft.'),
  verify: msgid('Verschlüsselt. Das Zertifikat muss von einer bekannten CA stammen.'),
  ca: msgid('Verschlüsselt. Das Zertifikat muss von dieser Stelle stammen.'),
};

/** Wo Zertifizierungsstellen hinterlegt werden. */
const BACKEND_CA_PAGE = '/reverse-proxy/zertifikate?bereich=zertifizierungsstellen';

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
   * stehen die CAs des Systems nicht zur Wahl, außer sie sind schon gewählt:
   * der Eintrag soll sich öffnen lassen, auch wenn die Voraussetzung fehlt.
   * Eine hinterlegte Zertifizierungsstelle geht auf jeder Version.
   */
  verifyUnsupported: string | null;
  /** Die Namen der hinterlegten Zertifizierungsstellen. */
  authorities: string[];
  /** Der Name, gegen den das Zertifikat geprüft wird, wie er im Feld steht. Leer: die Domain der Anfrage. */
  verifyHost: string;
  onVerifyHostChange: (value: string) => void;
}

/**
 * Der Hostname, unter dem die Ziele eingetragen sind, wenn es genau einer ist.
 * Dann ist er der naheliegende Name im Zertifikat. Eine IP-Adresse ist keiner,
 * und bei zwei verschiedenen Namen gibt es nichts vorzuschlagen: geprüft wird
 * gegen einen.
 */
function targetHostname(targets: string[]): string | null {
  const names = new Set(
    targets
      .map((target) => target.trim().toLowerCase().replace(/:\d{1,5}$/, ''))
      .filter((host) => host !== '' && isValidVerifyHost(host))
  );
  return names.size === 1 ? [...names][0] : null;
}

/**
 * Wie HAProxy mit den Zielen spricht. Im Reverse-Proxy- und im
 * Lastverteilungs-Formular für das Backend, und noch einmal je Pfad-Regel:
 * eine Regel zeigt auf einen anderen Port, und ob dort HTTPS spricht, ist eine
 * Eigenschaft dieses Ports (docs/reverse-proxy.md, „Ziele, die HTTPS sprechen").
 *
 * Drei Knöpfe und nicht vier: „prüfen" ist eine Entscheidung, wogegen geprüft
 * wird, die zweite. Sie steht darunter, sobald geprüft wird. Der Wert bleibt
 * ein Feld (`verify` oder `ca:<name>`).
 */
export default function BackendTlsPick({
  value,
  onChange,
  label,
  targets,
  verifyUnsupported,
  authorities,
  verifyHost,
  onVerifyHostChange,
}: Props) {
  const { t } = useT();
  const hostId = useId();
  const suggestion = verifyHost.trim() === '' ? targetHostname(targets) : null;
  const kind = backendTlsKind(value);
  const mode: Mode = kind === 'ca' ? 'verify' : kind;
  const chosenCa = backendCaName(value);
  const httpsPort =
    value === 'off'
      ? (targets.map(portOf).find((port) => port !== null && HTTPS_PORT_HINTS.includes(port)) ?? null)
      : null;

  const systemBlocked = verifyUnsupported !== null && value !== 'verify';
  /** Ohne die CAs des Systems bleibt nur eine hinterlegte Stelle. Gibt es keine, gibt es nichts zu prüfen. */
  const verifyBlocked = systemBlocked && authorities.length === 0 && mode !== 'verify';

  // Eine gewählte Stelle, die nicht (mehr) in der Liste steht, bleibt wählbar und sagt, was mit ihr ist.
  const names = chosenCa !== null && !authorities.includes(chosenCa) ? [...authorities, chosenCa] : authorities;
  const options: SelectOption<BackendTls>[] = [
    {
      value: 'verify',
      label: t('Die CAs des Systems'),
      hint: t('Öffentlich ausgestellte Zertifikate, etwa von Let’s Encrypt'),
      disabled: systemBlocked,
      disabledReason: systemBlocked
        ? t('Braucht HAProxy 2.6 oder neuer. Hier läuft {version}.', { version: verifyUnsupported ?? '' })
        : undefined,
    },
    ...names.map((name) => ({
      value: backendCaTls(name) as BackendTls,
      label: name,
      hint: authorities.includes(name) ? t('Hinterlegte Zertifizierungsstelle') : t('Nicht hinterlegt'),
    })),
  ];

  const pick = (next: Mode) => {
    if (next !== 'verify') return onChange(next);
    if (mode === 'verify') return;
    // Ohne die CAs des Systems beginnt die Prüfung bei der ersten hinterlegten Stelle.
    onChange(systemBlocked && authorities.length > 0 ? backendCaTls(authorities[0]) : 'verify');
  };

  return (
    <div className="form-group">
      <div className="form-label-row">
        <label className="form-label">{t(label)}</label>
        <InfoHint
          text={t(
            'Für Ziele, die selbst verschlüsseln, etwa Proxmox auf 8006 oder TrueNAS. Ohne Prüfung passt das für selbst signierte Zertifikate. Mit Prüfung muss das Zertifikat von einer CA stammen, der das System vertraut, oder von einer hinterlegten Zertifizierungsstelle, und für die aufgerufene Domain gelten oder für den Namen, den Sie dafür eintragen. HAProxy schickt die Domain der Anfrage als SNI, mit eingetragenem Namen diesen. In der Konfiguration: „{insecure}“ oder „{verify}“ an jeder server-Zeile, bei einer hinterlegten Stelle mit ihrer Datei statt @system-ca.',
            { insecure: backendTlsParams('insecure'), verify: backendTlsParams('verify') }
          )}
        />
      </div>
      <div>
        <div className="segmented" role="group" aria-label={t(label)}>
          {MODES.map((entry) => (
            <button
              key={entry}
              type="button"
              className={mode === entry ? 'active' : ''}
              aria-pressed={mode === entry}
              disabled={entry === 'verify' && verifyBlocked}
              onClick={() => pick(entry)}
            >
              {t(LABELS[entry])}
            </button>
          ))}
        </div>
      </div>
      <span className="form-hint">{t(SUMMARIES[kind])}</span>
      {mode === 'verify' && (
        <div className="form-group">
          <div className="form-label-row">
            <label className="form-label">{t('Geprüft gegen')}</label>
            <InfoHint
              text={t(
                'Die CAs des Systems kennen nur öffentlich ausgestellte Zertifikate. Für ein Ziel mit Zertifikat aus einer eigenen CA hinterlegen Sie deren Zertifikat unter Zertifikate, Reiter Zertifizierungsstellen, und wählen sie hier aus.'
              )}
            />
          </div>
          <Select value={value} onChange={onChange} options={options} />
          {authorities.length === 0 && (
            <span className="form-hint">
              {t('Noch keine eigene Zertifizierungsstelle hinterlegt.')}{' '}
              <Link href={BACKEND_CA_PAGE}>{t('Zertifizierungsstelle hinterlegen')}</Link>
            </span>
          )}
          {chosenCa !== null && !authorities.includes(chosenCa) && (
            <div className="form-note">
              <Info size={14} />
              <span>
                {t('Die Zertifizierungsstelle {name} ist nicht hinterlegt. Speichern geht erst, wenn sie hinterlegt ist.', {
                  name: chosenCa,
                })}
              </span>
            </div>
          )}
        </div>
      )}
      {mode === 'verify' && (
        <div className="form-group">
          <div className="form-label-row">
            <label className="form-label" htmlFor={hostId}>
              {t('Name im Zertifikat')}
            </label>
            <InfoHint
              text={t(
                'Leer heißt: das Zertifikat des Ziels muss für die aufgerufene Domain gelten. Nennt es stattdessen den eigenen Namen des Ziels, etwa app01.intern.example, tragen Sie ihn hier ein. HAProxy schickt ihn dann als SNI und prüft das Zertifikat dagegen. Die Anfrage selbst geht weiter mit der aufgerufenen Domain als Host an das Ziel. Ein Hostname, kein Stern, kein Port, keine IP-Adresse.'
              )}
            />
          </div>
          <input
            id={hostId}
            className="form-input mono"
            value={verifyHost}
            onChange={(event) => onVerifyHostChange(event.target.value)}
            placeholder={t('Leer: die aufgerufene Domain')}
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="none"
          />
          {suggestion !== null && (
            <div className="hapm-form-actions">
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => onVerifyHostChange(suggestion)}>
                {t('Name des Ziels übernehmen: {name}', { name: suggestion })}
              </button>
            </div>
          )}
        </div>
      )}
      {verifyUnsupported !== null && chosenCa === null && (
        <span className="form-hint">
          {t('Die Prüfung braucht HAProxy 2.6 oder neuer. Hier läuft {version}.', {
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
