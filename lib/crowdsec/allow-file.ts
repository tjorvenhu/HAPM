/**
 * Die Freigabeliste von CrowdSec als Datei für HAProxy.
 *
 * CrowdSec nimmt freigegebene Adressen von Sperren aus, die WAF prüft ihre
 * Anfragen aber weiter und lehnt sie bei einem Treffer ab (geprüft mit
 * CrowdSec 1.8, `scripts/verify-crowdsec.ts`). Wer eine Adresse freigibt,
 * meint: diese kommt immer durch. Deshalb liest HAProxy dieselben Adressen aus
 * `CROWDSEC_ALLOW_FILE` und fragt für sie gar nicht erst.
 *
 * Abgelaufene Einträge fallen beim nächsten Abgleich weg (nach jeder Änderung
 * und alle 15 Minuten im Scheduler).
 */

import type { AllowlistEntry } from './data';

/** Rein: die Zeilen der Datei, ohne abgelaufene Einträge, sortiert. */
export function allowFileContent(entries: readonly AllowlistEntry[], now: number): string {
  const values = entries
    .filter((entry) => entry.expiresAt === null || Date.parse(entry.expiresAt) > now)
    .map((entry) => entry.value)
    .filter((value, index, all) => all.indexOf(value) === index)
    .sort();
  return values.length === 0 ? '' : `${values.join('\n')}\n`;
}

/** Die Datei nachziehen. Scheitert nie nach außen: die Freigabe in CrowdSec gilt trotzdem. */
export async function syncAllowFile(entries: readonly AllowlistEntry[]): Promise<string | null> {
  try {
    const [{ refreshCrowdsecAllowFile, getProxyServer }, { LOCAL_SERVER_ID }] = await Promise.all([
      import('../haproxy/provision'),
      import('../helpers'),
    ]);
    const result = await refreshCrowdsecAllowFile(await getProxyServer(LOCAL_SERVER_ID), allowFileContent(entries, Date.now()));
    return result;
  } catch (err) {
    console.error('[crowdsec] Freigaben für HAProxy nicht geschrieben:', err);
    return null;
  }
}
