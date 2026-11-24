// @ts-check
/**
 * Die Adresse der Gegenstelle an die Anfrage hängen.
 *
 * Wird vor dem Server geladen (`node --import /app/bin/remote-addr.mjs server.js`).
 * Eine Route von Next kommt nicht an den Socket ihrer Anfrage, sie sieht nur
 * Kopfzeilen. Und Kopfzeilen schreibt der Aufrufer: `X-Forwarded-For` taugt nur
 * dann als Auskunft, wenn ein eigener Proxy sie gesetzt hat.
 *
 * Deshalb trägt jede Anfrage hier ihre echte Gegenstelle in
 * `x-hapm-remote-addr` ein. Ein mitgeschickter Wert wird überschrieben.
 * `getClientIP` (`lib/audit.ts`) entscheidet damit: kommt die Anfrage von
 * 127.0.0.1, hat sie das eigene HAProxy weitergereicht, und sein
 * `X-Forwarded-For` gilt. Kommt sie von woanders, ist die Gegenstelle selbst
 * der Aufrufer, und was er über sich behauptet, zählt nicht.
 *
 * Daran hängen die Sperre nach Fehlversuchen und die Bindung eines
 * API-Schlüssels an Adressen.
 */

import http from 'node:http';

export const REMOTE_ADDR_HEADER = 'x-hapm-remote-addr';

const emit = http.Server.prototype.emit;

/**
 * @this {import('node:http').Server}
 * @param {string | symbol} event
 * @param {...any} args
 */
http.Server.prototype.emit = function patchedEmit(event, ...args) {
  if (event === 'request') {
    const req = args[0];
    if (req && req.headers) req.headers[REMOTE_ADDR_HEADER] = req.socket?.remoteAddress ?? '';
  }
  return emit.call(this, event, ...args);
};
