/**
 * Der Folgeknoten: ein Paket annehmen und anwenden.
 *
 * ── Annehmen und Anwenden sind zwei Schritte ──
 *
 * Die Anfrage des Hauptknotens endet, sobald das Paket geprüft und angenommen
 * ist. Angewendet wird danach, abgekoppelt: das Neuladen von HAProxy kann eine
 * Minute dauern, und eine Anfrage, die über das HAProxy dieses Knotens käme,
 * schnitte es nach 50 Sekunden ab (`timeout server`). Wie weit das Anwenden
 * ist, fragt der Hauptknoten über die Auskunft (`nodeReport`).
 *
 * ── Wann ein Paket abgelehnt wird ──
 *
 *  - Dieser Knoten ist kein Folgeknoten. Zwei Hauptknoten überschrieben sich
 *    sonst gegenseitig; das ist der Fall, in dem ein alter Hauptknoten nach
 *    einem Ausfall zurückkommt, während sein Folgeknoten befördert wurde.
 *  - Es kommt von einem anderen Hauptknoten als dem, von dem der erste Stand
 *    kam. Ein Folgeknoten mit zwei Herren trüge abwechselnd den Stand des einen
 *    und des anderen. Wer den Hauptknoten wechselt, erzeugt hier einen neuen
 *    Kopplungsschlüssel, das löst die Bindung.
 *  - Es ist älter als das zuletzt übernommene (`seq`): ein mitgeschnittenes
 *    Paket soll den Knoten nicht auf einen früheren Stand zurückstellen.
 *  - Es läuft gerade ein Anwenden.
 *
 * Angewendet wird hinter der Sperre der Läufe (`withProxyLockLocal`), wie
 * jeder andere Vorgang an `haproxy.cfg`.
 */

import { logAudit, systemActor } from '../audit';
import { sshExec } from '../ssh';
import { buildCommand } from '../shell';
import { LOCAL_SERVER_ID, getSSHConfig, localServer } from '../helpers';
import { HAPROXY_CFG } from '../haproxy/config';
import { withProxyLockLocal } from '../haproxy/provision';
import { crowdsecInstalled } from '../crowdsec/paths';
import { msgid } from '../i18n/translate';
import { localVariant } from './adapt';
import { applyUnpacked } from './apply-core';
import { applyData, type DataApplyResult } from './data-apply';
import { BundleError, ROOT_DIRS, ROOT_NAMES, unpack, type Unpacked } from './bundle';
import { localNode, nodeReport } from './node';
import { RunLog, closeOpenSyncRuns, createSyncRun, getSyncSettings, updateSyncRun, updateSyncSettings } from './store';
import { recoverInterrupted } from './swap';
import { SYNC_PROTOCOL, type ApplyState, type NodeAnswer, type RefusalCode } from './types';

const globalState = globalThis as unknown as { __hapmSyncApply?: { current: ApplyState | null } };

function memory() {
  return (globalState.__hapmSyncApply ??= { current: null });
}

/** Das Anwenden, das läuft oder zuletzt lief. Für die Auskunft an den Hauptknoten. */
export function currentApply(): ApplyState | null {
  return memory().current;
}

const CHECK_MS = 60_000;
const RELOAD_MS = 90_000;

function tail(text: string, max = 800): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
}

async function checkConfig(): Promise<{ ok: boolean; detail: string }> {
  const ssh = await getSSHConfig(localServer());
  const res = await sshExec(ssh, buildCommand(['haproxy', '-c', '-f', HAPROXY_CFG]), CHECK_MS);
  return { ok: res.code === 0, detail: tail(res.stderr || res.stdout) };
}

async function reloadHaproxy(): Promise<{ ok: boolean; detail: string }> {
  const ssh = await getSSHConfig(localServer());
  const res = await sshExec(ssh, buildCommand(['hapm-reload']), RELOAD_MS);
  return { ok: res.code === 0, detail: tail(res.stderr || res.stdout) };
}

async function refuse(code: RefusalCode, detail?: string): Promise<NodeAnswer> {
  return { ok: false, code, report: await nodeReport(currentApply()).catch(() => null), ...(detail ? { detail } : {}) };
}

/**
 * Ein Hauptknoten hat angeklopft, und dieser Knoten nimmt von ihm nichts: das
 * steht danach auf der Seite „Abgleich" und im Protokoll, denn es heißt, dass
 * zwei Knoten sich für den Hauptknoten halten.
 */
async function noteRejection(code: 'not_replica' | 'other_primary', sender: { nodeId: string; name: string }): Promise<void> {
  await updateSyncSettings({
    rejected: { at: new Date().toISOString(), nodeId: sender.nodeId, name: sender.name, code },
  }).catch(() => undefined);
  await logAudit({
    ...systemActor(),
    action: 'sync_rejected',
    resource: 'sync',
    details:
      code === 'not_replica'
        ? `Abgleich von ${sender.name} abgelehnt: dieser Knoten ist kein Folgeknoten.`
        : `Abgleich von ${sender.name} abgelehnt: dieser Knoten ist an einen anderen Hauptknoten gebunden.`,
  });
}

/** Ein entschlüsseltes Paket prüfen und, wenn es gilt, das Anwenden starten. */
export async function acceptBundle(bundle: Buffer): Promise<NodeAnswer> {
  let unpacked: Unpacked;
  try {
    unpacked = unpack(bundle);
  } catch (err) {
    if (err instanceof BundleError) return refuse('invalid', err.message);
    throw err;
  }
  const { meta } = unpacked;
  if (meta.protocol !== SYNC_PROTOCOL) return refuse('protocol');

  const settings = await getSyncSettings();
  if (meta.sender.nodeId === settings.nodeId) return refuse('invalid', 'Das Paket stammt von diesem Knoten selbst.');
  if (settings.role !== 'replica') {
    await noteRejection('not_replica', meta.sender);
    return refuse('not_replica');
  }
  if (settings.primary && settings.primary.nodeId !== meta.sender.nodeId) {
    await noteRejection('other_primary', meta.sender);
    return refuse('other_primary');
  }
  if (settings.applied && meta.seq <= settings.applied.seq) return refuse('stale');

  const state = memory();
  if (state.current?.state === 'running') return refuse('busy');
  state.current = { seq: meta.seq, state: 'running', startedAt: new Date().toISOString(), completedAt: null, steps: [], error: null };

  void runApply(unpacked).catch((err) => {
    console.error('[abgleich] Anwenden gescheitert:', err);
    const current = memory().current;
    if (current && current.seq === meta.seq && current.state === 'running') {
      current.state = 'error';
      current.completedAt = new Date().toISOString();
      current.error = err instanceof Error ? err.message : String(err);
    }
  });
  return { ok: true, accepted: true, seq: meta.seq };
}

async function runApply(unpacked: Unpacked): Promise<void> {
  const { meta } = unpacked;
  const current = memory().current!;
  const run = await createSyncRun({
    direction: 'receive',
    trigger: 'incoming',
    status: 'running',
    startedAt: current.startedAt,
    completedAt: null,
    peers: meta.sender.name,
    steps: '[]',
    error: null,
    triggeredBy: meta.sender.name,
  });
  const log = new RunLog(run.$id);
  const local = localNode();

  let result: Awaited<ReturnType<typeof applyUnpacked>> | null = null;
  let failure: string | null = null;
  try {
    result = await withProxyLockLocal(LOCAL_SERVER_ID, () =>
      applyUnpacked(unpacked, {
        dirs: ROOT_DIRS,
        local,
        check: checkConfig,
        reload: reloadHaproxy,
        onStep: async (step) => {
          current.steps.push(step);
          await log.add(step.label, step.ok, step.detail);
        },
      })
    );
    if (!result.ok) {
      const failed = result.steps.find((step) => !step.ok);
      failure = failed ? [failed.label, failed.detail].filter(Boolean).join(': ') : msgid('Der Abgleich nennt keinen Grund.');
    }
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err);
    await log.add(msgid('Abbruch'), false, failure);
    current.steps.push({ label: msgid('Abbruch'), ok: false, detail: failure });
  }

  /* Die Daten nach den Dateien, und auch dann, wenn HAProxy die Dateien
   * abgelehnt hat: ein entferntes Konto oder ein zurückgezogener API-Key soll
   * nicht daran hängen, ob eine `haproxy.cfg` hier lädt. Nicht hinter der
   * Sperre der Läufe: geschrieben wird in die Datenbank und in CrowdSec, das
   * seine eigene Warteschlange hat. */
  let data: DataApplyResult | null = null;
  if (unpacked.data) {
    try {
      data = await applyData(unpacked.data, async (step) => {
        current.steps.push(step);
        await log.add(step.label, step.ok, step.detail);
      });
      if (!data.ok && !failure) {
        const failed = data.steps.find((step) => !step.ok);
        failure = failed ? [failed.label, failed.detail].filter(Boolean).join(': ') : msgid('Der Abgleich nennt keinen Grund.');
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      failure ??= reason;
      await log.add(msgid('Abbruch'), false, reason);
      current.steps.push({ label: msgid('Abbruch'), ok: false, detail: reason });
    }
  }

  const at = new Date().toISOString();
  if (result?.ok) {
    const before = (await getSyncSettings().catch(() => null))?.applied ?? null;
    await updateSyncSettings({
      primary: { nodeId: meta.sender.nodeId, name: meta.sender.name },
      applied: {
        fingerprint: meta.fingerprint,
        seq: meta.seq,
        at,
        variant: localVariant(local),
        localFingerprint: result.localFingerprint ?? '',
        crowdsec: result.crowdsec,
        // Ein Teil, der nicht kam, bleibt, wie er war. Einer, der scheiterte,
        // gilt als nicht übernommen: der Hauptknoten schickt ihn erneut.
        dataFingerprint: data ? (data.dbOk ? meta.dataFingerprint : null) : (before?.dataFingerprint ?? null),
        localDataFingerprint: data ? data.localFingerprint : (before?.localDataFingerprint ?? null),
        crowdsecFingerprint:
          data?.crowdsec === true ? meta.crowdsecFingerprint : data?.crowdsec === false ? null : (before?.crowdsecFingerprint ?? null),
      },
      rejected: null,
    });
  }

  await updateSyncRun(run.$id, { status: failure ? 'error' : 'success', completedAt: at, error: failure }).catch(() => undefined);
  current.state = failure ? 'error' : 'success';
  current.completedAt = at;
  current.error = failure;

  await logAudit({
    ...systemActor(),
    action: failure ? 'sync_apply_failed' : 'sync_applied',
    resource: 'sync',
    details: failure
      ? `Stand von ${meta.sender.name} nicht übernommen: ${failure}`
      : `Stand von ${meta.sender.name} übernommen${result?.changed || (data?.changes.length ?? 0) > 0 ? '' : ' (lag schon so vor)'}` +
        // Was sich an Konten, Einstellungen, Zonen, API-Keys und CrowdSec geändert hat, steht hier nachlesbar.
        (data && data.changes.length > 0 ? `. ${data.changes.join('; ')}` : ''),
  });

  /* Die Ausnahmen von CrowdSec hängen an den Anwendungen der Ziele, und die
   * stehen in der Datei, die gerade kam (`# hapm-app:`). Derselbe Abgleich wie
   * nach jedem Lauf am Reverse-Proxy. Er schreibt nur in den Ordner von
   * CrowdSec, nie nach `/etc/haproxy`. */
  if (result?.ok && result.changed && crowdsecInstalled()) {
    void import('../crowdsec/actions')
      .then(({ queueAppSync }) => queueAppSync(systemActor()))
      .catch(() => undefined);
  }
}

/**
 * Beim Start von HAPM: was der vorige Prozess offen gelassen hat.
 *
 * Ein Lauf, der noch läuft, ist mit ihm gestorben. Und wurde er mitten im
 * Tausch beendet, liegt `.hapm-sync-old` noch da: dann hat HAProxy den neuen
 * Stand nie bestätigt, und der alte kommt zurück. Der Hauptknoten sieht bei
 * seiner nächsten Prüfung, dass der Stand hier nicht seiner ist, und schickt
 * ihn erneut.
 */
export async function reconcileSync(): Promise<void> {
  await closeOpenSyncRuns();
  for (const root of ROOT_NAMES) {
    try {
      if (recoverInterrupted(root, ROOT_DIRS[root])) {
        console.log(`[abgleich] ${ROOT_DIRS[root]}: ein abgebrochener Abgleich wurde zurückgenommen.`);
      }
    } catch (err) {
      console.error(`[abgleich] ${ROOT_DIRS[root]}: abgebrochener Abgleich nicht zurückgenommen:`, err instanceof Error ? err.message : err);
    }
  }
}
