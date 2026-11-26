/**
 * Ein ausgepacktes Paket auf die Platte bringen: anpassen, bereitlegen,
 * tauschen, prüfen, neu laden, und an jeder Stelle zurück, an der es scheitert.
 *
 * Ohne Datenbank und ohne Docker: Prüfen und Neuladen kommen als Funktionen
 * herein. So rechnet `tests/sync/apply.test.ts` jeden Ausgang über
 * Temp-Verzeichnisse nach, und `scripts/verify-sync.ts` lässt dasselbe gegen
 * ein echtes HAProxy laufen.
 *
 * ── Die Reihenfolge ──
 *
 * Erst tauschen, dann prüfen: `haproxy.cfg` nennt ihre Zertifikate, Listen und
 * Fehlerseiten mit festen Pfaden, eine Prüfung neben dem gültigen Stand sähe
 * die alten. Zwischen Tausch und Neuladen läuft HAProxy mit dem, was es
 * geladen hat. Lehnt es den neuen Stand ab oder lädt nicht neu, kommt der alte
 * zurück, und ein zweites Neuladen stellt sicher, dass er auch gilt.
 */

import { msgid } from '../i18n/translate';
import { adaptConfig, type CrowdsecOutcome, type LocalNode } from './adapt';
import { collect, entryKey, fingerprintOf, type BundleEntry, type RootName, type Unpacked } from './bundle';
import { commit, recoverInterrupted, stage, swapBack, swapIn } from './swap';
import type { SyncStep } from './types';
import { createHash } from 'node:crypto';

export interface ApplyDeps {
  /** Wo die Ordner auf diesem Knoten liegen. */
  dirs: Record<RootName, string>;
  local: LocalNode;
  /** `haproxy -c` auf die eingesetzte Datei. */
  check: () => Promise<{ ok: boolean; detail: string }>;
  /** `hapm-reload`. */
  reload: () => Promise<{ ok: boolean; detail: string }>;
  onStep?: (step: SyncStep) => void | Promise<void>;
}

export interface ApplyResult {
  ok: boolean;
  steps: SyncStep[];
  crowdsec: CrowdsecOutcome;
  /** Fingerabdruck der Dateien hier nach dem Lauf. `null`, wenn er nicht zu lesen war. */
  localFingerprint: string | null;
  /** `false`: der Stand lag schon so vor, HAProxy wurde nicht neu geladen. */
  changed: boolean;
}

const HAPROXY_CFG_KEY = 'haproxy:haproxy.cfg';

export const CROWDSEC_NOTES: Partial<Record<CrowdsecOutcome, string>> = {
  removed: msgid(
    'CrowdSec ist auf diesem Knoten nicht eingeschaltet und wurde aus der Konfiguration genommen. Die Ziele laufen hier ohne WAF.'
  ),
  stuck: msgid(
    'CrowdSec ist auf diesem Knoten nicht eingeschaltet, ließ sich aber nicht aus der Konfiguration nehmen. HAProxy wartet hier bei jeder Anfrage auf den Bouncer.'
  ),
};

function sizeLabel(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Das Paket mit der `haproxy.cfg`, wie sie auf diesem Knoten stehen soll. */
export function adaptBundle(
  unpacked: Unpacked,
  local: LocalNode
): { entries: BundleEntry[]; contents: Map<string, Buffer>; crowdsec: CrowdsecOutcome } {
  const original = unpacked.contents.get(HAPROXY_CFG_KEY);
  if (!original) throw new Error('Im Paket fehlt haproxy.cfg.');
  const adapted = adaptConfig(original.toString('utf8'), local);
  if (adapted.text === original.toString('utf8')) {
    return { entries: unpacked.entries, contents: unpacked.contents, crowdsec: adapted.crowdsec };
  }
  const content = Buffer.from(adapted.text, 'utf8');
  const contents = new Map(unpacked.contents);
  contents.set(HAPROXY_CFG_KEY, content);
  const entries = unpacked.entries.map((entry) =>
    entryKey(entry) === HAPROXY_CFG_KEY
      ? { ...entry, size: content.length, sha256: createHash('sha256').update(content).digest('hex') }
      : entry
  );
  return { entries, contents, crowdsec: adapted.crowdsec };
}

export async function applyUnpacked(unpacked: Unpacked, deps: ApplyDeps): Promise<ApplyResult> {
  const steps: SyncStep[] = [];
  const push = async (label: string, ok: boolean, detail?: string) => {
    const step: SyncStep = { label, ok, ...(detail ? { detail: detail.slice(0, 1500) } : {}) };
    steps.push(step);
    try {
      await deps.onStep?.(step);
    } catch {
      // Wer mitliest, hält das Anwenden nicht auf.
    }
  };
  const roots = unpacked.meta.roots;
  const dirs = Object.fromEntries(roots.map((root) => [root, deps.dirs[root]])) as Partial<Record<RootName, string>>;
  const readLocal = (): string | null => {
    try {
      return fingerprintOf(collect(dirs).entries);
    } catch {
      return null;
    }
  };
  const done = (ok: boolean, crowdsec: CrowdsecOutcome, changed: boolean): ApplyResult => ({
    ok,
    steps,
    crowdsec,
    localFingerprint: readLocal(),
    changed,
  });

  // Ein früherer Lauf, den ein Neustart mitten im Tausch beendet hat.
  for (const root of roots) {
    try {
      if (recoverInterrupted(root, deps.dirs[root])) {
        await push(msgid('Abgebrochenen Abgleich zurückgenommen'), true, deps.dirs[root]);
      }
    } catch (err) {
      await push(msgid('Abgebrochenen Abgleich zurücknehmen'), false, `${deps.dirs[root]}: ${message(err)}`);
      return done(false, 'unused', false);
    }
  }

  let adapted: ReturnType<typeof adaptBundle>;
  try {
    adapted = adaptBundle(unpacked, deps.local);
  } catch (err) {
    await push(msgid('Paket lesen'), false, message(err));
    return done(false, 'unused', false);
  }
  const files = adapted.entries.filter((entry) => entry.type === 'file');
  const bytes = files.reduce((sum, entry) => sum + entry.size, 0);
  const count = files.length === 1 ? '1 Datei' : `${files.length} Dateien`;
  await push(msgid('Paket geprüft'), true, `${count}, ${sizeLabel(bytes)}, von ${unpacked.meta.sender.name}`);
  const note = CROWDSEC_NOTES[adapted.crowdsec];
  if (note) await push(msgid('Konfiguration an diesen Knoten angepasst'), true, note);

  if (fingerprintOf(adapted.entries) === readLocal()) {
    await push(msgid('Der Stand liegt schon so vor'), true, msgid('Es wurde nichts getauscht, HAProxy läuft weiter wie bisher.'));
    return done(true, adapted.crowdsec, false);
  }

  try {
    for (const root of roots) stage(root, deps.dirs[root], adapted.entries, adapted.contents);
  } catch (err) {
    for (const root of roots) {
      try {
        recoverInterrupted(root, deps.dirs[root]);
      } catch {
        // Der gültige Stand ist unberührt, liegen bleibt höchstens `.hapm-sync-new`.
      }
    }
    await push(msgid('Dateien bereitlegen'), false, `${message(err)}. Es wurde nichts getauscht.`);
    return done(false, adapted.crowdsec, false);
  }
  await push(msgid('Dateien bereitgelegt'), true);

  const swapped: RootName[] = [];
  const rollback = (): string | null => {
    let problem: string | null = null;
    for (const root of [...swapped].reverse()) {
      try {
        swapBack(root, deps.dirs[root]);
      } catch (err) {
        problem ??= `${deps.dirs[root]}: ${message(err)}`;
      }
    }
    for (const root of roots) {
      if (swapped.includes(root)) continue;
      try {
        recoverInterrupted(root, deps.dirs[root]);
      } catch {
        // Nur `.hapm-sync-new`, der gültige Stand ist unberührt.
      }
    }
    return problem;
  };
  const rolledBack = async (): Promise<void> => {
    const problem = rollback();
    if (problem) {
      await push(msgid('Bisherigen Stand wiederherstellen'), false, `${problem}. Der alte Stand liegt in .hapm-sync-old.`);
    } else {
      await push(msgid('Bisheriger Stand wiederhergestellt'), true);
    }
  };

  try {
    for (const root of roots) {
      swapIn(root, deps.dirs[root]);
      swapped.push(root);
    }
  } catch (err) {
    await push(msgid('Dateien tauschen'), false, message(err));
    await rolledBack();
    return done(false, adapted.crowdsec, false);
  }
  await push(msgid('Dateien getauscht'), true);

  let checked: { ok: boolean; detail: string };
  try {
    checked = await deps.check();
  } catch (err) {
    checked = { ok: false, detail: message(err) };
  }
  if (!checked.ok) {
    await push(msgid('Konfiguration prüfen'), false, checked.detail || msgid('HAProxy nennt keinen Grund.'));
    await rolledBack();
    return done(false, adapted.crowdsec, false);
  }
  await push(msgid('Konfiguration geprüft'), true);

  let reloaded: { ok: boolean; detail: string };
  try {
    reloaded = await deps.reload();
  } catch (err) {
    reloaded = { ok: false, detail: message(err) };
  }
  if (!reloaded.ok) {
    await push(msgid('HAProxy neu laden'), false, reloaded.detail || msgid('HAProxy nennt keinen Grund.'));
    await rolledBack();
    // Der alte Stand liegt wieder da. Ob HAProxy ihn oder noch den Stand davor
    // geladen hat, hängt davon ab, wie weit das Neuladen kam: noch einmal laden.
    const again = await deps.reload().catch((err: unknown) => ({ ok: false, detail: message(err) }));
    await push(
      again.ok ? msgid('HAProxy mit dem bisherigen Stand neu geladen') : msgid('HAProxy mit dem bisherigen Stand neu laden'),
      again.ok,
      again.ok ? undefined : again.detail
    );
    return done(false, adapted.crowdsec, false);
  }
  await push(msgid('HAProxy neu geladen'), true);

  for (const root of roots) {
    try {
      commit(deps.dirs[root]);
    } catch {
      // Liegengebliebenes räumt der nächste Abgleich weg, der Stand gilt.
    }
  }
  return done(true, adapted.crowdsec, true);
}
