/**
 * DNS über RFC 2136 gegen ein echtes BIND prüfen.
 *
 *   pnpm dns:verify
 *
 * Braucht Docker. Aus demselben Grund ein Skript und kein Test wie
 * `pnpm haproxy:verify-tls`: es startet einen Nameserver im Container.
 *
 * ── Was hier gezeigt wird und in `tests/dns/` nicht ──
 *
 * Die Tests rechnen nach, welche Bytes hinausgehen und was HAPM aus einer
 * Antwort liest, gegen einen nachgestellten Nameserver. Ob ein echter
 * Nameserver die Unterschrift annimmt, die Vorbedingungen so auslegt und die
 * Antwort so unterschreibt, wie HAPM sie prüft, sagt nur der Nameserver:
 *
 *  - Die Zone zu einer Domain wird gefunden, eine fremde Domain nicht.
 *  - Ein falsches Geheimnis, ein unbekannter Schlüssel und ein Schlüssel ohne
 *    Freigabe ergeben je ihre eigene Meldung.
 *  - Anlegen, Lesen, Ändern und Entfernen von CNAME, A, AAAA und TXT.
 *  - Ein CNAME entsteht nicht neben anderen Daten, und nichts neben einem CNAME.
 *  - Ein Stern in der Zone (`*.wild`) gilt nicht als Eintrag des Namens.
 *
 * Der zweite Teil lässt den Hook von acme.sh (`dns_nsupdate`) mit genau den
 * Zeilen und der Schlüsseldatei arbeiten, die HAPM ablegt
 * (`lib/haproxy/dns-credentials.ts`): den TXT-Eintrag setzen und entfernen,
 * mit dem `nsupdate` aus dem Container.
 *
 * Der dritte Teil stellt ein Zertifikat aus und erneuert es: acme.sh in einem
 * Container wie dem von HAPM, Pebble als Zertifizierungsstelle, BIND als
 * Nameserver. Er zeigt, dass acme.sh mit der festen Wartezeit (`--dnssleep`)
 * nicht bei öffentlichen Resolvern nachfragt, dass die Erneuerung genauso
 * wartet, und dass eine eigene Zertifizierungsstelle über `TRUST_SYNC` bei
 * `curl` ankommt.
 *
 * Für Teil zwei und drei holt das Skript acme.sh von GitHub, für Teil drei
 * dazu Pakete von Debian. Ohne Netz dorthin entfallen sie und werden als
 * übersprungen gemeldet.
 *
 * Wer `lib/dns/dns-wire.ts`, `lib/dns/rfc2136.ts` oder die Zeilen für
 * `dns_nsupdate` ändert, lässt dieses Skript laufen.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packAccess, type Rfc2136Access } from '../lib/dns/access';
import { rfc2136 } from '../lib/dns/rfc2136';
import type { DnsRecord } from '../lib/dns/records';
import { challengeArgs, planChallenge } from '../lib/haproxy/challenge';
import {
  TRUST_DIR,
  TRUST_SYNC,
  credentialFiles,
  credentialLines,
  credentialNamesToClear,
  findDnsProvider,
  plainNamesToClear,
  writeCredentialFileCommand,
  writeCredentialsCommand,
  type DnsCredentialInput,
} from '../lib/haproxy/dns-credentials';
import { buildCommand } from '../lib/shell';

const IMAGE = process.env.HAPM_VERIFY_BIND_IMAGE ?? 'internetsystemsconsortium/bind9:9.20';
const PEBBLE_IMAGE = process.env.HAPM_VERIFY_PEBBLE_IMAGE ?? 'ghcr.io/letsencrypt/pebble:latest';
/** Dasselbe Abbild, auf dem HAPM läuft (`NODE_IMAGE` im Dockerfile). */
const CLIENT_IMAGE = process.env.HAPM_VERIFY_CLIENT_IMAGE ?? 'node:24-bookworm-slim';
const PREFIX = process.env.HAPM_VERIFY_PREFIX ?? 'hapm-dns-verify';
const NAME = `${PREFIX}-bind`;
const PEBBLE = `${PREFIX}-pebble`;
const CLIENT = `${PREFIX}-acme`;
const NETWORK = `${PREFIX}-net`;
const PORT = Number(process.env.HAPM_VERIFY_DNS_PORT ?? 15353);

const KEY_SECRET = 'c2VjcmV0LXNlY3JldC1zZWNyZXQtc2VjcmV0LTEyMzQ=';
const OTHER_SECRET = 'YW5vdGhlci1zZWNyZXQtYW5vdGhlci1zZWNyZXQtYW5vdGhlci1zZWNyZXQtMTIzNDU2Nzg5MA==';

const NAMED_CONF = `options {
  directory "/var/cache/bind";
  recursion no;
  listen-on { any; };
  listen-on-v6 { none; };
  allow-query { any; };
  dnssec-validation no;
};
key "hapm-key" { algorithm hmac-sha256; secret "${KEY_SECRET}"; };
key "other-key" { algorithm hmac-sha512; secret "${OTHER_SECRET}"; };
zone "example.test" { type primary; file "/var/lib/bind/example.test.zone"; allow-update { key "hapm-key"; }; };
zone "policy.test" { type primary; file "/var/lib/bind/policy.test.zone"; update-policy { grant other-key zonesub ANY; }; };
zone "closed.test" { type primary; file "/var/lib/bind/closed.test.zone"; };
`;

const zoneFile = (zone: string) => `$TTL 300
@ IN SOA ns1.${zone}. hostmaster.${zone}. ( 1 3600 600 86400 300 )
@ IN NS ns1.${zone}.
@ IN A 192.0.2.10
ns1 IN A 192.0.2.1
old IN A 192.0.2.20
old IN A 192.0.2.21
alias IN CNAME ${zone}.
note IN TXT "hallo welt"
*.wild IN CNAME ${zone}.
real.wild IN CNAME ${zone}.
`;

const access = (over: Partial<Rfc2136Access> = {}): string =>
  packAccess({
    server: '127.0.0.1',
    port: PORT,
    keyName: 'hapm-key',
    algorithm: 'hmac-sha256',
    secret: KEY_SECRET,
    ...over,
  });

const ZONE = { id: '127.0.0.1', name: 'example.test' };

let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok    ' : 'FEHLER'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const docker = (args: string[], input?: string) =>
  execFileSync('docker', args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });

/** Die Meldung, mit der ein Aufruf scheitert, oder `null`. */
async function failure(work: () => Promise<unknown>): Promise<string | null> {
  try {
    await work();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

const describe = (records: DnsRecord[]) =>
  records.map((record) => `${record.type} ${record.content}`).sort().join(' | ');

async function waitForBind(): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const zones = await rfc2136.listZones(access(), 'example.test');
      if (zones.length > 0) return;
    } catch {
      // Noch nicht bereit.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`BIND antwortet nicht auf 127.0.0.1:${PORT}.`);
}

async function provider(): Promise<void> {
  console.log('\nHAPM gegen BIND (lib/dns/rfc2136.ts)');

  const found = await rfc2136.listZones(access(), 'app.sub.example.test');
  check('die Zone zu einer Domain wird gefunden', found.length === 1 && found[0].name === 'example.test', JSON.stringify(found));
  const apex = await rfc2136.listZones(access(), 'example.test');
  check('auch für die Zone selbst und eine Wildcard', apex[0]?.name === 'example.test' && (await rfc2136.listZones(access(), '*.example.test'))[0]?.name === 'example.test');
  const foreign = await failure(() => rfc2136.listZones(access(), 'app.fremd.example'));
  check('eine Domain, die der Nameserver nicht führt, ergibt keine Zone', foreign === null && (await rfc2136.listZones(access(), 'app.fremd.example')).length === 0, foreign ?? '');

  const badSecret = await failure(() => rfc2136.listZones(access({ secret: OTHER_SECRET }), 'example.test'));
  check('ein falsches Geheimnis wird als solches gemeldet', /Geheimnis/.test(badSecret ?? ''), badSecret ?? 'kein Fehler');
  const badKey = await failure(() => rfc2136.listZones(access({ keyName: 'gibt-es-nicht' }), 'example.test'));
  check('ein unbekannter Schlüssel ebenso', /kennt keinen TSIG-Schlüssel/.test(badKey ?? ''), badKey ?? 'kein Fehler');
  const badAlgorithm = await failure(() => rfc2136.listZones(access({ algorithm: 'hmac-sha512' }), 'example.test'));
  check('und ein falsches Verfahren', badAlgorithm !== null, 'kein Fehler');
  const unreachable = await failure(() => rfc2136.listZones(access({ port: PORT + 1 }), 'example.test'));
  check('ein Nameserver, der nicht antwortet, ist „nicht erreichbar"', /nicht erreichbar|nicht rechtzeitig/.test(unreachable ?? ''), unreachable ?? 'kein Fehler');

  check('der Schlüssel darf die Zone ändern', (await failure(() => rfc2136.assertWritable!(access(), ZONE))) === null);
  const noGrant = await failure(() =>
    rfc2136.assertWritable!(access({ keyName: 'other-key', algorithm: 'hmac-sha512', secret: OTHER_SECRET }), ZONE)
  );
  check('ein Schlüssel ohne Freigabe (allow-update) wird abgelehnt', /nicht ändern/.test(noGrant ?? ''), noGrant ?? 'kein Fehler');
  const closed = await failure(() => rfc2136.assertWritable!(access(), { id: '', name: 'closed.test' }));
  check('eine Zone ohne Freigabe ebenso', /nicht ändern/.test(closed ?? ''), closed ?? 'kein Fehler');

  const read = async (...names: string[]) => rfc2136.listRecords(access(), ZONE, names);
  check('ein freier Name ist leer', (await read('app.example.test')).length === 0);
  check('zwei A-Einträge unter einem Namen', describe(await read('old.example.test')) === 'A 192.0.2.20 | A 192.0.2.21', describe(await read('old.example.test')));
  check('ein CNAME', describe(await read('alias.example.test')) === 'CNAME example.test', describe(await read('alias.example.test')));
  check('ein TXT-Eintrag', describe(await read('note.example.test')) === 'TXT hallo welt', describe(await read('note.example.test')));
  const viaStar = await read('irgendwas.wild.example.test');
  check('ein Stern in der Zone gilt nicht als Eintrag des Namens', viaStar.length === 0, describe(viaStar));
  const beside = await read('real.wild.example.test');
  check('ein echter Eintrag neben dem Stern wird trotzdem gelesen', describe(beside) === 'CNAME example.test', describe(beside));
  const star = await read('*.wild.example.test');
  check('der Stern selbst auch', describe(star) === 'CNAME example.test', describe(star));

  const cname = { type: 'CNAME', name: 'app.example.test', content: 'example.test', ttl: null, comment: 'HAPM' };
  const created = await rfc2136.createRecord(access(), ZONE, cname);
  check('CNAME anlegen', created.type === 'CNAME' && created.content === 'example.test' && created.ttl === 3600, JSON.stringify(created));
  check('und wieder lesen', describe(await read('app.example.test')) === 'CNAME example.test');
  const twice = await failure(() => rfc2136.createRecord(access(), ZONE, cname));
  check('ein zweiter CNAME unter dem Namen wird abgelehnt', /bereits ein Eintrag/.test(twice ?? ''), twice ?? 'kein Fehler');
  const overData = await failure(() => rfc2136.createRecord(access(), ZONE, { ...cname, name: 'old.example.test' }));
  check('ein CNAME neben A-Einträgen wird abgelehnt', /bereits ein Eintrag/.test(overData ?? ''), overData ?? 'kein Fehler');
  check('und die A-Einträge stehen noch', describe(await read('old.example.test')) === 'A 192.0.2.20 | A 192.0.2.21');
  const besideAlias = await failure(() =>
    rfc2136.createRecord(access(), ZONE, { type: 'A', name: 'alias.example.test', content: '192.0.2.99', ttl: null })
  );
  check('ein A-Eintrag neben einem CNAME wird abgelehnt', /CNAME-Eintrag/.test(besideAlias ?? ''), besideAlias ?? 'kein Fehler');

  await rfc2136.deleteRecord(access(), ZONE, created);
  check('CNAME entfernen', (await read('app.example.test')).length === 0);
  const again = await failure(() => rfc2136.deleteRecord(access(), ZONE, created));
  check('ein zweites Entfernen sagt „gibt es nicht (mehr)"', /nicht \(mehr\)/.test(again ?? ''), again ?? 'kein Fehler');

  const a = await rfc2136.createRecord(access(), ZONE, { type: 'A', name: 'host.example.test', content: '192.0.2.50', ttl: 120 });
  check('A anlegen mit eigener TTL', a.content === '192.0.2.50' && a.ttl === 120, JSON.stringify(a));
  const moved = await rfc2136.updateRecord(access(), ZONE, a, { type: 'A', name: 'host.example.test', content: '192.0.2.51', ttl: a.ttl });
  check('A ändern in einer Nachricht', moved.content === '192.0.2.51' && describe(await read('host.example.test')) === 'A 192.0.2.51', describe(await read('host.example.test')));
  const second = await rfc2136.createRecord(access(), ZONE, { type: 'A', name: 'host.example.test', content: '192.0.2.52', ttl: null });
  check('ein zweiter Wert übernimmt die TTL des Namens', second.ttl === 120, String(second.ttl));
  await rfc2136.deleteRecord(access(), ZONE, moved);
  check('ein Wert geht, der andere bleibt', describe(await read('host.example.test')) === 'A 192.0.2.52', describe(await read('host.example.test')));
  await rfc2136.deleteRecord(access(), ZONE, second);

  const v6 = await rfc2136.createRecord(access(), ZONE, { type: 'AAAA', name: 'host.example.test', content: '2001:0db8:0:0:0:0:0:1', ttl: null });
  check('AAAA anlegen, gelesen in kurzer Form', v6.content === '2001:db8::1', v6.content);
  await rfc2136.deleteRecord(access(), ZONE, v6);

  const long = 'x'.repeat(300);
  const txt = await rfc2136.createRecord(access(), ZONE, { type: 'TXT', name: '_probe.example.test', content: long, ttl: null });
  check('ein TXT über 255 Zeichen kommt ganz zurück', txt.content === long, `${txt.content.length} Zeichen`);
  await rfc2136.deleteRecord(access(), ZONE, txt);

  const wild = await rfc2136.createRecord(access(), ZONE, { type: 'CNAME', name: '*.svc.example.test', content: 'example.test', ttl: null });
  check('ein Stern als Name lässt sich anlegen und entfernen', wild.name === '*.svc.example.test');
  await rfc2136.deleteRecord(access(), ZONE, wild);

  const policy = access({ keyName: 'other-key', algorithm: 'hmac-sha512', secret: OTHER_SECRET });
  const policyZone = { id: '', name: 'policy.test' };
  check('update-policy und HMAC-SHA512: die Zone ist änderbar', (await failure(() => rfc2136.assertWritable!(policy, policyZone))) === null);
  const viaPolicy = await rfc2136.createRecord(policy, policyZone, { type: 'CNAME', name: 'app.policy.test', content: 'policy.test', ttl: null });
  check('und ein Eintrag entsteht', viaPolicy.content === 'policy.test');
  await rfc2136.deleteRecord(policy, policyZone, viaPolicy);
  const denied = await failure(() =>
    rfc2136.createRecord(access(), policyZone, { type: 'CNAME', name: 'app.policy.test', content: 'policy.test', ttl: null })
  );
  check('ein Schlüssel, den die update-policy nicht nennt, wird abgelehnt', /nicht ändern/.test(denied ?? ''), denied ?? 'kein Fehler');
}

/** Führt ein Skript in einem Container aus, die Eingabe über stdin, wie `withStdin` es tut. */
function inContainer(script: string, input = '', container = NAME): { ok: boolean; output: string } {
  const run = spawnSync('docker', ['exec', '-i', container, 'sh', '-c', script], {
    encoding: 'utf8',
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}`.trim() };
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

/** acme.sh und sein Hook für RFC 2136, wie das Abbild sie mitbringt (`ACME_VERSION=master`). */
async function fetchAcme(dir: string): Promise<boolean> {
  const base = 'https://raw.githubusercontent.com/acmesh-official/acme.sh/master';
  try {
    const [acme, hook] = await Promise.all([fetchText(`${base}/acme.sh`), fetchText(`${base}/dnsapi/dns_nsupdate.sh`)]);
    mkdirSync(join(dir, 'acme', 'dnsapi'), { recursive: true });
    writeFileSync(join(dir, 'acme', 'acme.sh'), acme, { mode: 0o755 });
    writeFileSync(join(dir, 'acme', 'dnsapi', 'dns_nsupdate.sh'), hook);
    return true;
  } catch (err) {
    console.log(`\nacme.sh ließ sich nicht holen (${err instanceof Error ? err.message : String(err)}).`);
    console.log('  übersprungen: der Hook dns_nsupdate und das Ausstellen eines Zertifikats.');
    return false;
  }
}

/** Wie `lib/acme.ts` es hinterlässt: ein Ordner mit `account.conf` und den Hooks. */
function installAcme(dir: string, container: string): { ok: boolean; output: string } {
  docker(['cp', join(dir, 'acme'), `${container}:/opt/acme.sh`]);
  return inContainer(
    'mkdir -p /root/.acme.sh && cp -r /opt/acme.sh/dnsapi /root/.acme.sh/ && cp /opt/acme.sh/acme.sh /root/.acme.sh/ && ' +
      "chmod +x /root/.acme.sh/acme.sh && printf \"ACCOUNT_EMAIL='ops@example.test'\\n\" > /root/.acme.sh/account.conf && " +
      'chmod 600 /root/.acme.sh/account.conf',
    '',
    container
  );
}

/** Die Zugangsdaten so ablegen, wie `writeDnsCredentials` es tut: erst die Dateien, dann die Zeilen. */
function putCredentials(input: DnsCredentialInput, container: string): void {
  const provider = findDnsProvider(input.hook)!;
  for (const file of credentialFiles(input)) {
    const written = inContainer(writeCredentialFileCommand(file.path), file.content ?? '', container);
    check(`HAPM legt ${file.path} ab`, written.ok, written.output);
  }
  const lines = inContainer(
    writeCredentialsCommand(credentialNamesToClear(provider, false), plainNamesToClear(provider)),
    `${credentialLines(input).join('\n')}\n`,
    container
  );
  check('und die Zeilen in account.conf', lines.ok, lines.output);
}

const nsupdateInput = (server: string): DnsCredentialInput => ({
  hook: 'dns_nsupdate',
  values: {
    NSUPDATE_SERVER: server,
    NSUPDATE_SERVER_PORT: '',
    TSIG_NAME: 'hapm-key',
    TSIG_ALGORITHM: '',
    TSIG_SECRET: KEY_SECRET,
  },
  remove: false,
});

function acmeHook(dir: string): Promise<void> {
  console.log('\nacme.sh gegen BIND (dns_nsupdate mit den Zeilen von HAPM)');
  const prepared = installAcme(dir, NAME);
  check('acme.sh liegt im Container', prepared.ok, prepared.output);

  const input = nsupdateInput('127.0.0.1');
  const nsupdate = findDnsProvider(input.hook)!;
  putCredentials(input, NAME);
  const mode = inContainer('stat -c %a /root/.acme.sh/hapm-nsupdate.key');
  check('die Schlüsseldatei ist nur für root lesbar', mode.output === '600', mode.output);

  // acme.sh endet mit `main "$@"`: ohne Argumente zeigt es die Hilfe und
  // lässt seine Funktionen stehen. Danach liest `_initpath` account.conf.
  const harness = (call: string) =>
    `export LE_WORKING_DIR=/root/.acme.sh; . /root/.acme.sh/acme.sh >/dev/null 2>&1; _initpath; . /root/.acme.sh/dnsapi/dns_nsupdate.sh; ${call}`;
  const name = '_acme-challenge.app.example.test';
  return (async () => {
    const added = inContainer(harness(`dns_nsupdate_add ${name} hapm-verify-token`));
    check('der Hook setzt den TXT-Eintrag', added.ok, added.output.slice(-300));
    const seen = await rfc2136.listRecords(access(), ZONE, [name]);
    check('und er steht in der Zone', describe(seen) === 'TXT hapm-verify-token', describe(seen));
    const removed = inContainer(harness(`dns_nsupdate_rm ${name}`));
    check('der Hook entfernt ihn wieder', removed.ok && (await rfc2136.listRecords(access(), ZONE, [name])).length === 0, removed.output.slice(-300));
    const saved = inContainer("grep -c '^SAVED_NSUPDATE_KEY=' /root/.acme.sh/account.conf");
    check('acme.sh behält den Pfad der Schlüsseldatei für die Erneuerung', saved.output === '1', saved.output);

    const gone = inContainer(writeCredentialsCommand(credentialNamesToClear(nsupdate, true), plainNamesToClear(nsupdate)), '');
    const left = inContainer("grep -c 'NSUPDATE' /root/.acme.sh/account.conf");
    check('beim Entfernen bleibt keine Zeile des Hooks zurück', gone.ok && left.output === '0', `${gone.output} ${left.output}`);
  })();
}

/**
 * Ein Zertifikat ausstellen und erneuern, mit allem, was HAPM dafür ablegt:
 * acme.sh in einem Container wie dem von HAPM (Debian, `curl`, `nsupdate`),
 * Pebble als Zertifizierungsstelle, die den TXT-Eintrag beim BIND nachfragt.
 *
 * Gezeigt wird, was sonst erst auf einem Server auffiele: dass acme.sh mit
 * `--dnssleep` nicht bei öffentlichen Resolvern nach `example.test` fragt (das
 * liefe 20 Minuten in den Abbruch), dass die Erneuerung genauso wartet, und
 * dass eine eigene Zertifizierungsstelle über `TRUST_SYNC` bei `curl` ankommt:
 * Pebble ist hier die „Appliance mit eigener CA".
 */
async function issue(dir: string): Promise<void> {
  console.log('\nZertifikat über DNS-01 ausstellen und erneuern (acme.sh, Pebble, BIND)');
  const ACME = '/root/.acme.sh/acme.sh';
  const DIRECTORY = 'https://pebble:14000/dir';

  try {
    const bindIp = docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${NETWORK}").IPAddress}}`, NAME]).trim();
    docker([
      'run', '-d', '--name', PEBBLE, '--network', NETWORK, '--network-alias', 'pebble',
      '-e', 'PEBBLE_VA_NOSLEEP=1', '-e', 'PEBBLE_WFE_NONCEREJECT=0', '-e', 'PEBBLE_AUTHZREUSE=0',
      PEBBLE_IMAGE, '-config', '/test/config/pebble-config.json', '-dnsserver', `${bindIp}:53`,
    ]);
    docker(['run', '-d', '--name', CLIENT, '--network', NETWORK, CLIENT_IMAGE, 'sleep', '3600']);
  } catch (err) {
    console.log(`  übersprungen: die Container ließen sich nicht starten (${err instanceof Error ? err.message.split('\n')[0] : String(err)}).`);
    return;
  }

  // Dieselben Pakete wie im `runner` des Dockerfile, soweit acme.sh sie braucht.
  const packages = inContainer(
    'apt-get update -qq >/dev/null 2>&1 && apt-get install -y --no-install-recommends ca-certificates curl openssl bind9-dnsutils >/dev/null 2>&1',
    '',
    CLIENT
  );
  if (!packages.ok) {
    console.log('  übersprungen: die Pakete ließen sich nicht installieren (kein Netz zu den Paketquellen?).');
    return;
  }
  check('nsupdate liegt im Container (bind9-dnsutils)', inContainer('command -v nsupdate', '', CLIENT).ok);
  const prepared = installAcme(dir, CLIENT);
  check('acme.sh liegt im Container', prepared.ok, prepared.output);

  // Die Zertifizierungsstelle von Pebble ist keine öffentliche.
  const untrusted = inContainer(`curl -fsS ${DIRECTORY} >/dev/null`, '', CLIENT);
  check('ohne hinterlegte Stelle lehnt curl den ACME-Server ab', !untrusted.ok, untrusted.output.slice(-200));
  // Das Abbild von Pebble hat keine Shell: die Datei wird herauskopiert.
  docker(['cp', `${PEBBLE}:/test/certs/pebble.minica.pem`, join(dir, 'minica.pem')]);
  const minica = readFileSync(join(dir, 'minica.pem'), 'utf8');
  const stored = inContainer(writeCredentialFileCommand(`${TRUST_DIR}/pebble.pem`), minica, CLIENT);
  const synced = inContainer(TRUST_SYNC, '', CLIENT);
  check('HAPM legt die Stelle ab und in den Bestand des Containers', stored.ok && synced.ok, `${stored.output} ${synced.output}`);
  const trusted = inContainer(`curl -fsS ${DIRECTORY} >/dev/null`, '', CLIENT);
  check('danach vertraut curl ihr', trusted.ok, trusted.output.slice(-200));

  putCredentials(nsupdateInput('bind'), CLIENT);

  const domains = ['app.example.test', '*.example.test'];
  const plan = planChallenge(
    domains,
    { exposure: 'internal', dnsHook: null, source: 'acme', acmeServer: DIRECTORY, httpReachable: false, dnsWait: 5 },
    ['dns_nsupdate']
  );
  const args = challengeArgs(plan, '8888');
  check('die Regel gibt acme.sh die feste Wartezeit mit', args.join(' ') === '--dns dns_nsupdate --dnssleep 5', args.join(' '));

  const issued = inContainer(
    `${buildCommand([ACME, '--home', '/root/.acme.sh', '--issue', '--server', DIRECTORY, ...domains.flatMap((domain) => ['-d', domain]), ...args])} 2>&1`,
    '',
    CLIENT
  );
  check('acme.sh stellt Domain und Wildcard aus', issued.ok, issued.output.slice(-600));
  check('und wartet, statt öffentliche Resolver zu fragen', /Sleeping for .*5.* seconds/.test(issued.output) && !/check each DNS record/.test(issued.output));
  check('das Zertifikat liegt da', inContainer('test -s /root/.acme.sh/app.example.test_ecc/fullchain.cer', '', CLIENT).ok);

  const kept = inContainer("grep '^Le_DNSSleep=' /root/.acme.sh/app.example.test_ecc/app.example.test.conf", '', CLIENT);
  check('acme.sh merkt sich die Wartezeit am Zertifikat', kept.output === "Le_DNSSleep='5'", kept.output);

  const renewed = inContainer(
    `${buildCommand([ACME, '--home', '/root/.acme.sh', '--renew', '-d', 'app.example.test', '--ecc', '--force'])} 2>&1`,
    '',
    CLIENT
  );
  check('die Erneuerung läuft mit den abgelegten Zugangsdaten', renewed.ok, renewed.output.slice(-600));
  check('und wartet genauso', /Sleeping for .*5.* seconds/.test(renewed.output) && !/check each DNS record/.test(renewed.output));

  const leftover = await rfc2136.listRecords(access(), ZONE, ['_acme-challenge.app.example.test', '_acme-challenge.example.test']);
  check('die TXT-Einträge der Challenge sind wieder weg', leftover.length === 0, describe(leftover));
}

function remove(...names: string[]): void {
  for (const name of names) {
    try {
      docker(['rm', '-f', name]);
    } catch {
      // Es gab keinen.
    }
  }
}

async function main(): Promise<void> {
  try {
    docker(['version', '--format', '{{.Server.Version}}']);
  } catch {
    console.error('Docker ist nicht erreichbar. Dieses Skript startet BIND in einem Container.');
    process.exit(2);
  }

  const dir = mkdtempSync(join(tmpdir(), 'hapm-dns-'));
  remove(NAME, PEBBLE, CLIENT);
  try {
    docker(['network', 'rm', NETWORK]);
  } catch {
    // Es gab keins.
  }

  try {
    mkdirSync(join(dir, 'etc'));
    mkdirSync(join(dir, 'zones'));
    writeFileSync(join(dir, 'etc', 'named.conf'), NAMED_CONF);
    for (const zone of ['example.test', 'policy.test', 'closed.test']) {
      writeFileSync(join(dir, 'zones', `${zone}.zone`), zoneFile(zone));
    }
    docker(['network', 'create', NETWORK]);
    // Erst anlegen, dann die Dateien hineinkopieren: ein eingebundener Ordner
    // des Rechners gehört unter Docker Desktop nicht dem Benutzer von BIND,
    // und der schreibt neben die Zonendatei sein Journal.
    docker([
      'create', '--name', NAME, '--network', NETWORK, '--network-alias', 'bind',
      '-p', `127.0.0.1:${PORT}:53/tcp`, '-p', `127.0.0.1:${PORT}:53/udp`, IMAGE,
    ]);
    docker(['cp', join(dir, 'etc', 'named.conf'), `${NAME}:/etc/bind/named.conf`]);
    docker(['cp', `${join(dir, 'zones')}/.`, `${NAME}:/var/lib/bind/`]);
    docker(['start', NAME]);
    docker(['exec', '-u', 'root', NAME, 'sh', '-c', 'chown -R bind:bind /var/lib/bind 2>/dev/null || chown -R named:named /var/lib/bind']);
    await waitForBind();

    await provider();
    if (await fetchAcme(dir)) {
      await acmeHook(dir);
      await issue(dir);
    }
  } catch (err) {
    check('Durchlauf', false, err instanceof Error ? err.message : String(err));
    try {
      console.log(docker(['logs', '--tail', '30', NAME]));
    } catch {
      // Kein Container, kein Log.
    }
  } finally {
    remove(NAME, PEBBLE, CLIENT);
    try {
      docker(['network', 'rm', NETWORK]);
    } catch {
      // Schon weg.
    }
    rmSync(dir, { recursive: true, force: true });
  }

  console.log(failures === 0 ? '\nAlles in Ordnung.' : `\n${failures} Prüfung(en) fehlgeschlagen.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
