import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '@/lib/api';
import { createTranslator } from '@/lib/i18n';
import { addService, parseHaproxyConfig, type CreateServiceInput } from '@/lib/haproxy/config';
import { listedCas } from '@/lib/haproxy/backend-ca';
import { LEAF_KEY } from './fixtures/upload-certs';
import { EXPIRED_ROOT_CERT, PINNED_CERT, ROOT_CERT, ROOT_NOT_AFTER } from './fixtures/ca-certs';

/**
 * Die Funktionen, die Seite, interne API und MCP-Server für die
 * Zertifizierungsstellen gemeinsam rufen: was vor der Maschine abgelehnt wird,
 * was im Protokoll steht und wie die Liste aussieht. Die Maschine ist ersetzt.
 */

const calls = vi.hoisted(() => ({
  logAudit: vi.fn(async (_entry: { action: string; details?: string; userEmail: string }) => undefined),
  probeProxy: vi.fn(),
  readBackendCas: vi.fn(),
  uploadBackendCa: vi.fn(async (_server: unknown, _upload: { name: string }, _replace: boolean) => ({
    reloaded: false,
    usedBy: [] as string[],
  })),
  removeBackendCa: vi.fn(),
}));

vi.mock('@/lib/audit', () => ({ logAudit: calls.logAudit }));
vi.mock('@/lib/haproxy/provision', () => ({
  probeProxy: calls.probeProxy,
  readBackendCas: calls.readBackendCas,
  uploadBackendCa: calls.uploadBackendCa,
  removeBackendCa: calls.removeBackendCa,
}));

const { listCertificateAuthorities, removeCertificateAuthority, saveCertificateAuthority } = await import(
  '@/lib/haproxy/ca-actions'
);

const actor = { userId: 'service:tok1', userEmail: 'deploy-skript', ip: '203.0.113.9' };
const de = createTranslator('de').t;
const en = createTranslator('en').t;

async function refused(run: Promise<unknown>): Promise<ApiError> {
  try {
    await run;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error('nicht abgelehnt');
}

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockClear();
  calls.uploadBackendCa.mockResolvedValue({ reloaded: false, usedBy: [] });
});

describe('saveCertificateAuthority', () => {
  it('hinterlegt unter dem kleingeschriebenen Namen und schreibt ins Protokoll, was es war', async () => {
    const saved = await saveCertificateAuthority({ name: ' Intern-Root ', certificate: ROOT_CERT }, actor, de);
    expect(saved).toMatchObject({ name: 'intern-root', file: '/etc/haproxy/hapm-ca/intern-root.pem', notAfter: ROOT_NOT_AFTER, reloaded: false });
    expect(calls.uploadBackendCa).toHaveBeenCalledTimes(1);
    expect(calls.uploadBackendCa.mock.calls[0].slice(1)).toMatchObject([{ name: 'intern-root' }, false]);

    const entry = calls.logAudit.mock.calls[0][0];
    expect(entry).toMatchObject({ ...actor, action: 'haproxy_ca_uploaded', resource: 'server' });
    expect(entry.details).toContain('intern-root: Example Internal Root (gültig bis 2036-11-22, SHA-256 ');
    // Wer ihr vertraut und bis wann, nie der Inhalt.
    expect(entry.details).not.toContain('BEGIN CERTIFICATE');
  });

  it('ersetzt nur mit replace: true und sagt im Protokoll, wen es traf', async () => {
    calls.uploadBackendCa.mockResolvedValue({ reloaded: true, usedBy: ['app'] });
    const saved = await saveCertificateAuthority({ name: 'intern', certificate: ROOT_CERT, replace: true }, actor, de);
    expect(saved).toMatchObject({ reloaded: true, usedBy: ['app'] });
    expect(calls.uploadBackendCa.mock.calls[0][2]).toBe(true);
    expect(calls.logAudit.mock.calls[0][0].details).toContain('intern ersetzt: ');
    expect(calls.logAudit.mock.calls[0][0].details).toContain('HAProxy neu geladen, benutzt von app');
    // Alles außer `true` ist kein Ersetzen: ein Skript mit `"replace": "false"` überschreibt nichts.
    await saveCertificateAuthority({ name: 'intern', certificate: ROOT_CERT, replace: 'true' }, actor, de);
    expect(calls.uploadBackendCa.mock.calls[1][2]).toBe(false);
  });

  it('lehnt einen privaten Schlüssel ab, bevor die Maschine gefragt wird, und schreibt kein Protokoll', async () => {
    const error = await refused(saveCertificateAuthority({ name: 'intern', certificate: `${ROOT_CERT}\n${LEAF_KEY}` }, actor, de));
    expect(error.status).toBe(400);
    expect(error.message).toContain('privater Schlüssel');
    expect(calls.uploadBackendCa).not.toHaveBeenCalled();
    expect(calls.logAudit).not.toHaveBeenCalled();
  });

  it('lehnt einen Namen ab, der kein Dateiname wäre, und Eingaben, die kein Text sind', async () => {
    expect((await refused(saveCertificateAuthority({ name: '../../etc/cron.d/x', certificate: ROOT_CERT }, actor, de))).message).toContain(
      'Kleinbuchstaben'
    );
    expect((await refused(saveCertificateAuthority({ name: ['intern'], certificate: ROOT_CERT }, actor, de))).message).toContain('einen Namen');
    expect((await refused(saveCertificateAuthority({ name: 'intern', certificate: { pem: ROOT_CERT } }, actor, de))).message).toContain(
      'fügen Sie das Zertifikat'
    );
    expect(calls.uploadBackendCa).not.toHaveBeenCalled();
  });

  it('gibt Hinweise in der Sprache des Aufrufers zurück und hält sie deutsch im Protokoll fest', async () => {
    const saved = await saveCertificateAuthority({ name: 'nas', certificate: PINNED_CERT }, actor, en);
    expect(saved.warnings).toHaveLength(1);
    expect(saved.warnings[0]).toContain('self-signed');
    expect(calls.logAudit.mock.calls[0][0].details).toContain('Hinweise: „nas.intern.example" ist ein selbst signiertes Zertifikat');
  });

  it('schreibt kein Protokoll, wenn die Maschine ablehnt', async () => {
    calls.uploadBackendCa.mockRejectedValue(new ApiError('Unter dem Namen intern ist schon eine hinterlegt.', 409));
    expect((await refused(saveCertificateAuthority({ name: 'intern', certificate: ROOT_CERT }, actor, de))).status).toBe(409);
    expect(calls.logAudit).not.toHaveBeenCalled();
  });
});

describe('removeCertificateAuthority', () => {
  it('entfernt und nennt im Protokoll, was in der Datei stand', async () => {
    calls.removeBackendCa.mockResolvedValue(listedCas([{ file: 'intern.pem', pem: ROOT_CERT }])[0]);
    expect(await removeCertificateAuthority(' Intern ', actor)).toEqual({ name: 'intern' });
    expect(calls.removeBackendCa.mock.calls[0][1]).toBe('intern');
    expect(calls.logAudit.mock.calls[0][0]).toMatchObject({
      ...actor,
      action: 'haproxy_ca_removed',
      details: 'intern: Example Internal Root',
    });
  });

  it('fragt die Maschine nicht nach einem Namen, der keiner ist', async () => {
    for (const name of [null, undefined, '', '../x', 'a b']) {
      expect((await refused(removeCertificateAuthority(name, actor))).status).toBe(400);
    }
    expect(calls.removeBackendCa).not.toHaveBeenCalled();
  });
});

describe('listCertificateAuthorities', () => {
  const INPUT: CreateServiceInput = {
    scope: 'INTERN',
    id: 'app',
    domains: ['app.example.org'],
    servers: [{ name: '', target: '10.0.0.5:8443', weight: null }],
    redirect: null,
    routes: [],
    balance: null,
    sticky: false,
    lockedDomains: [],
    passwordLock: null,
    responseHeaders: [],
    requestHeaders: [],
    tunnel: false,
    crowdsec: false,
    app: null,
    healthcheck: true,
    backendTls: 'ca:intern',
  };
  const services = parseHaproxyConfig(
    addService('frontend f\n    bind :443\n\n# END AUTO INTERN SERVICES\n\n# END AUTO INTERN BACKENDS\n', INPUT)
  );

  it('nennt je Stelle Zertifikate, Tage bis zum Ablauf und die Ziele mit dem Weg zu ihnen', async () => {
    calls.probeProxy.mockResolvedValue({ services });
    calls.readBackendCas.mockResolvedValue(
      listedCas([
        { file: 'intern.pem', pem: ROOT_CERT },
        { file: 'alt.pem', pem: EXPIRED_ROOT_CERT },
        { file: 'kaputt.pem', pem: 'nichts' },
      ])
    );
    const list = await listCertificateAuthorities(de);
    expect(list.error).toBeNull();
    expect(list.warnDays).toBe(30);
    expect(list.authorities.map((ca) => ca.name)).toEqual(['alt', 'intern', 'kaputt']);
    const [old, intern, broken] = list.authorities;
    expect(intern.usedBy).toEqual([{ id: 'app', slug: 'intern' }]);
    expect(intern.daysLeft).toBeGreaterThan(3000);
    expect(old.usedBy).toEqual([]);
    expect(old.daysLeft).toBeLessThan(0);
    expect(broken.daysLeft).toBeNull();
  });

  it('meldet einen unlesbaren Ordner als unbekannt, nicht als leer', async () => {
    calls.probeProxy.mockResolvedValue({ services: [] });
    calls.readBackendCas.mockResolvedValue(null);
    const list = await listCertificateAuthorities(de);
    expect(list.authorities).toEqual([]);
    expect(list.error).toContain('nicht lesbar');
  });

  it('wirft nicht, wenn HAProxy nicht antwortet', async () => {
    calls.probeProxy.mockRejectedValue(new Error('HAProxy antwortet nicht'));
    const list = await listCertificateAuthorities(de);
    expect(list).toMatchObject({ authorities: [], error: 'HAProxy antwortet nicht' });
  });
});
