/**
 * Wie die Challenge für ein Zertifikat beantwortet wird: die eine Regel dafür.
 *
 * Zwei Dinge zwingen zu DNS-01. Eine Wildcard: Let's Encrypt stellt sie über
 * HTTP-01 nicht aus. Und eine interne Installation: dort erreicht
 * Let's Encrypt den Server nicht, HTTP-01 scheiterte bei jeder Domain.
 *
 * Die Art der Installation kommt als Wert herein und wird hier nicht gelesen.
 * Die Routen lösen sie aus den Einstellungen auf und geben sie mit, damit
 * `provision.ts` ohne Datenbank bleibt und diese Regel sich ohne sie prüfen
 * lässt (`tests/haproxy/challenge.test.ts`).
 *
 * Die Erneuerung fragt hier nicht nach: acme.sh merkt sich die Methode je
 * Zertifikat. Eine umgestellte Installation ändert nur künftige Anträge.
 */

import { isWildcardDomain } from './config';
import type { Exposure } from '../types';

/** Was ein Aufrufer zum Vorgang mitgibt. */
export interface ChallengeChoice {
  exposure: Exposure;
  /** Der gewählte acme.sh-Hook. `null` heißt: nicht genannt. */
  dnsHook: string | null;
}

export type ChallengePlan =
  | { method: 'http' }
  | { method: 'dns'; hook: string }
  | { method: 'unavailable'; message: string };

export function needsDnsChallenge(domains: string[], exposure: Exposure): boolean {
  return exposure === 'internal' || domains.some(isWildcardDomain);
}

/**
 * `dnsHooks` sind die eingerichteten Hooks der Maschine. Ist genau einer
 * eingerichtet, gilt er, ohne dass ihn jemand nennt. Bei mehreren muss er
 * gewählt sein: welcher Anbieter die Zone führt, lässt sich nicht raten.
 */
export function planChallenge(
  domains: string[],
  choice: ChallengeChoice,
  dnsHooks: string[]
): ChallengePlan {
  if (!needsDnsChallenge(domains, choice.exposure)) return { method: 'http' };

  const wildcard = domains.some(isWildcardDomain);

  if (dnsHooks.length === 0) {
    return {
      method: 'unavailable',
      message: wildcard
        ? "Eine Wildcard-Domain lässt Let's Encrypt nur über DNS-01 ausstellen, und dafür sind noch keine " +
          'DNS-Zugangsdaten hinterlegt. Sie werden unter Reverse-Proxy, Einstellungen eingetragen. ' +
          'Einmal hinterlegt, merkt acme.sh sie sich für jede Erneuerung.'
        : "Diese Installation ist als intern eingerichtet: Let's Encrypt erreicht den Server nicht, " +
          'jedes Zertifikat wird über DNS-01 ausgestellt. Dafür fehlen die DNS-Zugangsdaten. ' +
          'Sie werden unter Reverse-Proxy, Einstellungen eingetragen.',
    };
  }

  if (choice.dnsHook) {
    if (dnsHooks.includes(choice.dnsHook)) return { method: 'dns', hook: choice.dnsHook };
    return {
      method: 'unavailable',
      message:
        `Der DNS-Hook "${choice.dnsHook}" ist nicht eingerichtet. ` +
        `Zur Auswahl stehen: ${dnsHooks.join(', ')}.`,
    };
  }

  if (dnsHooks.length === 1) return { method: 'dns', hook: dnsHooks[0] };

  return {
    method: 'unavailable',
    message:
      (wildcard
        ? 'Für eine Wildcard-Domain muss der DNS-Hook gewählt werden, der die Challenge setzt. '
        : 'Das Zertifikat wird über DNS-01 ausgestellt. Dafür muss der DNS-Hook gewählt werden, der die Challenge setzt. ') +
      `Eingerichtet: ${dnsHooks.join(', ')}.`,
  };
}

/** Die Argumente für `acme.sh --issue`. */
export function challengeArgs(plan: ChallengePlan, httpPort: string): string[] {
  if (plan.method === 'http') return ['--standalone', '--httpport', httpPort];
  if (plan.method === 'dns') return ['--dns', plan.hook];
  // Kommt hier nur an, wenn die Vorabprüfung umgangen wurde.
  throw new Error(plan.message);
}
