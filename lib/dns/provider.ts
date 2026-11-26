/**
 * Was der Bereich „DNS" von einem Anbieter braucht, und nicht mehr.
 *
 * Routen, `sync.ts` und `connect.ts` kennen nur diese Schnittstelle. Dahinter
 * stehen `cloudflare.ts`, `hetzner.ts`, `rfc2136.ts` und `infoblox.ts`, und nur
 * dort entsteht eine Anfrage an den Anbieter. Ein weiterer Anbieter ist eine
 * weitere Datei und eine Zeile in `PROVIDERS`, kein zweiter Bereich.
 *
 * ── Der Zugang ist ein Text ──
 *
 * `token` ist bei Cloudflare und Hetzner der API-Token. Bei RFC 2136 und
 * Infoblox sind es die Zugangsdaten als JSON (`access.ts`): mehrere Angaben,
 * aber für alles außerhalb des Anbieters weiter ein Geheimnis, das als Ganzes
 * verschlüsselt, entschlüsselt und nie gezeigt wird.
 *
 * ── Nicht jeder Anbieter zählt auf ──
 *
 * Cloudflare und Hetzner nennen alle Zonen eines Tokens und alle Einträge einer
 * Zone. Ein Nameserver über RFC 2136 kann beides nicht (ohne Zonentransfer),
 * und ein Infoblox-Grid führt zu viele. Deshalb sagt jeder Aufrufer dazu,
 * worum es ihm geht: `listZones` bekommt die Domain (`near`), `listRecords`
 * die Namen (`names`). Wer aufzählen kann, darf beides übergehen und alles
 * liefern. Wer es nicht kann, liefert nur dazu und braucht die Angabe.
 *
 * ── Die Oberfläche rechnet in einzelnen Einträgen ──
 *
 * `DnsRecord` ist ein Wert mit eigener Kennung. Cloudflare führt Einträge
 * genau so. Hetzner führt je Name und Art einen Satz von Werten (RRSet); wie
 * daraus Einträge werden und zurück, steht in `hetzner-rrsets.ts`. Deshalb
 * bekommen Ändern und Löschen den Eintrag, wie er gerade gelesen wurde
 * (`current`), und nicht nur eine Kennung: der Anbieter entscheidet, was er
 * davon braucht.
 *
 * ── Was nur ein Anbieter kennt ──
 *
 * `proxied` gibt es nur bei Cloudflare. Das Feld bleibt im Auftrag, weil ein
 * Eintrag dort ohne die Angabe nicht vollständig beschrieben ist; Hetzner liest
 * es nicht. Welche Regeln sonst abweichen (TTL), steht in `PROVIDER_RULES`.
 */

import { cloudflare } from './cloudflare';
import { hetzner } from './hetzner';
import { infoblox } from './infoblox';
import { rfc2136 } from './rfc2136';
import { providerOf, type DnsProviderId } from './zones';
import type { DnsRecord } from './records';

/** Die Zone beim Anbieter: seine Kennung, und ihr Name für die Umrechnung der Eintragsnamen. */
export interface ZoneRef {
  id: string;
  name: string;
}

/** Eine Zone, wie der Token sie sieht. */
export interface ProviderZone {
  id: string;
  name: string;
  /**
   * Ob die Nameserver der Domain auf den Anbieter zeigen. `null` heißt, der
   * Anbieter weiß es (noch) nicht, und nicht „ja".
   */
  delegated: boolean | null;
}

/** Ein Eintrag, wie er geschrieben werden soll. */
export interface RecordWrite {
  type: string;
  /** Der volle Name. */
  name: string;
  content: string;
  /** `null`: keine eigene TTL (`PROVIDER_RULES[...].defaultTtl`). */
  ttl: number | null;
  proxied?: boolean;
  priority?: number;
  comment?: string;
}

export interface DnsProvider {
  readonly id: DnsProviderId;
  /**
   * Die Zonen, die der Zugang sieht. Der Aufruf, mit dem ein Zugang geprüft
   * wird. `near` ist die Domain, um die es geht: ein Anbieter, der nicht
   * aufzählt (`PROVIDER_RULES[...].listsZones`), liefert die Zonen, in denen
   * sie liegt.
   */
  listZones(token: string, near?: string): Promise<ProviderZone[]>;
  /**
   * Die Einträge der Zone. `names` sind die vollen Namen, um die es geht: ein
   * Anbieter, der nicht aufzählt, liefert nur, was unter ihnen steht. Jeder
   * Eintrag unter einem genannten Namen ist dabei, andere dürfen es sein.
   */
  listRecords(token: string, zone: ZoneRef, names?: readonly string[]): Promise<DnsRecord[]>;
  /**
   * Ob der Zugang die Zone auch ändern darf, geprüft beim Anbinden. Nur wo der
   * lesende Aufruf das nicht schon zeigt (RFC 2136: ein Schlüssel kann gültig
   * sein und trotzdem nichts ändern dürfen). Wirft mit dem Grund.
   */
  assertWritable?(token: string, zone: ZoneRef): Promise<void>;
  createRecord(token: string, zone: ZoneRef, input: RecordWrite): Promise<DnsRecord>;
  updateRecord(
    token: string,
    zone: ZoneRef,
    current: DnsRecord,
    input: RecordWrite
  ): Promise<DnsRecord>;
  deleteRecord(token: string, zone: ZoneRef, current: DnsRecord): Promise<void>;
}

const PROVIDERS: Record<DnsProviderId, DnsProvider> = { cloudflare, hetzner, rfc2136, infoblox };

/** Der Anbieter zu einer Kennung oder zu einer Zeile aus `dns_zones`. */
export function providerFor(zone: DnsProviderId | { provider?: string | null }): DnsProvider {
  return PROVIDERS[typeof zone === 'string' ? zone : providerOf(zone)];
}
