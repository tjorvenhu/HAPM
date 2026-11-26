import Image from 'next/image';
import { Network, ServerCog, type LucideIcon } from 'lucide-react';
import { dnsProviderInfo } from '@/lib/dns/provider-info';
import type { DnsProviderId } from '@/lib/dns/zones';

/**
 * Anbieter ohne eigenes Zeichen: ein Nameserver, den man selbst betreibt, hat
 * keins, und das von Infoblox liegt hier nicht. Sie bekommen ein Symbol in der
 * Akzentfarbe, wie die Karte „Eigener DNS-Server" im Assistenten.
 */
const ICONS: Partial<Record<DnsProviderId, LucideIcon>> = {
  rfc2136: ServerCog,
  infoblox: Network,
};

/**
 * Das Zeichen eines DNS-Anbieters. Die Dateien liegen unter `public/providers/`
 * und sind einfarbige Vektoren: `unoptimized`, weil die Bildoptimierung von
 * Next an einem SVG nichts zu tun hat.
 */
export function ProviderLogo({ provider, size }: { provider: DnsProviderId; size: number }) {
  const { logo } = dnsProviderInfo(provider);
  if (logo) {
    return <Image src={logo} alt="" width={size} height={size} className="hapm-provider-logo" unoptimized />;
  }
  const Icon = ICONS[provider];
  // Ein Symbol wirkt bei gleicher Kantenlänge größer als ein Zeichen mit Rand.
  return Icon ? (
    <Icon size={size <= 20 ? size : Math.round(size * 0.65)} strokeWidth={1.5} aria-hidden="true" />
  ) : null;
}

/** Zeichen und Name nebeneinander, für die Liste der Zonen. */
export default function ProviderName({
  provider,
  size = 16,
}: {
  provider: DnsProviderId;
  size?: number;
}) {
  return (
    <span className="hapm-provider">
      <ProviderLogo provider={provider} size={size} />
      {dnsProviderInfo(provider).label}
    </span>
  );
}
