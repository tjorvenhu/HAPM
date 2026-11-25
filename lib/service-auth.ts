/**
 * Dienst-zu-Dienst-Authentifizierung für `/api/internal/**`.
 *
 * Die einzige Fläche in HAPM, die nicht an `requireSession` hängt und trotzdem
 * schreibt. Deshalb hier die Regeln, aus denen alles Weitere folgt.
 *
 * **Warum es sie gibt.** Ein Deploy-Skript oder eine Pipeline soll eine Domain
 * am Reverse-Proxy anlegen können, ohne dass jemand einen Dialog ausfüllt. Die
 * Richtung ist **Aufrufer → HAPM**, nie umgekehrt.
 *
 * **Nur der Hash wird gespeichert.** Der Klartext existiert genau einmal, in
 * der Antwort auf das Anlegen. Ein Token mit Schreibzugriff auf den
 * Reverse-Proxy im Klartext in der Datenbank wäre der Fund, wegen dem ein
 * Datenbank-Leck zum Totalschaden wird. Kein Wiederherstellen, nur
 * Neuausstellen.
 *
 * **Kein Vergleich in JavaScript.** Nachgeschlagen wird über den Unique-Index
 * auf `tokenHash`. Ein `===` über alle Zeilen wäre nicht nur langsam, sondern
 * zeitabhängig; hier entscheidet der Index, und der sieht nur den Hash.
 *
 * **Jeder schreibende Aufruf steht im Audit**, mit dem Namen des aufrufenden
 * Dienstes. Wer im Nachhinein fragt, wer eine Domain angelegt hat, bekommt
 * einen Namen und keine ID — deshalb wird ein zurückgezogenes Token gesperrt
 * und nicht gelöscht.
 *
 * **Ein Token gilt für alles unter `/api/internal`**: Reverse-Proxy, Updates,
 * Sicherung, Einstellungen (docs/hapm-api.md). Bereiche oder Scopes je Token
 * gibt es nicht. Was kein Token darf (Geheimnisse, Konten, die Adresse von
 * HAPM), fehlt in der API ganz und steht in docs/mcp.md. Einschränken lässt sich ein Token über die Liste der Adressen,
 * von denen es gelten darf (`lib/ip-allow.ts`); ein leeres Feld heißt dort
 * „keine Einschränkung".
 */

import { createHash, randomBytes } from 'crypto';
import { listDocuments, updateDocument, Query } from './db';
import { COLLECTIONS } from './types';
import { ApiError } from './api';
import { getClientIP, logAudit, serviceActor } from './audit';
import { ipAllowed, parseAllowedIps } from './ip-allow';
import type { ServiceToken } from './types';

/**
 * Erkennbares Präfix.
 *
 * Ein Präfix ist kein Schmuck: Secret-Scanner in Git-Hosts und CI erkennen
 * Token an ihrer Form, und ein Token ohne Form fällt beim versehentlichen
 * Commit niemandem auf. Ausgestellte Token tragen es, und Aufrufer erkennen
 * ihre Token daran: es ändert sich deshalb nicht mehr.
 */
const TOKEN_PREFIX = 'hapm_';
const TOKEN_BYTES = 32;

/** So viele Zeichen des Klartexts sind später noch sichtbar. */
const VISIBLE_PREFIX_LENGTH = 12;

/**
 * Fehlversuche je Adresse und Stunde.
 *
 * Ein eigener Zähler statt `lib/rate-limit.ts`, weil hier **nur Fehlversuche**
 * zählen sollen. Der gemeinsame Begrenzer zählt jeden Aufruf, und ein Dienst
 * mit hundert Aufrufen am Tag hätte sich selbst ausgesperrt.
 */
const FAILED_ATTEMPTS_LIMIT = 20;
const FAILED_ATTEMPTS_WINDOW_MS = 60 * 60 * 1000;

const failures = new Map<string, number[]>();

function recentFailures(ip: string): number {
  const cutoff = Date.now() - FAILED_ATTEMPTS_WINDOW_MS;
  const kept = (failures.get(ip) ?? []).filter((t) => t > cutoff);
  if (kept.length > 0) failures.set(ip, kept);
  else failures.delete(ip);
  return kept.length;
}

function noteFailure(ip: string): void {
  const cutoff = Date.now() - FAILED_ATTEMPTS_WINDOW_MS;
  const kept = (failures.get(ip) ?? []).filter((t) => t > cutoff);
  kept.push(Date.now());
  failures.set(ip, kept);

  // Genau eine Instanz, also reicht der Speicher — aber unbegrenzt wachsen darf
  // er nicht, sonst ist der Begrenzer selbst der Angriffspunkt.
  if (failures.size > 5000) {
    for (const [key, times] of failures) {
      if (times.every((t) => t <= cutoff)) failures.delete(key);
    }
  }
}

/** Nur für Tests: der Zähler lebt im Prozess. */
export function resetFailedAttempts(): void {
  failures.clear();
}

export function generateServiceToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString('base64url')}`;
}

export function hashServiceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function tokenPrefix(token: string): string {
  return token.slice(0, VISIBLE_PREFIX_LENGTH);
}

/**
 * Das Token aus dem Header ziehen.
 *
 * `Authorization: Bearer …` und `X-Service-Token: …` — der zweite, weil manche
 * Proxys den Authorization-Header abräumen oder für sich beanspruchen.
 */
export function extractToken(request: Request): string | null {
  const auth = request.headers.get('authorization');
  if (auth?.toLowerCase().startsWith('bearer ')) {
    const value = auth.slice(7).trim();
    if (value) return value;
  }
  const header = request.headers.get('x-service-token')?.trim();
  return header || null;
}

export interface ServiceIdentity {
  id: string;
  name: string;
}

/**
 * Aufrufenden Dienst feststellen oder abbrechen.
 *
 * ── Die Ausgänge und ihre Statuscodes ──
 *
 * **401 bei unbekanntem oder zurückgezogenem Token**, mit derselben Meldung für
 * beides: ob ein Token nie existiert hat oder gesperrt wurde, geht den Aufrufer
 * nichts an. Der Unterschied hilft nur jemandem, der Token durchprobiert.
 *
 * **403 bei nicht freigegebener Adresse**, und hier ausdrücklich MIT
 * Begründung. Der Aufrufer hat sein Token bereits bewiesen — ihm zu sagen,
 * woran es lag, verrät nichts, was er nicht ohnehin erfragen könnte. Umgekehrt
 * ist ein wortloses 401 an dieser Stelle die Sorte Fehler, an der jemand eine
 * Stunde sucht, weil sie wie ein falscher Schlüssel aussieht und keiner ist.
 *
 * Die Ablehnung zählt als Fehlversuch und steht im Audit. Ein Token, das von
 * einer fremden Adresse auftaucht, ist der Fall, für den die Liste da ist —
 * dass es passiert, soll man nachlesen können und nicht erst bemerken, wenn
 * jemand danach sucht.
 */
export async function requireServiceToken(request: Request): Promise<ServiceIdentity> {
  // `getClientIP` und nicht der linkeste X-Forwarded-For-Eintrag: der ist vom
  // Aufrufer gesetzt und frei wählbar. Wer ihn je Versuch dreht, hätte den
  // Fehlversuchszähler damit wirkungslos gemacht. Steht so in lib/audit.ts.
  const ip = getClientIP(request);

  // Vor dem Nachschlagen, damit die Datenbank nicht der Flaschenhals ist, den
  // jemand mit erfundenen Token belastet.
  if (recentFailures(ip) >= FAILED_ATTEMPTS_LIMIT) {
    throw new ApiError('Zu viele Fehlversuche.', 429);
  }

  const token = extractToken(request);
  if (!token) {
    noteFailure(ip);
    throw new ApiError('Service-Token ungültig.', 401);
  }

  const matches = await listDocuments<ServiceToken>(COLLECTIONS.SERVICE_TOKENS, [
    Query.equal('tokenHash', hashServiceToken(token)),
    Query.limit(1),
  ]);

  const found = matches[0];
  if (!found || found.revokedAt) {
    noteFailure(ip);
    throw new ApiError('Service-Token ungültig.', 401);
  }

  const allowed = parseAllowedIps(found.allowedIps);
  if (!ipAllowed(allowed, ip)) {
    noteFailure(ip);
    await logAudit({
      ...serviceActor({ id: found.$id, name: found.name }),
      action: 'service_token_ip_rejected',
      resource: 'service_token',
      resourceId: found.$id,
      details: `${found.name} (${found.prefix}…): Adresse ${ip} steht nicht auf der Freigabeliste`,
      ip,
    });
    throw new ApiError(
      `Die Adresse ${ip} ist für dieses Token nicht freigegeben.`,
      403
    );
  }

  // Best effort. Ein fehlgeschlagener Zeitstempel darf einen gültigen Aufruf
  // nicht abbrechen — die Angabe ist Komfort, nicht Autorisierung.
  void updateDocument<ServiceToken>(COLLECTIONS.SERVICE_TOKENS, found.$id, {
    lastUsedAt: new Date().toISOString(),
    lastUsedIp: ip,
  }).catch(() => {});

  return { id: found.$id, name: found.name };
}
