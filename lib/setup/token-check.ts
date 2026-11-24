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
 */

export type TokenCheck =
  | { result: 'accepted' }
  | { result: 'rejected'; message: string }
  | { result: 'unknown'; message: string };

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
    return {
      result: 'rejected',
      message:
        `${label} hat den Token abgelehnt (HTTP ${status}). Bitte prüfen Sie, ob er vollständig kopiert ist ` +
        'und die nötigen Rechte hat. Es wurde nichts gespeichert.',
    };
  }
  return {
    result: 'unknown',
    message: `${label} antwortete mit HTTP ${status}. Ob der Token gilt, zeigt sich beim Ausstellen des Zertifikats.`,
  };
}

export async function checkDnsToken(hook: string, values: Record<string, string>): Promise<TokenCheck> {
  const probe = PROBES[hook];
  if (!probe) return { result: 'unknown', message: 'Für diesen Anbieter gibt es keine Vorabprüfung.' };

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
    return {
      result: 'unknown',
      message: `${probe.label} war nicht erreichbar. Ob der Token gilt, zeigt sich beim Ausstellen des Zertifikats.`,
    };
  }
}
