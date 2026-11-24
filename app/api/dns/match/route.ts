import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { listRecords } from '@/lib/dns/cloudflare';
import { listZoneRows, withZone } from '@/lib/dns/store';
import {
  isProxyRecord,
  matchZone,
  normalizeDomain,
  proxyRecordPlan,
  type DomainMatch,
} from '@/lib/dns/zones';
import type { DnsRecord } from '@/lib/dns/records';
import type { DnsZone } from '@/lib/types';

/**
 * Liegt diese Domain in einer verwalteten Zone, und steht der Eintrag schon?
 *
 * Die Frage stellt der Dienst-Dialog des Reverse-Proxys, während jemand tippt.
 * Sie hier zu beantworten und nicht im Browser hat zwei Gründe: der API-Token
 * verlässt den Server nicht, und die Antwort soll den ECHTEN Bestand bei
 * Cloudflare kennen — nicht nur, ob wir die Zone eingerichtet haben.
 *
 * Ein Haken, der gesetzt ist, weil der Eintrag schon steht, ist eine Aussage
 * über die Zone. Wäre sie geraten, stünde sie genau dann falsch da, wenn jemand
 * den Eintrag im Dashboard gerade gelöscht hat.
 */

export async function GET(request: Request) {
  try {
    await requireSession();
    const url = new URL(request.url);
    const domains = (url.searchParams.get('domains') ?? '')
      .split(',')
      .map(normalizeDomain)
      .filter(Boolean)
      // Der Dialog fragt bei jedem Tastendruck (entprellt). Ein Deckel hier ist
      // billiger als ein Nutzer, der versehentlich vierzig Zonen abfragt.
      .slice(0, 20);

    if (domains.length === 0) return ok([] as DomainMatch[]);

    const zones = await listZoneRows();
    // Ein Lesevorgang je Zone, nicht je Domain: drei Subdomains derselben Zone
    // sind eine Abfrage.
    const cache = new Map<string, Promise<DnsRecord[]>>();
    const recordsOf = (zone: DnsZone) => {
      const running = cache.get(zone.$id);
      if (running) return running;
      const started = withZone(zone, (token, zoneId) => listRecords(token, zoneId));
      cache.set(zone.$id, started);
      return started;
    };

    const matches: DomainMatch[] = await Promise.all(
      domains.map(async (domain) => {
        const zone = matchZone(domain, zones);
        if (!zone) {
          return { domain, zone: null, plan: null, blocked: null, existing: null, error: null };
        }

        const plan = proxyRecordPlan(domain, zone.name);
        const head = { domain, zone: { id: zone.$id, name: zone.name } };
        if (!plan) {
          return {
            ...head,
            plan: null,
            blocked: `${domain} ist die Zone selbst. Dort gehört ein A-Eintrag auf diesen Server hin, und der wird von Hand gepflegt.`,
            existing: null,
            error: null,
          };
        }

        try {
          const records = await recordsOf(zone);
          const found =
            records.find((r) => normalizeDomain(r.name) === normalizeDomain(plan.fqdn)) ?? null;
          return {
            ...head,
            plan: { fqdn: plan.fqdn, type: plan.type, content: plan.content },
            blocked: null,
            existing: found
              ? {
                  type: found.type,
                  content: found.content,
                  managed: isProxyRecord(found, zone.name),
                }
              : null,
            error: null,
          };
        } catch (err) {
          // Kein 502 für die ganze Antwort: die anderen Domains sind davon
          // unberührt, und der Dialog soll sagen können, WELCHE Zone klemmt.
          return {
            ...head,
            plan: { fqdn: plan.fqdn, type: plan.type, content: plan.content },
            blocked: null,
            existing: null,
            error: err instanceof Error ? err.message : 'Unbekannter Fehler',
          };
        }
      })
    );

    return ok(matches);
  } catch (err) {
    return handleError(err);
  }
}
