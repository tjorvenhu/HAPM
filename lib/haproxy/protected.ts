/**
 * Das Ziel, über das die Oberfläche von HAPM erreichbar ist, bleibt stehen.
 *
 * Die Einrichtung legt ein Ziel an, das die Domain der Oberfläche auf den Port
 * von HAPM führt. Wer es entfernt, ihm die Domain nimmt oder seine Gruppe
 * abräumt, sperrt sich aus: die Oberfläche, in der sich das rückgängig machen
 * ließe, ist danach nicht mehr erreichbar.
 *
 * ── Woran das Ziel erkannt wird ──
 *
 * An der Adresse von HAPM aus den Einstellungen (`publicUrl`), nicht an einem
 * Namen. Geschützt ist das Ziel, dessen Domains den Host dieser Adresse
 * treffen. Ein Name (`hapm`, Gruppe `HAPM`) sagte nichts darüber, worüber die
 * Oberfläche wirklich läuft: wer das Ziel von Hand angelegt oder umbenannt hat,
 * wäre ungeschützt, und ein beliebiges Ziel namens `hapm` wäre unlöschbar.
 * Ohne Adresse ist nichts geschützt.
 *
 * ── Der Ausweg ──
 *
 * Die Adresse unter „Allgemein" ändern oder leeren, danach greift der Schutz
 * nicht mehr. Die Einrichtung lässt sich nicht erneut öffnen, sie ist kein
 * Ausweg. Die Einrichtung ändert die Domain selbst und setzt die Adresse
 * erst am Ende neu, sie arbeitet deshalb ausdrücklich ohne Schutz
 * (`WITHOUT_SURFACE_PROTECTION`).
 *
 * Die Adresse kommt als Wert herein und wird hier nicht gelesen, wie die Art
 * der Installation in `challenge.ts`: `provision.ts` bleibt ohne Datenbank, und
 * dieselben Funktionen laufen im Browser (Karte und Formular zeigen den Stand,
 * statt einen Knopf anzubieten, der dann scheitert).
 */

import { ownsDomain } from './config';
import { msg, type Message } from '../i18n/translate';

/** Was ein Aufrufer zum Vorgang mitgibt. */
export interface SurfaceProtection {
  /** `publicUrl` aus den Einstellungen. `null` heißt: nichts ist geschützt. */
  publicUrl: string | null;
}

/** Nur für die Einrichtung (`lib/setup/run.ts`): sie verlegt die Oberfläche selbst. */
export const WITHOUT_SURFACE_PROTECTION: SurfaceProtection = { publicUrl: null };

/** Das geschützte Ziel, wie es die Oberfläche und die Prüfungen brauchen. */
export interface SurfaceTarget {
  serviceId: string;
  scope: string | null;
  /** Der Host der Adresse, klein und ohne Port. */
  host: string;
  /** Die Adresse, wie sie in den Einstellungen steht. */
  url: string;
}

/** Der Host aus der Adresse von HAPM. `null` ohne Adresse und bei einer, die keine ist. */
export function surfaceHost(publicUrl: string | null | undefined): string | null {
  if (!publicUrl) return null;
  try {
    return new URL(publicUrl.trim()).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/**
 * Das Ziel, über das die Adresse läuft.
 *
 * `services` steht in der Reihenfolge der Weichen, und HAProxy nimmt die erste
 * passende. Treffen ein Ziel mit der Domain selbst und eine Wildcard darunter,
 * ist deshalb das obere gemeint und nur dieses geschützt.
 */
export function surfaceTarget(
  services: readonly { id: string; scope: string | null; domains: string[] }[],
  protection: SurfaceProtection
): SurfaceTarget | null {
  const host = surfaceHost(protection.publicUrl);
  if (!host || !protection.publicUrl) return null;
  const service = services.find((entry) => ownsDomain(entry.domains, host));
  if (!service) return null;
  return { serviceId: service.id, scope: service.scope, host, url: protection.publicUrl.trim() };
}

/*
 * Jede Meldung nennt am Ende den Ausweg: die Adresse unter Allgemein ändern.
 * Er steht in jedem Schlüssel ganz, weil ein Schlüssel nicht zusammengesetzt
 * wird (docs/i18n.md).
 */

/**
 * Die Gruppe der Oberfläche trägt nur das Ziel der Oberfläche. Ein weiteres
 * Ziel oder eine TCP-Weiterleitung darin legt niemand von Hand an, und es zieht
 * auch nichts dorthin um: die Gruppe lässt sich nicht entfernen, solange die
 * Oberfläche darin liegt, und alles andere darin hinge an ihrem Schutz.
 *
 * `id` ist der Eintrag, um den es geht (`null` beim Anlegen), `currentScope`
 * seine bisherige Gruppe. Was schon dort liegt, darf bleiben: ein Ziel, das
 * jemand früher von Hand hineingelegt hat, soll sich weiter ändern lassen.
 */
export function refuseSurfaceScopeEntry(
  surface: SurfaceTarget | null,
  scope: string,
  id: string | null,
  currentScope: string | null
): Message | null {
  if (!surface || surface.scope === null) return null;
  const target = surface.scope.toUpperCase();
  if (scope.trim().toUpperCase() !== target) return null;
  if (id !== null && id === surface.serviceId) return null;
  if (currentScope !== null && currentScope.toUpperCase() === target) return null;
  return msg(
    'Die Gruppe {scope} gehört der Oberfläche von HAPM. Weitere Ziele und Weiterleitungen kommen in eine andere Gruppe.',
    { scope: surface.scope }
  );
}

/** Die Meldung, wenn dieses Ziel nicht entfernt werden darf, sonst `null`. */
export function refuseSurfaceDelete(surface: SurfaceTarget | null, id: string): Message | null {
  if (!surface || surface.serviceId !== id) return null;
  return msg(
    'Über dieses Ziel ist die Oberfläche von HAPM erreichbar ({url}). Es lässt sich nicht entfernen. Wer die Adresse ändern will, ändert sie unter Allgemein. Danach lässt sich dieses Ziel entfernen.',
    { url: surface.url }
  );
}

/**
 * Die Meldung, wenn das Ziel nach der Änderung die Domain der Oberfläche nicht
 * mehr trüge, sonst `null`. Alles andere an ihm bleibt änderbar.
 */
export function refuseSurfaceUpdate(
  surface: SurfaceTarget | null,
  id: string,
  nextDomains: string[]
): Message | null {
  if (!surface || surface.serviceId !== id) return null;
  if (ownsDomain(nextDomains, surface.host)) return null;
  return msg(
    'Über dieses Ziel ist die Oberfläche von HAPM erreichbar ({url}). Die Domain {host} muss deshalb bei diesem Ziel bleiben. Wer die Adresse ändern will, ändert sie unter Allgemein. Danach lässt sich die Domain ändern.',
    { url: surface.url, host: surface.host }
  );
}

/** Die Meldung, wenn in dieser Gruppe das Ziel der Oberfläche liegt, sonst `null`. */
export function refuseSurfaceScopeRemoval(surface: SurfaceTarget | null, scope: string): Message | null {
  if (!surface || surface.scope === null) return null;
  if (surface.scope.toUpperCase() !== scope.trim().toUpperCase()) return null;
  return msg(
    'In dieser Gruppe liegt das Ziel, über das die Oberfläche von HAPM erreichbar ist ({url}). Sie lässt sich nicht entfernen. Wer die Adresse ändern will, ändert sie unter Allgemein. Danach lässt sich die Gruppe entfernen.',
    { url: surface.url }
  );
}
