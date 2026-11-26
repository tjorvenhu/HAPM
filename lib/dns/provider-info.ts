/**
 * Name, Zeichen und Konsole eines DNS-Anbieters, für Oberfläche und Meldungen.
 *
 * Die Angaben stehen genau einmal, bei den Zugangsdaten für acme.sh
 * (`DNS_PROVIDERS` in `lib/haproxy/dns-credentials.ts`): es ist derselbe
 * Anbieter und derselbe Zugang, ob acme.sh damit eine Wildcard ausstellt oder
 * HAPM damit Einträge schreibt. Diese Datei schlägt nur über den Hook nach.
 *
 * Ohne Import, der `lib/db` erreicht: der Dialog unter `/dns` lädt sie.
 */

import {
  findDnsProvider,
  hasCredentialForm,
  validateDnsCredentials,
  zoneAccess,
  type DnsCredentialField,
} from '../haproxy/dns-credentials';
import type { Message } from '../i18n/translate';
import { DNS_PROVIDER_IDS, hookForDnsProvider, type DnsProviderId } from './zones';

export interface DnsProviderInfo {
  id: DnsProviderId;
  /** Der acme.sh-Hook desselben Anbieters, Schlüssel zu `DNS_PROVIDERS`. */
  hook: string;
  label: string;
  /** Die Datei unter `public/providers/`. `null`: der Anbieter hat kein Zeichen. */
  logo: string | null;
  /** Wo der Token entsteht. `null` bei einem Anbieter, den man selbst betreibt. */
  consoleUrl: string | null;
  /** Welcher Token es sein muss. Nur bei einem Anbieter mit einem Token. */
  tokenHint: string | null;
  /**
   * Der Zugang besteht aus mehreren Angaben (`fields`) statt aus einem Token:
   * RFC 2136 und Infoblox.
   */
  form: boolean;
  fields: readonly DnsCredentialField[];
}

export function dnsProviderInfo(id: DnsProviderId): DnsProviderInfo {
  const hook = hookForDnsProvider(id);
  const provider = findDnsProvider(hook);
  const form = provider ? hasCredentialForm(provider) : false;
  return {
    id,
    hook,
    label: provider?.label ?? id,
    logo: provider?.logo ?? null,
    consoleUrl: provider?.consoleUrl ?? null,
    tokenHint: form ? null : (provider?.fields.find((field) => field.required)?.hint ?? null),
    form,
    fields: provider?.fields ?? [],
  };
}

export function dnsProviderLabel(id: DnsProviderId): string {
  return dnsProviderInfo(id).label;
}

export const DNS_PROVIDER_INFOS: readonly DnsProviderInfo[] = DNS_PROVIDER_IDS.map(dnsProviderInfo);

/**
 * Der Zugang aus dem, was ein Formular schickt: der eine Token, oder die Felder
 * des Anbieters (`values`, nach Feldnamen). Dieselbe Prüfung wie für die
 * Zugangsdaten von acme.sh, damit unter „DNS" nichts durchgeht, was dort
 * abgelehnt würde. Zurück kommt der Zugang als Text oder die Meldung.
 */
export function accessFromInput(
  id: DnsProviderId,
  input: { token?: unknown; values?: unknown }
): { access: string } | { error: Message } {
  const info = dnsProviderInfo(id);
  const provider = findDnsProvider(info.hook);
  if (!provider || !info.form) return { access: typeof input.token === 'string' ? input.token.trim() : '' };

  const raw = typeof input.values === 'object' && input.values !== null ? (input.values as Record<string, unknown>) : {};
  const values: Record<string, string> = {};
  for (const field of provider.fields) {
    const value = raw[field.name];
    values[field.name] = typeof value === 'string' ? value.trim() : '';
  }
  const invalid = validateDnsCredentials({ hook: info.hook, values, remove: false });
  return invalid ? { error: invalid } : { access: zoneAccess(provider, values) };
}
