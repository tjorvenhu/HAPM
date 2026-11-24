import { requireSession } from '@/lib/session';
import { ok, handleError } from '@/lib/api';
import { localServer } from '@/lib/helpers';
import { probeProxy } from '@/lib/haproxy/provision';
import { findScope, parseScopes, type HaproxyScopeInfo } from '@/lib/haproxy/config';
import {
  SEARCH_MIN_LENGTH,
  searchRows,
  searchWords,
  type SearchGroup,
} from '@/lib/search';

/**
 * Die globale Suche (Strg K): die Ziele des Reverse-Proxys. Die Seiten der
 * Navigation filtert die Palette selbst.
 *
 * Gelesen wird wie in `/api/haproxy/services` aus der Konfiguration von HAProxy
 * und nicht aus der Datenbank: dort steht kein Ziel. Jede Zeile wird auf Titel,
 * Nebenzeile und Adresse abgebildet. Kein Feld eines Eintrags geht ungefiltert
 * in die Antwort, die Passwortsperre trägt Hash und Cookie-Wert.
 */

/** Wohin ein Treffer führt: auf die Seite seiner Gruppe. Ein Eintrag ohne Gruppe hat keine. */
function scopeOf(scopes: HaproxyScopeInfo[], name: string | null): HaproxyScopeInfo | undefined {
  return name ? findScope(scopes, name) : undefined;
}

export async function GET(request: Request) {
  try {
    await requireSession();

    const query = (new URL(request.url).searchParams.get('q') ?? '').trim().slice(0, 100);
    if (query.length < SEARCH_MIN_LENGTH) return ok({ groups: [] });
    const words = searchWords(query);

    // Eine Konfiguration, die sich nicht lesen lässt, ist keine Fehlermeldung der
    // Suche: die Seiten der Navigation bleiben trotzdem auffindbar.
    const probe = await probeProxy(localServer()).catch(() => null);
    if (!probe?.configReadable) return ok({ groups: [] });
    const scopes = parseScopes(probe.raw);

    const services = searchRows(
      probe.services,
      words,
      (service) => [
        service.id,
        ...service.domains,
        ...service.servers.map((server) => server.target),
        ...service.routes.flatMap((route) => route.servers.map((server) => server.target)),
        service.redirect?.to,
      ],
      (service) => {
        const scope = scopeOf(scopes, service.scope);
        return {
          title: service.domains[0] ?? service.id,
          subtitle: [service.id, scope?.label].filter(Boolean).join(' · '),
          // `?dienst=` öffnet auf der Seite der Gruppe den Dialog dieses Eintrags.
          href: scope
            ? `/reverse-proxy/${scope.slug}?dienst=${encodeURIComponent(service.id)}`
            : '/reverse-proxy',
        };
      }
    );

    const streams = searchRows(
      probe.streams,
      words,
      (stream) => [stream.id, stream.port, ...stream.servers.map((server) => server.target)],
      (stream) => {
        const scope = scopeOf(scopes, stream.scope);
        return {
          title: stream.port === null ? stream.id : `Port ${stream.port}`,
          subtitle: [stream.id, scope?.label].filter(Boolean).join(' · '),
          href: scope ? `/reverse-proxy/${scope.slug}` : '/reverse-proxy',
        };
      }
    );

    const found: SearchGroup[] = [
      { label: 'Ziele', items: services },
      { label: 'TCP-Weiterleitungen', items: streams },
    ];

    return ok({ groups: found.filter((group) => group.items.length > 0) });
  } catch (err) {
    return handleError(err);
  }
}
