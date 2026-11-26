import net from 'node:net';
import { isPublicAddress } from './rules';

/**
 * Die Adresse, unter der dieser Server aus dem Internet gesehen wird.
 *
 * Ein Server bei einem Cloud-Anbieter oder hinter einem Router trägt an seiner
 * Schnittstelle oft nur eine private Adresse (10.x, 192.168.x), und die
 * öffentliche setzt jemand davor um. Welche das ist, weiß der Server selbst
 * nicht: er muss außen fragen. Gefragt wird ein Dienst, der die Adresse des
 * Aufrufers als Text zurückgibt. Mitgeschickt wird nichts außer der Anfrage
 * selbst.
 *
 * Gefragt wird nur, wenn es nötig ist (`recordAddresses` in `address.ts`): bei
 * einer Installation aus dem Internet ohne öffentliche Adresse an einer
 * Schnittstelle, im Assistenten und beim Ändern der Adresse. Die Ziele stehen
 * in `docs/betrieb.md`, „Ausgehende Verbindungen". Scheitert die Frage (keine
 * Freigabe in der Firewall), gibt es keinen Vorschlag, und die Seite sagt das.
 */

/** Beide antworten mit der Adresse als reinem Text. Der zweite nur, wenn der erste nicht antwortet. */
const SOURCES = ['https://api.ipify.org', 'https://ipv4.icanhazip.com'];
const TIMEOUT_MS = 3000;
/** Die Adresse eines Servers ändert sich selten, und die Seite fragt beim Pollen im Takt. */
const KEEP_MS = 10 * 60_000;
const RETRY_MS = 60_000;

const cache = globalThis as unknown as { __hapmPublicAddress?: { at: number; value: string | null } };

/** Aus der Antwort eines Dienstes die Adresse, oder `null`, wenn es keine öffentliche ist. Rein. */
export function readPublicAddress(body: string): string | null {
  const text = body.trim();
  return text.length <= 45 && net.isIP(text) !== 0 && isPublicAddress(text) ? text : null;
}

async function ask(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
    if (!response.ok) return null;
    return readPublicAddress((await response.text()).slice(0, 100));
  } catch {
    return null;
  }
}

export async function lookupPublicAddress(now = Date.now()): Promise<string | null> {
  const known = cache.__hapmPublicAddress;
  if (known && now - known.at < (known.value ? KEEP_MS : RETRY_MS)) return known.value;
  let value: string | null = null;
  for (const url of SOURCES) {
    value = await ask(url);
    if (value) break;
  }
  cache.__hapmPublicAddress = { at: now, value };
  return value;
}
