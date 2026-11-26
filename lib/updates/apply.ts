/**
 * Ein Update einspielen: HAProxy, HAPM selbst oder acme.sh.
 *
 * Jeder Lauf ist eine Zeile in `update_runs` mit seinen Schritten, wie die
 * Vorgänge am Reverse-Proxy. Er läuft abgekoppelt von der Anfrage: ein Abbild
 * zu holen dauert, und die Seite soll dabei nicht an einem Spinner hängen.
 *
 * Drei Regeln, die für alle drei gelten:
 *  - Es läuft immer nur ein Update gleichzeitig.
 *  - Bevor HAProxy ersetzt wird, prüft das NEUE Abbild die vorhandene
 *    Konfiguration. Lehnt es sie ab, bleibt alles, wie es ist.
 *  - Steht der neue Container nicht, kommt der alte zurück (`replace.mjs`).
 *
 * Schritte und Fehler stehen als deutscher Text im Lauf. Was keine Werte
 * einsetzt, ist ein Schlüssel (`msgid`), den die Seite übersetzt. Texte mit
 * Werten bleiben deutsch, bis die Schritte `{ text, params }` speichern
 * (docs/i18n.md).
 */

import { createDocument, listDocuments, updateDocument, Query } from '../db';
import { ApiError } from '../api';
import { msg, msgid } from '../i18n';
import { logAudit } from '../audit';
import { COLLECTIONS, type HaproxyStep, type UpdateComponent, type UpdateRun } from '../types';
import { containerInfo, engine, haproxyContainerName, ownContainer } from '../docker';
import { bouncerContainerName, crowdsecContainerName } from '../crowdsec/paths';
import { replaceContainer } from '../docker/replace.mjs';
import { HAPROXY_CFG } from '../haproxy/config';
import { acmeStatus, upgradeAcme } from '../acme';
import { checkUpdatesAfterNow } from './check';
import { notify } from '../notifications';

export interface UpdateActor {
  userId: string;
  userEmail: string;
  ip?: string;
}

const LABELS: Record<UpdateComponent, string> = {
  haproxy: 'HAProxy',
  hapm: 'HAPM',
  acme: 'acme.sh',
  crowdsec: 'CrowdSec',
  'crowdsec-bouncer': 'CrowdSec-Bouncer',
};

function containerOf(component: UpdateComponent): string | null {
  if (component === 'haproxy') return haproxyContainerName();
  if (component === 'crowdsec') return crowdsecContainerName();
  if (component === 'crowdsec-bouncer') return bouncerContainerName();
  if (component === 'hapm') return ownContainer();
  return null;
}

export function componentLabel(component: UpdateComponent): string {
  return LABELS[component];
}

const globalLock = globalThis as unknown as { __hapmUpdateRunning?: boolean };

class StepLog {
  readonly steps: HaproxyStep[] = [];
  constructor(private readonly runId: string) {}

  async add(label: string, ok: boolean, detail?: string): Promise<void> {
    this.steps.push({ label, ok, ...(detail ? { detail: detail.slice(0, 2000) } : {}) });
    // Nach jedem Schritt, nicht am Ende: sonst zeigt die Seite minutenlang nur „läuft".
    await updateDocument<UpdateRun>(COLLECTIONS.UPDATE_RUNS, this.runId, {
      steps: JSON.stringify(this.steps),
    }).catch(() => undefined);
  }
}

class UpdateFailure extends Error {}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Antworten der Engine */

/** Holt das Abbild und sagt, ob es ein anderes ist als das laufende. */
async function pull(log: StepLog, reference: string, currentImageId: string): Promise<boolean> {
  let last = '';
  await engine.pullImage(reference, (line: string) => (last = line));
  const image: any = await engine.inspectImage(reference);
  if (image.Id === currentImageId) {
    await log.add(msgid('Abbild holen'), true, `${reference} ist schon das laufende Abbild.`);
    return false;
  }
  await log.add(msgid('Abbild holen'), true, last || `${reference} geholt.`);
  return true;
}

/**
 * Die vorhandene Konfiguration mit dem neuen Abbild prüfen, bevor irgendetwas
 * angehalten wird. Ein einmaliger Container mit denselben Volumes, ohne Netz.
 */
async function checkConfigWith(reference: string, current: any): Promise<{ ok: boolean; output: string }> {
  const name = `hapm-check-${Date.now()}`;
  await engine.createContainer(name, {
    Image: reference,
    Cmd: ['haproxy', '-c', '-f', HAPROXY_CFG],
    User: 'root',
    HostConfig: {
      Binds: current.HostConfig?.Binds ?? [],
      Mounts: current.HostConfig?.Mounts ?? [],
      NetworkMode: 'none',
    },
  });
  try {
    await engine.start(name);
    const code = await engine.wait(name, 60_000);
    const output = await engine.logs(name, { tail: 60 }).catch(() => '');
    return { ok: code === 0, output: output.trim() };
  } finally {
    await engine.removeContainer(name, { force: true }).catch(() => undefined);
  }
}

async function updateHaproxy(log: StepLog): Promise<string | null> {
  const name = haproxyContainerName();
  const current: any = await engine.findContainer(name);
  if (!current) throw new UpdateFailure(`Der Container "${name}" existiert nicht.`);
  const reference: string = current.Config.Image;
  // Vor dem Holen: danach trägt das alte Abbild keinen Namen mehr und kann weg sein.
  const oldImage = await engine.inspectImage(current.Image).catch(() => null);

  if (!(await pull(log, reference, current.Image))) return null;

  const check = await checkConfigWith(reference, current);
  await log.add(
    msgid('Konfiguration mit der neuen Fassung prüfen'),
    check.ok,
    check.ok ? msgid('Die neue Fassung nimmt die Konfiguration an.') : check.output
  );
  if (!check.ok) {
    throw new UpdateFailure(
      msgid('Die neue Fassung von HAProxy lehnt die vorhandene Konfiguration ab. Es wurde nichts geändert.')
    );
  }

  const lines: string[] = [];
  const replaced = await replaceContainer(name, reference, {
    log: (line: string) => lines.push(line),
    oldImage: oldImage ?? undefined,
  });
  await log.add(
    msgid('Container ersetzen'),
    replaced.ok,
    replaced.ok ? lines.join('. ') : `${replaced.error ?? ''}${replaced.tail ? `\n${replaced.tail}` : ''}`
  );
  if (!replaced.ok) {
    throw new UpdateFailure(msgid('Der neue Container ist nicht gestartet. Der bisherige läuft wieder.'));
  }

  // Das alte Abbild belegt sonst für immer Platz. Hängt noch etwas daran, lehnt Docker ab.
  const removed = await engine.removeImage(current.Image).then(
    () => true,
    () => false
  );
  await log.add(
    msgid('Altes Abbild entfernen'),
    true,
    removed ? undefined : msgid('Bleibt liegen, es wird noch benutzt.')
  );

  return (await containerInfo(name))?.version ?? null;
}

/**
 * HAPM ersetzt sich selbst über einen Helfer.
 *
 * Ein Prozess kann den Container, in dem er läuft, nicht anhalten und danach
 * noch einen neuen starten. Also startet er aus dem neuen Abbild einen zweiten
 * Container, der nur `hapm-ctl replace` ausführt, und wird von diesem ersetzt.
 * Wie es ausging, stellt der neue HAPM beim Start fest
 * (`reconcileUpdateRuns`).
 */
async function updateSelf(log: StepLog): Promise<'handover' | null> {
  const own = ownContainer();
  if (!own) throw new UpdateFailure(msgid('HAPM läuft nicht in einem Container.'));
  const current: any = await engine.inspectContainer(own);
  const reference: string = current.Config.Image;
  const oldImage = await engine.inspectImage(current.Image).catch(() => null);

  if (!(await pull(log, reference, current.Image))) return null;

  const socketMount = (current.Mounts ?? []).find((m: any) => m.Destination === '/var/run/docker.sock');
  const socketSource: string = socketMount?.Source ?? '/var/run/docker.sock';

  const helper = 'hapm-updater';
  const stale = await engine.findContainer(helper);
  if (stale) await engine.removeContainer(helper, { force: true });

  await engine.createContainer(helper, {
    Image: reference,
    Entrypoint: ['node', '/app/bin/hapm-ctl.mjs'],
    Cmd: ['replace', current.Id, reference],
    Env: [
      'HAPM_BOOTSTRAP=0',
      // Nur die Einrichtung des Abbilds, nicht seine Schichten: daran erkennt der
      // Helfer, was am Container eingestellt wurde und was das Abbild vorgab.
      ...(oldImage
        ? [`HAPM_OLD_IMAGE=${Buffer.from(JSON.stringify({ Config: oldImage.Config })).toString('base64')}`]
        : []),
    ],
    HostConfig: {
      Binds: [`${socketSource}:/var/run/docker.sock`],
      NetworkMode: 'none',
      AutoRemove: true,
    },
  });
  await log.add(
    msgid('Übergabe'),
    true,
    msgid('Ein Helfer aus dem neuen Abbild ersetzt jetzt den Container. HAPM ist gleich wieder da.')
  );
  await engine.start(helper);
  return 'handover';
}

/**
 * CrowdSec oder sein Bouncer: Abbild holen, Container ersetzen, altes Abbild
 * entfernen. Ohne Prüfung vorab wie bei HAProxy: es gibt keine Datei, die das
 * neue Abbild ablehnen könnte. Während des Tauschs gehen Anfragen ungeprüft
 * durch (HAProxy fragt einen Bouncer, der nicht antwortet, nicht weiter).
 */
async function updateContainer(log: StepLog, name: string): Promise<string | null> {
  const current: any = await engine.findContainer(name);
  if (!current) throw new UpdateFailure(`Der Container "${name}" existiert nicht.`);
  const reference: string = current.Config.Image;
  const oldImage = await engine.inspectImage(current.Image).catch(() => null);

  if (!(await pull(log, reference, current.Image))) return null;

  const lines: string[] = [];
  const replaced = await replaceContainer(name, reference, {
    log: (line: string) => lines.push(line),
    oldImage: oldImage ?? undefined,
  });
  await log.add(
    msgid('Container ersetzen'),
    replaced.ok,
    replaced.ok ? lines.join('. ') : `${replaced.error ?? ''}${replaced.tail ? `\n${replaced.tail}` : ''}`
  );
  if (!replaced.ok) {
    throw new UpdateFailure(msgid('Der neue Container ist nicht gestartet. Der bisherige läuft wieder.'));
  }
  const removed = await engine.removeImage(current.Image).then(
    () => true,
    () => false
  );
  await log.add(msgid('Altes Abbild entfernen'), true, removed ? undefined : msgid('Bleibt liegen, es wird noch benutzt.'));
  return (await containerInfo(name))?.version ?? null;
}

async function updateAcme(log: StepLog): Promise<string | null> {
  const result = await upgradeAcme();
  await log.add(msgid('acme.sh aktualisieren'), result.ok, result.output.trim().split('\n').slice(-3).join('\n'));
  if (!result.ok) throw new UpdateFailure(msgid('acme.sh ließ sich nicht aktualisieren.'));
  return (await acmeStatus()).version;
}

/* eslint-enable @typescript-eslint/no-explicit-any */

async function currentVersion(component: UpdateComponent): Promise<string | null> {
  if (component === 'acme') return (await acmeStatus().catch(() => null))?.version ?? null;
  const container = containerOf(component);
  if (!container) return null;
  return (await containerInfo(container).catch(() => null))?.version ?? null;
}

async function currentImage(component: UpdateComponent): Promise<string | null> {
  if (component === 'acme') return null;
  const container = containerOf(component);
  if (!container) return null;
  return (await containerInfo(container).catch(() => null))?.imageId ?? null;
}

/** Das Ende eines Laufs als Benachrichtigung. Hält nichts auf und wirft nie. */
function announce(run: UpdateRun, error: string | null, toVersion: string | null): void {
  void notify(
    error
      ? {
          type: 'update_failed',
          component: run.component,
          fromVersion: run.fromVersion,
          error,
          triggeredBy: run.triggeredBy,
        }
      : {
          type: 'update_completed',
          component: run.component,
          runId: run.$id,
          fromVersion: run.fromVersion,
          toVersion,
          triggeredBy: run.triggeredBy,
        }
  );
}

async function finish(
  run: UpdateRun,
  status: UpdateRun['status'],
  patch: Partial<UpdateRun>,
  actor: UpdateActor
): Promise<void> {
  await updateDocument<UpdateRun>(COLLECTIONS.UPDATE_RUNS, run.$id, {
    status,
    completedAt: new Date().toISOString(),
    ...patch,
  }).catch(() => undefined);
  await logAudit({
    ...actor,
    action: status === 'error' ? 'update_failed' : 'update_completed',
    resource: 'update',
    resourceId: run.component,
    details: `${LABELS[run.component]}: ${patch.error ?? `${run.fromVersion ?? '?'} → ${patch.toVersion ?? '?'}`}`,
  });
  announce(
    run,
    status === 'error' ? (patch.error ?? msgid('Der Lauf nennt keinen Grund.')) : null,
    patch.toVersion ?? null
  );
}

async function execute(run: UpdateRun, actor: UpdateActor): Promise<void> {
  const log = new StepLog(run.$id);
  try {
    if (run.component === 'hapm') {
      const outcome = await updateSelf(log);
      // Bei einer Übergabe bleibt der Lauf offen, der neue HAPM schließt ihn.
      if (outcome === 'handover') return;
      await finish(run, 'success', { toVersion: run.fromVersion }, actor);
    } else {
      const version =
        run.component === 'haproxy'
          ? await updateHaproxy(log)
          : run.component === 'acme'
            ? await updateAcme(log)
            : await updateContainer(log, containerOf(run.component)!);
      await finish(run, 'success', { toVersion: version ?? run.fromVersion }, actor);
    }
  } catch (err) {
    if (!(err instanceof UpdateFailure)) await log.add(msgid('Abbruch'), false, message(err));
    await finish(run, 'error', { error: message(err) }, actor);
  } finally {
    globalLock.__hapmUpdateRunning = false;
    await checkUpdatesAfterNow().catch(() => undefined);
  }
}

export async function startUpdate(component: UpdateComponent, actor: UpdateActor): Promise<UpdateRun> {
  await expireStaleUpdateRuns();
  const open = await listDocuments<UpdateRun>(COLLECTIONS.UPDATE_RUNS, [
    Query.equal('status', 'running'),
    Query.limit(1),
  ]);
  // Die Zeile zählt mit, nicht nur die Sperre im Prozess: während HAPM sich
  // selbst ersetzt, ist die Sperre schon frei und der Lauf noch offen.
  if (globalLock.__hapmUpdateRunning || open.length > 0) {
    throw new ApiError(msg('Es läuft schon ein Update. Bitte warten, bis es fertig ist.'), 409);
  }
  globalLock.__hapmUpdateRunning = true;

  let run: UpdateRun;
  try {
    run = await createDocument<UpdateRun>(COLLECTIONS.UPDATE_RUNS, {
      component,
      status: 'running',
      fromVersion: await currentVersion(component),
      fromImage: await currentImage(component),
      toVersion: null,
      startedAt: new Date().toISOString(),
      completedAt: null,
      steps: '[]',
      error: null,
      triggeredBy: actor.userEmail,
    });
  } catch (err) {
    globalLock.__hapmUpdateRunning = false;
    throw err;
  }

  await logAudit({ ...actor, action: 'update_started', resource: 'update', resourceId: component, details: LABELS[component] });
  void execute(run, actor);
  return run;
}

/** So lange darf die Übergabe an den Helfer dauern, bevor sie als gescheitert gilt. */
const HANDOVER_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Eine Übergabe, die nie stattfand, schließen.
 *
 * Bei einem Update von HAPM bleibt der Lauf offen, bis der neue Container ihn
 * beim Start schließt. Stirbt der Helfer vorher, startet nie ein neuer
 * Container, und der Lauf bliebe für immer offen und sperrte jedes weitere
 * Update. Läuft dieser Prozess nach zehn Minuten noch, hat ihn niemand ersetzt.
 */
export async function expireStaleUpdateRuns(): Promise<void> {
  const open = await listDocuments<UpdateRun>(COLLECTIONS.UPDATE_RUNS, [
    Query.equal('status', 'running'),
    Query.limit(50),
  ]);
  for (const run of open) {
    if (run.component !== 'hapm') continue;
    if (Date.now() - Date.parse(run.startedAt) < HANDOVER_TIMEOUT_MS) continue;
    const steps = JSON.parse(run.steps ?? '[]') as HaproxyStep[];
    steps.push({
      label: msgid('Neuer Container'),
      ok: false,
      detail: msgid('Der Helfer hat den Container nicht ersetzt. HAPM läuft weiter in der bisherigen Fassung.'),
    });
    await updateDocument<UpdateRun>(COLLECTIONS.UPDATE_RUNS, run.$id, {
      status: 'error',
      completedAt: new Date().toISOString(),
      steps: JSON.stringify(steps),
      error: msgid('Die Übergabe an den Helfer ist nicht zustande gekommen.'),
    });
    announce(
      run,
      msgid('Die Übergabe an den Helfer ist nicht zustande gekommen. HAPM läuft weiter in der bisherigen Fassung.'),
      null
    );
  }
}

export async function listUpdateRuns(limit = 20): Promise<UpdateRun[]> {
  return listDocuments<UpdateRun>(COLLECTIONS.UPDATE_RUNS, [Query.orderDesc('startedAt'), Query.limit(limit)]);
}

/**
 * Beim Start: offene Läufe schließen.
 *
 * Ein Lauf für HAPM selbst ist beim Start der Normalfall, der neue Container
 * findet ihn offen vor. Ob er gelungen ist, sagt das Abbild, in dem dieser
 * Prozess läuft. Jeder andere offene Lauf ist mit dem alten Prozess gestorben.
 */
export async function reconcileUpdateRuns(): Promise<void> {
  const open = await listDocuments<UpdateRun>(COLLECTIONS.UPDATE_RUNS, [
    Query.equal('status', 'running'),
    Query.limit(50),
  ]);
  for (const run of open) {
    const completedAt = new Date().toISOString();
    if (run.component === 'hapm') {
      const version = await currentVersion('hapm');
      const steps = JSON.parse(run.steps ?? '[]') as HaproxyStep[];
      const image = await currentImage('hapm');
      const changed = image !== null && image !== run.fromImage;
      steps.push(
        changed
          ? { label: msgid('Neuer Container'), ok: true, detail: `HAPM ${version ?? ''} läuft.`.replace('  ', ' ') }
          : {
              label: msgid('Neuer Container'),
              ok: false,
              detail: msgid('HAPM läuft weiter in der bisherigen Fassung.'),
            }
      );
      const failed = msgid('Der neue Container ist nicht gestartet, der bisherige läuft wieder.');
      await updateDocument<UpdateRun>(COLLECTIONS.UPDATE_RUNS, run.$id, {
        status: changed ? 'success' : 'error',
        toVersion: version,
        completedAt,
        steps: JSON.stringify(steps),
        error: changed ? null : failed,
      });
      announce(run, changed ? null : failed, version);
    } else {
      const restarted = msgid('HAPM wurde während des Updates neu gestartet. Der Zustand steht unter „Updates“.');
      await updateDocument<UpdateRun>(COLLECTIONS.UPDATE_RUNS, run.$id, {
        status: 'error',
        completedAt,
        error: restarted,
      });
      announce(run, restarted, null);
    }
  }
  // Gleich prüfen und nicht erst mit der ersten Prüfung nach dem Start: bis dahin
  // stünde auf der Seite der Stand von vor dem Update.
  if (open.length > 0) void checkUpdatesAfterNow().catch(() => undefined);
}
