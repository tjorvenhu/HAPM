/**
 * Das Paket, das ein Hauptknoten an seine Folgeknoten schickt: was darin
 * steht, wie es gepackt und wie es beim Auspacken geprüft wird.
 *
 * ── Alles außer einer kurzen Liste ──
 *
 * Übertragen wird, was HAProxy zum Ausliefern braucht (`/etc/haproxy`) und was
 * acme.sh zum Erneuern braucht (`/root/.acme.sh`). Beschrieben ist das als
 * Ausschlussliste und nicht als Liste der Ordner: ein Ordner, den eine spätere
 * Fassung von HAPM dort anlegt, geht damit von selbst mit, statt vergessen zu
 * werden. Was auf der Liste steht, steht dort mit Grund (`EXCLUDED`).
 *
 * Dazu kommt der Datenteil (`data.ts`): Konten, Einstellungen, DNS-Zonen,
 * API-Keys und von CrowdSec, was jemand eingestellt hat. Nicht im Paket: der
 * Rest der Datenbank (Statistik, Protokoll, Historie) und `secrets.json`.
 *
 * ── Die Form ──
 *
 * Vier Bytes Länge, ein Kopf als JSON (Angaben zum Absender, der Datenteil, je
 * Datei Pfad, Größe und SHA-256), dahinter die Inhalte in der Reihenfolge des
 * Kopfs, das Ganze mit gzip gepackt. Eine eigene Form statt tar, weil der Empfänger jede
 * Zeile des Kopfs prüft, bevor er ein Byte schreibt: nur Dateien und Ordner,
 * keine Verweise, keine Pfade nach außen.
 *
 * ── Dem Paket wird nicht getraut ──
 *
 * Es kommt verschlüsselt von jemandem mit dem Kopplungsschlüssel. Geprüft wird
 * trotzdem: ein Pfad mit `..`, ein absoluter Pfad, ein Pfad auf der
 * Ausschlussliste (dort liegt auf dem Folgeknoten acme.sh selbst, das HAPM als
 * root ausführt) oder eine Prüfsumme, die nicht stimmt, und das ganze Paket
 * wird abgelehnt. Der Preis für einen Fehler im Packen soll eine Meldung sein
 * und keine Datei an falscher Stelle.
 *
 * Rein bis auf `node:fs`, `node:zlib` und `node:crypto`: kein `lib/db`, kein
 * Docker. `tests/sync/bundle.test.ts` rechnet alles über Temp-Verzeichnisse nach.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { SyncDataError, crowdsecFingerprint, dataFingerprint, parseSyncData, type SyncData } from './data';
import { SYNC_PROTOCOL } from './types';

export const ROOT_NAMES = ['haproxy', 'acme'] as const;
export type RootName = (typeof ROOT_NAMES)[number];

/** Die Ordner im Container von HAPM. Dieselben Pfade auf jedem Knoten. */
export const ROOT_DIRS: Record<RootName, string> = {
  haproxy: '/etc/haproxy',
  acme: '/root/.acme.sh',
};

/** Wo ein neuer Stand liegt, bevor er getauscht wird, und wohin der alte geht. */
export const STAGE_NEW = '.hapm-sync-new';
export const STAGE_OLD = '.hapm-sync-old';

/**
 * Was nicht übertragen wird. Geprüft wird der Pfad unter dem Ordner, mit `/`
 * getrennt. Ein ausgeschlossener Ordner schließt alles darunter aus.
 */
export const EXCLUDED: Record<RootName, readonly { pattern: RegExp; reason: string }[]> = {
  haproxy: [
    { pattern: /^haproxy\.cfg\.backup-[^/]*$/, reason: 'Sicherungskopien, die jeder Schreibvorgang anlegt' },
    { pattern: /(^|\/)[^/]*\.hapm-new$/, reason: 'vorläufige Dateien eines laufenden Vorgangs' },
    { pattern: /^[^/]*\.hapm-previous$/, reason: 'Zwischenstände beim Hochladen und Entfernen von Zertifikaten' },
    { pattern: /^\.hapm-[^/]*$/, reason: 'Ordner des Zurückspielens und des Abgleichs selbst' },
    // Jeder Knoten schreibt sie bei seinem Start aus dem eigenen Code neu
    // (`lib/bootstrap.ts`). Aus dem Paket käme nach einem Update des einen
    // Knotens die Fassung des anderen zurück.
    { pattern: /^hapm-crowdsec\/spoe\.cfg$/, reason: 'die SPOE-Datei schreibt jeder Knoten selbst' },
  ],
  acme: [
    // Das Programm installiert und aktualisiert jeder Knoten selbst
    // (`ensureAcme`, „Updates"). Aus dem Paket käme nach jedem Update dort die
    // Fassung von hier zurück, und umgekehrt führt HAPM diese Dateien als root aus.
    { pattern: /^(acme\.sh|acme\.sh\.env|dnsapi|deploy|notify)$/, reason: 'acme.sh selbst, je Knoten installiert' },
    { pattern: /^http\.header$/, reason: 'Arbeitsdatei von acme.sh' },
    { pattern: /(^|\/)[^/]*\.hapm-new$/, reason: 'vorläufige Dateien eines laufenden Vorgangs' },
    { pattern: /^\.hapm-[^/]*$/, reason: 'Ordner des Zurückspielens und des Abgleichs selbst' },
  ],
};

export function isExcluded(root: RootName, relative: string): boolean {
  return EXCLUDED[root].some((entry) => entry.pattern.test(relative));
}

/** Ob ein Pfad oder einer seiner Ordner darüber ausgeschlossen ist. */
export function isExcludedPath(root: RootName, relative: string): boolean {
  const parts = relative.split('/');
  for (let i = 1; i <= parts.length; i++) {
    if (isExcluded(root, parts.slice(0, i).join('/'))) return true;
  }
  return false;
}

export interface BundleEntry {
  root: RootName;
  /** Unter dem Ordner, mit `/` getrennt: `certs/example.org.pem`. */
  path: string;
  type: 'file' | 'dir';
  /** Die Rechte der Datei (unterste neun Bits). */
  mode: number;
  size: number;
  /** SHA-256 des Inhalts, bei einem Ordner leer. */
  sha256: string;
}

export interface BundleSender {
  nodeId: string;
  name: string;
  hapmVersion: string;
  haproxyVersion: string | null;
  exposure: string;
  /** Ob `haproxy.cfg` CrowdSec benutzt. */
  usesCrowdsec: boolean;
}

export interface BundleMeta {
  protocol: number;
  /** Laufende Nummer: die Uhrzeit des Packens in Millisekunden. Ein Folgeknoten nimmt keine kleinere als die letzte. */
  seq: number;
  fingerprint: string;
  /** Fingerabdruck des Datenteils ohne CrowdSec. `null`: das Paket trägt nur Dateien. */
  dataFingerprint: string | null;
  /** Fingerabdruck des Teils für CrowdSec. `null`: er fehlt, der Folgeknoten behält, was er hat. */
  crowdsecFingerprint: string | null;
  sender: BundleSender;
  /** Die Ordner, die es beim Absender gab. Nur diese werden beim Empfänger getauscht. */
  roots: RootName[];
  /** Was beim Packen übergangen wurde, weil es weder Datei noch Ordner ist. */
  skipped: string[];
}

export interface Collected {
  entries: BundleEntry[];
  /** Inhalt je Datei, Schlüssel `entryKey`. */
  contents: Map<string, Buffer>;
  roots: RootName[];
  skipped: string[];
}

export function entryKey(entry: Pick<BundleEntry, 'root' | 'path'>): string {
  return `${entry.root}:${entry.path}`;
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Mehr trägt ein Paket nicht. Ein Proxy mit tausend Zertifikaten liegt bei wenigen Megabyte. */
export const MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 50_000;

export class BundleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BundleError';
  }
}

function gone(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

/**
 * Die Dateien eines Knotens einsammeln, ohne die Ausschlussliste.
 *
 * Verweise und Sonderdateien (Sockets, Geräte) gehen nicht mit und stehen in
 * `skipped`: einem Verweis zu folgen hieße, beim Empfänger eine Datei mit
 * fremdem Inhalt anzulegen, und ihn als Verweis zu übertragen, dort auf etwas
 * zu zeigen, das es nicht gibt.
 */
export function collect(dirs: Partial<Record<RootName, string>> = ROOT_DIRS): Collected {
  const entries: BundleEntry[] = [];
  const contents = new Map<string, Buffer>();
  const roots: RootName[] = [];
  const skipped: string[] = [];
  let total = 0;

  const walk = (root: RootName, base: string, relative: string) => {
    const names = fs.readdirSync(relative ? path.join(base, relative) : base).sort();
    for (const name of names) {
      const rel = relative ? `${relative}/${name}` : name;
      if (isExcluded(root, rel)) continue;
      const absolute = path.join(base, rel);
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(absolute);
      } catch (err) {
        // Zwischen Auflisten und Lesen verschwunden: dann gehört es nicht zum Stand.
        if (gone(err)) continue;
        throw err;
      }
      if (stat.isDirectory()) {
        entries.push({ root, path: rel, type: 'dir', mode: stat.mode & 0o777, size: 0, sha256: '' });
        walk(root, base, rel);
      } else if (stat.isFile()) {
        let content: Buffer;
        try {
          content = fs.readFileSync(absolute);
        } catch (err) {
          if (gone(err)) continue;
          // Jeder andere Fehler bricht ab. Eine Datei, die sich nur gerade nicht
          // lesen ließ, fehlte sonst im Paket, und der Folgeknoten räumte sie weg.
          throw err;
        }
        total += content.length;
        if (total > MAX_BUNDLE_BYTES) {
          throw new BundleError(`Der Stand ist größer als ${Math.round(MAX_BUNDLE_BYTES / 1024 / 1024)} MB. So viel überträgt der Abgleich nicht.`);
        }
        const entry: BundleEntry = { root, path: rel, type: 'file', mode: stat.mode & 0o777, size: content.length, sha256: sha256(content) };
        entries.push(entry);
        contents.set(entryKey(entry), content);
      } else {
        skipped.push(`${root}/${rel}`);
      }
      if (entries.length > MAX_ENTRIES) {
        throw new BundleError(`Der Stand hat mehr als ${MAX_ENTRIES} Dateien. So viele überträgt der Abgleich nicht.`);
      }
    }
  };

  for (const root of ROOT_NAMES) {
    const dir = dirs[root];
    if (!dir || !fs.existsSync(dir)) continue;
    roots.push(root);
    walk(root, dir, '');
  }
  return { entries, contents, roots, skipped };
}

/**
 * Der Fingerabdruck eines Stands: eine Zeile je Eintrag, sortiert, darüber
 * SHA-256. Rechte und Zeitstempel gehören nicht dazu. Ein `chmod` oder ein
 * `touch` ist kein anderer Stand, und ein Neustart von HAPM fasst
 * `account.conf` an, ohne etwas daran zu ändern.
 */
export function fingerprintOf(entries: readonly Pick<BundleEntry, 'root' | 'path' | 'type' | 'sha256'>[]): string {
  const lines = entries
    .map((entry) => `${entry.root}\0${entry.path}\0${entry.type}\0${entry.type === 'file' ? entry.sha256 : ''}`)
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Nur der Fingerabdruck, ohne die Inhalte im Speicher zu behalten. */
export function localFingerprint(dirs: Partial<Record<RootName, string>> = ROOT_DIRS): string {
  return fingerprintOf(collect(dirs).entries);
}

/**
 * Ein Pfad, wie er in einem Paket stehen darf: relativ, mit `/` getrennt, ohne
 * leere Teile, ohne `.` und `..`.
 */
export function validEntryPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024) return false;
  if (value.includes('\0') || value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) return false;
  return value.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && part.length <= 255);
}

interface BundleHead {
  v: number;
  meta: BundleMeta;
  /** `null`: nur Dateien (Prüfskripte). Im Betrieb packt `send.ts` immer mit Daten. */
  data: SyncData | null;
  entries: BundleEntry[];
}

export function pack(
  meta: Omit<BundleMeta, 'protocol' | 'fingerprint' | 'dataFingerprint' | 'crowdsecFingerprint' | 'roots' | 'skipped'>,
  collected: Collected,
  data: SyncData | null = null
): { bundle: Buffer; meta: BundleMeta } {
  const full: BundleMeta = {
    ...meta,
    protocol: SYNC_PROTOCOL,
    fingerprint: fingerprintOf(collected.entries),
    dataFingerprint: data ? dataFingerprint(data) : null,
    crowdsecFingerprint: data?.crowdsec ? crowdsecFingerprint(data.crowdsec) : null,
    roots: collected.roots,
    skipped: collected.skipped,
  };
  const head = Buffer.from(JSON.stringify({ v: SYNC_PROTOCOL, meta: full, data, entries: collected.entries } satisfies BundleHead), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(head.length);
  const files = collected.entries
    .filter((entry) => entry.type === 'file')
    .map((entry) => collected.contents.get(entryKey(entry)) ?? Buffer.alloc(0));
  return { bundle: gzipSync(Buffer.concat([length, head, ...files])), meta: full };
}

export interface Unpacked {
  meta: BundleMeta;
  /** Der geprüfte Datenteil. `null`: das Paket trägt nur Dateien. */
  data: SyncData | null;
  entries: BundleEntry[];
  contents: Map<string, Buffer>;
}

function fail(message: string): never {
  throw new BundleError(message);
}

/**
 * Ein Paket lesen und jede Angabe darin prüfen. Wirft `BundleError` mit dem
 * Grund, geschrieben wird hier nichts.
 */
export function unpack(bundle: Buffer): Unpacked {
  let raw: Buffer;
  try {
    // Die Obergrenze gilt für das Ausgepackte: ein kleines Paket darf sich nicht zu Gigabytes entfalten.
    raw = gunzipSync(bundle, { maxOutputLength: MAX_BUNDLE_BYTES + 64 * 1024 * 1024 });
  } catch {
    fail('Das Paket lässt sich nicht auspacken.');
  }
  if (raw.length < 4) fail('Das Paket ist leer.');
  const headLength = raw.readUInt32BE(0);
  if (headLength <= 0 || 4 + headLength > raw.length) fail('Der Kopf des Pakets ist unvollständig.');

  let head: BundleHead;
  try {
    head = JSON.parse(raw.subarray(4, 4 + headLength).toString('utf8')) as BundleHead;
  } catch {
    fail('Der Kopf des Pakets ist nicht lesbar.');
  }
  if (!head || typeof head !== 'object' || !head.meta || !Array.isArray(head.entries)) fail('Der Kopf des Pakets hat nicht die erwartete Form.');
  if (head.v !== SYNC_PROTOCOL || head.meta.protocol !== SYNC_PROTOCOL) {
    fail(`Das Paket hat die Fassung ${String(head.v)}, dieser Knoten versteht ${SYNC_PROTOCOL}.`);
  }
  const meta = head.meta;
  if (!Number.isSafeInteger(meta.seq) || meta.seq <= 0) fail('Dem Paket fehlt die laufende Nummer.');
  if (typeof meta.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(meta.fingerprint)) fail('Dem Paket fehlt der Fingerabdruck.');
  const sender = meta.sender;
  if (!sender || typeof sender.nodeId !== 'string' || !/^[0-9a-f]{16,64}$/.test(sender.nodeId) || typeof sender.name !== 'string') {
    fail('Dem Paket fehlt der Absender.');
  }
  if (!Array.isArray(meta.roots) || meta.roots.some((root) => !(ROOT_NAMES as readonly string[]).includes(root))) {
    fail('Das Paket nennt einen Ordner, den dieser Knoten nicht kennt.');
  }
  if (head.entries.length > MAX_ENTRIES) fail('Das Paket hat zu viele Einträge.');

  const entries: BundleEntry[] = [];
  const contents = new Map<string, Buffer>();
  const kinds = new Map<string, 'file' | 'dir'>();
  let offset = 4 + headLength;

  for (const given of head.entries) {
    if (!given || typeof given !== 'object') fail('Ein Eintrag des Pakets ist nicht lesbar.');
    const { root, path: rel, type } = given;
    if (!meta.roots.includes(root)) fail('Ein Eintrag liegt in einem Ordner, den das Paket nicht nennt.');
    if (!validEntryPath(rel)) fail(`Unzulässiger Pfad im Paket: ${JSON.stringify(rel).slice(0, 200)}`);
    if (type !== 'file' && type !== 'dir') fail(`Im Paket steht etwas, das weder Datei noch Ordner ist: ${root}/${rel}`);
    if (isExcludedPath(root, rel)) fail(`Das Paket enthält ${root}/${rel}. Das überträgt der Abgleich nie.`);
    const key = entryKey({ root, path: rel });
    if (kinds.has(key)) fail(`${root}/${rel} steht zweimal im Paket.`);
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : null;
    if (parent !== null && kinds.get(entryKey({ root, path: parent })) !== 'dir') {
      fail(`Der Ordner über ${root}/${rel} steht nicht vor ihm im Paket.`);
    }
    const mode = Number.isInteger(given.mode) ? given.mode & 0o777 : type === 'dir' ? 0o755 : 0o600;
    kinds.set(key, type);

    if (type === 'dir') {
      entries.push({ root, path: rel, type, mode, size: 0, sha256: '' });
      continue;
    }
    const size = given.size;
    if (!Number.isSafeInteger(size) || size < 0 || offset + size > raw.length) fail(`${root}/${rel}: die Größe passt nicht zum Paket.`);
    const content = raw.subarray(offset, offset + size);
    offset += size;
    const digest = sha256(content);
    if (digest !== given.sha256) fail(`${root}/${rel}: die Prüfsumme stimmt nicht.`);
    entries.push({ root, path: rel, type, mode, size, sha256: digest });
    contents.set(key, content);
  }
  if (offset !== raw.length) fail('Das Paket enthält mehr, als sein Kopf nennt.');
  if (fingerprintOf(entries) !== meta.fingerprint) fail('Der Fingerabdruck des Pakets passt nicht zu seinem Inhalt.');
  if (!meta.roots.includes('haproxy') || kinds.get('haproxy:haproxy.cfg') !== 'file') fail('Im Paket fehlt haproxy.cfg.');

  let data: SyncData | null = null;
  if (head.data !== null && head.data !== undefined) {
    try {
      data = parseSyncData(head.data);
    } catch (err) {
      if (err instanceof SyncDataError) fail(err.message);
      throw err;
    }
  }
  // Aus dem geprüften Inhalt gerechnet, nicht aus dem Kopf übernommen: danach
  // entscheidet der Hauptknoten, ob dieser Knoten den Stand trägt.
  const dataPrint = data ? dataFingerprint(data) : null;
  const crowdsecPrint = data?.crowdsec ? crowdsecFingerprint(data.crowdsec) : null;
  if ((meta.dataFingerprint ?? null) !== dataPrint || (meta.crowdsecFingerprint ?? null) !== crowdsecPrint) {
    fail('Der Fingerabdruck des Datenteils passt nicht zu seinem Inhalt.');
  }

  return {
    meta: {
      ...meta,
      dataFingerprint: dataPrint,
      crowdsecFingerprint: crowdsecPrint,
      skipped: Array.isArray(meta.skipped) ? meta.skipped.map(String).slice(0, 50) : [],
    },
    data,
    entries,
    contents,
  };
}
