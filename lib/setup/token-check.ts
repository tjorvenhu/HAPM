/**
 * Den Token beim DNS-Anbieter vorzeigen, bevor er abgelegt wird.
 *
 * Ohne diese Frage fiele ein falscher Token erst beim Ausstellen auf: mitten im
 * Ausführen, mit der Meldung von acme.sh. Gefragt wird, solange der Token
 * ohnehin durchgereicht wird. Gespeichert wird er auch hier nicht, und er geht
 * nur an den Anbieter, zu dem er gehört.
 *
 * Drei Antworten. `unknown` heißt, der Anbieter ließ sich nicht fragen oder
 * antwortete unerwartet: dann wird der Token trotzdem abgelegt, und das
 * Ausstellen entscheidet. Eine Ablehnung wird nur aus einer Antwort gelesen,
 * die eine ist.
 *
 * Ein eigener Nameserver (RFC 2136) und Infoblox haben keinen Token, sondern
 * Zugangsdaten. Gefragt wird dort über den Anbieter selbst (`probe` in
 * `lib/dns/rfc2136.ts` und `lib/dns/infoblox.ts`): eine unterschriebene Frage
 * an den Nameserver, eine Anmeldung an der Appliance.
 */

import { ApiError } from '../api';
import { readInfobloxAccess, readRfc2136Access } from '../dns/access';
import { DnsUnreachableError } from '../dns/errors';
import { infoblox } from '../dns/infoblox';
import { rfc2136 } from '../dns/rfc2136';
import { findDnsProvider } from '../haproxy/dns-credentials';
import { germanText, msg, type Message } from '../i18n/translate';

/**
 * `message` ist der Satz auf Deutsch (Logs, Tests), `detail` derselbe Satz zum
 * Übersetzen: die Route wirft ihn als `ApiError`, die Seite zeigt ihn mit `t()`.
 */
export type TokenCheck =
  | { result: 'accepted' }
  | { result: 'rejected'; message: string; detail: Message }
  | { result: 'unknown'; message: string; detail: Message };

function withDetail<R extends 'rejected' | 'unknown'>(result: R, detail: Message) {
  return { result, message: germanText(detail), detail };
}

interface Probe {
  label: string;
  url: string;
  token: (values: Record<string, string>) => string;
}

/** Je Hook eine lesende Anfrage, die jeder gültige Token darf: die Zonen auflisten. */
const PROBES: Record<string, Probe> = {
  dns_cf: {
    label: 'Cloudflare',
    url: 'https://api.cloudflare.com/client/v4/zones?per_page=1',
    token: (values) => values.CF_Token ?? '',
  },
  dns_hetznercloud: {
    label: 'Hetzner',
    url: 'https://api.hetzner.cloud/v1/zones?per_page=1',
    token: (values) => values.HETZNER_TOKEN ?? '',
  },
};

/** Was der Status der Antwort heißt. Rein, damit es sich ohne Netz prüfen lässt. */
export function judgeTokenResponse(label: string, status: number): TokenCheck {
  if (status >= 200 && status < 300) return { result: 'accepted' };
  if (status === 400 || status === 401 || status === 403) {
    return withDetail(
      'rejected',
      msg(
        '{provider} hat den Token abgelehnt (HTTP {status}). Bitte prüfen Sie, ob er vollständig kopiert ist und die nötigen Rechte hat. Es wurde nichts gespeichert.',
        { provider: label, status }
      )
    );
  }
  return withDetail(
    'unknown',
    msg('{provider} antwortete mit HTTP {status}. Ob der Token gilt, zeigt sich beim Ausstellen des Zertifikats.', {
      provider: label,
      status,
    })
  );
}

/** Je Hook, wie der Anbieter selbst gefragt wird. Der Zugang ist der Text aus `DnsProvider.access`. */
const ACCESS_PROBES: Record<string, (access: string) => Promise<void> | null> = {
  dns_nsupdate: (token) => {
    const access = readRfc2136Access(token);
    return access ? rfc2136.probe(access) : null;
  },
  dns_infoblox: (token) => {
    const access = readInfobloxAccess(token);
    return access ? infoblox.probe(access) : null;
  },
};

async function checkAccess(label: string, probe: Promise<void> | null): Promise<TokenCheck> {
  if (!probe) return withDetail('unknown', msg('Für diesen Anbieter gibt es keine Vorabprüfung.'));
  try {
    await probe;
    return { result: 'accepted' };
  } catch (err) {
    if (err instanceof DnsUnreachableError) {
      return withDetail(
        'unknown',
        msg('{provider} war nicht erreichbar. Ob die Zugangsdaten gelten, zeigt sich beim Ausstellen des Zertifikats.', {
          provider: label,
        })
      );
    }
    // Die Meldung des Anbieters nennt den Grund schon (falsches Geheimnis, Anmeldung abgelehnt).
    if (err instanceof ApiError) return withDetail('rejected', { text: err.text, params: err.params });
    throw err;
  }
}

export async function checkDnsToken(hook: string, values: Record<string, string>): Promise<TokenCheck> {
  const provider = findDnsProvider(hook);
  if (provider?.access && ACCESS_PROBES[hook]) {
    return checkAccess(provider.label, ACCESS_PROBES[hook](provider.access(values)));
  }

  const probe = PROBES[hook];
  if (!probe) return withDetail('unknown', msg('Für diesen Anbieter gibt es keine Vorabprüfung.'));

  try {
    const res = await fetch(probe.url, {
      headers: { Authorization: `Bearer ${probe.token(values)}`, Accept: 'application/json' },
      // Der Token geht an genau diese Adresse und folgt keiner Weiterleitung.
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
      cache: 'no-store',
    });
    return judgeTokenResponse(probe.label, res.status);
  } catch {
    return withDetail(
      'unknown',
      msg('{provider} war nicht erreichbar. Ob der Token gilt, zeigt sich beim Ausstellen des Zertifikats.', {
        provider: probe.label,
      })
    );
  }
}
