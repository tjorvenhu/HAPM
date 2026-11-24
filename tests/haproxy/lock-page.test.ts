import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCK_FIELD, LOCK_PAGE_FILES } from '@/lib/haproxy/config';
import {
  lockPages,
  renderLockPage,
  lockPageDigestCommand,
  lockPageWriteCommand,
  LOCK_PAGE_MAX_BYTES,
} from '@/lib/haproxy/lock-page';
import { HEREDOC_DELIMITER, withStdin } from '@/lib/shell';

/**
 * Die Seiten der Passwortsperre.
 *
 * HAProxy liefert sie selbst aus, und daraus folgen Bedingungen, die man einer
 * HTML-Datei nicht ansieht: sie muss in einen Puffer passen, darf nichts
 * nachladen und muss ohne JavaScript ein Formular abschicken können. Das
 * Aussehen kommt aus `ui/static/page.ts`; was hier steht, sind die
 * Bedingungen dieser einen Stelle.
 */

describe('Die Seiten der Passwortsperre', () => {
  const pages = lockPages();

  it('sind drei, unter den Namen, auf die die Regeln zeigen', () => {
    expect(pages.map((p) => p.file).sort()).toEqual(Object.values(LOCK_PAGE_FILES).sort());
  });

  it('passen in HAProxys Antwortpuffer', () => {
    // 16384 Bytes, davon 1024 Reserve, und die Kopfzeilen gehen auch ab. Eine
    // zu große Datei lehnt HAProxy beim Laden der Konfiguration ab, also beim
    // nächsten Schreibvorgang auf der Maschine und nicht hier.
    for (const page of pages) {
      expect(Buffer.byteLength(page.html, 'utf8')).toBeLessThan(LOCK_PAGE_MAX_BYTES);
    }
  });

  it('laden nichts nach und führen nichts aus', () => {
    // Vor der Sperre bekäme jede weitere Anfrage wieder diese Seite, und ein
    // fremder Host sähe, wer vor einer gesperrten Kundenseite steht.
    for (const { html } of pages) {
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<link/i);
      expect(html).not.toMatch(/<img/i);
      // `url(#…)` ist erlaubt: das Logo verweist damit auf einen Ausschnitt
      // im selben Dokument.
      expect(html).not.toMatch(/url\((?!#)/i);
      expect(html).not.toMatch(/@import/i);
      expect(html).not.toMatch(/\s(?:src|action)=/i);
      expect(html).not.toMatch(/href="[^"]/);
    }
  });

  it('schicken das Feld, das die Regel liest, an die eigene Adresse', () => {
    for (const kind of ['ask', 'wrong'] as const) {
      const html = renderLockPage(kind);
      // Ohne `action`: das Formular geht an die Adresse, die der Besucher
      // aufgerufen hat, und dorthin führt die Regel danach zurück.
      expect(html).toContain('<form method="post">');
      expect(html).toContain(`name="${LOCK_FIELD}"`);
      expect(html).toContain('type="password"');
    }
  });

  it('sagen bei einem falschen Passwort, dass es falsch war', () => {
    expect(renderLockPage('wrong')).toContain('role="alert"');
    expect(renderLockPage('ask')).not.toContain('role="alert"');
  });

  it('bieten nach zu vielen Versuchen kein Formular mehr an', () => {
    // Jede weitere Eingabe zählte wieder mit und verlängerte die Wartezeit.
    const html = renderLockPage('throttled');
    expect(html).not.toContain('<form');
    expect(html).toContain('role="alert"');
  });

  it('halten Suchmaschinen fern', () => {
    for (const { html } of pages) expect(html).toContain('noindex');
  });

  it('lassen sich über stdin auf die Maschine schreiben', () => {
    for (const { html } of pages) {
      expect(html.endsWith('\n')).toBe(true);
      expect(html).not.toContain(HEREDOC_DELIMITER);
      expect(() => withStdin(['tee', '/etc/haproxy/hapm-lock/x.html'], html)).not.toThrow();
    }
  });

  it('kommen Byte für Byte auf der Maschine an', () => {
    // Von einer echten Bash nachgerechnet. Geschrieben wird nur, wenn die
    // Prüfsumme auf der Maschine von der des Textes hier abweicht. Hängte das
    // Heredoc ein Zeilenende an, wichen sie für immer ab: jeder Vorgang schriebe
    // alle drei Seiten neu, und nirgends stünde ein Fehler.
    const dir = mkdtempSync(join(tmpdir(), 'hapm-lock-'));
    try {
      const target = `${dir.replace(/\\/g, '/')}/hapm-lock`;
      const paths = pages.map((page) => `${target}/${page.file}`);
      // Über stdin und nicht als `-c`-Argument: eine Seite ist eine einzige
      // Zeile von gut 8 KB, und unter Windows schneidet der Weg über die
      // Kommandozeile sie bei 8191 Zeichen ab.
      const bash = (command: string) =>
        execFileSync('bash', ['-s'], { input: command, encoding: 'utf8' });

      // Vorher gibt es nichts, und das ist eine leere Antwort und kein Fehler.
      expect(bash(lockPageDigestCommand(paths)).trim()).toBe('');

      pages.forEach((page, i) => bash(lockPageWriteCommand(target, paths[i], page.html)));

      const sums = bash(lockPageDigestCommand(paths))
        .trim()
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0].replace(/^\\/, ''));
      expect(sums).toEqual(
        pages.map((page) => createHash('sha256').update(page.html, 'utf8').digest('hex'))
      );
      pages.forEach((page, i) => expect(readFileSync(paths[i], 'utf8')).toBe(page.html));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('kommen aus dem gemeinsamen Baustein, mit Logo', () => {
    // Das Aussehen steht in `ui/static/page.ts` (kein Nachladen, Logo aus
    // `ui/static/logo.ts`). Hier nur: es ist diese Seite.
    for (const { html } of pages) {
      expect(html).toContain('<main class="card">');
      expect(html).toContain('<svg');
      expect(html).toContain('<h1>Geschützter Bereich</h1>');
    }
  });
});
