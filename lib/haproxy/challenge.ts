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
 *
 * ── Warten statt nachsehen ──
 *
 * Nach dem Setzen des TXT-Eintrags fragt acme.sh öffentliche Resolver (DNS
 * over HTTPS), ob er sichtbar ist, bis zu 20 Minuten lang. Eine Zone im
 * eigenen Netz sieht dort niemand: der Antrag liefe in den Abbruch, obwohl der
 * Eintrag steht. Für die Anbieter, die man selbst betreibt (RFC 2136,
 * Infoblox, `fixedWait` in `dns-credentials.ts`), geht deshalb `--dnssleep`
 * mit: acme.sh wartet die eingestellte Zeit und fragt dann die
 * Zertifizierungsstelle. Den Wert legt acme.sh als `Le_DNSSleep` im
 * Erneuerungseintrag des Zertifikats ab, die Erneuerung wartet also genauso.
 */

import { isWildcardDomain } from './config';
import { findDnsProvider } from './dns-credentials';
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
  /**
   * Sekunden, die acme.sh nach dem TXT-Eintrag wartet, bei einem Hook mit
   * `fixedWait`. Fehlt die Angabe, gilt `DEFAULT_DNS_WAIT`.
   */
  dnsWait?: number;
}

export type ChallengePlan =
  | { method: 'http' }
  /** `wait`: feste Wartezeit in Sekunden statt der öffentlichen Prüfung, sonst `null`. */
  | { method: 'dns'; hook: string; wait: number | null }
  | { method: 'unavailable'; message: Message };

/** Zwischen dem TXT-Eintrag und der Frage an die Zertifizierungsstelle. */
export const DEFAULT_DNS_WAIT = 30;
export const MIN_DNS_WAIT = 5;
export const MAX_DNS_WAIT = 900;

export function validDnsWait(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_DNS_WAIT && value <= MAX_DNS_WAIT;
}

/** Ob acme.sh bei diesem Hook wartet, statt öffentlich nachzusehen. */
export function hookWaits(hook: string): boolean {
  return findDnsProvider(hook)?.fixedWait === true;
}

function dnsPlan(hook: string, choice: ChallengeChoice): ChallengePlan {
  return { method: 'dns', hook, wait: hookWaits(hook) ? (choice.dnsWait ?? DEFAULT_DNS_WAIT) : null };
}

type CertificateSettings = Pick<Settings, 'exposure' | 'certificateSource' | 'acmeDirectory' | 'acmeHttpReachable'> &
  Partial<Pick<Settings, 'dnsWait'>>;

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
    ...(validDnsWait(settings.dnsWait) ? { dnsWait: settings.dnsWait } : {}),
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
    if (dnsHooks.includes(choice.dnsHook)) return dnsPlan(choice.dnsHook, choice);
    return {
      method: 'unavailable',
      message: msg('Der DNS-Hook "{hook}" ist nicht eingerichtet. Zur Auswahl stehen: {hooks}.', {
        hook: choice.dnsHook,
        hooks: dnsHooks.join(', '),
      }),
    };
  }

  if (dnsHooks.length === 1) return dnsPlan(dnsHooks[0], choice);

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
  if (plan.method === 'dns') {
    return plan.wait === null ? ['--dns', plan.hook] : ['--dns', plan.hook, '--dnssleep', String(plan.wait)];
  }
  // Kommt hier nur an, wenn die Vorabprüfung umgangen wurde.
  throw new Error(germanText(plan.message));
}
