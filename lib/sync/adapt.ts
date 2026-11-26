/**
 * Die `haproxy.cfg` des Hauptknotens an den Folgeknoten anpassen, bevor sie
 * dort eingesetzt wird.
 *
 * Fast alles in der Datei gilt auf jedem Knoten gleich, die Pfade sind
 * dieselben. Eine Sache hängt am Knoten: CrowdSec. Der Bouncer, den HAProxy je
 * Anfrage fragt, läuft im Stack des jeweiligen Knotens.
 *
 * - **CrowdSec ist hier nicht eingeschaltet** (abgewählt oder abgeschaltet),
 *   die Datei benutzt es aber: HAProxy ließe die Anfragen zwar durch
 *   (fail-open, docs/crowdsec.md), wartete aber bei jeder rund eine Sekunde auf
 *   einen Bouncer, den es nicht gibt. Die Zeilen kommen deshalb heraus, mit
 *   derselben Funktion, mit der ein einzelner Knoten sie in dieser Lage selbst
 *   herausnimmt (`dropOrphanedCrowdsec`). Die Ziele laufen hier dann ohne WAF,
 *   und der Abgleich sagt das auf beiden Seiten.
 * - **Der Port des Bouncers** (`HAPM_SPOA_PORT`) kann je Knoten ein anderer
 *   sein. Die Zeile, die HAPM geschrieben hat, bekommt den Port von hier. Eine
 *   von Hand geänderte bleibt, wie sie ist.
 *
 * Rein: Text hinein, Text heraus.
 */

import {
  CROWDSEC_SPOA_BACKEND,
  HaproxyConfigError,
  applyGlobalSettings,
  clean,
  syncCrowdsecBackend,
  usesCrowdsec,
} from '../haproxy/config';

export interface LocalNode {
  /** CrowdSec ist auf diesem Knoten da und eingeschaltet. */
  crowdsec: boolean;
  /** Wo HAProxy hier den Bouncer erreicht, `127.0.0.1:7423`. */
  spoaAddress: string;
}

/**
 * Woran die Anpassung hängt, als Text. Der Folgeknoten merkt sich, womit er
 * angepasst hat. Ändert sich das (CrowdSec wird eingeschaltet), ist ein neuer
 * Abgleich fällig, auch wenn sich beim Hauptknoten nichts geändert hat.
 */
export function localVariant(local: LocalNode): string {
  return `crowdsec=${local.crowdsec ? 'an' : 'aus'};spoa=${local.spoaAddress}`;
}

/**
 * `unused`: die Datei benutzt CrowdSec nicht. `kept`: sie benutzt es, und der
 * Knoten kann es. `removed`: herausgenommen, weil der Knoten es nicht kann.
 * `stuck`: es ließ sich nicht herausnehmen (der Block steht nicht so da, wie
 * HAPM ihn schreibt) und bleibt stehen.
 */
export type CrowdsecOutcome = 'unused' | 'kept' | 'removed' | 'stuck';

export interface AdaptedConfig {
  text: string;
  crowdsec: CrowdsecOutcome;
}

const HAPM_BOUNCER_LINE = /^(\s*)server bouncer 127\.0\.0\.1:\d{1,5} check inter 5s\s*$/;

function withLocalBouncer(text: string, address: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((raw) => clean(raw) === `backend ${CROWDSEC_SPOA_BACKEND}`);
  if (start === -1) return text;
  for (let i = start + 1; i < lines.length && clean(lines[i]) !== ''; i++) {
    const match = HAPM_BOUNCER_LINE.exec(lines[i]);
    if (match) {
      lines[i] = `${match[1]}server bouncer ${address} check inter 5s`;
      break;
    }
  }
  return lines.join('\n');
}

export function adaptConfig(text: string, local: LocalNode): AdaptedConfig {
  if (!usesCrowdsec(text)) return { text, crowdsec: 'unused' };
  if (local.crowdsec) return { text: withLocalBouncer(text, local.spoaAddress), crowdsec: 'kept' };

  try {
    const without = applyGlobalSettings(text, {
      httpsLines: [],
      adminIps: [],
      fromFile: true,
      crowdsec: false,
      crowdsecRemoveAll: true,
    });
    const cleaned = syncCrowdsecBackend(without, local.spoaAddress);
    return usesCrowdsec(cleaned) ? { text, crowdsec: 'stuck' } : { text: cleaned, crowdsec: 'removed' };
  } catch (err) {
    if (err instanceof HaproxyConfigError) return { text, crowdsec: 'stuck' };
    throw err;
  }
}
