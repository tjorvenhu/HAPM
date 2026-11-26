/**
 * Der Umschlag, in dem zwei Knoten miteinander sprechen.
 *
 * ── Warum nicht einfach HTTPS ──
 *
 * Ein Paket trägt die privaten Schlüssel aller Zertifikate. Ein Folgeknoten ist
 * aber oft nur unter `http://<adresse>:7080` zu erreichen: nach dem ersten
 * Abgleich trägt er die `haproxy.cfg` des Hauptknotens, eine eigene Domain für
 * seine Oberfläche hat er dann nicht. Der Schutz darf deshalb nicht an der
 * Leitung hängen. Jede Anfrage und jede Antwort ist mit dem Kopplungsschlüssel
 * verschlüsselt und gegen Veränderung gesichert (AES-256-GCM), gleich ob
 * darunter TLS liegt.
 *
 * ── Der Kopplungsschlüssel ──
 *
 * Entsteht auf dem Folgeknoten, wird dort einmal gezeigt und auf dem
 * Hauptknoten eingetragen. Beide halten ihn verschlüsselt (`lib/crypto.ts`):
 * anders als bei einem API-Key reicht ein Hash nicht, denn mit dem Schlüssel
 * wird entschlüsselt. Aus ihm entstehen drei Schlüssel (HKDF), damit dieselben
 * Bytes nie für zwei Zwecke stehen: einer für die Kopfzeile, einer für die
 * Anfrage, einer für die Antwort.
 *
 * ── Die Kopfzeile ──
 *
 * `X-Hapm-Sync: v1;<zeit>;<einmalwert>;<art>;<länge>;<mac>`. Der MAC geht über
 * alle Felder davor. Er steht in der Kopfzeile und nicht nur im Rumpf, damit
 * der Empfänger einen Fremden abweist, bevor er einen Rumpf von vielen
 * Megabyte liest: GCM sagt erst am Ende, ob etwas stimmt. Die Länge ist mit
 * gesichert, mehr liest der Empfänger nicht.
 *
 * ── Gegen Wiedereinspielen ──
 *
 * Die Zeit darf fünf Minuten abweichen (die Uhren beider Knoten müssen stimmen,
 * wie für Zertifikate auch), und ein Einmalwert gilt nur einmal
 * (`NonceCache`, im Speicher des Prozesses). Was ein Neustart davon vergisst,
 * fängt die laufende Nummer des Pakets ab: ein Folgeknoten nimmt kein Paket,
 * das älter ist als das zuletzt übernommene (`lib/sync/apply.ts`).
 *
 * Rein bis auf `node:crypto`, damit `tests/sync/envelope.test.ts` jede Regel
 * nachrechnen kann.
 */

import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

/** Erkennbar wie ein API-Key (`hapm_`), aber nicht mit ihm zu verwechseln. */
export const PAIRING_PREFIX = 'hapmsync_';
const PAIRING_BYTES = 32;
const PAIRING_FORM = /^hapmsync_[A-Za-z0-9_-]{43}$/;

export function generatePairingKey(): string {
  return `${PAIRING_PREFIX}${randomBytes(PAIRING_BYTES).toString('base64url')}`;
}

export function isPairingKey(value: unknown): value is string {
  return typeof value === 'string' && PAIRING_FORM.test(value);
}

export const SYNC_HEADER = 'x-hapm-sync';
const VERSION = 'v1';

/** So weit dürfen die Uhren zweier Knoten auseinanderliegen. */
export const MAX_SKEW_MS = 5 * 60_000;

/** `status`: Auskunft über den Knoten. `apply`: ein Paket zum Übernehmen. */
export const ENVELOPE_KINDS = ['status', 'apply'] as const;
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Was ein Umschlag um den Inhalt herum braucht. */
export const ENVELOPE_OVERHEAD = IV_BYTES + TAG_BYTES;

interface Keys {
  mac: Buffer;
  request: Buffer;
  response: Buffer;
}

function deriveKeys(pairingKey: string): Keys {
  const secret = Buffer.from(pairingKey, 'utf8');
  const salt = Buffer.from('hapm-sync-v1', 'utf8');
  const derive = (info: string) => Buffer.from(hkdfSync('sha256', secret, salt, Buffer.from(info, 'utf8'), 32));
  return { mac: derive('header'), request: derive('request'), response: derive('response') };
}

export interface EnvelopeHeader {
  ts: number;
  nonce: string;
  kind: EnvelopeKind;
  /** Länge des Rumpfs in Bytes, wie er über die Leitung geht. */
  length: number;
  mac: string;
}

function canonical(header: Pick<EnvelopeHeader, 'ts' | 'nonce' | 'kind' | 'length'>): string {
  return `hapm-sync ${VERSION}\n${header.ts}\n${header.nonce}\n${header.kind}\n${header.length}`;
}

function macOf(keys: Keys, header: Pick<EnvelopeHeader, 'ts' | 'nonce' | 'kind' | 'length'>): string {
  return createHmac('sha256', keys.mac).update(canonical(header)).digest('base64url');
}

function encrypt(key: Buffer, aad: string, plain: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

function decrypt(key: Buffer, aad: string, body: Buffer): Buffer {
  if (body.length < ENVELOPE_OVERHEAD) throw new Error('Der Umschlag ist zu kurz.');
  const decipher = createDecipheriv('aes-256-gcm', key, body.subarray(0, IV_BYTES));
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(body.subarray(IV_BYTES, ENVELOPE_OVERHEAD));
  return Buffer.concat([decipher.update(body.subarray(ENVELOPE_OVERHEAD)), decipher.final()]);
}

export interface SealedRequest {
  /** Der Wert der Kopfzeile `X-Hapm-Sync`. */
  header: string;
  body: Buffer;
  /** Der Einmalwert: an ihn ist die Antwort gebunden. */
  nonce: string;
}

/** Eine Anfrage verpacken. `now` nur für Tests. */
export function sealRequest(pairingKey: string, kind: EnvelopeKind, payload: Buffer, now: number = Date.now()): SealedRequest {
  const keys = deriveKeys(pairingKey);
  const nonce = randomBytes(16).toString('base64url');
  const fields = { ts: now, nonce, kind, length: payload.length + ENVELOPE_OVERHEAD };
  const body = encrypt(keys.request, canonical(fields), payload);
  return { header: [VERSION, fields.ts, nonce, kind, fields.length, macOf(keys, fields)].join(';'), body, nonce };
}

/** Die Kopfzeile lesen. `null` bei jeder Form, die HAPM nicht schreibt. */
export function parseHeader(value: string | null | undefined): EnvelopeHeader | null {
  if (!value || value.length > 400) return null;
  const parts = value.split(';');
  if (parts.length !== 6 || parts[0] !== VERSION) return null;
  const [, ts, nonce, kind, length, mac] = parts;
  if (!/^\d{10,16}$/.test(ts) || !/^\d{1,12}$/.test(length)) return null;
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[A-Za-z0-9_-]{43}$/.test(mac)) return null;
  if (!(ENVELOPE_KINDS as readonly string[]).includes(kind)) return null;
  return { ts: Number(ts), nonce, kind: kind as EnvelopeKind, length: Number(length), mac };
}

/**
 * Ob die Kopfzeile von jemandem mit dem Schlüssel stammt und frisch ist.
 * `mac`: falscher Schlüssel oder verändert. `time`: die Uhren liegen zu weit
 * auseinander, oder die Anfrage ist alt.
 */
export function verifyHeader(pairingKey: string, header: EnvelopeHeader, now: number = Date.now()): 'ok' | 'mac' | 'time' {
  const expected = Buffer.from(macOf(deriveKeys(pairingKey), header), 'utf8');
  const given = Buffer.from(header.mac, 'utf8');
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return 'mac';
  if (Math.abs(now - header.ts) > MAX_SKEW_MS) return 'time';
  return 'ok';
}

/** Den Rumpf einer Anfrage öffnen. Wirft, wenn er nicht zur Kopfzeile gehört oder verändert wurde. */
export function openRequest(pairingKey: string, header: EnvelopeHeader, body: Buffer): Buffer {
  if (body.length !== header.length) throw new Error('Die Länge des Rumpfs passt nicht zur Kopfzeile.');
  return decrypt(deriveKeys(pairingKey).request, canonical(header), body);
}

function responseAad(nonce: string): string {
  return `hapm-sync ${VERSION}\nresponse\n${nonce}`;
}

/** Die Antwort, gebunden an den Einmalwert der Anfrage: sie passt zu keiner anderen. */
export function sealResponse(pairingKey: string, nonce: string, payload: Buffer): Buffer {
  return encrypt(deriveKeys(pairingKey).response, responseAad(nonce), payload);
}

export function openResponse(pairingKey: string, nonce: string, body: Buffer): Buffer {
  return decrypt(deriveKeys(pairingKey).response, responseAad(nonce), body);
}

/**
 * Welche Einmalwerte schon gesehen wurden. Im Speicher: es läuft genau eine
 * Instanz. Ein Eintrag bleibt so lange, wie seine Anfrage noch als frisch
 * gälte, danach lehnt sie schon die Zeitprüfung ab.
 */
export class NonceCache {
  private readonly seen = new Map<string, number>();

  constructor(private readonly max = 10_000) {}

  /** `true`, wenn der Wert neu ist und jetzt als gesehen gilt. */
  claim(nonce: string, now: number = Date.now()): boolean {
    for (const [key, until] of this.seen) {
      if (until > now) break;
      this.seen.delete(key);
    }
    if (this.seen.has(nonce)) return false;
    // Voll heißt: jemand mit dem Schlüssel schickt Tausende Anfragen in zehn
    // Minuten. Dann lieber ablehnen als vergessen, was schon gesehen wurde.
    if (this.seen.size >= this.max) return false;
    this.seen.set(nonce, now + 2 * MAX_SKEW_MS);
    return true;
  }
}
