/**
 * HTTPS zum Ziel gegen ein echtes HAProxy prüfen.
 *
 *   pnpm haproxy:verify-tls              # 2.6, 3.0 und lts
 *   pnpm haproxy:verify-tls 3.2          # eine bestimmte Fassung
 *
 * Braucht Docker und `openssl` auf dem Rechner, der es startet. Aus demselben
 * Grund ein Skript und kein Test wie `pnpm haproxy:verify-pages`.
 *
 * ── Was hier gezeigt wird und in `tests/haproxy/backend-tls.test.ts` nicht ──
 *
 * Der Test hält fest, welche Zeilen geschrieben und wieder gelesen werden. Ob
 * HAProxy sie annimmt und das Ziel damit wirklich so anspricht, sagt nur
 * HAProxy:
 *
 *  - `haproxy -c` nimmt beide Formen an (`ssl verify none …` und `ssl verify
 *    required ca-file @system-ca …`) und lehnt `ssl` ohne `verify` ab. Das
 *    Letzte ist der Grund, warum HAPM `verify none` ausdrücklich schreibt.
 *  - Das Ziel bekommt die Domain der Anfrage als SNI (`sni req.hdr(host)`).
 *  - Der Healthcheck läuft über TLS und schickt `check-sni`: das Ziel hier
 *    nimmt ohne passenden SNI keine Verbindung an (`strict-sni`). Ohne
 *    `check-sni` nähme der Check es nach drei Versuchen aus dem Betrieb, und
 *    die Anfrage danach bekäme 503.
 *  - `verify` prüft wirklich: gegen ein selbst signiertes Zertifikat kommt 503.
 *
 * Wer `serverParams`, `backendTlsParams` oder `backendCheckSni` ändert, lässt
 * dieses Skript laufen.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addService, type CreateServiceInput } from '../lib/haproxy/config';

const VERSIONS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['2.6', '3.0', 'lts'];
const PORT = 18481;
const CFG = '/usr/local/etc/haproxy/haproxy.cfg';
const PEM = '/usr/local/etc/haproxy/ziel.pem';
const NAMES = ['unsicher.test', 'geprueft.test', 'regel.test'];

/* Die globalen Zeilen wie in `base-config.ts`, soweit sie hier zählen:
 * `ca-base` steht dort und darf `@system-ca` nicht stören. */
const BASE = `global
    log stdout format raw local0
    ca-base /etc/ssl/certs

defaults
    mode http
    timeout connect 5s
    timeout client 30s
    timeout server 30s

frontend https_in
    bind :8080

# END AUTO TEST SERVICES

    default_backend sonst

# END AUTO TEST BACKENDS

backend sonst
    http-request return status 200 content-type text/plain string "sonst"

# Ein Ziel, das selbst HTTPS spricht, mit selbst signiertem Zertifikat. Es
# nimmt nur Verbindungen mit einem SNI an, für das es ein Zertifikat hat, und
# antwortet mit dem SNI, den es bekommen hat.
listen tlsziel
    bind 127.0.0.1:9443 ssl crt ${PEM} strict-sni
    http-request return status 200 content-type text/plain lf-string "sni=%[ssl_fc_sni]"

listen ziel
    bind 127.0.0.1:9000
    http-request return status 200 content-type text/plain string "ziel"
`;

const service = (over: Partial<CreateServiceInput>): CreateServiceInput => ({
  scope: 'TEST',
  id: 'unsicher',
  domains: ['unsicher.test'],
  servers: [{ name: '', target: '127.0.0.1:9443', weight: null }],
  redirect: null,
  routes: [],
  balance: null,
  sticky: false,
  lockedDomains: [],
  passwordLock: null,
  responseHeaders: [],
  requestHeaders: [],
  tunnel: false,
  crowdsec: false,
  app: null,
  healthcheck: true,
  backendTls: 'insecure',
  ...over,
});

function config(): string {
  let text = addService(BASE, service({}));
  text = addService(text, service({ id: 'geprueft', domains: ['geprueft.test'], healthcheck: false, backendTls: 'verify' }));
  text = addService(
    text,
    service({
      id: 'regel',
      domains: ['regel.test'],
      servers: [{ name: '', target: '127.0.0.1:9000', weight: null }],
      backendTls: 'off',
      routes: [
        { name: 'api', paths: ['/api'], servers: [{ name: '', target: '127.0.0.1:9443' }], check: true, backendTls: 'insecure' },
      ],
    })
  );
  return text;
}

interface Reply {
  status: number;
  body: string;
}

function call(host: string, path = '/'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: PORT, path, headers: { Host: host } }, (res) => {
      // Als UTF-8-Strom lesen, siehe verify-proxy-pages.ts.
      res.setEncoding('utf8');
      let data = '';
      res.on('data', (chunk: string) => (data += chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok    ' : 'FEHLER'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const docker = (args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/** `haproxy -c` mit einer Konfiguration, Ausgabe samt Warnungen. */
function haproxyCheck(version: string, mounts: string[]): { ok: boolean; output: string } {
  const run = spawnSync('docker', ['run', '--rm', ...mounts, `haproxy:${version}`, 'haproxy', '-c', '-f', CFG], {
    encoding: 'utf8',
  });
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}`.trim() };
}

/** Ein selbst signiertes Zertifikat für die Domains des Tests, als PEM mit Schlüssel. */
function selfSigned(dir: string): string {
  const key = join(dir, 'key.pem');
  const crt = join(dir, 'crt.pem');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=unsicher.test',
    '-addext', `subjectAltName=${NAMES.map((name) => `DNS:${name}`).join(',')}`,
    '-keyout', key, '-out', crt,
  ], { stdio: 'ignore' });
  const pem = join(dir, 'ziel.pem');
  writeFileSync(pem, `${readFileSync(crt, 'utf8')}${readFileSync(key, 'utf8')}`, { mode: 0o644 });
  return pem;
}

async function verify(version: string): Promise<void> {
  console.log(`\nHAProxy ${version}`);
  const dir = mkdtempSync(join(tmpdir(), 'hapm-tls-'));
  const name = `hapm-tls-verify-${version.replace(/\W/g, '-')}`;
  try {
    docker(['rm', '-f', name]);
  } catch {
    // Es gab keinen.
  }

  try {
    const pem = selfSigned(dir);
    const cfg = join(dir, 'haproxy.cfg');
    const mounts = ['-v', `${cfg}:${CFG}:ro`, '-v', `${pem}:${PEM}:ro`];

    // `ssl` ohne `verify`: HAProxy prüft dann gegen `ssl-server-verify`
    // (Vorgabe `required`) und hat keine CA. Angenommen hieße, dass ein
    // Ziel ohne Prüfung auch ohne `verify none` ginge.
    writeFileSync(cfg, `${BASE}\nbackend nackt\n    server s 127.0.0.1:9443 ssl\n`, { mode: 0o644 });
    const bare = haproxyCheck(version, mounts);
    check('haproxy -c lehnt „ssl" ohne verify ab', !bare.ok, bare.output.slice(-300));

    writeFileSync(cfg, config(), { mode: 0o644 });
    const checked = haproxyCheck(version, mounts);
    check('haproxy -c nimmt beide HTTPS-Formen an', checked.ok, checked.output.slice(-400));
    check('ohne Warnung', !/\[WARNING\]/.test(checked.output), checked.output.slice(-400));
    if (!checked.ok) return;

    docker(['run', '-d', '--name', name, '-p', `127.0.0.1:${PORT}:8080`, ...mounts, `haproxy:${version}`]);
    // `inter 2s`, `fall 3`: nach gut sechs Sekunden wäre ein Ziel, dessen
    // Check scheitert, aus dem Betrieb.
    await new Promise((resolve) => setTimeout(resolve, 9000));

    const insecure = await call('unsicher.test');
    check('ohne Prüfung: das selbst signierte Ziel antwortet', insecure.status === 200, `Status ${insecure.status}`);
    check('mit der Domain der Anfrage als SNI', insecure.body === 'sni=unsicher.test', insecure.body);
    check('und der Healthcheck über TLS mit check-sni hält es im Betrieb', insecure.status === 200);

    const verified = await call('geprueft.test');
    check('mit Prüfung: ein selbst signiertes Zertifikat wird abgelehnt (503)', verified.status === 503, `Status ${verified.status}`);

    const route = await call('regel.test', '/api/x');
    check('eine Pfad-Regel mit eigener Einstellung spricht HTTPS', route.status === 200 && route.body === 'sni=regel.test', `${route.status} ${route.body}`);
    const plain = await call('regel.test', '/');
    check('das Backend daneben bleibt HTTP', plain.status === 200 && plain.body === 'ziel', `${plain.status} ${plain.body}`);
  } catch (err) {
    check('Durchlauf', false, err instanceof Error ? err.message : String(err));
  } finally {
    try {
      docker(['rm', '-f', name]);
    } catch {
      // Schon weg.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  try {
    docker(['version', '--format', '{{.Server.Version}}']);
  } catch {
    console.error('Docker ist nicht erreichbar. Dieses Skript startet HAProxy in einem Container.');
    process.exit(2);
  }
  for (const version of VERSIONS) await verify(version);
  console.log(failures === 0 ? '\nAlles in Ordnung.' : `\n${failures} Prüfung(en) fehlgeschlagen.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
