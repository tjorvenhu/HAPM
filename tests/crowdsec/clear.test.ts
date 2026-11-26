import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * CrowdSec leeren (`clearCrowdsec`): die Reihenfolge ist der Inhalt.
 *
 * Ein Bouncer erfährt von einer aufgehobenen Sperre nur, solange sie noch in
 * der Datenbank steht. `cscli alerts delete` nimmt sie mit dem Ereignis ganz
 * weg. Deshalb: erst aufheben, dann warten, bis der Bouncer abgeholt hat, dann
 * die Ereignisse entfernen, dann die Sperren von Hand neu setzen. `cscli` ist
 * nachgebaut, mit den Ausgaben von CrowdSec 1.8.2.
 */

const world = vi.hoisted(() => ({
  calls: [] as string[][],
  /** Sperren, wie `cscli decisions list -o json` sie liefert. */
  decisions: [] as unknown[],
  /** Ereignisse, wie `cscli alerts list -o json` sie liefert. */
  alerts: [] as { source: { scope: string } }[],
  /** `last_pull` des Bouncers je Abfrage von `bouncers list`: der letzte Wert bleibt stehen. */
  pulls: [] as string[],
  failAdd: new Set<string>(),
  audits: [] as { action: string; details: string }[],
}));

vi.mock('@/lib/audit', () => ({
  logAudit: vi.fn(async (entry: { action: string; details: string }) => {
    world.audits.push({ action: entry.action, details: entry.details });
  }),
}));

vi.mock('@/lib/crowdsec/cscli', () => {
  class CrowdsecUnavailable extends Error {}
  const run = async (args: string[]) => {
    world.calls.push(args);
    const [group, verb] = args;
    if (group === 'decisions' && verb === 'list') return { code: 0, stdout: JSON.stringify(world.decisions), stderr: '' };
    if (group === 'decisions' && verb === 'delete') {
      const origin = args[args.indexOf('--origin') + 1];
      const before = world.decisions.length;
      world.decisions = world.decisions.filter(
        (alert) => (alert as { decisions: { origin: string }[] }).decisions[0].origin !== origin
      );
      return { code: 0, stdout: '', stderr: `level=info msg="${before - world.decisions.length} decision(s) deleted"` };
    }
    if (group === 'decisions' && verb === 'add') {
      const value = args[3];
      return world.failAdd.has(value)
        ? { code: 1, stdout: '', stderr: 'level=fatal msg="nope"' }
        : { code: 0, stdout: '', stderr: 'level=info msg="Decision successfully added"' };
    }
    if (group === 'alerts' && verb === 'list') return { code: 0, stdout: JSON.stringify(world.alerts), stderr: '' };
    if (group === 'alerts' && verb === 'delete') {
      const scope = args[args.indexOf('--scope') + 1];
      const before = world.alerts.length;
      world.alerts = world.alerts.filter((alert) => alert.source.scope !== scope);
      // Mit dem Ereignis geht seine Sperre, auch die von Hand.
      if (scope === 'Ip' || scope === 'Range') world.decisions = [];
      return { code: 0, stdout: '', stderr: `level=info msg="${before - world.alerts.length} alert(s) deleted"` };
    }
    if (group === 'bouncers') {
      const at = world.pulls.length > 1 ? world.pulls.shift()! : world.pulls[0];
      return { code: 0, stdout: JSON.stringify(at ? [{ name: 'hapm', last_pull: at }] : []), stderr: '' };
    }
    return { code: 0, stdout: 'null', stderr: '' };
  };
  const cscliOk = async (args: string[]) => {
    const result = await run(args);
    if (result.code !== 0) throw new Error('CrowdSec lehnt ab');
    return result;
  };
  return {
    CrowdsecUnavailable,
    cscli: run,
    cscliOk,
    cscliJson: async (args: string[]) => JSON.parse((await cscliOk([...args, '-o', 'json'])).stdout),
  };
});

const { clearCrowdsec } = await import('@/lib/crowdsec/actions');

const actor = { userId: 'u1', userEmail: 'admin@example.org' };
const NOW = Date.parse('2026-11-26T12:00:00Z');

function decision(id: number, origin: string, value: string, duration: string, scenario: string, scope = 'Ip') {
  return {
    id,
    created_at: '2026-11-26T11:00:00Z',
    scenario,
    source: { scope, value },
    decisions: [{ id, origin, scope, value, duration, scenario, type: 'ban', simulated: false }],
  };
}

function order(...wanted: string[]): number[] {
  return wanted.map((needle) => world.calls.findIndex((call) => call.join(' ').startsWith(needle)));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  world.calls = [];
  world.audits = [];
  world.failAdd = new Set();
  world.decisions = [];
  world.alerts = [];
  world.pulls = [];
  const state = globalThis as unknown as { __hapmCrowdsecUnpulled?: boolean; __hapmCrowdsecClearing?: boolean };
  state.__hapmCrowdsecUnpulled = false;
  state.__hapmCrowdsecClearing = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clearCrowdsec', () => {
  it('hebt auf, wartet auf den Bouncer, entfernt die Ereignisse und setzt Sperren von Hand neu', async () => {
    world.decisions = [
      decision(1, 'crowdsec', '203.0.113.58', '3h59m0s', 'crowdsecurity/http-probing'),
      decision(2, 'cscli', '192.0.2.44', '23h0m0s', 'Brute Force auf /login'),
      decision(3, 'cscli', '198.51.100.0/24', '2h0m0s', 'Scanner', 'Range'),
    ];
    world.alerts = [
      { source: { scope: 'Ip' } },
      { source: { scope: 'Ip' } },
      { source: { scope: 'Ip' } },
      { source: { scope: 'Range' } },
    ];
    // Der Bouncer hat eben abgeholt und holt beim zweiten Nachsehen erneut ab.
    world.pulls = ['2026-11-26T11:59:55Z', '2026-11-26T11:59:55Z', '2026-11-26T12:00:05Z'];

    const pending = clearCrowdsec(actor);
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result).toEqual({ alerts: 2, lifted: 1, kept: 2, lost: [] });
    const [lift, pull, remove, add] = order('decisions delete --origin crowdsec', 'bouncers list', 'alerts delete', 'decisions add');
    expect(lift).toBeGreaterThanOrEqual(0);
    expect(pull).toBeGreaterThan(lift);
    expect(remove).toBeGreaterThan(pull);
    expect(add).toBeGreaterThan(remove);

    // Von Hand (neueste zuerst): mit der Restdauer und dem Grund von vorher. Nie `--all`, das nähme die Gemeinschaftsliste mit.
    const adds = world.calls.filter((call) => call[0] === 'decisions' && call[1] === 'add');
    expect(adds).toEqual([
      ['decisions', 'add', '--range', '198.51.100.0/24', '--duration', '7200s', '--type', 'ban', '--reason', 'Scanner'],
      ['decisions', 'add', '--ip', '192.0.2.44', '--duration', '82800s', '--type', 'ban', '--reason', 'Brute Force auf /login'],
    ]);
    expect(world.calls.some((call) => call.includes('--all'))).toBe(false);
    expect(world.calls.some((call) => call.join(' ') === 'decisions delete --origin cscli')).toBe(false);
    expect(world.audits).toEqual([
      { action: 'crowdsec_cleared', details: '2 Ereignisse entfernt, 1 Sperren aufgehoben, 2 Sperren von Hand behalten.' },
    ]);
  });

  it('lässt die Ereignisse stehen, solange der Bouncer nicht abgeholt hat, und holt es beim nächsten Mal nach', async () => {
    world.decisions = [decision(1, 'crowdsec', '203.0.113.58', '3h59m0s', 'crowdsecurity/http-probing')];
    world.alerts = [{ source: { scope: 'Ip' } }];
    world.pulls = ['2026-11-26T11:59:55Z'];

    const failed = clearCrowdsec(actor).catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(30_000);
    const error = await failed;
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('noch nicht abgeholt');
    expect(world.alerts).toHaveLength(1);
    expect(world.calls.some((call) => call[0] === 'alerts' && call[1] === 'delete')).toBe(false);

    // Zweiter Versuch: nichts mehr aufzuheben, aber gewartet wird trotzdem, bis abgeholt ist.
    world.calls = [];
    vi.setSystemTime(Date.parse('2026-11-26T12:01:00Z'));
    world.pulls = ['2026-11-26T12:00:55Z', '2026-11-26T12:01:05Z'];
    const pending = clearCrowdsec(actor);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await pending).toEqual({ alerts: 1, lifted: 0, kept: 0, lost: [] });
    const [pull, remove] = order('bouncers list', 'alerts delete');
    expect(pull).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(pull);
  });

  it('wartet nicht, wenn kein Bouncer läuft, und nicht, wenn nichts aufzuheben war', async () => {
    world.decisions = [decision(1, 'crowdsec', '203.0.113.58', '3h59m0s', 'crowdsecurity/http-probing')];
    world.alerts = [{ source: { scope: 'Ip' } }];
    // Zuletzt vor zehn Minuten abgeholt: der Bouncer steht und liest beim Start alles neu.
    world.pulls = ['2026-11-26T11:50:00Z'];
    expect(await clearCrowdsec(actor)).toEqual({ alerts: 1, lifted: 1, kept: 0, lost: [] });

    world.calls = [];
    world.alerts = [{ source: { scope: 'Ip' } }];
    expect(await clearCrowdsec(actor)).toEqual({ alerts: 1, lifted: 0, kept: 0, lost: [] });
    expect(world.calls.some((call) => call[0] === 'bouncers')).toBe(false);
  });

  it('rührt bezogene Listen nicht an und nennt Sperren von Hand, die sich nicht neu setzen ließen', async () => {
    world.decisions = [
      decision(1, 'CAPI', '203.0.113.9', '100h0m0s', 'crowdsecurity/community-blocklist'),
      decision(2, 'lists', '203.0.113.10', '24h0m0s', 'firehol'),
      decision(3, 'cscli', '192.0.2.44', '23h0m0s', 'Von Hand'),
    ];
    world.alerts = [{ source: { scope: 'CAPI' } }, { source: { scope: 'lists:firehol' } }, { source: { scope: 'Ip' } }];
    world.failAdd.add('192.0.2.44');

    const result = await clearCrowdsec(actor);
    expect(result).toEqual({ alerts: 1, lifted: 0, kept: 0, lost: ['192.0.2.44'] });
    expect(world.calls.filter((call) => call[1] === 'delete')).toEqual([['alerts', 'delete', '--scope', 'Ip']]);
    expect(world.alerts.map((alert) => alert.source.scope)).toEqual(['CAPI', 'lists:firehol']);
    expect(world.audits[0].details).toContain('Nicht wieder gesetzt: 192.0.2.44.');
  });

  it('läuft nicht zweimal gleichzeitig', async () => {
    world.decisions = [decision(1, 'crowdsec', '203.0.113.58', '3h59m0s', 'crowdsecurity/http-probing')];
    world.pulls = ['2026-11-26T11:59:55Z', '2026-11-26T12:00:05Z'];
    const first = clearCrowdsec(actor);
    await expect(clearCrowdsec(actor)).rejects.toThrow('wird gerade geleert');
    await vi.advanceTimersByTimeAsync(10_000);
    await first;
  });
});
