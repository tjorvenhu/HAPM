import Image from 'next/image';
import { dnsProviderInfo } from '@/lib/dns/provider-info';
import type { DnsProviderId } from '@/lib/dns/zones';

/**
 * Das Zeichen eines DNS-Anbieters. Die Dateien liegen unter `public/providers/`
 * und sind einfarbige Vektoren: `unoptimized`, weil die Bildoptimierung von
 * Next an einem SVG nichts zu tun hat.
 */
export function ProviderLogo({ provider, size }: { provider: DnsProviderId; size: number }) {
  const { logo } = dnsProviderInfo(provider);
  if (!logo) return null;
  return (
    <Image src={logo} alt="" width={size} height={size} className="hapm-provider-logo" unoptimized />
  );
}

/** Zeichen und Name nebeneinander, für die Liste der Zonen und den Kopf einer Zone. */
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
