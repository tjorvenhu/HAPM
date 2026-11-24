/**
 * Was der Bereich „DNS" von einem Anbieter braucht, und nicht mehr.
 *
 * Routen, `sync.ts` und `connect.ts` kennen nur diese Schnittstelle. Dahinter
 * stehen `cloudflare.ts` und `hetzner.ts`, und nur dort entsteht eine Anfrage
 * an den Anbieter. Ein dritter Anbieter ist eine dritte Datei und eine Zeile
 * in `PROVIDERS`, kein zweiter Bereich.
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
  /** Alle Zonen, die der Token sieht. Der Aufruf, mit dem ein Token geprüft wird. */
  listZones(token: string): Promise<ProviderZone[]>;
  /** Alle Einträge der Zone, bis zur letzten Seite. */
  listRecords(token: string, zone: ZoneRef): Promise<DnsRecord[]>;
  createRecord(token: string, zone: ZoneRef, input: RecordWrite): Promise<DnsRecord>;
  updateRecord(
    token: string,
    zone: ZoneRef,
    current: DnsRecord,
    input: RecordWrite
  ): Promise<DnsRecord>;
  deleteRecord(token: string, zone: ZoneRef, current: DnsRecord): Promise<void>;
}

const PROVIDERS: Record<DnsProviderId, DnsProvider> = { cloudflare, hetzner };

/** Der Anbieter zu einer Kennung oder zu einer Zeile aus `dns_zones`. */
export function providerFor(zone: DnsProviderId | { provider?: string | null }): DnsProvider {
  return PROVIDERS[typeof zone === 'string' ? zone : providerOf(zone)];
}
