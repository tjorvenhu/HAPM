/**
 * Die Zertifikatsfrage der Installation speichern: woher Zertifikate kommen,
 * bei welchem ACME-Server beantragt wird, und ob er HAPM über Port 80
 * erreicht. Ein Weg für die Seite „Allgemein" und den Assistenten.
 *
 * Ein eigener ACME-Server wird erst gespeichert, wenn acme.sh ein Konto bei
 * ihm angemeldet hat (`registerAcmeAccount`). Sonst fiele eine falsche Adresse
 * oder ein abgelehnter EAB-Schlüssel erst beim ersten Ziel auf, in einem Lauf,
 * Minuten später und mit einer Meldung über ein Zertifikat statt über ein Konto.
 */

import { ApiError } from './api';
import { msg } from './i18n/translate';
import { registerAcmeAccount } from './acme';
import { normalizeAcmeDirectory, validateAcmeDirectory, validateEab, type EabInput } from './acme-server';
import { CERTIFICATE_SOURCES, getSettings, updateSettings } from './settings';
import type { CertificateSource, Settings } from './types';

export interface CertificateSettingsInput {
  source: CertificateSource;
  /** Leer oder `null`: Let's Encrypt (oder `HAPM_ACME_SERVER`). */
  acmeDirectory: string | null;
  httpReachable: boolean;
  /** Nur zur Anmeldung. Leer heißt: ohne External Account Binding. */
  eab: EabInput | null;
}

/** Die Eingabe einer Route auf ihre Form prüfen. */
export function readCertificateSettings(body: Record<string, unknown>): CertificateSettingsInput {
  const source = body.source as CertificateSource;
  if (!CERTIFICATE_SOURCES.includes(source)) {
    throw new ApiError(msg('Zertifikate kommen entweder über ACME oder werden hochgeladen.'));
  }
  const text = (value: unknown) => (typeof value === 'string' ? value : '');
  const keyId = text(body.eabKeyId).trim();
  const hmacKey = text(body.eabHmacKey).trim();
  return {
    source,
    acmeDirectory: normalizeAcmeDirectory(text(body.acmeDirectory)) || null,
    httpReachable: body.httpReachable === true,
    eab: keyId || hmacKey ? { keyId, hmacKey } : null,
  };
}

export interface CertificateSettingsResult {
  settings: Settings;
  /** Ob dabei ein Konto beim eigenen ACME-Server angemeldet wurde. */
  registered: boolean;
  /** Was ins Protokoll geht. Nie der HMAC-Schlüssel. */
  audit: string;
}

export async function saveCertificateSettings(input: CertificateSettingsInput): Promise<CertificateSettingsResult> {
  if (input.acmeDirectory) {
    const invalid = validateAcmeDirectory(input.acmeDirectory);
    if (invalid) throw new ApiError(invalid);
  }
  if (input.eab) {
    if (!input.acmeDirectory) {
      throw new ApiError(msg('External Account Binding gibt es nur zusammen mit einem eigenen ACME-Server.'));
    }
    const invalid = validateEab(input.eab);
    if (invalid) throw new ApiError(invalid);
  }

  const current = await getSettings();
  const serverChanged = input.acmeDirectory !== current.acmeDirectory;
  let registered = false;
  // Angemeldet wird bei einem neuen Server und immer, wenn EAB mitkommt: wer
  // den Schlüssel eingibt, will ihn auch benutzen, etwa nach einem Fehlversuch.
  if (input.acmeDirectory && (serverChanged || input.eab)) {
    const result = await registerAcmeAccount(input.acmeDirectory, current.acmeEmail, input.eab);
    if (!result.ok) throw new ApiError(result.message);
    registered = true;
  }

  const settings = await updateSettings({
    certificateSource: input.source,
    acmeDirectory: input.acmeDirectory,
    acmeHttpReachable: input.acmeDirectory ? input.httpReachable : false,
  });

  const audit = [
    input.source === 'upload' ? 'Zertifikate: nur hochladen' : 'Zertifikate: über ACME',
    `ACME-Server: ${input.acmeDirectory ?? "Let's Encrypt"}`,
    input.acmeDirectory ? `HTTP über Port 80: ${settings.acmeHttpReachable ? 'ja' : 'nein'}` : null,
    registered ? `Konto angemeldet${input.eab ? ' mit External Account Binding' : ''}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return { settings, registered, audit };
}
