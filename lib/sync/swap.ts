/**
 * Einen neuen Stand in einen Ordner bringen und wieder herausnehmen.
 *
 * Derselbe Gedanke wie beim Zurückspielen einer Sicherung
 * (`lib/backup/restore-script.ts`): der neue Stand liegt zuerst vollständig
 * daneben (`.hapm-sync-new`), dann wird getauscht, der alte geht nach
 * `.hapm-sync-old`. Beides sind Umbenennungen innerhalb des Ordners, also auf
 * demselben Dateisystem, und dauern Millisekunden. Erst wenn HAProxy den neuen
 * Stand geprüft und geladen hat, verschwindet der alte.
 *
 * Getauscht werden die Einträge der obersten Ebene und nicht der Ordner
 * selbst: `/etc/haproxy` ist ein eingebundenes Volume und lässt sich nicht
 * umbenennen. Was auf der Ausschlussliste steht (`bundle.ts`), bleibt liegen,
 * ebenso alles, was weder Datei noch Ordner ist.
 *
 * Danach ist der Ordner ein Abbild des Pakets: was der Hauptknoten nicht mehr
 * hat (ein entferntes Zertifikat), gibt es hier auch nicht mehr.
 *
 * Rein bis auf `node:fs`, damit `tests/sync/swap.test.ts` jeden Ausgang über
 * ein Temp-Verzeichnis nachrechnen kann.
 */

import fs from 'node:fs';
import path from 'node:path';
import { STAGE_NEW, STAGE_OLD, entryKey, isExcluded, isExcludedPath, type BundleEntry, type RootName } from './bundle';

/** Ob ein Eintrag der obersten Ebene beim Tausch liegen bleibt. */
function staysInPlace(root: RootName, dir: string, name: string): boolean {
  if (name === STAGE_NEW || name === STAGE_OLD || name === STAGE_DONE || isExcluded(root, name)) return true;
  try {
    const stat = fs.lstatSync(path.join(dir, name));
    return !stat.isFile() && !stat.isDirectory();
  } catch {
    return true;
  }
}

function movable(root: RootName, dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => !staysInPlace(root, dir, name));
}

/**
 * Was auf diesem Knoten unter einem Ordner liegt, der getauscht wird, selbst
 * aber nie übertragen wird (`hapm-crowdsec/spoe.cfg`). Es zieht in den neuen
 * Stand um, sonst wäre es nach dem Tausch weg.
 */
function nestedLocalFiles(root: RootName, dir: string): string[] {
  const found: string[] = [];
  const walk = (relative: string) => {
    for (const name of fs.readdirSync(path.join(dir, relative))) {
      const rel = `${relative}/${name}`;
      if (isExcluded(root, rel)) {
        found.push(rel);
        continue;
      }
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(path.join(dir, rel));
      } catch {
        continue;
      }
      if (stat.isDirectory()) walk(rel);
    }
  };
  for (const name of movable(root, dir)) {
    try {
      if (fs.lstatSync(path.join(dir, name)).isDirectory()) walk(name);
    } catch {
      // Gerade verschwunden.
    }
  }
  return found;
}

/**
 * Den neuen Stand eines Ordners vollständig nach `.hapm-sync-new` schreiben.
 * Am gültigen Stand ändert das nichts.
 *
 * Geschrieben wird nur unter dem frisch angelegten Ordner. Die Pfade sind in
 * `unpack` geprüft, hier noch einmal gegen den Zielordner: ein Fehler dort soll
 * nicht hier eine Datei außerhalb anlegen.
 */
export function stage(root: RootName, dir: string, entries: readonly BundleEntry[], contents: ReadonlyMap<string, Buffer>): void {
  const target = path.join(dir, STAGE_NEW);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { mode: 0o700 });
  const inside = (rel: string) => {
    const full = path.resolve(target, ...rel.split('/'));
    if (full !== target && !full.startsWith(target + path.sep)) throw new Error(`Der Pfad ${rel} führt aus dem Ordner hinaus.`);
    return full;
  };

  for (const entry of entries) {
    if (entry.root !== root) continue;
    if (isExcludedPath(root, entry.path)) throw new Error(`${entry.path} wird nie übertragen.`);
    const full = inside(entry.path);
    if (entry.type === 'dir') {
      fs.mkdirSync(full, { mode: entry.mode || 0o755 });
      continue;
    }
    const content = contents.get(entryKey(entry));
    if (!content) throw new Error(`Zu ${entry.path} fehlt der Inhalt.`);
    // `wx`: nie über etwas schreiben, das schon da ist. Im frischen Ordner gibt es das nicht.
    fs.writeFileSync(full, content, { mode: entry.mode || 0o600, flag: 'wx' });
  }

  for (const rel of nestedLocalFiles(root, dir)) {
    const full = inside(rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.cpSync(path.join(dir, rel), full, { recursive: true, force: true });
  }
}

/**
 * Tauschen: der bisherige Stand nach `.hapm-sync-old`, der neue an seine
 * Stelle. Scheitert eine Umbenennung, steht danach wieder der bisherige Stand,
 * und der Fehler wird geworfen.
 */
export function swapIn(root: RootName, dir: string): void {
  const fresh = path.join(dir, STAGE_NEW);
  const old = path.join(dir, STAGE_OLD);
  if (!fs.existsSync(fresh)) throw new Error(`${fresh} fehlt: es liegt kein neuer Stand bereit.`);
  if (fs.existsSync(old)) throw new Error(`${old} liegt noch da: ein früherer Abgleich wurde nicht abgeschlossen.`);
  fs.mkdirSync(old, { mode: 0o700 });

  const movedOut: string[] = [];
  const movedIn: string[] = [];
  try {
    for (const name of movable(root, dir)) {
      fs.renameSync(path.join(dir, name), path.join(old, name));
      movedOut.push(name);
    }
    for (const name of fs.readdirSync(fresh)) {
      fs.renameSync(path.join(fresh, name), path.join(dir, name));
      movedIn.push(name);
    }
    fs.rmdirSync(fresh);
  } catch (err) {
    for (const name of movedIn.reverse()) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    for (const name of movedOut.reverse()) fs.renameSync(path.join(old, name), path.join(dir, name));
    fs.rmSync(old, { recursive: true, force: true });
    fs.rmSync(fresh, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Zurücktauschen: was aus `.hapm-sync-old` kommt, gilt wieder. Der neue Stand
 * wird verworfen, er liegt im Paket ohnehin noch einmal vor.
 */
export function swapBack(root: RootName, dir: string): void {
  const old = path.join(dir, STAGE_OLD);
  if (!fs.existsSync(old)) return;
  for (const name of movable(root, dir)) fs.rmSync(path.join(dir, name), { recursive: true, force: true });
  for (const name of fs.readdirSync(old)) fs.renameSync(path.join(old, name), path.join(dir, name));
  fs.rmdirSync(old);
  fs.rmSync(path.join(dir, STAGE_NEW), { recursive: true, force: true });
}

/** Wohin der alte Stand geht, sobald der neue gilt. Nur noch zum Wegräumen. */
const STAGE_DONE = '.hapm-sync-done';

/**
 * Der neue Stand gilt: den alten wegräumen.
 *
 * Erst umbenennen, dann löschen. Solange `.hapm-sync-old` da liegt, gilt ein
 * Abgleich als abgebrochen (`recoverInterrupted`). Bräche das Löschen auf
 * halbem Weg ab, käme sonst beim nächsten Start ein halber alter Stand zurück.
 */
export function commit(dir: string): void {
  const old = path.join(dir, STAGE_OLD);
  const doneDir = path.join(dir, STAGE_DONE);
  fs.rmSync(doneDir, { recursive: true, force: true });
  if (fs.existsSync(old)) fs.renameSync(old, doneDir);
  fs.rmSync(doneDir, { recursive: true, force: true });
  fs.rmSync(path.join(dir, STAGE_NEW), { recursive: true, force: true });
}

/**
 * Nach einem Abbruch mitten im Tausch (HAPM wurde beendet): liegt
 * `.hapm-sync-old` noch da, hat HAProxy den neuen Stand nie bestätigt. Dann
 * gilt wieder der alte. `true`, wenn etwas zurückgetauscht wurde.
 */
export function recoverInterrupted(root: RootName, dir: string): boolean {
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(path.join(dir, STAGE_DONE), { recursive: true, force: true });
  const interrupted = fs.existsSync(path.join(dir, STAGE_OLD));
  if (interrupted) swapBack(root, dir);
  else fs.rmSync(path.join(dir, STAGE_NEW), { recursive: true, force: true });
  return interrupted;
}
