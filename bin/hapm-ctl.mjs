#!/usr/bin/env node
// @ts-check
/**
 * Das Kommando, mit dem der HAPM-Container sein HAProxy erreicht.
 *
 *   hapm-ctl haproxy <argumente>   führt `haproxy <argumente>` im HAProxy-Container aus
 *   hapm-ctl reload                lädt HAProxy neu und meldet, ob es geklappt hat
 *   hapm-ctl replace <container> <abbild>   ersetzt einen Container durch einen mit neuem Abbild
 *
 * Für den Helfer beim Zurückspielen einer Sicherung (`lib/backup/restore.ts`):
 *
 *   hapm-ctl check <datei>         prüft die Konfiguration, auch wenn HAProxy steht
 *   hapm-ctl stop|start <container>
 *   hapm-ctl restore-db <datei>    spielt eine Datenbank aus `pg_dump` in einer Transaktion ein
 *
 * Im Abbild liegen dafür zwei Verweise: `/usr/local/bin/haproxy` und
 * `/usr/local/bin/hapm-reload`. So bleiben die Kommandos aus `lib/haproxy/`
 * dieselben wie auf einer Maschine mit installiertem HAProxy, und der
 * Deploy-Hook von acme.sh kann sie bei jeder Erneuerung aufrufen, auch wenn die
 * Oberfläche gerade nicht läuft.
 *
 * Geprüft wird im HAProxy-Container und nicht mit einem eigenen HAProxy hier:
 * nur so prüft genau die Version, die die Datei danach laden muss.
 */

import net from 'node:net';
import fs from 'node:fs';
import * as docker from '../lib/docker/engine.mjs';
import { replaceContainer } from '../lib/docker/replace.mjs';

const HAPROXY = process.env.HAPM_HAPROXY_CONTAINER || 'hapm-haproxy';
const MASTER_SOCKET = process.env.HAPM_MASTER_SOCKET || '/run/haproxy/master.sock';

/**
 * Ein Kommando an den Master-Socket von HAProxy schicken.
 * @param {string} command
 * @param {number} timeoutMs
 * @returns {Promise<string>}
 */
function master(command, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(MASTER_SOCKET);
    let output = '';
    const timer = setTimeout(() => socket.destroy(new Error('Zeitüberschreitung am Master-Socket')), timeoutMs);
    socket.on('connect', () => socket.write(`${command}\n`));
    socket.on('data', (chunk) => (output += chunk.toString('utf8')));
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

async function reload() {
  const container = await docker.findContainer(HAPROXY);
  if (!container) {
    console.error(`Der Container "${HAPROXY}" existiert nicht.`);
    return 1;
  }
  if (!container.State?.Running) {
    // Ein gestopptes HAProxy lädt nichts neu. Starten hat dieselbe Wirkung:
    // die Konfiguration wird gelesen.
    await docker.start(HAPROXY);
    console.log('HAProxy lief nicht und wurde gestartet.');
    return 0;
  }

  if (fs.existsSync(MASTER_SOCKET)) {
    try {
      // Der Master antwortet erst, wenn der neue Prozess steht oder gescheitert
      // ist, und sagt welches von beidem.
      const answer = await master('reload', 60_000);
      if (/Success=1/.test(answer)) return 0;
      if (/Success=0/.test(answer)) {
        console.error(answer.trim());
        return 1;
      }
      // Eine ältere Fassung ohne Rückmeldung: der Befehl ist angekommen.
      if (answer.trim() === '') return 0;
      console.error(answer.trim());
      return 1;
    } catch (err) {
      console.error(`Master-Socket: ${err instanceof Error ? err.message : String(err)}. Weiter über das Signal.`);
    }
  }

  await docker.kill(HAPROXY, 'SIGHUP');
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = await docker.inspectContainer(HAPROXY);
  if (!after.State?.Running) {
    console.error('HAProxy läuft nach dem Neuladen nicht mehr.');
    return 1;
  }
  return 0;
}

/** @param {string[]} argv */
async function haproxy(argv) {
  const container = await docker.findContainer(HAPROXY);
  if (!container) {
    console.error(`Der Container "${HAPROXY}" existiert nicht.`);
    return 127;
  }
  if (!container.State?.Running) {
    console.error(`Der Container "${HAPROXY}" läuft nicht (Zustand: ${container.State?.Status ?? 'unbekannt'}).`);
    return 126;
  }
  const result = await docker.exec(HAPROXY, ['haproxy', ...argv], { timeoutMs: 60_000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.code;
}

/**
 * Die Konfiguration prüfen, auch wenn HAProxy gerade nicht läuft: dann in
 * einem einmaligen Container aus demselben Abbild mit denselben Einbindungen,
 * ohne Netz. Das Zurückspielen darf ein stehendes HAProxy nicht übergehen.
 *
 * @param {string} file
 */
async function check(file) {
  const container = await docker.findContainer(HAPROXY);
  if (!container) {
    console.error(`Der Container "${HAPROXY}" existiert nicht.`);
    return 127;
  }
  if (container.State?.Running) return haproxy(['-c', '-f', file]);

  const name = `hapm-check-${Date.now()}`;
  await docker.createContainer(name, {
    Image: container.Image,
    Cmd: ['haproxy', '-c', '-f', file],
    User: 'root',
    HostConfig: {
      Binds: container.HostConfig?.Binds ?? [],
      Mounts: container.HostConfig?.Mounts ?? [],
      NetworkMode: 'none',
    },
  });
  try {
    await docker.start(name);
    const code = await docker.wait(name, 60_000);
    const output = await docker.logs(name, { tail: 60 }).catch(() => '');
    if (output.trim()) console.log(output.trim());
    return code;
  } finally {
    await docker.removeContainer(name, { force: true }).catch(() => undefined);
  }
}

/**
 * Löscht die Sitzungen, die mit der Datenbank zurückgekommen sind: wer
 * zurückspielt, meldet sich danach mit den Konten der Sicherung neu an, und
 * kein Cookie aus der Zeit der Sicherung gilt wieder. Eine Sicherung aus einer
 * Fassung ohne die Tabelle kennt keine. Nicht beim Zurückrollen nach einem
 * Fehler (`--keep-sessions`): dann gilt wieder der Stand von eben, samt der
 * Sitzung dessen, der das Zurückspielen begonnen hat.
 */
const DELETE_SESSIONS =
  "DO $$ BEGIN IF to_regclass('public.auth_sessions') IS NOT NULL THEN DELETE FROM public.auth_sessions; END IF; END $$";

/**
 * Eine Datenbank aus `pg_dump` einspielen, in EINER Transaktion: das Schema
 * leeren, die Datei einspielen, die Sitzungen löschen. Scheitert eine Zeile,
 * rollt Postgres alles zurück, und die Datenbank ist, wie sie war.
 *
 * Das Schema wird geleert und nicht nur überschrieben: eine Sicherung aus einer
 * älteren Fassung kennt nicht jede Tabelle, und eine Tabelle von heute bliebe
 * sonst mit ihrem heutigen Inhalt neben dem alten Stand stehen. Was fehlt,
 * legt HAPM beim Start an.
 *
 * Die Datei geht über die Engine in den Postgres-Container (`/tmp`), dort liest
 * sie `psql`. Das Abbild von HAPM hat kein `psql`, und die Engine reicht kein
 * stdin durch.
 *
 * @param {string} file
 * @param {boolean} keepSessions
 */
async function restoreDb(file, keepSessions) {
  const container = process.env.HAPM_POSTGRES_CONTAINER || 'hapm-postgres';
  const database = process.env.HAPM_DATABASE_NAME || 'hapm';
  const user = process.env.HAPM_DATABASE_USER || 'hapm';
  const name = `hapm-restore-${process.pid}-${Date.now()}.sql`;
  await docker.putFile(container, '/tmp', name, file);
  try {
    const result = await docker.exec(
      container,
      [
        'psql', '-X', '-q', '-U', user, '-d', database,
        '--single-transaction', '-v', 'ON_ERROR_STOP=1',
        '-c', 'DROP SCHEMA IF EXISTS public CASCADE',
        '-c', 'CREATE SCHEMA public',
        '-c', 'ALTER SCHEMA public OWNER TO pg_database_owner',
        '-c', 'GRANT USAGE ON SCHEMA public TO PUBLIC',
        '-c', "COMMENT ON SCHEMA public IS 'standard public schema'",
        '-f', `/tmp/${name}`,
        ...(keepSessions ? [] : ['-c', DELETE_SESSIONS]),
      ],
      { timeoutMs: 30 * 60_000 }
    );
    if (result.stdout.trim()) console.log(result.stdout.trim().slice(-2000));
    if (result.stderr.trim()) console.error(result.stderr.trim().slice(-2000));
    return result.code;
  } finally {
    await docker.exec(container, ['rm', '-f', `/tmp/${name}`]).catch(() => undefined);
  }
}

/**
 * Das bisherige Abbild, wie HAPM es vor dem Holen des neuen gelesen hat. Der
 * Helfer bekommt es mit, weil das alte Abbild danach verschwunden sein kann.
 */
function oldImageFromEnv() {
  const raw = process.env.HAPM_OLD_IMAGE;
  if (!raw) return undefined;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

function usage() {
  console.error(
    'Aufruf: hapm-ctl haproxy <argumente> | reload | replace <container> <abbild> | check <datei> | stop <container> | start <container> | restore-db <datei> [--keep-sessions]'
  );
  return 2;
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case 'haproxy':
      return haproxy(rest);
    case 'reload':
      return reload();
    case 'replace': {
      const [container, image] = rest;
      if (!container || !image) {
        console.error('Aufruf: hapm-ctl replace <container> <abbild>');
        return 2;
      }
      const result = await replaceContainer(container, image, {
        log: (line) => console.log(line),
        oldImage: oldImageFromEnv(),
      });
      if (!result.ok) console.error(result.error);
      return result.ok ? 0 : 1;
    }
    // Die folgenden ruft der Helfer beim Zurückspielen (`lib/backup/restore.ts`).
    case 'check':
      return rest[0] ? check(rest[0]) : usage();
    case 'stop':
      if (!rest[0]) return usage();
      // 30 Sekunden, wie `docker stop`: Zeit genug, laufende Anfragen zu beenden.
      await docker.stop(rest[0], 30);
      return 0;
    case 'start':
      if (!rest[0]) return usage();
      await docker.start(rest[0]);
      return 0;
    case 'restore-db':
      return rest[0] ? restoreDb(rest[0], rest[1] === '--keep-sessions') : usage();
    default:
      return usage();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
);
