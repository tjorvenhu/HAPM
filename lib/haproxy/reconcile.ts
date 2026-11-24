/**
 * Reverse-Proxy-Läufe, die ein Neustart von HAPM zerrissen hat.
 *
 * Der ganze Vorgang läuft IM Prozess von HAPM, Kommando für Kommando. Stirbt
 * der Prozess, stirbt der Vorgang mit ihm: eine `running`-Zeile beim Start ist
 * ohne jede Rückfrage tot.
 *
 * Was auf der Maschine angekommen ist, sagt der letzte erfolgreiche Schritt.
 * Die Schrittliste wird deshalb nach jedem Schritt geschrieben und nicht erst
 * am Ende (siehe `ProvisionReporter`) — genau für diesen Fall. Zurückgerollt
 * wird nichts: HAPM weiß nach dem Neustart nicht mehr, ob das
 * abgebrochene `cp` durchkam, und ein Rollback auf Verdacht wäre auf einem
 * Reverse-Proxy die Sorte Handlung, die fremde Domains offline nimmt. Die
 * Seite liest die Konfiguration ohnehin bei jedem Aufruf direkt von der
 * Maschine, der tatsächliche Stand steht dort also eine Sekunde später.
 */

import { listDocuments, updateDocument, Query } from '../db';
import { COLLECTIONS } from '../types';
import type { HaproxyRun } from '../types';
import { msgid } from '../i18n/translate';

/** Gespeichert als deutscher Schlüssel, die Seite übersetzt ihn beim Zeigen. */
const INTERRUPTED = msgid(
  'HAPM wurde neu gestartet, während der Vorgang lief. Die Schritte unten sind die, die noch abgeschlossen wurden; ob der letzte begonnene durchkam, sagt die Konfiguration von HAProxy.'
);

export async function reconcileOrphanedHaproxyRuns(): Promise<void> {
  let running: HaproxyRun[];
  try {
    running = await listDocuments<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, [
      Query.equal('status', 'running'),
      Query.limit(100),
    ]);
  } catch (err) {
    log(`Laufende Vorgänge konnten nicht geladen werden: ${err instanceof Error ? err.message : err}`);
    return;
  }

  if (running.length === 0) return;

  const now = new Date().toISOString();
  for (const run of running) {
    await updateDocument<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, run.$id, {
      status: 'error',
      phase: 'done',
      completedAt: now,
      duration: Math.max(0, Math.round((Date.now() - new Date(run.startedAt).getTime()) / 1000)),
      error: INTERRUPTED,
    }).catch((err) => log(`${run.$id}: ${err instanceof Error ? err.message : err}`));
  }

  log(`${running.length} unterbrochene(r) Reverse-Proxy-Vorgang/-Vorgänge abgeschlossen`);
}

function log(msg: string): void {
  console.log(`[haproxy-reconcile] ${new Date().toISOString()} ${msg}`);
}
