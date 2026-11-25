/**
 * Zertifikate entfernen und einen nie ausgestellten Antrag erneut stellen: die
 * Seite „Zertifikate", die interne API (`/api/internal/haproxy/certificates`)
 * und der MCP-Server rufen dieselben Funktionen.
 *
 * Die Logik stand vorher in `app/api/haproxy/certificates/route.ts` (DELETE)
 * und `.../issue/route.ts`. Ob ein Zertifikat noch gebraucht wird, prüft
 * `removeAcmeCertificate` im Lock (`certificateKeepers`), nicht der Aufrufer.
 *
 * Hochladen gibt es nur in der Oberfläche: der private Schlüssel gehörte sonst
 * in einen Rumpf, ein Skript oder den Verlauf eines Sprachmodells. Deshalb
 * entfernt die API auch nur, was acme.sh führt (`allowUploaded: false`): was
 * hochgeladen ist, ließe sich über sie nicht wieder herstellen.
 */

import { ApiError } from '../api';
import { msg } from '../i18n';
import { logAudit } from '../audit';
import { localServer } from '../helpers';
import { challengeFor, getSettings } from '../settings';
import { isValidDomain } from './config';
import { pemFileName } from './certs';
import { isPemFileName } from './cert-upload';
import {
  precheckCertificate,
  readCertificateInventory,
  removeAcmeCertificate,
  removeUploadedCertificate,
} from './provision';
import { startHaproxyRun, type HaproxyActor } from './runner';

export interface CertificateActor {
  userId: string;
  userEmail: string;
  ip?: string;
}

export type CertificateRemoval = { mainDomain: string; reloaded: boolean } | { file: string };

/**
 * Ein Zertifikat entfernen: `domain` eins von acme.sh (seine Hauptdomain),
 * `file` ein hochgeladenes.
 */
export async function removeCertificate(
  target: { domain?: string | null; file?: string | null },
  actor: CertificateActor,
  options: { allowUploaded: boolean } = { allowUploaded: true }
): Promise<CertificateRemoval> {
  const server = localServer();

  if (target.domain !== undefined && target.domain !== null) {
    const mainDomain = target.domain.trim().toLowerCase();
    if (!isValidDomain(mainDomain)) throw new ApiError(msg('"{domain}" ist keine gültige Domain.', { domain: mainDomain }));
    const removed = await removeAcmeCertificate(server, mainDomain);
    const cert = removed.certificate;

    await logAudit({
      ...actor,
      action: 'haproxy_certificate_removed',
      resource: 'server',
      resourceId: server.$id,
      details:
        `acme.sh ${cert.mainDomain}: ${cert.domains.join(', ')}` +
        (cert.createdAt === null ? ', nie ausgestellt' : removed.reloaded ? `, ${pemFileName(cert.mainDomain)} gelöscht` : ', nicht ausgerollt'),
    });

    return { mainDomain: cert.mainDomain, reloaded: removed.reloaded };
  }

  if (!options.allowUploaded) throw new ApiError(msg('Es wurde kein Zertifikat angegeben.'));

  const file = target.file ?? '';
  if (!isPemFileName(file)) throw new ApiError(msg('Unbekannte Zertifikatsdatei.'));

  const removed = await removeUploadedCertificate(server, file);

  await logAudit({
    ...actor,
    action: 'haproxy_certificate_removed',
    resource: 'server',
    resourceId: server.$id,
    details: `${file}: ${removed.domains.join(', ') || 'unlesbar'}`,
  });

  return { file };
}

/**
 * Einen Antrag, den acme.sh führt, der aber nie durchgekommen ist, noch einmal
 * stellen.
 *
 * Der Fall: die Wildcard aus der Einrichtung scheiterte (DNS-Hook, Token,
 * Kontingent). acme.sh behält den Eintrag mit Domains und ohne
 * Ausstellungsdatum, ein Zertifikat gibt es nicht. Jedes Ziel darunter bekam
 * deshalb ein eigenes, und ohne diesen Weg bliebe die Wildcard für immer ein
 * Eintrag ohne Zertifikat: einen Antrag ohne Ziel stellt sonst nur der
 * Assistent.
 *
 * Nur für einen nie ausgestellten Eintrag und nur mit dessen Domains. Was
 * ausgestellt ist, erneuert acme.sh selbst; ein beliebiges neues Zertifikat
 * ohne Ziel ist nicht der Zweck. Derselbe Lauf wie aus dem Assistenten
 * (`action: 'certificate'`), mit Vorabprüfung; den Eintrag in die Historie
 * schreibt der Lauf.
 */
export async function reissueCertificate(
  body: { mainDomain?: unknown; dnsHook?: unknown },
  actor: HaproxyActor
): Promise<{ runId: string }> {
  const mainDomain = typeof body.mainDomain === 'string' ? body.mainDomain.trim().toLowerCase() : '';
  if (!mainDomain) throw new ApiError(msg('Es wurde kein Zertifikat angegeben.'));

  const server = localServer();
  const { acme } = await readCertificateInventory(server);
  const entry = acme.find((cert) => cert.mainDomain.toLowerCase() === mainDomain);
  if (!entry) throw new ApiError(msg('acme.sh führt kein Zertifikat für {domain}.', { domain: mainDomain }), 404);
  if (entry.createdAt !== null) {
    throw new ApiError(msg('Das Zertifikat für {domain} ist ausgestellt. acme.sh erneuert es selbst.', { domain: mainDomain }), 409);
  }

  // Wie beim Anlegen eines Ziels: ohne Angabe nimmt die Regel den einen eingerichteten Hook.
  const dnsHook = typeof body.dnsHook === 'string' && body.dnsHook.trim() ? body.dnsHook.trim() : null;
  const challenge = challengeFor(await getSettings(), dnsHook);
  await precheckCertificate(server, entry.domains, challenge);

  const run = await startHaproxyRun({
    server,
    action: 'certificate',
    serviceId: entry.mainDomain,
    certificateDomains: entry.domains,
    challenge,
    actor,
  });

  return { runId: run.$id };
}
