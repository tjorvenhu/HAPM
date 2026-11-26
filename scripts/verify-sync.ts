/**
 * Den Abgleich zwischen Knoten gegen ein echtes HAProxy prüfen.
 *
 *   pnpm sync:verify
 *
 * Braucht Docker. Ein Skript und kein Test in `pnpm test`, aus demselben Grund
 * wie `verify-proxy-pages.ts`: ein Test, der sich ohne Docker still überspringt,
 * ist ein grüner Haken ohne Deckung.
 *
 * ── Was hier gezeigt wird und in `tests/sync/apply.test.ts` nicht ──
 *
 * Der Test rechnet den Tausch der Dateien nach, mit Attrappen für Prüfen und
 * Neuladen. Ob ein Folgeknoten danach wirklich den Stand des Hauptknotens
 * ausliefert, und ob er bei einem Stand, den HAProxy ablehnt, wirklich beim
 * alten bleibt, sagt nur HAProxy:
 *
 *  - Der Stand eines Hauptknotens entsteht wie im Betrieb (Grundkonfiguration,
 *    Gruppe, Ziel über `addService`), wird gepackt, ausgepackt und auf den
 *    Ordner eines laufenden HAProxy angewendet (`applyUnpacked`).
 *  - `haproxy -c` sieht nach dem Tausch die neuen Zertifikate und Fehlerseiten:
 *    die Datei nennt sie mit festen Pfaden.
 *  - Nach dem Neuladen über den Master-Socket antwortet HAProxy mit dem neuen
 *    Stand, und ein Zertifikat, das der Hauptknoten nicht mehr hat, zeigt es
 *    nicht mehr.
 *  - Lehnt `haproxy -c` den Stand ab, liegt danach Datei für Datei der alte da.
 *  - Nimmt `haproxy -c` ihn an, lädt HAProxy aber nicht neu (eine Adresse, die
 *    es auf dem Knoten nicht gibt), kommt der alte Stand zurück, und HAProxy
 *    liefert weiter aus.
 *  - Ohne CrowdSec auf dem Folgeknoten kommen die Zeilen heraus, und HAProxy
 *    nimmt die Datei so an.
 *
 * Wer `lib/sync/apply-core.ts`, `swap.ts`, `adapt.ts` oder die Ausschlussliste
 * in `bundle.ts` ändert, lässt dieses Skript laufen.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderBaseConfig } from '../lib/haproxy/base-config';
import {
  addScope,
  addService,
  crowdsecSpoeConfig,
  syncCrowdsecBackend,
  usesCrowdsec,
  type CreateServiceInput,
} from '../lib/haproxy/config';
import { applyUnpacked, type ApplyDeps, type ApplyResult } from '../lib/sync/apply-core';
import { collect, pack, unpack, type RootName } from '../lib/sync/bundle';

const PREFIX = process.env.HAPM_VERIFY_PREFIX || 'hapm-verify-sync';
const NAME = `${PREFIX}-haproxy`;
const PORT = 18643;
const MASTER_PORT = 18699;
const IMAGE = `haproxy:${process.argv[2] ?? 'lts'}`;
const STATUSES = [403, 404, 503];

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const quiet = (args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`${ok ? '  ok    ' : '  FEHLER'} ${label}${ok || !detail ? '' : `: ${detail}`}`);
}

function service(id: string, domain: string, crowdsec: boolean): CreateServiceInput {
  return {
    scope: 'WEB',
    id,
    domains: [domain],
    // Kein Ziel dahinter: HAProxy antwortet mit seiner Fehlerseite 503, und an ihr ist der Stand abzulesen.
    servers: [{ name: 'ziel', target: '127.0.0.1:9', weight: null }],
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
    app: null,
    healthcheck: false,
    backendTls: 'off',
  };
}

function baseConfig(): string {
  return renderBaseConfig({ ipv6: false, errorStatuses: STATUSES });
}

/** Die `haproxy.cfg` des Hauptknotens: ein Ziel, das CrowdSec benutzt. */
function primaryConfig(): string {
  const text = addService(addScope(baseConfig(), 'WEB'), service('shop', 'shop.example.org', true));
  return syncCrowdsecBackend(text, '127.0.0.1:7423');
}

function errorFile(status: number, node: string): string {
  return `HTTP/1.0 ${status} Fehler\r\nContent-Type: text/plain\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\nstand ${node} ${status}\n`;
}

/** Ein selbst signiertes Zertifikat samt Schlüssel, erzeugt in einem Container: so braucht der Rechner kein openssl. */
function certificate(dir: string, file: string, domain: string): void {
  docker([
    'run', '--rm', '-v', `${dir}:/out`, '--entrypoint', 'sh', 'alpine/openssl', '-c',
    `openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=${domain} -addext subjectAltName=DNS:${domain} ` +
      `-keyout /tmp/k -out /tmp/c && cat /tmp/c /tmp/k > /out/${file}`,
  ]);
}

function stageNode(base: string, node: 'a' | 'b'): Record<RootName, string> {
  const etc = join(base, node, 'etc');
  const acme = join(base, node, 'acme');
  for (const sub of ['certs', 'errors', 'hapm-crowdsec']) mkdirSync(join(etc, sub), { recursive: true });
  mkdirSync(acme, { recursive: true });
  for (const status of STATUSES) writeFileSync(join(etc, 'errors', `${status}.http`), errorFile(status, node));
  writeFileSync(join(etc, 'hapm-crowdsec', 'spoe.cfg'), crowdsecSpoeConfig());
  writeFileSync(join(etc, 'hapm-crowdsec', 'allow.lst'), node === 'a' ? '203.0.113.7\n' : '');
  if (node === 'a') {
    certificate(join(etc, 'certs'), 'shop.example.org.pem', 'shop.example.org');
    writeFileSync(join(etc, 'haproxy.cfg'), primaryConfig());
    writeFileSync(join(acme, 'account.conf'), "SAVED_CF_Token='nur-fuer-die-pruefung'\n");
    mkdirSync(join(acme, 'shop.example.org_ecc'));
    writeFileSync(join(acme, 'shop.example.org_ecc', 'shop.example.org.conf'), "Le_Domain='shop.example.org'\n");
  } else {
    // Der Folgeknoten, wie er nach der Installation dasteht: eigene Grundkonfiguration, eigenes Zertifikat.
    certificate(join(etc, 'certs'), 'alt.example.org.pem', 'alt.example.org');
    writeFileSync(join(etc, 'haproxy.cfg'), baseConfig());
    writeFileSync(join(etc, 'haproxy.cfg.backup-20261126-101500'), 'Sicherungskopie des Folgeknotens');
    writeFileSync(join(acme, 'account.conf'), '');
    writeFileSync(join(acme, 'acme.sh'), '#!/bin/sh\n# acme.sh des Folgeknotens\n');
  }
  return { haproxy: etc, acme };
}

/** Pfad → Prüfsumme für alles unter einem Ordner. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (relative: string) => {
    for (const name of readdirSync(join(dir, relative)).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      if (statSync(join(dir, rel)).isDirectory()) walk(rel);
      else out[rel] = createHash('sha256').update(readFileSync(join(dir, rel))).digest('hex');
    }
  };
  walk('');
  return out;
}

function same(a: Record<string, string>, b: Record<string, string>): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface Reply {
  status: number;
  text: string;
}

/** Eine Anfrage an den Folgeknoten. `status: 0` heißt: keine TLS-Verbindung (kein Zertifikat für den Namen). */
function get(host: string): Promise<Reply> {
  return new Promise((resolve) => {
    const req = request(
      { host: '127.0.0.1', port: PORT, path: '/', servername: host, rejectUnauthorized: false, headers: { host }, timeout: 10_000, agent: false },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      }
    );
    req.on('error', (err) => resolve({ status: 0, text: err.message }));
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.end();
  });
}

/** `reload` am Master-Socket, wie `bin/hapm-ctl.mjs` es tut, hier über TCP. */
function masterReload(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const socket = connect(MASTER_PORT, '127.0.0.1');
    let output = '';
    const timer = setTimeout(() => socket.destroy(new Error('Zeitüberschreitung am Master-Socket')), 60_000);
    socket.on('connect', () => socket.write('reload\n'));
    socket.on('data', (chunk) => (output += chunk.toString('utf8')));
    socket.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, detail: err.message });
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve({ ok: /Success=1/.test(output), detail: output.trim().slice(-600) });
    });
  });
}

function haproxyCheck(): Promise<{ ok: boolean; detail: string }> {
  const run = quiet(['exec', NAME, 'haproxy', '-c', '-f', '/etc/haproxy/haproxy.cfg']);
  return Promise.resolve({ ok: run.status === 0, detail: `${run.stdout}${run.stderr}`.trim().slice(-600) });
}

function cleanup(): void {
  quiet(['rm', '-f', '-v', NAME]);
}

async function waitForHaproxy(): Promise<boolean> {
  for (let i = 0; i < 30; i++) {
    const reply = await get('alt.example.org');
    if (reply.status > 0) return true;
    await sleep(1000);
  }
  return false;
}

async function main(): Promise<void> {
  try {
    docker(['version', '--format', '{{.Server.Version}}']);
  } catch {
    console.error('Docker ist nicht erreichbar. Dieses Skript startet HAProxy in einem Container.');
    process.exit(2);
  }
  cleanup();
  const base = mkdtempSync(join(tmpdir(), 'hapm-sync-'));
  console.log(`Arbeitsordner ${base}, Abbild ${IMAGE}`);

  try {
    const primary = stageNode(base, 'a');
    const replica = stageNode(base, 'b');

    // Der Folgeknoten: ein laufendes HAProxy auf seinem Ordner. Der Master-Socket
    // hier über TCP, weil ein eingebundener Ordner unter Docker Desktop keinen
    // Unix-Socket trägt. `/run/haproxy` (Stats-Socket) deshalb als tmpfs.
    docker([
      'run', '-d', '--name', NAME, '--user', 'root',
      '-p', `127.0.0.1:${PORT}:443`, '-p', `127.0.0.1:${MASTER_PORT}:9999`,
      '-v', `${replica.haproxy}:/etc/haproxy:ro`, '--tmpfs', '/run/haproxy',
      IMAGE, 'haproxy', '-f', '/etc/haproxy/haproxy.cfg', '-S', '0.0.0.0:9999',
    ]);
    if (!(await waitForHaproxy())) {
      check('HAProxy des Folgeknotens startet', false, quiet(['logs', '--tail', '20', NAME]).stderr.slice(-600));
      return;
    }

    const before = await get('alt.example.org');
    check('vor dem Abgleich liefert der Folgeknoten seinen eigenen Stand', before.status === 404 && before.text.includes('stand b'), `${before.status} ${before.text.trim()}`);
    check('und kennt das Zertifikat des Hauptknotens nicht', (await get('shop.example.org')).status === 0);

    const deps = (local: ApplyDeps['local']): ApplyDeps => ({ dirs: replica, local, check: haproxyCheck, reload: masterReload });
    const bundleOf = () => unpack(pack({ seq: Date.now(), sender: SENDER }, collect(primary)).bundle);
    const show = (result: ApplyResult) => result.steps.map((step) => `${step.ok ? 'ok' : 'FEHLER'} ${step.label}${step.detail ? ` (${step.detail})` : ''}`).join(' | ');

    console.log('\nDer erste Abgleich');
    const first = await applyUnpacked(bundleOf(), deps({ crowdsec: true, spoaAddress: '127.0.0.1:7423' }));
    check('der Stand des Hauptknotens wird übernommen', first.ok && first.changed, show(first));
    await sleep(1000);
    const after = await get('shop.example.org');
    check('HAProxy liefert mit dem Zertifikat und der Fehlerseite des Hauptknotens aus', after.status === 503 && after.text.includes('stand a'), `${after.status} ${after.text.trim()}`);
    check('das Zertifikat, das der Hauptknoten nicht hat, zeigt es nicht mehr', (await get('alt.example.org')).status === 0);
    const afterFirst = snapshot(replica.haproxy);
    check('die SPOE-Datei des Folgeknotens bleibt seine eigene', 'hapm-crowdsec/spoe.cfg' in afterFirst);
    check('seine Sicherungskopie bleibt liegen', 'haproxy.cfg.backup-20261126-101500' in afterFirst);
    check('die Freigaben kommen vom Hauptknoten', readFileSync(join(replica.haproxy, 'hapm-crowdsec', 'allow.lst'), 'utf8') === '203.0.113.7\n');
    check('acme.sh selbst bleibt das des Folgeknotens', readFileSync(join(replica.acme, 'acme.sh'), 'utf8').includes('des Folgeknotens'));
    check('Konto und Erneuerungseinträge von acme.sh sind da', 'shop.example.org_ecc/shop.example.org.conf' in snapshot(replica.acme));
    check('nichts vom Tausch bleibt liegen', !Object.keys(afterFirst).some((name) => name.startsWith('.hapm-sync')));

    console.log('\nDerselbe Stand noch einmal');
    const again = await applyUnpacked(bundleOf(), deps({ crowdsec: true, spoaAddress: '127.0.0.1:7423' }));
    check('wird erkannt, HAProxy lädt nicht neu', again.ok && !again.changed, show(again));

    console.log('\nEin Stand, den HAProxy ablehnt');
    const good = readFileSync(join(primary.haproxy, 'haproxy.cfg'), 'utf8');
    writeFileSync(join(primary.haproxy, 'haproxy.cfg'), `${good}\nfrontend kaputt\n    kein-schluesselwort-von-haproxy\n`);
    writeFileSync(join(primary.haproxy, 'errors', '503.http'), errorFile(503, 'kaputt'));
    const rejected = await applyUnpacked(bundleOf(), deps({ crowdsec: true, spoaAddress: '127.0.0.1:7423' }));
    check('wird nicht übernommen', !rejected.ok, show(rejected));
    check('die Meldung von HAProxy steht im Schritt', rejected.steps.some((step) => !step.ok && /kein-schluesselwort-von-haproxy/.test(step.detail ?? '')), show(rejected));
    check('danach liegt Datei für Datei der alte Stand da', same(snapshot(replica.haproxy), afterFirst));
    const stillA = await get('shop.example.org');
    check('und HAProxy liefert weiter den alten aus', stillA.status === 503 && stillA.text.includes('stand a'), `${stillA.status} ${stillA.text.trim()}`);

    console.log('\nEin Stand, den haproxy -c annimmt, mit dem HAProxy aber nicht neu lädt');
    // Eine Adresse, die es auf dem Knoten nicht gibt: die Prüfung bindet nicht, das Neuladen schon.
    writeFileSync(join(primary.haproxy, 'haproxy.cfg'), `${good}\nfrontend fremde_adresse\n    mode http\n    bind 192.0.2.77:8099\n`);
    const unloadable = await applyUnpacked(bundleOf(), deps({ crowdsec: true, spoaAddress: '127.0.0.1:7423' }));
    const reloadFailed = unloadable.steps.some((step) => step.label === 'HAProxy neu laden' && !step.ok);
    check('scheitert am Neuladen, nicht an der Prüfung', !unloadable.ok && reloadFailed, show(unloadable));
    check('der alte Stand ist zurück und wieder geladen', unloadable.steps.at(-1)?.ok === true && same(snapshot(replica.haproxy), afterFirst), show(unloadable));
    await sleep(1000);
    const survived = await get('shop.example.org');
    check('HAProxy liefert weiter aus', survived.status === 503 && survived.text.includes('stand a'), `${survived.status} ${survived.text.trim()}`);

    console.log('\nEin Folgeknoten ohne CrowdSec');
    writeFileSync(join(primary.haproxy, 'haproxy.cfg'), good);
    writeFileSync(join(primary.haproxy, 'errors', '503.http'), errorFile(503, 'a2'));
    const without = await applyUnpacked(bundleOf(), deps({ crowdsec: false, spoaAddress: '127.0.0.1:7423' }));
    check('übernimmt den Stand, HAProxy nimmt die Datei ohne die Zeilen an', without.ok && without.crowdsec === 'removed', show(without));
    const cfg = readFileSync(join(replica.haproxy, 'haproxy.cfg'), 'utf8');
    check('in seiner haproxy.cfg steht CrowdSec nicht mehr', !usesCrowdsec(cfg) && !cfg.includes('hapm_crowdsec_spoa'));
    check('das Ziel steht weiter darin', cfg.includes('backend shop'));
    await sleep(1000);
    const finalReply = await get('shop.example.org');
    check('und HAProxy liefert den neuen Stand aus', finalReply.status === 503 && finalReply.text.includes('stand a2'), `${finalReply.status} ${finalReply.text.trim()}`);
  } catch (err) {
    check('Durchlauf', false, err instanceof Error ? err.message : String(err));
  } finally {
    cleanup();
    rmSync(base, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAlles in Ordnung.' : `\n${failures} Prüfung(en) fehlgeschlagen.`);
  process.exit(failures === 0 ? 0 : 1);
}

const SENDER = { nodeId: 'a'.repeat(32), name: 'hauptknoten', hapmVersion: 'verify', haproxyVersion: null, exposure: 'public', usesCrowdsec: true };

void main();
