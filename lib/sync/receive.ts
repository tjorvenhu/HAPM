/**
 * Der Endpunkt, über den ein anderer Knoten diesen anspricht
 * (`POST /api/sync/node`).
 *
 * Die einzige Route in HAPM, die weder Sitzung noch API-Key verlangt und
 * trotzdem die Konfiguration des Proxys ersetzen kann. Ihr Zugang ist der
 * Kopplungsschlüssel, und die Reihenfolge der Prüfungen ist der Schutz
 * (`tests/security/sync-api.test.ts` hält sie fest):
 *
 *  1. Fehlversuche je Adresse, bevor irgendetwas gelesen wird.
 *  2. Die Kopfzeile: Form, MAC, Zeit. Ohne gültigen MAC wird kein Rumpf gelesen.
 *  3. Die Länge, wie die Kopfzeile sie nennt (sie ist mit gesichert), gegen die
 *     Obergrenze der Art. Mehr als das wird nicht gelesen.
 *  4. Der Einmalwert: jede Anfrage gilt einmal.
 *  5. Der Rumpf: entschlüsseln und prüfen (AES-256-GCM).
 *
 * Erst danach entscheidet die Rolle. Auch ein Knoten, der kein Folgeknoten ist,
 * antwortet einem Aufrufer mit gültigem Schlüssel, und zwar mit dem Grund:
 * daran erkennt ein Hauptknoten, dass die Gegenstelle selbst Hauptknoten ist.
 * Wer den Schlüssel nicht hat, bekommt immer dieselbe Absage.
 *
 * Die Antwort ist wie die Anfrage verschlüsselt und an deren Einmalwert
 * gebunden: der Aufrufer weiß damit, dass der richtige Knoten geantwortet hat.
 */

import { ApiError } from '../api';
import { getClientIP } from '../audit';
import { msg } from '../i18n/translate';
import { acceptBundle, currentApply } from './apply';
import { NonceCache, SYNC_HEADER, openRequest, parseHeader, sealResponse, verifyHeader, type EnvelopeKind } from './envelope';
import { nodeReport } from './node';
import { getSyncSettings, openKey } from './store';
import type { NodeAnswer } from './types';

/** Was ein Paket über die Leitung höchstens wiegt (gepackt und verschlüsselt). */
export const MAX_APPLY_BYTES = 96 * 1024 * 1024;
/** Eine Frage nach der Auskunft ist ein leeres Objekt. */
export const MAX_STATUS_BYTES = 16 * 1024;

const LIMITS: Record<EnvelopeKind, number> = { apply: MAX_APPLY_BYTES, status: MAX_STATUS_BYTES };

/** Wie in `lib/service-auth.ts`: nur Fehlversuche zählen, je Adresse und Stunde. */
const FAILED_ATTEMPTS_LIMIT = 20;
const FAILED_ATTEMPTS_WINDOW_MS = 60 * 60 * 1000;

interface Memory {
  failures: Map<string, number[]>;
  nonces: NonceCache;
}

const globalMemory = globalThis as unknown as { __hapmSyncReceive?: Memory };

function memory(): Memory {
  return (globalMemory.__hapmSyncReceive ??= { failures: new Map(), nonces: new NonceCache() });
}

function recentFailures(ip: string): number {
  const cutoff = Date.now() - FAILED_ATTEMPTS_WINDOW_MS;
  const { failures } = memory();
  const kept = (failures.get(ip) ?? []).filter((at) => at > cutoff);
  if (kept.length > 0) failures.set(ip, kept);
  else failures.delete(ip);
  return kept.length;
}

function noteFailure(ip: string): void {
  const cutoff = Date.now() - FAILED_ATTEMPTS_WINDOW_MS;
  const { failures } = memory();
  const kept = (failures.get(ip) ?? []).filter((at) => at > cutoff);
  kept.push(Date.now());
  failures.set(ip, kept);
  if (failures.size > 5000) {
    for (const [key, times] of failures) {
      if (times.every((at) => at <= cutoff)) failures.delete(key);
    }
  }
}

/** Nur für Tests: Zähler und Einmalwerte leben im Prozess. */
export function resetSyncReceive(): void {
  globalMemory.__hapmSyncReceive = undefined;
}

/** Dieselbe Absage für jeden, der den Schlüssel nicht zeigt: ob es hier einen gibt, geht ihn nichts an. */
function denied(): ApiError {
  return new ApiError(msg('Abgleich: Die Anmeldung ist ungültig.'), 401);
}

/** Höchstens `limit` Bytes lesen. Wirft, wenn mehr kommt. */
async function readBody(request: Request, limit: number): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      throw new ApiError(msg('Abgleich: Der Rumpf ist länger als angekündigt.'), 413);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function handleNodeRequest(request: Request): Promise<Response> {
  const ip = getClientIP(request);
  if (recentFailures(ip) >= FAILED_ATTEMPTS_LIMIT) throw new ApiError(msg('Zu viele Fehlversuche.'), 429);

  const header = parseHeader(request.headers.get(SYNC_HEADER));
  if (!header) {
    noteFailure(ip);
    throw denied();
  }
  const key = openKey((await getSyncSettings()).pairingKey);
  if (!key) {
    noteFailure(ip);
    throw denied();
  }
  const verdict = verifyHeader(key, header);
  if (verdict === 'mac') {
    noteFailure(ip);
    throw denied();
  }
  // Ab hier hat der Aufrufer den Schlüssel gezeigt: der Grund hilft ihm, und er verrät nichts.
  if (verdict === 'time') {
    throw new ApiError(msg('Abgleich: Die Uhren der beiden Knoten liegen mehr als fünf Minuten auseinander.'), 409);
  }
  if (header.length > LIMITS[header.kind]) {
    throw new ApiError(msg('Abgleich: Das Paket ist größer, als dieser Knoten annimmt.'), 413);
  }
  if (!memory().nonces.claim(header.nonce)) {
    throw new ApiError(msg('Abgleich: Diese Anfrage wurde schon einmal gestellt.'), 409);
  }

  const body = await readBody(request, header.length);
  let payload: Buffer;
  try {
    payload = openRequest(key, header, body);
  } catch {
    noteFailure(ip);
    throw denied();
  }

  const answer: NodeAnswer =
    header.kind === 'apply' ? await acceptBundle(payload) : { ok: true, report: await nodeReport(currentApply()) };

  const sealed = sealResponse(key, header.nonce, Buffer.from(JSON.stringify(answer), 'utf8'));
  return new Response(new Uint8Array(sealed), {
    status: 200,
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
  });
}
