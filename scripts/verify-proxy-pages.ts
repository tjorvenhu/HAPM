/**
 * Die Passwortsperre und die Fehlerseiten gegen ein echtes HAProxy prüfen.
 *
 *   pnpm haproxy:verify-pages            # 2.4, 2.8 und 3.0
 *   pnpm haproxy:verify-pages 3.2        # eine bestimmte Fassung
 *
 * Braucht Docker. Das ist der Grund, warum es ein Skript ist und kein Test in
 * `pnpm test`: dort läuft es nicht überall, und ein Test, der sich ohne Docker
 * still überspringt, ist ein grüner Haken ohne Deckung.
 *
 * ── Warum es das gibt ──
 *
 * `tests/haproxy/password-lock.test.ts` prüft, dass geschrieben wird, was
 * zurückgelesen wird. Ob HAProxy die Zeilen so versteht, wie sie gemeint sind,
 * kann es nicht prüfen, und genau dort liegen die Fehler, die niemand sieht:
 * ein Konverter, der in einer Version anders heißt, ein Rumpf, der beim Prüfen
 * noch nicht gelesen ist, ein Passwort mit Umlaut, das der Browser anders
 * kodiert, als der Hash es erwartet. Jeder davon ergibt eine gültige Datei und
 * eine Sperre, durch die niemand kommt, oder schlimmer: jeder.
 *
 * Deshalb entsteht hier dieselbe Konfiguration wie im Betrieb (`addService`,
 * `createPasswordLock`, `lockPages`), HAProxy startet damit, und ein Client
 * schickt, was ein Browser-Formular schickt.
 *
 * Dasselbe gilt für die Fehlerseiten (`lib/haproxy/error-pages.ts`): eine
 * Fehlerdatei ist eine rohe HTTP-Antwort, die HAProxy beim Laden einliest, und
 * ob es sie annimmt und mit dem Status ausliefert, der in ihr steht, sagt nur
 * HAProxy.
 *
 * Dazu ein Durchgang mit dem größten Design, das HAPM speichern lässt: ein
 * Logo genau bis zur Grenze (`PAGE_MAX_BYTES`). Knapp darüber nimmt
 * `haproxy -c` die Passwortabfrage noch an, und HAProxy beantwortet sie mit 500
 * (`lib/haproxy/page-design.ts`). Hier zeigt sich, ob die Grenze trägt.
 *
 * Wer `passwordLockRules`, `renderErrorFile` oder das Design der Seiten
 * ändert, lässt dieses Skript laufen.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addService,
  lockCookieFor,
  LOCK_FIELD,
  LOCK_MAX_ATTEMPTS,
  LOCK_PAGE_DIR,
  type CreateServiceInput,
  type PasswordLock,
} from '../lib/haproxy/config';
import { createPasswordLock } from '../lib/haproxy/password-lock';
import { lockPages } from '../lib/haproxy/lock-page';
import { renderErrorFile } from '../lib/haproxy/error-pages';
import {
  bytesToBase64,
  defaultPageDesign,
  parsePageDesign,
  PAGE_MAX_BYTES,
  type PageDesign,
} from '../lib/haproxy/page-design';
import { designPageSizes, logoByteBudget } from '../lib/haproxy/design-pages';

const VERSIONS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['2.4', '2.8', '3.0'];
const PORT = 18480;
/** Alles, was ein Formular anders kodiert als man denkt: Leerzeichen, Plus,
 *  Prozent, Und, Gleich, Umlaut, Anführungszeichen, Euro. */
const PASSWORD = 'a b+c%&=ä"\'<>€;';

const BASE = `global
    log stdout format raw local0

defaults
    mode http
    timeout connect 5s
    timeout client 30s
    timeout server 30s
    errorfile 403 /etc/haproxy/errors/403.http

frontend https_in
    bind :8080

# END AUTO TEST SERVICES

    acl fehler_aus hdr(host),lower -i aus.test
    acl fehler_unbekannt hdr(host),lower -i unbekannt.test
    acl fehler_gesperrt hdr(host),lower -i gesperrt.test
    http-request deny deny_status 403 if fehler_gesperrt
    use_backend aus if fehler_aus
    use_backend unbekannt if fehler_unbekannt
    default_backend sonst

# END AUTO TEST BACKENDS

backend sonst
    http-request return status 200 content-type text/plain string "sonst"

# Ein Backend ohne Server antwortet mit 503.
backend aus
    errorfile 503 /etc/haproxy/errors/503.http

# Der Griff für unbekannte Domains: die 503 des leeren Backends wird über die
# Fehlerdatei zur 404.
backend unbekannt
    errorfile 503 /etc/haproxy/errors/404.http

listen ziel
    bind 127.0.0.1:9000
    http-request return status 200 content-type text/plain string "ziel"
`;

const service = (over: Partial<CreateServiceInput>): CreateServiceInput => ({
  scope: 'TEST',
  id: 'ganz',
  domains: ['ganz.test'],
  servers: [{ name: 'web', target: '127.0.0.1:9000', weight: null }],
  redirect: null,
  routes: [],
  balance: null,
  sticky: false,
  lockedDomains: ['ganz.test'],
  passwordLock: null,
  responseHeaders: [],
  requestHeaders: [],
  tunnel: false,
  healthcheck: false,
  ...over,
});

interface Reply {
  status: number;
  location: string;
  cookie: string;
  contentType: string;
  body: string;
}

function call(opts: {
  host: string;
  path?: string;
  method?: string;
  cookie?: string;
  form?: Record<string, string>;
}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    // Genau die Kodierung eines Browser-Formulars.
    const body = opts.form ? new URLSearchParams(opts.form).toString() : null;
    const headers: Record<string, string | number> = { Host: opts.host };
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (body !== null) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = request(
      { host: '127.0.0.1', port: PORT, path: opts.path ?? '/', method: opts.method ?? (body ? 'POST' : 'GET'), headers },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            location: String(res.headers.location ?? ''),
            cookie: String(res.headers['set-cookie']?.[0] ?? ''),
            contentType: String(res.headers['content-type'] ?? ''),
            body: data,
          })
        );
      }
    );
    req.on('error', reject);
    if (body !== null) req.write(body);
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

async function verify(version: string): Promise<void> {
  console.log(`\nHAProxy ${version}`);

  const full = createPasswordLock(PASSWORD);
  const partial = createPasswordLock('nur für eine Domain');
  const { dir, mounts } = stage(full, partial, defaultPageDesign());

  const name = `hapm-lock-verify-${version.replace(/\W/g, '-')}`;
  try {
    docker(['rm', '-f', name]);
  } catch {
    // Es gab keinen.
  }

  try {
    try {
      docker(['run', '--rm', ...mounts, `haproxy:${version}`, 'haproxy', '-c', '-f', '/usr/local/etc/haproxy/haproxy.cfg']);
      check('haproxy -c nimmt die Konfiguration an', true);
    } catch (err) {
      const out = err as { stdout?: string; stderr?: string };
      check('haproxy -c nimmt die Konfiguration an', false, `${out.stdout ?? ''}${out.stderr ?? ''}`.trim().slice(-400));
      return;
    }

    docker(['run', '-d', '--name', name, '-p', `127.0.0.1:${PORT}:8080`, ...mounts, `haproxy:${version}`]);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const cookie = `${lockCookieFor('ganz')}=${full.token}`;
    const host = 'ganz.test';

    const other = await call({ host: 'fremd.test' });
    check('eine andere Domain ist nicht betroffen', other.status === 200 && other.body === 'sonst');

    const ask = await call({ host, path: '/pfad?x=1' });
    check('ohne Cookie kommt die Abfrage (401)', ask.status === 401 && ask.body.includes(LOCK_FIELD));
    check('die Abfrage ist die ganze Seite', ask.body.trimEnd().endsWith('</html>'));

    const wrong = await call({ host, path: '/pfad?x=1', form: { [LOCK_FIELD]: 'falsch' } });
    check('ein falsches Passwort bekommt den Hinweis (401)', wrong.status === 401 && wrong.body.includes('stimmt nicht'));

    const right = await call({ host, path: '/pfad?x=1&y=2', form: { [LOCK_FIELD]: PASSWORD } });
    check('das richtige Passwort leitet zurück (303)', right.status === 303, `Status ${right.status}`);
    check('und zwar auf dieselbe Adresse', right.location === `https://${host}/pfad?x=1&y=2`, right.location);
    check(
      'mit dem Cookie, wie er geschrieben wurde',
      right.cookie.startsWith(`${cookie};`) && /HttpOnly/.test(right.cookie) && /Secure/.test(right.cookie),
      right.cookie
    );

    const evil = await call({ host, path: '//fremd.example/x', form: { [LOCK_FIELD]: PASSWORD } });
    check('ein Pfad wie //fremd.example führt nicht auf eine fremde Seite', evil.location === `https://${host}//fremd.example/x`, evil.location);

    const through = await call({ host, path: '/pfad', cookie: `a=b; ${cookie}` });
    check('mit Cookie geht es ans Ziel', through.status === 200 && through.body === 'ziel');

    const post = await call({ host, path: '/pfad', cookie, form: { a: 'b' } });
    check('auch ein POST mit Cookie geht ans Ziel', post.status === 200 && post.body === 'ziel');

    const forged = await call({ host, cookie: `${lockCookieFor('ganz')}=${full.token}x` });
    check('ein verlängerter Cookie-Wert gilt nicht', forged.status === 401);
    const foreign = await call({ host, cookie: `${lockCookieFor('teil')}=${partial.token}` });
    check('der Cookie eines anderen Eintrags gilt nicht', foreign.status === 401);

    const open = await call({ host: 'offen.test' });
    check('die offene Domain eines teilweise gesperrten Eintrags bleibt offen', open.status === 200 && open.body === 'ziel');
    const shut = await call({ host: 'zu.test' });
    check('die gesperrte Domain desselben Eintrags fragt', shut.status === 401);
    const shutRight = await call({ host: 'zu.test', form: { [LOCK_FIELD]: 'nur für eine Domain' } });
    check('und lässt mit ihrem Passwort durch', shutRight.status === 303 && shutRight.cookie.startsWith(`${lockCookieFor('teil')}=${partial.token};`));
    const crossed = await call({ host: 'zu.test', form: { [LOCK_FIELD]: PASSWORD } });
    check('aber nicht mit dem Passwort des anderen Eintrags', crossed.status === 401);

    // Bis hierher hat `ganz.test` drei Eingaben ohne Cookie gesehen (falsch,
    // richtig, //fremd). Aufgefüllt wird bis zur Grenze, und die nächste muss
    // abgewiesen werden, auch die richtige.
    for (let i = 3; i < LOCK_MAX_ATTEMPTS; i++) await call({ host, form: { [LOCK_FIELD]: 'falsch' } });
    const throttled = await call({ host, form: { [LOCK_FIELD]: PASSWORD } });
    check(`nach ${LOCK_MAX_ATTEMPTS} Eingaben kommt 429, auch für das richtige Passwort`, throttled.status === 429, `Status ${throttled.status}`);
    check('und die Seite dazu bietet kein Formular mehr an', !throttled.body.includes('<form'));
    const still = await call({ host, cookie });
    check('wer schon durch ist, merkt davon nichts', still.status === 200 && still.body === 'ziel');
    const elsewhere = await call({ host: 'zu.test', form: { [LOCK_FIELD]: 'falsch' } });
    check('gezählt wird je Eintrag', elsewhere.status === 401);

    /* ── Fehlerseiten ── */
    const down = await call({ host: 'aus.test' });
    check('ein Ziel ohne Server zeigt die 503-Seite', down.status === 503 && down.body.includes('Gerade nicht erreichbar'), `Status ${down.status}`);
    check('als HTML in UTF-8', down.contentType === 'text/html; charset=utf-8', down.contentType);
    check('vollständig, mit Logo', down.body.trimEnd().endsWith('</html>') && down.body.includes('<svg'));
    const unknown = await call({ host: 'unbekannt.test' });
    check('die Datei bestimmt den Status: aus errorfile 503 wird eine 404', unknown.status === 404 && unknown.body.includes('nichts eingerichtet'), `Status ${unknown.status}`);
    const denied = await call({ host: 'gesperrt.test' });
    check('eine Sperre mit deny_status 403 zeigt die 403-Seite', denied.status === 403 && denied.body.includes('Kein Zugriff'), `Status ${denied.status}`);
  } finally {
    try {
      docker(['rm', '-f', name]);
    } catch {
      // Schon weg.
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Konfiguration, Seiten der Passwortsperre und Fehlerdateien in ein frisches
 * Verzeichnis, eingehängt dort, wo sie auf der Maschine liegen.
 */
function stage(full: PasswordLock, partial: PasswordLock, design: PageDesign): { dir: string; mounts: string[] } {
  let config = addService(BASE, service({ passwordLock: full }));
  config = addService(
    config,
    service({
      id: 'teil',
      domains: ['offen.test', 'zu.test'],
      lockedDomains: ['zu.test'],
      passwordLock: partial,
    })
  );
  const dir = mkdtempSync(join(tmpdir(), 'hapm-lock-'));
  mkdirSync(join(dir, 'pages'));
  writeFileSync(join(dir, 'haproxy.cfg'), config);
  for (const page of lockPages(design)) writeFileSync(join(dir, 'pages', page.file), page.html);
  mkdirSync(join(dir, 'errors'));
  for (const status of [403, 404, 503]) {
    writeFileSync(join(dir, 'errors', `${status}.http`), renderErrorFile(status, design));
  }
  const mounts = [
    '-v', `${join(dir, 'haproxy.cfg')}:/usr/local/etc/haproxy/haproxy.cfg:ro`,
    '-v', `${join(dir, 'pages')}:${LOCK_PAGE_DIR}:ro`,
    '-v', `${join(dir, 'errors')}:/etc/haproxy/errors:ro`,
  ];
  return { dir, mounts };
}

/**
 * Das größte Design, das die Route annimmt: ein langer Text und ein Logo genau
 * bis zur Grenze. Ein PNG, weil seine Data-URI immer Base64 ist und die Grenze
 * deshalb aufs Byte trifft. Einmal ist die Passwortabfrage die größte Seite,
 * einmal die 503: die beiden liefert HAProxy auf verschiedenen Wegen aus.
 */
function largestDesign(largest: 'lock' | 'error'): PageDesign {
  const long = 'ü'.repeat(300);
  const raw = {
    colors: { accent: '#7a1f3d', background: '#101418', text: '#eef1f4' },
    brand: 'Beispiel',
    footer: 'Kontakt: it@example.org',
    lock: { title: 'Geschützte Vorschau', subtitle: largest === 'lock' ? long : null, submit: 'Weiter' },
    errors: largest === 'error' ? { 503: { text: long } } : {},
  };
  const png = (size: number) => {
    const bytes = new Uint8Array(size);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (let i = 8; i < size; i++) bytes[i] = (i * 31) % 256;
    return bytesToBase64(bytes);
  };
  const probe = parsePageDesign({ ...raw, logo: { kind: 'custom', data: png(8) } });
  if (!probe.ok) throw new Error(probe.error);
  const parsed = parsePageDesign({ ...raw, logo: { kind: 'custom', data: png(logoByteBudget(probe.design)) } });
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.design;
}

async function verifyLargest(version: string, kind: 'lock' | 'error'): Promise<void> {
  const design = largestDesign(kind);
  const [largest] = designPageSizes(design);
  console.log(`\nHAProxy ${version}, größtes Design („${largest.page.label}“: ${largest.bytes} von ${PAGE_MAX_BYTES} Bytes)`);

  const { dir, mounts } = stage(createPasswordLock(PASSWORD), createPasswordLock('zweites'), design);
  const name = `hapm-lock-verify-gross-${version.replace(/\W/g, '-')}`;
  try {
    docker(['rm', '-f', name]);
  } catch {
    // Es gab keinen.
  }

  try {
    // `spawnSync` statt `docker()`: Warnungen stehen auf stderr, auch wenn die
    // Prüfung besteht.
    const checked = spawnSync(
      'docker',
      ['run', '--rm', ...mounts, `haproxy:${version}`, 'haproxy', '-c', '-f', '/usr/local/etc/haproxy/haproxy.cfg'],
      { encoding: 'utf8' }
    );
    const output = `${checked.stdout}${checked.stderr}`.trim();
    check('haproxy -c nimmt die Konfiguration an', checked.status === 0, output.slice(-400));
    if (checked.status !== 0) return;
    // Die Warnung von HAProxy vor einer zu großen Seite. Andere Warnungen gehören
    // zur Testkonfiguration und nicht hierher.
    check('und warnt nicht vor der Größe einer Seite', !/payload|buffer space/i.test(output), output.slice(-400));

    docker(['run', '-d', '--name', name, '-p', `127.0.0.1:${PORT}:8080`, ...mounts, `haproxy:${version}`]);
    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Die Fassung mit dem Hinweis ist die größte der drei.
    const page = lockPages(design).find((entry) => entry.file === 'lock-wrong.html')!.html;
    const wrong = await call({ host: 'ganz.test', form: { [LOCK_FIELD]: 'falsch' } });
    check('die Passwortabfrage kommt mit 401, nicht mit 500', wrong.status === 401, `Status ${wrong.status}`);
    check('und vollständig, Byte für Byte', wrong.body === page, `${Buffer.byteLength(wrong.body)} Bytes`);

    const file = renderErrorFile(503, design);
    const down = await call({ host: 'aus.test' });
    check('die 503-Seite kommt mit ihrem Status', down.status === 503, `Status ${down.status}`);
    check(
      'und vollständig, Byte für Byte',
      down.body === file.slice(file.indexOf('\r\n\r\n') + 4),
      `${Buffer.byteLength(down.body)} Bytes`
    );
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
  for (const version of VERSIONS) {
    await verify(version);
    await verifyLargest(version, 'lock');
    await verifyLargest(version, 'error');
  }
  console.log(failures === 0 ? '\nAlles in Ordnung.' : `\n${failures} Prüfung(en) fehlgeschlagen.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
