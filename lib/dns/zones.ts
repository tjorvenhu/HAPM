/**
 * Domain → Zone, und was daraus für einen Eintrag folgt.
 *
 * **Ohne einen einzigen Import**, aus demselben Grund wie
 * `lib/haproxy/config.ts`: das Formular im Browser stellt dieselbe Frage wie
 * die Route auf dem Server — „liegt diese Domain in einer Zone, die wir
 * verwalten, und wie hieße der Eintrag dort?". Zwei Antworten darauf wären ein
 * Dialog, der einen Haken anbietet, den das Speichern danach anders auslegt.
 *
 * Die Zuordnung ist ein Suffixvergleich und keine Textsuche: `kunde.example` liegt
 * nicht in der Zone `fremdekunde.example`, obwohl der Name darin vorkommt. Dieselbe
 * Falle wie beim `-m end -i .kunde.example` der HAProxy-ACL, und derselbe Riegel: der
 * Punkt gehört mit verglichen.
 */

/** Die Eintragsart, die dieses Werkzeug für ein Proxy-Ziel setzt. */
export const PROXY_RECORD_TYPE = 'CNAME';

/** Die Anbieter, bei denen HAPM Zonen verwaltet. */
export type DnsProviderId = 'cloudflare' | 'hetzner';

/**
 * Der acme.sh-Hook, der mit demselben Token arbeitet wie der Bereich „DNS".
 *
 * Die Zuordnung steht hier und nicht bei den Zugangsdaten für acme.sh
 * (`lib/haproxy/dns-credentials.ts`): dort ist der Hook der Schlüssel, hier der
 * Anbieter, und beide Seiten fragen in ihre Richtung.
 */
const PROVIDER_HOOKS: Record<DnsProviderId, string> = {
  hetzner: 'dns_hetznercloud',
  cloudflare: 'dns_cf',
};

/** In der Reihenfolge, in der die Oberfläche sie anbietet. */
export const DNS_PROVIDER_IDS = Object.keys(PROVIDER_HOOKS) as DnsProviderId[];

export function isDnsProviderId(value: unknown): value is DnsProviderId {
  return (DNS_PROVIDER_IDS as unknown[]).includes(value);
}

/** dns_cf → cloudflare, dns_hetznercloud → hetzner, sonst null. */
export function dnsProviderForHook(hook: string): DnsProviderId | null {
  return DNS_PROVIDER_IDS.find((id) => PROVIDER_HOOKS[id] === hook) ?? null;
}

export function hookForDnsProvider(provider: DnsProviderId): string {
  return PROVIDER_HOOKS[provider];
}

/**
 * Der Anbieter einer Zeile aus `dns_zones`.
 *
 * Eine Zeile ohne das Feld ist Cloudflare: sie stammt aus der Zeit, in der es
 * nur diesen Anbieter gab. Deshalb braucht es keine Migration, und deshalb
 * fragt jede Stelle über diese Funktion statt über das Feld.
 */
export function providerOf(zone: { provider?: string | null }): DnsProviderId {
  return isDnsProviderId(zone.provider) ? zone.provider : 'cloudflare';
}

/**
 * Ein Domainname, wie er hier überall verglichen wird.
 *
 * Klein, ohne Rand-Leerzeichen und ohne den abschließenden Punkt: ein Anbieter
 * gibt `kunde.example.` zurück, ein Formular liefert `Kunde.example `, und beides ist
 * dieselbe Domain. Ohne diese eine Stelle wären es drei Schreibweisen, die sich
 * gegenseitig nicht wiederfinden.
 */
export function normalizeDomain(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, '');
}

export function isWildcardDomain(domain: string): boolean {
  return normalizeDomain(domain).startsWith('*.');
}

/**
 * Liegt die Domain in dieser Zone (oder IST sie die Zone)?
 *
 * Die Wildcard braucht dafür keine Sonderbehandlung: `*.kunde.example` endet auf
 * `.kunde.example` wie jeder andere Name darunter. Sie ihr `*.` abzuschneiden war
 * genau der Fehler — dann sah `*.kunde.example` aus wie die Zone selbst, und der
 * Eintrag wurde als „auf der Root nicht möglich" abgewiesen.
 */
export function zoneCovers(zoneName: string, domain: string): boolean {
  const zone = normalizeDomain(zoneName);
  const value = normalizeDomain(domain);
  if (zone === '') return false;
  // Der Punkt ist der Riegel: ohne ihn träfe die Zone `kunde.example` auch
  // `fremdekunde.example`, und ein Eintrag landete in einer fremden Zone.
  return value === zone || value.endsWith(`.${zone}`);
}

/**
 * Welche der eingerichteten Zonen diese Domain trägt.
 *
 * Die LÄNGSTE gewinnt. `intern.kunde.example` liegt in `kunde.example` und in
 * `intern.kunde.example`, falls beide eingerichtet sind — und der Eintrag gehört in
 * die speziellere, denn sonst schriebe das Werkzeug in eine Zone, die für diesen
 * Namen gar nicht mehr zuständig ist. Dieselbe Regel wie beim engeren
 * Wildcard-Muster in `insertServiceBlock`.
 */
export function matchZone<T extends { name: string }>(domain: string, zones: T[]): T | null {
  let best: T | null = null;
  for (const zone of zones) {
    if (!zoneCovers(zone.name, domain)) continue;
    if (!best || normalizeDomain(zone.name).length > normalizeDomain(best.name).length) {
      best = zone;
    }
  }
  return best;
}

/**
 * Die Domain IST die Zone selbst — dort gibt es keinen Namen unterhalb.
 *
 * `*.kunde.example` ist das NICHT: der Stern ist ein eigener Name in der Zone, und
 * ein CNAME darauf verdeckt weder NS noch MX der Root.
 */
export function isZoneApex(domain: string, zoneName: string): boolean {
  return normalizeDomain(domain) === normalizeDomain(zoneName);
}

/**
 * Der Name eines Eintrags innerhalb seiner Zone.
 *
 * Hier werden Einträge unter ihrem vollen Namen geführt (so liefert sie
 * Cloudflare, Hetzner rechnet `lib/dns/hetzner-rrsets.ts` dahin um); eingegeben
 * und angezeigt wird der Teil davor. `@` ist die Zone selbst, so schreiben es
 * beide Anbieter.
 */
export function recordName(domain: string, zoneName: string): string {
  const value = normalizeDomain(domain);
  const zone = normalizeDomain(zoneName);
  if (value === zone) return '@';
  return value.endsWith(`.${zone}`) ? value.slice(0, -(zone.length + 1)) : value;
}

/** Der volle Name aus einem Eintragsnamen: `@` → die Zone, sonst `name.zone`. */
export function recordFqdn(name: string, zoneName: string): string {
  const value = normalizeDomain(name);
  const zone = normalizeDomain(zoneName);
  if (value === '' || value === '@' || value === zone) return zone;
  return value.endsWith(`.${zone}`) ? value : `${value}.${zone}`;
}

/** Der Eintrag, den ein Reverse-Proxy-Ziel in seiner Zone braucht. */
export interface ProxyRecordPlan {
  type: typeof PROXY_RECORD_TYPE;
  /** Der Name innerhalb der Zone, z. B. `app` oder `*`. */
  name: string;
  /** Der volle Name, für Anzeige und Vergleich. */
  fqdn: string;
  /** Worauf er zeigt: die Zone selbst. */
  content: string;
  /** Zählt nur bei Cloudflare. Ein anderer Anbieter kennt das Feld nicht. */
  proxied: boolean;
  /**
   * Cloudflare: 1 heißt „automatisch". Wer den Eintrag schreibt, nimmt die
   * Vorgabe seines Anbieters (`PROVIDER_RULES` in `records.ts`) und nicht
   * diesen Wert.
   */
  ttl: number;
}

/**
 * Was für diese Domain in dieser Zone stehen müsste — oder `null`.
 *
 * **Ein CNAME auf die Zone selbst und keine IP.** Das setzt voraus, dass der
 * A-Eintrag der Root-Domain auf diesen Server zeigt; er wird von Hand gepflegt,
 * und jeder Dienst darunter hängt sich daran. Schriebe dieses Werkzeug
 * stattdessen die Adresse dieses Servers in jeden Eintrag, stünde dieselbe IP
 * in dreißig Einträgen, und ein Umzug hieße dreißig Änderungen statt einer —
 * die Sorte zweite Quelle, die genau dann auffällt, wenn es eilig ist.
 *
 * `null` bei der Zone selbst: ein CNAME auf der Root ist kein zulässiger
 * Eintrag (er verdeckte NS und MX der Zone), und einen A-Eintrag zu erfinden
 * hieße, eine Adresse zu raten. Die Root pflegt der Mensch.
 *
 * **Nicht proxied.** Der Verkehr geht direkt an HAProxy: Let's Encrypt kommt
 * sonst über HTTP-01 nicht durch, und die Client-IP in Log, Statistik und
 * Sperrlisten wäre die von Cloudflare. Bei Hetzner gibt es die Frage nicht.
 */
export function proxyRecordPlan(domain: string, zoneName: string): ProxyRecordPlan | null {
  const value = normalizeDomain(domain);
  const zone = normalizeDomain(zoneName);
  if (!zoneCovers(zone, value) || isZoneApex(value, zone)) return null;
  return {
    type: PROXY_RECORD_TYPE,
    name: recordName(value, zone),
    fqdn: value,
    content: zone,
    proxied: false,
    ttl: 1,
  };
}

/**
 * Ob ein vorgefundener Eintrag der ist, den dieses Werkzeug gesetzt hätte.
 *
 * Die Bedingung fürs Löschen und für den grünen Haken im Dialog. Ein A-Eintrag,
 * den jemand von Hand gesetzt hat, erfüllt sie nicht — er bleibt stehen und wird
 * angezeigt, genauso wie ein HAProxy-Eintrag, der nicht dem Namensschema folgt,
 * gelesen und nicht angefasst wird.
 */
export function isProxyRecord(
  record: { type: string; content: string },
  zoneName: string
): boolean {
  return (
    record.type === PROXY_RECORD_TYPE &&
    normalizeDomain(record.content) === normalizeDomain(zoneName)
  );
}

/**
 * Welche Domains aus dem Formular wirklich einen Eintrag bekommen.
 *
 * Der Schnitt mit den Domains des Dienstes ist der Riegel: die Liste kommt aus
 * dem Browser, und ohne ihn ließe sich über die Reverse-Proxy-Route ein Eintrag
 * in einer beliebigen verwalteten Zone anlegen, ohne dass am Proxy irgendetwas
 * damit zu tun hätte. Dieselbe Überlegung wie bei `lockedDomains`, die auch nur
 * gelten, solange die Domain danebensteht.
 */
export function selectedDnsDomains(requested: unknown, domains: string[]): string[] {
  if (!Array.isArray(requested)) return [];
  const allowed = new Set(domains.map(normalizeDomain));
  return [...new Set(requested.map((value) => normalizeDomain(String(value))))].filter((domain) =>
    allowed.has(domain)
  );
}

/**
 * Die Antwort auf „liegt diese Domain in einer verwalteten Zone, und steht der
 * Eintrag schon?" — `/api/dns/match`.
 *
 * Der Typ steht hier und nicht in der Route, weil beide Seiten ihn brauchen: der
 * Dienst-Dialog des Reverse-Proxys liest ihn, die Route baut ihn. Ein Typ, der
 * in einer `route.ts` steht, zöge deren Importe in die Client-Komponente.
 */
export interface DomainMatch {
  domain: string;
  zone: { id: string; name: string; provider: DnsProviderId } | null;
  /** Der Eintrag, der gesetzt würde. `null`, wenn hier keiner möglich ist. */
  plan: { fqdn: string; type: string; content: string } | null;
  /** Warum kein Eintrag möglich ist. Nur gesetzt, wenn `plan` fehlt und eine Zone da ist. */
  blocked: string | null;
  /** Was dort schon steht. `managed` heißt: genau der Eintrag, den wir setzen würden. */
  existing: { type: string; content: string; managed: boolean } | null;
  /** Der Bestand der Zone war nicht lesbar — `existing` sagt dann nichts aus. */
  error: string | null;
}

/**
 * Prüft, was jemand als Zonennamen eingegeben hat.
 *
 * Eng, weil der Name in jeden Suffixvergleich eingeht: eine Zone `de` deckte
 * jede deutsche Domain ab, und ein Name mit `*` oder `/` darin ist keiner.
 * Zurück kommt die Meldung oder `null`.
 */
export function validateZoneName(value: string): string | null {
  const name = normalizeDomain(value);
  if (name === '') return 'Bitte eine Domain angeben.';
  if (name.startsWith('*.')) {
    return 'Eine Zone ist eine Domain, keine Wildcard. Einträge darunter legt man einzeln an.';
  }
  if (!name.includes('.')) return 'Das ist keine vollständige Domain: der Punkt fehlt.';
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(name)) {
    return 'Erlaubt sind a-z, 0-9, Bindestrich und Punkt.';
  }
  if (name.length > 253) return 'Die Domain ist zu lang.';
  return null;
}
