import os from 'node:os';
import { Resolver } from 'node:dns/promises';
import type { Exposure } from '../types';
import { lookupPublicAddress } from './public-address';
import { hasPublicIpv4, judgeAddresses, orderRecordAddresses, pickServerAddresses, type AddressVerdict } from './rules';

/** Die Adressen dieses Servers. Beide Container laufen im Netz des Hosts, es sind also seine. */
export function serverAddresses(): string[] {
  return pickServerAddresses(os.networkInterfaces());
}

/**
 * Die Adressen für den DNS-Eintrag der Oberfläche, die beste zuerst
 * (`orderRecordAddresses`). Nach außen gefragt wird nur bei einer Installation
 * aus dem Internet, deren Schnittstellen keine öffentliche IPv4-Adresse tragen.
 */
export async function recordAddresses(exposure: Exposure | null): Promise<string[]> {
  const own = serverAddresses();
  const outside = exposure === 'public' && !hasPublicIpv4(own) ? await lookupPublicAddress() : null;
  return orderRecordAddresses(own, exposure, outside);
}

/** Antworten, die „es gibt keinen Eintrag" heißen und nicht „die Abfrage ging nicht". */
const NO_RECORD = new Set(['ENOTFOUND', 'ENODATA']);

/** A und AAAA bei einem Resolver. `null`: beide Abfragen sind gescheitert. */
async function askAddresses(resolver: Resolver, domain: string): Promise<string[] | null> {
  const lookup = async (query: () => Promise<string[]>): Promise<string[] | null> => {
    try {
      return await query();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      return NO_RECORD.has(code) ? [] : null;
    }
  };
  const [v4, v6] = await Promise.all([
    lookup(() => resolver.resolve4(domain)),
    lookup(() => resolver.resolve6(domain)),
  ]);
  if (v4 === null && v6 === null) return null;
  return [...(v4 ?? []), ...(v6 ?? [])];
}

/** Die Zonen, in denen die Domain liegen kann, die engste zuerst: `a.b.example.org`, `b.example.org`, `example.org`. Rein. */
export function zoneCandidates(domain: string): string[] {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.').filter(Boolean);
  const zones: string[] = [];
  for (let from = 0; from < labels.length - 1; from++) zones.push(labels.slice(from).join('.'));
  return zones;
}

/** Wie viele Nameserver einer Zone gefragt werden. Einer, der antwortet, genügt. */
const MAX_NAMESERVERS = 3;

/**
 * Die Adressen der Nameserver, die für die Domain zuständig sind: von der
 * Domain aufwärts die erste Zone, die Nameserver nennt.
 */
async function nameserverAddresses(resolver: Resolver, domain: string): Promise<string[]> {
  for (const zone of zoneCandidates(domain)) {
    const names = await resolver.resolveNs(zone).catch(() => [] as string[]);
    if (names.length === 0) continue;
    const found = await Promise.all(
      names.slice(0, MAX_NAMESERVERS).map((name) => resolver.resolve4(name).catch(() => [] as string[]))
    );
    const addresses = found.flat();
    if (addresses.length > 0) return addresses.slice(0, MAX_NAMESERVERS);
  }
  return [];
}

/**
 * Dieselbe Frage direkt an die Nameserver der Domain.
 *
 * Wer die Domain fragt, BEVOR es den Eintrag gibt, bekommt „gibt es nicht", und
 * sein Resolver merkt sich das: je nach Zone eine halbe bis ganze Stunde. Ein
 * eben angelegter Eintrag bleibt so lange unsichtbar, obwohl er längst gilt.
 * Die Nameserver der Zone merken sich nichts, sie haben den Eintrag oder
 * nicht. Auch der ACME-Server fragt dort und nicht bei unserem Resolver.
 *
 * Ein CNAME zeigt aus der Zone heraus: dessen Ziel löst der gewöhnliche
 * Resolver auf. Leer heißt weiterhin: es gibt keinen Eintrag.
 */
async function askAuthoritative(resolver: Resolver, domain: string): Promise<string[]> {
  const servers = await nameserverAddresses(resolver, domain);
  if (servers.length === 0) return [];
  const direct = new Resolver({ timeout: 2500, tries: 1 });
  direct.setServers(servers);
  const addresses = await askAddresses(direct, domain);
  if (addresses && addresses.length > 0) return addresses;
  const alias = await direct.resolveCname(domain).catch(() => [] as string[]);
  if (alias.length === 0) return [];
  return (await askAddresses(resolver, alias[0])) ?? [];
}

/**
 * Worauf die Domain zeigt: A und AAAA zusammen. Leer heißt, es gibt keinen
 * Eintrag. `null` heißt, die Abfrage selbst ist gescheitert, und das ist keine
 * Auskunft über die Domain.
 *
 * Findet der Resolver des Servers nichts, werden die Nameserver der Domain
 * selbst gefragt (`askAuthoritative`): ein gerade erst angelegter Eintrag steht
 * dort sofort.
 */
export async function resolveDomain(domain: string): Promise<string[] | null> {
  const resolver = new Resolver({ timeout: 3000, tries: 2 });
  const seen = await askAddresses(resolver, domain);
  if (seen && seen.length > 0) return seen;
  const fresh = await askAuthoritative(resolver, domain).catch(() => [] as string[]);
  return fresh.length > 0 ? fresh : seen;
}

export interface AddressCheck {
  domain: string;
  /** `null`: die Abfrage ist gescheitert. */
  resolved: string[] | null;
  verdict: AddressVerdict;
  serverAddresses: string[];
}

export async function checkDomainAddress(domain: string, exposure: Exposure | null = null): Promise<AddressCheck> {
  const own = await recordAddresses(exposure);
  const resolved = await resolveDomain(domain);
  return { domain, resolved, verdict: judgeAddresses(resolved, own), serverAddresses: own };
}
