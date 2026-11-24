/**
 * Der Vorgang um `lib/haproxy/config.ts` herum: Zertifikat, Prüfen, Reload,
 * Rollback — als Kommandos gegen das HAProxy im selben Stack.
 *
 * ── Die Reihenfolge ist der Inhalt ──
 *
 * Ein Reverse-Proxy-Eintrag besteht aus mehr als der Konfigurationszeile: ohne
 * Zertifikat scheitert `haproxy -c`, ohne Prüfung vor dem Einsetzen steht eine
 * kaputte Datei auf der Maschine, und ohne Reload gilt weiter die alte. Deshalb
 * in dieser Reihenfolge:
 *
 *   1. lesen und rechnen (die neue Datei entsteht hier im Prozess, nicht dort)
 *   2. Zertifikat ausstellen und nach `/etc/haproxy/certs` ausrollen
 *   3. die neue Datei **neben** die alte legen und mit `haproxy -c` prüfen
 *   4. erst dann Backup ziehen und einsetzen
 *   5. reloaden, und bei einem Fehlschlag das Backup zurückspielen
 *
 * Schritt 3 vor Schritt 4 ist der Kern: wer erst schreibt und danach prüft, hat
 * ein Zeitfenster mit einer ungültigen Konfiguration und einen Rollback-Pfad,
 * der selbst scheitern kann. Geprüft wird hier, solange die gültige Datei noch
 * unangetastet ist.
 *
 * ── Zwei Schreiber auf dieselbe Datei ──
 *
 * HAPM liest die Konfiguration, rechnet, schreibt sie zurück. Wer in
 * dieser Zeitspanne von Hand editiert, verlöre seine Änderung. Dagegen zwei
 * Riegel: ein Lock im Prozess (HAPM läuft als genau eine Instanz)
 * gegen HAPM selbst, und ein Prüfsummenvergleich unmittelbar vor dem
 * Einsetzen gegen alle anderen. Der zweite ist der wichtigere — er kann einen
 * Mensch mit einem `vim` nicht verhindern, aber er weigert sich, ihn zu
 * überschreiben.
 */

import { createHash } from 'node:crypto';
import { sshExec } from '../ssh';
import { acmeServer } from '../acme';
import { getSSHConfig, getServer } from '../helpers';
import { buildCommand, withEnv, withStdin, batchCommands, splitSections, shellEscape } from '../shell';
import { ApiError } from '../api';
import {
  HAPROXY_CFG,
  HAPROXY_CERT_DIR,
  addService,
  removeService,
  replaceService,
  certificateChanged,
  parseHaproxyConfig,
  parseHaproxyVersion,
  parseGlobalSettings,
  applyGlobalSettings,
  addScope,
  removeScope,
  parseStatsSocket,
  parseStatsCsv,
  type CreateServiceInput,
  type HaproxyService,
  type BackendServerState,
  isValidDomain,
  usesLockPages,
  supportsPasswordLock,
  LOCK_PAGE_DIR,
  INHERIT_LOCK,
  type GlobalSettings,
  type GlobalSettingsInput,
} from './config';
import { lockPages, lockPageDigestCommand, lockPageWriteCommand } from './lock-page';
import {
  parseErrorFiles,
  isManageableErrorFile,
  planErrorPages,
  writableErrorPages,
  renderErrorFile,
  parseFirstLines,
  parseDigests,
  errorPageFirstLinesCommand,
  errorPageDigestCommand,
  errorPageWriteCommand,
  errorPageRestoreCommand,
  type ErrorPageEntry,
} from './error-pages';
import {
  addStream,
  removeStream,
  replaceStream,
  parseStreams,
  parseBindPorts,
  parseListeningPorts,
  bindConflict,
  type CreateStreamInput,
  type HaproxyStream,
} from './streams';
import {
  parseAcmeList,
  parseDnsHooks,
  findCertificateFor,
  certCovers,
  pemFileName,
  type AcmeCertificate,
} from './certs';
import {
  findDnsProvider,
  credentialLines,
  credentialNamesToClear,
  writeCredentialsCommand,
  validateDnsCredentials,
  type DnsCredentialInput,
} from './dns-credentials';
import {
  planChallenge,
  challengeArgs,
  type ChallengeChoice,
  type ChallengePlan,
} from './challenge';
import type { Server, HaproxyPhase } from '../types';

/**
 * HAProxy neu laden. Das Kommando kommt aus `bin/hapm-ctl.mjs`: es lädt über
 * den Master-Socket neu und meldet, ob der neue Prozess steht.
 */
const RELOAD_ARGV = ['hapm-reload'];

/** acme.sh, wie `lib/acme.ts` es einrichtet. */
const ACME = '/root/.acme.sh/acme.sh';
const ACME_HOME = '/root/.acme.sh';
/**
 * Der Port, auf dem acme.sh im Standalone-Modus die HTTP-01-Anfrage entgegen
 * nimmt. Nicht 80: dort steht HAProxy, und es leitet die Challenge hierher
 * weiter. Ein anderer Port hieße, die Weiterleitung im Frontend mit zu ändern.
 */
const ACME_PORT = '8888';

/**
 * Welche DNS-Hooks auf der Maschine eingerichtet sind — abgeleitet, nicht
 * hinterlegt.
 *
 * HTTP-01 kann keine Wildcard ausstellen, das lässt Let's Encrypt nicht zu. Für
 * `*.kunde.example` braucht es DNS-01, und dafür braucht acme.sh Zugangsdaten zur
 * Zone. Die bleiben auf der Maschine: acme.sh legt sie beim ersten Gebrauch als
 * `SAVED_*` in `account.conf` ab und schreibt sie in die Erneuerungs-
 * konfiguration der Domain — die automatische Erneuerung braucht danach keine
 * Eingabe mehr, genau wie beim Deploy-Hook. Dieselben Zugangsdaten zusätzlich
 * hier zu halten hieße zwei Quellen für ein Geheimnis, von denen nur eine zählt.
 *
 * Ermittelt wird der Hook über seine eigene Variable: für jeden `SAVED_*`-Namen
 * in `account.conf` wird die `dnsapi/dns_*.sh` gesucht, die ihn liest. Damit
 * steht in diesem Code kein einziger Anbietername.
 *
 * Exportiert für `tests/haproxy/dns-credentials.test.ts`: dort rechnet eine
 * echte Bash nach, dass geschriebene Zugangsdaten auch erkannt werden.
 */
export const DNS_HOOK_PROBE = [
  'conf=/root/.acme.sh/account.conf; dir=/root/.acme.sh/dnsapi',
  'if [ -r "$conf" ] && [ -d "$dir" ]; then',
  '  sed -n "s/^SAVED_\\([A-Za-z0-9_]*\\)=.*/\\1/p" "$conf" | sort -u | while read -r v; do',
  '    [ -n "$v" ] || continue',
  '    grep -lE "(^|[^A-Za-z0-9_])$v([^A-Za-z0-9_]|$)" "$dir"/dns_*.sh 2>/dev/null',
  '  done | sort -u',
  'fi',
].join('\n');

/**
 * Die neue Konfiguration liegt bis zur Prüfung daneben, nicht in `/tmp`:
 * `/etc/haproxy` gehört root, und eine vorhersagbare Datei in einem Verzeichnis,
 * in das sonst niemand schreiben darf, ist kein Angriffsweg. In `/tmp` wäre
 * derselbe feste Name einer.
 */
const STAGING_CFG = `${HAPROXY_CFG}.hapm-new`;

/**
 * Wie viele `haproxy.cfg.backup-*` auf der Maschine stehen bleiben.
 *
 * Jeder Schreibvorgang legt eins an, und sonst räumt sie niemand weg:
 * ein Proxy mit vierzig Diensten sammelt über die Jahre Dutzende Kopien
 * derselben Datei in `/etc/haproxy` — kein Platzproblem (ein paar Kilobyte),
 * aber ein Verzeichnis, in dem man die eine gültige Datei suchen muss. Zehn
 * decken jeden Fall ab, in dem man ein Backup wirklich braucht: der ist immer
 * „der Vorgang gerade eben", und dafür gibt es das Rollback ohnehin schon.
 *
 * Aufgeräumt wird NACH dem erfolgreichen Reload und best effort. Vorher wäre es
 * eine Handlung an Dateien, die man im selben Vorgang noch zurückspielen können
 * muss.
 */
const BACKUP_KEEP = 10;

const SHORT_MS = 30_000;
const RELOAD_MS = 60_000;
/**
 * Ausstellung und Auslieferung eines Zertifikats. Eine Anfrage an
 * Let's Encrypt samt Challenge kann Minuten dauern.
 */
const ACME_MS = 300_000;

/* ── Ein Schreiber zur selben Zeit ──
 *
 * Eine Promise-Kette je Schlüssel im Prozess. Zwei gleichzeitige
 * Anlegevorgänge lesen sonst dieselbe Datei und schreiben nacheinander zurück —
 * der zweite Dienst wäre angelegt, der erste spurlos weg. */

interface LockState {
  chains: Map<string, Promise<void>>;
}

const g = globalThis as typeof globalThis & { __hapm_haproxy_locks?: LockState };
if (!g.__hapm_haproxy_locks) g.__hapm_haproxy_locks = { chains: new Map() };
const locks = g.__hapm_haproxy_locks;

async function withProxyLock<T>(serverId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.chains.get(serverId) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.chains.set(serverId, previous.then(() => held));
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

/* ── Server auflösen ── */

export async function getProxyServer(serverId: string): Promise<Server> {
  const server = await getServer(serverId);
  if (!server.roleReverseProxy) {
    throw new ApiError(`Server "${server.name}" hat die Rolle "Reverse-Proxy" nicht.`);
  }
  return server;
}

/* ── Lesen ── */

export interface ProxyProbe {
  /** Die Version aus `haproxy -v`, nicht die ganze Zeile. `null` heißt unbekannt,
   *  nicht „nicht installiert". */
  version: string | null;
  /** SHA-256 der Konfiguration, für den Vergleich unmittelbar vor dem Schreiben. */
  digest: string | null;
  services: HaproxyService[];
  /** Die TCP-Weiterleitungen derselben Datei. Aus demselben `cat` gelesen wie
   *  die Dienste: eine zweite Runde für eine Frage, die die erste schon
   *  bezahlt hat, wäre verschenkt. */
  streams: HaproxyStream[];
  /** Was HAProxy über seine Backend-Server weiß. Leer heißt: kein Stats-Socket
   *  in der Konfiguration, kein `socat` auf der Maschine, oder kein Server mit
   *  Healthcheck — in allen drei Fällen ist der Zustand unbekannt. */
  serverStates: BackendServerState[];
  /** Ohne acme.sh lässt sich kein Zertifikat ausstellen — dann gibt es kein Anlegen. */
  acmeReady: boolean;
  /** Die eingerichteten DNS-Hooks. Leer heißt: keine Wildcard ausstellbar, denn
   *  HTTP-01 kann sie nicht. Siehe `DNS_HOOK_PROBE`. */
  dnsHooks: string[];
  configReadable: boolean;
  raw: string;
}

const PROBE = [
  'haproxy -v 2>/dev/null | head -1',
  `test -x ${shellEscape(ACME)} && test -d ${shellEscape(HAPROXY_CERT_DIR)} && echo ja`,
  `sha256sum ${shellEscape(HAPROXY_CFG)} 2>/dev/null | cut -d' ' -f1`,
  DNS_HOOK_PROBE,
  // Zuletzt, weil es das längste ist: die Trennmarke steht danach, nicht mittendrin.
  `cat ${shellEscape(HAPROXY_CFG)} 2>/dev/null`,
];

/**
 * Die Zertifikate der Maschine. Eine eigene Runde und nicht im Standard-Probe:
 * `acme.sh --list` läuft über jedes Domainverzeichnis, und die Übersicht pollt
 * im Minutentakt. Gebraucht wird die Liste an genau zwei Stellen — auf
 * der Zertifikatsseite und innerhalb des Locks eines Vorgangs.
 */
async function probeCertificates(
  ssh: Awaited<ReturnType<typeof getSSHConfig>>
): Promise<AcmeCertificate[]> {
  const res = await sshExec(
    ssh,
    `${buildCommand([ACME, '--list', '--listraw'])} 2>/dev/null || true`,
    SHORT_MS
  ).catch(() => null);
  return res ? parseAcmeList(res.stdout) : [];
}

/** Die Zertifikate einer Maschine für die Anzeige. */
export async function readCertificates(server: Server): Promise<AcmeCertificate[]> {
  return probeCertificates(await getSSHConfig(server));
}

/**
 * Worauf die Maschine gerade lauscht.
 *
 * Eine eigene Runde und nicht im Standard-Probe: gebraucht wird sie allein für
 * die TCP-Weiterleitungen, und die Übersicht pollt im Minutentakt.
 *
 * Der Grund, warum es sie überhaupt gibt: `haproxy -c` bindet keine Sockets.
 * Ein Port, den auf der Maschine schon ein anderer Dienst oder ein
 * Docker-Mapping hält, kommt deshalb durch die Prüfung und scheitert erst beim
 * Reload — also in dem Moment, in dem die Konfiguration bereits eingesetzt ist.
 *
 * `null` heißt unbekannt: fehlt `ss`, wird nichts behauptet, und der Vorgang
 * läuft mit der Prüfung weiter, die die Datei allein hergibt.
 */
async function probeListeningPorts(
  ssh: Awaited<ReturnType<typeof getSSHConfig>>
): Promise<number[] | null> {
  const res = await sshExec(ssh, `${buildCommand(['ss', '-Hltn'])} 2>/dev/null || true`, SHORT_MS)
    .catch(() => null);
  return res ? parseListeningPorts(res.stdout) : null;
}

/**
 * Ob der Port auf der Maschine von etwas gehalten wird, das nicht HAProxy ist.
 *
 * Die eigenen `bind`-Zeilen werden abgezogen: HAProxy lauscht selbst auf 443,
 * und beim Ändern einer Weiterleitung, die ihren Port behält, wäre er sonst
 * ein Konflikt mit sich selbst.
 */
async function assertPortFree(
  ssh: Awaited<ReturnType<typeof getSSHConfig>>,
  config: string,
  port: number,
  serverName: string
): Promise<void> {
  const listening = await probeListeningPorts(ssh);
  if (listening === null || !listening.includes(port)) return;
  if (parseBindPorts(config).some((b) => b.port === port)) return;

  throw new ApiError(
    `Auf diesem Server ("${serverName}") lauscht bereits ein anderer Dienst auf Port ${port}. ` +
      'HAProxy könnte ihn beim Neuladen nicht binden, und das fällt der Konfigurationsprüfung nicht auf.'
  );
}

/**
 * Die DNS-Zugangsdaten auf der Maschine setzen oder entfernen.
 *
 * Synchron und ohne Lauf-Zeile, anders als jeder Vorgang an `haproxy.cfg`: das
 * hier fasst HAProxy nicht an, es gibt keinen Reload, kein Backup und nichts
 * zurückzurollen — ein Kommando, das in einer Sekunde durch ist. Ein
 * abgekoppelter Lauf dafür wäre eine Pille unten rechts für einen Vorgang, der
 * schon fertig ist, bevor sie erscheint.
 *
 * Der Lock läuft trotzdem mit. Nicht wegen HAProxy, sondern wegen der Datei:
 * zwei gleichzeitige Speichervorgänge auf dieselbe `account.conf` lesen beide
 * den alten Stand.
 *
 * ── Der Rückabgleich ist nicht optional ──
 *
 * Zurückgegeben wird, was die Maschine danach über ihre Hooks sagt, und nicht,
 * was gerade geschickt wurde. Ein Token, der ankommt, aber unter einem Namen
 * steht, den kein Hook liest, wäre sonst ein grüner Haken ohne Deckung — und
 * auffallen würde er erst beim ersten Wildcard-Antrag. Dieselbe Regel wie bei
 * `ensureDatabase()`.
 */
export async function writeDnsCredentials(
  server: Server,
  input: DnsCredentialInput
): Promise<string[]> {
  const invalid = validateDnsCredentials(input);
  if (invalid) throw new ApiError(invalid);

  return withProxyLock(server.$id, async () => {
    const ssh = await getSSHConfig(server);
    const provider = findDnsProvider(input.hook)!;

    const res = await sshExec(
      ssh,
      withStdin(
        ['sh', '-c', writeCredentialsCommand(credentialNamesToClear(provider, input.remove))],
        // Ohne abschließenden Zeilenumbruch klebte die erste neue Zeile an der
        // letzten der Datei, falls die keinen hatte.
        `${credentialLines(input).join('\n')}\n`
      ),
      SHORT_MS
    );

    if (res.code !== 0) {
      throw new ApiError(
        res.code === 3
          ? `Es gibt keine acme.sh-Konfiguration (${ACME_HOME}/account.conf). ` +
            'HAPM richtet acme.sh beim Start ein. Ob das geklappt hat, steht in der Übersicht.'
          : `Die Zugangsdaten ließen sich nicht ablegen: ${tail(res.stderr || res.stdout)}`
      );
    }

    return (await probeProxy(server)).dnsHooks;
  });
}

/**
 * Der Zustand der Backend-Server, über den Stats-Socket.
 *
 * Eine zweite Runde, und zwar bewusst: der Pfad des Sockets steht in der
 * Konfiguration, die die erste Runde gerade erst geholt hat. Ihn zu raten wäre
 * die Alternative — `/run/haproxy/admin.sock` und `/var/run/haproxy.sock` sind
 * beide üblich, und geraten hieße, bei der Hälfte der Konfigurationen nichts
 * zu finden und das für „alles unten" zu halten.
 *
 * `socat` ist das übliche Werkzeug dafür und auf einem Proxy meist da; fehlt
 * es, gibt es eben keinen Zustand. Deshalb `|| true`: ein fehlendes Programm
 * ist hier kein Fehler, sondern eine Auskunft, die es nicht gibt.
 */
async function probeServerStates(
  ssh: Awaited<ReturnType<typeof getSSHConfig>>,
  socket: string
): Promise<BackendServerState[]> {
  const res = await sshExec(
    ssh,
    `printf 'show stat\\n' | socat -t 2 stdio ${shellEscape(socket)} 2>/dev/null || true`,
    SHORT_MS
  ).catch(() => null);
  return res ? parseStatsCsv(res.stdout) : [];
}

export async function probeProxy(server: Server): Promise<ProxyProbe> {
  const ssh = await getSSHConfig(server);
  const res = await sshExec(ssh, batchCommands(PROBE), SHORT_MS);
  const [version, acme, digest, hooks, raw] = splitSections(res.stdout, PROBE.length);

  const configReadable = digest.length > 0;
  const socket = configReadable ? parseStatsSocket(raw) : null;

  return {
    version: parseHaproxyVersion(version),
    digest: digest || null,
    services: configReadable ? parseHaproxyConfig(raw) : [],
    streams: configReadable ? parseStreams(raw) : [],
    serverStates: socket ? await probeServerStates(ssh, socket) : [],
    acmeReady: acme.trim() === 'ja',
    dnsHooks: parseDnsHooks(hooks),
    configReadable,
    raw,
  };
}

/* ── Schreiben ── */

export interface ProvisionStep {
  label: string;
  ok: boolean;
  detail?: string;
}

export interface ProvisionResult {
  steps: ProvisionStep[];
}

/**
 * Wohin der Fortschritt gemeldet wird, während der Vorgang läuft.
 *
 * Er läuft abgekoppelt von der Anfrage (lib/haproxy/runner.ts): der Dialog
 * schließt sich, und was passiert, steht in der Pille unten rechts. Ohne diese
 * Rückmeldung stünde dort für Minuten „läuft" und danach das fertige Ergebnis —
 * ein Fortschritt, der erst am Ende erscheint, ist keiner. Optional, damit ein
 * Aufrufer ohne Zeile (Test, künftiger Skript-Weg) dieselben Funktionen nimmt.
 */
export interface ProvisionReporter {
  onStep?: (steps: ProvisionStep[]) => void | Promise<void>;
  onPhase?: (phase: HaproxyPhase) => void | Promise<void>;
}

/** Sammelt die Schritte und meldet jeden einzelnen weiter, sobald er feststeht. */
class StepLog {
  readonly steps: ProvisionStep[] = [];

  constructor(private readonly reporter?: ProvisionReporter) {}

  async push(step: ProvisionStep): Promise<void> {
    this.steps.push(step);
    // Ein Fehlschlag beim Melden darf den Vorgang nicht anhalten: die Datenbank
    // ist für das, was auf der Maschine passiert, nicht zuständig.
    await Promise.resolve(this.reporter?.onStep?.(this.steps)).catch(() => {});
  }

  async phase(phase: HaproxyPhase): Promise<void> {
    await Promise.resolve(this.reporter?.onPhase?.(phase)).catch(() => {});
  }
}

/** Kürzt Werkzeugausgabe auf das, was in eine Meldung passt. */
function tail(text: string, max = 600): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

/**
 * Die Seiten der Passwortsperre auf die Maschine legen.
 *
 * Die Regeln der Sperre verweisen auf drei Dateien, und HAProxy liest sie beim
 * Laden der Konfiguration ein. Fehlt eine, lehnt es die ganze Datei ab. Sie
 * müssen deshalb liegen, BEVOR `haproxy -c` läuft, und das stellt dieser
 * Schritt vor jeder Prüfung sicher, nicht nur beim Anlegen einer Sperre: sonst
 * scheiterte ein Jahr später das Ändern einer fremden Backend-Adresse daran,
 * dass jemand das Verzeichnis aufgeräumt hat.
 *
 * Verglichen wird über die Prüfsumme, geschrieben nur bei einer Abweichung.
 * So kommt auch eine geänderte Fassung der Seite mit dem nächsten Vorgang auf
 * die Maschine, ohne dass jeder Vorgang drei Dateien schreibt.
 *
 * Aufgeräumt wird nicht. Drei kleine Dateien ohne Verweis darauf stören
 * niemanden, und ein Löschen müsste sicher sein, dass keine Regel sie mehr
 * braucht, auch keine, die jemand von Hand geschrieben hat.
 */
async function ensureLockPages(
  ssh: Awaited<ReturnType<typeof getSSHConfig>>
): Promise<{ ok: boolean; detail: string }> {
  const pages = lockPages().map((page) => ({
    path: `${LOCK_PAGE_DIR}/${page.file}`,
    html: page.html,
    digest: createHash('sha256').update(page.html, 'utf8').digest('hex'),
  }));

  const sums = await sshExec(
    ssh,
    lockPageDigestCommand(pages.map((page) => page.path)),
    SHORT_MS
  );
  const present = new Set(sums.stdout.split('\n').map((line) => line.trim().split(/\s+/)[0]));
  if (pages.every((page) => present.has(page.digest))) return { ok: true, detail: '' };

  for (const page of pages) {
    const write = await sshExec(
      ssh,
      lockPageWriteCommand(LOCK_PAGE_DIR, page.path, page.html),
      SHORT_MS
    );
    if (write.code !== 0) {
      return {
        ok: false,
        detail: `Die Seite der Passwortsperre (${page.path}) ließ sich nicht schreiben: ${tail(write.stderr)}`,
      };
    }
  }
  return { ok: true, detail: '' };
}

/**
 * Eine Passwortsperre auf einer Maschine, deren HAProxy sie nicht kann.
 *
 * `haproxy -c` lehnte die Datei ohnehin ab, aber mit einer Meldung über ein
 * unbekanntes Schlüsselwort und erst im Vorgang. Hier steht der Grund, und er
 * kommt ins Formular zurück. Ist die Version unbekannt, entscheidet die Prüfung.
 */
function assertLockSupported(server: Server, probe: ProxyProbe, input: CreateServiceInput): void {
  // `INHERIT_LOCK` verlangt nichts: steht dort schon eine Passwortsperre, läuft
  // sie auf dieser Maschine bereits, und sonst bleibt es bei den Admin-IPs.
  if (input.passwordLock === null || input.passwordLock === INHERIT_LOCK) return;
  if (supportsPasswordLock(probe.version) === false) {
    throw new ApiError(
      `Die Passwortsperre braucht HAProxy 2.4 oder neuer. Hier läuft ${probe.version}. ` +
        'Die Sperre auf Admin-IPs geht dort weiterhin.'
    );
  }
}

/**
 * Die neue Datei ablegen und prüfen, ohne die gültige anzufassen.
 *
 * Der Inhalt geht über stdin und nie als Argument: eine Konfiguration auf der
 * Kommandozeile stünde in `ps`, für jeden Benutzer sichtbar.
 * Siehe `withStdin` in lib/shell.ts.
 */
async function stageAndCheck(
  ssh: Awaited<ReturnType<typeof getSSHConfig>>,
  text: string
): Promise<{ ok: boolean; detail: string }> {
  if (usesLockPages(text)) {
    const pages = await ensureLockPages(ssh);
    if (!pages.ok) return pages;
  }

  // `tee` gibt den Inhalt auf stdout wieder aus; das wird verworfen. Eine
  // haproxy.cfg ist ein paar Kilobyte groß, der doppelte Weg fällt nicht ins
  // Gewicht und spart eine Umleitung, die es in `buildCommand` nicht gibt.
  const write = await sshExec(ssh, withStdin(['tee', STAGING_CFG], text), SHORT_MS);
  if (write.code !== 0) {
    return { ok: false, detail: tail(write.stderr || write.stdout) };
  }
  const check = await sshExec(ssh, buildCommand(['haproxy', '-c', '-f', STAGING_CFG]), SHORT_MS);
  return {
    ok: check.code === 0,
    detail: tail(check.stderr || check.stdout),
  };
}

/**
 * Die geprüfte Datei einsetzen und HAProxy neu laden. Scheitert der Reload,
 * kommt das Backup zurück und wird selbst wieder geladen.
 *
 * `cp` und nicht `mv`: der Zielinode bleibt derselbe, also auch Besitzer, Rechte
 * und Kontext der Datei. `mv` schöbe die Datei aus dem Arbeitsverzeichnis mit
 * ihren Rechten darüber.
 */
async function installAndReload(
  ssh: Awaited<ReturnType<typeof getSSHConfig>>,
  expectedDigest: string | null,
  steps: StepLog
): Promise<boolean> {
  // Letzte Gelegenheit, einen fremden Schreiber zu bemerken: gelesen wurde vor
  // Sekunden bis Minuten (das Zertifikat liegt dazwischen). Wer inzwischen von
  // Hand editiert hat, soll seine Änderung behalten.
  if (expectedDigest) {
    const now = await sshExec(
      ssh,
      `sha256sum ${shellEscape(HAPROXY_CFG)} | cut -d' ' -f1`,
      SHORT_MS
    );
    if (now.stdout.trim() !== expectedDigest) {
      await steps.push({
        label: 'Konfiguration einsetzen',
        ok: false,
        detail:
          'Die Konfiguration hat sich geändert, seit sie gelesen wurde. ' +
          'Es wurde nichts überschrieben. Bitte erneut versuchen.',
      });
      return false;
    }
  }

  const backup = `${HAPROXY_CFG}.backup-${stamp()}`;
  const copy = await sshExec(ssh, buildCommand(['cp', '-a', HAPROXY_CFG, backup]), SHORT_MS);
  if (copy.code !== 0) {
    await steps.push({ label: 'Backup anlegen', ok: false, detail: tail(copy.stderr) });
    return false;
  }
  await steps.push({ label: 'Backup angelegt', ok: true, detail: backup });

  const install = await sshExec(ssh, buildCommand(['cp', STAGING_CFG, HAPROXY_CFG]), SHORT_MS);
  if (install.code !== 0) {
    await steps.push({ label: 'Konfiguration einsetzen', ok: false, detail: tail(install.stderr) });
    return false;
  }

  const reload = await sshExec(ssh, buildCommand(RELOAD_ARGV), RELOAD_MS);
  if (reload.code !== 0) {
    await sshExec(ssh, buildCommand(['cp', '-a', backup, HAPROXY_CFG]), SHORT_MS).catch(() => null);
    await sshExec(ssh, buildCommand(RELOAD_ARGV), RELOAD_MS).catch(() => null);
    await steps.push({
      label: 'HAProxy neu laden',
      ok: false,
      detail: `${tail(reload.stderr || reload.stdout)}. Rollback auf ${backup} durchgeführt.`,
    });
    return false;
  }

  await steps.push({ label: 'Konfiguration eingesetzt und HAProxy neu geladen', ok: true });
  await sshExec(ssh, buildCommand(['rm', '-f', STAGING_CFG]), SHORT_MS).catch(() => null);
  await pruneBackups(ssh, steps);
  return true;
}

/**
 * Die ältesten Konfigurations-Backups wegräumen, die neuesten `BACKUP_KEEP`
 * behalten.
 *
 * Sortiert wird nach dem Zeitstempel im Dateinamen und nicht nach mtime: der
 * Name ist der Zeitpunkt des Vorgangs, die mtime die der Datei — und `cp -a`
 * behält die der Vorlage, alle Backups tragen also die mtime der jeweils
 * gesicherten Fassung. Nach der falschen von beiden sortiert würde
 * ausgerechnet das jüngste Backup einer alten Datei zuerst gelöscht.
 *
 * `sort` reicht dafür, weil `stamp()` ein festbreites `YYYYMMDD-HHMMSS`
 * schreibt. Best effort: liegengebliebene Backups sind ein unordentliches
 * Verzeichnis, kein Ausfall — der Vorgang gilt hier bereits als gelungen.
 */
/**
 * Das Muster, unter dem die Sicherungen liegen — Pfad in Anführungszeichen,
 * Stern DAVOR nicht.
 *
 * Der ganze Ausdruck durch `shellEscape` wäre der stille Fehlschlag: aus einem
 * Muster würde ein Dateiname mit einem Sternchen darin, `ls` fände nichts, und
 * das Aufräumen liefe für immer erfolgreich über null Dateien. Deshalb wird nur
 * der feste Teil zitiert; die Shell hängt den unzitierten Rest an und expandiert
 * ihn. Der feste Teil ist eine Konstante ohne Sonderzeichen, das Zitat also
 * Vorsorge und keine Notwendigkeit.
 *
 * Rein, damit `tests/haproxy/prune.test.ts` es mit einer echten Bash nachprüfen
 * kann statt mit einer zweiten Meinung darüber, was Quoting tut.
 */
export function backupGlob(cfg: string = HAPROXY_CFG): string {
  return `${shellEscape(cfg)}.backup-*`;
}

/**
 * Der Befehl, der die ältesten Sicherungen entfernt und die Zahl der übrigen
 * ausgibt. Rein, weil an ihm ein `rm -f` über ein Muster hängt: der Test lässt
 * ihn von einer echten Bash über ein Temp-Verzeichnis laufen, und dafür ist der
 * Pfad ein Parameter — im Betrieb ist er die Konstante.
 */
export function pruneBackupsCommand(
  keep: number = BACKUP_KEEP,
  cfg: string = HAPROXY_CFG
): string {
  const glob = backupGlob(cfg);
  // `tr` und `xargs -0`, nicht `xargs` allein: das trennt sonst an Leerzeichen,
  // und ein Pfad mit einem Leerzeichen darin käme als zwei Namen an, die es
  // beide nicht gibt. `rm -f` schweigt dazu, und das Aufräumen täte still
  // nichts — derselbe Ausgang wie beim falsch zitierten Muster.
  return (
    `ls -1 ${glob} 2>/dev/null | sort | head -n -${keep} | tr '\\n' '\\0' | ` +
    `xargs -0 -r rm -f -- && ls -1 ${glob} 2>/dev/null | wc -l`
  );
}

async function pruneBackups(
  ssh: Awaited<ReturnType<typeof getSSHConfig>>,
  steps: StepLog
): Promise<void> {
  // `ls -1` auf ein Muster ohne Treffer meldet einen Fehler; das Ergebnis ist
  // dann leer, `head -n -N` gibt nichts aus, und `xargs -r` läuft gar nicht erst.
  const res = await sshExec(ssh, pruneBackupsCommand(), SHORT_MS).catch(() => null);

  const remaining = Number(res?.stdout.trim());
  if (!res || res.code !== 0 || !Number.isFinite(remaining)) return;

  await steps.push({
    label: 'Alte Konfigurations-Backups aufgeräumt',
    ok: true,
    detail: `${remaining} von höchstens ${BACKUP_KEEP} Sicherungen liegen noch in /etc/haproxy.`,
  });
}

/** Der Pfad, unter dem das Zertifikat einer Domain in `/etc/haproxy/certs`
 *  liegt. Der Stern einer Wildcard wird dabei zum Unterstrich, siehe
 *  `pemFileName`. */
function pemPath(mainDomain: string): string {
  return `${HAPROXY_CERT_DIR}/${pemFileName(mainDomain)}`;
}

/**
 * Ob sich für diese Domains überhaupt ein Zertifikat ausstellen lässt, und wie:
 * geprüft, bevor irgendetwas geschrieben wird.
 *
 * Die Regel selbst steht in `challenge.ts` (HTTP-01, außer bei einer Wildcard
 * oder einer internen Installation). Hier kommt dazu, was die Maschine sagt:
 * ob acme.sh da ist und welche DNS-Hooks eingerichtet sind.
 *
 * Der Hook wird verlangt, sobald DNS-01 nötig ist, auch wenn ein passendes
 * Zertifikat vielleicht schon auf der Maschine liegt. Das nachzusehen wäre
 * eine zweite Runde in jeder Vorabprüfung. Ist es doch da, kostet der Hook
 * nichts: `issueAndDeploy` beantragt dann gar nicht erst.
 */
function assertIssuable(
  probe: ProxyProbe,
  domains: string[],
  challenge: ChallengeChoice
): ChallengePlan {
  if (!probe.acmeReady) {
    throw new ApiError(
      `acme.sh (${ACME}) oder das Zertifikatsverzeichnis (${HAPROXY_CERT_DIR}) fehlt. Ohne beides lässt sich ` +
        'kein Zertifikat ausstellen. HAPM legt beides beim Start an. Ob das geklappt hat, steht in der Übersicht.'
    );
  }
  const plan = planChallenge(domains, challenge, probe.dnsHooks);
  if (plan.method === 'unavailable') throw new ApiError(plan.message);
  return plan;
}

/**
 * Zertifikat beantragen und nach `/etc/haproxy/certs` ausrollen.
 *
 * Der Deploy-Hook ist der Grund, warum das Zertifikat sich danach **von selbst**
 * erneuert: acme.sh schreibt Hook und Umgebung in die Renewal-Konfiguration der
 * Domain, und der tägliche Lauf (`renewCertificates` in `lib/acme.ts`) rollt
 * beim Erneuern erneut aus und lädt HAProxy neu. In `lib/db` steht dafür
 * nichts: was zu erneuern ist und wie, weiß acme.sh allein.
 */
async function issueAndDeploy(
  ssh: Awaited<ReturnType<typeof getSSHConfig>>,
  domains: string[],
  plan: ChallengePlan,
  certs: AcmeCertificate[],
  steps: StepLog
): Promise<boolean> {
  const mainDomain = domains[0];

  /* ── Erst nachsehen, dann beantragen ──
   *
   * Ein Wildcard-Zertifikat bedient mehrere Dienste — das ist sein Sinn. Für den
   * zweiten Dienst unter `*.kunde.example` eins zu beantragen, das schon da ist,
   * kostet einen Lauf gegen das Kontingent von Let's Encrypt und legt einen
   * zweiten Erneuerungseintrag auf überlappende Domains an; die beiden nähmen
   * sich danach gegenseitig die Challenge weg. */
  const existing = findCertificateFor(certs, domains);
  if (existing) {
    await steps.push({
      label: 'Zertifikat schon vorhanden',
      ok: true,
      detail: `${existing.mainDomain} deckt ${domains.join(', ')} ab. Es wurde keins beantragt.`,
    });
    return true;
  }

  const issue = await sshExec(
    ssh,
    buildCommand([
      ACME,
      '--issue',
      '--server',
      acmeServer(),
      ...challengeArgs(plan, ACME_PORT),
      '--keylength',
      'ec-256',
      ...domains.flatMap((domain) => ['-d', domain]),
    ]),
    ACME_MS
  );
  // 2 heißt bei acme.sh „das vorhandene Zertifikat ist noch gültig". Das ist
  // kein Fehlschlag, sondern der zweite Normalfall.
  if (issue.code !== 0 && issue.code !== 2) {
    await steps.push({
      label: 'Zertifikat ausstellen',
      ok: false,
      detail: tail(issue.stderr || issue.stdout),
    });
    return false;
  }
  await steps.push({
    label: issue.code === 2 ? 'Zertifikat war noch gültig' : 'Zertifikat ausgestellt',
    ok: true,
    detail: `${domains.join(', ')} (${plan.method === 'dns' ? `DNS-01 über ${plan.hook}` : 'HTTP-01'})`,
  });

  const deploy = await sshExec(
    ssh,
    withEnv(
      {
        DEPLOY_HAPROXY_PEM_PATH: HAPROXY_CERT_DIR,
        // Ausdrücklich gesetzt und nicht dem Hook überlassen: seine Vorgabe ist
        // die Hauptdomain, und bei einer Wildcard hieße die Datei `*.kunde.example.pem`.
        // Ein Stern im Dateinamen ist in jedem Shell-Muster ein Zeichen zu viel.
        DEPLOY_HAPROXY_PEM_NAME: pemFileName(mainDomain),
        // Der Hook läuft auch bei jeder späteren automatischen Erneuerung.
        // Er prüft deshalb selbst, bevor er neu lädt — ein erneuertes
        // Zertifikat darf HAProxy nicht mit einer Konfiguration hochfahren,
        // die inzwischen jemand anders kaputtgemacht hat.
        DEPLOY_HAPROXY_RELOAD: `haproxy -c -f ${HAPROXY_CFG} && hapm-reload`,
      },
      [ACME, '--deploy', '-d', mainDomain, '--ecc', '--deploy-hook', 'haproxy']
    ),
    ACME_MS
  );
  if (deploy.code !== 0) {
    await steps.push({
      label: 'Zertifikat ausrollen',
      ok: false,
      detail: tail(deploy.stderr || deploy.stdout),
    });
    return false;
  }

  const pem = await sshExec(ssh, buildCommand(['test', '-f', pemPath(mainDomain)]), SHORT_MS);
  if (pem.code !== 0) {
    await steps.push({
      label: 'Zertifikat ausrollen',
      ok: false,
      detail: `${pemPath(mainDomain)} liegt nach dem Ausrollen nicht vor.`,
    });
    return false;
  }
  await steps.push({ label: 'Zertifikat ausgerollt', ok: true, detail: pemPath(mainDomain) });
  return true;
}

/**
 * Welche der übrig bleibenden Dienste dieses Zertifikat noch brauchen.
 *
 * Der Fall, für den es die Prüfung gibt: `app.kunde.example` und `api.kunde.example` sind
 * zwei Einträge auf einem Zertifikat `*.kunde.example` — genau wofür man Wildcards
 * nimmt. Den ersten zu löschen darf dem zweiten das PEM nicht wegnehmen. Ohne
 * die Prüfung täte es das, und auffallen würde es nicht beim Löschen, sondern
 * beim nächsten Start von HAProxy.
 *
 * Im Zweifel bleibt das Zertifikat stehen: ein überzähliges kostet einen
 * Erneuerungseintrag, ein fehlendes nimmt eine fremde Domain offline.
 */
function certificateUsers(cert: AcmeCertificate, services: HaproxyService[]): HaproxyService[] {
  return services.filter((service) =>
    service.domains.some((domain) => cert.domains.some((p) => certCovers(p, domain)))
  );
}

/**
 * Ein Zertifikat samt Erneuerungseintrag abräumen. Best effort und immer am
 * Ende: ab hier läuft HAProxy schon mit der neuen Lage, ein Fehlschlag ist eine
 * liegengebliebene Datei und kein Ausfall.
 */
async function dropCertificate(
  ssh: Awaited<ReturnType<typeof getSSHConfig>>,
  mainDomain: string,
  steps: StepLog
): Promise<void> {
  const remove = await sshExec(
    ssh,
    buildCommand([ACME, '--remove', '-d', mainDomain, '--ecc']),
    SHORT_MS
  );
  await steps.push({
    label: 'Zertifikat aus der Erneuerung genommen',
    ok: remove.code === 0,
    detail: remove.code === 0 ? mainDomain : tail(remove.stderr || remove.stdout),
  });
  await sshExec(
    ssh,
    buildCommand(['rm', '-rf', '--', `${ACME_HOME}/${mainDomain}_ecc`]),
    SHORT_MS
  ).catch(() => null);
}

/**
 * Einen Dienst anlegen.
 *
 * Wirft nur, wenn schon die Vorbedingungen nicht stimmen (Rolle, Lesbarkeit,
 * Namenskonflikt). Was danach schiefgeht, steht als Schritt im Ergebnis: ein
 * Vorgang aus fünf Teilen, der beim vierten scheitert, ist keine Ausnahme,
 * sondern eine Auskunft.
 */
export async function createService(
  server: Server,
  input: CreateServiceInput,
  challenge: ChallengeChoice,
  reporter?: ProvisionReporter
): Promise<ProvisionResult> {
  return withProxyLock(server.$id, async () => {
    const steps = new StepLog(reporter);
    await steps.phase('preflight');

    const ssh = await getSSHConfig(server);
    const probe = await probeProxy(server);

    if (!probe.configReadable) {
      throw new ApiError(
        `${HAPROXY_CFG} ist nicht lesbar. Ob die Ersteinrichtung durchgelaufen ist, steht in der Übersicht.`
      );
    }
    const plan = assertIssuable(probe, input.domains, challenge);
    assertLockSupported(server, probe, input);

    // Wirft bei doppelter ID oder belegter Domain — bevor irgendetwas passiert,
    // und insbesondere bevor ein Zertifikat beantragt wird. Ein Fehlversuch bei
    // Let's Encrypt zählt gegen ein Kontingent.
    const nextConfig = addService(probe.raw, input);

    /* ── Zertifikat ── */
    await steps.phase('certificate');
    const certs = await probeCertificates(ssh);
    if (!(await issueAndDeploy(ssh, input.domains, plan, certs, steps))) {
      return { steps: steps.steps };
    }

    /* ── Konfiguration ── */
    await steps.phase('checking');
    const staged = await stageAndCheck(ssh, nextConfig);
    if (!staged.ok) {
      await steps.push({
        label: 'Neue Konfiguration prüfen',
        ok: false,
        detail: `${staged.detail}. Es wurde nichts eingesetzt, die bestehende Konfiguration ist unverändert.`,
      });
      return { steps: steps.steps };
    }
    await steps.push({ label: 'Neue Konfiguration geprüft', ok: true });

    await steps.phase('installing');
    await installAndReload(ssh, probe.digest, steps);
    return { steps: steps.steps };
  });
}

/**
 * Einen Dienst entfernen: Konfiguration, Zertifikat und der Erneuerungseintrag.
 *
 * Das PEM wird **vor** der Prüfung beiseitegelegt und nicht nach dem Reload
 * gelöscht. Der Grund ist der letzte Dienst auf einer Maschine: HAProxy lädt das
 * Zertifikatsverzeichnis als Ganzes, und ein leeres Verzeichnis hinter
 * `crt /etc/haproxy/certs` lässt es beim nächsten Start scheitern. Wer erst
 * reloadet und dann löscht, merkt das nicht heute, sondern beim nächsten
 * Neustart der Maschine.
 */
export async function deleteService(
  server: Server,
  id: string,
  reporter?: ProvisionReporter
): Promise<ProvisionResult> {
  return withProxyLock(server.$id, async () => {
    const steps = new StepLog(reporter);
    await steps.phase('preflight');

    const ssh = await getSSHConfig(server);
    const probe = await probeProxy(server);

    if (!probe.configReadable) {
      throw new ApiError(`${HAPROXY_CFG} ist nicht lesbar.`);
    }

    const service = probe.services.find((s) => s.id === id);
    if (!service) throw new ApiError(`Der Dienst "${id}" steht nicht in ${HAPROXY_CFG}.`, 404);
    if (!service.removable) {
      throw new ApiError(
        `"${id}" wurde nicht über HAPM angelegt und lässt sich hier nicht entfernen. ` +
          'ACL, Weiche oder Backend folgen nicht dem erwarteten Schema.'
      );
    }

    const nextConfig = removeService(probe.raw, id);
    const mainDomain = service.domains[0] ?? null;

    /* ── Gehört das Zertifikat noch jemandem? ──
     *
     * Vor dem Beiseitelegen und nicht danach: ein geteiltes Zertifikat darf gar
     * nicht erst aus dem Verzeichnis verschwinden, auch nicht für die Dauer der
     * Prüfung. HAProxy liest `crt /etc/haproxy/certs` beim Reload neu ein. */
    const certs = await probeCertificates(ssh);
    const cert = mainDomain
      ? (certs.find((c) => c.mainDomain.toLowerCase() === mainDomain.toLowerCase()) ?? null)
      : null;
    const sharedWith = cert ? certificateUsers(cert, parseHaproxyConfig(nextConfig)) : [];

    if (cert && sharedWith.length > 0) {
      await steps.push({
        label: 'Zertifikat bleibt stehen',
        ok: true,
        detail:
          `${cert.mainDomain} deckt auch ${sharedWith.map((s) => s.id).join(', ')} ab. ` +
          'Es wird weder aus der Erneuerung genommen noch gelöscht.',
      });
    }

    const keepCertificate = sharedWith.length > 0;
    const pem = mainDomain && !keepCertificate ? pemPath(mainDomain) : null;
    const parked = pem ? `${pem}.hapm-removing` : null;

    let pemParked = false;
    if (pem && parked) {
      const move = await sshExec(
        ssh,
        `test -f ${shellEscape(pem)} && mv ${shellEscape(pem)} ${shellEscape(parked)} && echo ja`,
        SHORT_MS
      );
      pemParked = move.stdout.trim() === 'ja';
    }

    const restorePem = async () => {
      if (pemParked && pem && parked) {
        await sshExec(ssh, buildCommand(['mv', parked, pem]), SHORT_MS).catch(() => null);
      }
    };

    await steps.phase('checking');
    const staged = await stageAndCheck(ssh, nextConfig);
    if (!staged.ok) {
      await restorePem();
      await steps.push({
        label: 'Neue Konfiguration prüfen',
        ok: false,
        detail: `${staged.detail}. Es wurde nichts geändert.`,
      });
      return { steps: steps.steps };
    }
    await steps.push({ label: 'Neue Konfiguration geprüft', ok: true });

    await steps.phase('installing');
    const installed = await installAndReload(ssh, probe.digest, steps);
    if (!installed) {
      await restorePem();
      return { steps: steps.steps };
    }

    /* ── Zertifikat aus der Erneuerung nehmen ──
     *
     * Ab hier ist der Dienst weg und HAProxy läuft. Was jetzt noch schiefgeht,
     * ist eine liegengebliebene Datei und kein Ausfall — deshalb wird es
     * gemeldet und nicht zurückgerollt. */
    await steps.phase('cleanup');
    if (mainDomain && !keepCertificate) await dropCertificate(ssh, mainDomain, steps);

    if (parked) {
      await sshExec(ssh, buildCommand(['rm', '-f', '--', parked]), SHORT_MS).catch(() => null);
    }

    return { steps: steps.steps };
  });
}

/**
 * Einen Dienst ändern: Domains, Ziele, Namen, Healthcheck, Preset, Bereich.
 *
 * ── Warum nicht einfach löschen und neu anlegen ──
 *
 * Weil das eine Lücke wäre. Zwei Vorgänge heißen zwei Reloads, und zwischen
 * ihnen ist die Domain nicht erreichbar — bei einem Fehlschlag im zweiten sogar
 * dauerhaft. Hier entsteht die neue Konfiguration in EINEM Text, wird in EINEM
 * `haproxy -c` geprüft und in EINEM Reload gültig. Aus Sicht der Besucher
 * wechselt das Ziel, es fällt nicht aus.
 *
 * ── Das Zertifikat wird nur angefasst, wenn es muss ──
 *
 * Eine geänderte Backend-IP hat mit dem Zertifikat nichts zu tun. Erst wenn sich
 * die Domainliste ändert, wird neu ausgestellt — und nur wenn sich dabei die
 * HAUPTdomain ändert, wird das alte Zertifikat abgeräumt: es hieße sonst zwei
 * Erneuerungseinträge für überlappende Domains, die sich gegenseitig die
 * Challenge wegnehmen.
 */
export async function updateService(
  server: Server,
  oldId: string,
  input: CreateServiceInput,
  challenge: ChallengeChoice,
  reporter?: ProvisionReporter
): Promise<ProvisionResult> {
  return withProxyLock(server.$id, async () => {
    const steps = new StepLog(reporter);
    await steps.phase('preflight');

    const ssh = await getSSHConfig(server);
    const probe = await probeProxy(server);

    if (!probe.configReadable) {
      throw new ApiError(`${HAPROXY_CFG} ist nicht lesbar.`);
    }

    const current = probe.services.find((s) => s.id === oldId);
    if (!current) throw new ApiError(`Der Dienst "${oldId}" steht nicht in ${HAPROXY_CFG}.`, 404);
    if (!current.editable) {
      throw new ApiError(
        `"${oldId}" lässt sich nicht bearbeiten. ` +
          (current.extras.length > 0
            ? `Der Backend-Block enthält Einstellungen, die dieses Formular nicht abbildet: ${current.extras.join(', ')}. ` +
              'Sie gingen beim Speichern verloren.'
            : 'ACL, Weiche oder Backend folgen nicht dem erwarteten Schema.')
      );
    }

    assertLockSupported(server, probe, input);

    // Wirft bei einer Domain, die inzwischen woanders geroutet wird — bevor ein
    // Zertifikat beantragt wird. Die eigenen Domains stehen dem nicht im Weg:
    // `replaceService` entfernt den alten Eintrag zuerst.
    const nextConfig = replaceService(probe.raw, oldId, input);

    const certNeeded = certificateChanged(current.domains, input.domains);
    const oldMain = current.domains[0] ?? null;
    const newMain = input.domains[0];
    const mainChanged = oldMain !== null && oldMain.toLowerCase() !== newMain.toLowerCase();

    const plan = certNeeded ? assertIssuable(probe, input.domains, challenge) : null;

    await steps.phase('certificate');
    if (plan) {
      const certs = await probeCertificates(ssh);
      if (!(await issueAndDeploy(ssh, input.domains, plan, certs, steps))) {
        return { steps: steps.steps };
      }
    } else {
      await steps.push({
        label: 'Zertifikat unverändert',
        ok: true,
        detail: 'Die Domains sind dieselben geblieben, es wurde keins beantragt.',
      });
    }

    await steps.phase('checking');
    const staged = await stageAndCheck(ssh, nextConfig);
    if (!staged.ok) {
      await steps.push({
        label: 'Neue Konfiguration prüfen',
        ok: false,
        detail: `${staged.detail}. Es wurde nichts eingesetzt, die bestehende Konfiguration ist unverändert.`,
      });
      return { steps: steps.steps };
    }
    await steps.push({ label: 'Neue Konfiguration geprüft', ok: true });

    await steps.phase('installing');
    if (!(await installAndReload(ssh, probe.digest, steps))) return { steps: steps.steps };

    /* ── Das alte Zertifikat, falls die Hauptdomain gewechselt hat ──
     *
     * Erst hier: die neue Konfiguration läuft bereits, das alte PEM wird von
     * niemandem mehr gebraucht. Vorher gelöscht wäre es der Fall, in dem der
     * Reload scheitert und das Rollback auf eine Datei zeigt, die es nicht mehr
     * gibt. */
    if (mainChanged && oldMain) {
      await steps.phase('cleanup');

      // Dieselbe Frage wie beim Löschen: das alte Zertifikat kann ein Wildcard
      // sein, an dem noch andere Dienste hängen.
      const oldCert = (await probeCertificates(ssh)).find(
        (c) => c.mainDomain.toLowerCase() === oldMain.toLowerCase()
      );
      const sharedWith = oldCert
        ? certificateUsers(oldCert, parseHaproxyConfig(nextConfig))
        : [];

      if (sharedWith.length > 0) {
        await steps.push({
          label: 'Altes Zertifikat bleibt stehen',
          ok: true,
          detail: `${oldMain} deckt auch ${sharedWith.map((s) => s.id).join(', ')} ab.`,
        });
      } else {
        await sshExec(ssh, buildCommand(['rm', '-f', '--', pemPath(oldMain)]), SHORT_MS).catch(
          () => null
        );
        await dropCertificate(ssh, oldMain, steps);
      }
    }

    return { steps: steps.steps };
  });
}

/* ── Vorabprüfung ──
 *
 * Was sich ohne einen einzigen Schreibvorgang beantworten lässt: gibt es die
 * Maschine, ist die Konfiguration lesbar, ist die Dienst-ID frei, gehört die
 * Domain schon jemand anderem, lässt sich der Eintrag überhaupt bearbeiten.
 *
 * Diese Fragen bleiben synchron, obwohl der Vorgang selbst abgekoppelt läuft.
 * Ein Formular, das sich schließt und eine Minute später in der Historie einen
 * Fehlschlag „Dienst-ID bereits vergeben" hinterlässt, hat die Eingabe
 * weggeworfen, statt sie zu bemängeln — und der Benutzer tippt sie neu, statt
 * das eine Feld zu ändern.
 *
 * Der Preis ist eine zweite Runde je Vorgang: der Lauf probt gleich noch
 * einmal, und zwar innerhalb des Locks. Anders geht es nicht ehrlich — zwischen
 * Prüfung und Ausführung kann sich die Datei ändern, und die Antwort auf diese
 * Frage darf nicht aus einer Momentaufnahme von vorhin kommen.
 */

async function readableProbe(server: Server): Promise<ProxyProbe> {
  const probe = await probeProxy(server);
  if (!probe.configReadable) {
    throw new ApiError(
      `${HAPROXY_CFG} ist nicht lesbar. Ob die Ersteinrichtung durchgelaufen ist, steht in der Übersicht.`
    );
  }
  return probe;
}

export async function precheckCreate(
  server: Server,
  input: CreateServiceInput,
  challenge: ChallengeChoice
): Promise<void> {
  const probe = await readableProbe(server);
  assertIssuable(probe, input.domains, challenge);
  assertLockSupported(server, probe, input);
  // Wirft als HaproxyConfigError bei doppelter ID oder belegter Domain.
  addService(probe.raw, input);
}

/**
 * Gibt den Dienst zurück, wie er JETZT dasteht — wie `precheckDelete`.
 *
 * Der Aufrufer braucht seine bisherigen Domains: die, die nach dem Speichern
 * nicht mehr dabei sind, verlieren ihren DNS-Eintrag. Nach dem Schreiben ließe
 * sich das nicht mehr feststellen.
 */
export async function precheckUpdate(
  server: Server,
  oldId: string,
  input: CreateServiceInput,
  challenge: ChallengeChoice
): Promise<HaproxyService> {
  const probe = await readableProbe(server);
  const current = probe.services.find((s) => s.id === oldId);
  if (!current) throw new ApiError(`Der Dienst "${oldId}" steht nicht in ${HAPROXY_CFG}.`, 404);
  if (!current.editable) {
    throw new ApiError(
      `"${oldId}" lässt sich nicht bearbeiten. ` +
        (current.extras.length > 0
          ? `Der Backend-Block enthält Einstellungen, die dieses Formular nicht abbildet: ${current.extras.join(', ')}. ` +
            'Sie gingen beim Speichern verloren.'
          : 'ACL, Weiche oder Backend folgen nicht dem erwarteten Schema.')
    );
  }
  if (certificateChanged(current.domains, input.domains)) {
    assertIssuable(probe, input.domains, challenge);
  }
  assertLockSupported(server, probe, input);
  replaceService(probe.raw, oldId, input);
  return current;
}

/* ── Ein Zertifikat ohne Ziel ──
 *
 * Der Fall ist die Wildcard aus der Einrichtung: `*.example.org` wird einmal
 * ausgestellt, und jedes Ziel darunter findet es danach vor
 * (`findCertificateFor`), statt ein eigenes zu beantragen. Es ist derselbe
 * Antrag und derselbe Deploy-Hook wie beim Anlegen eines Ziels, nur ohne die
 * Konfiguration: `haproxy.cfg` nennt kein einzelnes Zertifikat, HAProxy lädt
 * das Verzeichnis, und der Deploy-Hook lädt neu.
 *
 * Abgeräumt wird es wie jedes andere: es bleibt, solange ein Ziel es braucht.
 * Braucht es keines, steht es auf der Zertifikatsseite mit leerer Spalte
 * „Benutzt von".
 */

export function validateCertificateDomains(domains: string[]): string | null {
  if (domains.length === 0) return 'Mindestens eine Domain wird benötigt.';
  for (const domain of domains) {
    if (!isValidDomain(domain)) return `"${domain}" ist keine gültige Domain.`;
  }
  return null;
}

export async function precheckCertificate(
  server: Server,
  domains: string[],
  challenge: ChallengeChoice
): Promise<void> {
  const invalid = validateCertificateDomains(domains);
  if (invalid) throw new ApiError(invalid);
  const probe = await readableProbe(server);
  assertIssuable(probe, domains, challenge);
}

export async function issueCertificate(
  server: Server,
  domains: string[],
  challenge: ChallengeChoice,
  reporter?: ProvisionReporter
): Promise<ProvisionResult> {
  const invalid = validateCertificateDomains(domains);
  if (invalid) throw new ApiError(invalid);

  return withProxyLock(server.$id, async () => {
    const steps = new StepLog(reporter);
    await steps.phase('preflight');

    const ssh = await getSSHConfig(server);
    const probe = await probeProxy(server);
    const plan = assertIssuable(probe, domains, challenge);

    await steps.phase('certificate');
    const certs = await probeCertificates(ssh);
    await issueAndDeploy(ssh, domains, plan, certs, steps);
    return { steps: steps.steps };
  });
}

/* ── TCP-Weiterleitungen ──
 *
 * Derselbe Weg wie bei einem Dienst — Lock, Prüfsumme, `haproxy -c`, Backup,
 * `cp`, Reload —, nur ohne den Zertifikatsschritt: eine TCP-Weiterleitung hat
 * keine Domain, über die sich eine Challenge führen ließe, und was durch den
 * Port geht, entschlüsselt dieser Proxy gar nicht.
 *
 * Der Schritt, der bei einem Dienst fehlt, ist dafür der Port. Er ist die
 * einzige Stelle im ganzen Modul, an der die Prüfung `haproxy -c` nicht
 * ausreicht — sie liest die Datei, sie bindet keine Sockets.
 */

/** Prüfen, einsetzen, neu laden — der Teil, der bei allen drei Stream-Vorgängen
 *  Wort für Wort derselbe ist. */
async function writeStreamConfig(
  nextConfig: string,
  probeDigest: string | null,
  ssh: Awaited<ReturnType<typeof getSSHConfig>>,
  steps: StepLog
): Promise<ProvisionResult> {
  await steps.phase('checking');
  const staged = await stageAndCheck(ssh, nextConfig);
  if (!staged.ok) {
    await steps.push({
      label: 'Neue Konfiguration prüfen',
      ok: false,
      detail: `${staged.detail}. Es wurde nichts eingesetzt, die bestehende Konfiguration ist unverändert.`,
    });
    return { steps: steps.steps };
  }
  await steps.push({ label: 'Neue Konfiguration geprüft', ok: true });

  await steps.phase('installing');
  await installAndReload(ssh, probeDigest, steps);
  return { steps: steps.steps };
}

export async function createStream(
  server: Server,
  input: CreateStreamInput,
  reporter?: ProvisionReporter
): Promise<ProvisionResult> {
  return withProxyLock(server.$id, async () => {
    const steps = new StepLog(reporter);
    await steps.phase('preflight');

    const ssh = await getSSHConfig(server);
    const probe = await probeProxy(server);
    if (!probe.configReadable) {
      throw new ApiError(`${HAPROXY_CFG} ist nicht lesbar.`);
    }

    // Wirft bei belegtem Namen oder belegtem Port — innerhalb des Locks noch
    // einmal, denn die Antwort darf nicht aus der Momentaufnahme der
    // Vorabprüfung kommen.
    const nextConfig = addStream(probe.raw, input);
    await assertPortFree(ssh, probe.raw, input.port, server.name);
    await steps.push({
      label: `Port ${input.port} ist frei`,
      ok: true,
      detail: 'Weder in der Konfiguration noch auf diesem Server hält ihn jemand.',
    });

    return writeStreamConfig(nextConfig, probe.digest, ssh, steps);
  });
}

export async function updateStream(
  server: Server,
  oldId: string,
  input: CreateStreamInput,
  reporter?: ProvisionReporter
): Promise<ProvisionResult> {
  return withProxyLock(server.$id, async () => {
    const steps = new StepLog(reporter);
    await steps.phase('preflight');

    const ssh = await getSSHConfig(server);
    const probe = await probeProxy(server);
    if (!probe.configReadable) {
      throw new ApiError(`${HAPROXY_CFG} ist nicht lesbar.`);
    }

    const current = probe.streams.find((s) => s.id === oldId);
    if (!current) {
      throw new ApiError(`Die TCP-Weiterleitung "${oldId}" steht nicht in ${HAPROXY_CFG}.`, 404);
    }
    if (!current.editable) throw new ApiError(notEditable(current));

    // EIN Text, EIN `haproxy -c`, EIN Reload. Zwei Vorgänge wären eine Lücke,
    // in der der Port nicht bedient wird — bei einer Datenbankverbindung heißt
    // das abgebrochene Sitzungen und nicht eine langsame Seite.
    const nextConfig = replaceStream(probe.raw, oldId, input);
    if (input.port !== current.port) {
      await assertPortFree(ssh, probe.raw, input.port, server.name);
    }

    return writeStreamConfig(nextConfig, probe.digest, ssh, steps);
  });
}

export async function deleteStream(
  server: Server,
  id: string,
  reporter?: ProvisionReporter
): Promise<ProvisionResult> {
  return withProxyLock(server.$id, async () => {
    const steps = new StepLog(reporter);
    await steps.phase('preflight');

    const ssh = await getSSHConfig(server);
    const probe = await probeProxy(server);
    if (!probe.configReadable) {
      throw new ApiError(`${HAPROXY_CFG} ist nicht lesbar.`);
    }

    const current = probe.streams.find((s) => s.id === id);
    if (!current) {
      throw new ApiError(`Die TCP-Weiterleitung "${id}" steht nicht in ${HAPROXY_CFG}.`, 404);
    }
    if (!current.removable) throw new ApiError(notRemovable(current));

    return writeStreamConfig(removeStream(probe.raw, id), probe.digest, ssh, steps);
  });
}

function notEditable(stream: HaproxyStream): string {
  return (
    `"${stream.id}" lässt sich nicht bearbeiten. ` +
    (stream.extras.length > 0
      ? `Der Abschnitt enthält Einstellungen, die dieses Formular nicht abbildet: ${stream.extras.join(', ')}. ` +
        'Sie gingen beim Speichern verloren.'
      : 'Der Abschnitt folgt nicht dem erwarteten Schema.')
  );
}

function notRemovable(stream: HaproxyStream): string {
  return (
    `"${stream.id}" steht außerhalb der Marker-Blöcke und lässt sich hier nicht entfernen. ` +
    'Wo der Abschnitt anfängt, wäre geraten, und geraten wird an einer Konfiguration nicht, ' +
    'die fremde Ports bedient.'
  );
}

export async function precheckStreamCreate(
  server: Server,
  input: CreateStreamInput
): Promise<void> {
  const probe = await readableProbe(server);
  // Wirft als HaproxyConfigError bei belegtem Namen oder belegtem Port.
  addStream(probe.raw, input);
  await assertPortFree(await getSSHConfig(server), probe.raw, input.port, server.name);
}

/** Gibt die Weiterleitung zurück, wie sie JETZT dasteht — der Aufrufer braucht
 *  ihren bisherigen Port für die Historie. */
export async function precheckStreamUpdate(
  server: Server,
  oldId: string,
  input: CreateStreamInput
): Promise<HaproxyStream> {
  const probe = await readableProbe(server);
  const current = probe.streams.find((s) => s.id === oldId);
  if (!current) {
    throw new ApiError(`Die TCP-Weiterleitung "${oldId}" steht nicht in ${HAPROXY_CFG}.`, 404);
  }
  if (!current.editable) throw new ApiError(notEditable(current));

  replaceStream(probe.raw, oldId, input);
  if (input.port !== current.port) {
    await assertPortFree(await getSSHConfig(server), probe.raw, input.port, server.name);
  }
  return current;
}

export async function precheckStreamDelete(
  server: Server,
  id: string
): Promise<HaproxyStream> {
  const probe = await readableProbe(server);
  const stream = probe.streams.find((s) => s.id === id);
  if (!stream) {
    throw new ApiError(`Die TCP-Weiterleitung "${id}" steht nicht in ${HAPROXY_CFG}.`, 404);
  }
  if (!stream.removable) throw new ApiError(notRemovable(stream));
  return stream;
}

/**
 * Ob dieser Port auf DIESER Maschine noch frei ist — für das Formular, während
 * jemand tippt.
 *
 * Beantwortet wird die Frage zweimal: hier für die Eingabe und noch einmal im
 * Lauf innerhalb des Locks. Nur hier wäre sie eine Momentaufnahme von vorhin,
 * nur dort käme sie zu spät, um im Feld zu stehen.
 */
export async function checkStreamPort(
  server: Server,
  port: number,
  exclude?: string
): Promise<{ free: boolean; reason: string | null }> {
  const probe = await readableProbe(server);

  const inConfig = bindConflict(probe.raw, port, exclude);
  if (inConfig) return { free: false, reason: `In der Konfiguration gebunden von "${inConfig}".` };

  const listening = await probeListeningPorts(await getSSHConfig(server));
  if (listening === null) {
    // Unbekannt ist nicht frei. Der Vorgang läuft trotzdem weiter — was die
    // Datei hergibt, ist geprüft —, aber behauptet wird hier nichts.
    return { free: true, reason: 'Ob auf diesem Server etwas darauf lauscht, ließ sich nicht feststellen.' };
  }
  if (listening.includes(port) && !parseBindPorts(probe.raw).some((b) => b.port === port)) {
    return { free: false, reason: 'Auf diesem Server lauscht bereits ein anderer Dienst darauf.' };
  }
  return { free: true, reason: null };
}

/* ── Globale Einstellungen ──
 *
 * Derselbe Vorgang wie bei einem Dienst, nur ohne Zertifikat: prüfen,
 * einsetzen, reloaden, bei einem Fehlschlag zurück. Er läuft über dasselbe Lock
 * und denselben Prüfsummenvergleich — die Datei ist dieselbe, und zwei
 * Schreiber darauf sind zwei Schreiber, egal welcher Teil sie ändert.
 */

/**
 * Was die Einstellungsseite braucht — in EINER Runde.
 *
 * Die DNS-Hooks stehen mit drin, obwohl sie mit `haproxy.cfg` nichts zu tun
 * haben: sie kommen aus derselben Probe, die ohnehin läuft. Eine zweite Runde
 * für eine Frage, die die erste schon bezahlt hat, wäre verschenkt.
 */
export async function readGlobalSettings(
  server: Server
): Promise<{ settings: GlobalSettings; dnsHooks: string[] }> {
  const probe = await readableProbe(server);
  return { settings: parseGlobalSettings(probe.raw), dnsHooks: probe.dnsHooks };
}

export async function precheckSettings(
  server: Server,
  input: GlobalSettingsInput
): Promise<void> {
  const probe = await readableProbe(server);
  // Wirft als HaproxyConfigError bei fehlendem Marker, unbekannten Zeilen im
  // Block oder fehlendem default_404 — bevor irgendetwas geschrieben wird.
  applyGlobalSettings(probe.raw, input);
}

export async function updateGlobalSettings(
  server: Server,
  input: GlobalSettingsInput,
  reporter?: ProvisionReporter
): Promise<ProvisionResult> {
  return withProxyLock(server.$id, async () => {
    const steps = new StepLog(reporter);
    await steps.phase('preflight');

    const ssh = await getSSHConfig(server);
    const probe = await probeProxy(server);
    if (!probe.configReadable) {
      throw new ApiError(`${HAPROXY_CFG} ist nicht lesbar.`);
    }

    const nextConfig = applyGlobalSettings(probe.raw, input);
    if (nextConfig === probe.raw) {
      await steps.push({
        label: 'Keine Änderung',
        ok: true,
        detail: 'Die Konfiguration steht bereits so da. Es wurde nichts geschrieben.',
      });
      return { steps: steps.steps };
    }

    await steps.phase('checking');
    const staged = await stageAndCheck(ssh, nextConfig);
    if (!staged.ok) {
      await steps.push({
        label: 'Neue Konfiguration prüfen',
        ok: false,
        detail: `${staged.detail}. Es wurde nichts eingesetzt, die bestehende Konfiguration ist unverändert.`,
      });
      return { steps: steps.steps };
    }
    await steps.push({ label: 'Neue Konfiguration geprüft', ok: true });

    await steps.phase('installing');
    await installAndReload(ssh, probe.digest, steps);
    return { steps: steps.steps };
  });
}

/* ── Gruppen ──
 *
 * Eine Gruppe ist ein Marker-Paar, also zwei Kommentarzeilen je Teil. Trotzdem
 * läuft sie über denselben Weg wie jeder andere Schreibvorgang: Lock,
 * Prüfsumme, `haproxy -c`, Backup, `cp`, Reload. Ein zweiter, kürzerer
 * Schreibweg „weil es ja nur Kommentare sind" wäre der erste ohne Rollback —
 * und die Datei, in die er schreibt, ist dieselbe.
 */

export async function precheckScope(
  server: Server,
  name: string,
  action: 'add' | 'remove'
): Promise<void> {
  const probe = await readableProbe(server);
  if (action === 'add') addScope(probe.raw, name);
  else removeScope(probe.raw, name, streamsInScope(probe, name));
}

/**
 * Die Kennungen der TCP-Weiterleitungen einer Gruppe.
 *
 * Sie gehen als Parameter in `removeScope`, weil `config.ts` sie nicht selbst
 * lesen kann — `streams.ts` liest seinerseits aus `config.ts`, und ein
 * Import-Kreis wäre das Gegenteil dessen, was die Trennung erreicht. Ohne das
 * ließe sich eine Gruppe entfernen, in der noch ein gebundener Port steht: die
 * Marker verschwänden, der `listen`-Abschnitt bliebe, und niemand fände ihn
 * wieder.
 */
function streamsInScope(probe: ProxyProbe, name: string): string[] {
  return probe.streams
    .filter((stream) => stream.scope?.toUpperCase() === name.toUpperCase())
    .map((stream) => stream.id);
}

export async function updateScopes(
  server: Server,
  name: string,
  action: 'add' | 'remove',
  reporter?: ProvisionReporter
): Promise<ProvisionResult> {
  return withProxyLock(server.$id, async () => {
    const steps = new StepLog(reporter);
    await steps.phase('preflight');

    const ssh = await getSSHConfig(server);
    const probe = await probeProxy(server);
    if (!probe.configReadable) {
      throw new ApiError(`${HAPROXY_CFG} ist nicht lesbar.`);
    }

    const nextConfig =
      action === 'add'
        ? addScope(probe.raw, name)
        : removeScope(probe.raw, name, streamsInScope(probe, name));

    await steps.phase('checking');
    const staged = await stageAndCheck(ssh, nextConfig);
    if (!staged.ok) {
      await steps.push({
        label: 'Neue Konfiguration prüfen',
        ok: false,
        detail: `${staged.detail}. Es wurde nichts eingesetzt, die bestehende Konfiguration ist unverändert.`,
      });
      return { steps: steps.steps };
    }
    await steps.push({ label: 'Neue Konfiguration geprüft', ok: true });

    await steps.phase('installing');
    await installAndReload(ssh, probe.digest, steps);
    return { steps: steps.steps };
  });
}

/** Gibt den Dienst zurück, wie er JETZT dasteht: Domains und Ziele gehen
 *  denormalisiert in die Historie, nach dem Löschen gibt es sie nirgends mehr. */
export async function precheckDelete(server: Server, id: string): Promise<HaproxyService> {
  const probe = await readableProbe(server);
  const service = probe.services.find((s) => s.id === id);
  if (!service) throw new ApiError(`Der Dienst "${id}" steht nicht in ${HAPROXY_CFG}.`, 404);
  if (!service.removable) {
    throw new ApiError(
      `"${id}" wurde nicht über HAPM angelegt und lässt sich hier nicht entfernen. ` +
        'ACL, Weiche oder Backend folgen nicht dem erwarteten Schema.'
    );
  }
  return service;
}

/* ── Fehlerseiten ──
 *
 * Die Dateien hinter den `errorfile`-Zeilen ins Aussehen von HAPM bringen.
 * Was dabei gilt und warum, steht in `error-pages.ts`; hier steht der Vorgang.
 *
 * Synchron wie die DNS-Zugangsdaten und nicht als abgekoppelter Lauf: kein
 * Zertifikat, keine neue Konfiguration, eine Handvoll kleiner Dateien. Einen
 * Reload gibt es trotzdem, denn HAProxy liest die Dateien nur beim Laden ein.
 */

const errorPageDigest = (content: string): string =>
  createHash('sha256').update(content, 'utf8').digest('hex');

async function probeErrorPages(
  ssh: Awaited<ReturnType<typeof getSSHConfig>>,
  config: string
): Promise<ErrorPageEntry[]> {
  const refs = parseErrorFiles(config);
  // Gelesen wird nur, was dieses Werkzeug auch anfassen würde. Ein Pfad
  // außerhalb von /etc/haproxy geht in kein Kommando, auch in kein lesendes.
  const paths = [...new Set(refs.map((ref) => ref.path))].filter(isManageableErrorFile);
  if (paths.length === 0) return planErrorPages(refs, new Map(), new Map(), errorPageDigest);

  const res = await sshExec(
    ssh,
    batchCommands([errorPageFirstLinesCommand(paths), errorPageDigestCommand(paths)]),
    SHORT_MS
  );
  const [lines, sums] = splitSections(res.stdout, 2);
  return planErrorPages(refs, parseFirstLines(lines), parseDigests(sums), errorPageDigest);
}

/** Welche Fehlerdateien die Maschine hat und in welchem Zustand sie sind. */
export async function readErrorPages(server: Server): Promise<ErrorPageEntry[]> {
  const probe = await readableProbe(server);
  return probeErrorPages(await getSSHConfig(server), probe.raw);
}

/**
 * Die Fehlerdateien neu schreiben.
 *
 * Geschrieben wird nur, was `writableErrorPages` nennt: Dateien unter
 * `/etc/haproxy/`, deren eigener Status lesbar ist und für den es eine Seite
 * gibt. Jede wird vorher gesichert. Lehnt `haproxy -c` danach ab oder scheitert
 * der Reload, kommen alle zurück: eine Maschine mit einer kaputten Fehlerdatei
 * startet nicht mehr, und das fiele erst beim nächsten Neustart auf.
 *
 * Zurück kommt neben den Schritten, was die Maschine DANACH über ihre Dateien
 * sagt, nicht was gerade geschickt wurde. Dieselbe Regel wie bei den
 * DNS-Zugangsdaten.
 */
export async function updateErrorPages(
  server: Server
): Promise<{ steps: ProvisionStep[]; entries: ErrorPageEntry[] }> {
  return withProxyLock(server.$id, async () => {
    const steps: ProvisionStep[] = [];
    const ssh = await getSSHConfig(server);
    const probe = await readableProbe(server);
    const before = await probeErrorPages(ssh, probe.raw);
    const targets = writableErrorPages(before);

    if (targets.length === 0) {
      steps.push({
        label: 'Nichts zu schreiben',
        ok: true,
        detail: 'Keine Fehlerdatei weicht von der Vorlage ab.',
      });
      return { steps, entries: before };
    }

    const written: string[] = [];
    const restore = async () => {
      for (const path of written) {
        await sshExec(ssh, errorPageRestoreCommand(path), SHORT_MS).catch(() => null);
      }
    };

    for (const target of targets) {
      const write = await sshExec(
        ssh,
        errorPageWriteCommand(target.path, renderErrorFile(target.status!)),
        SHORT_MS
      );
      if (write.code !== 0) {
        // Auch die gerade angefangene Datei: `tee` kann sie halb geschrieben haben.
        written.push(target.path);
        await restore();
        steps.push({
          label: `${target.path} schreiben`,
          ok: false,
          detail: `${tail(write.stderr)}. Alle Fehlerdateien sind wieder auf dem Stand von vorher.`,
        });
        return { steps, entries: await probeErrorPages(ssh, probe.raw) };
      }
      written.push(target.path);
    }
    steps.push({
      label: `${written.length} Fehlerdatei(en) geschrieben`,
      ok: true,
      detail: targets.map((t) => `${t.path} (${t.status})`).join('\n'),
    });

    const check = await sshExec(ssh, buildCommand(['haproxy', '-c', '-f', HAPROXY_CFG]), SHORT_MS);
    if (check.code !== 0) {
      await restore();
      steps.push({
        label: 'Konfiguration prüfen',
        ok: false,
        detail: `${tail(check.stderr || check.stdout)}. Alle Fehlerdateien sind wieder auf dem Stand von vorher.`,
      });
      return { steps, entries: await probeErrorPages(ssh, probe.raw) };
    }
    steps.push({ label: 'Konfiguration geprüft', ok: true });

    const reload = await sshExec(ssh, buildCommand(RELOAD_ARGV), RELOAD_MS);
    if (reload.code !== 0) {
      await restore();
      await sshExec(ssh, buildCommand(RELOAD_ARGV), RELOAD_MS).catch(() => null);
      steps.push({
        label: 'HAProxy neu laden',
        ok: false,
        detail: `${tail(reload.stderr || reload.stdout)}. Alle Fehlerdateien sind wieder auf dem Stand von vorher.`,
      });
      return { steps, entries: await probeErrorPages(ssh, probe.raw) };
    }
    steps.push({ label: 'HAProxy neu geladen', ok: true });

    return { steps, entries: await probeErrorPages(ssh, probe.raw) };
  });
}
