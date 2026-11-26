/**
 * Was HAPM von selbst tut, in diesem Prozess. Es darf deshalb genau eine
 * Instanz laufen.
 *
 *  - jede Minute: die Zähler von HAProxy einsammeln (Statistik)
 *  - jede Minute: prüfen, ob ein selbsttätiges Update fällig ist
 *  - alle zwei Minuten: läuft HAProxy, antworten die Ziele (Benachrichtigungen)
 *  - alle sechs Stunden: nach neuen Abbildern und einem neuen acme.sh sehen
 *  - einmal am Tag: Zertifikate erneuern und Altes aufräumen
 *  - jede Minute: das Protokoll an ein SIEM nachliefern, falls eines eingerichtet ist
 */

import { deleteWhere, getDocument, Query } from './db';
import { COLLECTIONS, type UpdateComponent, type UpdateRun } from './types';
import { systemActor } from './audit';
import { AUTO_UPDATE_ORDER, getSettings } from './settings';
import { renewCertificates } from './acme';
import { pruneExpiredSessions } from './session';
import { checkUpdates } from './updates/check';
import { expireStaleUpdateRuns, reconcileUpdateRuns, startUpdate } from './updates/apply';
import { reconcileOrphanedHaproxyRuns } from './haproxy/reconcile';
import {
  collectHaproxyMetrics,
  HAPROXY_METRICS_INTERVAL_MS,
  HAPROXY_METRICS_RETENTION_DAYS,
} from './haproxy/stats-collect';
import { startLogFollower } from './haproxy-log';
import { HEALTH_CHECK_INTERVAL_MS, runDailyChecks, runHealthChecks } from './notifications/checks';
import { maybeRefreshGeoip } from './geoip/fetch';
import { getBackupSettings } from './backup/settings';
import {
  BACKUP_INTERRUPTED,
  onBackupFailure,
  pruneBackupRuns,
  reconcileBackupRuns,
  startBackup,
  stillInterruptedBackups,
} from './backup/run';
import { reconcileRestore } from './backup/restore';
import { notify } from './notifications';
import { keepCrowdsecStopped, reconcileCrowdsec } from './crowdsec/setup';
import { crowdsecDisabled, crowdsecInStack } from './crowdsec/paths';
import { dropOrphanedCrowdsec, queueAppSync } from './crowdsec/actions';
import { ruleRunActive } from './crowdsec/rule-jobs';
import { timeReached } from './schedule-time';
import { AUDIT_RETENTION_DEFAULT, getAuditSettings } from './audit-log/settings';
import { onForwardingFailing, runAuditForwarding, startAuditForwarding } from './audit-log/forward';

/** CrowdSec startet nach HAPM. Angemeldet wird der Bouncer danach, und
 *  nachgesehen wird regelmäßig, falls jemand den Container neu angelegt hat. */
const CROWDSEC_RECONCILE_MS = 15 * 60_000;

async function tickCrowdsec(): Promise<void> {
  if (process.platform !== 'linux') return;
  // Nicht eingeschaltet, aber `haproxy.cfg` fragt den Bouncer noch: herausnehmen.
  const dropped = await dropOrphanedCrowdsec(systemActor()).catch((err) => `CrowdSec ließ sich nicht aus haproxy.cfg nehmen: ${err instanceof Error ? err.message : String(err)}`);
  if (dropped) log(dropped);
  if (!crowdsecInStack()) return;
  if (crowdsecDisabled()) {
    for (const name of await keepCrowdsecStopped()) log(`CrowdSec ist abgeschaltet, ${name} angehalten`);
    return;
  }
  // Der Abgleich startete CrowdSec nach einem Wechsel der OWASP-Regeln neu,
  // mitten im Lauf: das nächste `cscli` scheiterte. Der Lauf lädt selbst neu.
  if (ruleRunActive()) return;
  const notes = await reconcileCrowdsec();
  for (const note of notes) log(note);
  // Einmal je Start, sobald CrowdSec läuft: holt aus dem Hub, was die
  // Anwendungen der Ziele brauchen (etwa nach einem Update von HAPM oder
  // einer von Hand geänderten haproxy.cfg). Danach erledigt das jeder Vorgang
  // an einem Ziel selbst.
  if (!crowdsecTick.appsChecked) {
    const synced = await queueAppSync(systemActor());
    crowdsecTick.appsChecked = synced.ok;
    if (synced.runId) log(`Ausnahmen für Anwendungen werden abgeglichen (Lauf ${synced.runId}).`);
  }
}

const crowdsecTick = globalThis as unknown as { appsChecked?: boolean };

const UPDATE_CHECK_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Wie lange Historie und Protokoll aufgehoben werden. */
const RUN_RETENTION_DAYS = 180;

interface SchedulerState {
  started: boolean;
  timers: ReturnType<typeof setInterval>[];
  statsRunning: boolean;
  dailyRunning: boolean;
  lastStatsRun: string | null;
  lastStatsError: string | null;
  lastDailyRun: string | null;
  lastRenewal: { at: string; ok: boolean; output: string } | null;
  /** Wann `tickMinute` zuletzt lief. Dazwischen liegt, was seitdem erreicht wurde. */
  lastTick: number | null;
  /** Der Tag, an dem zuletzt selbsttätig aktualisiert wurde, damit es je Tag einmal geschieht. */
  lastAutoUpdateDay: string | null;
  /** Der Tag der letzten selbsttätigen Sicherung, aus demselben Grund. */
  lastBackupDay: string | null;
}

const globalState = globalThis as unknown as { __hapmScheduler?: SchedulerState };

function state(): SchedulerState {
  return (globalState.__hapmScheduler ??= {
    started: false,
    timers: [],
    statsRunning: false,
    dailyRunning: false,
    lastStatsRun: null,
    lastStatsError: null,
    lastDailyRun: null,
    lastRenewal: null,
    lastTick: null,
    lastAutoUpdateDay: null,
    lastBackupDay: null,
  });
}

export function schedulerStatus() {
  const s = state();
  return {
    started: s.started,
    lastStatsRun: s.lastStatsRun,
    lastStatsError: s.lastStatsError,
    lastDailyRun: s.lastDailyRun,
    lastRenewal: s.lastRenewal,
  };
}

function log(text: string): void {
  console.log(`[scheduler] ${text}`);
}

async function tickStats(): Promise<void> {
  const s = state();
  if (s.statsRunning) return;
  s.statsRunning = true;
  try {
    const result = await collectHaproxyMetrics();
    s.lastStatsRun = new Date().toISOString();
    s.lastStatsError = result.errors[0] ?? null;
  } catch (err) {
    s.lastStatsError = err instanceof Error ? err.message : String(err);
  } finally {
    s.statsRunning = false;
  }
}

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

export async function runDaily(): Promise<void> {
  const s = state();
  if (s.dailyRunning) return;
  s.dailyRunning = true;
  try {
    // Die Länder-Tabelle, falls ein neuer Monat begonnen hat. Wirft nie.
    void maybeRefreshGeoip();

    const renewal = await renewCertificates();
    s.lastRenewal = { at: new Date().toISOString(), ok: renewal.ok, output: renewal.output };
    if (!renewal.ok) log(`Erneuerung der Zertifikate meldet einen Fehler:\n${renewal.output}`);
    // Benachrichtigen, ohne den Lauf aufzuhalten. Wirft nie.
    void runDailyChecks(renewal);

    await deleteWhere(COLLECTIONS.HAPROXY_METRICS, [
      Query.lessThan('collectedAt', daysAgo(HAPROXY_METRICS_RETENTION_DAYS)),
    ]);
    await deleteWhere(COLLECTIONS.HAPROXY_RUNS, [Query.lessThan('startedAt', daysAgo(RUN_RETENTION_DAYS))]);
    await deleteWhere(COLLECTIONS.UPDATE_RUNS, [Query.lessThan('startedAt', daysAgo(RUN_RETENTION_DAYS))]);
    // Die Dauer steht unter „Protokoll", Reiter „Aufbewahrung". Ist sie nicht zu lesen, gilt die Vorgabe.
    const auditDays = await getAuditSettings()
      .then((settings) => settings.retentionDays)
      .catch(() => AUDIT_RETENTION_DEFAULT);
    await deleteWhere(COLLECTIONS.AUDIT_LOGS, [Query.lessThan('timestamp', daysAgo(auditDays))]);
    await pruneBackupRuns(daysAgo(RUN_RETENTION_DAYS));
    await pruneExpiredSessions();
    s.lastDailyRun = new Date().toISOString();
  } catch (err) {
    log(`Täglicher Lauf gescheitert: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    s.dailyRunning = false;
  }
}

async function tickMinute(): Promise<void> {
  const s = state();
  const now = new Date();
  const to = now.getTime();
  // Nach einem Neustart zählt erst, was ab jetzt erreicht wird: sonst liefe
  // nach jedem Start am Nachmittag die Sicherung von heute Nacht noch einmal.
  const from = s.lastTick ?? to - 60_000;
  s.lastTick = to;
  const day = now.toDateString();

  // Die Weiterleitung des Protokolls: holt nach, was ein Ziel eben nicht annahm. Wirft nie.
  void runAuditForwarding();

  // Kurz nach drei: dann ist auf einem Proxy am wenigsten los.
  if (timeReached('03:17', from, to)) void runDaily();

  await expireStaleUpdateRuns().catch(() => undefined);

  try {
    const backup = await getBackupSettings();
    if (backup.enabled && backup.hostPath && timeReached(backup.time, from, to) && s.lastBackupDay !== day) {
      s.lastBackupDay = day;
      log('Tägliche Sicherung beginnt');
      await startBackup(systemActor());
    }
  } catch (err) {
    log(`Sicherung nicht gestartet: ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    const settings = await getSettings();
    if (settings.autoUpdate.length === 0 || !timeReached(settings.autoUpdateTime, from, to) || s.lastAutoUpdateDay === day) return;
    s.lastAutoUpdateDay = day;
    await runAutoUpdates(settings.autoUpdate);
  } catch (err) {
    log(`Selbsttätiges Update nicht gestartet: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Die gewählten Bestandteile nacheinander aktualisieren, nur wo es ein neues
 * Abbild gibt. Immer nur ein Update gleichzeitig (`startUpdate` lehnt sonst
 * ab), deshalb wartet jedes auf das Ende des vorigen. HAPM kommt zuletzt
 * (`AUTO_UPDATE_ORDER`): es ersetzt den Prozess, in dem diese Schleife läuft.
 */
async function runAutoUpdates(components: readonly UpdateComponent[]): Promise<void> {
  const states = await checkUpdates();
  for (const component of AUTO_UPDATE_ORDER) {
    if (!components.includes(component)) continue;
    const state = states.find((entry) => entry.component === component);
    if (state?.updateAvailable !== true) continue;
    log(`Selbsttätiges Update von ${component} beginnt`);
    try {
      const run = await startUpdate(component, systemActor());
      await waitForUpdateRun(run.$id);
    } catch (err) {
      log(`Selbsttätiges Update von ${component} nicht gestartet: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Bis ein Update-Lauf endet, höchstens 20 Minuten. */
async function waitForUpdateRun(runId: string): Promise<void> {
  const until = Date.now() + 20 * 60_000;
  while (Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const run = await getDocument<UpdateRun>(COLLECTIONS.UPDATE_RUNS, runId).catch(() => null);
    if (!run || run.status !== 'running') return;
  }
}

export async function initializeScheduler(): Promise<void> {
  const s = state();
  if (s.started) return;
  s.started = true;

  // Was der vorige Prozess offen gelassen hat.
  await reconcileOrphanedHaproxyRuns().catch((err) => log(`Abgleich der Läufe gescheitert: ${err}`));
  await reconcileUpdateRuns().catch((err) => log(`Abgleich der Updates gescheitert: ${err}`));
  const interrupted = await reconcileBackupRuns().catch((err) => {
    log(`Abgleich der Sicherungen gescheitert: ${err}`);
    return [] as string[];
  });
  // Nach dem Zurückspielen: der Helfer hat sein Ergebnis in eine Datei geschrieben.
  await reconcileRestore().catch((err) => log(`Abgleich des Zurückspielens gescheitert: ${err}`));
  // Die Sicherung kennt den Mailversand nicht, sie meldet nur, dass sie gescheitert ist.
  onBackupFailure((detail) => void notify({ type: 'backup_failed', detail }));
  // Eine Sicherung, die der vorige Prozess nicht zu Ende gebracht hat, fehlt:
  // das soll jemand erfahren. Erst nach dem Abgleich des Zurückspielens, der
  // seine eigene Sicherung noch richtigstellt.
  void stillInterruptedBackups(interrupted)
    .then((count) => {
      if (count > 0) void notify({ type: 'backup_failed', detail: BACKUP_INTERRUPTED });
    })
    .catch(() => undefined);

  // Ab jetzt geht jeder neue Eintrag des Protokolls an ein eingerichtetes SIEM.
  onForwardingFailing((destination, since, error) => {
    void getAuditSettings()
      .then((settings) =>
        notify({
          type: 'audit_forward_failed',
          destination,
          target:
            destination === 'syslog'
              ? `${settings.syslog.protocol}://${settings.syslog.host ?? ''}:${settings.syslog.port}`
              : (settings.http.url ?? ''),
          since,
          error,
        })
      )
      .catch(() => undefined);
  });
  startAuditForwarding();

  startLogFollower();

  s.timers.push(setInterval(() => void tickStats(), HAPROXY_METRICS_INTERVAL_MS));
  s.timers.push(setInterval(() => void tickMinute(), 60_000));
  s.timers.push(setInterval(() => void checkUpdates().catch(() => undefined), UPDATE_CHECK_MS));
  s.timers.push(setInterval(() => void runHealthChecks(), HEALTH_CHECK_INTERVAL_MS));
  s.timers.push(setInterval(() => void tickCrowdsec(), CROWDSEC_RECONCILE_MS));

  // Die erste Prüfung kurz nach dem Start, damit die Übersicht nicht sechs Stunden leer ist.
  setTimeout(() => void checkUpdates().catch(() => undefined), 20_000);
  // Eine frische Installation bringt den Stand des Abbilds mit: gleich nachsehen.
  setTimeout(() => void maybeRefreshGeoip(), 30_000);
  // Compose startet CrowdSec, sobald HAPM gesund ist; eine Minute reicht dafür.
  setTimeout(() => void tickCrowdsec(), 60_000);
  log('gestartet');
}
