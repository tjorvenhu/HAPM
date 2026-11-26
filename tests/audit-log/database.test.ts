import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { TEST_DATABASE_URL, announceSkip, createTestSchema, dropTestSchema } from '../helpers/test-database';

/**
 * Das Protokoll gegen ein echtes Postgres, von der Route bis zum Empfänger.
 *
 * Ersetzt sind nur die Sitzung (es gibt hier kein Konto) und die Sprache der
 * Anfrage. Alles andere ist echt: das SQL des Filters, die Einstellungen in
 * ihrer Zeile, der verschlüsselte Wert der Kopfzeile, die Marke der
 * Weiterleitung und eine TCP-Verbindung zu einem Empfänger auf 127.0.0.1.
 *
 * Läuft nur mit `TEST_DATABASE_URL` (`tests/helpers/test-database.ts`).
 */

vi.mock('@/lib/session', () => {
  const session = { userId: 'u-test', email: 'admin@example.org', name: 'Admin', twoFactorVerified: true, csrfToken: 'x' };
  return {
    requireSession: async () => session,
    getSession: async () => session,
    requireCsrf: async () => undefined,
  };
});

vi.mock('@/lib/i18n/server', async () => {
  const { createTranslator } = await vi.importActual<typeof import('@/lib/i18n/translate')>('@/lib/i18n/translate');
  return { getLocale: async () => 'de', getT: async () => createTranslator('de') };
});

const SCHEMA = `hapm_test_audit_${process.pid}`;
const DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'hapm-audit-data-'));

type Db = typeof import('@/lib/db');
let db: Db;
let driver: typeof import('@/lib/db/postgres-driver');
let query: typeof import('@/lib/db/audit-query');
let read: typeof import('@/lib/audit-log/read');
let forward: typeof import('@/lib/audit-log/forward');
let audit: typeof import('@/lib/audit');

const AUDIT = 'audit_logs';

const suite = TEST_DATABASE_URL ? describe : describe.skip;
if (!TEST_DATABASE_URL) announceSkip('tests/audit-log/database');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(check: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    if (await check()) return;
    if (Date.now() > until) throw new Error(`Gewartet und nicht eingetreten: ${what}`);
    await sleep(50);
  }
}

function octetFrames(data: Buffer): string[] {
  const out: string[] = [];
  let rest = data;
  while (rest.length > 0) {
    const space = rest.indexOf(0x20);
    if (space < 0) break;
    const length = Number(rest.subarray(0, space).toString('ascii'));
    if (!Number.isInteger(length) || rest.length < space + 1 + length) break;
    out.push(rest.subarray(space + 1, space + 1 + length).toString('utf8'));
    rest = rest.subarray(space + 1 + length);
  }
  return out;
}

interface Receiver {
  port: number;
  /** Der JSON-Teil jeder angekommenen Nachricht. */
  payloads: () => Record<string, unknown>[];
  lines: () => string[];
  close: () => Promise<void>;
}

function receiver(port = 0): Promise<Receiver> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on('data', (chunk: Buffer) => chunks.push(chunk));
      socket.on('close', () => sockets.delete(socket));
      socket.on('error', () => undefined);
    });
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const lines = () => octetFrames(Buffer.concat(chunks));
      resolve({
        port: (server.address() as net.AddressInfo).port,
        lines,
        payloads: () => lines().map((line) => JSON.parse(line.slice(line.indexOf('{'))) as Record<string, unknown>),
        close: () =>
          new Promise((done) => {
            sockets.forEach((socket) => socket.destroy());
            server.close(() => done());
          }),
      });
    });
  });
}

function jsonRequest(url: string, method: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://hapm.test${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

suite('Protokoll gegen Postgres', () => {
  beforeAll(async () => {
    process.env.HAPM_DATA_DIR = DATA_DIR;
    await createTestSchema(SCHEMA);
    db = await import('@/lib/db');
    driver = await import('@/lib/db/postgres-driver');
    query = await import('@/lib/db/audit-query');
    read = await import('@/lib/audit-log/read');
    forward = await import('@/lib/audit-log/forward');
    audit = await import('@/lib/audit');

    const rows: [string, string, string, string, string | null][] = [
      // userId, userEmail, action, timestamp, details
      ['u1', 'admin@example.org', 'login', '2026-11-01T08:00:00.000Z', null],
      ['', 'fremd@example.org', 'login_failed', '2026-11-02T08:00:00.000Z', 'Falsches Passwort'],
      ['u1', 'admin@example.org', 'haproxy_service_created', '2026-11-03T08:00:00.000Z', 'shop.example.org → 10.0.0.5:8080'],
      ['service:t1', 'deploy', 'haproxy_service_updated', '2026-11-04T08:00:00.000Z', 'Rabatt 100% für shop_a'],
      ['service:t1', 'deploy', 'backup_started', '2026-11-05T08:00:00.000Z', null],
      ['system', 'scheduler', 'backup_completed', '2026-11-06T08:00:00.000Z', 'hapm-backup-20261106.tar.gz'],
      ['system', 'scheduler', 'backup_failed', '2026-11-07T08:00:00.000Z', 'Ordner nicht beschreibbar'],
      ['u2', 'zweite@example.org', 'service_token_created', '2026-11-08T08:00:00.000Z', 'deploy (hapm_abc…)'],
    ];
    for (const [userId, userEmail, action, timestamp, details] of rows) {
      await db.createDocument(AUDIT, { userId, userEmail, action, resource: null, resourceId: null, details, ip: '10.0.0.9', timestamp });
      // Die Kennungen sollen in der Reihenfolge des Anlegens stehen, nicht in derselben Millisekunde.
      await sleep(3);
    }
    // Der Rand muss fest sein, bevor aufsteigend gelesen wird.
    await sleep(read.SETTLE_MS + 100);
  }, 60_000);

  afterAll(async () => {
    forward?.resetForwardingMemory();
    await driver?.closeDatabase();
    await dropTestSchema(SCHEMA);
    delete process.env.HAPM_DATA_DIR;
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  describe('Filter', () => {
    const actions = async (filter: Parameters<typeof query.queryAudit>[0]) =>
      (await query.queryAudit(filter, 'asc', 100)).map((row) => row.action);

    it('unterscheidet Konto, API-Key und System', async () => {
      expect(await actions({ actor: 'user' })).toEqual(['login', 'login_failed', 'haproxy_service_created', 'service_token_created']);
      expect(await actions({ actor: 'service' })).toEqual(['haproxy_service_updated', 'backup_started']);
      expect(await actions({ actor: 'system' })).toEqual(['backup_completed', 'backup_failed']);
    });

    it('filtert nach dem Zeitpunkt des Eintrags, beide Grenzen eingeschlossen', async () => {
      expect(await actions({ from: '2026-11-03T08:00:00.000Z', to: '2026-11-05T08:00:00.000Z' })).toEqual([
        'haproxy_service_created',
        'haproxy_service_updated',
        'backup_started',
      ]);
    });

    it('nimmt nur die Handlungen eines Bereichs', async () => {
      const page = await read.readAuditLog(read.readAuditQuery({ area: 'backup' }));
      expect(page.entries.map((entry) => entry.action)).toEqual(['backup_failed', 'backup_completed', 'backup_started']);
      expect(page.entries.every((entry) => entry.area === 'backup')).toBe(true);
    });

    it('sucht ohne Rücksicht auf Groß und Klein, in Namen, Handlung und Einzelheiten', async () => {
      expect(await actions({ search: 'SHOP.example' })).toEqual(['haproxy_service_created']);
      expect(await actions({ search: 'deploy' })).toEqual(['haproxy_service_updated', 'backup_started', 'service_token_created']);
      expect(await actions({ search: 'login_failed' })).toEqual(['login_failed']);
    });

    it('liest % und _ im Suchtext als Zeichen, nicht als Muster', async () => {
      expect(await actions({ search: '100%' })).toEqual(['haproxy_service_updated']);
      expect(await actions({ search: 'shop_a' })).toEqual(['haproxy_service_updated']);
      // Als Muster träfe `_` jedes Zeichen und `%` alles.
      expect(await actions({ search: 'shop_e' })).toEqual([]);
      expect(await actions({ search: '%' })).toEqual(['haproxy_service_updated']);
    });

    it('verbindet mehrere Filter mit UND', async () => {
      expect(await actions({ actor: 'system', actions: ['backup_failed', 'login'], search: 'ordner' })).toEqual(['backup_failed']);
      expect(await actions({ actor: 'user', actions: ['backup_failed'] })).toEqual([]);
    });

    it('zählt bis zur Obergrenze und nennt Bestand und ältesten Eintrag', async () => {
      expect(await query.countAudit({}, 5000)).toBe(8);
      expect(await query.countAudit({}, 3)).toBe(3);
      expect(await query.auditTotals()).toEqual({ count: 8, oldest: '2026-11-01T08:00:00.000Z' });
    });
  });

  describe('Blättern', () => {
    it('liest absteigend Seite für Seite, ohne Lücke und ohne Doppelte', async () => {
      const seen: string[] = [];
      let before: string | undefined;
      for (let page = 0; page < 5; page++) {
        const result = await read.readAuditLog(read.readAuditQuery({ limit: 3, before }));
        seen.push(...result.entries.map((entry) => entry.action));
        if (!result.more) break;
        before = result.cursor ?? undefined;
      }
      expect(seen).toEqual([
        'service_token_created',
        'backup_failed',
        'backup_completed',
        'backup_started',
        'haproxy_service_updated',
        'haproxy_service_created',
        'login_failed',
        'login',
      ]);
    });

    it('liest aufsteigend mit after weiter und behält die Marke, wenn nichts Neues da ist', async () => {
      const first = await read.readAuditLog(read.readAuditQuery({ order: 'asc', limit: 5 }));
      expect(first.entries.map((entry) => entry.action)).toEqual([
        'login',
        'login_failed',
        'haproxy_service_created',
        'haproxy_service_updated',
        'backup_started',
      ]);
      expect(first.more).toBe(true);

      const second = await read.readAuditLog(read.readAuditQuery({ after: first.cursor ?? undefined, limit: 5 }));
      expect(second.entries.map((entry) => entry.action)).toEqual(['backup_completed', 'backup_failed', 'service_token_created']);
      expect(second.more).toBe(false);

      const third = await read.readAuditLog(read.readAuditQuery({ after: second.cursor ?? undefined }));
      expect(third.entries).toEqual([]);
      expect(third.cursor).toBe(second.cursor);
    });
  });

  describe('Routen', () => {
    it('liefert der Seite die Einträge mit Bereich, Art und Ergebnis', async () => {
      const { GET } = await import('@/app/api/audit/route');
      const response = await GET(jsonRequest('/api/audit?actor=user&q=fremd', 'GET'));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data.entries).toHaveLength(1);
      expect(body.data.entries[0]).toMatchObject({
        action: 'login_failed',
        area: 'auth',
        actorType: 'user',
        actor: 'fremd@example.org',
        outcome: 'failure',
        ip: '10.0.0.9',
      });
    });

    it('lehnt einen kaputten Filter mit 400 und einer Meldung ab', async () => {
      const { GET } = await import('@/app/api/audit/route');
      const response = await GET(jsonRequest('/api/audit?limit=5000', 'GET'));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain('limit');
    });

    it('gibt den Wert der Kopfzeile nie zurück und speichert ihn verschlüsselt', async () => {
      const { GET, PATCH } = await import('@/app/api/audit/settings/route');
      const saved = await PATCH(
        jsonRequest('/api/audit/settings', 'PATCH', {
          http: { url: 'https://siem.example.org/in', headerName: 'Authorization', headerValue: 'Splunk streng-geheim' },
        })
      );
      expect(saved.status).toBe(200);
      const text = JSON.stringify(await saved.json()) + JSON.stringify(await (await GET()).json());
      expect(text).not.toContain('streng-geheim');
      expect(text).toContain('"headerValueSet":true');

      const row = await db.getDocument<{ http: { headerValue: string } }>('audit_settings', 'main');
      expect(row.http.headerValue).not.toContain('streng-geheim');
      const { decrypt } = await import('@/lib/crypto');
      expect(decrypt(row.http.headerValue)).toBe('Splunk streng-geheim');

      const logged = await query.queryAudit({ actions: ['audit_settings_updated'] }, 'desc', 1);
      expect(logged[0].details).toContain('Wert der Kopfzeile neu gesetzt');
      expect(logged[0].details).not.toContain('streng-geheim');
      expect(logged[0].userEmail).toBe('admin@example.org');
    });

    it('speichert die Aufbewahrung und lehnt eine zu kurze ab', async () => {
      const { PATCH } = await import('@/app/api/audit/settings/route');
      const ok = await PATCH(jsonRequest('/api/audit/settings', 'PATCH', { retentionDays: 180 }));
      expect((await ok.json()).data.settings.retentionDays).toBe(180);
      const tooShort = await PATCH(jsonRequest('/api/audit/settings', 'PATCH', { retentionDays: 7 }));
      expect(tooShort.status).toBe(400);
      const { getAuditSettings } = await import('@/lib/audit-log/settings');
      expect((await getAuditSettings()).retentionDays).toBe(180);
    });

    it('exportiert die gefilterten Einträge als CSV und schreibt das ins Protokoll', async () => {
      const { POST } = await import('@/app/api/audit/export/route');
      const response = await POST(jsonRequest('/api/audit/export', 'POST', { format: 'csv', actor: 'system' }));
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toContain('text/csv');
      expect(response.headers.get('Content-Disposition')).toMatch(/attachment; filename="hapm-protokoll-\d{8}-\d{6}\.csv"/);

      const text = await response.text();
      const lines = text.replace(/^﻿/, '').split('\r\n').filter(Boolean);
      expect(lines).toHaveLength(3);
      expect(lines[0]).toContain('"Zeitpunkt (UTC)"');
      expect(lines[1]).toContain('"Sicherung abgeschlossen";"backup_completed";"Sicherung"');
      expect(lines[2]).toContain('"Sicherung gescheitert";"backup_failed"');

      const logged = await query.queryAudit({ actions: ['audit_exported'] }, 'desc', 1);
      expect(logged[0].details).toBe('CSV, gesamter Zeitraum, Wer: system');
    });

    it('exportiert als JSON Lines dieselben Felder wie die API', async () => {
      const { POST } = await import('@/app/api/audit/export/route');
      const response = await POST(jsonRequest('/api/audit/export', 'POST', { format: 'jsonl', area: 'tokens' }));
      const lines = (await response.text()).trimEnd().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ action: 'service_token_created', actor: 'zweite@example.org', area: 'tokens' });
    });

    it('lehnt ein unbekanntes Format ab, bevor es etwas ins Protokoll schreibt', async () => {
      const { POST } = await import('@/app/api/audit/export/route');
      const before = await query.countAudit({ actions: ['audit_exported'] }, 100);
      expect((await POST(jsonRequest('/api/audit/export', 'POST', { format: 'xlsx' }))).status).toBe(400);
      expect(await query.countAudit({ actions: ['audit_exported'] }, 100)).toBe(before);
    });

    it('gibt das Protokoll über die interne API nur mit Token heraus', async () => {
      const { GET } = await import('@/app/api/internal/audit/route');
      const { generateServiceToken, hashServiceToken, tokenPrefix } = await import('@/lib/service-auth');
      const token = generateServiceToken();
      await db.createDocument('service_tokens', {
        name: 'siem',
        tokenHash: hashServiceToken(token),
        prefix: tokenPrefix(token),
        revokedAt: null,
        allowedIps: null,
      });

      expect((await GET(jsonRequest('/api/internal/audit', 'GET'))).status).toBe(401);
      expect((await GET(jsonRequest('/api/internal/audit', 'GET', undefined, { Authorization: 'Bearer hapm_falsch' }))).status).toBe(401);

      const response = await GET(jsonRequest('/api/internal/audit?order=asc&limit=2', 'GET', undefined, { Authorization: `Bearer ${token}` }));
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.data.entries.map((entry: { action: string }) => entry.action)).toEqual(['login', 'login_failed']);
      expect(body.data.more).toBe(true);
      expect(body.data.cursor).toMatch(/^[0-9a-f]{32}$/);
    });
  });

  describe('Weiterleitung an einen echten Empfänger', () => {
    it(
      'schickt neue Einträge in Reihenfolge, holt nach einem Ausfall alles nach und zeigt den Zustand',
      async () => {
        const { PATCH, GET } = await import('@/app/api/audit/settings/route');
        let siem = await receiver();
        const port = siem.port;
        // Was der Scheduler beim Start tut: ab jetzt stößt jeder Eintrag die Weiterleitung an.
        forward.startAuditForwarding();

        const enabled = await PATCH(
          jsonRequest('/api/audit/settings', 'PATCH', {
            syslog: { enabled: true, host: '127.0.0.1', port, protocol: 'tcp', framing: 'octet', format: 'json', appName: 'hapm-test' },
          })
        );
        expect(enabled.status).toBe(200);

        // Das Einschalten selbst ist der erste Eintrag, der hinausgeht. Nichts von vorher.
        await waitFor(() => siem.lines().length >= 1, 8000, 'die erste Nachricht');
        expect(siem.payloads()[0]).toMatchObject({ action: 'audit_settings_updated', actor: 'admin@example.org', source: 'hapm' });
        expect(siem.lines()[0]).toMatch(/^<134>1 \d{4}-\d{2}-\d{2}T[\d:.]+Z \S+ hapm-test - audit_settings_updated - \{/);

        await audit.logAudit({ userId: 'u1', userEmail: 'admin@example.org', action: 'login', ip: '10.0.0.1' });
        await sleep(5);
        await audit.logAudit({ userId: '', userEmail: 'fremd@example.org', action: 'login_failed', details: 'erste\nzweite Zeile' });
        await waitFor(() => siem.lines().length >= 3, 8000, 'zwei weitere Nachrichten');
        expect(siem.payloads().slice(1).map((payload) => payload.action)).toEqual(['login', 'login_failed']);
        // Dringlichkeit Warnung für den Fehlschlag, und der Umbruch bleibt im JSON maskiert.
        expect(siem.lines()[2].startsWith('<132>1 ')).toBe(true);
        expect(siem.payloads()[2].details).toBe('erste\nzweite Zeile');

        // Die Kennung in der Nachricht ist die der Zeile in der Datenbank.
        const stored = await query.queryAudit({ actions: ['login_failed'], search: 'zweite Zeile' }, 'desc', 1);
        expect(siem.payloads()[2].id).toBe(stored[0].$id);

        // Der Empfänger fällt aus.
        await siem.close();
        await audit.logAudit({ userId: 'u1', userEmail: 'admin@example.org', action: 'backup_started', details: 'während des Ausfalls 1' });
        await sleep(5);
        await audit.logAudit({ userId: 'u1', userEmail: 'admin@example.org', action: 'backup_completed', details: 'während des Ausfalls 2' });
        await waitFor(
          async () => (await forward.readForwardState('syslog')).failingSince !== null,
          10_000,
          'die Störung im Zustand'
        );
        const failing = (await (await GET()).json()).data.forwarding.find((entry: { destination: string }) => entry.destination === 'syslog');
        expect(failing.lastError).toContain(`127.0.0.1:${port}`);
        expect(failing.backlog).toBeGreaterThanOrEqual(2);

        // Er kommt wieder: ohne Zutun geht hinaus, was liegen blieb, in Reihenfolge.
        siem = await receiver(port);
        await waitFor(() => siem.lines().length >= 2, 30_000, 'die nachgelieferten Nachrichten');
        expect(siem.payloads().slice(0, 2).map((payload) => payload.details)).toEqual(['während des Ausfalls 1', 'während des Ausfalls 2']);
        await waitFor(async () => (await forward.readForwardState('syslog')).failingSince === null, 5000, 'das Ende der Störung');
        const healthy = (await (await GET()).json()).data.forwarding.find((entry: { destination: string }) => entry.destination === 'syslog');
        expect(healthy).toMatchObject({ enabled: true, backlog: 0, lastError: null });

        await siem.close();
      },
      90_000
    );

    it('meldet bei einer Testnachricht, ob der Empfänger sie annimmt, und schreibt beides ins Protokoll', async () => {
      const { PATCH } = await import('@/app/api/audit/settings/route');
      const { POST } = await import('@/app/api/audit/test/route');
      const siem = await receiver();
      await PATCH(jsonRequest('/api/audit/settings', 'PATCH', { syslog: { enabled: false, host: '127.0.0.1', port: siem.port, protocol: 'tcp' } }));

      const sent = await (await POST(jsonRequest('/api/audit/test', 'POST', { destination: 'syslog' }))).json();
      expect(sent.data).toEqual({ destination: 'syslog', sent: true, error: null });
      await waitFor(() => siem.lines().length === 1, 3000, 'die Testnachricht');
      expect(siem.payloads()[0]).toMatchObject({ action: 'audit_forward_test', actor: 'admin@example.org' });
      await siem.close();

      const failed = await (await POST(jsonRequest('/api/audit/test', 'POST', { destination: 'syslog' }))).json();
      expect(failed.data.sent).toBe(false);
      expect(failed.data.error).toContain(`127.0.0.1:${siem.port}`);

      const logged = await query.queryAudit({ actions: ['audit_forward_test_sent', 'audit_forward_test_failed'] }, 'asc', 10);
      expect(logged.map((row) => row.action)).toEqual(['audit_forward_test_sent', 'audit_forward_test_failed']);

      const unknown = await POST(jsonRequest('/api/audit/test', 'POST', { destination: 'kafka' }));
      expect(unknown.status).toBe(400);
    }, 30_000);
  });
});
