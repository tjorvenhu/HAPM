/**
 * Der Stats-Socket von HAProxy, direkt über `node:net`.
 *
 * Für den Sampler der Sekundenwerte (`./stats-sampler.ts`): ohne Kindprozess,
 * weil er im Sekundentakt fragt. Warum das geht und warum der Minutensammler
 * trotzdem bei `socat` bleibt, steht dort und in docs/reverse-proxy.md.
 *
 * Eigene Datei, damit der Test sie gegen einen Socket im Test prüfen kann,
 * ohne `lib/db` und `lib/ssh` zu laden.
 */

import net from 'node:net';

/** Die Antwort darf nicht unbegrenzt wachsen. `show stat` mit tausend Abschnitten hat einige hundert KB. */
const MAX_ANSWER_BYTES = 8 * 1024 * 1024;

/**
 * Ein Kommando an den Stats-Socket, die ganze Antwort zurück.
 *
 * HAProxy beantwortet eine Zeile ohne `prompt` und schließt dann die
 * Verbindung. Das Ende der Antwort ist also das Ende der Verbindung.
 */
export function askStatsSocket(path: string, command: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => socket.destroy(new Error('Zeitüberschreitung am Stats-Socket')), timeoutMs);
    socket.on('connect', () => socket.write(`${command}\n`));
    socket.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_ANSWER_BYTES) {
        socket.destroy(new Error('Antwort des Stats-Sockets zu groß'));
        return;
      }
      chunks.push(chunk);
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    socket.on('close', (hadError) => {
      clearTimeout(timer);
      if (!hadError) resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}
