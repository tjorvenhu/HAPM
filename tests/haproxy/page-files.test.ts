import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  errorFiles,
  followableErrorPages,
  isOwnErrorFile,
  planErrorPages,
  renderErrorFile,
  type ErrorFileRef,
} from '@/lib/haproxy/error-pages';
import { defaultPageDesign, type PageDesign } from '@/lib/haproxy/page-design';
import { isFormerStandardPage } from '@/lib/haproxy/page-history';
import type { PageBrand } from '@/lib/haproxy/page-brand';

/**
 * Das Nachziehen ohne Rückfrage: welche Fehlerdatei HAPM nach einem Update
 * oder einer geänderten Darstellung selbst neu schreibt, und welche nicht.
 *
 * Die Regel steht in `isOwnErrorFile`, die Auswahl in `followableErrorPages`.
 * Hier läuft sie über `planErrorPages`, also mit dem Zustand, den die Seite
 * „Fehlerseiten“ zeigt.
 */

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

const BRAND: PageBrand = { name: 'Beispiel GmbH', accent: '#c2410c', logo: null, logoDark: null, logoTooLarge: false };

/** Eine 503 und eine 404 aus HAPM 0.5 (Prüfsummen aus `page-history.ts`). */
const OLD_503 = '332cfdbdbac9c4e8d80463645ae382a3544cc1318988878ae01fe8e0a0734958';
const OLD_404 = '9c263ffcf2c7bd2f1e120928160a212a62a64c723cf32155c35842c16e1270f3';

const HAND = 'HTTP/1.0 503 Service Unavailable\r\nContent-Type: text/html\r\n\r\n<h1>Wartung</h1>\n';

const refs: ErrorFileRef[] = [
  { code: 503, path: '/etc/haproxy/errors/503.http' },
  { code: 404, path: '/etc/haproxy/errors/404.http' },
  { code: 502, path: '/etc/haproxy/errors/502.http' },
];

/** Was die Maschine meldet: Statuszeile und Prüfsumme je Datei. */
function machine(files: Record<string, { status: number; digest: string }>) {
  const lines = new Map(Object.entries(files).map(([path, file]) => [path, `HTTP/1.1 ${file.status} X`]));
  const digests = new Map(Object.entries(files).map(([path, file]) => [path, file.digest]));
  return { lines, digests };
}

/** Plant gegen das, was mit `design` und `brand` jetzt entstünde. */
function plan(files: Record<string, { status: number; digest: string }>, design: PageDesign, brand: PageBrand | null) {
  const { lines, digests } = machine(files);
  const entries = planErrorPages(refs, lines, digests, (content) => {
    // `planErrorPages` rechnet mit dem Design im Prozess. Für den Test wird die
    // Prüfsumme dessen ersetzt, was mit `design` und `brand` entstünde.
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(content)?.[1]);
    return sha256(renderErrorFile(status, design, brand));
  });
  return { entries, digests };
}

describe('isOwnErrorFile', () => {
  it('nimmt eine Datei, die genau das ist, was HAPM zuletzt schrieb', () => {
    expect(isOwnErrorFile('a'.repeat(64), 'a'.repeat(64))).toBe(true);
  });

  it('lässt eine Datei stehen, die davon abweicht: eine Seite von Hand', () => {
    expect(isOwnErrorFile('b'.repeat(64), 'a'.repeat(64))).toBe(false);
    // Auch wenn sie zufällig eine alte Standardseite ist: der Eintrag entscheidet.
    expect(isOwnErrorFile(OLD_503, 'a'.repeat(64))).toBe(false);
  });

  it('nimmt ohne Eintrag nur eine frühere Standardseite', () => {
    expect(isOwnErrorFile(OLD_503, undefined)).toBe(true);
    expect(isOwnErrorFile(sha256(HAND), undefined)).toBe(false);
    expect(isOwnErrorFile(undefined, undefined)).toBe(false);
  });

  it('kennt die jetzige Standardseite in beiden Sprachen', () => {
    // Scheitert dieser Test, hat sich die Standardseite geändert: ihre neuen
    // Prüfsummen gehören nach `lib/haproxy/page-history.ts`, die alten bleiben.
    for (const locale of ['de', 'en'] as const) {
      for (const file of errorFiles({ ...defaultPageDesign(), locale }, null)) {
        expect(isFormerStandardPage(sha256(file.content)), `${locale} ${file.status}`).toBe(true);
      }
    }
  });
});

describe('nach einer geänderten Darstellung', () => {
  const standard503 = sha256(renderErrorFile(503, defaultPageDesign(), null));

  it('wird eine Datei im alten Standard nachgezogen', () => {
    const { entries, digests } = plan(
      {
        '/etc/haproxy/errors/503.http': { status: 503, digest: OLD_503 },
        '/etc/haproxy/errors/502.http': { status: 502, digest: sha256(renderErrorFile(502, defaultPageDesign(), null)) },
      },
      defaultPageDesign(),
      BRAND
    );
    const { targets, skipped } = followableErrorPages(entries, digests, new Map());
    expect(targets.map((entry) => entry.path).sort()).toEqual([
      '/etc/haproxy/errors/502.http',
      '/etc/haproxy/errors/503.http',
    ]);
    expect(skipped).toEqual([]);
  });

  it('wird eine Datei, die HAPM selbst geschrieben hat, nachgezogen', () => {
    const designed = { ...defaultPageDesign(), mode: 'designed' as const, footer: 'Kontakt: it@example.org' };
    const written = sha256(renderErrorFile(503, designed, null));
    const { entries, digests } = plan({ '/etc/haproxy/errors/503.http': { status: 503, digest: written } }, designed, BRAND);
    const { targets } = followableErrorPages(entries, digests, new Map([['/etc/haproxy/errors/503.http', written]]));
    expect(targets.map((entry) => entry.path)).toEqual(['/etc/haproxy/errors/503.http']);
  });

  it('bleibt eine Datei von Hand stehen', () => {
    const { entries, digests } = plan(
      {
        '/etc/haproxy/errors/503.http': { status: 503, digest: sha256(HAND) },
        '/etc/haproxy/errors/404.http': { status: 404, digest: OLD_404 },
      },
      defaultPageDesign(),
      BRAND
    );
    // Die 503 hat HAPM einmal geschrieben, danach hat sie jemand geändert.
    const { targets, skipped } = followableErrorPages(
      entries,
      digests,
      new Map([['/etc/haproxy/errors/503.http', standard503]])
    );
    expect(skipped.map((entry) => entry.path)).toContain('/etc/haproxy/errors/503.http');
    expect(targets.map((entry) => entry.path)).not.toContain('/etc/haproxy/errors/503.http');
    // Die 404 steht seit 0.5 unverändert da und wird nachgezogen.
    expect(targets.map((entry) => entry.path)).toEqual(['/etc/haproxy/errors/404.http']);
  });

  it('bleibt eine eigene HTML-Datei, wie sie ist', () => {
    const custom: PageDesign = { ...defaultPageDesign(), mode: 'custom', custom: { html: '<p>Eigen</p>' } };
    const digest = sha256(renderErrorFile(503, custom, null));
    const { entries, digests } = plan({ '/etc/haproxy/errors/503.http': { status: 503, digest } }, custom, BRAND);
    // Die Darstellung ändert an der eigenen Datei nichts: sie ist und bleibt aktuell.
    expect(entries.find((entry) => entry.path === '/etc/haproxy/errors/503.http')?.state).toBe('current');
    expect(followableErrorPages(entries, digests, new Map([['/etc/haproxy/errors/503.http', digest]])).targets).toEqual([]);
  });
});
