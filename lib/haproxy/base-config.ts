/**
 * Die Konfiguration, mit der eine frische Installation beginnt.
 *
 * HAPM legt sie genau einmal an: wenn `/etc/haproxy/haproxy.cfg` fehlt. Danach
 * ist die Datei die Wahrheit, und nichts hier schreibt sie je wieder als
 * Ganzes.
 *
 * Die Form ist die, die `config.ts` erwartet: der Marker der globalen
 * Einstellungen im HTTPS-Frontend und die Weiterleitung der ACME-Challenge auf
 * Port 8888. **Eine Gruppe bringt sie nicht mit.** Eine frische Installation
 * hat null Gruppen, die erste legt der Nutzer in der Oberfläche an. Wohin ihre
 * Marker gehören, liest `firstScopeAnchor` in `config.ts` am Marker der
 * globalen Einstellungen ab.
 *
 * Die Vorgaben: TLS ab 1.2 und nur mit Forward Secrecy, HTTP/3, HSTS, die
 * `X-Forwarded-*`-Kopfzeilen, `strict-sni`, `chroot`. Zwei Dinge folgen aus dem
 * Container: kein `daemon` (HAProxy läuft im Vordergrund) und `log … format
 * raw` statt `short`.
 *
 * Rein: Optionen rein, Text raus. `tests/haproxy/base-config.test.ts` liest das
 * Ergebnis mit dem Parser zurück.
 */

import { HAPROXY_CERT_DIR, HTTPS_MARKER } from './config';

export const ERROR_DIR = '/etc/haproxy/errors';
export const STATS_SOCKET = '/run/haproxy/admin.sock';

/** Der Port, auf dem acme.sh die HTTP-01-Anfrage annimmt, siehe `provision.ts`. */
const ACME_PORT = 8888;

/** Für diese Fehler kennt HAProxy eine `errorfile`-Zeile. */
const ERRORFILE_STATUSES = new Set([400, 401, 403, 404, 405, 407, 408, 410, 413, 425, 429, 500, 501, 502, 503, 504]);

export interface BaseConfigOptions {
  /** Ob die Maschine IPv6 hat. Ein `bind` auf `::` ohne IPv6 lässt HAProxy nicht starten. */
  ipv6: boolean;
  /** Die Fehler, für die eine Datei unter `ERROR_DIR` liegt. */
  errorStatuses: number[];
}

/**
 * Die Verschlüsselungsverfahren für TLS 1.2 und 1.3: nur solche mit
 * Forward Secrecy und AEAD, in dieser Reihenfolge.
 */
const TLS12_CIPHERS = [
  'ECDHE-ECDSA-AES128-GCM-SHA256',
  'ECDHE-RSA-AES128-GCM-SHA256',
  'ECDHE-ECDSA-AES256-GCM-SHA384',
  'ECDHE-RSA-AES256-GCM-SHA384',
  'ECDHE-ECDSA-CHACHA20-POLY1305',
  'ECDHE-RSA-CHACHA20-POLY1305',
  'DHE-RSA-AES128-GCM-SHA256',
  'DHE-RSA-AES256-GCM-SHA384',
].join(':');

const TLS13_CIPHERSUITES = ['TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256'].join(':');

export function renderBaseConfig(options: BaseConfigOptions): string {
  const tls = ` ssl crt ${HAPROXY_CERT_DIR}/`;
  const errorfiles = options.errorStatuses
    .filter((status) => ERRORFILE_STATUSES.has(status))
    .sort((a, b) => a - b)
    .map((status) => `    errorfile ${status} ${ERROR_DIR}/${status}.http`);

  return [
    '# HAProxy, verwaltet von HAPM.',
    '#',
    '# Die Datei darf von Hand geändert werden. HAPM schreibt nur zwischen seine',
    '# Marker (BEGIN AUTO und END AUTO), in den Block der globalen HTTPS-Einstellungen',
    '# und die Zeile "acl admin_ips". Alles andere bleibt, wie es ist.',
    '',
    'global',
    // `raw` und nicht `short`: HAPM schreibt das Log des Containers selbst mit
    // und setzt den Kopf davor (lib/haproxy-log.ts).
    '    log stdout format raw local0 info',
    '',
    // Ohne die Zeile schaltet ein HAProxy, dessen TLS-Bibliothek keine QUIC-API
    // hat (gewöhnliches OpenSSL vor 3.5), die QUIC-Listener ab, und `bind quic4@`
    // brächte kein HTTP/3. Wo die Bibliothek QUIC kann, ist sie laut Handbuch
    // wirkungslos (docs.haproxy.org, „limited-quic“). Aus der Konfiguration, die
    // der Nutzer produktiv betreibt und als Vorgabe gesetzt hat.
    '    limited-quic',
    '',
    '    chroot /var/lib/haproxy',
    '',
    `    stats socket ${STATS_SOCKET} mode 660 level admin`,
    '    stats timeout 30s',
    '',
    '    user haproxy',
    '    group haproxy',
    '',
    '    ca-base /etc/ssl/certs',
    '    crt-base /etc/ssl/private',
    '',
    `    ssl-default-bind-ciphers ${TLS12_CIPHERS}`,
    `    ssl-default-bind-ciphersuites ${TLS13_CIPHERSUITES}`,
    '    ssl-default-bind-options ssl-min-ver TLSv1.2 no-tls-tickets',
    '',
    'defaults',
    '    log global',
    '    mode http',
    '',
    '    option httplog',
    '    option dontlognull',
    '',
    '    timeout connect 5s',
    '    timeout client 50s',
    '    timeout server 50s',
    '    timeout http-request    10s',
    '    timeout http-keep-alive 10s',
    '    timeout queue           30s',
    '',
    ...errorfiles,
    '',
    '# ============================================================',
    '# HTTP',
    '# ============================================================',
    '',
    'frontend public_http',
    '    bind :80',
    ...(options.ipv6 ? ['    bind :::80 v6only'] : []),
    '',
    "    # Let's Encrypt HTTP-01",
    '    acl acme_challenge path_beg /.well-known/acme-challenge/',
    '',
    '    # Alles außer ACME auf HTTPS umleiten',
    '    http-request redirect scheme https code 301 unless acme_challenge',
    '',
    '    # ACME-Challenge an acme.sh weiterleiten',
    '    use_backend acme_challenge if acme_challenge',
    '',
    '# ============================================================',
    '# HTTPS',
    '# ============================================================',
    '',
    'frontend public_https',
    // strict-sni: ohne passendes Zertifikat kommt keine Verbindung zustande,
    // statt dass ein fremder Name das Zertifikat einer anderen Domain sieht.
    `    bind :443${tls} alpn h2,http/1.1 strict-sni`,
    ...(options.ipv6 ? [`    bind :::443 v6only${tls} alpn h2,http/1.1 strict-sni`] : []),
    '',
    '    # HTTP/3 / QUIC',
    `    bind quic4@:443${tls} alpn h3`,
    ...(options.ipv6 ? [`    bind quic6@:443${tls} alpn h3`] : []),
    '',
    '    # Clients HTTP/3 anbieten',
    '    http-response set-header alt-svc "h3=\\":443\\";ma=900"',
    '',
    `    ${HTTPS_MARKER}`,
    '    http-response set-header Strict-Transport-Security "max-age=31536000"',
    '    http-response set-header X-Content-Type-Options "nosniff"',
    '    http-request set-header X-Forwarded-For %[src]',
    '    http-request set-header X-Forwarded-Proto https',
    '    http-request set-header X-Forwarded-Port 443',
    '    http-request set-header X-Forwarded-Host %[req.hdr(host)]',
    '',
    '    # Default-Error-Page',
    '    default_backend default_404',
    '',
    '# ============================================================',
    '# ACME',
    '# ============================================================',
    '',
    'backend acme_challenge',
    `    server acme 127.0.0.1:${ACME_PORT}`,
    '',
    '# ============================================================',
    '# Default / unbekannte Hosts',
    '# ============================================================',
    '',
    'backend default_404',
    '    http-request deny deny_status 404',
    '',
  ].join('\n');
}
