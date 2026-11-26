/**
 * Der geteilte Teil von `/api/internal/haproxy/**` — die Reverse-Proxy-API für
 * andere Dienste.
 *
 * ── Warum es sie gibt ──
 *
 * Ein Deploy-Skript oder eine Pipeline braucht für ein neues Projekt eine
 * Domain am Reverse-Proxy. Ohne diesen Weg wäre das ein Dialog, den jemand von
 * Hand ausfüllt. Die Richtung ist **Aufrufer → HAPM**, nie umgekehrt.
 *
 * ── Was hier NICHT noch einmal entsteht ──
 *
 * Kein zweiter Weg auf `haproxy.cfg`. Die Routen unter `/api/internal` nehmen
 * denselben Rumpf (`readServiceInput`), prüfen ihn mit derselben Funktion
 * (`validateCreateInput`), gehen durch dieselbe Vorabprüfung (`precheck*`) und
 * starten denselben abgekoppelten Lauf (`startHaproxyRun`) wie der Dialog. Ein
 * eigener Schreibpfad „für Dienste" wäre der, in dem eine Regel fehlt, die man
 * beim Dialog später ergänzt — und aufgefallen wäre das im Betrieb, nicht
 * hier.
 *
 * Der einzige Unterschied ist der Aufrufer: ein Token statt einer Sitzung, und
 * damit `serviceActor` im Audit und in der Historie. Wer im Nachhinein fragt,
 * wer diese Domain angelegt hat, liest den Namen des Tokens und nicht eine
 * E-Mail-Adresse, die es nie gab.
 *
 * ── Eine Maschine, als Liste ──
 *
 * HAPM verwaltet genau ein HAProxy (`localServer()`). `serverId`, `serverName`
 * und die Listen in den Antworten gehören trotzdem zur Schnittstelle: ein
 * Aufrufer findet darin immer genau einen Eintrag und muss keine Kennung
 * mitschicken.
 */

import { ApiError } from '../api';
import { msg, msgid } from '../i18n/translate';
import { getClientIP } from '../audit';
import { autoDnsDomains } from '../dns/sync';
import { selectedDnsDomains } from '../dns/zones';
import { probeProxy, type ProxyProbe } from './provision';
import {
  parseGlobalSettings,
  parseScopes,
  scopeSlug,
  serviceHealth,
  type BackendTls,
  type HeaderRule,
  type HaproxyService,
  type HaproxyScopeInfo,
  type ServiceHealth,
} from './config';
import type { HaproxyStream } from './streams';
import { surfaceTarget, type SurfaceProtection, type SurfaceTarget } from './protected';
import type { HaproxyActor } from './runner';
import type { Server } from '../types';
import { localServer } from '../helpers';

/** Die Maschinen dieser API: immer genau eine, als Liste. */
export async function proxyServers(): Promise<Server[]> {
  return [localServer()];
}

/**
 * Die Maschine, auf der der Aufruf landet.
 *
 * Ohne Angabe die lokale: ein Aufrufer muss keine Kennung kennen, die es nur
 * einmal gibt. Eine genannte `serverId` wird trotzdem geprüft und nicht
 * ignoriert. Ein Aufrufer, der eine fremde Kennung schickt, meint einen
 * anderen Server, und ihm hier stillschweigend zu antworten hieße,
 * seine Domain an der falschen Stelle anzulegen.
 */
export async function resolveProxy(serverId: unknown): Promise<Server> {
  const wanted = String(serverId ?? '').trim();
  const local = localServer();

  if (wanted && wanted !== local.$id) {
    throw new ApiError(
      msg('Kein Reverse-Proxy mit der ID "{wanted}". HAPM verwaltet genau einen: "{id}". serverId kann weggelassen werden.', {
        wanted,
        id: local.$id,
      }),
      404
    );
  }
  return local;
}

/**
 * Der Aufrufer als Actor für Lauf und Audit.
 *
 * `HaproxyActor` heißt sein zweites Feld `email`, weil es beim Menschen eine
 * ist; hier steht der Name des Dienstes darin. Das ist kein Notbehelf, sondern
 * genau das, was `serviceActor` überall sonst auch tut — die Zeile in der
 * Historie soll den Namen des Tokens tragen und nicht `service:68a3f1c2`.
 *
 * `serviceActor` wird bewusst NICHT hier drin aufgerufen, sondern in der Route
 * hineingereicht: so steht in jeder schreibenden Routendatei sichtbar, dass sie
 * den Dienst ins Audit schreibt.
 */
export function haproxyActor(
  actor: { userId: string; userEmail: string },
  request: Request
): HaproxyActor {
  return { userId: actor.userId, email: actor.userEmail, ip: getClientIP(request) };
}

/**
 * Welche Domains einen DNS-Eintrag bekommen.
 *
 * Drei Formen, und alle drei sind Ansagen des Aufrufers:
 *   - fehlt      → keine. Wie im Dialog, wenn niemand einen Haken setzt.
 *   - `'auto'`   → jede Domain, für die es hier eine Zone gibt (`autoDnsDomains`).
 *   - Liste      → genau diese, geschnitten mit den Domains des Dienstes.
 *
 * Der Schnitt ist derselbe Riegel wie im Browser-Weg (`selectedDnsDomains`):
 * ohne ihn ließe sich über die Dienst-Route ein Eintrag in einer beliebigen
 * verwalteten Zone anlegen, ohne dass am Proxy irgendetwas damit zu tun hätte.
 */
export async function readDnsDomains(value: unknown, domains: string[]): Promise<string[]> {
  if (value === 'auto') return autoDnsDomains(domains);
  return selectedDnsDomains(value, domains);
}

/**
 * Ein Ziel, wie es ein anderer Dienst liest.
 *
 * `weight: null` heißt **keine `weight`-Angabe** und nicht 1. Ein Aufrufer, der
 * ein GET macht, etwas ändert und zurückschickt, würde sonst eine Zahl in jede
 * Zeile schreiben, in der vorher keine stand — der Diff wäre voll von
 * Änderungen, die niemand angefordert hat.
 */
export interface ServerEntry {
  name: string;
  target: string;
  check: boolean;
  weight: number | null;
}

function serverEntry(s: {
  name: string;
  target: string;
  check: boolean;
  weight: number | null;
}): ServerEntry {
  return { name: s.name, target: s.target, check: s.check, weight: s.weight };
}

/**
 * Ein Dienst, wie ihn ein anderer Dienst liest.
 *
 * Flach und ohne die Felder, die nur die Oberfläche braucht: `aclName` und
 * `auto` sind Innenleben der Konfiguration. `editable`, `removable` und
 * `shadowedBy` stehen dagegen mit drin, weil sie Antworten auf Fragen sind, die
 * ein Aufrufer VOR seinem nächsten Aufruf hat — ein PATCH auf einen Eintrag mit
 * `editable: false` wird abgelehnt, und das soll er vorher wissen können.
 */
export interface ServiceView {
  serverId: string;
  serverName: string;
  id: string;
  scope: string | null;
  /** Der Adressteil der Gruppe, für einen Link in die Oberfläche. */
  scopeSlug: string | null;
  domains: string[];
  lockedDomains: string[];
  /**
   * Wie die gesperrten Domains gesperrt sind: `ip` über die Admin-IPs,
   * `password` mit einer Passwortabfrage, `null` ohne gesperrte Domain.
   *
   * Nur die Art. Hash und Cookie-Wert der Passwortsperre gehen nicht hinaus:
   * der Cookie-Wert ist der Durchlass selbst.
   */
  lockMode: 'ip' | 'password' | null;
  servers: ServerEntry[];
  /** Gesetzt heißt: der Eintrag leitet weiter, statt etwas zu bedienen. Dann
   *  sind `servers` und `routes` leer. */
  redirect: { to: string; keepPath: boolean; permanent: boolean } | null;
  /** Die Ziele einer Pfad-Regel tragen kein `weight`: sie verteilen nichts, sie
   *  trennen. Siehe `RouteServerInput`. */
  routes: {
    name: string;
    paths: string[];
    servers: { name: string; target: string; check: boolean }[];
    check: boolean;
    backendTls: BackendTls;
  }[];
  /** Das Verteilverfahren. `null` heißt: keine `balance`-Zeile, es gilt der
   *  `defaults`-Block der Maschine. Nicht „roundrobin" — was dort steht, weiß
   *  auch dieser Aufruf nicht. */
  balance: string | null;
  /** Sitzungsbindung über einen Cookie. */
  sticky: boolean;
  /** Feste Header an den Besucher und an das Ziel, und ob offene Verbindungen
   *  lange bleiben (`timeout tunnel 1h`). Was früher `preset` hieß, steht hier
   *  als das, was es in der Datei immer war: zwei Header bzw. das Timeout. */
  responseHeaders: HeaderRule[];
  requestHeaders: HeaderRule[];
  tunnel: boolean;
  /** CrowdSec prüft die Anfragen an dieses Ziel (eigener Schalter, nicht global). */
  crowdsec: boolean;
  /** Die Anwendung hinter dem Ziel (`APP_RULES`), `null` keine. */
  app: string | null;
  healthcheck: boolean;
  /** Wie HAProxy die Ziele anspricht: `off` HTTP, `insecure` HTTPS ohne
   *  Prüfung des Zertifikats, `verify` HTTPS gegen die CAs des Systems. */
  backendTls: BackendTls;
  editable: boolean;
  removable: boolean;
  /**
   * Über dieses Ziel läuft die Adresse von HAPM (`protected.ts`). Dann wird ein
   * DELETE abgelehnt, auch bei `removable: true`, und ein PATCH, nach dem das
   * Ziel die Domain der Oberfläche nicht mehr trägt.
   */
  surface: boolean;
  /** Die ID des Eintrags, dessen Weiche diesem den Verkehr wegnimmt. */
  shadowedBy: string | null;
  /** Was der Bearbeiten-Weg nicht abbilden kann. Leer ist der Normalfall. */
  extras: string[];
  /** Was HAProxy über die Ziele sagt. `unknown` heißt: kein Stats-Socket, kein
   *  socat oder kein Healthcheck — nie „alles unten". */
  health: ServiceHealth;
}

export function serviceView(
  server: Server,
  service: HaproxyService,
  health: ServiceHealth,
  surface: SurfaceTarget | null
): ServiceView {
  return {
    serverId: server.$id,
    serverName: server.name,
    id: service.id,
    scope: service.scope,
    scopeSlug: service.scope ? scopeSlug(service.scope) : null,
    domains: service.domains,
    lockedDomains: service.lockedDomains,
    lockMode:
      service.lockedDomains.length === 0 ? null : service.passwordLock ? 'password' : 'ip',
    servers: service.servers.map(serverEntry),
    redirect: service.redirect ? { ...service.redirect } : null,
    routes: service.routes.map((route) => ({
      name: route.name,
      paths: route.paths,
      servers: route.servers.map((s) => ({ name: s.name, target: s.target, check: s.check })),
      check: route.check,
      backendTls: route.backendTls,
    })),
    balance: service.balance,
    sticky: service.sticky,
    responseHeaders: service.responseHeaders,
    requestHeaders: service.requestHeaders,
    tunnel: service.tunnel,
    crowdsec: service.crowdsec,
    app: service.app,
    healthcheck: service.healthcheck,
    backendTls: service.backendTls,
    editable: service.editable,
    removable: service.removable,
    surface: surface?.serviceId === service.id,
    shadowedBy: service.shadowedBy,
    extras: service.extras,
    health,
  };
}

/** Die Dienste einer Maschine aus einer bereits gelesenen Probe. */
export function servicesOf(
  server: Server,
  probe: ProxyProbe,
  protection: SurfaceProtection
): ServiceView[] {
  const surface = surfaceTarget(probe.services, protection);
  return probe.services.map((service) =>
    serviceView(server, service, serviceHealth(service, probe.serverStates), surface)
  );
}

/**
 * Eine TCP-Weiterleitung, wie sie ein anderer Dienst liest.
 *
 * Flach wie `ServiceView` und mit denselben drei Auskünften über den nächsten
 * Aufruf: `editable`, `removable` und `extras`. Was hier fehlt und dort steht,
 * fehlt aus einem Grund — es gibt keine Domains, kein Zertifikat, keinen
 * DNS-Eintrag und keine Sperre über die Admin-IPs.
 *
 * `port: null` heißt **unbekannt** und nicht 0: der Abschnitt trägt keine
 * lesbare `bind`-Zeile. Dann ist er auch nicht bearbeitbar.
 */
export interface StreamView {
  serverId: string;
  serverName: string;
  id: string;
  scope: string | null;
  scopeSlug: string | null;
  port: number | null;
  servers: ServerEntry[];
  balance: string | null;
  check: boolean;
  /** Von welchen Adressen der Port erreichbar ist. **Leer heißt: von überall** —
   *  eine Auskunft, die ein Aufrufer vor seinem nächsten Schritt haben will. */
  allowedSources: string[];
  editable: boolean;
  removable: boolean;
  extras: string[];
  health: ServiceHealth;
}

export function streamView(
  server: Server,
  stream: HaproxyStream,
  health: ServiceHealth
): StreamView {
  return {
    serverId: server.$id,
    serverName: server.name,
    id: stream.id,
    scope: stream.scope,
    scopeSlug: stream.scope ? scopeSlug(stream.scope) : null,
    port: stream.port,
    servers: stream.servers.map(serverEntry),
    balance: stream.balance,
    check: stream.check,
    allowedSources: stream.allowedSources,
    editable: stream.editable,
    removable: stream.removable,
    extras: stream.extras,
    health,
  };
}

/** Die TCP-Weiterleitungen einer Maschine aus einer bereits gelesenen Probe.
 *  Ein `listen`-Abschnitt taucht in `show stat` unter seinem Namen auf wie
 *  jedes Backend, hat aber keine Pfad-Regeln. */
export function streamsOf(server: Server, probe: ProxyProbe): StreamView[] {
  return probe.streams.map((stream) =>
    streamView(server, stream, serviceHealth({ id: stream.id, routes: [] }, probe.serverStates))
  );
}

/**
 * Was eine Maschine über sich sagt, ohne ihre Dienste.
 *
 * Der Aufruf, mit dem eine Pipeline anfängt: sie braucht `serverId`, die
 * Gruppen (`scope` ist ein Pflichtfeld beim Anlegen), und die Auskunft, ob
 * überhaupt ein Zertifikat ausgestellt werden kann. Ein `acmeReady: false`
 * hinterher ist ein Lauf, der auf halbem Weg stehen bleibt.
 */
export interface ProxyView {
  id: string;
  name: string;
  host: string;
  version: string | null;
  acmeReady: boolean;
  dnsHooks: string[];
  scopes: HaproxyScopeInfo[];
  adminIps: string[];
  serviceCount: number;
  /** Wie viele TCP-Weiterleitungen dort stehen. Getrennt gezählt: sie beantworten
   *  eine andere Frage („welche Ports sind offen") und brauchen kein acme.sh. */
  streamCount: number;
  error: string | null;
}

export async function proxyView(server: Server): Promise<ProxyView> {
  const base = { id: server.$id, name: server.name, host: server.host };
  try {
    const probe = await probeProxy(server);
    if (!probe.configReadable) {
      return {
        ...base,
        version: probe.version,
        acmeReady: probe.acmeReady,
        dnsHooks: probe.dnsHooks,
        scopes: [],
        adminIps: [],
        serviceCount: 0,
        streamCount: 0,
        // Deutscher Schlüssel: die Route übersetzt ihn mit `t()`.
        error: msgid('Die HAProxy-Konfiguration ist nicht lesbar.'),
      };
    }
    return {
      ...base,
      version: probe.version,
      acmeReady: probe.acmeReady,
      dnsHooks: probe.dnsHooks,
      scopes: parseScopes(probe.raw),
      adminIps: parseGlobalSettings(probe.raw).adminIps,
      serviceCount: probe.services.length,
      streamCount: probe.streams.length,
      error: null,
    };
  } catch (err) {
    // Wie in der Oberfläche: HAProxy, das gerade nicht antwortet, ist eine
    // Auskunft in der Zeile und kein Fehler des Aufrufs.
    return {
      ...base,
      version: null,
      acmeReady: false,
      dnsHooks: [],
      scopes: [],
      adminIps: [],
      serviceCount: 0,
      streamCount: 0,
      error: err instanceof Error ? err.message : msgid('HAProxy ist nicht erreichbar.'),
    };
  }
}
