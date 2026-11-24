/**
 * Was ein DNS-Eintrag ist, wie HAPM ihn vom Anbieter liest und schreibt.
 *
 * Geschrieben wird nur, was HAPM selbst setzt: der CNAME eines Ziels
 * (`sync.ts`) und der Adress-Eintrag aus dem Assistenten (`connect.ts`). Die
 * übrigen Einträge einer Zone verwaltet man beim Anbieter.
 *
 * ── Was je Anbieter anders ist ──
 *
 * Steht in `PROVIDER_RULES` und sonst nirgends: ob es einen Proxy gibt und was
 * „keine eigene TTL" heißt. Wer schreibt, fragt dort, statt den Anbieter beim
 * Namen zu kennen.
 */

import type { DnsProviderId } from './zones';

/** Cloudflare: 1 heißt „automatisch", sonst mindestens 60 Sekunden. */
export const TTL_AUTO = 1;

export interface ProviderRules {
  /** Ob der Anbieter Verkehr über eigene Server leiten kann. Nur Cloudflare. */
  proxy: boolean;
  /**
   * Was „keine eigene TTL" heißt. Cloudflare: 1, der Anbieter entscheidet.
   * Hetzner: `null`, es gilt die Vorgabe der Zone.
   */
  defaultTtl: number | null;
}

export const PROVIDER_RULES: Record<DnsProviderId, ProviderRules> = {
  cloudflare: { proxy: true, defaultTtl: TTL_AUTO },
  hetzner: { proxy: false, defaultTtl: null },
};

/** Ein Eintrag, wie HAPM ihn führt, bei jedem Anbieter gleich. */
export interface DnsRecord {
  /**
   * Die Kennung beim Anbieter. Bei Cloudflare seine eigene, bei Hetzner aus
   * Name, Art und Wert gebildet (`hetzner-rrsets.ts`): dort gibt es keine.
   */
  id: string;
  type: string;
  /** Der volle Name. */
  name: string;
  content: string;
  /** `null`: keine eigene TTL, es gilt die Vorgabe der Zone (Hetzner). */
  ttl: number | null;
  /** Nur bei Cloudflare je wahr. */
  proxied: boolean;
  priority: number | null;
  comment: string | null;
  /** Vom Anbieter gepflegt oder dort geschützt (z. B. der SOA): HAPM ändert ihn nicht. */
  locked: boolean;
}

/** Eine IPv6-Adresse in ihren acht Gruppen ohne führende Nullen, oder `null`. */
function ipv6Groups(address: string): string | null {
  let value = address;
  const mapped = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (mapped) {
    const [, head, a, b, c, d] = mapped;
    const high = ((Number(a) << 8) | Number(b)).toString(16);
    const low = ((Number(c) << 8) | Number(d)).toString(16);
    value = `${head}${high}:${low}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 1 ? gap !== 0 : gap < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? gap : 0).fill('0'), ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16).toString(16)).join(':');
}

/**
 * Ob zwei Schreibweisen dieselbe Adresse meinen.
 *
 * `2001:db8::1` und `2001:0db8:0:0:0:0:0:1` sind dieselbe, und ein Anbieter
 * gibt nicht unbedingt die Form zurück, in der geschrieben wurde. Ohne diesen
 * Vergleich sähe ein Eintrag, der längst stimmt, bei jedem Lauf wie ein
 * falscher aus.
 */
export function sameAddress(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left === right) return true;
  const groups = ipv6Groups(left);
  return groups !== null && groups === ipv6Groups(right);
}
