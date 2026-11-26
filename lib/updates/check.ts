/**
 * Prüfen, ob es etwas Neues gibt: für das Abbild von HAProxy, für HAPM selbst
 * und für acme.sh.
 *
 * Für die Abbilder wird der Digest des Tags in der Registry mit dem des lokalen
 * Abbilds verglichen. Geholt wird dabei nichts. Das Ergebnis steht je
 * Bestandteil in `update_state`, damit Übersicht und Seitenleiste es zeigen
 * können, ohne bei jedem Aufruf eine Registry zu fragen.
 *
 * `updateAvailable: null` heißt unbekannt (Registry nicht erreichbar, Abbild
 * selbst gebaut) und wird auch so angezeigt. „Aktuell" steht dort nur, wenn es
 * geprüft ist.
 *
 * `error` ist ein deutscher Text. Was keine Werte einsetzt, ist ein Schlüssel
 * (`msgid`) und wird auf der Seite übersetzt. Meldungen von Registry und
 * Docker bleiben, wie sie kamen.
 */

import { createDocument, getDocument, listAll, updateDocument, NotFoundError } from '../db';
import { msgid } from '../i18n';
import { bouncerContainerName, crowdsecContainerName, crowdsecInstalled } from '../crowdsec/paths';
import { COLLECTIONS, type UpdateComponent, type UpdateState } from '../types';
import { containerInfo, haproxyContainerName, ownContainer, registryArchitecture } from '../docker';
import { remoteDetails, remoteDigest } from '../docker/registry';
import { acmeStatus, isNewerVersion, latestAcmeVersion } from '../acme';
import { notify } from '../notifications';
import { needsCheckAfterRun } from './plan';

type StateData = Omit<UpdateState, '$id' | '$createdAt' | '$updatedAt'>;

async function save(data: StateData): Promise<void> {
  try {
    await updateDocument<UpdateState>(COLLECTIONS.UPDATE_STATE, data.component, data);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    await createDocument<UpdateState>(COLLECTIONS.UPDATE_STATE, data, data.component);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function previous(component: UpdateComponent): Promise<UpdateState | null> {
  return getDocument<UpdateState>(COLLECTIONS.UPDATE_STATE, component).catch(() => null);
}

async function checkImage(component: Exclude<UpdateComponent, 'acme'>, container: string | null): Promise<StateData> {
  const now = new Date().toISOString();
  const empty: StateData = {
    component,
    reference: null,
    currentVersion: null,
    currentDigest: null,
    latestVersion: null,
    latestDigest: null,
    updateAvailable: null,
    checkedAt: now,
    error: null,
  };
  if (!container) return { ...empty, error: msgid('HAPM läuft nicht in einem Container.') };

  let info;
  try {
    info = await containerInfo(container);
  } catch (err) {
    return { ...empty, error: message(err) };
  }
  if (!info) return { ...empty, error: `Der Container "${container}" existiert nicht.` };

  const base: StateData = {
    ...empty,
    reference: info.reference,
    currentVersion: info.version,
    currentDigest: info.repoDigests[0] ?? null,
  };

  if (info.reference.includes('@sha256:')) {
    return {
      ...base,
      error: msgid('Das Abbild ist auf einen Digest festgelegt. Ein Update gibt es dann nur von Hand.'),
    };
  }
  if (info.repoDigests.length === 0) {
    return { ...base, error: msgid('Das Abbild ist lokal gebaut und stammt aus keiner Registry.') };
  }

  try {
    const digest = await remoteDigest(info.reference);
    if (info.repoDigests.includes(digest)) {
      return { ...base, latestDigest: digest, latestVersion: info.version, updateAvailable: false };
    }
    // Die Version ist Beiwerk: scheitert ihr Abruf, bleibt die Auskunft „es gibt etwas Neues".
    const details = await remoteDetails(info.reference, registryArchitecture()).catch(() => null);
    return { ...base, latestDigest: digest, latestVersion: details?.version ?? null, updateAvailable: true };
  } catch (err) {
    // Die letzte bekannte Auskunft bleibt stehen, der Fehler steht daneben.
    const before = await previous(component);
    const stillValid = before && before.currentDigest === base.currentDigest;
    return {
      ...base,
      latestDigest: stillValid ? before.latestDigest : null,
      latestVersion: stillValid ? before.latestVersion : null,
      updateAvailable: stillValid ? before.updateAvailable : null,
      error: message(err),
    };
  }
}

async function checkAcme(): Promise<StateData> {
  const now = new Date().toISOString();
  const status = await acmeStatus().catch(() => null);
  const base: StateData = {
    component: 'acme',
    reference: 'acme.sh',
    currentVersion: status?.version ?? null,
    currentDigest: null,
    latestVersion: null,
    latestDigest: null,
    updateAvailable: null,
    checkedAt: now,
    error: null,
  };
  if (!status?.installed || !status.version) return { ...base, error: msgid('acme.sh ist nicht installiert.') };

  try {
    const latest = await latestAcmeVersion();
    if (!latest) return { ...base, error: msgid('GitHub nennt keine Fassung.') };
    return { ...base, latestVersion: latest, updateAvailable: isNewerVersion(latest, status.version) };
  } catch (err) {
    const before = await previous('acme');
    return {
      ...base,
      latestVersion: before?.latestVersion ?? null,
      updateAvailable:
        before?.latestVersion && status.version ? isNewerVersion(before.latestVersion, status.version) : null,
      error: message(err),
    };
  }
}

let running: Promise<UpdateState[]> | null = null;

export function checkUpdates(): Promise<UpdateState[]> {
  running ??= (async () => {
    try {
      const results = await Promise.all([
        checkImage('haproxy', haproxyContainerName()),
        checkImage('hapm', ownContainer()),
        checkAcme(),
        // CrowdSec nur, wenn der Stack es mitbringt: sonst stünde dort ein
        // Fehler über einen Container, den es mit Absicht nicht gibt.
        ...(crowdsecInstalled()
          ? [checkImage('crowdsec', crowdsecContainerName()), checkImage('crowdsec-bouncer', bouncerContainerName())]
          : []),
      ]);
      for (const result of results) await save(result);
      // Einmal je neuer Fassung, das regelt `notify`. Hält die Prüfung nicht auf und wirft nie.
      for (const result of results) {
        if (result.updateAvailable !== true) continue;
        void notify({
          type: 'update_available',
          component: result.component,
          currentVersion: result.currentVersion,
          latestVersion: result.latestVersion,
          latestDigest: result.latestDigest,
        });
      }
      return readUpdateStates();
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Ob gerade eine Prüfung läuft. Die Seite zeigt dann „Wird geprüft" statt „Prüfung steht aus". */
export function isCheckRunning(): boolean {
  return running !== null;
}

/**
 * Eine Prüfung, die sicher NACH diesem Aufruf beginnt.
 *
 * `checkUpdates` gibt eine laufende Prüfung zurück, statt eine zweite zu
 * starten. Nach einem Update ist das zu wenig: eine Prüfung, die vor dem Ende
 * des Laufs begann, kennt das neue Abbild nicht, und ihr `checkedAt` liegt vor
 * dem Ende des Laufs. Die Seite stünde dann bis zur nächsten Prüfung, also
 * Stunden, auf „Prüfung steht aus".
 */
export async function checkUpdatesAfterNow(): Promise<UpdateState[]> {
  if (running) await running.catch(() => undefined);
  return checkUpdates();
}

/** Wie oft `settleAfterRuns` höchstens eine Prüfung anstößt. */
const SETTLE_RETRY_MS = 30_000;
let lastSettle = 0;

/**
 * Prüfen, wenn ein Bestandteil seit seinem letzten Lauf nicht geprüft wurde.
 *
 * Das Netz unter der Prüfung nach jedem Lauf (`apply.ts`) und beim Start
 * (`reconcileUpdateRuns`): ging dort etwas schief, holt der nächste Aufruf der
 * Seite die Prüfung nach, statt den alten Stand stehen zu lassen.
 */
export function settleAfterRuns(
  states: UpdateState[],
  runs: { component: UpdateComponent; status: string; completedAt: string | null }[]
): void {
  if (running || Date.now() - lastSettle < SETTLE_RETRY_MS) return;
  // Ein alter Lauf von CrowdSec, das inzwischen abgeschaltet ist, hat keinen
  // Stand mehr und bekäme nie einen: ohne diese Auswahl gälte er für immer als
  // ungeprüft, und jede halbe Minute liefe eine volle Prüfung.
  const crowdsec = crowdsecInstalled();
  const stale = ORDER.filter(
    (component) => crowdsec || (component !== 'crowdsec' && component !== 'crowdsec-bouncer')
  ).some((component) =>
    needsCheckAfterRun(
      runs.find((run) => run.component === component) ?? null,
      states.find((state) => state.component === component)
    )
  );
  if (!stale) return;
  lastSettle = Date.now();
  void checkUpdates().catch(() => undefined);
}

const ORDER: UpdateComponent[] = ['haproxy', 'hapm', 'acme', 'crowdsec', 'crowdsec-bouncer'];

export async function readUpdateStates(): Promise<UpdateState[]> {
  const rows = await listAll<UpdateState>(COLLECTIONS.UPDATE_STATE);
  // Ein Stand von CrowdSec aus der Zeit, als es noch dazugehörte, zählt nicht mehr.
  const crowdsec = crowdsecInstalled();
  return rows
    .filter((row) => crowdsec || (row.component !== 'crowdsec' && row.component !== 'crowdsec-bouncer'))
    .sort((a, b) => ORDER.indexOf(a.component) - ORDER.indexOf(b.component));
}

export async function pendingUpdateCount(): Promise<number> {
  return (await readUpdateStates()).filter((state) => state.updateAvailable === true).length;
}
