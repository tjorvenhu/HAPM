import { describe, it, expect } from 'vitest';
import {
  alertTargetId,
  cleanNote,
  crowdsecStats,
  goDurationMs,
  isoTime,
  parseAddress,
  parseAlerts,
  parseAllowlist,
  parseDecisions,
  type AlertTarget,
} from '@/lib/crowdsec/data';
import { allowFileContent } from '@/lib/crowdsec/allow-file';

/**
 * Die Ausgaben von `cscli … -o json`, festgehalten mit CrowdSec 1.8.2 (siehe
 * `scripts/verify-crowdsec.ts`). Ändert sich das Format, fällt es hier auf.
 */

const WAF_ALERT = {
  capacity: 1,
  created_at: '2026-11-26T07:25:08Z',
  decisions: null,
  events: [
    {
      meta: [
        { key: 'rule_name', value: 'crowdsecurity/vpatch-env-access' },
        { key: 'uri', value: '/.env' },
        { key: 'target_fqdn', value: 'Shop.Example.org' },
      ],
      timestamp: '2026-11-26 07:25:07 +0000 UTC',
    },
  ],
  events_count: 1,
  id: 1,
  kind: 'waf',
  message: 'WAF block: crowdsecurity/vpatch-env-access from 172.19.0.1 (172.19.0.3)',
  meta: [
    { key: 'target_uri', value: '["/.env"]' },
    { key: 'method', value: '["GET"]' },
  ],
  scenario: 'crowdsecurity/vpatch-env-access',
  simulated: false,
  source: { as_number: '0', ip: '172.19.0.1', scope: 'Ip', value: '172.19.0.1' },
};

const LOG_ALERT = {
  created_at: '2026-11-26T07:27:55Z',
  decisions: [{ duration: '3h59m57s', id: 2, origin: 'crowdsec', scenario: 'crowdsecurity/http-probing', scope: 'Ip', type: 'ban', value: '203.0.113.9' }],
  events: [
    {
      meta: [
        { key: 'http_path', value: '/probe1.php' },
        { key: 'http_verb', value: 'GET' },
        { key: 'target_backend', value: 'blog_ws' },
      ],
    },
  ],
  events_count: 11,
  id: 3,
  kind: 'crowdsec',
  meta: [{ key: 'target_uri', value: '["/probe1.php","/probe2.php"]' }],
  scenario: 'crowdsecurity/http-probing',
  source: { ip: '203.0.113.9', scope: 'Ip', value: '203.0.113.9', cn: 'DE', as_name: 'Beispiel AG' },
};

const MANUAL = {
  created_at: '2026-11-26T07:25:14Z',
  decisions: [{ duration: '1m47s', id: 1, origin: 'cscli', scenario: 'test hapm', scope: 'Ip', simulated: false, type: 'ban', value: '172.19.0.1' }],
  events: null,
  events_count: 1,
  id: 2,
  kind: 'cscli',
  scenario: 'test hapm',
  source: { ip: '172.19.0.1', scope: 'Ip', value: '172.19.0.1' },
};

const TARGETS: AlertTarget[] = [
  { id: 'shop', domains: ['shop.example.org'], backends: ['shop'] },
  { id: 'blog', domains: ['blog.example.org', '*.blog.example.org'], backends: ['blog', 'blog_ws'] },
];

describe('parseAlerts', () => {
  const alerts = parseAlerts([WAF_ALERT, LOG_ALERT, MANUAL]);

  it('liest Art, Quelle, Domain, Backend und Pfade', () => {
    const waf = alerts.find((a) => a.id === 1)!;
    expect(waf.kind).toBe('waf');
    expect(waf.targetHost).toBe('shop.example.org');
    expect(waf.paths).toEqual(['/.env']);
    expect(waf.method).toBe('GET');
    expect(waf.source).toBe('172.19.0.1');

    const log = alerts.find((a) => a.id === 3)!;
    expect(log.kind).toBe('scenario');
    expect(log.targetBackend).toBe('blog_ws');
    expect(log.country).toBe('DE');
    expect(log.decisions).toBe(1);
    expect(log.paths).toEqual(['/probe1.php', '/probe2.php']);

    expect(alerts.find((a) => a.id === 2)!.kind).toBe('manual');
  });

  it('sortiert die neuesten nach oben und übersteht Unsinn', () => {
    expect(alerts.map((a) => a.id)).toEqual([3, 2, 1]);
    expect(parseAlerts(null)).toEqual([]);
    expect(parseAlerts([null, 'x'])).toEqual([]);
  });
});

describe('alertTargetId', () => {
  const alerts = parseAlerts([WAF_ALERT, LOG_ALERT]);

  it('ordnet über die Domain und über das Backend einer Pfad-Regel zu', () => {
    expect(alertTargetId(alerts.find((a) => a.id === 1)!, TARGETS)).toBe('shop');
    expect(alertTargetId(alerts.find((a) => a.id === 3)!, TARGETS)).toBe('blog');
  });

  it('nimmt eine Wildcard nur, wenn keine Domain genau passt', () => {
    const [alert] = parseAlerts([{ ...WAF_ALERT, events: [{ meta: [{ key: 'target_fqdn', value: 'a.blog.example.org:443' }] }] }]);
    expect(alertTargetId(alert, TARGETS)).toBe('blog');
    const [none] = parseAlerts([{ ...WAF_ALERT, events: [{ meta: [{ key: 'target_fqdn', value: 'fremd.example' }] }] }]);
    expect(alertTargetId(none, TARGETS)).toBeNull();
  });
});

describe('parseDecisions', () => {
  it('eine Zeile je Sperre, Ende aus der Restdauer', () => {
    const now = Date.parse('2026-11-26T08:00:00Z');
    const rows = parseDecisions([MANUAL, LOG_ALERT], now);
    expect(rows.map((r) => r.id)).toEqual([2, 1]);
    const manual = rows.find((r) => r.id === 1)!;
    expect(manual.origin).toBe('cscli');
    expect(manual.until).toBe('2026-11-26T08:01:47.000Z');
    expect(rows.find((r) => r.id === 2)!.country).toBe('DE');
  });
});

describe('parseAllowlist', () => {
  it('liest Einträge, ein unbefristeter hat kein Ende', () => {
    const entries = parseAllowlist({
      name: 'hapm',
      items: [
        { created_at: '2026-11-26T07:28:03.255Z', description: 'Büro', expiration: '0001-01-01T00:00:00.000Z', value: '203.0.113.9' },
        { created_at: '2026-11-26T07:28:03.629Z', description: 'kurz', expiration: '2026-12-03T07:28:03.629Z', value: '192.0.2.1' },
      ],
    });
    expect(entries).toEqual([
      { value: '203.0.113.9', description: 'Büro', createdAt: '2026-11-26T07:28:03.255Z', expiresAt: null },
      { value: '192.0.2.1', description: 'kurz', createdAt: '2026-11-26T07:28:03.629Z', expiresAt: '2026-12-03T07:28:03.629Z' },
    ]);
    expect(parseAllowlist(null)).toEqual([]);
  });

  it('wird zur Datei für HAProxy, ohne Abgelaufenes', () => {
    const now = Date.parse('2026-12-04T00:00:00Z');
    const content = allowFileContent(
      [
        { value: '203.0.113.9', description: '', createdAt: null, expiresAt: null },
        { value: '192.0.2.1', description: '', createdAt: null, expiresAt: '2026-12-03T07:28:03.629Z' },
        { value: '198.51.100.0/24', description: '', createdAt: null, expiresAt: '2027-01-01T00:00:00Z' },
      ],
      now
    );
    expect(content).toBe('198.51.100.0/24\n203.0.113.9\n');
    expect(allowFileContent([], now)).toBe('');
  });
});

describe('Zeit und Dauer', () => {
  it('liest beide Zeitformate von CrowdSec', () => {
    expect(isoTime('2026-11-26 07:25:07 +0000 UTC')).toBe('2026-11-26T07:25:07.000Z');
    expect(isoTime('2026-11-26T07:25:08Z')).toBe('2026-11-26T07:25:08.000Z');
    expect(isoTime('0001-01-01T00:00:00Z')).toBeNull();
    expect(isoTime('')).toBeNull();
  });

  it('liest Dauern wie Go', () => {
    expect(goDurationMs('3h59m57s')).toBe((3 * 3600 + 59 * 60 + 57) * 1000);
    expect(goDurationMs('1m47.5s')).toBe(107_500);
    expect(goDurationMs('-5s')).toBe(-5000);
    expect(goDurationMs('416µs')).toBeCloseTo(0.416);
    expect(goDurationMs('kaputt')).toBeNull();
  });
});

describe('parseAddress', () => {
  it('nimmt Adressen und Netze an', () => {
    expect(parseAddress('203.0.113.7')).toEqual({ value: '203.0.113.7', scope: 'ip' });
    expect(parseAddress(' 198.51.100.0/24 ')).toEqual({ value: '198.51.100.0/24', scope: 'range' });
    expect(parseAddress('2001:db8::1')).toEqual({ value: '2001:db8::1', scope: 'ip' });
    expect(parseAddress('2001:db8::/32')).toEqual({ value: '2001:db8::/32', scope: 'range' });
  });

  it('lehnt alles andere ab, auch was als Argument von cscli gefährlich wäre', () => {
    for (const bad of ['', '256.1.1.1', '1.2.3.4/33', 'example.org', '--all', '1.2.3.4 --all', '1.2.3.4/24/1', ':::']) {
      expect(parseAddress(bad), bad).toBeNull();
    }
  });
});

describe('cleanNote', () => {
  it('nimmt Steuerzeichen heraus und kürzt', () => {
    expect(cleanNote('a\nb\tc')).toBe('a b c');
    expect(cleanNote('x'.repeat(300))).toHaveLength(120);
    expect(cleanNote(undefined)).toBe('');
  });
});

describe('crowdsecStats', () => {
  it('zählt je Stunde und Art und rangiert', () => {
    const alerts = parseAlerts([WAF_ALERT, LOG_ALERT, MANUAL]);
    const from = Date.parse('2026-11-26T00:00:00Z');
    const to = Date.parse('2026-11-26T09:00:00Z');
    const stats = crowdsecStats(alerts, TARGETS, from, to);
    expect(stats.bucketMs).toBe(3_600_000);
    expect(stats.totals).toEqual({ alerts: 3, waf: 1, scenario: 1, manual: 1, sources: 2 });
    const seven = stats.series.find((row) => row.at === '2026-11-26T07:00:00.000Z')!;
    expect(seven).toMatchObject({ waf: 1, scenario: 1, manual: 1 });
    expect(stats.targets).toEqual([
      { key: 'blog', count: 1 },
      { key: 'shop', count: 1 },
    ]);
    expect(stats.countries).toEqual([{ key: 'DE', count: 1 }]);
  });

  it('rechnet über mehr als drei Tage je Tag und lässt Ereignisse außerhalb weg', () => {
    const alerts = parseAlerts([WAF_ALERT]);
    const stats = crowdsecStats(alerts, TARGETS, Date.parse('2026-11-27T00:00:00Z') - 7 * 86_400_000, Date.parse('2026-11-27T00:00:00Z'));
    expect(stats.bucketMs).toBe(86_400_000);
    expect(stats.series).toHaveLength(7);
    expect(crowdsecStats(alerts, TARGETS, 0, 1000).totals.alerts).toBe(0);
  });
});
