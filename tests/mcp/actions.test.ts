import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '@/lib/api';

/**
 * Die Funktionen, die Oberfläche, interne API und MCP-Server gemeinsam rufen:
 * was ein Token nicht darf, und dass die Prüfungen der Routen mitgekommen sind.
 * Datenbank, Docker und acme.sh sind ersetzt.
 */

const calls = vi.hoisted(() => ({
  startUpdate: vi.fn(async () => ({ $id: 'run1' })),
  getDocument: vi.fn(),
  logAudit: vi.fn(async () => undefined),
  updateSettings: vi.fn(),
  saveCertificateSettings: vi.fn(),
  removeAcmeCertificate: vi.fn(),
  removeUploadedCertificate: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ getDocument: calls.getDocument }));
vi.mock('@/lib/audit', () => ({ logAudit: calls.logAudit }));
vi.mock('@/lib/updates/apply', () => ({ startUpdate: calls.startUpdate, listUpdateRuns: vi.fn(async () => []) }));
vi.mock('@/lib/updates/check', () => ({
  checkUpdates: vi.fn(),
  isCheckRunning: () => false,
  readUpdateStates: vi.fn(async () => []),
  settleAfterRuns: vi.fn(),
}));
vi.mock('@/lib/settings', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/settings')>()),
  getSettings: vi.fn(async () => ({})),
  updateSettings: calls.updateSettings,
}));
vi.mock('@/lib/certificate-settings', () => ({
  readCertificateSettings: (body: Record<string, unknown>) => body,
  saveCertificateSettings: calls.saveCertificateSettings,
}));
vi.mock('@/lib/acme', () => ({ ensureAcme: vi.fn() }));
vi.mock('@/lib/mail', () => ({ mailConfigured: vi.fn(async () => true) }));
vi.mock('@/lib/notifications', () => ({ notificationStatus: vi.fn(), sendTestMail: vi.fn() }));
vi.mock('@/lib/haproxy/provision', () => ({
  precheckCertificate: vi.fn(),
  readCertificateInventory: vi.fn(),
  removeAcmeCertificate: calls.removeAcmeCertificate,
  removeUploadedCertificate: calls.removeUploadedCertificate,
}));
vi.mock('@/lib/haproxy/runner', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/haproxy/runner')>()),
  startHaproxyRun: vi.fn(),
}));

const { startComponentUpdate, getUpdateRun } = await import('@/lib/updates/actions');
const { readServiceSettingsInput, readSettingsInput, changeCertificateSettings, sendTestMailAs } = await import(
  '@/lib/settings-actions'
);
const { removeCertificate } = await import('@/lib/haproxy/certificate-actions');

const actor = { userId: 'service:tok1', userEmail: 'deploy-skript', ip: '203.0.113.9' };

beforeEach(() => {
  for (const fn of Object.values(calls)) fn.mockClear();
});

async function rejection(promise: Promise<unknown>): Promise<ApiError> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(ApiError);
  return err as ApiError;
}

describe('Updates', () => {
  it('startet nur einen bekannten Bestandteil', async () => {
    const err = await rejection(startComponentUpdate('postgres', actor));
    expect(err.status).toBe(404);
    expect(calls.startUpdate).not.toHaveBeenCalled();
  });

  it('reicht den Actor an startUpdate, das ins Protokoll schreibt', async () => {
    await expect(startComponentUpdate('hapm', actor)).resolves.toEqual({ runId: 'run1' });
    expect(calls.startUpdate).toHaveBeenCalledWith('hapm', actor);
  });

  it('liest einen Lauf mit übersetztem Fehler und Protokolltext', async () => {
    calls.getDocument.mockResolvedValueOnce({
      $id: 'run1',
      component: 'haproxy',
      status: 'error',
      fromVersion: '3.0',
      toVersion: null,
      startedAt: 'a',
      completedAt: 'b',
      triggeredBy: 'deploy-skript',
      error: 'Abbruch',
      steps: JSON.stringify([{ label: 'Abbild holen', ok: true }]),
    });
    const run = await getUpdateRun('run1', (text) => `<${text}>`);
    expect(run.error).toBe('<Abbruch>');
    expect(run.steps).toHaveLength(1);
    expect(run.log).toContain('<Abbild holen>');
  });

  it('meldet einen unbekannten Lauf mit 404', async () => {
    calls.getDocument.mockRejectedValueOnce(new Error('not found'));
    expect((await rejection(getUpdateRun('nope', (t) => t))).status).toBe(404);
  });
});

describe('Einstellungen über ein Token', () => {
  it('lehnt die Adresse von HAPM ab', () => {
    expect(() => readServiceSettingsInput({ publicUrl: 'https://x.example' })).toThrow(ApiError);
  });

  it('lehnt das SMTP-Passwort ab, auch als null', () => {
    expect(() => readServiceSettingsInput({ smtpPass: 'geheim' })).toThrow(ApiError);
    expect(() => readServiceSettingsInput({ smtpPass: null })).toThrow(ApiError);
  });

  it('lehnt jede Änderung am SMTP-Server ab: wer ihn umstellt, bekäme die Links zum Zurücksetzen', () => {
    for (const body of [{ smtpHost: 'evil.example' }, { smtpPort: 25 }, { smtpSecurity: 'none' }, { smtpUser: 'x' }]) {
      expect(() => readServiceSettingsInput(body), JSON.stringify(body)).toThrow(ApiError);
    }
    // Absender und Empfänger bleiben möglich.
    expect(readServiceSettingsInput({ mailFrom: 'hapm@example.org' })).toEqual({ mailFrom: 'hapm@example.org' });
  });

  it('nimmt alles andere wie die Oberfläche', () => {
    const body = { exposure: 'public', notifyRecipients: ['ops@example.com'], autoUpdateHaproxy: true };
    expect(readServiceSettingsInput(body)).toEqual(readSettingsInput(body));
  });

  it('lehnt einen EAB-Schlüssel ab, ohne etwas zu speichern', async () => {
    await rejection(changeCertificateSettings({ source: 'acme', eabHmacKey: 'x' }, actor, { allowEab: false }));
    expect(calls.saveCertificateSettings).not.toHaveBeenCalled();
  });

  it('verlangt ohne Sitzung eine Adresse für die Testmail', async () => {
    await rejection(sendTestMailAs(undefined, actor, null));
  });
});

describe('Zertifikate über ein Token', () => {
  it('entfernt kein hochgeladenes', async () => {
    await rejection(removeCertificate({ file: 'shop.example.com.pem' }, actor, { allowUploaded: false }));
    expect(calls.removeUploadedCertificate).not.toHaveBeenCalled();
  });

  it('entfernt eins von acme.sh und schreibt ins Protokoll', async () => {
    calls.removeAcmeCertificate.mockResolvedValueOnce({
      certificate: { mainDomain: 'old.example.com', domains: ['old.example.com'], createdAt: null },
      reloaded: false,
    });
    await expect(removeCertificate({ domain: 'Old.Example.com' }, actor, { allowUploaded: false })).resolves.toEqual({
      mainDomain: 'old.example.com',
      reloaded: false,
    });
    expect(calls.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'service:tok1', userEmail: 'deploy-skript', action: 'haproxy_certificate_removed' })
    );
  });
});
