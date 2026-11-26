/**
 * Ein verschlüsseltes Archiv erkennen und entschlüsseln, im Container von HAPM.
 *
 * Verschlüsselt wird im Helfer (`./run.ts`). Entschlüsselt wird hier, beim
 * Bereitlegen für das Zurückspielen und bevor irgendetwas geprüft wird: danach
 * liegt in `/data/.restore/` ein gewöhnliches `.tar.gz`, und Prüfung und Helfer
 * des Zurückspielens (`./archive.ts`, `./restore-script.ts`) arbeiten wie mit
 * jedem anderen Archiv. Der Daten-Ordner ist dafür der richtige Ort: dort
 * liegen `secrets.json` und nebenan die privaten Schlüssel ohnehin im Klartext.
 *
 * ── Erkannt wird am Inhalt, nicht am Namen ──
 *
 * Ein hochgeladenes Archiv heißt, wie der Benutzer es genannt hat. gzip beginnt
 * mit `1f 8b`. Eine Datei aus `gpg --symmetric` beginnt mit dem Paket, das den
 * Schlüssel beschreibt (OpenPGP, Tag 3): `8c` in der alten Schreibweise des
 * Kopfs, `c3` in der neuen.
 *
 * ── Der Schlüssel steht in keiner Kommandozeile ──
 *
 * `lib/ssh.ts` gibt das Kommando als Argument an bash, ein Heredoc
 * (`withStdin`) stünde also samt Inhalt in `ps`. Deshalb eine Datei (600) in
 * einem eigenen Temp-Ordner, den gpg zugleich als `--homedir` bekommt, und
 * `--passphrase-file`. Der Ordner verschwindet danach.
 *
 * ── Was gpg meldet ──
 *
 * Gelesen wird `--status-fd`, nicht der Text für Menschen: der hängt von der
 * Sprache ab. Ein falscher Schlüssel ist `BAD_PASSPHRASE` (gpg merkt das an
 * einer Prüfsumme des Sitzungsschlüssels, bevor es etwas schreibt). Ein
 * verändertes oder abgeschnittenes Archiv endet mit `DECRYPTION_FAILED` ohne
 * diese Zeile, und gpg hat dann schon geschrieben: deshalb unter einem
 * vorläufigen Namen, und erst nach `DECRYPTION_OKAY` und Exit-Code 0
 * umbenennen. `DECRYPTION_OKAY` meldet gpg nur, wenn der Integritätsschutz
 * stimmt. Daten ganz ohne ihn lehnt es seit 2.2.8 ab.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCommand } from '../shell';
import { localExec } from '../ssh';

export type ArchiveFormat = 'gzip' | 'gpg' | 'unknown';

export function archiveFormat(file: string): ArchiveFormat {
  const head = Buffer.alloc(2);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 2, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head[0] === 0x8c || head[0] === 0xc3) return 'gpg';
  return 'unknown';
}

/**
 * - `ok`: `target` ist das entschlüsselte Archiv.
 * - `wrong-passphrase`: der Schlüssel passt nicht.
 * - `damaged`: die Datei ist verändert, abgeschnitten oder kein Archiv aus gpg.
 * - `unavailable`: gpg fehlt (außerhalb des Abbilds).
 */
export type DecryptResult = 'ok' | 'wrong-passphrase' | 'damaged' | 'unavailable';

/**
 * Pfade, wie gpg sie liest. Im Container unverändert. Unter Windows laufen die
 * Tests in Git Bash, und dessen gpg nimmt `/c/…`: an `C:/…` liest es den
 * Doppelpunkt nicht als Laufwerk.
 */
function shellPath(file: string): string {
  if (process.platform !== 'win32') return file;
  return file.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
}

/**
 * Entschlüsselt `source` nach `target`. `target` gibt es danach nur bei `ok`.
 * Die Ausgabe von gpg steht bei `damaged` in `detail`, für das Log.
 */
export async function decryptArchive(
  source: string,
  target: string,
  passphrase: string
): Promise<{ result: DecryptResult; detail: string }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hapm-gpg-'));
  const part = `${target}.part`;
  try {
    const keyFile = path.join(home, 'key');
    fs.writeFileSync(keyFile, `${passphrase}\n`, { mode: 0o600 });
    fs.rmSync(part, { force: true });
    const run = await localExec(
      buildCommand([
        'gpg',
        '--homedir', shellPath(home),
        '--batch', '--yes', '--no-tty', '--no-symkey-cache', '--no-keyring',
        '--pinentry-mode', 'loopback',
        '--passphrase-file', shellPath(keyFile),
        '--status-fd', '2',
        '-o', shellPath(part),
        '--decrypt', shellPath(source),
      ]),
      20 * 60 * 1000
    );
    const status = run.stderr;
    if (run.code === 0 && /^\[GNUPG:\] DECRYPTION_OKAY\b/m.test(status) && fs.existsSync(part)) {
      fs.chmodSync(part, 0o600);
      fs.renameSync(part, target);
      return { result: 'ok', detail: '' };
    }
    if (run.code === 127 || /gpg: (command )?not found/i.test(status)) return { result: 'unavailable', detail: status.trim().slice(-400) };
    if (/^\[GNUPG:\] ERROR \S+ \d+_BAD_PASSPHRASE\b/m.test(status) || /\bBAD_PASSPHRASE\b/.test(status)) {
      return { result: 'wrong-passphrase', detail: '' };
    }
    return { result: 'damaged', detail: status.trim().slice(-400) };
  } finally {
    fs.rmSync(part, { force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}
