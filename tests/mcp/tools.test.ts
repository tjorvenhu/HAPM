import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createTranslator } from '@/lib/i18n';

/**
 * Die Werkzeugliste ohne Transport: Namen, Hinweise, Rechte und die
 * Abbildung jedes schreibenden Werkzeugs auf seine Funktion.
 */

const actions = vi.hoisted(() => ({
  listProxies: vi.fn(async () => [{ id: 'local' }]),
  listScopes: vi.fn(),
  changeScope: vi.fn(async () => ({ name: 'kunden', runs: [{ runId: 'r', serverId: 'local', serverName: 'x' }] })),
  listServices: vi.fn(),
  getService: vi.fn(),
  createServiceRun: vi.fn(async () => ({ runId: 'r', serverId: 'local', serviceId: 's' })),
  updateServiceRun: vi.fn(async () => ({ runId: 'r', serverId: 'local', serviceId: 's' })),
  deleteServiceRun: vi.fn(async () => ({ runId: 'r', serverId: 'local', serviceId: 's' })),
  listStreams: vi.fn(),
  checkPort: vi.fn(),
  getStream: vi.fn(),
  createStreamRun: vi.fn(async () => ({ runId: 'r', serverId: 'local', streamId: 'tcp_5432' })),
  updateStreamRun: vi.fn(async () => ({ runId: 'r', serverId: 'local', streamId: 'tcp_5432' })),
  deleteStreamRun: vi.fn(async () => ({ runId: 'r', serverId: 'local', streamId: 'tcp_5432' })),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  getProxySettings: vi.fn(),
  patchProxySettings: vi.fn(async () => ({ runId: 'r', serverId: 'local', adminIps: [] })),
  listCertificates: vi.fn(),
}));

vi.mock('@/lib/haproxy/api-actions', () => ({
  ...actions,
  RUN_STATUSES: ['running', 'success', 'warning', 'error', 'cancelled'],
  RUN_ACTIONS: ['create', 'update', 'delete'],
}));
vi.mock('@/lib/system/overview', () => ({ systemOverview: vi.fn() }));
vi.mock('@/lib/haproxy/stats-overview', () => ({
  readStatsOverview: vi.fn(async () => ({
    hours: 24,
    bucketMinutes: 15,
    series: [{ at: 'x' }],
    samples: 1,
    totals: { requests: 10 },
    services: Array.from({ length: 30 }, (_, i) => ({ scope: `b${i}`, serverId: 'local', serverName: 'x', requests: 30 - i })),
    proxies: [],
  })),
}));
vi.mock('@/lib/dns/zone-check', () => ({ checkZones: vi.fn() }));

/** Die Funktionen außerhalb des Reverse-Proxys, die Routen unter `/api/internal` auch rufen. */
const more = vi.hoisted(() => ({
  updatesOverview: vi.fn(async () => ({ states: [], runs: [] as { $id: string; steps: unknown[] }[], running: false })),
  checkUpdatesNow: vi.fn(async () => ({ states: [], runs: [] as { $id: string; steps: unknown[] }[], running: false })),
  startComponentUpdate: vi.fn(async () => ({ runId: 'u1' })),
  getUpdateRun: vi.fn(),
  backupOverview: vi.fn(async () => ({ settings: {}, runs: [{ $id: 'b1', steps: [{ label: 'x' }] }] })),
  changeBackupSettings: vi.fn(async () => ({})),
  startBackupRun: vi.fn(async () => ({ runId: 'b1' })),
  getBackupRun: vi.fn(),
  syncOverview: vi.fn(async () => ({ role: 'primary', peers: [], runs: [{ $id: 's1', steps: [{ label: 'x' }] }] })),
  startSyncRun: vi.fn(async () => ({ runId: 's1' })),
  getSyncRun: vi.fn(),
  settingsOverview: vi.fn(),
  changeSettings: vi.fn(async () => ({})),
  readServiceSettingsInput: vi.fn((body: Record<string, unknown>) => ({ ...body })),
  changeCertificateSettings: vi.fn(async () => ({})),
  sendTestMailAs: vi.fn(async () => ({ sent: true })),
  checkAddressMove: vi.fn(),
  removeCertificate: vi.fn(async () => ({ mainDomain: 'x', reloaded: true })),
  reissueCertificate: vi.fn(async () => ({ runId: 'c1' })),
  listCertificateAuthorities: vi.fn(async () => ({ warnDays: 30, authorities: [], error: null })),
  saveCertificateAuthority: vi.fn(async () => ({ name: 'intern-root', reloaded: false })),
  removeCertificateAuthority: vi.fn(async () => ({ name: 'intern-root' })),
  readBaseConfigRows: vi.fn(async () => [{ $id: 'local', diff: null }]),
  applyBaseConfig: vi.fn(async () => ({ steps: [] })),
  readErrorPageRows: vi.fn(async () => [{ $id: 'local', entries: [] }]),
  redeployErrorPages: vi.fn(async () => ({ steps: [] })),
  readHaproxyLog: vi.fn(),
  haproxyContainer: vi.fn(),
  restartHaproxy: vi.fn(async () => ({ wasRunning: true })),
  geoipOverview: vi.fn(),
  refreshGeoipNow: vi.fn(async () => ({ changed: false })),
  changeGeoipAutoRefresh: vi.fn(async () => ({})),
  crowdsecOverview: vi.fn(),
  listDecisions: vi.fn(async () => []),
  clearCrowdsec: vi.fn(async () => ({ alerts: 0, lifted: 0, kept: 0, lost: [] })),
  addDecision: vi.fn(async () => ({})),
  removeDecision: vi.fn(async () => ({})),
  listAllowlist: vi.fn(async () => []),
  addAllowlist: vi.fn(async () => ({})),
  removeAllowlist: vi.fn(async () => ({})),
  listAlerts: vi.fn(),
  crowdsecStatistics: vi.fn(),
  crowdsecRules: vi.fn(),
  changeRules: vi.fn(async () => ({})),
  setCrowdsecEnabled: vi.fn(async () => ({})),
}));

vi.mock('@/lib/updates/actions', () => ({
  UPDATE_COMPONENTS: ['haproxy', 'hapm', 'acme'],
  updatesOverview: more.updatesOverview,
  checkUpdatesNow: more.checkUpdatesNow,
  startComponentUpdate: more.startComponentUpdate,
  getUpdateRun: more.getUpdateRun,
}));
vi.mock('@/lib/backup/actions', () => ({
  backupOverview: more.backupOverview,
  changeBackupSettings: more.changeBackupSettings,
  startBackupRun: more.startBackupRun,
  getBackupRun: more.getBackupRun,
}));
vi.mock('@/lib/sync/actions', () => ({
  syncOverview: more.syncOverview,
  startSyncRun: more.startSyncRun,
  getSyncRun: more.getSyncRun,
}));
vi.mock('@/lib/settings-actions', () => ({
  settingsOverview: more.settingsOverview,
  changeSettings: more.changeSettings,
  readServiceSettingsInput: more.readServiceSettingsInput,
  changeCertificateSettings: more.changeCertificateSettings,
  sendTestMailAs: more.sendTestMailAs,
}));
vi.mock('@/lib/settings', () => ({ EXPOSURES: ['internal', 'public'], CERTIFICATE_SOURCES: ['acme', 'upload'] }));
vi.mock('@/lib/address-move', () => ({ checkAddressMove: more.checkAddressMove }));
vi.mock('@/lib/haproxy/certificate-actions', () => ({
  removeCertificate: more.removeCertificate,
  reissueCertificate: more.reissueCertificate,
}));
vi.mock('@/lib/haproxy/ca-actions', () => ({
  listCertificateAuthorities: more.listCertificateAuthorities,
  saveCertificateAuthority: more.saveCertificateAuthority,
  removeCertificateAuthority: more.removeCertificateAuthority,
}));
vi.mock('@/lib/haproxy/maintenance-actions', () => ({
  readBaseConfigRows: more.readBaseConfigRows,
  applyBaseConfig: more.applyBaseConfig,
  readErrorPageRows: more.readErrorPageRows,
  redeployErrorPages: more.redeployErrorPages,
}));
vi.mock('@/lib/haproxy/log-read', () => ({ readHaproxyLog: more.readHaproxyLog }));
vi.mock('@/lib/system/haproxy-container', () => ({
  haproxyContainer: more.haproxyContainer,
  restartHaproxy: more.restartHaproxy,
}));
vi.mock('@/lib/geoip/fetch', () => ({ geoipOverview: more.geoipOverview }));
vi.mock('@/lib/crowdsec/actions', () => ({
  crowdsecOverview: more.crowdsecOverview,
  listDecisions: more.listDecisions,
  addDecision: more.addDecision,
  removeDecision: more.removeDecision,
  listAllowlist: more.listAllowlist,
  addAllowlist: more.addAllowlist,
  removeAllowlist: more.removeAllowlist,
  listAlerts: more.listAlerts,
  clearCrowdsec: more.clearCrowdsec,
  crowdsecStatistics: more.crowdsecStatistics,
  crowdsecRules: more.crowdsecRules,
  changeRules: more.changeRules,
  setCrowdsecEnabled: more.setCrowdsecEnabled,
}));
vi.mock('@/lib/geoip/actions', () => ({
  refreshGeoipNow: more.refreshGeoipNow,
  changeGeoipAutoRefresh: more.changeGeoipAutoRefresh,
}));

const { TOOLS, MAX_WAIT_SECONDS } = await import('@/lib/mcp/tools');

const actor = { userId: 'service:tok1', email: 'deploy-skript', ip: '203.0.113.9' };
const ctx = { actor, locale: 'en' as const, t: createTranslator('en').t };

function tool(name: string) {
  const found = TOOLS.find((entry) => entry.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
}

/** Die schreibenden Werkzeuge des Reverse-Proxys: sie starten einen Lauf. */
const RUN_WRITING = [
  'create_service',
  'update_service',
  'delete_service',
  'create_stream',
  'update_stream',
  'delete_stream',
  'create_scope',
  'delete_scope',
  'update_proxy_settings',
];

/** Die schreibenden Werkzeuge der übrigen Bereiche. Eine neue Zeile hier ist eine Entscheidung. */
const OTHER_WRITING = [
  'start_update',
  // CrowdSec: Sperren und Freigaben gelten sofort, ohne Lauf.
  'add_crowdsec_decision',
  'remove_crowdsec_decision',
  'add_crowdsec_allowlist',
  'remove_crowdsec_allowlist',
  'update_crowdsec_rules',
  'clear_crowdsec',
  // Ganz abschalten wartet selbst auf den Lauf am Reverse-Proxy.
  'set_crowdsec_enabled',
  'update_backup_settings',
  'start_backup',
  // Nur der Anstoß. Rolle, Kopplungsschlüssel und Gegenstellen gibt es über einen Key nicht.
  'start_sync',
  'update_settings',
  'update_certificate_settings',
  'send_test_mail',
  'restart_haproxy',
  'delete_certificate',
  'reissue_certificate',
  // Zertifizierungsstellen sind kein Geheimnis: hochladen geht, anders als bei den Zertifikaten der Domains.
  'upload_certificate_authority',
  'delete_certificate_authority',
  'apply_base_config',
  'redeploy_error_pages',
  'refresh_geoip',
  'set_geoip_auto_refresh',
];

const WRITING = [...RUN_WRITING, ...OTHER_WRITING];

beforeEach(() => {
  for (const fn of Object.values(actions)) fn.mockClear();
  for (const fn of Object.values(more)) fn.mockClear();
});

describe('die Werkzeugliste', () => {
  it('hat eindeutige Namen in snake_case', () => {
    const names = TOOLS.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(_[a-z]+)*$/);
  });

  it('schreibt genau mit den Werkzeugen, die dafür vorgesehen sind', () => {
    expect(TOOLS.filter((entry) => entry.writes).map((entry) => entry.name).sort()).toEqual([...WRITING].sort());
  });

  it.each(TOOLS.map((entry) => [entry.name, entry] as const))('%s trägt stimmige Hinweise', (_name, entry) => {
    expect(entry.annotations.title).toBe(entry.title);
    expect(entry.annotations.readOnlyHint).toBe(!entry.writes);
    if (entry.writes) {
      expect(typeof entry.annotations.destructiveHint).toBe('boolean');
    } else {
      expect(entry.annotations.destructiveHint).toBe(false);
    }
    expect(typeof entry.annotations.openWorldHint).toBe('boolean');
  });

  it.each(TOOLS.map((entry) => [entry.name, entry] as const))(
    '%s hat eine englische Beschreibung ohne Gedankenstrich',
    (_name, entry) => {
      // Ein Sprachmodell liest sie. Englisch, weil die Schemas englisch sind.
      expect(entry.description.length).toBeGreaterThan(40);
      expect(entry.description).not.toMatch(/[äöüÄÖÜß]/);
      expect(entry.description).not.toMatch(/ [–—] /);
    }
  );

  it('nimmt im Schema eine hinterlegte Zertifizierungsstelle und den Namen im Zertifikat an', () => {
    for (const name of ['create_service', 'update_service']) {
      const schema = z.object(tool(name).input);
      const base = { id: 's', scope: 'K', domains: ['a.example'] };
      const accepted = schema.safeParse({
        ...base,
        backendTls: 'ca:intern-root',
        backendVerifyHost: 'app01.intern.example',
        routes: [{ name: 'api', paths: ['/api'], servers: [], backendTls: 'verify', backendVerifyHost: null }],
      });
      expect(accepted.success, name).toBe(true);
      // Ohne das Feld wie bisher.
      expect(schema.safeParse({ ...base, backendTls: 'verify' }).success, name).toBe(true);
      // Die Allow-Liste sagt es früher als `validateCreateInput`.
      for (const backendTls of ['yes', 'ca:', 'ca:../x', 'ca:Intern']) {
        expect(schema.safeParse({ ...base, backendTls }).success, `${name} ${backendTls}`).toBe(false);
      }
    }
  });

  it('nennt bei jedem Löschen und Ersetzen die Nebenwirkung', () => {
    for (const name of ['delete_service', 'delete_stream', 'update_service', 'update_stream', 'delete_scope']) {
      expect(tool(name).annotations.destructiveHint, name).toBe(true);
    }
    expect(tool('create_service').annotations.destructiveHint).toBe(false);
  });
});

describe('Rechte: schreibende Werkzeuge reichen den Actor des Tokens weiter', () => {
  const CALLS: [string, Record<string, unknown>, keyof typeof actions][] = [
    ['create_service', { scope: 'K', domains: ['a.example'] }, 'createServiceRun'],
    ['update_service', { id: 's', scope: 'K', domains: ['a.example'] }, 'updateServiceRun'],
    ['delete_service', { id: 's' }, 'deleteServiceRun'],
    ['create_stream', { scope: 'K', port: 5432, servers: [{ target: '10.0.0.1:5432' }] }, 'createStreamRun'],
    ['update_stream', { id: 'tcp_5432', scope: 'K', port: 5432, servers: [] }, 'updateStreamRun'],
    ['delete_stream', { id: 'tcp_5432' }, 'deleteStreamRun'],
    ['create_scope', { name: 'kunden' }, 'changeScope'],
    ['delete_scope', { name: 'kunden' }, 'changeScope'],
    ['update_proxy_settings', { addAdminIps: ['203.0.113.7'] }, 'patchProxySettings'],
  ];

  it('deckt jedes schreibende Werkzeug des Reverse-Proxys ab', () => {
    expect(CALLS.map(([name]) => name).sort()).toEqual([...RUN_WRITING].sort());
  });

  it.each(CALLS)('%s', async (name, args, fn) => {
    const result = (await tool(name).run(args, ctx)) as { next?: string };
    const calls = actions[fn].mock.calls as unknown[][];
    expect(calls).toHaveLength(1);
    expect(calls[0][calls[0].length - 1]).toBe(actor);
    expect(result.next).toContain('get_run');
  });

  it('delete_service fasst DNS nur auf ausdrücklichen Wunsch an', async () => {
    await tool('delete_service').run({ id: 's' }, ctx);
    expect((actions.deleteServiceRun.mock.calls as unknown[][])[0][1]).toEqual({ removeDns: false });
    await tool('delete_service').run({ id: 's', removeDns: true }, ctx);
    expect((actions.deleteServiceRun.mock.calls as unknown[][])[1][1]).toEqual({ removeDns: true });
  });

  it('create_scope und delete_scope sind zwei Richtungen derselben Funktion', async () => {
    await tool('create_scope').run({ name: 'kunden' }, ctx);
    await tool('delete_scope').run({ name: 'kunden' }, ctx);
    expect((actions.changeScope.mock.calls as unknown[][]).map((c) => c[1])).toEqual(['scope-add', 'scope-remove']);
  });
});

describe('get_run', () => {
  afterEach(() => vi.useRealTimers());

  it('wartet, bis der Lauf fertig ist', async () => {
    vi.useFakeTimers();
    actions.getRun
      .mockResolvedValueOnce({ id: 'r', status: 'running' })
      .mockResolvedValueOnce({ id: 'r', status: 'running' })
      .mockResolvedValueOnce({ id: 'r', status: 'success' });

    const pending = tool('get_run').run({ runId: 'r', waitSeconds: 30 }, ctx);
    await vi.advanceTimersByTimeAsync(4000);

    await expect(pending).resolves.toEqual({ id: 'r', status: 'success' });
    expect(actions.getRun).toHaveBeenCalledTimes(3);
  });

  it('kommt ohne waitSeconds sofort zurück, auch wenn der Lauf noch läuft', async () => {
    actions.getRun.mockResolvedValue({ id: 'r', status: 'running' });
    await expect(tool('get_run').run({ runId: 'r' }, ctx)).resolves.toEqual({ id: 'r', status: 'running' });
    expect(actions.getRun).toHaveBeenCalledTimes(1);
  });

  it('wartet nie länger als die Obergrenze', async () => {
    vi.useFakeTimers();
    actions.getRun.mockResolvedValue({ id: 'r', status: 'running' });

    const pending = tool('get_run').run({ runId: 'r', waitSeconds: 10_000 }, ctx);
    await vi.advanceTimersByTimeAsync((MAX_WAIT_SECONDS + 10) * 1000);
    await pending;

    expect(actions.getRun.mock.calls.length).toBeLessThanOrEqual(MAX_WAIT_SECONDS / 2 + 1);
  });
});

describe('get_traffic_stats', () => {
  it('gibt die Summen und die meistbesuchten Ziele zurück, die Zeitreihe nur auf Wunsch', async () => {
    const short = (await tool('get_traffic_stats').run({}, ctx)) as Record<string, unknown>;
    expect(short.totals).toEqual({ requests: 10 });
    expect(short.busiest).toHaveLength(10);
    expect(short).not.toHaveProperty('series');

    const full = (await tool('get_traffic_stats').run({ top: 3, includeSeries: true }, ctx)) as Record<string, unknown>;
    expect(full.busiest).toEqual([
      { id: 'b0', requests: 30 },
      { id: 'b1', requests: 29 },
      { id: 'b2', requests: 28 },
    ]);
    expect(full.series).toHaveLength(1);
  });
});

describe('Rechte: die übrigen schreibenden Werkzeuge schreiben unter dem Namen des Tokens ins Protokoll', () => {
  /** Was `logAudit` braucht: dieselben Angaben wie `serviceActor`, dazu die Adresse. */
  const auditActor = { userId: 'service:tok1', userEmail: 'deploy-skript', ip: '203.0.113.9' };

  const CALLS: [string, Record<string, unknown>, keyof typeof more, unknown][] = [
    ['start_update', { component: 'hapm' }, 'startComponentUpdate', auditActor],
    ['update_backup_settings', { keep: 7 }, 'changeBackupSettings', auditActor],
    ['start_backup', {}, 'startBackupRun', auditActor],
    ['start_sync', {}, 'startSyncRun', auditActor],
    ['update_settings', { exposure: 'public' }, 'changeSettings', auditActor],
    ['update_certificate_settings', { source: 'acme' }, 'changeCertificateSettings', { allowEab: false }],
    ['send_test_mail', { to: 'ops@example.com' }, 'sendTestMailAs', null],
    ['restart_haproxy', {}, 'restartHaproxy', auditActor],
    ['delete_certificate', { mainDomain: 'old.example.com' }, 'removeCertificate', { allowUploaded: false }],
    ['reissue_certificate', { mainDomain: '*.example.com' }, 'reissueCertificate', actor],
    // Das letzte Argument ist die Sprache des Aufrufers, für die Hinweise der Antwort.
    ['upload_certificate_authority', { name: 'intern-root', certificate: 'PEM' }, 'saveCertificateAuthority', ctx.t],
    ['delete_certificate_authority', { name: 'intern-root' }, 'removeCertificateAuthority', auditActor],
    ['apply_base_config', { ids: ['global|missing|x'] }, 'applyBaseConfig', auditActor],
    ['redeploy_error_pages', {}, 'redeployErrorPages', auditActor],
    ['refresh_geoip', {}, 'refreshGeoipNow', auditActor],
    ['set_geoip_auto_refresh', { autoRefresh: true }, 'changeGeoipAutoRefresh', auditActor],
    ['add_crowdsec_decision', { value: '203.0.113.7' }, 'addDecision', auditActor],
    ['remove_crowdsec_decision', { id: 3 }, 'removeDecision', auditActor],
    ['add_crowdsec_allowlist', { value: '203.0.113.7' }, 'addAllowlist', auditActor],
    ['remove_crowdsec_allowlist', { value: '203.0.113.7' }, 'removeAllowlist', auditActor],
    ['update_crowdsec_rules', { crs: 'block' }, 'changeRules', auditActor],
    ['clear_crowdsec', {}, 'clearCrowdsec', auditActor],
    ['set_crowdsec_enabled', { enabled: false }, 'setCrowdsecEnabled', auditActor],
  ];

  it('deckt jedes übrige schreibende Werkzeug ab', () => {
    expect(CALLS.map(([name]) => name).sort()).toEqual([...OTHER_WRITING].sort());
  });

  it.each(CALLS)('%s ruft seine Funktion mit dem Token', async (name, args, fn, last) => {
    await tool(name).run(args, ctx);
    const calls = more[fn].mock.calls as unknown[][];
    expect(calls).toHaveLength(1);
    expect(calls[0][calls[0].length - 1]).toEqual(last);
    // Wo der Actor nicht das letzte Argument ist, steht er davor.
    if (last !== auditActor && last !== actor) expect(calls[0]).toContainEqual(auditActor);
  });

  it('start_update sagt, dass die Verbindung bei einem Update von HAPM abbricht', async () => {
    const result = (await tool('start_update').run({ component: 'hapm' }, ctx)) as { runId: string; next: string };
    expect(result.runId).toBe('u1');
    expect(result.next).toContain('get_update_run');
    expect(tool('start_update').description).toMatch(/CONNECTION BREAKS/);
  });

  it('send_test_mail weicht ohne Sitzung auf keine Adresse aus', async () => {
    await tool('send_test_mail').run({ to: 'ops@example.com' }, ctx);
    expect((more.sendTestMailAs.mock.calls as unknown[][])[0][0]).toBe('ops@example.com');
  });

  it('update_settings geht durch dieselbe Prüfung wie PATCH /api/internal/settings', async () => {
    await tool('update_settings').run({ exposure: 'public' }, ctx);
    expect(more.readServiceSettingsInput).toHaveBeenCalledWith({ exposure: 'public' });
  });

  it('update_settings kennt weder Adresse noch SMTP-Passwort, der ACME-Server keinen EAB-Schlüssel', () => {
    const fields = Object.keys(tool('update_settings').input);
    expect(fields).not.toContain('publicUrl');
    expect(fields).not.toContain('smtpPass');
    expect(Object.keys(tool('update_certificate_settings').input)).not.toContain('eabHmacKey');
  });

  it('die Werkzeuge mit Neustart oder Überschreiben tragen destructiveHint', () => {
    for (const name of ['start_update', 'restart_haproxy', 'delete_certificate', 'apply_base_config', 'redeploy_error_pages']) {
      expect(tool(name).annotations.destructiveHint, name).toBe(true);
    }
  });
});

describe('Übersichten ohne Schritte', () => {
  it('get_updates gibt die Läufe ohne Schritte zurück und prüft nur auf Wunsch', async () => {
    more.updatesOverview.mockResolvedValueOnce({
      states: [],
      runs: [{ $id: 'u1', steps: [{ label: 'Abbild holen' }] }],
      running: false,
    });
    const result = (await tool('get_updates').run({}, ctx)) as { runs: Record<string, unknown>[] };
    expect(result.runs).toEqual([{ $id: 'u1' }]);
    expect(more.checkUpdatesNow).not.toHaveBeenCalled();

    await tool('get_updates').run({ check: true }, ctx);
    expect(more.checkUpdatesNow).toHaveBeenCalledTimes(1);
  });

  it('get_backup gibt die Läufe ohne Schritte zurück', async () => {
    const result = (await tool('get_backup').run({}, ctx)) as { runs: Record<string, unknown>[] };
    expect(result.runs).toEqual([{ $id: 'b1' }]);
  });

  it('get_sync gibt die Läufe ohne Schritte zurück', async () => {
    const result = (await tool('get_sync').run({}, ctx)) as { role: string; runs: Record<string, unknown>[] };
    expect(result.role).toBe('primary');
    expect(result.runs).toEqual([{ $id: 's1' }]);
  });

  it('kennt kein Werkzeug für Rolle, Kopplungsschlüssel oder Gegenstellen', () => {
    // Der Schlüssel ist ein Geheimnis, und die Rolle entscheidet, welcher Knoten den anderen überschreibt.
    const names = TOOLS.map((entry) => entry.name).filter((name) => name.includes('sync'));
    expect(names.sort()).toEqual(['get_sync', 'get_sync_run', 'start_sync']);
  });
});

describe('get_update_run und get_backup_run', () => {
  afterEach(() => vi.useRealTimers());

  it('get_update_run wartet wie get_run, bis der Lauf fertig ist', async () => {
    vi.useFakeTimers();
    more.getUpdateRun
      .mockResolvedValueOnce({ id: 'u1', status: 'running' })
      .mockResolvedValueOnce({ id: 'u1', status: 'success' });

    const pending = tool('get_update_run').run({ runId: 'u1', waitSeconds: 30 }, ctx);
    await vi.advanceTimersByTimeAsync(2000);

    await expect(pending).resolves.toEqual({ id: 'u1', status: 'success' });
    expect(more.getUpdateRun).toHaveBeenCalledTimes(2);
  });

  it('get_backup_run kommt ohne waitSeconds sofort zurück', async () => {
    more.getBackupRun.mockResolvedValue({ id: 'b1', status: 'running' });
    await expect(tool('get_backup_run').run({ runId: 'b1' }, ctx)).resolves.toEqual({ id: 'b1', status: 'running' });
    expect(more.getBackupRun).toHaveBeenCalledTimes(1);
  });
});
