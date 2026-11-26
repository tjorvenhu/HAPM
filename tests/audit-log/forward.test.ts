import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Die Marke der Weiterleitung: in Reihenfolge, ohne Lücke, mit Wiederholung.
 *
 * Datenbank und Netz sind ersetzt, die Logik dazwischen ist die echte. Dass
 * die Nachrichten wirklich ankommen, prüft `transport.test.ts` gegen echte
 * Empfänger, dass die Abfrage stimmt, `database.test.ts` gegen Postgres.
 */

interface Row {
  $id: string;
  $createdAt: string;
  $updatedAt: string;
  userId: string;
  userEmail: string;
  action: string;
  resource: string | null;
  resourceId: string | null;
  details: string | null;
  ip: string | null;
  timestamp: string;
}

const store = vi.hoisted(() => ({
  rows: [] as Row[],
  state: new Map<string, Record<string, unknown>>(),
  settings: null as unknown,
  syslogSent: [] as string[][],
  syslogFail: null as string | null,
  syslogTargets: [] as unknown[],
  httpSent: [] as string[],
  /** Die n-te Anfrage (ab 1) scheitert, oder jede (`0`), oder keine (`null`). */
  httpFailAt: null as number | null,
  queries: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/db', () => {
  class NotFoundError extends Error {}
  return {
    NotFoundError,
    getDocument: async (_collection: string, id: string) => {
      const row = store.state.get(id);
      if (!row) throw new NotFoundError(id);
      return { ...row, $id: id, $createdAt: '', $updatedAt: '' };
    },
    updateDocument: async (_collection: string, id: string, patch: Record<string, unknown>) => {
      const row = store.state.get(id);
      if (!row) throw new NotFoundError(id);
      store.state.set(id, { ...row, ...patch });
    },
    createDocument: async (_collection: string, data: Record<string, unknown>, id: string) => {
      store.state.set(id, { ...data });
    },
  };
});

vi.mock('@/lib/db/audit-query', async (original) => {
  const actual = await original<typeof import('@/lib/db/audit-query')>();
  const select = (filter: { after?: string; upTo?: string }) =>
    store.rows
      .filter((row) => (filter.after ? row.$id > filter.after : true))
      .filter((row) => (filter.upTo ? row.$id <= filter.upTo : true))
      .sort((a, b) => (a.$id < b.$id ? -1 : 1));
  return {
    ...actual,
    queryAudit: async (filter: { after?: string; upTo?: string }, _order: string, limit: number) => {
      store.queries.push({ ...filter, limit });
      return select(filter).slice(0, limit);
    },
    countAudit: async (filter: { after?: string }, cap: number) => Math.min(select(filter).length, cap),
  };
});

vi.mock('@/lib/audit-log/settings', () => ({
  getAuditSettings: async () => store.settings,
}));

vi.mock('@/lib/crypto', () => ({ decrypt: (value: string) => value.replace(/^enc\(|\)$/g, '') }));
vi.mock('@/lib/helpers', () => ({ localServer: () => ({ name: 'proxy01' }) }));

vi.mock('@/lib/audit-log/transport', async (original) => {
  const actual = await original<typeof import('@/lib/audit-log/transport')>();
  class SyslogConnection {
    constructor(readonly target: unknown) {
      store.syslogTargets.push(target);
    }
    async send(messages: string[]) {
      if (store.syslogFail) throw new Error(store.syslogFail);
      store.syslogSent.push(messages);
    }
    close() {}
  }
  return {
    ...actual,
    SyslogConnection,
    postJson: async (_target: unknown, body: string) => {
      const attempt = store.httpSent.length + 1;
      if (store.httpFailAt === 0 || store.httpFailAt === attempt) {
        if (store.httpFailAt === attempt) store.httpFailAt = null;
        throw new Error('siem antwortet mit 503');
      }
      store.httpSent.push(body);
    },
  };
});

import { idAtTime } from '@/lib/db/audit-query';
import { auditWritten } from '@/lib/audit-log/kick';
import {
  FAILING_NOTIFY_MS,
  forwardHaproxyLines,
  forwardingSettingsChanged,
  forwardingStatus,
  haproxyForwardStatus,
  onForwardingFailing,
  readForwardState,
  resetForwardingMemory,
  runAuditForwarding,
  startAuditForwarding,
  startForwardingFrom,
  syslogLine,
} from '@/lib/audit-log/forward';
import { SETTLE_MS, toEntry } from '@/lib/audit-log/read';

const START = Date.UTC(2026, 10, 26, 8, 0, 0);

function settings(patch: { syslog?: Record<string, unknown>; http?: Record<string, unknown> } = {}) {
  return {
    retentionDays: 365,
    syslog: {
      enabled: false,
      host: 'siem.example.org',
      port: 6514,
      protocol: 'tls',
      framing: 'octet',
      facility: 'local0',
      appName: 'hapm',
      format: 'json',
      caPem: null,
      haproxyLog: false,
      ...patch.syslog,
    },
    http: { enabled: false, url: 'https://siem.example.org/in', body: 'json', headerName: null, headerValue: null, caPem: null, ...patch.http },
  };
}

let counter = 0;
/** Ein Eintrag, entstanden `offsetMs` nach dem Beginn des Tests. */
function addRow(offsetMs: number, action = 'login'): Row {
  counter += 1;
  const at = START + offsetMs;
  const row: Row = {
    $id: idAtTime(at).slice(0, 12) + counter.toString(16).padStart(20, '0'),
    $createdAt: new Date(at).toISOString(),
    $updatedAt: new Date(at).toISOString(),
    userId: 'u1',
    userEmail: 'admin@example.org',
    action,
    resource: null,
    resourceId: null,
    details: `Eintrag ${counter}`,
    ip: '10.0.0.5',
    timestamp: new Date(at).toISOString(),
  };
  store.rows.push(row);
  return row;
}

const sentDetails = () => store.syslogSent.flat().map((line) => JSON.parse(line.slice(line.indexOf('{'))).details as string);
const postedDetails = () => store.httpSent.map((body) => JSON.parse(body).details as string);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(START);
  counter = 0;
  store.rows = [];
  store.state = new Map();
  store.syslogSent = [];
  store.syslogFail = null;
  store.syslogTargets = [];
  store.httpSent = [];
  store.httpFailAt = null;
  store.queries = [];
  store.settings = settings();
  resetForwardingMemory();
});

afterEach(() => {
  resetForwardingMemory();
  vi.useRealTimers();
});

describe('Marke und Reihenfolge', () => {
  it('leitet nach dem Einschalten nur weiter, was danach geschieht', async () => {
    addRow(-60_000);
    store.settings = settings({ syslog: { enabled: true } });
    await startForwardingFrom('syslog');
    addRow(1000);
    addRow(2000);

    vi.setSystemTime(START + 10_000);
    await runAuditForwarding();
    expect(sentDetails()).toEqual(['Eintrag 2', 'Eintrag 3']);
  });

  it('setzt die Marke auf den letzten abgegebenen Eintrag und schickt nichts doppelt', async () => {
    store.settings = settings({ syslog: { enabled: true } });
    await startForwardingFrom('syslog');
    addRow(1000);
    const last = addRow(2000);

    vi.setSystemTime(START + 10_000);
    await runAuditForwarding();
    expect((await readForwardState('syslog')).cursor).toBe(last.$id);
    expect((await readForwardState('syslog')).lastSuccessAt).toBe(new Date(START + 10_000).toISOString());

    await runAuditForwarding();
    expect(store.syslogSent.flat()).toHaveLength(2);

    addRow(11_000);
    vi.setSystemTime(START + 20_000);
    await runAuditForwarding();
    expect(sentDetails()).toEqual(['Eintrag 1', 'Eintrag 2', 'Eintrag 3']);
  });

  it('hält den jüngsten Rand zurück, bis er fest ist', async () => {
    store.settings = settings({ syslog: { enabled: true } });
    await startForwardingFrom('syslog');
    addRow(5000);

    // Der Eintrag ist eben erst entstanden: ein gleichzeitig geschriebener könnte noch davor landen.
    vi.setSystemTime(START + 5000 + SETTLE_MS - 200);
    await runAuditForwarding();
    expect(store.syslogSent).toHaveLength(0);

    vi.setSystemTime(START + 5000 + SETTLE_MS + 200);
    await runAuditForwarding();
    expect(sentDetails()).toEqual(['Eintrag 1']);
  });

  it('holt einen Rückstand über mehrere Stapel ab, jeder in Reihenfolge', async () => {
    store.settings = settings({ syslog: { enabled: true } });
    await startForwardingFrom('syslog');
    for (let i = 0; i < 250; i++) addRow(1000 + i);

    vi.setSystemTime(START + 60_000);
    await runAuditForwarding();
    expect(store.syslogSent.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(sentDetails()).toEqual(Array.from({ length: 250 }, (_, i) => `Eintrag ${i + 1}`));
  });

  it('schickt an ein ausgeschaltetes Ziel nichts', async () => {
    addRow(1000);
    vi.setSystemTime(START + 10_000);
    await runAuditForwarding();
    expect(store.syslogSent).toHaveLength(0);
    expect(store.httpSent).toHaveLength(0);
    expect(store.queries).toHaveLength(0);
  });
});

describe('Fehler und Wiederholung', () => {
  it('lässt die Marke stehen, wenn das Ziel nicht annimmt, und liefert danach alles nach', async () => {
    store.settings = settings({ syslog: { enabled: true } });
    await startForwardingFrom('syslog');
    const before = (await readForwardState('syslog')).cursor;
    addRow(1000);
    addRow(2000);

    store.syslogFail = 'siem.example.org:6514: Verbindung abgelehnt';
    vi.setSystemTime(START + 10_000);
    await runAuditForwarding();

    const failed = await readForwardState('syslog');
    expect(failed.cursor).toBe(before);
    expect(failed.lastError).toBe('siem.example.org:6514: Verbindung abgelehnt');
    expect(failed.failingSince).toBe(new Date(START + 10_000).toISOString());

    addRow(11_000);
    store.syslogFail = null;
    vi.setSystemTime(START + 120_000);
    await runAuditForwarding();

    expect(sentDetails()).toEqual(['Eintrag 1', 'Eintrag 2', 'Eintrag 3']);
    const recovered = await readForwardState('syslog');
    expect(recovered.lastError).toBeNull();
    expect(recovered.failingSince).toBeNull();
  });

  it('versucht es nach einem Fehler nicht sofort wieder', async () => {
    store.settings = settings({ syslog: { enabled: true } });
    await startForwardingFrom('syslog');
    addRow(1000);
    store.syslogFail = 'weg';

    vi.setSystemTime(START + 10_000);
    await runAuditForwarding();
    const queriesAfterFailure = store.queries.length;

    store.syslogFail = null;
    vi.setSystemTime(START + 11_000);
    await runAuditForwarding();
    expect(store.queries.length).toBe(queriesAfterFailure);
    expect(store.syslogSent).toHaveLength(0);

    // Nach der Pause holt der eigene Zeitgeber es nach, ohne dass jemand anstößt.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sentDetails()).toEqual(['Eintrag 1']);
  });

  it('behält den Beginn der Störung über mehrere Fehlschläge', async () => {
    store.settings = settings({ syslog: { enabled: true } });
    await startForwardingFrom('syslog');
    addRow(1000);
    store.syslogFail = 'weg';

    vi.setSystemTime(START + 10_000);
    await runAuditForwarding();
    vi.setSystemTime(START + 200_000);
    await runAuditForwarding();

    const state = await readForwardState('syslog');
    expect(state.failingSince).toBe(new Date(START + 10_000).toISOString());
    expect(state.lastErrorAt).toBe(new Date(START + 200_000).toISOString());
  });

  it('meldet eine Störung erst, wenn sie eine Viertelstunde anhält', async () => {
    const failing = vi.fn();
    onForwardingFailing(failing);
    store.settings = settings({ syslog: { enabled: true } });
    await startForwardingFrom('syslog');
    addRow(1000);
    store.syslogFail = 'weg';

    vi.setSystemTime(START + 10_000);
    await runAuditForwarding();
    vi.setSystemTime(START + 10_000 + FAILING_NOTIFY_MS - 60_000);
    await runAuditForwarding();
    expect(failing).not.toHaveBeenCalled();

    vi.setSystemTime(START + 10_000 + FAILING_NOTIFY_MS + 1000);
    await runAuditForwarding();
    expect(failing).toHaveBeenCalledWith('syslog', new Date(START + 10_000).toISOString(), 'weg');
  });

  it('lässt eine Störung des einen Ziels das andere nicht aufhalten', async () => {
    store.settings = settings({ syslog: { enabled: true }, http: { enabled: true } });
    await startForwardingFrom('syslog');
    await startForwardingFrom('http');
    addRow(1000);
    store.syslogFail = 'weg';

    vi.setSystemTime(START + 10_000);
    await runAuditForwarding();
    expect(store.syslogSent).toHaveLength(0);
    expect(postedDetails()).toEqual(['Eintrag 1']);
    expect((await readForwardState('http')).failingSince).toBeNull();
    expect((await readForwardState('syslog')).failingSince).not.toBeNull();
  });
});

describe('HTTP-Endpunkt', () => {
  it('schickt je Eintrag eine Anfrage und merkt sich bei einem Fehler, wie weit es kam', async () => {
    store.settings = settings({ http: { enabled: true } });
    await startForwardingFrom('http');
    const first = addRow(1000);
    addRow(2000);
    addRow(3000);

    store.httpFailAt = 2;
    vi.setSystemTime(START + 10_000);
    await runAuditForwarding();

    expect(postedDetails()).toEqual(['Eintrag 1']);
    const state = await readForwardState('http');
    expect(state.cursor).toBe(first.$id);
    expect(state.lastError).toBe('siem antwortet mit 503');

    vi.setSystemTime(START + 120_000);
    await runAuditForwarding();
    expect(postedDetails()).toEqual(['Eintrag 1', 'Eintrag 2', 'Eintrag 3']);
  });

  it('schickt für Splunk HEC einen Stapel in einem Rumpf, ein Ereignis je Zeile', async () => {
    store.settings = settings({ http: { enabled: true, body: 'hec' } });
    await startForwardingFrom('http');
    addRow(1000);
    addRow(2000);

    vi.setSystemTime(START + 10_000);
    await runAuditForwarding();
    expect(store.httpSent).toHaveLength(1);
    const events = store.httpSent[0].split('\n').map((line) => JSON.parse(line));
    expect(events.map((event) => event.event.details)).toEqual(['Eintrag 1', 'Eintrag 2']);
    expect(events[0]).toMatchObject({ host: 'proxy01', sourcetype: 'hapm:audit' });
  });
});

describe('Zustand für die Seite', () => {
  it('zählt den Rückstand eines eingeschalteten Ziels und nennt für ein ausgeschaltetes keinen', async () => {
    store.settings = settings({ syslog: { enabled: true } });
    await startForwardingFrom('syslog');
    addRow(1000);
    addRow(2000);
    // Eben erst entstanden und noch nicht fest: das ist unterwegs, kein Rückstand.
    addRow(9500);

    vi.setSystemTime(START + 10_000);
    const [syslog, http] = await forwardingStatus();
    expect(syslog).toMatchObject({ destination: 'syslog', enabled: true, backlog: 2 });
    expect(http).toMatchObject({ destination: 'http', enabled: false, backlog: null });
  });
});

describe('Anstoß durch logAudit', () => {
  it('tut ohne Scheduler nichts', async () => {
    store.settings = settings({ syslog: { enabled: true } });
    await startForwardingFrom('syslog');
    addRow(1000);

    auditWritten();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(store.syslogSent).toHaveLength(0);
  });

  it('leitet nach dem Start des Schedulers einen neuen Eintrag von selbst weiter', async () => {
    store.settings = settings({ syslog: { enabled: true } });
    await startForwardingFrom('syslog');
    startAuditForwarding();
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
    expect(store.syslogSent).toHaveLength(0);

    // Der Eintrag entsteht jetzt, `logAudit` stößt an.
    addRow(SETTLE_MS + 500);
    auditWritten();
    await vi.advanceTimersByTimeAsync(SETTLE_MS + 500);
    expect(sentDetails()).toEqual(['Eintrag 1']);
  });

  it('verliert keinen Anstoß, der kommt, während ein früherer Durchgang schon ansteht', async () => {
    store.settings = settings({ syslog: { enabled: true } });
    await startForwardingFrom('syslog');
    // Der Durchgang des Starts steht an und feuert, bevor der Eintrag unten fest ist.
    startAuditForwarding();
    await vi.advanceTimersByTimeAsync(1000);
    addRow(1000);
    auditWritten();

    await vi.advanceTimersByTimeAsync(SETTLE_MS - 800);
    expect(store.queries.length).toBeGreaterThan(0);
    expect(store.syslogSent).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1200);
    expect(sentDetails()).toEqual(['Eintrag 1']);
  });

  it('wirft nie, auch wenn die Datenbank fehlt', async () => {
    store.settings = null;
    await expect(runAuditForwarding()).resolves.toBeUndefined();
  });
});

describe('Nachricht', () => {
  const row = () => toEntry(addRow(1000, 'login_failed'));

  it('trägt als JSON die Kennung des Eintrags, an der ein SIEM Doppelte erkennt', () => {
    const entry = row();
    const line = syslogLine(entry, settings().syslog as never, 'proxy01');
    expect(line.startsWith('<132>1 2026-11-26T08:00:01.000Z proxy01 hapm - login_failed - {')).toBe(true);
    expect(JSON.parse(line.slice(line.indexOf('{')))).toMatchObject({ id: entry.id, source: 'hapm', host: 'proxy01', outcome: 'failure' });
  });

  it('schreibt CEF mit dem deutschen Text der Handlung als Namen', () => {
    const line = syslogLine(row(), settings({ syslog: { format: 'cef' } }).syslog as never, 'proxy01');
    expect(line).toContain(' - CEF:0|HAPM|HAPM|');
    expect(line).toContain('|login_failed|Anmeldung gescheitert|6|');
  });
});

describe('Zugriffslog von HAProxy', () => {
  const lines = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => ({ stamp: '2026-11-26T08:00:00.123456789Z', text: `10.0.0.${(from + i) % 250}:5000 [26/Nov/2026] zeile ${from + i}` }));

  it('schickt nichts, solange der Schalter aus ist', async () => {
    forwardingSettingsChanged(settings({ syslog: { enabled: true, haproxyLog: false } }) as never);
    forwardHaproxyLines(lines(3));
    await vi.advanceTimersByTimeAsync(10);
    expect(store.syslogSent).toHaveLength(0);
  });

  it('schickt jede Zeile unter dem Namen haproxy, mit der Zeit der Zeile', async () => {
    forwardingSettingsChanged(settings({ syslog: { enabled: true, haproxyLog: true } }) as never);
    forwardHaproxyLines(lines(2));
    await vi.advanceTimersByTimeAsync(10);
    expect(store.syslogSent.flat()).toEqual([
      '<134>1 2026-11-26T08:00:00.123456Z proxy01 haproxy - - - 10.0.0.0:5000 [26/Nov/2026] zeile 0',
      '<134>1 2026-11-26T08:00:00.123456Z proxy01 haproxy - - - 10.0.0.1:5000 [26/Nov/2026] zeile 1',
    ]);
  });

  it('behält bei einer Störung die letzten 5000 Zeilen und zählt, was wegfällt', async () => {
    forwardingSettingsChanged(settings({ syslog: { enabled: true, haproxyLog: true } }) as never);
    store.syslogFail = 'weg';
    forwardHaproxyLines(lines(3000));
    await vi.advanceTimersByTimeAsync(10);
    forwardHaproxyLines(lines(3000, 3000));
    await vi.advanceTimersByTimeAsync(10);
    expect(haproxyForwardStatus()).toEqual({ queued: 5000, dropped: 1000 });

    store.syslogFail = null;
    forwardHaproxyLines(lines(1, 6000));
    await vi.advanceTimersByTimeAsync(10);
    const sent = store.syslogSent.flat();
    expect(sent).toHaveLength(5000);
    // Die ältesten tausend sind weg, die Reihenfolge der übrigen stimmt.
    expect(sent[0]).toContain('zeile 1001');
    expect(sent[sent.length - 1]).toContain('zeile 6000');
    expect(haproxyForwardStatus().queued).toBe(0);
  });
});
