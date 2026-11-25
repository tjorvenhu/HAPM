import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { bytesToBase64, defaultPageDesign, PAGE_MAX_BYTES } from '@/lib/haproxy/page-design';

/**
 * Die Routen der Fehlerseiten: `/api/haproxy/error-pages` (Dateien) und
 * `/api/haproxy/error-pages/design` (Design).
 *
 * Beide schreiben als root unter `/etc/haproxy/` und laden HAProxy neu. Die
 * Reihenfolge der Prüfungen steht deshalb hier fest, und für das Design auch,
 * dass nichts gespeichert und nichts ausgeliefert wird, was die Prüfung nicht
 * besteht.
 */

const ROUTES = ['app/api/haproxy/error-pages/route.ts', 'app/api/haproxy/error-pages/design/route.ts'];

function handlers(source: string): { method: string; body: string }[] {
  const starts = [...source.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g)];
  return starts.map((match, index) => ({
    method: match[1],
    body: source.slice(match.index, starts[index + 1]?.index ?? source.length),
  }));
}

const CASES = ROUTES.flatMap((file) => handlers(readFileSync(file, 'utf8')).map((handler) => ({ file, ...handler })));

describe('die Reihenfolge der Prüfungen', () => {
  it('findet die Handler, damit ein kaputter Pfad die Suite nicht grün macht', () => {
    expect(CASES.map((handler) => handler.method).sort()).toEqual(['DELETE', 'GET', 'GET', 'POST', 'PUT']);
  });

  it.each(CASES)('$file $method prüft die Sitzung', ({ body }) => {
    expect(body).toContain('await requireSession()');
  });

  it.each(CASES.filter((handler) => handler.method !== 'GET'))(
    '$file $method prüft den CSRF-Token vor allem anderen und schreibt ins Audit',
    ({ body }) => {
      const csrf = body.indexOf('await requireCsrf(request)');
      expect(csrf).toBeGreaterThan(-1);
      for (const marker of [
        'await requireSession()',
        'await jsonBody',
        'await getProxyServer',
        'await savePageDesign',
        'await applyPageDesign',
        'await deliver',
      ]) {
        const at = body.indexOf(marker);
        if (at > -1) expect(csrf, `${marker} steht vor der CSRF-Prüfung`).toBeLessThan(at);
      }
      expect(body).toMatch(/logAudit|audit\(/);
      expect(body).toContain('handleError(err)');
    }
  );
});

/* ── Das Design: was durchgeht und was nicht ── */

const calls = vi.hoisted(() => ({ csrf: true, saved: [] as unknown[], applied: 0, audits: [] as unknown[] }));

vi.mock('@/lib/session', () => ({
  requireCsrf: async () => {
    if (!calls.csrf) throw new Error('Ungültiger CSRF-Token');
  },
  requireSession: async () => ({ userId: 'u1', email: 'admin@example.org', twoFactorVerified: true }),
}));

vi.mock('@/lib/audit', () => ({
  logAudit: async (entry: unknown) => {
    calls.audits.push(entry);
  },
  getClientIP: () => null,
}));

vi.mock('@/lib/haproxy/provision', () => ({
  getProxyServer: async (id: string) => ({ $id: id, name: 'HAProxy' }),
}));

vi.mock('@/lib/haproxy/page-design-store', () => ({
  loadPageDesign: async () => defaultPageDesign(),
  savePageDesign: async (design: unknown) => {
    calls.saved.push(design);
    return design;
  },
}));

vi.mock('@/lib/haproxy/page-design-apply', () => ({
  applyPageDesign: async () => {
    calls.applied++;
    return { steps: [{ label: 'HAProxy neu geladen', ok: true }], entries: [] };
  },
}));

const { PUT, DELETE } = await import('@/app/api/haproxy/error-pages/design/route');

function put(design: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/haproxy/error-pages/design', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ design }),
  });
}

function png(size: number): string {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytesToBase64(bytes);
}

describe('PUT /api/haproxy/error-pages/design', () => {
  beforeEach(() => {
    calls.csrf = true;
    calls.saved = [];
    calls.applied = 0;
    calls.audits = [];
  });

  it('speichert ein gültiges Design, liefert es aus und schreibt ins Audit', async () => {
    const res = await PUT(put({ ...defaultPageDesign(), mode: 'designed', colors: { accent: '#AA0000' } }));
    expect(res.status).toBe(200);
    expect(calls.saved).toEqual([
      { ...defaultPageDesign(), mode: 'designed', colors: { accent: '#aa0000', background: null, text: null } },
    ]);
    expect(calls.applied).toBe(1);
    expect(calls.audits).toHaveLength(1);
  });

  it('tut ohne gültigen CSRF-Token nichts', async () => {
    calls.csrf = false;
    const res = await PUT(put(defaultPageDesign()));
    expect(res.status).toBe(403);
    expect(calls.saved).toEqual([]);
    expect(calls.applied).toBe(0);
  });

  it('lehnt eine ungültige Farbe ab, ohne zu speichern', async () => {
    const res = await PUT(put({ colors: { accent: 'red;}body{display:none' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('#rrggbb');
    expect(calls.saved).toEqual([]);
    expect(calls.applied).toBe(0);
  });

  it('lehnt eine Datei ab, die kein Bild ist, egal was sie behauptet', async () => {
    const html = bytesToBase64(new TextEncoder().encode('<html><script>alert(1)</script></html>'));
    const res = await PUT(put({ logo: { kind: 'custom', mime: 'image/png', data: html } }));
    expect(res.status).toBe(400);
    expect(calls.saved).toEqual([]);
  });

  it('lehnt ein Logo ab, mit dem eine Seite zu groß würde, und nennt die Höchstgröße', async () => {
    const res = await PUT(put({ logo: { kind: 'custom', data: png(12_000) } }));
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error).toMatch(/darf die Logo-Datei höchstens [\d.]+ Bytes groß sein/);
    expect(calls.saved).toEqual([]);
    expect(calls.applied).toBe(0);
  });

  it('speichert eigenes HTML und CSS', async () => {
    const custom = { html: '<h1>{{title}}</h1>', css: 'h1{color:red}' };
    const res = await PUT(put({ ...defaultPageDesign(), mode: 'custom', custom }));
    expect(res.status).toBe(200);
    expect(calls.saved).toEqual([{ ...defaultPageDesign(), mode: 'custom', custom }]);
    expect(calls.applied).toBe(1);
  });

  it('lehnt eigenes HTML ab, mit dem eine Seite zu groß würde, mit derselben Meldung wie das Formular', async () => {
    const res = await PUT(put({ ...defaultPageDesign(), mode: 'custom', custom: { html: 'x'.repeat(14_900), css: '' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/^Mit diesem HTML und CSS hätte .+ Kürzen Sie HTML oder CSS\.$/);
    expect(calls.saved).toEqual([]);
    expect(calls.applied).toBe(0);
  });

  it('lehnt einen unbekannten Platzhalter ab, ohne zu speichern', async () => {
    const res = await PUT(put({ ...defaultPageDesign(), mode: 'custom', custom: { html: '{{code}}', css: '' } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('{{code}}');
    expect(calls.saved).toEqual([]);
  });

  it('liest einen übergroßen Rumpf gar nicht erst', async () => {
    const res = await PUT(put(defaultPageDesign(), { 'Content-Length': String(10 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect((await res.json()).error).toContain(PAGE_MAX_BYTES.toLocaleString('de-DE'));
    expect(calls.saved).toEqual([]);
  });
});

describe('DELETE /api/haproxy/error-pages/design', () => {
  beforeEach(() => {
    calls.csrf = true;
    calls.saved = [];
    calls.applied = 0;
  });

  it('setzt auf die Vorgabe zurück und liefert sie aus', async () => {
    const res = await DELETE(new Request('http://localhost/api/haproxy/error-pages/design', { method: 'DELETE' }));
    expect(res.status).toBe(200);
    expect(calls.saved).toEqual([defaultPageDesign()]);
    expect(calls.applied).toBe(1);
  });

  it('tut ohne gültigen CSRF-Token nichts', async () => {
    calls.csrf = false;
    const res = await DELETE(new Request('http://localhost/api/haproxy/error-pages/design', { method: 'DELETE' }));
    expect(res.status).toBe(403);
    expect(calls.saved).toEqual([]);
  });
});
