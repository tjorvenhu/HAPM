/**
 * Kommandos auf der Maschine ausführen.
 *
 * Trotz des Namens gibt es hier kein SSH. HAPM läuft auf der Maschine, die es
 * verwaltet: der Container teilt sich `/etc/haproxy`, die Sockets und das Log
 * über Volumes mit dem HAProxy-Container. „Auf der Maschine" heißt also: in
 * diesem Container, und jedes Kommando läuft lokal.
 *
 * Die Funktion heißt `sshExec` und nimmt eine Verbindung als erstes Argument,
 * weil `lib/haproxy/` sie überall unter diesem Namen und mit dieser Signatur
 * aufruft. Das Argument wird nicht gelesen. Ein Umbenennen wäre ein eigener
 * Schritt quer durch `lib/haproxy/`.
 *
 * Ein Kommando entsteht über `lib/shell.ts` aus einem argv, nie als
 * zusammengesetzter Text.
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** Platzhalter für Verbindungsdaten. Es gibt keine: jedes Kommando läuft lokal. */
export type SSHConnectionConfig = Record<string, never>;

export interface SSHExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Ab dieser Länge geht das Kommando als Datei an die Shell statt als Argument.
 * Ein einzelnes Argument fasst unter Linux 128 KB, und eine Konfiguration mit
 * vielen Einträgen kommt als Heredoc in einem Kommando daher.
 */
const INLINE_LIMIT = 64 * 1024;

const MAX_OUTPUT = 32 * 1024 * 1024;

export interface ExecOptions {
  /** Jedes Stück Ausgabe (stdout und stderr), sobald es kommt. Für Kommandos,
   *  die Minuten laufen und deren Fortschritt jemand sehen soll (acme.sh). */
  onOutput?: (chunk: string) => void;
}

export async function sshExec(
  _config: SSHConnectionConfig,
  command: string,
  timeoutMs = 120_000,
  options: ExecOptions = {}
): Promise<SSHExecResult> {
  return localExec(command, timeoutMs, options);
}

export function localExec(
  command: string,
  timeoutMs = 120_000,
  { onOutput }: ExecOptions = {}
): Promise<SSHExecResult> {
  return new Promise((resolve, reject) => {
    let script: string | null = null;
    let args: string[];
    if (Buffer.byteLength(command) > INLINE_LIMIT) {
      script = path.join(os.tmpdir(), `hapm-${randomBytes(8).toString('hex')}.sh`);
      fs.writeFileSync(script, command, { mode: 0o600 });
      args = [script];
    } else {
      args = ['-c', command];
    }

    const child = spawn('bash', args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (script) fs.rm(script, { force: true }, () => undefined);
    };

    const killTree = () => {
      try {
        // Die ganze Prozessgruppe: acme.sh startet Kindprozesse, die sonst weiterlaufen.
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Schon beendet.
      }
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree();
      cleanup();
      reject(new Error(`Zeitüberschreitung nach ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_OUTPUT) target.push(chunk);
      if (onOutput) {
        try {
          onOutput(chunk.toString('utf8'));
        } catch {
          // Wer mitliest, darf das Kommando nicht aufhalten.
        }
      }
    };
    child.stdout.on('data', collect(out));
    child.stderr.on('data', collect(err));

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      });
    });
  });
}
