/**
 * Zertifizierungsstellen hinterlegen, ersetzen, entfernen und auflisten: die
 * Seite „Zertifikate", die interne API
 * (`/api/internal/haproxy/certificate-authorities`) und der MCP-Server rufen
 * dieselben Funktionen. Sie schreiben auch das Protokoll.
 *
 * Anders als bei den Zertifikaten der Domains darf die API hier hochladen: in
 * der Datei steht kein Geheimnis (`inspectCaUpload` lehnt einen privaten
 * Schlüssel ab), und ein Key kann ein Ziel ohnehin auf „nicht prüfen" stellen.
 * Eine Zertifizierungsstelle zu hinterlegen gibt ihm also nichts, was er nicht
 * hatte. Wer eine interne Root auf mehrere Installationen verteilt, tut das
 * mit einem Skript.
 */

import { ApiError } from '../api';
import { logAudit } from '../audit';
import { localServer } from '../helpers';
import { germanText, type Params, type Translatable } from '../i18n/translate';
import { scopeSlug } from './config';
import {
  CA_WARN_DAYS,
  caDaysLeft,
  caUsers,
  inspectCaUpload,
  normalizeCaName,
  validateCaName,
  type BackendCa,
  type CaCertificate,
} from './backend-ca';
import { probeProxy, readBackendCas, removeBackendCa, uploadBackendCa } from './provision';

/** Übersetzen in der Sprache des Aufrufers. */
type Translate = (text: Translatable, params?: Params) => string;

export interface CaActor {
  userId: string;
  userEmail: string;
  ip?: string;
}

/** Ein Ziel, das gegen die Zertifizierungsstelle prüft, mit dem, was ein Link zu ihm braucht. */
export interface CaUser {
  id: string;
  /** `null`: der Eintrag liegt außerhalb aller Gruppen und hat keine Seite. */
  slug: string | null;
}

export interface CaRow extends BackendCa {
  usedBy: CaUser[];
  /** Ganze Tage bis zum frühesten Ablauf. Negativ heißt abgelaufen, `null` unbekannt. */
  daysLeft: number | null;
}

export interface CaList {
  /** Ab so vielen Tagen vor dem Ablauf warnt die Seite. */
  warnDays: number;
  authorities: CaRow[];
  /** Gesetzt, wenn HAProxy oder der Ordner nicht lesbar war. Die Liste ist dann leer und heißt „unbekannt". */
  error: string | null;
}

/** Die hinterlegten Zertifizierungsstellen mit den Zielen, die sie benutzen. Nur lesend. */
export async function listCertificateAuthorities(t: Translate): Promise<CaList> {
  const server = localServer();
  try {
    const probe = await probeProxy(server);
    const authorities = await readBackendCas(server);
    if (authorities === null) {
      return { warnDays: CA_WARN_DAYS, authorities: [], error: t('Der Ordner der Zertifizierungsstellen ist nicht lesbar.') };
    }
    const now = Date.now();
    return {
      warnDays: CA_WARN_DAYS,
      authorities: authorities.map((ca) => ({
        ...ca,
        daysLeft: caDaysLeft(ca, now),
        usedBy: caUsers(ca.name, probe.services).map((service) => ({
          id: service.id,
          slug: service.scope ? scopeSlug(service.scope) : null,
        })),
      })),
      error: null,
    };
  } catch (err) {
    return {
      warnDays: CA_WARN_DAYS,
      authorities: [],
      error: err instanceof Error ? err.message : t('HAProxy ist nicht erreichbar.'),
    };
  }
}

export interface CaSaved {
  name: string;
  file: string;
  certificates: CaCertificate[];
  notAfter: string;
  /** Ob HAProxy neu geladen hat: nur, wenn ein Ziel die Datei schon benutzt. */
  reloaded: boolean;
  usedBy: string[];
  /** Was der Aufrufer wissen muss, etwa ein abgelaufenes Zertifikat im Bündel. In seiner Sprache. */
  warnings: string[];
}

/**
 * Eine Zertifizierungsstelle hinterlegen (`replace: false`) oder die Datei
 * einer hinterlegten austauschen (`replace: true`).
 */
export async function saveCertificateAuthority(
  body: { name?: unknown; certificate?: unknown; replace?: unknown },
  actor: CaActor,
  t: Translate
): Promise<CaSaved> {
  const checked = inspectCaUpload(
    {
      name: typeof body.name === 'string' ? body.name : '',
      certificate: typeof body.certificate === 'string' ? body.certificate : '',
    },
    Date.now()
  );
  if (!checked.ok) throw new ApiError(checked.message);
  const upload = checked.value;
  const replace = body.replace === true;

  const server = localServer();
  const result = await uploadBackendCa(server, upload, replace);

  await logAudit({
    ...actor,
    action: 'haproxy_ca_uploaded',
    resource: 'server',
    resourceId: server.$id,
    // Wer ihr vertraut und bis wann, nie der Inhalt. Der Fingerabdruck sagt, welche Datei es war.
    details:
      `${upload.name}${replace ? ' ersetzt' : ''}: ` +
      upload.certificates
        .map((cert) => `${cert.subject} (gültig bis ${cert.notAfter.slice(0, 10)}, SHA-256 ${cert.fingerprint})`)
        .join('; ') +
      (result.reloaded ? `, HAProxy neu geladen, benutzt von ${result.usedBy.join(', ') || 'einer Zeile von Hand'}` : '') +
      (upload.warnings.length > 0 ? `, Hinweise: ${upload.warnings.map(germanText).join(' ')}` : ''),
  });

  return {
    name: upload.name,
    file: upload.file,
    certificates: upload.certificates,
    notAfter: upload.notAfter,
    reloaded: result.reloaded,
    usedBy: result.usedBy,
    warnings: upload.warnings.map((warning) => t(warning)),
  };
}

/** Eine hinterlegte Zertifizierungsstelle entfernen. Ob sie noch benutzt wird, prüft `removeBackendCa` im Lock. */
export async function removeCertificateAuthority(name: string | null | undefined, actor: CaActor): Promise<{ name: string }> {
  const wanted = normalizeCaName(name ?? '');
  const invalid = validateCaName(wanted);
  if (invalid) throw new ApiError(invalid);

  const server = localServer();
  const removed = await removeBackendCa(server, wanted);

  await logAudit({
    ...actor,
    action: 'haproxy_ca_removed',
    resource: 'server',
    resourceId: server.$id,
    details: `${removed.name}: ${removed.certificates.map((cert) => cert.subject).join('; ') || 'unlesbar'}`,
  });

  return { name: removed.name };
}
