/**
 * Wie die Challenge für ein Zertifikat beantwortet wird: die eine Regel dafür.
 *
 * Zwei Dinge zwingen zu DNS-01. Eine Wildcard: keine ACME-CA stellt sie über
 * HTTP-01 aus (RFC 8555 lässt es nicht zu). Und eine interne Installation:
 * dort erreicht Let's Encrypt den Server nicht, HTTP-01 scheiterte bei jeder
 * Domain. Die Ausnahme davon ist ein eigener ACME-Server im selben Netz, der
 * HAPM über Port 80 erreicht (`httpReachable`): dann geht HTTP-01 auch intern.
 *
 * Und eine Installation, die nur hochgeladene Zertifikate nimmt
 * (`source: 'upload'`), beantragt gar nicht. Ob schon ein passendes
 * Zertifikat da ist, sagt nicht diese Regel, sondern die Maschine
 * (`assertIssuable` in `provision.ts`).
 *
 * Alles kommt als Wert herein und wird hier nicht gelesen. Die Routen lösen
 * es aus den Einstellungen auf (`challengeChoice`) und geben es mit, damit
 * `provision.ts` ohne Datenbank bleibt und diese Regel sich ohne sie prüfen
 * lässt (`tests/haproxy/challenge.test.ts`).
 *
 * Die Erneuerung fragt hier nicht nach: acme.sh merkt sich Methode und Server
 * je Zertifikat. Eine umgestellte Installation ändert nur künftige Anträge.
 */

import { isWildcardDomain } from './config';
import { effectiveAcmeServer } from '../acme-server';
import { germanText, msg, type Message } from '../i18n/translate';
import type { CertificateSource, Exposure, Settings } from '../types';

/** Was ein Aufrufer zum Vorgang mitgibt. */
export interface ChallengeChoice {
  exposure: Exposure;
  /** Der gewählte acme.sh-Hook. `null` heißt: nicht genannt. */
  dnsHook: string | null;
  /** `upload`: HAPM beantragt nie selbst. */
  source: CertificateSource;
  /** Was an `acme.sh --server` geht: ein Name, den acme.sh kennt, oder eine Directory-URL. */
  acmeServer: string;
  /** Der ACME-Server erreicht HAPM über Port 80, auch wenn die Installation intern ist. */
  httpReachable: boolean;
}

export type ChallengePlan =
  | { method: 'http' }
  | { method: 'dns'; hook: string }
  | { method: 'unavailable'; message: Message };

type CertificateSettings = Pick<Settings, 'exposure' | 'certificateSource' | 'acmeDirectory' | 'acmeHttpReachable'>;

/**
 * Die Angabe zum Vorgang aus den Einstellungen. `httpReachable` gilt nur mit
 * eigenem Server: Let's Encrypt erreicht eine interne Installation nicht,
 * auch wenn der Schalter noch von früher an steht.
 */
export function challengeChoice(
  settings: CertificateSettings,
  dnsHook: string | null,
  envServer: string | undefined
): ChallengeChoice {
  return {
    exposure: settings.exposure,
    dnsHook,
    source: settings.certificateSource,
    acmeServer: effectiveAcmeServer(settings.acmeDirectory, envServer),
    httpReachable: settings.acmeDirectory !== null && settings.acmeHttpReachable,
  };
}

export function needsDnsChallenge(domains: string[], exposure: Exposure, httpReachable = false): boolean {
  return domains.some(isWildcardDomain) || (exposure === 'internal' && !httpReachable);
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
  if (choice.source === 'upload') {
    return {
      method: 'unavailable',
      message: msg(
        'Diese Installation stellt keine Zertifikate selbst aus, und für {domains} ist keins hochgeladen. Laden Sie es zuerst unter Reverse-Proxy, Zertifikate hoch.',
        { domains: domains.join(', ') }
      ),
    };
  }

  if (!needsDnsChallenge(domains, choice.exposure, choice.httpReachable)) return { method: 'http' };

  const wildcard = domains.some(isWildcardDomain);

  if (dnsHooks.length === 0) {
    return {
      method: 'unavailable',
      message: wildcard
        ? msg(
            'Eine Wildcard-Domain lässt sich nur über DNS-01 ausstellen, und dafür sind noch keine DNS-Zugangsdaten hinterlegt. Sie werden unter Reverse-Proxy, Einstellungen eingetragen. Einmal hinterlegt, merkt acme.sh sie sich für jede Erneuerung. Ohne sie bleibt ein hochgeladenes Zertifikat (Reverse-Proxy, Zertifikate).'
          )
        : msg(
            "Diese Installation ist als intern eingerichtet: Let's Encrypt erreicht den Server nicht, jedes Zertifikat wird über DNS-01 ausgestellt. Dafür fehlen die DNS-Zugangsdaten. Sie werden unter Reverse-Proxy, Einstellungen eingetragen. Ohne sie geht es nur mit einem eigenen ACME-Server, der HAPM über Port 80 erreicht (Allgemein), oder mit einem hochgeladenen Zertifikat (Reverse-Proxy, Zertifikate)."
          ),
    };
  }

  if (choice.dnsHook) {
    if (dnsHooks.includes(choice.dnsHook)) return { method: 'dns', hook: choice.dnsHook };
    return {
      method: 'unavailable',
      message: msg('Der DNS-Hook "{hook}" ist nicht eingerichtet. Zur Auswahl stehen: {hooks}.', {
        hook: choice.dnsHook,
        hooks: dnsHooks.join(', '),
      }),
    };
  }

  if (dnsHooks.length === 1) return { method: 'dns', hook: dnsHooks[0] };

  return {
    method: 'unavailable',
    message: msg(
      wildcard
        ? 'Für eine Wildcard-Domain muss der DNS-Hook gewählt werden, der die Challenge setzt. Eingerichtet: {hooks}.'
        : 'Das Zertifikat wird über DNS-01 ausgestellt. Dafür muss der DNS-Hook gewählt werden, der die Challenge setzt. Eingerichtet: {hooks}.',
      { hooks: dnsHooks.join(', ') }
    ),
  };
}

/** Die Argumente für `acme.sh --issue`. */
export function challengeArgs(plan: ChallengePlan, httpPort: string): string[] {
  if (plan.method === 'http') return ['--standalone', '--httpport', httpPort];
  if (plan.method === 'dns') return ['--dns', plan.hook];
  // Kommt hier nur an, wenn die Vorabprüfung umgangen wurde.
  throw new Error(germanText(plan.message));
}
