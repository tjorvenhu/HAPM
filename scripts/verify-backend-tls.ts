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
 *  - Eine hinterlegte Zertifizierungsstelle (`ca:<name>`, `backend-ca.ts`):
 *    HAProxy lädt die Datei, wie `inspectCaUpload` sie schreibt, nimmt ein Ziel
 *    mit Zertifikat aus dieser CA an, lehnt es mit einer fremden CA ab (503)
 *    und prüft den Namen: ein Zertifikat der richtigen CA für eine andere
 *    Domain fällt durch (503). Ein Bündel aus Root und Zwischenstelle bestätigt
 *    ein Ziel, das nur sein eigenes Zertifikat schickt. Ein selbst signiertes
 *    Zertifikat eines Servers als „Stelle" lässt genau dieses Ziel durch.
 *    Fehlt die Datei, lehnt `haproxy -c` die ganze Konfiguration ab: deshalb
 *    `assertCasPresent` vor dem Lauf und die Sperre beim Entfernen.
 *  - Ein fester Name (`backendVerifyHost`, `sni str(<name>)`): ein Ziel, dessen
 *    Zertifikat nur seinen internen Namen nennt, fällt ohne ihn durch (503),
 *    antwortet mit ihm, und fällt mit einem falschen Namen wieder durch. Das
 *    Ziel bekommt den Namen als SNI und die Domain der Anfrage weiter als
 *    Host-Header. Der Healthcheck geht mit `check-sni <name>` hinaus: das Ziel
 *    hier nimmt ohne passenden SNI keine Verbindung an. `verifyhost` schreibt
 *    HAPM nicht: der SNI genügt, und allein prüft es ab HAProxy 3.3 nicht
 *    mehr gegen den Namen, sondern gegen die Domain der Anfrage (`sni-auto`).
 *
 * Wer `serverParams`, `backendTlsParams`, `backendCheckSni` oder
 * `inspectCaUpload` ändert, lässt dieses Skript laufen.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addService, backendCaTls, BACKEND_CA_DIR, type CreateServiceInput } from '../lib/haproxy/config';
import { inspectCaUpload } from '../lib/haproxy/backend-ca';

const VERSIONS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['2.6', '3.0', 'lts'];
const PORT = 18481;
const CFG = '/usr/local/etc/haproxy/haproxy.cfg';
const PEM = '/usr/local/etc/haproxy/ziel.pem';
/** Die Zertifikate der Ziele, die eine eigene CA ausgestellt hat. */
const TARGETS = '/usr/local/etc/haproxy/ziele';
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

# Ein Ziel mit Zertifikat aus der eigenen Test-CA, für eigen.test und
# fremdeca.test. Ohne strict-sni: für jeden anderen Namen zeigt es dasselbe
# Zertifikat, und das muss dann am Namen scheitern.
listen caziel
    bind 127.0.0.1:9444 ssl crt ${TARGETS}/ca-ziel.pem
    http-request return status 200 content-type text/plain lf-string "sni=%[ssl_fc_sni]"

# Ausgestellt von einer Zwischenstelle. Das Ziel schickt nur sein eigenes
# Zertifikat, die Zwischenstelle muss aus der hinterlegten Datei kommen.
listen kettenziel
    bind 127.0.0.1:9445 ssl crt ${TARGETS}/ketten-ziel.pem
    http-request return status 200 content-type text/plain lf-string "sni=%[ssl_fc_sni]"

# Selbst signiert und keine CA (CA:FALSE), wie eine Appliance es mitbringt.
listen pinziel
    bind 127.0.0.1:9446 ssl crt ${TARGETS}/pin-ziel.pem
    http-request return status 200 content-type text/plain lf-string "sni=%[ssl_fc_sni]"

# Ein Ziel der internen PKI: sein Zertifikat nennt nur app01.intern.test, nicht
# die Domain, unter der Besucher es aufrufen. Es nimmt nur diesen SNI an und
# antwortet mit SNI und Host-Header, wie sie angekommen sind.
listen internziel
    bind 127.0.0.1:9447 ssl crt ${TARGETS}/intern-ziel.pem strict-sni
    http-request return status 200 content-type text/plain lf-string "sni=%[ssl_fc_sni] host=%[req.hdr(host)]"

# Dasselbe Zertifikat ohne strict-sni: jeder SNI bekommt es zu sehen, und ein
# falscher Name muss an der Prüfung scheitern, nicht am Handshake.
listen internoffen
    bind 127.0.0.1:9448 ssl crt ${TARGETS}/intern-ziel.pem
    http-request return status 200 content-type text/plain lf-string "sni=%[ssl_fc_sni] host=%[req.hdr(host)]"
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
  // Die eigene CA: angenommen, mit fremder CA abgelehnt, am Namen abgelehnt.
  const own = { servers: [{ name: '', target: '127.0.0.1:9444', weight: null }] };
  text = addService(text, service({ ...own, id: 'eigen', domains: ['eigen.test'], backendTls: backendCaTls('test-ca') }));
  text = addService(
    text,
    service({ ...own, id: 'fremdeca', domains: ['fremdeca.test'], healthcheck: false, backendTls: backendCaTls('andere-ca') })
  );
  text = addService(
    text,
    service({ ...own, id: 'falschername', domains: ['falschername.test'], healthcheck: false, backendTls: backendCaTls('test-ca') })
  );
  text = addService(
    text,
    service({
      id: 'kette',
      domains: ['kette.test'],
      servers: [{ name: '', target: '127.0.0.1:9445', weight: null }],
      backendTls: backendCaTls('test-kette'),
    })
  );
  // Nur mit der Root: die Zwischenstelle fehlt, und das Ziel schickt sie nicht.
  text = addService(
    text,
    service({
      id: 'nurroot',
      domains: ['nurroot.test'],
      servers: [{ name: '', target: '127.0.0.1:9445', weight: null }],
      healthcheck: false,
      backendTls: backendCaTls('test-ca'),
    })
  );
  text = addService(
    text,
    service({
      id: 'pin',
      domains: ['pin.test'],
      servers: [{ name: '', target: '127.0.0.1:9446', weight: null }],
      backendTls: backendCaTls('pin'),
    })
  );
  text = addService(
    text,
    service({
      id: 'regelca',
      domains: ['regelca.test'],
      servers: [{ name: '', target: '127.0.0.1:9000', weight: null }],
      backendTls: 'off',
      routes: [
        { name: 'api', paths: ['/api'], servers: [{ name: '', target: '127.0.0.1:9444' }], check: true, backendTls: backendCaTls('test-ca') },
      ],
    })
  );
  // Ein fester Name statt der Domain der Anfrage: der Fall der internen PKI.
  const strict = [{ name: '', target: '127.0.0.1:9447', weight: null }];
  const open = [{ name: '', target: '127.0.0.1:9448', weight: null }];
  const ca = backendCaTls('test-ca');
  text = addService(text, service({ id: 'ohnename', domains: ['ohnename.test'], servers: open, healthcheck: false, backendTls: ca }));
  text = addService(
    text,
    service({ id: 'mitname', domains: ['mitname.test'], servers: strict, backendTls: ca, backendVerifyHost: 'app01.intern.test' })
  );
  text = addService(
    text,
    service({
      id: 'andername',
      domains: ['andername.test'],
      servers: open,
      healthcheck: false,
      backendTls: ca,
      backendVerifyHost: 'anders.intern.test',
    })
  );
  // Gegen die CAs des Systems mit festem Name: die Zeile muss laden, und geprüft wird weiter (die Test-CA kennt das System nicht).
  text = addService(
    text,
    service({
      id: 'systemname',
      domains: ['systemname.test'],
      servers: open,
      healthcheck: false,
      backendTls: 'verify',
      backendVerifyHost: 'app01.intern.test',
    })
  );
  // Unter einer Wildcard hat der Check sonst keinen SNI. Mit festem Namen bekommt er ihn.
  text = addService(
    text,
    service({
      id: 'wildname',
      domains: ['*.wildname.test'],
      servers: [{ name: '', target: '127.0.0.1:9000', weight: null }],
      healthcheck: false,
      backendTls: 'off',
      routes: [
        {
          name: 'api',
          paths: ['/api'],
          servers: [{ name: '', target: '127.0.0.1:9447' }],
          check: true,
          backendTls: ca,
          backendVerifyHost: 'app01.intern.test',
        },
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

const openssl = (args: string[]) => execFileSync('openssl', args, { stdio: 'ignore' });

/** Ein Schlüssel und ein Antrag für `cn`, unterschrieben von `issuer` mit den Erweiterungen `ext`. */
function issue(dir: string, name: string, cn: string, issuer: string, ext: string): void {
  const extFile = join(dir, `${name}.ext`);
  writeFileSync(extFile, ext);
  openssl(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${cn}`, '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.csr`)]);
  openssl([
    'x509', '-req', '-in', join(dir, `${name}.csr`), '-CA', join(dir, `${issuer}.crt`), '-CAkey', join(dir, `${issuer}.key`),
    '-CAcreateserial', '-days', '1', '-extfile', extFile, '-out', join(dir, `${name}.crt`),
  ]);
}

function root(dir: string, name: string, cn: string): void {
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', `/CN=${cn}`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout', join(dir, `${name}.key`), '-out', join(dir, `${name}.crt`),
  ]);
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

/**
 * Die Test-PKI: eine Root, eine Zwischenstelle darunter, eine zweite, fremde
 * Root, und die Zertifikate der drei Ziele. Hinterlegt wird, was
 * `inspectCaUpload` daraus macht: so prüft HAProxy die Datei, die HAPM schreibt.
 */
function ownPki(dir: string): { targets: string; cas: string } {
  const work = join(dir, 'pki');
  const targets = join(dir, 'ziele');
  const cas = join(dir, 'hapm-ca');
  for (const path of [work, targets, cas]) mkdirSync(path);

  root(work, 'root', 'HAPM Test Root');
  root(work, 'andere', 'Eine andere Root');
  issue(work, 'zwischen', 'HAPM Test Zwischenstelle', 'root', 'basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n');
  issue(work, 'leaf', 'eigen.test', 'root', 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:eigen.test,DNS:fremdeca.test,DNS:regelca.test\n');
  issue(work, 'kettenleaf', 'kette.test', 'zwischen', 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:kette.test,DNS:nurroot.test\n');
  issue(work, 'intern', 'app01.intern.test', 'root', 'basicConstraints=CA:FALSE\nsubjectAltName=DNS:app01.intern.test\n');
  openssl([
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=pin.test',
    '-addext', 'basicConstraints=critical,CA:FALSE', '-addext', 'subjectAltName=DNS:pin.test',
    '-keyout', join(work, 'pin.key'), '-out', join(work, 'pin.crt'),
  ]);

  writeFileSync(join(targets, 'ca-ziel.pem'), read(work, 'leaf.crt') + read(work, 'leaf.key'), { mode: 0o644 });
  writeFileSync(join(targets, 'ketten-ziel.pem'), read(work, 'kettenleaf.crt') + read(work, 'kettenleaf.key'), { mode: 0o644 });
  writeFileSync(join(targets, 'pin-ziel.pem'), read(work, 'pin.crt') + read(work, 'pin.key'), { mode: 0o644 });
  writeFileSync(join(targets, 'intern-ziel.pem'), read(work, 'intern.crt') + read(work, 'intern.key'), { mode: 0o644 });

  const store = (name: string, certificate: string, warnings: number) => {
    const checked = inspectCaUpload({ name, certificate }, Date.now());
    check(`inspectCaUpload nimmt „${name}" an`, checked.ok, checked.ok ? '' : JSON.stringify(checked.message));
    if (!checked.ok) return;
    check(`„${name}" mit ${warnings} Hinweis(en)`, checked.value.warnings.length === warnings, JSON.stringify(checked.value.warnings));
    writeFileSync(join(cas, `${name}.pem`), checked.value.pem, { mode: 0o644 });
  };
  store('test-ca', read(work, 'root.crt'), 0);
  store('andere-ca', read(work, 'andere.crt'), 0);
  // Zwischenstelle zuerst, Root danach: die Reihenfolge in der Datei spielt für HAProxy keine Rolle.
  store('test-kette', read(work, 'zwischen.crt') + read(work, 'root.crt'), 0);
  store('pin', read(work, 'pin.crt'), 1);

  const leaf = inspectCaUpload({ name: 'blatt', certificate: read(work, 'leaf.crt') }, Date.now());
  check('inspectCaUpload lehnt das Zertifikat eines Servers ab, das eine CA ausgestellt hat', !leaf.ok);
  const withKey = inspectCaUpload({ name: 'schluessel', certificate: read(work, 'root.crt') + read(work, 'root.key') }, Date.now());
  check('inspectCaUpload lehnt einen privaten Schlüssel ab', !withKey.ok);

  return { targets, cas };
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
    const pki = ownPki(dir);
    const cfg = join(dir, 'haproxy.cfg');
    const mounts = [
      '-v', `${cfg}:${CFG}:ro`,
      '-v', `${pem}:${PEM}:ro`,
      '-v', `${pki.targets}:${TARGETS}:ro`,
      '-v', `${pki.cas}:${BACKEND_CA_DIR}:ro`,
    ];

    // `ssl` ohne `verify`: HAProxy prüft dann gegen `ssl-server-verify`
    // (Vorgabe `required`) und hat keine CA. Angenommen hieße, dass ein
    // Ziel ohne Prüfung auch ohne `verify none` ginge.
    writeFileSync(cfg, `${BASE}\nbackend nackt\n    server s 127.0.0.1:9443 ssl\n`, { mode: 0o644 });
    const bare = haproxyCheck(version, mounts);
    check('haproxy -c lehnt „ssl" ohne verify ab', !bare.ok, bare.output.slice(-300));

    // Eine Zertifizierungsstelle, die nicht hinterlegt ist: HAProxy lädt dann die ganze Datei nicht.
    writeFileSync(
      cfg,
      addService(BASE, service({ id: 'fehlt', domains: ['fehlt.test'], backendTls: backendCaTls('gibt-es-nicht') })),
      { mode: 0o644 }
    );
    const missing = haproxyCheck(version, mounts);
    check('haproxy -c lehnt eine ca-file ab, die fehlt', !missing.ok, missing.output.slice(-300));

    writeFileSync(cfg, config(), { mode: 0o644 });
    const checked = haproxyCheck(version, mounts);
    check('haproxy -c nimmt alle HTTPS-Formen an, auch die hinterlegten Zertifizierungsstellen', checked.ok, checked.output.slice(-400));
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

    const own = await call('eigen.test');
    check('eigene CA: ein Ziel mit Zertifikat aus ihr antwortet', own.status === 200 && own.body === 'sni=eigen.test', `${own.status} ${own.body}`);
    check('und der Healthcheck mit check-sni hält es im Betrieb', own.status === 200);
    const foreign = await call('fremdeca.test');
    check('eigene CA: gegen eine fremde CA wird dasselbe Ziel abgelehnt (503)', foreign.status === 503, `Status ${foreign.status}`);
    const wrongName = await call('falschername.test');
    check('eigene CA: ein Zertifikat für eine andere Domain wird abgelehnt (503)', wrongName.status === 503, `Status ${wrongName.status}`);
    const chain = await call('kette.test');
    check('Bündel aus Root und Zwischenstelle: das Ziel schickt nur sein Zertifikat und antwortet', chain.status === 200 && chain.body === 'sni=kette.test', `${chain.status} ${chain.body}`);
    const rootOnly = await call('nurroot.test');
    check('nur die Root hinterlegt: ohne die Zwischenstelle wird es abgelehnt (503)', rootOnly.status === 503, `Status ${rootOnly.status}`);
    const pinned = await call('pin.test');
    check('selbst signiertes Zertifikat eines Servers als Stelle: genau dieses Ziel antwortet', pinned.status === 200 && pinned.body === 'sni=pin.test', `${pinned.status} ${pinned.body}`);
    const caRoute = await call('regelca.test', '/api/x');
    check('eine Pfad-Regel prüft gegen die eigene CA', caRoute.status === 200 && caRoute.body === 'sni=regelca.test', `${caRoute.status} ${caRoute.body}`);

    const noName = await call('ohnename.test');
    check('interner Name im Zertifikat, ohne festen Namen: abgelehnt (503)', noName.status === 503, `Status ${noName.status}`);
    const named = await call('mitname.test');
    check('mit festem Namen: das Ziel antwortet', named.status === 200, `Status ${named.status} ${named.body}`);
    check('es bekommt den Namen als SNI', named.body.startsWith('sni=app01.intern.test '), named.body);
    check('und die Domain der Anfrage weiter als Host-Header', named.body.endsWith(' host=mitname.test'), named.body);
    check('der Healthcheck mit check-sni des Namens hält es im Betrieb', named.status === 200);
    const otherName = await call('andername.test');
    check('mit einem falschen Namen: abgelehnt (503)', otherName.status === 503, `Status ${otherName.status}`);
    const systemName = await call('systemname.test');
    check('fester Name gegen die CAs des Systems: geprüft wird weiter (503 bei der Test-CA)', systemName.status === 503, `Status ${systemName.status}`);
    const wildName = await call('kunde.wildname.test', '/api/x');
    check(
      'unter einer Wildcard: Pfad-Regel mit festem Namen antwortet, Host ist die aufgerufene Domain',
      wildName.status === 200 && wildName.body === 'sni=app01.intern.test host=kunde.wildname.test',
      `${wildName.status} ${wildName.body}`
    );
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
