/**
 * Hinterlegte Zertifizierungsstellen: womit HAProxy das Zertifikat eines Ziels
 * prüft, wenn es weder öffentlich ausgestellt ist (`@system-ca`) noch ungeprüft
 * bleiben soll.
 *
 * ── Wozu es sie gibt ──
 *
 * Ein Ziel im eigenen Netz trägt meist ein Zertifikat aus einer internen CA.
 * Die CAs des Systems kennen sie nicht, also blieb bisher nur „HTTPS ohne
 * Prüfung". Hier wird die CA als PEM-Datei hinterlegt, und ein Ziel wählt sie
 * aus (`backendTls: 'ca:<name>'`, `config.ts`). Geschrieben wird
 * `ssl verify required ca-file /etc/haproxy/hapm-ca/<name>.pem`.
 *
 * ── Die Platte ist die Wahrheit ──
 *
 * Wie bei den hochgeladenen Zertifikaten (`cert-upload.ts`) steht keine
 * Collection dahinter. Eine Zertifizierungsstelle ist eine Datei in
 * `BACKEND_CA_DIR`, deren Name `isValidCaName` besteht. Gelesen wird bei jedem
 * Aufruf. Eine Datei, die jemand von Hand dorthin legt, zählt genauso, eine mit
 * anderem Namen wird nicht angefasst und nicht gezeigt.
 *
 * ── Kein Geheimnis ──
 *
 * In der Datei stehen nur Zertifikate. Ein privater Schlüssel wird abgelehnt,
 * bevor irgendetwas auf die Platte geht: der Schlüssel einer CA gehört nicht
 * auf einen Reverse-Proxy. Deshalb darf die Liste den ganzen Inhalt lesen und
 * die API hochladen, anders als bei den Zertifikaten der Domains.
 *
 * ── Geprüft wird mit node:crypto ──
 *
 * HAProxy lädt die Datei erst, wenn ein Ziel sie benutzt, und lehnt dann die
 * ganze Konfiguration ab, wenn sie nicht lesbar ist. Vorher geprüft wird, was
 * HAProxy dabei prüft (lesbares PEM), und was es nicht prüft, die Prüfung des
 * Ziels aber scheitern ließe: ein abgelaufenes Zertifikat und eines, das als
 * Vertrauensanker nicht taugt (weder CA noch selbst signiert).
 */

import { X509Certificate } from 'node:crypto';
import { msg, type Message } from '../i18n/translate';
import { shellEscape } from '../shell';
import { backendCaFile, isValidCaName, usedBackendCas, type HaproxyService } from './config';

/** Ein Bündel aus Root und Zwischenstellen ist ein paar KB. Mehr ist die Sammlung eines ganzen Systems. */
export const MAX_CA_INPUT = 300_000;

/** Ab hier gilt eine Zertifizierungsstelle als „läuft bald ab". Wie bei hochgeladenen Zertifikaten: niemand erneuert sie von selbst. */
export const CA_WARN_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

const CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const KEY_MARK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

/** Ein Zertifikat einer hinterlegten Datei, wie Liste und Protokoll es nennen. */
export interface CaCertificate {
  /** CN des Inhabers, ohne ihn die Organisation, ohne beides der ganze Name. */
  subject: string;
  issuer: string;
  notBefore: string;
  notAfter: string;
  /** SHA-256, wie `openssl x509 -fingerprint -sha256` ihn zeigt. */
  fingerprint: string;
  /** Aussteller und Inhaber sind derselbe: eine Root oder ein selbst signiertes Zertifikat eines Ziels. */
  selfSigned: boolean;
  /**
   * Ob es als Zertifizierungsstelle gilt: `CA:TRUE` in den Basic Constraints,
   * oder eine selbst signierte Root der Fassung 1, die keine Erweiterungen
   * tragen kann (so entscheidet auch OpenSSL, `X509_check_ca`).
   */
  ca: boolean;
}

/** Eine hinterlegte Zertifizierungsstelle, gelesen von der Platte. */
export interface BackendCa {
  name: string;
  /** Der Pfad, der in der server-Zeile steht. */
  file: string;
  /** Leer heißt: die Datei ließ sich nicht lesen. Dann prüft HAProxy damit nichts. */
  certificates: CaCertificate[];
  /** Der früheste Ablauf unter den Zertifikaten. `null`: nicht lesbar. */
  notAfter: string | null;
}

export interface CaUploadInput {
  name: string;
  /** PEM: ein Zertifikat oder mehrere hintereinander. */
  certificate: string;
}

export interface InspectedCa {
  name: string;
  file: string;
  certificates: CaCertificate[];
  notAfter: string;
  /** Was auf die Platte geht: jedes Zertifikat einmal, normalisiert. */
  pem: string;
  /** Was der Benutzer wissen muss, ohne dass es das Hinterlegen verhindert. */
  warnings: Message[];
}

export type CaCheck = { ok: true; value: InspectedCa } | { ok: false; message: Message };

function fail(message: Message): CaCheck {
  return { ok: false, message };
}

/** `CN=…`, sonst `O=…`, sonst der ganze Name in einer Zeile. */
function displayName(distinguishedName: string): string {
  const parts = distinguishedName.split('\n');
  const named = parts.find((part) => part.startsWith('CN=')) ?? parts.find((part) => part.startsWith('O='));
  return named ? named.replace(/^(CN|O)=/, '').trim() : parts.join(', ');
}

function isSelfSigned(cert: X509Certificate): boolean {
  try {
    return cert.checkIssued(cert) && cert.verify(cert.publicKey);
  } catch {
    return false;
  }
}

/**
 * Ob das Zertifikat die Fassung 1 hat. In DER steht die Fassung als erstes
 * Feld des inneren Blocks, markiert mit `[0]` (0xA0), und fehlt bei Fassung 1
 * ganz. `X509Certificate` nennt sie nicht, und `ca` ist dort einfach `false`.
 */
function isVersion1(raw: Buffer): boolean {
  let at = 0;
  for (let depth = 0; depth < 2; depth++) {
    const length = raw[at + 1];
    at += 2 + (length !== undefined && length & 0x80 ? length & 0x7f : 0);
  }
  return raw[at] !== 0xa0;
}

function describe(cert: X509Certificate): CaCertificate {
  const selfSigned = isSelfSigned(cert);
  return {
    subject: displayName(cert.subject),
    issuer: displayName(cert.issuer),
    notBefore: cert.validFromDate.toISOString(),
    notAfter: cert.validToDate.toISOString(),
    fingerprint: cert.fingerprint256,
    selfSigned,
    ca: cert.ca || (selfSigned && isVersion1(cert.raw)),
  };
}

function earliest(certificates: CaCertificate[]): string | null {
  if (certificates.length === 0) return null;
  return certificates.map((cert) => cert.notAfter).sort()[0];
}

/** Der Name, wie er gespeichert wird: ohne Leerraum am Rand, klein. */
export function normalizeCaName(input: string): string {
  return input.trim().toLowerCase();
}

/** Die Meldung zu einem Namen, den HAPM nicht nimmt, oder `null`. Erwartet die normalisierte Form. */
export function validateCaName(name: string): Message | null {
  if (!name) return msg('Bitte geben Sie der Zertifizierungsstelle einen Namen.');
  if (!isValidCaName(name)) {
    return msg(
      'Der Name darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten, höchstens 40 Zeichen, und beginnt und endet mit einem Buchstaben oder einer Ziffer.'
    );
  }
  return null;
}

/**
 * Was hochgeladen wurde, geprüft und in der Form, in der es auf die Platte geht.
 *
 * Abgelehnt wird, womit HAProxy nichts erfolgreich prüfen könnte: kein
 * Zertifikat, ein privater Schlüssel, ein abgelaufenes Zertifikat, ein
 * Zertifikat eines Servers, das eine CA ausgestellt hat (OpenSSL vertraut ihm
 * nicht als Anker).
 * Ein selbst signiertes Zertifikat eines Ziels geht dagegen: genau dieses
 * Zertifikat wird dann angenommen, und nur dieses.
 */
export function inspectCaUpload(input: CaUploadInput, now: number): CaCheck {
  const name = normalizeCaName(input.name);
  const invalidName = validateCaName(name);
  if (invalidName) return fail(invalidName);

  const text = input.certificate.trim();
  if (!text) return fail(msg('Bitte fügen Sie das Zertifikat der Zertifizierungsstelle ein.'));
  if (text.length > MAX_CA_INPUT) {
    return fail(msg('Die Datei ist größer als 300 KB. Hinterlegen Sie nur die Zertifizierungsstelle, die Ihre Ziele ausstellt, mit ihren Zwischenstellen.'));
  }
  if (KEY_MARK.test(text)) {
    return fail(
      msg('Hier steht ein privater Schlüssel. Hinterlegt wird nur das Zertifikat der Zertifizierungsstelle, ihr Schlüssel gehört nicht auf diesen Server.')
    );
  }

  const blocks = text.match(CERT_BLOCK) ?? [];
  if (blocks.length === 0) {
    return fail(msg('Hier steht kein PEM-Zertifikat. Erwartet wird ein Text, der mit -----BEGIN CERTIFICATE----- beginnt.'));
  }

  let certs: X509Certificate[];
  try {
    certs = blocks.map((block) => new X509Certificate(block));
  } catch {
    return fail(msg('Das Zertifikat lässt sich nicht lesen. Ist der Text vollständig kopiert?'));
  }

  // Dasselbe Zertifikat zweimal ändert nichts, steht aber zweimal in der Liste.
  const seen = new Set<string>();
  const unique = certs.filter((cert) => {
    if (seen.has(cert.fingerprint256)) return false;
    seen.add(cert.fingerprint256);
    return true;
  });
  const certificates = unique.map(describe);

  const unusable = certificates.find((cert) => !cert.ca && !cert.selfSigned);
  if (unusable) {
    return fail(
      msg(
        '„{subject}" ist das Zertifikat eines Servers und keine Zertifizierungsstelle. Hinterlegen Sie das Zertifikat der Stelle, die es ausgestellt hat ({issuer}).',
        { subject: unusable.subject, issuer: unusable.issuer }
      )
    );
  }

  // Auch ein einzelnes abgelaufenes Zertifikat im Bündel wird abgelehnt. Was es
  // bestätigen sollte, lehnte HAProxy ab, und die Liste zeigte die Stelle ab
  // dem ersten Tag als abgelaufen (der früheste Ablauf zählt, `earliest`).
  const expired = certificates.find((cert) => Date.parse(cert.notAfter) <= now);
  if (expired) {
    return fail(
      certificates.length === 1
        ? msg('Das Zertifikat ist seit dem {date} abgelaufen. HAProxy lehnte damit jedes Ziel ab.', {
            date: expired.notAfter.slice(0, 10),
          })
        : msg('„{subject}" in der Datei ist seit dem {date} abgelaufen. Nehmen Sie es heraus: HAProxy bestätigt damit kein Ziel.', {
            subject: expired.subject,
            date: expired.notAfter.slice(0, 10),
          })
    );
  }
  const pending = certificates.filter((cert) => Date.parse(cert.notBefore) > now + 5 * 60_000);
  if (pending.length === certificates.length) {
    return fail(msg('Das Zertifikat gilt erst ab dem {date}.', { date: pending[0].notBefore.slice(0, 10) }));
  }

  const warnings: Message[] = [];
  for (const cert of certificates) {
    if (!cert.ca && cert.selfSigned) {
      warnings.push(
        msg('„{subject}" ist ein selbst signiertes Zertifikat eines Servers. HAProxy nimmt damit genau dieses Zertifikat an, kein anderes.', {
          subject: cert.subject,
        })
      );
    }
  }

  return {
    ok: true,
    value: {
      name,
      file: backendCaFile(name),
      certificates,
      notAfter: earliest(certificates) as string,
      pem: `${unique.map((cert) => cert.toString().trim()).join('\n')}\n`,
      warnings,
    },
  };
}

/* ── Auf der Platte ── */

const LISTING_MARK = '==> ';

/**
 * Jede PEM-Datei des Ordners ganz, je mit `==> <name>` davor. Ganz, weil eine
 * Datei mehrere Zertifikate tragen kann und keines davon ein Geheimnis ist.
 * Begrenzt, damit eine fremde, große Datei die Antwort nicht füllt.
 */
export function caListingCommand(dir: string): string {
  const quoted = shellEscape(dir);
  return (
    `for f in ${quoted}/*.pem; do [ -f "$f" ] || continue; printf '${LISTING_MARK}%s\\n' "\${f##*/}"; ` +
    `head -c ${MAX_CA_INPUT} "$f"; printf '\\n'; done`
  );
}

/** Die Ausgabe von `caListingCommand` in Dateien zerlegen. */
export function parseCaListing(raw: string): { file: string; pem: string }[] {
  const entries: { file: string; pem: string }[] = [];
  let current: { file: string; lines: string[] } | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith(LISTING_MARK)) {
      if (current) entries.push({ file: current.file, pem: current.lines.join('\n').trim() });
      current = { file: line.slice(LISTING_MARK.length).trim(), lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) entries.push({ file: current.file, pem: current.lines.join('\n').trim() });
  return entries;
}

/**
 * Die hinterlegten Zertifizierungsstellen aus der Liste des Ordners. Eine
 * Datei, deren Name keiner ist, den HAPM vergibt, gehört nicht dazu. Eine
 * unlesbare gehört dazu und hat keine Zertifikate: sie liegt da, und ein Ziel
 * könnte sie nennen.
 */
export function listedCas(listing: { file: string; pem: string }[]): BackendCa[] {
  const out: BackendCa[] = [];
  for (const entry of listing) {
    if (!entry.file.endsWith('.pem')) continue;
    const name = entry.file.slice(0, -'.pem'.length);
    if (!isValidCaName(name)) continue;
    let certificates: CaCertificate[] = [];
    try {
      certificates = (entry.pem.match(CERT_BLOCK) ?? []).map((block) => describe(new X509Certificate(block)));
    } catch {
      certificates = [];
    }
    out.push({ name, file: backendCaFile(name), certificates, notAfter: earliest(certificates) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Die Ziele, die gegen diese Zertifizierungsstelle prüfen, im Backend oder in einer Pfad-Regel. */
export function caUsers(name: string, services: HaproxyService[]): HaproxyService[] {
  return services.filter((service) => usedBackendCas(service).includes(name));
}

/**
 * Ob `haproxy.cfg` die Datei irgendwo nennt, auch in einer Zeile, die HAPM
 * nicht geschrieben hat. Danach richtet sich, ob sie entfernt werden darf und
 * ob nach dem Ersetzen neu geladen wird: fehlte sie, lüde HAProxy die
 * Konfiguration nicht mehr.
 */
export function caReferenced(name: string, config: string): boolean {
  const file = backendCaFile(name);
  return config.split('\n').some((line) => {
    const text = line.trim();
    return !text.startsWith('#') && text.split(/\s+/).includes(file);
  });
}

/** Ganze Tage bis zum Ablauf, abgerundet. Negativ heißt abgelaufen, `null` unbekannt. */
export function caDaysLeft(ca: Pick<BackendCa, 'notAfter'>, now: number): number | null {
  if (!ca.notAfter) return null;
  const expiry = Date.parse(ca.notAfter);
  return Number.isNaN(expiry) ? null : Math.floor((expiry - now) / DAY_MS);
}
