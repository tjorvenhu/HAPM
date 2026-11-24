/**
 * Die Zonen aus der Datenbank holen, den Token entschlüsseln und das Ergebnis
 * eines Aufrufs beim Anbieter an der Zeile vermerken.
 *
 * Die Trennung zu `cloudflare.ts` und `hetzner.ts` ist keine Zeremonie: dort
 * steht der Anbieter, hier die eigene Datenbank. Eine Datei, die beides täte,
 * wäre die einzige im Baum, die man weder ohne Netz noch ohne Datenbank
 * aufrufen kann. Deshalb bekommt `withZone` die Arbeit hereingereicht und kennt
 * selbst keinen Anbieter.
 */

import { listAll, getDocument, updateDocument, Query } from '../db';
import { COLLECTIONS, type DnsZone } from '../types';
import { decrypt } from '../crypto';
import { ApiError } from '../api';
import { msg, msgid, translate, type Locale } from '../i18n';
import { matchZone, normalizeDomain, providerOf, type DnsProviderId } from './zones';
import type { ZoneRef } from './provider';

/** Die Zone, wie sie an den Browser geht: alles außer dem Token. */
export interface ZoneForClient {
  $id: string;
  /** Immer gesetzt, auch bei einer Zeile aus der Zeit vor dem Feld (`providerOf`). */
  provider: DnsProviderId;
  name: string;
  zoneId: string;
  status: DnsZone['status'];
  lastCheckedAt: string | null;
  lastError: string | null;
}

/**
 * Der Token verlässt den Server nicht.
 *
 * Dieselbe Regel wie beim `coolifyToken` auf einer servers-Zeile: ein Geheimnis,
 * das einmal im Browser war, steht danach im Speicher jeder Erweiterung, die
 * mitliest. Zurück kommt deshalb nie der Wert, sondern nur, ob und wann er
 * zuletzt funktioniert hat.
 */
export function forClient(zone: DnsZone): ZoneForClient {
  return {
    $id: zone.$id,
    provider: providerOf(zone),
    name: zone.name,
    zoneId: zone.zoneId,
    status: zone.status,
    lastCheckedAt: zone.lastCheckedAt,
    lastError: zone.lastError,
  };
}

export async function listZoneRows(): Promise<DnsZone[]> {
  const zones = await listAll<DnsZone>(COLLECTIONS.DNS_ZONES);
  return zones.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

export async function getZoneRow(id: string): Promise<DnsZone> {
  const zone = await getDocument<DnsZone>(COLLECTIONS.DNS_ZONES, id).catch(() => null);
  if (!zone) throw new ApiError(msg('Diese Domain ist hier nicht eingerichtet.'), 404);
  return zone;
}

/** Die eingerichtete Zone, in der diese Domain liegt — oder `null`. */
export async function zoneForDomain(domain: string): Promise<DnsZone | null> {
  return matchZone(domain, await listZoneRows());
}

/**
 * Die Zeile zu genau diesem Zonennamen, oder `null`.
 *
 * Der Riegel gegen zwei Zeilen und zwei Tokens für dieselbe Domain: eine Domain
 * ist bei einem Anbieter delegiert, und mit zwei Zeilen wüsste `matchZone`
 * nicht, in welche geschrieben wird.
 */
export async function findZoneRow(name: string): Promise<DnsZone | null> {
  const rows = await listAll<DnsZone>(COLLECTIONS.DNS_ZONES, [
    Query.equal('name', normalizeDomain(name)),
  ]);
  return rows[0] ?? null;
}

export function tokenOf(zone: DnsZone): string {
  try {
    return decrypt(zone.apiToken);
  } catch {
    // Das passiert genau dann, wenn ENCRYPTION_KEY gewechselt hat — und dann
    // hilft kein Wiederholen, sondern nur ein neuer Token.
    throw new ApiError(
      msg('Der API-Token von {zone} lässt sich nicht entschlüsseln. Bitte neu hinterlegen.', { zone: zone.name }),
      409
    );
  }
}

/**
 * Was der Anbieter gerade gesagt hat, an der Zeile vermerken.
 *
 * Der Grund ist die Liste: eine Domain, deren Token seit drei Wochen abgelaufen
 * ist, sieht dort sonst aus wie jede andere — auffallen würde es beim nächsten
 * Proxy-Ziel, also genau dann, wenn jemand es eilig hat.
 *
 * Ein Fehlschlag beim Vermerken hält den Aufrufer nicht auf: die Auskunft, die
 * er gerade holt, ist wichtiger als die Notiz darüber.
 */
export async function markZone(zone: DnsZone, error: string | null): Promise<void> {
  await updateDocument<DnsZone>(COLLECTIONS.DNS_ZONES, zone.$id, {
    status: error ? 'error' : 'ok',
    lastCheckedAt: new Date().toISOString(),
    lastError: error,
  }).catch(() => {});
}

/**
 * Einen Aufruf beim Anbieter ausführen und sein Ergebnis an der Zone vermerken.
 *
 * Zwei Zeilen, die sonst an jeder Aufrufstelle stünden — und an der einen, an
 * der sie fehlten, bliebe eine tote Zone für immer grün.
 *
 * Die Arbeit bekommt den Token und die Zone, wie der Anbieter sie kennt
 * (`ZoneRef`), und ruft damit `providerFor(zone)` aus `provider.ts`.
 */
export async function withZone<T>(
  zone: DnsZone,
  work: (token: string, ref: ZoneRef) => Promise<T>
): Promise<T> {
  try {
    const result = await work(tokenOf(zone), { id: zone.zoneId, name: zone.name });
    await markZone(zone, null);
    return result;
  } catch (err) {
    await markZone(zone, err instanceof Error ? err.message : msgid('Unbekannter Fehler'));
    throw err;
  }
}

/**
 * Der Fehler eines Aufrufs beim Anbieter als Text in einer Sprache, für Routen,
 * die ihn neben der Zone ausliefern statt zu werfen. An der Zeile steht er
 * deutsch (`markZone`): das ist eine Aufzeichnung.
 */
export function zoneErrorText(err: unknown, locale: Locale): string {
  if (err instanceof ApiError) return err.localized(locale);
  return translate(locale, err instanceof Error ? err.message : 'Unbekannter Fehler');
}
