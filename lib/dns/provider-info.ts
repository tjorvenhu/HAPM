/**
 * Name, Zeichen und Konsole eines DNS-Anbieters, für Oberfläche und Meldungen.
 *
 * Die Angaben stehen genau einmal, bei den Zugangsdaten für acme.sh
 * (`DNS_PROVIDERS` in `lib/haproxy/dns-credentials.ts`): es ist derselbe
 * Anbieter und dasselbe Token, ob acme.sh damit eine Wildcard ausstellt oder
 * HAPM damit Einträge schreibt. Diese Datei schlägt nur über den Hook nach.
 *
 * Ohne Import, der `lib/db` erreicht: der Dialog unter `/dns` lädt sie.
 */

import { findDnsProvider } from '../haproxy/dns-credentials';
import { DNS_PROVIDER_IDS, hookForDnsProvider, type DnsProviderId } from './zones';

export interface DnsProviderInfo {
  id: DnsProviderId;
  label: string;
  /** Die Datei unter `public/providers/`. */
  logo: string | null;
  /** Wo der Token entsteht. */
  consoleUrl: string | null;
  /** Welcher Token es sein muss. */
  tokenHint: string | null;
}

export function dnsProviderInfo(id: DnsProviderId): DnsProviderInfo {
  const provider = findDnsProvider(hookForDnsProvider(id));
  return {
    id,
    label: provider?.label ?? id,
    logo: provider?.logo ?? null,
    consoleUrl: provider?.consoleUrl ?? null,
    tokenHint: provider?.fields.find((field) => field.required)?.hint ?? null,
  };
}

export function dnsProviderLabel(id: DnsProviderId): string {
  return dnsProviderInfo(id).label;
}

export const DNS_PROVIDER_INFOS: readonly DnsProviderInfo[] = DNS_PROVIDER_IDS.map(dnsProviderInfo);
