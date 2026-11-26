/**
 * Die Dateien, die HAPM für CrowdSec schreibt. Rein: Optionen rein, Text raus.
 *
 * - die Quellen (`acquis.d/hapm.yaml`): das Log von HAProxy und die WAF,
 * - ein Parser, der das Backend einer Anfrage als Meta mitgibt, damit ein
 *   Ereignis aus dem Log einem Ziel zugeordnet werden kann,
 * - die Konfiguration des Bouncers.
 *
 * Geprüft gegen CrowdSec 1.8 und den SPOA-Bouncer 0.3 (docs/crowdsec.md).
 */

import { msgid } from '../i18n/translate';

/** Die OWASP-Regeln: aus, nur melden (außerhalb der Anfrage) oder sperren. */
export type CrsMode = 'off' | 'detect' | 'block';
export const CRS_MODES: readonly CrsMode[] = ['off', 'detect', 'block'];

/** Die Sammlung je Modus. Ohne sie fehlt die Regel, die die Konfiguration nennt. */
export const CRS_COLLECTIONS: Record<Exclude<CrsMode, 'off'>, string> = {
  detect: 'crowdsecurity/appsec-crs',
  block: 'crowdsecurity/appsec-crs-inband',
};

const CRS_CONFIGS: Record<Exclude<CrsMode, 'off'>, string> = {
  detect: 'crowdsecurity/crs',
  block: 'crowdsecurity/crs-inband',
};

/** Immer da: das Log von HAProxy und die WAF mit virtuellen Patches und
 *  allgemeinen Regeln. Compose installiert sie (`COLLECTIONS`). */
export const BASE_COLLECTIONS: readonly string[] = [
  'crowdsecurity/haproxy',
  'crowdsecurity/appsec-virtual-patching',
  'crowdsecurity/appsec-generic-rules',
];

/**
 * Was sich in der Oberfläche dazuschalten lässt. Eine feste Liste: der Name
 * geht als Argument an `cscli`, und was dort installiert wird, läuft danach in
 * der WAF jeder Anfrage. Die OWASP-Regeln stehen nicht hier, sie haben einen
 * eigenen Schalter, weil sie auch die Quellen ändern. Was zu einer einzelnen
 * Anwendung gehört, steht in `apps.ts`.
 */
export const OPTIONAL_COLLECTIONS: readonly { name: string; label: string; hint: string }[] = [
  {
    name: 'crowdsecurity/http-dos',
    label: msgid('HTTP-Flut'),
    hint: msgid(
      'Erkennt Adressen, die in kurzer Zeit sehr viele Anfragen schicken, und sperrt sie. Vorsicht bei Diensten, die viele Anfragen von einer Adresse bekommen, etwa Apps zum Abgleich hinter einem gemeinsamen Ausgang (Firmennetz, Mobilfunk). Solche Adressen gehören in die Freigaben.'
    ),
  },
];

export const LOG_PATH = '/var/log/haproxy/haproxy.log';
export const APPSEC_LISTEN = '0.0.0.0:7422';
/** Unter diesem Namen erreicht der Bouncer CrowdSec im Netz des Stacks. */
export const CROWDSEC_HOST = 'crowdsec';
export const SPOA_LISTEN = '0.0.0.0:7423';

/**
 * Die Quellen. `poll_without_inotify` bleibt aus: unter Linux meldet inotify
 * jede neue Zeile, und die Datei rotiert HAPM selbst per Umbenennen, dem die
 * Quelle über den Namen folgt.
 */
export function renderAcquis(crs: CrsMode): string {
  const configs = ['crowdsecurity/appsec-default', ...(crs === 'off' ? [] : [CRS_CONFIGS[crs]])];
  return [
    '# Von HAPM geschrieben. Wird bei jedem Start von HAPM neu geschrieben.',
    'source: file',
    'filenames:',
    `  - ${LOG_PATH}`,
    'labels:',
    '  type: haproxy',
    '---',
    'source: appsec',
    `listen_addr: ${APPSEC_LISTEN}`,
    'appsec_configs:',
    ...configs.map((name) => `  - ${name}`),
    'labels:',
    '  type: appsec',
    '',
  ].join('\n');
}

/** Liest den Modus der OWASP-Regeln aus den Quellen zurück. Unbekannt heißt aus. */
export function readCrsMode(acquis: string | null): CrsMode {
  if (!acquis) return 'off';
  if (/^\s*-\s*crowdsecurity\/crs-inband\s*$/m.test(acquis)) return 'block';
  if (/^\s*-\s*crowdsecurity\/crs\s*$/m.test(acquis)) return 'detect';
  return 'off';
}

/**
 * Ein Parser in der Stufe `s02-enrich`: das Backend aus der Zeile von HAProxy
 * als `target_backend`. Ohne `onsuccess: next_stage`, das übersprünge die
 * übrigen Parser der Stufe (darunter `http-logs`, ohne den kein Szenario
 * anspringt).
 */
export function renderBackendParser(): string {
  return [
    '# Von HAPM geschrieben: welches Backend die Anfrage bedient hat.',
    "filter: \"evt.Parsed.program startsWith 'haproxy' && evt.Parsed.backend_name != ''\"",
    'name: hapm/haproxy-backend',
    'description: "HAPM: Backend der Anfrage als Meta target_backend"',
    'statics:',
    '  - meta: target_backend',
    '    expression: evt.Parsed.backend_name',
    '',
  ].join('\n');
}

/**
 * Der Bouncer. Der Schlüssel steht im Klartext darin, wie bei jedem Bouncer:
 * die Datei liegt im Ordner der Daten, den nur root liest. Captcha gibt es
 * nicht (es bräuchte Schlüssel eines Anbieters): ein `captcha`-Block ohne
 * Anbieter steht als Fehler im Log des Bouncers, und eine Captcha-Entscheidung
 * lehnt HAProxy ohnehin ab wie eine Sperre (`CROWDSEC_LINES`).
 */
export function renderBouncerConfig(key: string): string {
  return [
    '# Von HAPM geschrieben. Wird bei jedem Start von HAPM neu geschrieben.',
    'log_mode: stdout',
    'log_level: info',
    `api_url: http://${CROWDSEC_HOST}:8080/`,
    `api_key: ${key}`,
    'update_frequency: 10s',
    'insecure_skip_verify: false',
    `listen_tcp: ${SPOA_LISTEN}`,
    `appsec_url: http://${CROWDSEC_HOST}:7422/`,
    'appsec_timeout: 400ms',
    'hosts:',
    '  - host: "*"',
    '    appsec:',
    '      always_send: false',
    'prometheus:',
    '  enabled: false',
    '  listen_addr: 127.0.0.1',
    '  listen_port: 60601',
    '',
  ].join('\n');
}

/** Ein Schlüssel für den Bouncer: Kleinbuchstaben und Ziffern, wie `cscli bouncers add` sie erzeugt. */
export function isValidBouncerKey(key: string): boolean {
  return /^[A-Za-z0-9]{32,128}$/.test(key);
}
