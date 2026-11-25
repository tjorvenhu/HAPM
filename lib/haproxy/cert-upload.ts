/**
 * Hochgeladene Zertifikate: prüfen, bevor sie auf die Platte gehen, und
 * wiedererkennen, wenn sie dort liegen.
 *
 * ── Wozu es sie gibt ──
 *
 * Nicht jede Installation kann über ACME ausstellen. Eine interne ohne
 * DNS-Anbieter mit API erreicht Let's Encrypt weder über HTTP noch über DNS,
 * und manche Netze haben eine eigene CA ohne ACME. Dann bringt der Betreiber
 * das Zertifikat mit: PEM mit Kette und der private Schlüssel.
 *
 * ── Die Platte ist die Wahrheit, auch hier ──
 *
 * Es gibt keine Collection dahinter. Ein hochgeladenes Zertifikat ist eine
 * PEM-Datei in `/etc/haproxy/certs`, die acme.sh nicht führt. Gelesen wird bei
 * jedem Aufruf, aus demselben Grund wie bei `haproxy.cfg` und `acme.sh --list`:
 * eine Spiegelung wäre genau dann falsch, wenn jemand von Hand eine Datei
 * hingelegt oder weggenommen hat. Das heißt auch: eine PEM-Datei, die jemand
 * von Hand dort abgelegt hat, zählt als hochgeladen. Sie verhält sich genauso
 * (niemand erneuert sie, ersetzt und entfernt wird sie hier).
 *
 * ── Geprüft wird mit node:crypto, nicht mit HAProxy ──
 *
 * Erst nach dem Neuladen zu merken, dass der Schlüssel nicht passt, hieße ein
 * HAProxy, das die Datei ablehnt, und `haproxy -c` scheitert dann an der
 * ganzen Konfiguration, nicht an diesem Zertifikat. Vorher geprüft wird
 * deshalb, was HAProxy auch prüft (lesbar, Schlüssel passt) und was es nicht
 * prüft, ein Browser aber schon (abgelaufen, Reihenfolge der Kette).
 *
 * Gelesen wird beim Auflisten nur das erste Zertifikat jeder Datei
 * (`certListingCommand`), nie der Schlüssel: für die Liste braucht es ihn
 * nicht, und was nicht gelesen wird, kann nicht versehentlich in einer
 * Antwort oder einem Log landen.
 */

import { X509Certificate, createPrivateKey, type KeyObject } from 'node:crypto';
import { msg, type Message } from '../i18n/translate';
import { shellEscape } from '../shell';
import { isValidDomain } from './config';
import { pemFileName, type AcmeCertificate } from './certs';

/** Das Platzhalter-Zertifikat aus `lib/bootstrap.ts`. Es gehört niemandem und wird nie angezeigt. */
export const FALLBACK_PEM_NAME = '000-hapm-default.pem';

/** Ein Zertifikat und sein Schlüssel zusammen: mehr ist eine Kette nie. */
const MAX_INPUT = 100_000;

export interface UploadInput {
  /** PEM, das Zertifikat zuerst, danach die Kette. Darf den Schlüssel mit enthalten. */
  certificate: string;
  /** PEM. Leer, wenn er in `certificate` steht. */
  privateKey: string;
}

export interface InspectedUpload {
  /** Nach ihr heißt die Datei (`pemFileName`). */
  mainDomain: string;
  domains: string[];
  notBefore: string;
  notAfter: string;
  issuer: string;
  /** Der Dateiname in `/etc/haproxy/certs`. */
  file: string;
  /** Was auf die Platte geht: Zertifikat, Kette, Schlüssel (PKCS#8). */
  pem: string;
}

export type UploadCheck = { ok: true; value: InspectedUpload } | { ok: false; message: Message };

const CERT_BLOCK = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g;
const KEY_BLOCK = /-----BEGIN ([A-Z ]*)PRIVATE KEY-----[\s\S]+?-----END \1PRIVATE KEY-----/g;

function fail(message: Message): UploadCheck {
  return { ok: false, message };
}

/** Die DNS-Namen aus `subjectAltName` (`DNS:a.example, IP Address:…`). Node setzt sie in Anführungszeichen, wenn sie Sonderzeichen tragen. */
export function sanDnsNames(subjectAltName: string | undefined): string[] {
  if (!subjectAltName) return [];
  return subjectAltName
    .split(/,\s*/)
    .filter((entry) => entry.startsWith('DNS:'))
    .map((entry) => entry.slice(4).replace(/^"(.*)"$/, '$1').trim().toLowerCase())
    .filter(Boolean);
}

/** Der CN aus `subject` (`CN=app.example.org\nO=…`). */
function commonName(subject: string): string | null {
  const line = subject.split('\n').find((part) => part.startsWith('CN='));
  return line ? line.slice(3).trim().toLowerCase() : null;
}

/** Die Domains eines Zertifikats: die SANs, ohne sie der CN. Die Hauptdomain ist der CN, wenn er dabei ist. */
export function certificateNames(cert: X509Certificate): { mainDomain: string | null; domains: string[] } {
  const sans = sanDnsNames(cert.subjectAltName);
  const cn = commonName(cert.subject);
  const domains = sans.length > 0 ? [...new Set(sans)] : cn ? [cn] : [];
  const mainDomain = cn && domains.includes(cn) ? cn : (domains[0] ?? null);
  // Die Hauptdomain zuerst: nach ihr heißt die Datei, und so steht sie auch bei acme.sh.
  return { mainDomain, domains: mainDomain ? [mainDomain, ...domains.filter((d) => d !== mainDomain)] : domains };
}

function issuerName(cert: X509Certificate): string {
  const parts = cert.issuer.split('\n');
  return (parts.find((part) => part.startsWith('CN=')) ?? parts.find((part) => part.startsWith('O=')) ?? cert.issuer)
    .replace(/^(CN|O)=/, '')
    .trim();
}

/**
 * Was hochgeladen wurde, geprüft und in der Form, in der es auf die Platte geht.
 *
 * Der Schlüssel darf auch im Feld des Zertifikats stehen: wer eine fertige
 * PEM-Datei für HAProxy hat, lädt sie als Ganzes hoch.
 */
export function inspectUpload(input: UploadInput, now: number): UploadCheck {
  const certText = input.certificate.trim();
  const keyText = input.privateKey.trim();
  if (!certText) return fail(msg('Bitte fügen Sie das Zertifikat ein.'));
  if (certText.length + keyText.length > MAX_INPUT) return fail(msg('Zertifikat und Schlüssel sind zusammen größer als 100 KB. Das ist keine Kette mehr.'));

  const blocks = certText.match(CERT_BLOCK) ?? [];
  if (blocks.length === 0) {
    return fail(msg('Im Feld für das Zertifikat steht kein PEM-Zertifikat. Erwartet wird ein Text, der mit -----BEGIN CERTIFICATE----- beginnt.'));
  }
  const keyBlocks = [...(keyText.match(KEY_BLOCK) ?? []), ...(keyText ? [] : (certText.match(KEY_BLOCK) ?? []))];
  if (keyBlocks.length === 0) {
    return fail(msg('Es fehlt der private Schlüssel. Erwartet wird ein Text, der mit -----BEGIN PRIVATE KEY----- oder ähnlich beginnt.'));
  }
  if (keyBlocks.length > 1) return fail(msg('Es steht mehr als ein privater Schlüssel da. Bitte nur den Schlüssel zu diesem Zertifikat.'));
  if (/ENCRYPTED/.test(keyBlocks[0])) {
    return fail(msg('Der private Schlüssel ist mit einem Passwort verschlüsselt. HAProxy kann ihn so nicht laden. Bitte laden Sie ihn unverschlüsselt hoch.'));
  }

  let certs: X509Certificate[];
  try {
    certs = blocks.map((block) => new X509Certificate(block));
  } catch {
    return fail(msg('Das Zertifikat lässt sich nicht lesen. Ist der Text vollständig kopiert?'));
  }

  let key: KeyObject;
  try {
    key = createPrivateKey({ key: keyBlocks[0], format: 'pem' });
  } catch {
    return fail(msg('Der private Schlüssel lässt sich nicht lesen. Ist der Text vollständig kopiert?'));
  }

  // Das Zertifikat zum Schlüssel gehört nach vorn: HAProxy nimmt das erste der Datei als das der Domain.
  const leafIndex = certs.findIndex((cert) => {
    try {
      return cert.checkPrivateKey(key);
    } catch {
      return false;
    }
  });
  if (leafIndex === -1) return fail(msg('Der private Schlüssel gehört zu keinem der Zertifikate.'));
  const leaf = certs[leafIndex];
  const chain = certs.filter((_, index) => index !== leafIndex);
  const orderedBlocks = [blocks[leafIndex], ...blocks.filter((_, index) => index !== leafIndex)];

  if (chain.length > 0 && !leaf.checkIssued(chain[0])) {
    return fail(msg('Die Kette passt nicht: das Zertifikat nach dem der Domain hat es nicht ausgestellt. Erwartet wird zuerst das Zertifikat, dann das Zwischenzertifikat, das es ausgestellt hat.'));
  }

  const notBefore = leaf.validFromDate;
  const notAfter = leaf.validToDate;
  if (notAfter.getTime() <= now) {
    return fail(msg('Das Zertifikat ist seit dem {date} abgelaufen.', { date: notAfter.toISOString().slice(0, 10) }));
  }
  if (notBefore.getTime() > now + 5 * 60_000) {
    return fail(msg('Das Zertifikat gilt erst ab dem {date}.', { date: notBefore.toISOString().slice(0, 10) }));
  }

  const { mainDomain, domains } = certificateNames(leaf);
  if (!mainDomain) return fail(msg('Das Zertifikat nennt keinen Domainnamen. Für eine IP-Adresse allein taugt es hier nicht.'));
  const invalid = domains.find((domain) => !isValidDomain(domain));
  if (invalid) return fail(msg('"{domain}" im Zertifikat ist kein Domainname, den HAPM einem Ziel zuordnen kann.', { domain: invalid }));

  const exported = key.export({ type: 'pkcs8', format: 'pem' }).toString().trim();
  return {
    ok: true,
    value: {
      mainDomain,
      domains,
      notBefore: notBefore.toISOString(),
      notAfter: notAfter.toISOString(),
      issuer: issuerName(leaf),
      file: pemFileName(mainDomain),
      pem: `${[...orderedBlocks.map((block) => block.trim()), exported].join('\n')}\n`,
    },
  };
}

/* ── Auf der Platte ── */

/** Eine PEM-Datei in `/etc/haproxy/certs`, die acme.sh nicht führt. */
export interface UploadedCertificate {
  file: string;
  /** `null`: die Datei ließ sich nicht lesen. Dann deckt sie nichts ab. */
  mainDomain: string | null;
  domains: string[];
  notBefore: string | null;
  notAfter: string | null;
  issuer: string | null;
}

/** Ein Dateiname, wie `pemFileName` ihn bildet. Alles andere wird nicht angefasst. */
export function isPemFileName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9._-]*\.pem$/.test(name) && !name.includes('..');
}

const LISTING_MARK = '==> ';

/**
 * Das erste Zertifikat jeder PEM-Datei, je mit `==> <name>` davor. Der
 * Schlüssel bleibt in der Datei: `awk` hört nach dem ersten Zertifikat auf.
 */
export function certListingCommand(dir: string): string {
  const quoted = shellEscape(dir);
  return (
    `for f in ${quoted}/*.pem; do [ -f "$f" ] || continue; printf '${LISTING_MARK}%s\\n' "\${f##*/}"; ` +
    `awk '/-----BEGIN CERTIFICATE-----/{p=1} p{print} /-----END CERTIFICATE-----/{if(p) exit}' "$f"; done`
  );
}

/** Die Ausgabe von `certListingCommand` in Dateien zerlegen. */
export function parseCertListing(raw: string): { file: string; pem: string }[] {
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

/** Was eine gelesene Datei über sich sagt. Unlesbar heißt: alles `null`, nicht „abgelaufen". */
export function describePem(file: string, pem: string): UploadedCertificate {
  try {
    const cert = new X509Certificate(pem);
    const { mainDomain, domains } = certificateNames(cert);
    return {
      file,
      mainDomain,
      domains,
      notBefore: cert.validFromDate.toISOString(),
      notAfter: cert.validToDate.toISOString(),
      issuer: issuerName(cert),
    };
  } catch {
    return { file, mainDomain: null, domains: [], notBefore: null, notAfter: null, issuer: null };
  }
}

/**
 * Welche Dateien hochgeladen sind: alle außer dem Platzhalter und denen, die
 * acme.sh ausgerollt hat. Ein Antrag, der gescheitert ist, steht bei acme.sh
 * ohne Ausstellungsdatum in der Liste; eine Datei unter seinem Namen ist dann
 * nicht von acme.sh.
 */
export function uploadedCertificates(
  listing: { file: string; pem: string }[],
  acme: AcmeCertificate[]
): UploadedCertificate[] {
  const managed = new Set(acme.filter((cert) => cert.createdAt !== null).map((cert) => pemFileName(cert.mainDomain)));
  return listing
    .filter((entry) => isPemFileName(entry.file) && entry.file !== FALLBACK_PEM_NAME && !managed.has(entry.file))
    .map((entry) => describePem(entry.file, entry.pem))
    .sort((a, b) => a.file.localeCompare(b.file));
}

/** Eine PEM-Datei, die HAProxy lädt, mit den Namen ihres Zertifikats. */
export interface ServedFile {
  file: string;
  domains: string[];
}

/**
 * Was HAProxy aus `/etc/haproxy/certs` lädt: was acme.sh ausgestellt und
 * ausgerollt hat, dazu jede hochgeladene Datei, auch eine abgelaufene (HAProxy
 * liefert sie trotzdem aus). Ein Antrag ohne Ausstellungsdatum hat keine Datei,
 * und ein ausgestelltes Zertifikat ohne Datei liefert HAProxy nicht aus.
 *
 * `deployed` sind die Dateinamen im Verzeichnis, `null` heißt unbekannt: dann
 * gilt, was acme.sh ausgestellt hat, als ausgerollt, statt ein Fehlen zu
 * behaupten, das niemand gesehen hat.
 *
 * Sortiert nach Dateinamen, Byte für Byte: in dieser Reihenfolge liest HAProxy
 * das Verzeichnis, und bei gleichen Namen gewinnt die erste Datei
 * (`servedCertificate`).
 */
export function servedFiles(
  acme: AcmeCertificate[],
  uploaded: UploadedCertificate[],
  deployed: string[] | null
): ServedFile[] {
  const files: ServedFile[] = [];
  for (const cert of acme) {
    if (cert.createdAt === null) continue;
    const file = pemFileName(cert.mainDomain);
    if (deployed !== null && !deployed.includes(file)) continue;
    files.push({ file, domains: cert.domains });
  }
  for (const cert of uploaded) files.push({ file: cert.file, domains: cert.domains });
  return files.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * Die hochgeladenen Zertifikate in der Form, die `findCertificateFor` und
 * `certificateUsers` lesen. Nur gültige: ein abgelaufenes deckt nichts ab,
 * sonst beantragte HAPM für die Domain nie wieder eins.
 */
export function uploadedCoverage(uploaded: UploadedCertificate[], now: number): AcmeCertificate[] {
  return uploaded
    .filter((cert) => cert.mainDomain !== null && cert.notAfter !== null && Date.parse(cert.notAfter) > now)
    .map((cert) => ({
      mainDomain: cert.mainDomain as string,
      domains: cert.domains,
      keyLength: null,
      createdAt: cert.notBefore,
      renewAt: null,
    }));
}
