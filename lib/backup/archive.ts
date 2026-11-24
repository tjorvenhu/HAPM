/**
 * Ein Archiv prüfen, bevor irgendetwas angefasst wird.
 *
 * Gefragt wird viererlei: Lässt es sich ganz lesen (`tar -t` liest bis zum
 * Ende, gzip prüft dabei die Prüfsumme)? Ist es eine Sicherung von HAPM (der
 * Aufbau aus `./run.ts`)? Ist die Datenbank darin vollständig (`pg_dump`
 * schreibt eine Schlusszeile)? Und passt der Schlüssel zu den verschlüsselten
 * Werten der Datenbank, so wie HAPM danach liefe?
 *
 * Die Namen im Archiv tragen teils `./` davor, teils nicht: der Helfer packt
 * den Zwischenordner mit `-C … .`, `/etc/haproxy` und `/root/.acme.sh` dagegen
 * über ihren Namen. Verglichen wird deshalb ohne `./`, gelesen mit dem Namen,
 * wie er im Archiv steht.
 *
 * Kommandos über `lib/shell.ts`, ausgeführt im eigenen Container.
 * `--force-local`, damit GNU tar einen Pfad mit Doppelpunkt nicht für einen
 * entfernten Rechner hält (unter Windows in den Tests: `C:/…`).
 */

import { buildCommand, withEnv } from '../shell';
import { localExec } from '../ssh';
import { msg, type Message } from '../i18n';
import { MANIFEST_NAME, compareVersions, keyFingerprint, parseManifest, type BackupManifest } from './manifest';

export interface ArchiveEntry {
  /** Der Name ohne `./` davor. */
  path: string;
  /** Der Name, wie er im Archiv steht. */
  raw: string;
  type: 'file' | 'dir' | 'symlink' | 'hardlink' | 'other';
  sizeBytes: number;
  /** Zeitpunkt der Datei, wie `tar -tv` ihn zeigt: `JJJJ-MM-TT HH:MM`. */
  mtime: string;
  linkTarget: string | null;
}

export interface ArchiveContents {
  databaseBytes: number;
  haproxyFiles: number;
  certificates: number;
  acmeFiles: number;
}

export interface ArchiveCheck {
  manifest: BackupManifest | null;
  version: string | null;
  /** Aus dem Manifest, als ISO-Zeitpunkt. */
  createdAt: string | null;
  /**
   * Ohne Manifest: aus dem Dateinamen oder dem Zeitpunkt von `database.sql`, in
   * der Uhrzeit des Servers und ohne Zone (`JJJJ-MM-TTTHH:MM:SS`).
   */
  createdLocal: string | null;
  contents: ArchiveContents;
  /** Fingerabdruck des Schlüssels, mit dem HAPM nach dem Zurückspielen läuft. */
  effectiveKeyFingerprint: string;
  warnings: Message[];
  /** Gründe, aus denen nicht zurückgespielt wird. Leer, wenn nichts dagegen spricht. */
  blockers: Message[];
}

export class ArchiveError extends Error {
  constructor(readonly reason: Message, readonly detail = '') {
    super(reason.text);
    this.name = 'ArchiveError';
  }
}

const REQUIRED = ['database.sql', 'data/secrets.json', 'haproxy/haproxy.cfg'] as const;

/** Was ein Name ohne `./` davor ist. Leer für das Archiv selbst (`.`, `./`). */
export function normalizeEntryName(raw: string): string {
  let name = raw;
  while (name.startsWith('./')) name = name.slice(2);
  if (name === '.') return '';
  return name.replace(/\/+$/, '');
}

const LINE = /^([-dlhcbps])\S*\s+\S+\s+(\d+|\d+,\s*\d+)\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}(?::\d{2})?)\s(.*)$/;

/** Die Ausgabe von `LC_ALL=C tar -tzv`. Zeilen in anderer Form werden übergangen. */
export function parseListing(output: string): ArchiveEntry[] {
  const entries: ArchiveEntry[] = [];
  for (const line of output.split('\n')) {
    const match = LINE.exec(line.replace(/\r$/, ''));
    if (!match) continue;
    const [, kind, size, date, time, rest] = match;
    let raw = rest;
    let linkTarget: string | null = null;
    if (kind === 'l') {
      const at = rest.indexOf(' -> ');
      if (at !== -1) {
        raw = rest.slice(0, at);
        linkTarget = rest.slice(at + 4);
      }
    } else if (kind === 'h') {
      const at = rest.indexOf(' link to ');
      if (at !== -1) {
        raw = rest.slice(0, at);
        linkTarget = rest.slice(at + 9);
      }
    }
    const type =
      kind === '-' ? 'file' : kind === 'd' ? 'dir' : kind === 'l' ? 'symlink' : kind === 'h' ? 'hardlink' : 'other';
    entries.push({
      path: normalizeEntryName(raw),
      raw,
      type,
      sizeBytes: type === 'file' ? Number(size) : 0,
      mtime: `${date} ${time.slice(0, 5)}`,
      linkTarget,
    });
  }
  return entries;
}

function escapes(target: string): boolean {
  return target.startsWith('/') || target.split('/').includes('..');
}

/**
 * Aufbau und Sicherheit der Namen. Ausgepackt wird später als root: ein Name,
 * der aus dem Ordner hinausführt, ein Verweis nach `/etc` oder ein Gerät haben
 * in einer Sicherung nichts verloren.
 */
export function checkEntries(entries: ArchiveEntry[]): { error: Message } | { contents: ArchiveContents } {
  const unsafe = entries.some(
    (entry) =>
      escapes(entry.path) ||
      entry.type === 'other' ||
      ((entry.type === 'symlink' || entry.type === 'hardlink') && (!entry.linkTarget || escapes(entry.linkTarget)))
  );
  if (unsafe) {
    return {
      error: msg(
        'Das Archiv enthält Namen außerhalb seines Ordners, Verweise dorthin oder Geräte. HAPM spielt es nicht zurück.'
      ),
    };
  }

  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const known = REQUIRED.filter((name) => byPath.get(name)?.type === 'file');
  if (known.length === 0 && !entries.some((entry) => entry.path === '.acme.sh' || entry.path.startsWith('.acme.sh/'))) {
    return { error: msg('Das ist keine Sicherung von HAPM. Es fehlen Datenbank, Schlüssel und Konfiguration.') };
  }
  for (const name of REQUIRED) {
    if (byPath.get(name)?.type !== 'file') {
      return { error: msg('Im Archiv fehlt {file}. Eine Sicherung von HAPM enthält es immer.', { file: name }) };
    }
  }
  if (!entries.some((entry) => entry.path === '.acme.sh' || entry.path.startsWith('.acme.sh/'))) {
    return { error: msg('Im Archiv fehlt {file}. Eine Sicherung von HAPM enthält es immer.', { file: '.acme.sh/' }) };
  }

  const files = entries.filter((entry) => entry.type === 'file');
  return {
    contents: {
      databaseBytes: byPath.get('database.sql')!.sizeBytes,
      haproxyFiles: files.filter((entry) => entry.path.startsWith('haproxy/')).length,
      certificates: files.filter((entry) => /^haproxy\/certs\/[^/]+\.pem$/.test(entry.path)).length,
      acmeFiles: files.filter((entry) => entry.path.startsWith('.acme.sh/')).length,
    },
  };
}

/** Der Zeitpunkt aus `hapm-backup-JJJJMMTT-HHMMSS….tar.gz`, ohne Zone. */
export function createdFromName(name: string): string | null {
  const match = /hapm-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
}

/**
 * Der Schlüssel. Nach dem Zurückspielen läuft HAPM mit `ENCRYPTION_KEY` aus der
 * Umgebung, falls gesetzt, sonst mit dem aus `data/secrets.json` im Archiv. Die
 * Werte in der Datenbank sind mit dem Schlüssel verschlüsselt, den das Manifest
 * nennt. Passen beide nicht, wären zweiter Faktor, DNS-Tokens und
 * SMTP-Passwort danach nicht mehr lesbar: das wird nicht zurückgespielt.
 * Ohne Manifest ist der Schlüssel der Sicherung unbekannt, dann bleibt es bei
 * einer Warnung, falls die Umgebung etwas setzt.
 */
export function assessKey(input: {
  manifest: BackupManifest | null;
  fileKey: string;
  envKey: string | null;
}): { effective: string; warnings: Message[]; blockers: Message[] } {
  const effective = keyFingerprint(input.envKey || input.fileKey);
  const warnings: Message[] = [];
  const blockers: Message[] = [];
  const expected = input.manifest?.keyFingerprint || null;

  if (expected) {
    if (expected !== effective) {
      blockers.push(
        msg(
          'Der Schlüssel, mit dem HAPM danach liefe, ist nicht der, mit dem die Datenbank der Sicherung verschlüsselt ist. Zweiter Faktor, DNS-Tokens und SMTP-Passwort wären nicht mehr lesbar.'
        )
      );
      if (input.envKey) {
        blockers.push(
          msg(
            'ENCRYPTION_KEY ist am Container gesetzt und gilt vor dem Schlüssel aus dem Archiv. Entfernen Sie die Variable oder setzen Sie sie auf den Schlüssel der Sicherung, dann prüfen Sie erneut.'
          )
        );
      } else if (input.manifest?.keyFromEnvironment) {
        blockers.push(
          msg(
            'Die Sicherung wurde mit ENCRYPTION_KEY aus der Umgebung geschrieben. Setzen Sie die Variable am Container auf diesen Schlüssel, dann prüfen Sie erneut.'
          )
        );
      }
    }
  } else if (input.envKey && keyFingerprint(input.envKey) !== keyFingerprint(input.fileKey)) {
    warnings.push(
      msg(
        'ENCRYPTION_KEY ist am Container gesetzt und gilt auch nach dem Zurückspielen. Diese Sicherung nennt ihren Schlüssel nicht. Stammt sie von einer Installation mit anderem Schlüssel, sind zweiter Faktor, DNS-Tokens und SMTP-Passwort danach nicht lesbar.'
      )
    );
  }
  return { effective, warnings, blockers };
}

function tarArgs(file: string, ...rest: string[]): string[] {
  return ['tar', '--force-local', ...rest, file];
}

async function run(command: string, timeoutMs = 10 * 60 * 1000) {
  return localExec(command, timeoutMs);
}

async function readMember(file: string, member: string, limit: number): Promise<string | null> {
  const command =
    'set -o pipefail; ' +
    `${withEnv({ LC_ALL: 'C' }, [...tarArgs(file, '-xzO', '-f'), member])} | ${buildCommand(['head', '-c', String(limit)])}`;
  const result = await run(command);
  return result.code === 0 ? result.stdout : null;
}

/**
 * Prüft das Archiv unter `file` (ein Pfad im Container). Wirft `ArchiveError`,
 * wenn es keines ist, das HAPM zurückspielen kann.
 */
export async function inspectArchive(
  file: string,
  options: { name: string; currentVersion: string | null; envKey: string | null }
): Promise<ArchiveCheck> {
  // `-f` steht in `tarArgs` vor dem Pfad, alle Schalter davor.
  const listing = await run(withEnv({ LC_ALL: 'C' }, tarArgs(file, '-tzv', '-f')));
  if (listing.code !== 0) {
    throw new ArchiveError(
      msg('Das Archiv lässt sich nicht vollständig lesen. Es ist beschädigt, unvollständig oder kein .tar.gz-Archiv.'),
      listing.stderr.trim().slice(-400)
    );
  }
  const entries = parseListing(listing.stdout);
  const checked = checkEntries(entries);
  if ('error' in checked) throw new ArchiveError(checked.error);
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));

  const tail = await run(
    'set -o pipefail; ' +
      `${withEnv({ LC_ALL: 'C' }, [...tarArgs(file, '-xzO', '-f'), byPath.get('database.sql')!.raw])} | ` +
      buildCommand(['tail', '-c', '4096'])
  );
  if (tail.code !== 0 || !tail.stdout.includes('PostgreSQL database dump complete')) {
    throw new ArchiveError(
      msg('Die Datenbank im Archiv ist unvollständig: die Schlusszeile von pg_dump fehlt.'),
      tail.stderr.trim().slice(-400)
    );
  }

  const secretsText = await readMember(file, byPath.get('data/secrets.json')!.raw, 64 * 1024);
  let fileKey: string | null = null;
  try {
    const parsed = JSON.parse(secretsText ?? '') as { encryptionKey?: unknown };
    if (typeof parsed.encryptionKey === 'string' && parsed.encryptionKey) fileKey = parsed.encryptionKey;
  } catch {
    // Unten gemeldet.
  }
  if (!fileKey) throw new ArchiveError(msg('Der Schlüssel im Archiv (data/secrets.json) ist nicht lesbar.'));

  let manifest: BackupManifest | null = null;
  const manifestEntry = byPath.get(MANIFEST_NAME);
  if (manifestEntry?.type === 'file') {
    const text = await readMember(file, manifestEntry.raw, 64 * 1024);
    manifest = text ? parseManifest(text) : null;
  }

  const warnings: Message[] = [];
  if (manifest?.version && options.currentVersion) {
    if (compareVersions(manifest.version, options.currentVersion) === 1) {
      warnings.push(
        msg('Die Sicherung stammt aus HAPM {archive}. Hier läuft die ältere Fassung {current}.', {
          archive: manifest.version,
          current: options.currentVersion,
        })
      );
    }
  }
  const key = assessKey({ manifest, fileKey, envKey: options.envKey });

  const database = byPath.get('database.sql')!;
  return {
    manifest,
    version: manifest?.version ?? null,
    createdAt: manifest?.createdAt ?? null,
    createdLocal: manifest
      ? null
      : (createdFromName(options.name) ?? `${database.mtime.replace(' ', 'T')}:00`),
    contents: checked.contents,
    effectiveKeyFingerprint: key.effective,
    warnings: [...warnings, ...key.warnings],
    blockers: key.blockers,
  };
}
