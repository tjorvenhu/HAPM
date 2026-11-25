import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Die interne API für Updates und Sicherung: das Token steht als Actor im
 * Aufruf (Name des Tokens im Protokoll), und ohne gültiges Token passiert
 * nichts. Was jede interne Route sonst einhalten muss, prüft
 * `internal-api.test.ts` über den Quelltext.
 */

const calls = vi.hoisted(() => ({
  token: true,
  startComponentUpdate: vi.fn(async () => ({ runId: 'u1' })),
  updatesOverview: vi.fn(async () => ({ states: [] })),
  checkUpdatesNow: vi.fn(async () => ({ states: [] })),
  startBackupRun: vi.fn(async () => ({ runId: 'b1' })),
}));

vi.mock('@/lib/service-auth', () => ({
  requireServiceToken: async () => {
    const { ApiError } = await import('@/lib/api');
    if (!calls.token) throw new ApiError('Ungültiges Token', 401);
    return { id: 'tok1', name: 'deploy-skript' };
  },
}));
vi.mock('@/lib/updates/actions', () => ({
  startComponentUpdate: calls.startComponentUpdate,
  updatesOverview: calls.updatesOverview,
  checkUpdatesNow: calls.checkUpdatesNow,
}));
vi.mock('@/lib/backup/actions', () => ({
  startBackupRun: calls.startBackupRun,
  backupOverview: vi.fn(),
  changeBackupSettings: vi.fn(),
}));

const updates = await import('@/app/api/internal/updates/route');
const component = await import('@/app/api/internal/updates/[component]/route');
const backup = await import('@/app/api/internal/backup/route');

function request(path: string, method = 'GET'): Request {
  return new Request(`https://hapm.example.test${path}`, {
    method,
    headers: { authorization: 'Bearer hapm_x', 'x-forwarded-for': '203.0.113.9' },
  });
}

const tokenActor = { userId: 'service:tok1', userEmail: 'deploy-skript', ip: '203.0.113.9' };

beforeEach(() => {
  calls.token = true;
  for (const fn of [calls.startComponentUpdate, calls.updatesOverview, calls.checkUpdatesNow, calls.startBackupRun]) {
    fn.mockClear();
  }
});

describe('/api/internal/updates', () => {
  it('liest den Stand und prüft nur mit ?check=1', async () => {
    expect((await updates.GET(request('/api/internal/updates'))).status).toBe(200);
    expect(calls.checkUpdatesNow).not.toHaveBeenCalled();
    await updates.GET(request('/api/internal/updates?check=1'));
    expect(calls.checkUpdatesNow).toHaveBeenCalledTimes(1);
  });

  it('startet ein Update unter dem Namen des Tokens', async () => {
    const res = await component.POST(request('/api/internal/updates/hapm', 'POST'), {
      params: Promise.resolve({ component: 'hapm' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { runId: 'u1' } });
    expect(calls.startComponentUpdate).toHaveBeenCalledWith('hapm', tokenActor);
  });

  it('tut ohne gültiges Token nichts', async () => {
    calls.token = false;
    const res = await component.POST(request('/api/internal/updates/hapm', 'POST'), {
      params: Promise.resolve({ component: 'hapm' }),
    });
    expect(res.status).toBe(401);
    expect(calls.startComponentUpdate).not.toHaveBeenCalled();
  });
});

describe('/api/internal/backup', () => {
  it('startet eine Sicherung unter dem Namen des Tokens', async () => {
    const res = await backup.POST(request('/api/internal/backup', 'POST'));
    expect(res.status).toBe(200);
    expect(calls.startBackupRun).toHaveBeenCalledWith(tokenActor);
  });
});
