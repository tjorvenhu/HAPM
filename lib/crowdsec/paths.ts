/**
 * Wo CrowdSec liegt und wie die Container heißen.
 *
 * Zwei Container gehören dazu (docs/crowdsec.md): `hapm-crowdsec` (die
 * Erkennung, die lokale API und die WAF) und `hapm-crowdsec-bouncer` (der
 * SPOE-Agent, den HAProxy je Anfrage fragt). Beide laufen nur, wenn der Stack
 * sie nicht abgewählt hat (`HAPM_CROWDSEC_OFF=1` in `.env`, dann sind beide
 * Dienste für Compose nicht da).
 *
 * Nur Server: `crowdsecInstalled` sieht im Dateisystem nach.
 */

import { existsSync } from 'node:fs';

export function crowdsecContainerName(): string {
  return process.env.HAPM_CROWDSEC_CONTAINER || 'hapm-crowdsec';
}

export function bouncerContainerName(): string {
  return process.env.HAPM_CROWDSEC_BOUNCER_CONTAINER || 'hapm-crowdsec-bouncer';
}

/** Ob der Stack CrowdSec mitbringt. Gesetzt heißt: bei der Installation abgewählt. */
export function crowdsecInStack(): boolean {
  return !process.env.HAPM_CROWDSEC_OFF;
}

/**
 * Ob CrowdSec auf dieser Installation da ist: nicht abgewählt UND der Ordner
 * eingebunden. Ohne Ordner läuft HAPM mit einer `docker-compose.yml` von vor
 * CrowdSec; dann gibt es auch die Container nicht, und die Oberfläche blendet
 * CrowdSec aus wie bei einer abgewählten Installation. Nachrüsten:
 * `install.sh` erneut ausführen (docs/crowdsec.md).
 */
export function crowdsecInstalled(): boolean {
  return crowdsecInStack() && existsSync(crowdsecDir());
}

/** Der Ordner im HAPM-Container, in dem die Dateien für beide Container liegen
 *  (auf dem Server `HAPM_STORAGE/crowdsec`). */
export function crowdsecDir(): string {
  return process.env.HAPM_CROWDSEC_DIR || '/crowdsec';
}

/** Wo HAProxy den Bouncer erreicht. Compose veröffentlicht seinen Port nur auf
 *  127.0.0.1 des Servers, HAProxy läuft im Netz des Servers. */
export function spoaAddress(): string {
  const port = Number(process.env.HAPM_SPOA_PORT || '7423');
  return `127.0.0.1:${Number.isInteger(port) && port > 0 && port < 65536 ? port : 7423}`;
}

/** Unter diesem Namen meldet sich der Bouncer bei der lokalen API an. */
export const BOUNCER_NAME = 'hapm';
/** Die Freigabeliste, die HAPM führt. Andere Listen werden gelesen, nicht geändert. */
export const ALLOWLIST_NAME = 'hapm';

export const ACQUIS_FILE = 'config/acquis.d/hapm.yaml';
export const PARSER_FILE = 'config/parsers/s02-enrich/hapm-backend.yaml';
export const BOUNCER_KEY_FILE = `secrets/bouncer_key_${BOUNCER_NAME}`;
export const BOUNCER_CONFIG_FILE = 'bouncer/crowdsec-spoa-bouncer.yaml';
