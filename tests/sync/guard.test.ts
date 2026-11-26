import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SyncRole } from '@/lib/sync/types';

/**
 * Ein Folgeknoten ändert nichts an dem, was der Abgleich überschreibt. Die
 * Sperre sitzt an zwei Stellen, die jeder Weg nimmt (Oberfläche, API, MCP,
 * Scheduler): `startHaproxyRun` und `withProxyLock`.
 */

const state = vi.hoisted(() => ({
  role: 'single' as SyncRole | 'kaputt',
  created: [] as string[],
  commands: [] as string[],
}));

vi.mock('@/lib/sync/store', () => ({
  getSyncSettings: vi.fn(async () => {
    if (state.role === 'kaputt') throw new Error('Datenbank nicht erreichbar');
    return { role: state.role };
  }),
}));

vi.mock('@/lib/db', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/db')>()),
  createDocument: vi.fn(async (collection: string, data: Record<string, unknown>) => {
    state.created.push(collection);
    return { $id: 'run1', ...data };
  }),
  updateDocument: vi.fn(async () => ({})),
  getDocument: vi.fn(async () => ({ $id: 'run1', status: 'error' })),
}));

vi.mock('@/lib/ssh', () => ({
  sshExec: vi.fn(async (_config: unknown, command: string) => {
    state.commands.push(command);
    return { code: 1, stdout: '', stderr: '' };
  }),
  localExec: vi.fn(async () => ({ code: 1, stdout: '', stderr: '' })),
}));

vi.mock('@/lib/audit', () => ({ logAudit: vi.fn(async () => undefined), systemActor: () => ({ userId: 'system', userEmail: 'scheduler' }) }));
vi.mock('@/lib/notifications', () => ({ notify: vi.fn(async () => 'disabled') }));

const { ApiError } = await import('@/lib/api');
const provision = await import('@/lib/haproxy/provision');
const { startHaproxyRun } = await import('@/lib/haproxy/runner');
const { getSyncRole, assertProxyWritable, assertDataWritable } = await import('@/lib/sync/role');
const { syncedChanges } = await import('@/lib/settings');
const { replicaNoticeFor } = await import('@/components/ReplicaNotice');
const { localServer } = await import('@/lib/helpers');

const actor = { userId: 'u1', email: 'admin@example.org', ip: null };

beforeEach(() => {
  state.role = 'single';
  state.created = [];
  state.commands = [];
  provision.onProxyChange(null);
});

describe('die Rolle', () => {
  it('gilt als „einzeln", wenn sie sich nicht lesen lässt', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    state.role = 'kaputt';
    await expect(getSyncRole()).resolves.toBe('single');
    await expect(assertProxyWritable()).resolves.toBeUndefined();
    quiet.mockRestore();
  });

  it.each(['single', 'primary'] as const)('%s darf ändern', async (role) => {
    state.role = role;
    await expect(assertProxyWritable()).resolves.toBeUndefined();
  });

  it('ein Folgeknoten nicht, mit einer Meldung, die sagt wo', async () => {
    state.role = 'replica';
    const error = await assertProxyWritable().catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as InstanceType<typeof ApiError>).status).toBe(409);
    expect((error as Error).message).toContain('Folgeknoten');
    expect((error as Error).message).toContain('Hauptknoten');
  });
});

describe('withProxyLock', () => {
  it('führt auf einem Folgeknoten nichts aus', async () => {
    state.role = 'replica';
    const fn = vi.fn(async () => 'geschrieben');
    await expect(provision.withProxyLock('local', fn)).rejects.toBeInstanceOf(ApiError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('prüft unter der Sperre: die Rolle zählt, wenn der Vorgang dran ist, nicht wenn er sich anstellt', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = provision.withProxyLock('local', () => held);
    const fn = vi.fn(async () => 'geschrieben');
    const second = provision.withProxyLock('local', fn);
    // Der erste ist dran und hält die Sperre. Während der zweite wartet, wird der Knoten zum Folgeknoten.
    await new Promise((resolve) => setTimeout(resolve, 0));
    state.role = 'replica';
    release();
    await first;
    await expect(second).rejects.toBeInstanceOf(ApiError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('gibt die Sperre nach einer Absage wieder frei', async () => {
    state.role = 'replica';
    await expect(provision.withProxyLock('local', async () => 1)).rejects.toBeInstanceOf(ApiError);
    state.role = 'primary';
    await expect(provision.withProxyLock('local', async () => 2)).resolves.toBe(2);
  });

  it('stößt nach jedem Vorgang den Abgleich an, auch nach einem gescheiterten', async () => {
    const hook = vi.fn();
    provision.onProxyChange(hook);
    await provision.withProxyLock('local', async () => 'ok');
    expect(hook).toHaveBeenCalledTimes(1);
    await expect(
      provision.withProxyLock('local', async () => {
        throw new Error('gescheitert');
      })
    ).rejects.toThrow('gescheitert');
    expect(hook).toHaveBeenCalledTimes(2);
  });

  it('lässt einen Vorgang nicht an einem Anstoß scheitern, der wirft', async () => {
    provision.onProxyChange(() => {
      throw new Error('Abgleich kaputt');
    });
    await expect(provision.withProxyLock('local', async () => 'ok')).resolves.toBe('ok');
  });
});

describe('withProxyLockLocal', () => {
  it('läuft auch auf einem Folgeknoten und stößt keinen Abgleich an', async () => {
    state.role = 'replica';
    const hook = vi.fn();
    provision.onProxyChange(hook);
    await expect(provision.withProxyLockLocal('local', async () => 'angewendet')).resolves.toBe('angewendet');
    expect(hook).not.toHaveBeenCalled();
  });

  it('teilt sich die Warteschlange mit withProxyLock', async () => {
    const order: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = provision.withProxyLock('local', async () => {
      order.push('lauf beginnt');
      await held;
      order.push('lauf endet');
    });
    const second = provision.withProxyLockLocal('local', async () => {
      order.push('abgleich');
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['lauf beginnt', 'lauf endet', 'abgleich']);
  });
});

describe('was ein Folgeknoten still auslässt', () => {
  it('die Länderlisten und die Freigaben: sie kommen mit dem Abgleich', async () => {
    state.role = 'replica';
    await expect(provision.refreshGeoBlockFiles(localServer())).resolves.toBe('none');
    await expect(provision.refreshCrowdsecAllowFile(localServer(), '203.0.113.7\n')).resolves.toBe('unchanged');
    expect(state.commands).toEqual([]);
  });
});

describe('der Datenteil: Konten, Einstellungen, DNS-Zonen, API-Keys, CrowdSec', () => {
  const AREAS = ['accounts', 'settings', 'dns', 'tokens', 'crowdsec'] as const;

  it.each(['single', 'primary'] as const)('%s darf ändern', async (role) => {
    state.role = role;
    for (const area of AREAS) await expect(assertDataWritable(area)).resolves.toBeUndefined();
  });

  it('ein Folgeknoten nicht, mit einer Meldung je Bereich', async () => {
    state.role = 'replica';
    const texts = new Set<string>();
    for (const area of AREAS) {
      const error = await assertDataWritable(area).catch((err: unknown) => err);
      expect(error).toBeInstanceOf(ApiError);
      expect((error as InstanceType<typeof ApiError>).status).toBe(409);
      expect((error as Error).message).toContain('Hauptknoten');
      texts.add((error as Error).message);
    }
    expect(texts.size).toBe(AREAS.length);
  });

  it('an den Einstellungen zählt nur, was abgeglichen wird und sich wirklich ändert', () => {
    const current = { exposure: 'public', notifyRecipients: ['ops@example.org'], autoUpdateTime: '04:00', smtpPass: null } as never;
    // Ein Formular schickt seine Felder unverändert mit: das ist keine Änderung.
    expect(syncedChanges({ exposure: 'public', notifyRecipients: ['ops@example.org'] }, current)).toEqual([]);
    // Selbsttätige Updates stellt jeder Knoten für sich ein.
    expect(syncedChanges({ autoUpdateTime: '03:00', autoUpdate: ['haproxy'], setupStatus: 'done' }, current)).toEqual([]);
    expect(syncedChanges({ exposure: 'internal', autoUpdateTime: '03:00' }, current)).toEqual(['exposure']);
    expect(syncedChanges({ notifyRecipients: [] }, current)).toEqual(['notifyRecipients']);
    expect(syncedChanges({ smtpPass: 'iv:tag:daten' }, current)).toEqual(['smtpPass']);
  });

  it('der Hinweis steht über jeder Seite, auf der sich sonst etwas davon ändern ließe', () => {
    for (const page of ['/dashboard', '/reverse-proxy', '/reverse-proxy/zertifikate', '/reverse-proxy/crowdsec', '/reverse-proxy/api', '/dns', '/users', '/konto', '/system', '/notifications']) {
      expect(replicaNoticeFor(page), page).toEqual(expect.any(String));
    }
    // Was dieser Knoten selbst mitschreibt oder für sich einstellt.
    for (const page of ['/reverse-proxy/statistiken', '/reverse-proxy/logs', '/protokoll', '/updates', '/backup', '/abgleich', '/system/darstellung']) {
      expect(replicaNoticeFor(page), page).toBeNull();
    }
    expect(replicaNoticeFor('/reverse-proxy/crowdsec')).not.toBe(replicaNoticeFor('/reverse-proxy'));
  });
});

describe('startHaproxyRun', () => {
  it('legt auf einem Folgeknoten keinen Lauf an', async () => {
    state.role = 'replica';
    await expect(
      startHaproxyRun({ server: localServer(), action: 'scope-add', serviceId: 'Kunden', actor })
    ).rejects.toBeInstanceOf(ApiError);
    expect(state.created).toEqual([]);
  });

  it('lässt nur den Lauf durch, der CrowdSec aus der eigenen Datei nimmt', async () => {
    state.role = 'replica';
    const removal = { httpsLines: [], adminIps: [], fromFile: true, crowdsec: false, crowdsecRemoveAll: true };
    await expect(
      startHaproxyRun({ server: localServer(), action: 'settings', serviceId: 'globale-einstellungen', settings: removal, actor })
    ).resolves.toMatchObject({ $id: 'run1' });
    expect(state.created).toEqual(['haproxy_runs']);
  });

  it('erkennt diesen Lauf eng', () => {
    const removal = { httpsLines: [], adminIps: [], fromFile: true, crowdsec: false, crowdsecRemoveAll: true };
    expect(provision.isLocalCrowdsecRemoval(removal)).toBe(true);
    expect(provision.isLocalCrowdsecRemoval(undefined)).toBe(false);
    // Jede andere Änderung an den Einstellungen des Proxys bleibt gesperrt.
    expect(provision.isLocalCrowdsecRemoval({ ...removal, fromFile: false })).toBe(false);
    expect(provision.isLocalCrowdsecRemoval({ ...removal, crowdsec: true })).toBe(false);
    expect(provision.isLocalCrowdsecRemoval({ ...removal, crowdsecRemoveAll: false })).toBe(false);
    expect(provision.isLocalCrowdsecRemoval({ ...removal, patch: { addAdminIps: ['203.0.113.7'] } })).toBe(false);
    expect(provision.isLocalCrowdsecRemoval({ ...removal, protection: { blockedIps: [], blockedCountries: [], rateLimit: null } as never })).toBe(false);
  });
});
