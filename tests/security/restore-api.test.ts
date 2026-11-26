import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Die Routen des Zurückspielens unter `/api/backup/restore/**`.
 *
 * Eine nimmt bis zu 512 MB entgegen, eine startet einen Helfer mit dem
 * Docker-Socket, der Konten, Schlüssel und Konfiguration ersetzt. Diese Datei
 * hält fest: jede schreibende Route prüft zuerst den CSRF-Token und dann die
 * Sitzung, bevor sie den Rumpf liest oder etwas anfasst; der Start verlangt
 * das Passwort, bevor irgendetwas vorbereitet wird; der Upload prüft die
 * Obergrenze, bevor er liest; und alles steht im Protokoll.
 */

const DIR = 'app/api/backup/restore';

function routeFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) routeFiles(path, out);
    else if (entry === 'route.ts') out.push(path);
  }
  return out;
}

function handlers(source: string): { method: string; body: string }[] {
  const starts = [...source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g)];
  return starts.map((match, index) => ({
    method: match[1],
    body: source.slice(match.index, starts[index + 1]?.index ?? source.length),
  }));
}

const FILES = routeFiles(DIR);
const CASES = FILES.flatMap((file) => handlers(readFileSync(file, 'utf8')).map((handler) => ({ file, ...handler })));
const WRITING = CASES.filter((c) => c.method !== 'GET');

const TOUCHES = [
  'await jsonBody',
  'request.body',
  'stageUpload(',
  'stageFromFolder(',
  'prepareRestore(',
  'beginRestore(',
  'discardStaged(',
  'unlockStaged(',
  'verifyPassword(',
];

describe('die Routen des Zurückspielens', () => {
  it('findet alle Routen, damit ein kaputter Pfad die Suite nicht grün macht', () => {
    // Fünf seit `runs/[id]` (der Stand eines Laufs für das Fenster, nur lesend),
    // sechs seit `unlock` (ein verschlüsseltes Archiv mit eingegebenem Schlüssel).
    expect(FILES).toHaveLength(6);
    expect(CASES.map((c) => c.method).sort()).toEqual(['DELETE', 'GET', 'GET', 'POST', 'POST', 'POST', 'POST']);
  });

  it.each(CASES)('$file $method verlangt eine Sitzung', ({ body }) => {
    expect(body).toContain('await requireSession()');
    expect(body).toContain('handleError(err)');
  });

  it.each(WRITING)('$file $method prüft CSRF, dann die Sitzung, vor allem anderen', ({ body }) => {
    const csrf = body.indexOf('await requireCsrf(request)');
    const session = body.indexOf('await requireSession()');
    expect(csrf, 'requireCsrf(request) nicht gefunden').toBeGreaterThan(-1);
    expect(session, 'requireSession() nicht gefunden').toBeGreaterThan(csrf);
    for (const marker of TOUCHES) {
      const at = body.indexOf(marker);
      if (at > -1) expect(session, `${marker} steht vor der Prüfung der Sitzung`).toBeLessThan(at);
    }
  });

  it.each(WRITING)('$file $method steht im Protokoll', ({ body }) => {
    expect(body).toContain('logAudit(');
  });

  it('der Start prüft das Passwort mit Sperre, bevor er etwas vorbereitet', () => {
    const start = WRITING.find((c) => c.file === join(DIR, 'start', 'route.ts'))!.body;
    const limit = start.indexOf('rateLimit(');
    const password = start.indexOf('verifyPassword(');
    const prepare = start.indexOf('prepareRestore(');
    const audit = start.indexOf('logAudit(');
    const begin = start.indexOf('beginRestore(');
    expect(limit).toBeGreaterThan(-1);
    expect(limit).toBeLessThan(password);
    expect(password).toBeLessThan(prepare);
    // Der Eintrag vor dem Start: so steht er auch in der Sicherung von unmittelbar vorher.
    expect(prepare).toBeLessThan(audit);
    expect(audit).toBeLessThan(begin);
  });

  it('der Upload prüft die Obergrenze, bevor er den Rumpf liest', () => {
    const upload = WRITING.find((c) => c.file === join(DIR, 'upload', 'route.ts'))!.body;
    expect(upload.indexOf('RESTORE_MAX_BYTES')).toBeGreaterThan(-1);
    expect(upload.indexOf('RESTORE_MAX_BYTES')).toBeLessThan(upload.indexOf('stageUpload('));
  });

  it('das Entschlüsseln ist begrenzt, bevor gpg einen Schlüssel ableitet, und schreibt den Schlüssel nicht ins Protokoll', () => {
    const unlock = WRITING.find((c) => c.file === join(DIR, 'unlock', 'route.ts'))!.body;
    const limit = unlock.indexOf('rateLimit(');
    expect(limit).toBeGreaterThan(-1);
    expect(limit).toBeLessThan(unlock.indexOf('unlockStaged('));
    const audit = unlock.slice(unlock.indexOf('logAudit('));
    expect(audit.slice(0, audit.indexOf('});'))).not.toContain('passphrase');
  });
});

/**
 * Der Sicherungsschlüssel (`/api/backup/encryption`). Wer ihn setzt, entscheidet,
 * wer die nächsten Sicherungen lesen kann, und wer ihn entfernt, schreibt sie
 * wieder im Klartext: das verlangt das Passwort des Kontos. Und er ist ein
 * Geheimnis: weder die interne API noch der MCP-Server setzen oder zeigen ihn.
 */
describe('die Route des Sicherungsschlüssels', () => {
  const source = readFileSync('app/api/backup/encryption/route.ts', 'utf8');
  const [put] = handlers(source);

  it('kennt nur das Setzen, und das mit CSRF, Sitzung, Sperre und Passwort in dieser Reihenfolge', () => {
    expect(handlers(source).map((handler) => handler.method)).toEqual(['PUT']);
    const order = ['await requireCsrf(request)', 'await requireSession()', 'rateLimit(', 'await jsonBody', 'verifyPassword(', 'changeBackupPassphrase('].map(
      (marker) => put.body.indexOf(marker)
    );
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(put.body).toContain('handleError(err)');
  });

  it('ist der einzige Weg zum Sicherungsschlüssel: nicht über die interne API, nicht über MCP', () => {
    const outside = [...routeFiles('app/api/internal'), 'lib/mcp/tools.ts', 'app/api/mcp/route.ts', 'app/api/backup/route.ts'];
    for (const file of outside) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toMatch(/changeBackupPassphrase|storePassphrase|readPassphrase/);
    }
  });

  it('gibt den Schlüssel nie heraus: die Übersicht nennt nur, ob einer gesetzt ist', () => {
    const actions = readFileSync('lib/backup/actions.ts', 'utf8');
    const overview = actions.slice(actions.indexOf('export async function backupOverview'), actions.indexOf('export type BackupOverview'));
    expect(overview).toContain('...passphraseState(settings)');
    // Die Einstellungen werden Feld für Feld genannt, nie als Ganzes weitergereicht.
    expect(overview).not.toMatch(/settings,\s*$|\.\.\.settings\b|settings\.passphrase/m);
    const state = readFileSync('lib/backup/settings.ts', 'utf8');
    const fn = state.slice(state.indexOf('export function passphraseState'), state.indexOf('export async function storePassphrase'));
    expect(fn).not.toMatch(/return \{[^}]*passphrase:/);
  });
});
