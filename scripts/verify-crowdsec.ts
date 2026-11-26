/**
 * CrowdSec gegen echtes HAProxy, CrowdSec und den SPOA-Bouncer prüfen.
 *
 *   pnpm crowdsec:verify
 *
 * Braucht Docker und Netz (CrowdSec holt beim ersten Start seine Regeln). Ein
 * Skript und kein Test in `pnpm test`, aus demselben Grund wie
 * `verify-proxy-pages.ts`: ein Test, der sich ohne Docker still überspringt,
 * ist ein grüner Haken ohne Deckung.
 *
 * Die Konfiguration entsteht wie im Betrieb: Grundkonfiguration, eine Gruppe,
 * Ziele über `addService`, der globale Schalter über `applyGlobalSettings`,
 * das Backend des Bouncers über `syncCrowdsecBackend`, die Dateien für
 * CrowdSec und den Bouncer aus `lib/crowdsec/files.ts`. Geprüft wird, was nur
 * die echten Programme zeigen:
 *
 *  - `haproxy -c` nimmt die Zeilen in mehreren Fassungen an,
 *  - die WAF lehnt eine Anfrage auf `/.env` mit 403 ab, nur bei Zielen mit
 *    CrowdSec, global bei allen, und der Alarm nennt die Domain,
 *  - eine Sperre von Hand trifft die Adresse, eine Freigabe hebt sie auf,
 *  - ein Szenario aus dem Log von HAProxy trägt das Backend (`target_backend`),
 *  - ohne Bouncer gehen Anfragen durch.
 *
 * Wer `CROWDSEC_LINES`, die SPOE-Datei oder die Dateien für CrowdSec ändert,
 * lässt dieses Skript laufen.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync } from 'node:fs';
import { request } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderBaseConfig } from '../lib/haproxy/base-config';
import {
  addScope,
  addService,
  applyGlobalSettings,
  crowdsecSpoeConfig,
  parseGlobalSettings,
  syncCrowdsecBackend,
  type CreateServiceInput,
} from '../lib/haproxy/config';
import { renderAcquis, renderBackendParser, renderBouncerConfig, BASE_COLLECTIONS } from '../lib/crowdsec/files';
import { parseAlerts, parseDecisions } from '../lib/crowdsec/data';

const NETWORK = 'hapm-verify-crowdsec';
const PREFIX = 'hapm-verify-cs';
const PORT = 18443;
const KEY = 'verify0123456789abcdef0123456789abcdef';
const VERSIONS = ['2.4', '2.8', '3.0', 'lts'];

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const quiet = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok  ' : '  FEHLER'} ${label}${detail ? `: ${detail}` : ''}`);
}

function service(id: string, domain: string, crowdsec: boolean): CreateServiceInput {
  return {
    scope: 'WEB',
    id,
    domains: [domain],
    servers: [{ name: 'ziel', target: `${PREFIX}-ziel:8000`, weight: null }],
    redirect: null,
    routes: [],
    balance: null,
    sticky: false,
    lockedDomains: [],
    passwordLock: null,
    responseHeaders: [],
    requestHeaders: [],
    tunnel: false,
    crowdsec,
    healthcheck: false,
    backendTls: 'off',
  };
}

function config(global: boolean): string {
  let text = addScope(renderBaseConfig({ ipv6: false, errorStatuses: [403, 404] }), 'WEB');
  text = addService(text, service('shop', 'shop.example.org', true));
  text = addService(text, service('blog', 'blog.example.org', false));
  const current = parseGlobalSettings(text);
  text = applyGlobalSettings(text, { httpsLines: current.httpsLines ?? [], adminIps: [], crowdsec: global });
  return syncCrowdsecBackend(text, `${PREFIX}-bouncer:7423`);
}

function stage(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hapm-crowdsec-'));
  for (const sub of ['etc/certs', 'etc/errors', 'etc/hapm-crowdsec', 'run', 'cs/acquis', 'cs/parser', 'cs/secrets', 'cs/bouncer', 'log']) {
    mkdirSync(join(dir, sub), { recursive: true });
  }
  // Ein Zertifikat für beide Namen, selbst signiert: strict-sni will eines.
  docker([
    'run', '--rm', '-v', `${join(dir, 'etc/certs')}:/out`, '--entrypoint', 'sh', 'alpine/openssl', '-c',
    'openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=shop.example.org ' +
      '-addext subjectAltName=DNS:shop.example.org,DNS:blog.example.org -keyout /tmp/k -out /tmp/c && cat /tmp/c /tmp/k > /out/test.pem',
  ]);
  for (const status of [403, 404]) {
    writeFileSync(
      join(dir, `etc/errors/${status}.http`),
      `HTTP/1.0 ${status} Fehler\r\nContent-Type: text/plain\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\nstatus ${status}\n`
    );
  }
  writeFileSync(join(dir, 'etc/hapm-crowdsec/spoe.cfg'), crowdsecSpoeConfig());
  writeFileSync(join(dir, 'etc/hapm-crowdsec/allow.lst'), '');
  writeFileSync(join(dir, 'etc/haproxy.cfg'), config(false));
  // Unter Docker Desktop meldet inotify Änderungen an eingebundenen Dateien nicht.
  writeFileSync(join(dir, 'cs/acquis/hapm.yaml'), renderAcquis('off').replace('labels:\n  type: haproxy', 'poll_without_inotify: true\nlabels:\n  type: haproxy'));
  writeFileSync(join(dir, 'cs/parser/hapm-backend.yaml'), renderBackendParser());
  writeFileSync(join(dir, 'cs/secrets/bouncer_key_hapm'), KEY);
  writeFileSync(
    join(dir, 'cs/bouncer/crowdsec-spoa-bouncer.yaml'),
    renderBouncerConfig(KEY).replace(/http:\/\/crowdsec:/g, `http://${PREFIX}-crowdsec:`)
  );
  writeFileSync(join(dir, 'log/haproxy.log'), '');
  return dir;
}

function get(path: string, host: string, body?: string): Promise<{ status: number; text: string; ms: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const req = request(
      {
        host: '127.0.0.1',
        port: PORT,
        path,
        method: body === undefined ? 'GET' : 'POST',
        servername: host,
        rejectUnauthorized: false,
        headers: { host, 'user-agent': 'hapm-verify', ...(body === undefined ? {} : { 'content-type': 'text/plain' }) },
        timeout: 15_000,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text, ms: Date.now() - started }));
      }
    );
    req.on('error', (err) => resolve({ status: 0, text: err.message, ms: Date.now() - started }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function cscli(args: string[]): string {
  return docker(['exec', `${PREFIX}-crowdsec`, 'cscli', ...args]);
}

async function waitFor(label: string, test: () => boolean | Promise<boolean>, ms = 120_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      if (await test()) return true;
    } catch {
      // Noch nicht bereit.
    }
    await sleep(2000);
  }
  check(label, false, 'Zeit abgelaufen');
  return false;
}

function cleanup(): void {
  for (const name of ['haproxy', 'bouncer', 'crowdsec', 'ziel']) quiet(['rm', '-f', '-v', `${PREFIX}-${name}`]);
  quiet(['network', 'rm', NETWORK]);
}

function startHaproxy(dir: string, global: boolean): void {
  writeFileSync(join(dir, 'etc/haproxy.cfg'), config(global));
  quiet(['rm', '-f', `${PREFIX}-haproxy`]);
  docker([
    'run', '-d', '--name', `${PREFIX}-haproxy`, '--network', NETWORK, '-p', `127.0.0.1:${PORT}:443`, '--user', 'root',
    '-v', `${join(dir, 'etc')}:/etc/haproxy:ro`, '-v', `${join(dir, 'run')}:/run/haproxy`,
    'haproxy:lts', 'haproxy', '-f', '/etc/haproxy/haproxy.cfg',
  ]);
}

async function main(): Promise<void> {
  docker(['version', '--format', '{{.Server.Version}}']);
  cleanup();
  const dir = stage();
  console.log(`Arbeitsordner ${dir}`);

  try {
    console.log('haproxy -c');
    for (const version of VERSIONS) {
      for (const global of [false, true]) {
        // HTTP/3 gibt es in den offiziellen Abbildern erst mit `lts`. Die Zeilen
        // gehören zur Grundkonfiguration und nicht zu CrowdSec.
        const text = config(global);
        writeFileSync(
          join(dir, 'etc/haproxy.cfg'),
          version === 'lts' ? text : text.split('\n').filter((line) => !/quic|alt-svc/.test(line)).join('\n')
        );
        const checked = quiet([
          'run', '--rm', '--add-host', `${PREFIX}-bouncer:127.0.0.1`, '--add-host', `${PREFIX}-ziel:127.0.0.1`,
          '-v', `${join(dir, 'etc')}:/etc/haproxy:ro`, `haproxy:${version}`, 'haproxy', '-c', '-f', '/etc/haproxy/haproxy.cfg',
        ]);
        const warnings = `${checked.stdout}${checked.stderr}`.split('\n').filter((line) => /WARNING|ALERT/.test(line) && !/quic|QUIC/.test(line));
        check(`${version}, global ${global ? 'an' : 'aus'}`, checked.status === 0 && warnings.length === 0, warnings.join(' | ') || (checked.status === 0 ? '' : checked.stderr.trim()));
      }
    }

    console.log('Stack starten');
    docker(['network', 'create', NETWORK]);
    docker([
      'run', '-d', '--name', `${PREFIX}-ziel`, '--network', NETWORK, 'haproxy:lts', 'sh', '-c',
      'printf "global\\ndefaults\\n mode http\\n timeout client 5s\\n timeout server 5s\\n timeout connect 5s\\nfrontend f\\n bind :8000\\n http-request return status 200 content-type text/plain string ziel\\n" > /tmp/z.cfg && haproxy -f /tmp/z.cfg',
    ]);
    docker([
      'run', '-d', '--name', `${PREFIX}-crowdsec`, '--network', NETWORK,
      '-e', `COLLECTIONS=${BASE_COLLECTIONS.join(' ')}`,
      '-v', '/var/lib/crowdsec/data', '-v', '/etc/crowdsec',
      '-v', `${join(dir, 'cs/acquis/hapm.yaml')}:/etc/crowdsec/acquis.d/hapm.yaml:ro`,
      '-v', `${join(dir, 'cs/parser/hapm-backend.yaml')}:/etc/crowdsec/parsers/s02-enrich/hapm-backend.yaml:ro`,
      '-v', `${join(dir, 'cs/secrets')}:/run/secrets:ro`,
      '-v', `${join(dir, 'log')}:/var/log/haproxy:ro`,
      'crowdsecurity/crowdsec:latest',
    ]);
    docker([
      'run', '-d', '--name', `${PREFIX}-bouncer`, '--network', NETWORK, '--restart', 'unless-stopped',
      '-v', `${join(dir, 'cs/bouncer')}:/etc/crowdsec/bouncers:ro`, 'crowdsecurity/spoa-bouncer:latest',
    ]);
    if (!(await waitFor('CrowdSec bereit', () => quiet(['exec', `${PREFIX}-crowdsec`, 'cscli', 'lapi', 'status']).status === 0, 240_000))) return;
    if (!(await waitFor('Bouncer bereit', () => quiet(['logs', `${PREFIX}-bouncer`]).stderr.includes('Serving TCP') || quiet(['logs', `${PREFIX}-bouncer`]).stdout.includes('Serving TCP')))) return;
    check('Bouncer angemeldet', cscli(['bouncers', 'list', '-o', 'json']).includes('"hapm"'));

    console.log('Je Ziel (global aus)');
    startHaproxy(dir, false);
    if (!(await waitFor('HAProxy antwortet', async () => (await get('/', 'shop.example.org')).status === 200))) return;
    const plain = await get('/', 'shop.example.org');
    check('shop: GET / geht durch', plain.status === 200 && plain.text.includes('ziel'), `${plain.status}`);
    const waf = await get('/.env', 'shop.example.org');
    check('shop: GET /.env lehnt die WAF ab', waf.status === 403, `${waf.status} ${waf.text.trim()}`);
    const blogWaf = await get('/.env', 'blog.example.org');
    check('blog (ohne CrowdSec): GET /.env geht durch', blogWaf.status === 200, `${blogWaf.status}`);
    const big = await get('/upload', 'shop.example.org', 'x'.repeat(20_000));
    check('shop: großer Rumpf geht ohne Rumpf an die WAF', big.status === 200, `${big.status}`);
    const smallBad = await get('/.env', 'shop.example.org', 'a=1');
    check('shop: kleiner Rumpf geht mit an die WAF', smallBad.status === 403, `${smallBad.status}`);

    await sleep(2000);
    const alerts = parseAlerts(JSON.parse(cscli(['alerts', 'list', '-o', 'json'])));
    const wafAlert = alerts.find((alert) => alert.kind === 'waf');
    check('WAF-Alarm nennt die Domain', wafAlert?.targetHost === 'shop.example.org', JSON.stringify(wafAlert?.targetHost));
    const client = wafAlert?.source ?? '';
    check('WAF-Alarm nennt die Adresse', /^\d+\.\d+\.\d+\.\d+$/.test(client), client);

    console.log('Global an');
    startHaproxy(dir, true);
    await waitFor('HAProxy antwortet', async () => (await get('/', 'blog.example.org')).status === 200);
    const blogGlobal = await get('/.env', 'blog.example.org');
    check('blog: GET /.env lehnt die WAF ab', blogGlobal.status === 403, `${blogGlobal.status}`);
    const shopGlobal = await get('/', 'shop.example.org');
    check('shop: GET / geht durch (nicht doppelt gefragt)', shopGlobal.status === 200, `${shopGlobal.status}`);

    console.log('Sperren und Freigaben');
    cscli(['decisions', 'add', '--ip', client, '--duration', '5m', '--reason', 'verify']);
    const decisions = parseDecisions(JSON.parse(cscli(['decisions', 'list', '-o', 'json'])), Date.now());
    check('Sperre steht in der Liste', decisions.some((d) => d.value === client && d.until !== null));
    await waitFor('Sperre greift', async () => (await get('/', 'blog.example.org')).status === 403, 30_000);
    cscli(['allowlists', 'create', 'hapm', '-d', 'verify']);
    cscli(['allowlists', 'add', 'hapm', client, '-d', 'verify']);
    await waitFor('Freigabe hebt die Sperre auf', async () => (await get('/', 'blog.example.org')).status === 200, 30_000);
    const unlisted = await get('/.env', 'blog.example.org');
    check('Freigabe nur in CrowdSec: die WAF prüft weiter', unlisted.status === 403, `${unlisted.status}`);
    // Was HAPM nach einer Freigabe tut: die Datei für HAProxy schreiben und neu laden.
    writeFileSync(join(dir, 'etc/hapm-crowdsec/allow.lst'), `${client}\n`);
    startHaproxy(dir, true);
    await waitFor('HAProxy antwortet', async () => (await get('/', 'blog.example.org')).status === 200);
    const allowedWaf = await get('/.env', 'blog.example.org');
    check('Freigegebene Adresse: die WAF prüft nicht', allowedWaf.status === 200, `${allowedWaf.status}`);
    cscli(['allowlists', 'remove', 'hapm', client]);

    console.log('Log von HAProxy');
    const now = new Date();
    const stamp = now.toISOString().slice(0, 19) + 'Z';
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const pad = (n: number) => String(n).padStart(2, '0');
    const date = `${pad(now.getUTCDate())}/${months[now.getUTCMonth()]}/${now.getUTCFullYear()}:${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}:${pad(now.getUTCSeconds())}.000`;
    const lines = Array.from(
      { length: 15 },
      (_, i) => `${stamp} haproxy: 198.51.100.77:5${i} [${date}] public_https~ shop/ziel 0/0/1/2/3 404 120 - - ---- 1/1/0/0/0 0/0 "GET /probe${i}.php HTTP/1.1"`
    );
    appendFileSync(join(dir, 'log/haproxy.log'), `${lines.join('\n')}\n`);
    await waitFor('Szenario aus dem Log', () => cscli(['alerts', 'list', '-o', 'json']).includes('198.51.100.77'), 60_000);
    const logAlert = parseAlerts(JSON.parse(cscli(['alerts', 'list', '-o', 'json']))).find((a) => a.source === '198.51.100.77');
    check('Szenario trägt das Backend', logAlert?.targetBackend === 'shop', JSON.stringify(logAlert?.targetBackend));
    check('Szenario sperrt die Adresse', (logAlert?.decisions ?? 0) > 0);

    console.log('Ohne Bouncer');
    docker(['rm', '-f', `${PREFIX}-bouncer`]);
    await sleep(6000);
    const down = await get('/', 'shop.example.org');
    check('Anfragen gehen durch, wenn der Bouncer fehlt', down.status === 200 && down.ms < 3000, `${down.status} in ${down.ms} ms`);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(failures === 0 ? '\nAlles in Ordnung.' : `\n${failures} Prüfung(en) fehlgeschlagen.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

void main().catch((err) => {
  console.error(err);
  cleanup();
  process.exitCode = 1;
});

