import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Die Warteschlange für Änderungen an den Regeln (`lib/crowdsec/rule-jobs.ts`,
 * `changeRules` und `queueRuleChange` in `lib/crowdsec/actions.ts`).
 *
 * Worauf es ankommt: die Änderungen laufen nacheinander, nie zwei `cscli`
 * nebeneinander, und CrowdSec startet je Lauf einmal neu, am Ende. `cscli` und
 * das Neuladen sind nachgebaut und lassen sich anhalten, damit sich prüfen
 * lässt, was sich einreiht, während etwas läuft.
 */

interface Gate {
  promise: Promise<void>;
  open: () => void;
}

function gate(): Gate {
  let open = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const world = vi.hoisted(() => ({
  /** `cscli`-Aufrufe und `RELOAD`, in der Reihenfolge, in der sie beginnen. */
  calls: [] as string[],
  /** Wie viele `cscli` gerade laufen, und der höchste Stand: nie mehr als eines. */
  running: 0,
  maxRunning: 0,
  /** Hält jedes `cscli` an, das etwas ändert. */
  cscliGate: null as { promise: Promise<void> } | null,
  /** Hält das Neuladen an. */
  reloadGate: null as { promise: Promise<void> } | null,
  reloadFails: false,
  /** Namen, deren `install`/`remove` scheitert. */
  fail: new Set<string>(),
  audits: [] as { action: string; resourceId: string; details: string }[],
}));

vi.mock('@/lib/audit', () => ({
  logAudit: vi.fn(async (entry: { action: string; resourceId: string; details: string }) => {
    world.audits.push({ action: entry.action, resourceId: entry.resourceId, details: entry.details });
  }),
}));

vi.mock('@/lib/crowdsec/cscli', async () => {
  const { ApiError } = await import('@/lib/api');
  const { msg } = await import('@/lib/i18n');
  class CrowdsecUnavailable extends ApiError {
    constructor() {
      super('CrowdSec ist nicht erreichbar.', 503);
    }
  }
  const run = async (args: string[]) => {
    // `hub list` liest nur: die Seite fragt es, während ein Lauf arbeitet.
    if (args[0] === 'hub' && args[1] === 'list') return { code: 0, stdout: 'null', stderr: '' };
    world.calls.push(args.join(' '));
    world.running += 1;
    world.maxRunning = Math.max(world.maxRunning, world.running);
    try {
      await world.cscliGate?.promise;
      return world.fail.has(args[2])
        ? { code: 1, stdout: '', stderr: 'level=fatal msg="hub nicht erreichbar"' }
        : { code: 0, stdout: 'fertig', stderr: '' };
    } finally {
      world.running -= 1;
    }
  };
  const cscliOk = async (args: string[]) => {
    const result = await run(args);
    if (result.code !== 0) throw new ApiError(msg('CrowdSec lehnt ab: {detail}', { detail: 'hub nicht erreichbar' }), 409);
    return result;
  };
  return {
    CrowdsecUnavailable,
    cscli: run,
    cscliOk,
    cscliJson: async (args: string[]) => JSON.parse((await cscliOk([...args, '-o', 'json'])).stdout),
  };
});

vi.mock('@/lib/crowdsec/setup', async (original) => ({
  ...(await original<typeof import('@/lib/crowdsec/setup')>()),
  reloadCrowdsec: vi.fn(async () => {
    world.calls.push('RELOAD');
    await world.reloadGate?.promise;
    if (world.reloadFails) throw new Error('Container startet nicht');
  }),
  // Die echte schriebe Dateien nach /var/log und in den Ordner von CrowdSec.
  writeCrowdsecFiles: vi.fn(() => ({ mounted: true, crowdsecChanged: true, bouncerChanged: false })),
}));

const { changeRules, queueRuleChange, crowdsecRules } = await import('@/lib/crowdsec/actions');
const { pendingRuleChanges, ruleRunActive, ruleRunView, setRuleGrace } = await import('@/lib/crowdsec/rule-jobs');
// Die Frist, in der ein Lauf auf weitere Änderungen wartet, hat ihren eigenen Fall unten.
setRuleGrace(0);
const { createTranslator } = await import('@/lib/i18n');

const actor = { userId: 'u1', userEmail: 'admin@example.org' };
const { t } = createTranslator('de');
const HTTP_DOS = 'crowdsecurity/http-dos';
const DRUPAL = 'crowdsecurity/appsec-crs-exclusion-plugin-drupal';

// `crowdsecInstalled()` fragt nach dem Ordner.
const dir = mkdtempSync(join(tmpdir(), 'hapm-crowdsec-'));
process.env.HAPM_CROWDSEC_DIR = dir;
delete process.env.HAPM_CROWDSEC_OFF;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function view(runId: string) {
  const run = ruleRunView(runId, t);
  if (!run) throw new Error(`Lauf ${runId} fehlt`);
  return run;
}

async function finished(runId: string) {
  await vi.waitFor(() => expect(view(runId).status).not.toBe('running'));
  return view(runId);
}

function reloads(): number {
  return world.calls.filter((call) => call === 'RELOAD').length;
}

beforeEach(() => {
  world.calls = [];
  world.running = 0;
  world.maxRunning = 0;
  world.cscliGate = null;
  world.reloadGate = null;
  world.reloadFails = false;
  world.fail = new Set();
  world.audits = [];
  (globalThis as unknown as { __hapmCrowdsecRuleJobs?: unknown }).__hapmCrowdsecRuleJobs = undefined;
});

describe('Warteschlange der Regeln', () => {
  it('arbeitet drei Änderungen nacheinander ab und lädt CrowdSec einmal neu, am Ende', async () => {
    const held = gate();
    world.cscliGate = held;
    const first = queueRuleChange({ app: 'drupal', installed: true }, actor);
    const second = queueRuleChange({ name: HTTP_DOS, installed: true }, actor);
    const third = queueRuleChange({ crs: 'block' }, actor);

    expect(first.key).toBe('app:drupal');
    expect(second).toEqual({ runId: first.runId, key: HTTP_DOS });
    expect(third).toEqual({ runId: first.runId, key: 'crs' });
    expect(ruleRunActive()).toBe(true);

    held.open();
    const run = await finished(first.runId);

    expect(world.calls).toEqual([
      `collections install ${DRUPAL}`,
      `collections install ${HTTP_DOS}`,
      'collections install crowdsecurity/appsec-crs-inband',
      'RELOAD',
    ]);
    expect(world.maxRunning).toBe(1);
    expect(run.status).toBe('success');
    expect(run.error).toBeNull();
    expect(run.completedAt).not.toBeNull();
    expect(run.steps).toEqual([
      { label: 'Drupal einschalten', ok: true },
      { label: 'HTTP-Flut einschalten', ok: true },
      { label: 'OWASP-Regeln: an', ok: true },
      { label: 'CrowdSec neu laden', ok: true },
    ]);
    expect(run.pending).toEqual([]);
    // Das Audit bleibt je Änderung.
    expect(world.audits).toEqual([
      { action: 'crowdsec_rules_updated', resourceId: 'app:drupal', details: 'Drupal: an' },
      { action: 'crowdsec_rules_updated', resourceId: HTTP_DOS, details: `${HTTP_DOS}: an` },
      { action: 'crowdsec_rules_updated', resourceId: 'crs', details: 'OWASP-Regeln: block' },
    ]);
    expect(ruleRunActive()).toBe(false);
    expect(pendingRuleChanges()).toEqual({});
  });

  it('hängt eine Änderung an den laufenden Lauf an und nennt, was aussteht', async () => {
    const held = gate();
    world.cscliGate = held;
    const first = queueRuleChange({ app: 'drupal', installed: true }, actor);
    await vi.waitFor(() => expect(world.calls).toHaveLength(1));

    const second = queueRuleChange({ name: HTTP_DOS, installed: false }, actor);
    expect(second.runId).toBe(first.runId);
    expect(view(first.runId)).toMatchObject({
      status: 'running',
      steps: [],
      pending: ['Drupal einschalten', 'HTTP-Flut ausschalten', 'CrowdSec neu laden'],
    });
    // So erfährt es die Seite, auch nach einem Neuladen.
    expect((await crowdsecRules()).pending).toEqual({ 'app:drupal': true, [HTTP_DOS]: false });

    held.open();
    const run = await finished(first.runId);
    expect(run.steps.map((step) => step.label)).toEqual(['Drupal einschalten', 'HTTP-Flut ausschalten', 'CrowdSec neu laden']);
    expect(world.calls).toEqual([`collections install ${DRUPAL}`, `collections remove ${HTTP_DOS}`, 'RELOAD']);
  });

  it('ersetzt eine wartende Änderung durch die spätere mit demselben Schlüssel', async () => {
    const held = gate();
    world.cscliGate = held;
    const first = queueRuleChange({ crs: 'block' }, actor);
    await vi.waitFor(() => expect(world.calls).toHaveLength(1));

    const replaced = changeRules({ name: HTTP_DOS, installed: true }, actor);
    const later = queueRuleChange({ name: HTTP_DOS, installed: false }, actor);
    expect(later.runId).toBe(first.runId);
    await expect(replaced).rejects.toMatchObject({ status: 409, message: expect.stringContaining('ersetzt') });
    expect(pendingRuleChanges()).toEqual({ crs: 'block', [HTTP_DOS]: false });
    expect(view(first.runId).pending).toEqual(['OWASP-Regeln: an', 'HTTP-Flut ausschalten', 'CrowdSec neu laden']);

    held.open();
    await finished(first.runId);
    expect(world.calls).toEqual(['collections install crowdsecurity/appsec-crs-inband', `collections remove ${HTTP_DOS}`, 'RELOAD']);
  });

  it('lässt nach einem Fehler die übrigen weiterlaufen, lädt trotzdem neu und endet mit error', async () => {
    world.fail.add(HTTP_DOS);
    const held = gate();
    world.reloadGate = held;
    const first = queueRuleChange({ name: HTTP_DOS, installed: true }, actor);
    const second = queueRuleChange({ app: 'drupal', installed: true }, actor);
    expect(second.runId).toBe(first.runId);

    // Während des Neuladens: die gescheiterte steht nicht mehr aus, die gelungene bis zum Ende.
    await vi.waitFor(() => expect(reloads()).toBe(1));
    expect(pendingRuleChanges()).toEqual({ 'app:drupal': true });
    expect(view(first.runId)).toMatchObject({ status: 'running', error: null, pending: ['CrowdSec neu laden'] });

    held.open();
    const run = await finished(first.runId);
    expect(run.status).toBe('error');
    expect(run.error).toBe('CrowdSec lehnt ab: hub nicht erreichbar');
    expect(run.steps).toEqual([
      { label: 'HTTP-Flut einschalten', ok: false, detail: 'CrowdSec lehnt ab: hub nicht erreichbar' },
      { label: 'Drupal einschalten', ok: true },
      { label: 'CrowdSec neu laden', ok: true },
    ]);
    expect(world.calls).toEqual([`collections install ${HTTP_DOS}`, `collections install ${DRUPAL}`, 'RELOAD']);
    expect(world.audits.map((entry) => entry.resourceId)).toEqual(['app:drupal']);
    expect(pendingRuleChanges()).toEqual({});
  });

  it('beginnt mit einer Änderung während des Neuladens den nächsten Lauf', async () => {
    const held = gate();
    world.reloadGate = held;
    const first = queueRuleChange({ app: 'drupal', installed: true }, actor);
    await vi.waitFor(() => expect(reloads()).toBe(1));

    const second = queueRuleChange({ name: HTTP_DOS, installed: true }, actor);
    expect(second.runId).not.toBe(first.runId);
    expect(view(second.runId)).toMatchObject({ status: 'running', steps: [] });
    // Solange CrowdSec neu startet, läuft kein `cscli`.
    expect(world.calls).toEqual([`collections install ${DRUPAL}`, 'RELOAD']);

    held.open();
    expect((await finished(first.runId)).status).toBe('success');
    expect((await finished(second.runId)).status).toBe('success');
    expect(world.calls).toEqual([`collections install ${DRUPAL}`, 'RELOAD', `collections install ${HTTP_DOS}`, 'RELOAD']);
  });

  it('wartet nach der letzten Änderung kurz: der nächste Klick gehört noch zu diesem Lauf', async () => {
    setRuleGrace(150);
    try {
      const first = await queueRuleChange({ app: 'drupal', installed: true }, actor);
      // Die erste Änderung ist längst durch, der Lauf aber noch offen.
      await vi.waitFor(() => expect(world.calls.length).toBeGreaterThan(0));
      expect(reloads()).toBe(0);
      const second = await queueRuleChange({ name: HTTP_DOS, installed: true }, actor);
      expect(second.runId).toBe(first.runId);

      const run = await finished(first.runId);
      expect(run.status).toBe('success');
      expect(reloads()).toBe(1);
      expect(world.calls[world.calls.length - 1]).toBe('RELOAD');
    } finally {
      setRuleGrace(0);
    }
  });

  it('übersetzt die Schritte in die Sprache der Anfrage', async () => {
    const queued = queueRuleChange({ app: 'drupal', installed: false }, actor);
    await finished(queued.runId);
    const english = ruleRunView(queued.runId, createTranslator('en').t);
    expect(english?.steps.map((step) => step.label)).toEqual(['Switch off Drupal', 'Reload CrowdSec']);
  });

  it('kennt einen unbekannten Lauf nicht', () => {
    expect(ruleRunView('gibt-es-nicht', t)).toBeNull();
  });
});

describe('changeRules', () => {
  it('wartet auf die Änderung samt Neuladen und liefert dieselbe Rückgabe wie bisher', async () => {
    const held = gate();
    world.reloadGate = held;
    let settled = false;
    const pending = changeRules({ name: HTTP_DOS, installed: true }, actor).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(reloads()).toBe(1));
    expect(settled).toBe(false);
    held.open();
    expect(await pending).toEqual({ name: HTTP_DOS, installed: true });

    world.reloadGate = null;
    expect(await changeRules({ crs: 'block' }, actor)).toEqual({ crs: 'block' });
    expect(await changeRules({ app: 'drupal', installed: false }, actor)).toEqual({ app: 'drupal', installed: false });
    expect(await changeRules({ upgrade: true }, actor)).toEqual({ output: 'fertig' });
    expect(world.calls).toEqual([
      `collections install ${HTTP_DOS}`,
      'RELOAD',
      'collections install crowdsecurity/appsec-crs-inband',
      'RELOAD',
      `collections remove ${DRUPAL}`,
      'RELOAD',
      'hub update',
      'hub upgrade',
      'RELOAD',
    ]);
  });

  it('reiht sich hinter einen Lauf der Oberfläche ein, statt neben ihm zu arbeiten', async () => {
    const held = gate();
    world.cscliGate = held;
    const queued = queueRuleChange({ app: 'drupal', installed: true }, actor);
    await vi.waitFor(() => expect(world.calls).toHaveLength(1));
    const waiting = changeRules({ name: HTTP_DOS, installed: true }, actor);
    held.open();

    expect(await waiting).toEqual({ name: HTTP_DOS, installed: true });
    expect(view(queued.runId).status).toBe('success');
    expect(world.maxRunning).toBe(1);
    expect(reloads()).toBe(1);
  });

  it('scheitert mit dem Fehler der eigenen Änderung, nicht mit dem einer anderen', async () => {
    world.fail.add(HTTP_DOS);
    const held = gate();
    world.cscliGate = held;
    const failing = changeRules({ name: HTTP_DOS, installed: true }, actor);
    const fine = changeRules({ app: 'drupal', installed: true }, actor);
    const outcome = Promise.allSettled([failing, fine]);
    held.open();

    const [first, second] = await outcome;
    expect(first).toMatchObject({ status: 'rejected', reason: { status: 409, message: 'CrowdSec lehnt ab: hub nicht erreichbar' } });
    expect(second).toEqual({ status: 'fulfilled', value: { app: 'drupal', installed: true } });
    expect(reloads()).toBe(1);
  });

  it('scheitert, wenn CrowdSec nicht neu lädt: die Änderung gilt dann nicht', async () => {
    world.reloadFails = true;
    await expect(changeRules({ app: 'drupal', installed: true }, actor)).rejects.toThrow('Container startet nicht');
  });

  it('prüft vor dem Einreihen: was abgelehnt wird, kommt in keinen Lauf', async () => {
    expect(() => queueRuleChange({ app: 'gibt-es-nicht', installed: true }, actor)).toThrow(
      expect.objectContaining({ status: 404 })
    );
    expect(() => queueRuleChange({ app: 'drupal' }, actor)).toThrow('installed: true oder false');
    expect(() => queueRuleChange({ name: 'crowdsecurity/irgendwas', installed: true }, actor)).toThrow(
      expect.objectContaining({ status: 404 })
    );
    expect(() => queueRuleChange({ crs: 'laut' }, actor)).toThrow('Erwartet wird crs: off oder block.');
    // Das frühere „Nur melden“ gibt es nicht mehr.
    expect(() => queueRuleChange({ crs: 'detect' }, actor)).toThrow('Erwartet wird crs: off oder block.');
    await expect(changeRules({}, actor)).rejects.toThrow('Was soll sich ändern?');

    process.env.HAPM_CROWDSEC_OFF = '1';
    try {
      expect(() => queueRuleChange({ app: 'drupal', installed: true }, actor)).toThrow(expect.objectContaining({ status: 503 }));
    } finally {
      delete process.env.HAPM_CROWDSEC_OFF;
    }
    expect(ruleRunActive()).toBe(false);
    expect(world.calls).toEqual([]);
  });
});
