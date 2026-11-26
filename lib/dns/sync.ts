/**
 * Der DNS-Teil eines Reverse-Proxy-Vorgangs.
 *
 * ── Warum das hier steht und nicht in lib/haproxy/ ──
 *
 * Ein CNAME beim DNS-Anbieter hat mit `haproxy.cfg` nichts zu tun: keine Datei,
 * kein Lock. Umgekehrt kennt diese Datei kein HAProxy — sie bekommt
 * Domains und liefert Schritte. Der Lauf in `lib/haproxy/runner.ts` setzt beides
 * zusammen, und nur dort ist die Reihenfolge zu sehen, auf die es ankommt.
 *
 * ── Warum der Eintrag VOR dem Zertifikat entsteht ──
 *
 * Let's Encrypt prüft über HTTP-01, also über die Domain selbst. Zeigt sie noch
 * nirgendwohin, scheitert der Antrag — und ein Fehlversuch zählt gegen ein
 * Kontingent. Ein Eintrag, der nach dem Zertifikat entstünde, wäre für genau den
 * Fall zu spät, für den man ihn braucht: die frisch angelegte Domain.
 *
 * ── Was hier NIE passiert: überschreiben ──
 *
 * Steht unter dem Namen schon etwas anderes — ein A-Eintrag von Hand, ein CNAME
 * woandershin —, bleibt es stehen und der Schritt sagt, was dort steht. Ein
 * Werkzeug, das beim Anlegen eines Proxy-Ziels stillschweigend einen fremden
 * A-Eintrag ersetzt, nimmt etwas offline, wovon der Vorgang nichts weiß.
 * Dieselbe Regel wie beim HAProxy-Eintrag, der nicht dem Namensschema folgt.
 *
 * ── Derselbe Eintrag bei jedem Anbieter ──
 *
 * Ein CNAME auf die Zone selbst, bei jedem Anbieter. Was abweicht,
 * kommt aus `PROVIDER_RULES`: die TTL ist die Vorgabe des Anbieters, und
 * `proxied: false` geht nur dorthin mit, wo es einen Proxy gibt. Wie der Wert
 * beim Anbieter geschrieben wird (Hetzner: `example.org.` mit Punkt), ist
 * dessen Sache und steht hinter `provider.ts`.
 */

import { providerFor } from './provider';
import { dnsProviderLabel } from './provider-info';
import { listZoneRows, withZone } from './store';
import { isProxyRecord, matchZone, normalizeDomain, proxyRecordPlan, zoneCovers } from './zones';
import { PROVIDER_RULES, type DnsRecord } from './records';
import type { DnsZone, HaproxyStep } from '../types';
import { msgid } from '../i18n';

/**
 * Ein Leser je Zone und Vorgang.
 *
 * Ein Dienst hat oft drei Domains in derselben Zone; ohne diesen Zwischenspeicher
 * wären das drei Abfragen über denselben Eintragsbestand — und die letzte könnte
 * einen Eintrag nicht sehen, den die erste gerade angelegt hat.
 */
class ZoneRecords {
  private readonly cache = new Map<string, DnsRecord[]>();

  /**
   * `names` sind die Namen, um die es in diesem Vorgang geht. Ein Anbieter,
   * der eine Zone nicht als Ganzes liest (RFC 2136), liest genau sie.
   */
  constructor(
    private readonly zones: DnsZone[],
    private readonly names: readonly string[]
  ) {}

  zoneOf(domain: string): DnsZone | null {
    return matchZone(domain, this.zones);
  }

  async of(zone: DnsZone): Promise<DnsRecord[]> {
    const cached = this.cache.get(zone.$id);
    if (cached) return cached;
    const here = this.names.filter((name) => zoneCovers(zone.name, name));
    const records = await withZone(zone, (token, ref) => providerFor(zone).listRecords(token, ref, here));
    this.cache.set(zone.$id, records);
    return records;
  }

  /** Nach dem Anlegen oder Löschen: der Bestand im Speicher stimmt sonst nicht mehr. */
  forget(zone: DnsZone): void {
    this.cache.delete(zone.$id);
  }
}

function findByName(records: DnsRecord[], fqdn: string): DnsRecord | null {
  return records.find((record) => normalizeDomain(record.name) === normalizeDomain(fqdn)) ?? null;
}

/**
 * Welche dieser Domains einen Eintrag bekommen KÖNNEN — die Antwort auf
 * `dnsDomains: 'auto'` in der Dienst-API.
 *
 * Im Dialog wählt der Mensch die Domains aus, weil er die Zonen vor sich sieht.
 * Ein Dienst sieht sie nicht: ein Deploy-Skript kennt seine Domain und nicht,
 * welche Zonen hier eingerichtet sind. „Auto" heißt deshalb genau das, was der
 * Dialog vorbelegt — jede Domain, für die es eine Zone gibt und in der ein
 * Eintrag überhaupt zulässig ist.
 *
 * Der Apex fällt heraus, und das ist der Punkt: `ensureProxyRecords` macht aus
 * ihm einen Schritt mit `ok: false`, und der setzt den ganzen Lauf auf `error`.
 * Ein Aufruf mit `kunde.example` und `www.kunde.example` würde also als fehlgeschlagen
 * gemeldet, obwohl der Dienst steht und der einzige mögliche Eintrag gesetzt
 * wurde. Eine Domain ohne Zone fällt aus demselben Grund heraus: sie zeigt
 * schon woandershin, sonst hätte sie niemand in den Antrag geschrieben.
 *
 * Wer den Fehlschlag sehen WILL, nennt die Domains einzeln — dann ist es eine
 * Ansage und keine Vermutung.
 */
export async function autoDnsDomains(domains: string[]): Promise<string[]> {
  if (domains.length === 0) return [];
  const zones = await listZoneRows();
  return domains
    .map(normalizeDomain)
    .filter((domain) => {
      const zone = matchZone(domain, zones);
      return zone !== null && proxyRecordPlan(domain, zone.name) !== null;
    })
    .filter((domain, index, all) => all.indexOf(domain) === index);
}

/**
 * Für jede Domain den CNAME auf ihre Zone setzen, falls er fehlt.
 *
 * Wirft nicht: der Vorgang darum ist der Reverse-Proxy, und ein DNS-Eintrag, der
 * nicht gesetzt werden konnte, ist ein Schritt mit `ok: false` und kein Abbruch.
 * Der Lauf steht danach auf `error` und nennt den Grund — der Dienst selbst wird
 * trotzdem angelegt, denn eine Domain, die schon anderswo aufgelöst wird,
 * funktioniert auch ohne diesen Eintrag.
 *
 * Die Schritte werden am Lauf gespeichert. Texte mit eingesetzten Werten
 * bleiben deshalb deutsch, bis das Format `{ text, params }` trägt; die ohne
 * Werte sind `msgid` und werden beim Zeigen übersetzt (docs/i18n.md).
 */
export async function ensureProxyRecords(domains: string[]): Promise<HaproxyStep[]> {
  if (domains.length === 0) return [];
  const zones = new ZoneRecords(await listZoneRows(), domains.map(normalizeDomain));
  const steps: HaproxyStep[] = [];

  for (const raw of domains) {
    const domain = normalizeDomain(raw);
    const zone = zones.zoneOf(domain);
    if (!zone) {
      steps.push({
        label: `DNS-Eintrag ${domain}`,
        ok: false,
        detail: msgid('Für diese Domain ist keine Zone eingerichtet.'),
      });
      continue;
    }

    const plan = proxyRecordPlan(domain, zone.name);
    if (!plan) {
      steps.push({
        label: `DNS-Eintrag ${domain}`,
        ok: false,
        detail:
          `${domain} ist die Zone selbst. Dort gehört ein A-Eintrag auf diesen Server hin, und ` +
          'der wird von Hand gepflegt. Ein CNAME auf der Root verdeckte NS und MX.',
      });
      continue;
    }

    try {
      const existing = findByName(await zones.of(zone), plan.fqdn);
      if (existing && isProxyRecord(existing, zone.name)) {
        steps.push({
          label: `DNS-Eintrag ${plan.fqdn}`,
          ok: true,
          detail: `Steht bereits: CNAME auf ${zone.name}.`,
        });
        continue;
      }
      if (existing) {
        steps.push({
          label: `DNS-Eintrag ${plan.fqdn}`,
          ok: false,
          detail:
            `Dort steht bereits ein ${existing.type}-Eintrag auf ${existing.content}. ` +
            'Er wurde nicht angefasst.',
        });
        continue;
      }

      const provider = providerFor(zone);
      const rules = PROVIDER_RULES[provider.id];
      await withZone(zone, (token, ref) =>
        provider.createRecord(token, ref, {
          type: plan.type,
          name: plan.fqdn,
          content: plan.content,
          ttl: rules.defaultTtl,
          ...(rules.proxy ? { proxied: plan.proxied } : {}),
          comment: 'HAPM',
        })
      );
      zones.forget(zone);
      steps.push({
        label: `DNS-Eintrag ${plan.fqdn}`,
        ok: true,
        detail:
          `Angelegt bei ${dnsProviderLabel(provider.id)}: CNAME auf ${zone.name}` +
          (rules.proxy ? ', ohne Proxy.' : '.'),
      });
    } catch (err) {
      steps.push({
        label: `DNS-Eintrag ${plan.fqdn}`,
        ok: false,
        detail: err instanceof Error ? err.message : msgid('Unbekannter Fehler'),
      });
    }
  }

  return steps;
}

/**
 * Die CNAMEs dieser Domains wieder entfernen — aber nur die eigenen.
 *
 * `isProxyRecord` ist die Bedingung, nicht der Name: ein A-Eintrag unter
 * demselben Namen gehört jemand anderem, und ihn beim Löschen eines Proxy-Ziels
 * mitzunehmen wäre der Fall, der erst auffällt, wenn eine fremde Seite weg ist.
 *
 * Domains ohne eingerichtete Zone und ohne passenden Eintrag ergeben keinen
 * Schritt: „nichts zu tun" ist keine Auskunft, und in der Historie eines
 * Löschvorgangs stünden sonst drei Zeilen über Dinge, die es nie gab.
 */
export async function removeProxyRecords(domains: string[]): Promise<HaproxyStep[]> {
  if (domains.length === 0) return [];
  const zones = new ZoneRecords(await listZoneRows(), domains.map(normalizeDomain));
  const steps: HaproxyStep[] = [];

  for (const raw of domains) {
    const domain = normalizeDomain(raw);
    const zone = zones.zoneOf(domain);
    if (!zone) continue;
    const plan = proxyRecordPlan(domain, zone.name);
    if (!plan) continue;

    try {
      const existing = findByName(await zones.of(zone), plan.fqdn);
      if (!existing) continue;
      if (!isProxyRecord(existing, zone.name)) {
        steps.push({
          label: `DNS-Eintrag ${plan.fqdn}`,
          ok: true,
          detail: `Bleibt stehen: dort steht ein ${existing.type}-Eintrag, den HAPM nicht gesetzt hat.`,
        });
        continue;
      }

      await withZone(zone, (token, ref) => providerFor(zone).deleteRecord(token, ref, existing));
      zones.forget(zone);
      steps.push({ label: `DNS-Eintrag ${plan.fqdn}`, ok: true, detail: msgid('Entfernt.') });
    } catch (err) {
      steps.push({
        label: `DNS-Eintrag ${plan.fqdn}`,
        ok: false,
        detail: err instanceof Error ? err.message : msgid('Unbekannter Fehler'),
      });
    }
  }

  return steps;
}
