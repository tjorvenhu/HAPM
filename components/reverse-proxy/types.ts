import type {
  HaproxyScope,
  HaproxyScopeInfo,
  HaproxyService,
  HeaderDirection,
  ServiceHealth,
} from '@/lib/haproxy/config';
import type { HaproxyStream } from '@/lib/haproxy/streams';
import type { SurfaceTarget } from '@/lib/haproxy/protected';
import type { CertificateSource, Exposure } from '@/lib/types';

/**
 * HAProxy mit dem, was gerade in seiner `haproxy.cfg` steht.
 * Die Antwort von `/api/haproxy/services` — es gibt keine Collection dahinter,
 * gelesen wird bei jedem Aufruf direkt aus der Datei.
 *
 * Die Route liefert eine Liste mit genau einem Eintrag.
 */
export interface ProxyRow {
  $id: string;
  name: string;
  host: string;
  version: string | null;
  acmeReady: boolean;
  /** Wie viele Zeilen der Grundkonfiguration in der Datei fehlen. Fehlt das
   *  Feld (andere Routen), ist es unbekannt. */
  baseConfigMissing?: number;
  /** Die eingerichteten acme.sh-DNS-Hooks. Leer heißt: keine
   *  Wildcard ausstellbar, denn HTTP-01 kann sie nicht. */
  dnsHooks: string[];
  /** Intern oder öffentlich. Bei `internal` geht jedes Zertifikat über DNS-01. */
  exposure: Exposure;
  /** `upload`: HAPM beantragt nie selbst, ein Ziel braucht ein vorhandenes Zertifikat. */
  certificateSource: CertificateSource;
  /** Ein eigener ACME-Server erreicht HAPM über Port 80: HTTP-01 auch intern. */
  httpChallenge: boolean;
  /** Die Domains jeder gültigen PEM-Datei auf der Maschine. */
  presentCertificates: string[][];
  services: HaproxyService[];
  /** Das Ziel, über das die Adresse von HAPM läuft. Es und seine Gruppe lassen
   *  sich nicht entfernen (`lib/haproxy/protected.ts`). `null`: es gibt keins. */
  surface: SurfaceTarget | null;
  /** Die TCP-Weiterleitungen derselben Datei: `listen`-Abschnitte in `mode tcp`.
   *  Sie stehen in denselben Marker-Blöcken und deshalb auf denselben
   *  Gruppenseiten wie die Dienste. */
  streams: HaproxyStream[];
  /** Die Gruppen, aus den Marker-Paaren der Datei gelesen. */
  scopes: HaproxyScopeInfo[];
  /** Die Adressen aus `acl admin_ips src …`. Ohne mindestens eine lässt sich
   *  kein Eintrag auf sie sperren. */
  adminIps: string[];
  /** Die Header, die das Frontend schon für alle Ziele setzt, je Richtung. */
  globalHeaders: Record<HeaderDirection, string[]>;
  /** `timeout tunnel` aus dem `defaults`-Block, oder `null`: dann gilt es nicht für alle. */
  defaultsTunnel: string | null;
  /** Was HAProxy über die Ziele weiß, je Dienst-ID. Ein fehlender Eintrag heißt
   *  „nicht bekannt" und nicht „in Ordnung". */
  health: Record<string, ServiceHealth>;
  error: string | null;
}

/**
 * Die Seiten, in die die Liste zerfällt: eine je Gruppe.
 *
 * Eine Seite je Gruppe statt aller Abschnitte untereinander: die Liste wächst
 * mit jedem Eintrag, und wer einen Dienst sucht, scrollte sonst an allen
 * anderen Gruppen vorbei. Die Aufteilung ist keine Erfindung der Oberfläche —
 * es sind die Marker-Blöcke der Konfiguration.
 *
 * Sie ist nicht aufgezählt: welche es gibt, sagt die Datei. Eine feste Liste
 * hier wäre die zweite Quelle daneben, und eine neue Gruppe bräuchte einen
 * Commit. Eine frische Installation hat keine.
 *
 * Für alles außerhalb der Marker gibt es keine Gruppe und keine Seite: das
 * sind Einträge, die dieses Werkzeug ohnehin nicht anfasst. Dass es sie gibt,
 * bleibt trotzdem sichtbar (`unmanagedCount`) — ein Dienst, der nirgends
 * auftaucht, ist der Grund, aus dem später eine Domain doppelt vergeben wird.
 */
export interface ScopePage {
  /** Der Teil in der Adresse: /reverse-proxy/<slug>. */
  slug: string;
  /** Der Name im Marker. */
  scope: HaproxyScope;
  title: string;
  /** Ob sie sich wieder entfernen ließe. */
  removable: boolean;
  /** Gesetzt, wenn in ihr das Ziel der Oberfläche liegt: dann bleibt sie stehen. */
  surface: SurfaceTarget | null;
}

/** Die Gruppen: die Marker-Blöcke der Konfiguration. */
export function scopePages(proxies: ProxyRow[]): ScopePage[] {
  const pages = new Map<string, ScopePage>();
  for (const proxy of proxies) {
    for (const scope of proxy.scopes) {
      const key = scope.name.toUpperCase();
      const surface = proxy.surface?.scope?.toUpperCase() === key ? proxy.surface : null;
      const existing = pages.get(key);
      if (existing) {
        existing.removable = existing.removable && scope.removable;
        existing.surface = existing.surface ?? surface;
        continue;
      }
      pages.set(key, {
        slug: scope.slug,
        scope: scope.name,
        title: scope.label,
        removable: scope.removable,
        surface,
      });
    }
  }
  return [...pages.values()];
}

export function scopePageFor(proxies: ProxyRow[], slug: string): ScopePage | undefined {
  return scopePages(proxies).find((page) => page.slug === slug);
}

/** Alle Dienste einer Gruppe. */
export function servicesInScope(
  proxies: ProxyRow[],
  scope: HaproxyScope
): { proxy: ProxyRow; service: HaproxyService }[] {
  return proxies.flatMap((proxy) =>
    proxy.services
      .filter((service) => service.scope?.toUpperCase() === scope.toUpperCase())
      .map((service) => ({ proxy, service }))
  );
}

/** Dasselbe für die TCP-Weiterleitungen. Sie liegen in denselben Gruppen und
 *  stehen auf derselben Seite, nur unter eigener Überschrift. */
export function streamsInScope(
  proxies: ProxyRow[],
  scope: HaproxyScope
): { proxy: ProxyRow; stream: HaproxyStream }[] {
  return proxies.flatMap((proxy) =>
    proxy.streams
      .filter((stream) => stream.scope?.toUpperCase() === scope.toUpperCase())
      .map((stream) => ({ proxy, stream }))
  );
}

/** Einträge außerhalb jedes Marker-Blocks. Sie haben keine Seite mehr, aber die
 *  Übersicht nennt ihre Anzahl. Die TCP-Weiterleitungen zählen mit: ein
 *  `listen`-Abschnitt, den niemand sieht, ist der Grund, aus dem später ein
 *  Port doppelt vergeben wird. */
export function unmanagedCount(proxies: ProxyRow[]): number {
  return proxies.reduce(
    (sum, proxy) =>
      sum +
      proxy.services.filter((service) => service.scope === null).length +
      proxy.streams.filter((stream) => stream.scope === null).length,
    0
  );
}
