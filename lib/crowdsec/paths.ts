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
import path from 'node:path';

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
  return crowdsecPresent() && !crowdsecDisabled();
}

/** Da, gleich ob in der Oberfläche abgeschaltet: der Schalter zum Einschalten braucht das. */
export function crowdsecPresent(): boolean {
  return crowdsecInStack() && existsSync(crowdsecDir());
}

/**
 * In der Oberfläche abgeschaltet (System, Allgemein, oder oben auf der Seite
 * CrowdSec). Eine Datei im Ordner von CrowdSec und kein Feld in der Datenbank:
 * `crowdsecInstalled` fragen viele Stellen ohne `await`, und die Angabe gehört
 * zu dem Ordner, den sie beschreibt.
 */
export function crowdsecDisabled(): boolean {
  return existsSync(path.join(crowdsecDir(), DISABLED_FILE));
}

export const DISABLED_FILE = 'hapm-disabled';

const switching = globalThis as unknown as { __hapmCrowdsecSwitchingOff?: boolean };

/** Ob gerade ein Lauf CrowdSec aus `haproxy.cfg` nimmt (`setCrowdsecEnabled`). */
export function crowdsecSwitchingOff(): boolean {
  return switching.__hapmCrowdsecSwitchingOff === true;
}

export function setCrowdsecSwitchingOff(value: boolean): void {
  switching.__hapmCrowdsecSwitchingOff = value;
}

/**
 * Ob ein Ziel jetzt CrowdSec bekommen darf: installiert und nicht gerade beim
 * Abschalten. Sonst schriebe ein Vorgang, der hinter dem Abschalten ansteht,
 * die Zeilen wieder in die Datei, und HAProxy fragte einen Bouncer, der steht.
 */
export function crowdsecUsable(): boolean {
  return crowdsecInstalled() && !crowdsecSwitchingOff();
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
