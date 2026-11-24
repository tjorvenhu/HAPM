#!/usr/bin/env node
// @ts-check
/**
 * Das Kommando, mit dem der HAPM-Container sein HAProxy erreicht.
 *
 *   hapm-ctl haproxy <argumente>   führt `haproxy <argumente>` im HAProxy-Container aus
 *   hapm-ctl reload                lädt HAProxy neu und meldet, ob es geklappt hat
 *   hapm-ctl replace <container> <abbild>   ersetzt einen Container durch einen mit neuem Abbild
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
    default:
      console.error('Aufruf: hapm-ctl haproxy <argumente> | reload | replace <container> <abbild>');
      return 2;
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
);
