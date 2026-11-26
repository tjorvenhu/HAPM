import { describe, expect, it } from 'vitest';
import { createTranslator } from '@/lib/i18n';
import { BACKUP_STALE_HOURS, judge, overall, type BackupHealthInput } from '@/lib/system/health';
import { renderMetrics, escapeLabel } from '@/lib/system/metrics';
import type { SystemContainer, SystemOverview } from '@/lib/system/overview';
import type { CertificateDue } from '@/lib/system/certificates';

const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const de = createTranslator('de');

function container(name: string, patch: Partial<SystemContainer> = {}): SystemContainer {
  return {
    name,
    exists: true,
    running: true,
    status: 'running',
    health: null,
    version: '3.2.1',
    image: 'haproxy:lts',
    startedAt: '2026-11-20T08:00:00.000Z',
    restartCount: 0,
    error: null,
    ...patch,
  };
}

/** Eine Installation, an der nichts auszusetzen ist. */
function healthy(patch: Partial<SystemOverview> = {}): SystemOverview {
  return {
    generatedAt: new Date(NOW).toISOString(),
    docker: { available: true, version: '29.0.0', error: null },
    haproxy: container('hapm-haproxy'),
    hapm: { version: '0.7.0', containerized: true, image: null, startedAt: null, nodeName: 'lb1' },
    acme: { installed: true, version: '3.1.2', accountEmail: null, error: null },
    bootstrap: { status: 'ok', steps: [], finishedAt: null },
    scheduler: {
      started: true,
      lastStatsRun: '2026-11-26T11:59:00.000Z',
      lastStatsError: null,
      lastDailyRun: null,
      lastRenewal: null,
    },
    logFollower: { connected: true, lines: 10, last: null },
    proxy: { services: 3, scopes: 1, streams: 1, checked: 4, down: 0, partial: 0, unhealthy: [], error: null },
    certificates: { total: 2, expiring: 0, unreadable: 0, due: [], warnDays: 14, error: null },
    runs: { recent: [], running: 0, failed: 0 },
    updates: [],
    crowdsec: {
      summary: null,
      crowdsec: container('hapm-crowdsec', { exists: false, running: false }),
      bouncer: container('hapm-crowdsec-bouncer', { exists: false, running: false }),
    },
    ...patch,
  };
}

function due(patch: Partial<CertificateDue>): CertificateDue {
  return {
    mainDomain: 'app.example.org',
    domains: ['app.example.org'],
    expiresAt: '2026-12-01T00:00:00.000Z',
    daysLeft: 4,
    renewAt: null,
    renewalOverdue: false,
    uploaded: false,
    ...patch,
  };
}

const NO_BACKUP: BackupHealthInput = { enabled: false, lastRun: null, lastSuccessAt: null };

function statusOf(overview: SystemOverview, id: string, backup: BackupHealthInput | null = NO_BACKUP) {
  return judge(overview, backup, de, NOW).checks.find((entry) => entry.id === id)?.status;
}

describe('judge', () => {
  it('ist ok, wenn alles läuft, und sagt dann nichts', () => {
    const report = judge(healthy(), NO_BACKUP, de, NOW);
    expect(report.status).toBe('ok');
    expect(report.version).toBe('0.7.0');
    expect(report.checks.every((entry) => entry.status === 'ok' && entry.message === null)).toBe(true);
  });

  it('ist fail, wenn HAProxy steht oder es den Container nicht gibt', () => {
    expect(statusOf(healthy({ haproxy: container('hapm-haproxy', { running: false }) }), 'haproxy')).toBe('fail');
    expect(
      statusOf(healthy({ haproxy: container('hapm-haproxy', { exists: false, running: false }) }), 'haproxy')
    ).toBe('fail');
    expect(judge(healthy({ haproxy: container('x', { running: false }) }), NO_BACKUP, de, NOW).status).toBe('fail');
  });

  it('nennt einen unbekannten Zustand von HAProxy unbekannt, nicht ausgefallen', () => {
    const overview = healthy({ haproxy: container('hapm-haproxy', { exists: null, running: null }) });
    expect(statusOf(overview, 'haproxy')).toBe('unknown');
    // Unbekannt ist nicht ok: das Gesamturteil wird warn, aber nicht fail.
    expect(judge(overview, NO_BACKUP, de, NOW).status).toBe('warn');
  });

  it('ist fail ohne Docker-Engine', () => {
    expect(statusOf(healthy({ docker: { available: false, version: null, error: 'ENOENT' } }), 'docker')).toBe('fail');
  });

  it('warnt bei einem Ziel ohne Backend, schlägt aber nicht fehl: das Backend ist kaputt, nicht der Proxy', () => {
    const overview = healthy({ proxy: { ...healthy().proxy, down: 2 } });
    const report = judge(overview, NO_BACKUP, de, NOW);
    expect(report.status).toBe('warn');
    expect(report.checks.find((entry) => entry.id === 'targets')?.message).toBe(
      '2 Ziele haben kein erreichbares Backend.'
    );
  });

  it('weiß nichts über die Ziele, wenn HAProxy kein Backend prüft', () => {
    expect(statusOf(healthy({ proxy: { ...healthy().proxy, down: null, partial: null } }), 'targets')).toBe('unknown');
  });

  it('ist fail bei einem abgelaufenen Zertifikat und warnt bei einem, das bald abläuft', () => {
    const soon = healthy({ certificates: { ...healthy().certificates, due: [due({ daysLeft: 4 })] } });
    expect(statusOf(soon, 'certificates')).toBe('warn');
    const expired = healthy({ certificates: { ...healthy().certificates, due: [due({ daysLeft: -1 })] } });
    expect(statusOf(expired, 'certificates')).toBe('fail');
  });

  it('nennt die Zertifikate unbekannt, wenn acme.sh nicht zu fragen war', () => {
    expect(statusOf(healthy({ certificates: { ...healthy().certificates, total: null } }), 'certificates')).toBe(
      'unknown'
    );
  });

  it('prüft CrowdSec nur, wenn ein Ziel es benutzt', () => {
    const summary = {
      inStack: true,
      running: false,
      bouncerRunning: false,
      activeDecisions: null,
      alerts24h: null,
      waf24h: null,
      communityBlocklist: null,
      global: false,
      protectedServices: 0,
      totalServices: 3,
      topScenarios: [],
      version: null,
      bouncerVersion: null,
    };
    const idle = healthy({ crowdsec: { ...healthy().crowdsec, summary } });
    expect(statusOf(idle, 'crowdsec')).toBeUndefined();
    const used = healthy({ crowdsec: { ...healthy().crowdsec, summary: { ...summary, protectedServices: 1 } } });
    expect(statusOf(used, 'crowdsec')).toBe('warn');
  });

  it('prüft die Sicherung nur, wenn sie täglich läuft', () => {
    expect(statusOf(healthy(), 'backup')).toBeUndefined();
    expect(statusOf(healthy(), 'backup', null)).toBe('unknown');

    const fresh = new Date(NOW - 5 * HOUR).toISOString();
    const stale = new Date(NOW - (BACKUP_STALE_HOURS + 1) * HOUR).toISOString();
    const ok: BackupHealthInput = {
      enabled: true,
      lastRun: { status: 'success', startedAt: fresh },
      lastSuccessAt: fresh,
    };
    expect(statusOf(healthy(), 'backup', ok)).toBe('ok');
    expect(statusOf(healthy(), 'backup', { ...ok, lastRun: { status: 'error', startedAt: fresh } })).toBe('warn');
    expect(statusOf(healthy(), 'backup', { ...ok, lastSuccessAt: stale })).toBe('warn');
    expect(statusOf(healthy(), 'backup', { enabled: true, lastRun: null, lastSuccessAt: null })).toBe('warn');
  });

  it('übersetzt die Meldungen', () => {
    const report = judge(
      healthy({ haproxy: container('hapm-haproxy', { running: false }) }),
      NO_BACKUP,
      createTranslator('en'),
      NOW
    );
    expect(report.checks.find((entry) => entry.id === 'haproxy')?.message).toBe('HAProxy is not running.');
  });
});

describe('overall', () => {
  it('nimmt das schlechteste Urteil', () => {
    expect(overall([])).toBe('ok');
    expect(overall([{ id: 'a', status: 'ok', message: null }])).toBe('ok');
    expect(overall([{ id: 'a', status: 'unknown', message: null }])).toBe('warn');
    expect(
      overall([
        { id: 'a', status: 'warn', message: null },
        { id: 'b', status: 'fail', message: null },
      ])
    ).toBe('fail');
  });
});

describe('renderMetrics', () => {
  function metrics(
    overview: SystemOverview,
    extra: { certificates?: CertificateDue[] | null; backup?: BackupHealthInput | null } = {}
  ) {
    const backup = extra.backup === undefined ? NO_BACKUP : extra.backup;
    return renderMetrics({
      overview,
      health: judge(overview, backup, de, NOW),
      certificates: extra.certificates === undefined ? [] : extra.certificates,
      backup,
    });
  }

  it('schreibt HELP, TYPE und Wert je Metrik und endet mit einem Zeilenumbruch', () => {
    const text = metrics(healthy());
    expect(text).toContain('# HELP hapm_haproxy_up ');
    expect(text).toContain('# TYPE hapm_haproxy_up gauge\nhapm_haproxy_up 1\n');
    expect(text).toContain('hapm_info{version="0.7.0"} 1');
    expect(text).toContain('hapm_health_status 0');
    expect(text).toContain('hapm_targets{kind="service"} 3');
    expect(text).toContain('hapm_targets_unhealthy{state="down"} 0');
    expect(text.endsWith('\n')).toBe(true);
    // Jede Zeile ist Kommentar oder `name{labels} wert`.
    for (const line of text.trimEnd().split('\n')) {
      expect(line).toMatch(/^(# (HELP|TYPE) [a-z_]+ .+|[a-z_]+(\{[^}]*\})? -?[0-9.]+)$/);
    }
  });

  it('lässt weg, was unbekannt ist, statt 0 zu schreiben', () => {
    const text = metrics(
      healthy({
        haproxy: container('hapm-haproxy', { exists: null, running: null, restartCount: null }),
        proxy: { ...healthy().proxy, services: null, streams: null, checked: null, down: null, partial: null },
        certificates: { ...healthy().certificates, total: null },
        runs: { recent: null, running: null, failed: null },
      }),
      { backup: null }
    );
    for (const name of [
      'hapm_haproxy_up',
      'hapm_container_running',
      'hapm_targets',
      'hapm_targets_unhealthy',
      'hapm_certificates',
      'hapm_certificates_due',
      'hapm_runs_failed',
      'hapm_backup_enabled',
    ]) {
      expect(text, name).not.toMatch(new RegExp('^' + name + '[ {]', 'm'));
    }
    expect(text).toContain('hapm_check_status{check="haproxy",status="unknown"} 1');
    expect(text).toContain('hapm_health_status 1');
  });

  it('führt den Ablauf je Zertifikat als Unix-Zeit', () => {
    const text = metrics(healthy(), {
      certificates: [
        due({ mainDomain: 'a.example.org', expiresAt: '2027-01-01T00:00:00.000Z' }),
        due({ mainDomain: 'b.example.org', expiresAt: '2027-01-02T00:00:00.000Z', uploaded: true }),
        due({ mainDomain: 'c.example.org', expiresAt: null }),
      ],
    });
    expect(text).toContain('hapm_certificate_expiry_timestamp_seconds{domain="a.example.org",source="acme"} 1798761600');
    expect(text).toContain(
      'hapm_certificate_expiry_timestamp_seconds{domain="b.example.org",source="uploaded"} 1798848000'
    );
    expect(text).not.toContain('c.example.org');
  });

  it('nennt jedes Ziel ohne Backend und die Sicherung', () => {
    const fresh = new Date(NOW - HOUR).toISOString();
    const text = metrics(
      healthy({
        proxy: {
          ...healthy().proxy,
          down: 1,
          unhealthy: [{ id: 'shop_example_org', kind: 'service', health: 'down', slug: 'websites' }],
        },
      }),
      { backup: { enabled: true, lastRun: { status: 'error', startedAt: fresh }, lastSuccessAt: fresh } }
    );
    expect(text).toContain('hapm_target_unhealthy{target="shop_example_org",kind="service",state="down"} 1');
    expect(text).toContain('hapm_backup_enabled 1');
    expect(text).toContain('hapm_backup_last_run_ok 0');
    expect(text).toContain('hapm_backup_last_success_timestamp_seconds ' + Math.floor((NOW - HOUR) / 1000));
  });

  it('maskiert Labels', () => {
    expect(escapeLabel('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
  });
});
