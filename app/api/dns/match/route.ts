import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { providerFor } from '@/lib/dns/provider';
import { listZoneRows, withZone, zoneErrorText } from '@/lib/dns/store';
import { getT } from '@/lib/i18n/server';
import {
  isProxyRecord,
  matchZone,
  normalizeDomain,
  providerOf,
  proxyRecordPlan,
  type DomainMatch,
} from '@/lib/dns/zones';
import type { DnsRecord } from '@/lib/dns/records';
import { checkDomainAddress } from '@/lib/setup/address';
import type { DnsZone } from '@/lib/types';

/**
 * Liegt diese Domain in einer verwalteten Zone, und steht der Eintrag schon?
 *
 * Die Frage stellt der Dienst-Dialog des Reverse-Proxys, während jemand tippt.
 * Sie hier zu beantworten und nicht im Browser hat zwei Gründe: der API-Token
 * verlässt den Server nicht, und die Antwort soll den ECHTEN Bestand beim
 * Anbieter kennen — nicht nur, ob wir die Zone eingerichtet haben.
 *
 * Ein Haken, der gesetzt ist, weil der Eintrag schon steht, ist eine Aussage
 * über die Zone. Wäre sie geraten, stünde sie genau dann falsch da, wenn jemand
 * den Eintrag beim Anbieter gerade gelöscht hat.
 *
 * Der Anbieter der Zone geht mit zurück (`zone.provider`): der Dialog nennt ihn
 * und sagt nur bei Cloudflare etwas über den Proxy.
 *
 * Dazu für jede Domain, worauf sie gerade auflöst (`resolution`), auch ohne
 * Zone: der Dialog zeigt die Adresse oder schlägt den Eintrag vor.
 */

/**
 * Worauf die Domain auflöst, gefragt aus diesem Container und damit über
 * denselben Resolver, den auch der Server hat. Läuft neben dem Lesen der Zone
 * und nicht danach. Eine Wildcard hat keine eigene Adresse.
 */
async function resolutionOf(domain: string): Promise<DomainMatch['resolution']> {
  if (domain.startsWith('*.')) return null;
  const check = await checkDomainAddress(domain);
  return { addresses: check.resolved, verdict: check.verdict };
}

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
    const { t, locale } = await getT();

    const zones = await listZoneRows();
    // Ein Lesevorgang je Zone, nicht je Domain: drei Subdomains derselben Zone
    // sind eine Abfrage.
    const cache = new Map<string, Promise<DnsRecord[]>>();
    const recordsOf = (zone: DnsZone) => {
      const running = cache.get(zone.$id);
      if (running) return running;
      const started = withZone(zone, (token, ref) => providerFor(zone).listRecords(token, ref));
      cache.set(zone.$id, started);
      return started;
    };

    const matches: DomainMatch[] = await Promise.all(
      domains.map(async (domain) => {
        const resolution = resolutionOf(domain);
        const zone = matchZone(domain, zones);
        if (!zone) {
          return { domain, zone: null, plan: null, blocked: null, existing: null, error: null, resolution: await resolution };
        }

        const plan = proxyRecordPlan(domain, zone.name);
        const head = {
          domain,
          zone: { id: zone.$id, name: zone.name, provider: providerOf(zone) },
        };
        if (!plan) {
          return {
            ...head,
            plan: null,
            blocked: t(
              '{domain} ist die Zone selbst. Dort gehört ein A-Eintrag auf diesen Server hin, und der wird von Hand gepflegt.',
              { domain }
            ),
            existing: null,
            error: null,
            resolution: await resolution,
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
            resolution: await resolution,
          };
        } catch (err) {
          // Kein 502 für die ganze Antwort: die anderen Domains sind davon
          // unberührt, und der Dialog soll sagen können, WELCHE Zone klemmt.
          return {
            ...head,
            plan: { fqdn: plan.fqdn, type: plan.type, content: plan.content },
            blocked: null,
            existing: null,
            error: zoneErrorText(err, locale),
            resolution: await resolution,
          };
        }
      })
    );

    return ok(matches);
  } catch (err) {
    return handleError(err);
  }
}
