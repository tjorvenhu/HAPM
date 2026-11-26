/**
 * Die Weiterleitung des Protokolls an ein SIEM: Syslog und HTTP-Endpunkt.
 *
 * ── In Reihenfolge und ohne Lücke ──
 *
 * Je Ziel steht in der Datenbank eine Marke: die Kennung des letzten Eintrags,
 * den das Ziel angenommen hat. Ein Durchgang liest, was danach kommt, schickt
 * es in der Reihenfolge des Protokolls und setzt die Marke erst nach der
 * Abgabe weiter. Scheitert die Abgabe, bleibt die Marke stehen und der nächste
 * Durchgang beginnt an derselben Stelle. Was im Protokoll steht, geht also
 * hinaus, sobald das Ziel wieder antwortet, auch nach einem Neustart von HAPM.
 *
 * Das heißt mindestens einmal, nicht genau einmal: stürzt HAPM zwischen Abgabe
 * und Marke ab, kommt ein Eintrag doppelt. Jeder trägt deshalb seine Kennung
 * (`id`), an der ein SIEM Doppelte erkennt.
 *
 * Verloren geht nur, was die Aufbewahrung löscht, bevor das Ziel es annimmt:
 * ein Ziel, das länger ausfällt, als das Protokoll aufgehoben wird.
 *
 * ── Sofort, aber nicht im Weg ──
 *
 * `logAudit` stößt nach dem Schreiben einen Durchgang an (`kick.ts`, eingetragen
 * von `startAuditForwarding`) und wartet nicht darauf. Der Durchgang beginnt `SETTLE_MS` später: so lange
 * gilt der Rand des Protokolls als noch nicht fest (`lib/db/audit-query.ts`).
 * Der Scheduler ruft jede Minute nach, das ist zugleich der Takt der
 * Wiederholung nach einem Fehler.
 *
 * ── Eine Instanz ──
 *
 * Der Zustand eines laufenden Durchgangs steht im Prozess. HAPM läuft als
 * genau ein Prozess (`lib/scheduler.ts`), zwei würden doppelt schicken.
 */

import pkg from '../../package.json';
import { createDocument, getDocument, updateDocument, NotFoundError } from '../db';
import { countAudit, idAtTime, queryAudit } from '../db/audit-query';
import { decrypt } from '../crypto';
import { localServer } from '../helpers';
import { germanText } from '../i18n/translate';
import { COLLECTIONS, type DbDoc } from '../types';
import { auditPayload, formatCef, formatRfc5424, hecEvent, SEVERITY } from './format';
import { setAuditKick } from './kick';
import { labelOf } from './labels';
import { SETTLE_MS, settledId, toEntry, type AuditEntry } from './read';
import { getAuditSettings, type AuditSettings, type HttpSettings, type SyslogSettings } from './settings';
import { postJson, sameTarget, SyslogConnection, type HttpTarget, type SyslogTarget } from './transport';

export const FORWARD_DESTINATIONS = ['syslog', 'http'] as const;
export type ForwardDestination = (typeof FORWARD_DESTINATIONS)[number];

/** So viele Einträge je Abgabe. */
const BATCH = 100;
/** Ein Durchgang gibt höchstens so viele Stapel ab, dann ist der nächste dran. */
const MAX_BATCHES = 50;
/** Der Rückstand wird höchstens bis hierhin gezählt. */
export const BACKLOG_CAP = 5000;
/** Nach einem Fehler: frühestens so viel später der nächste Versuch. */
const RETRY_MS = [5000, 15_000, 60_000];
/** Ab dieser Dauer ohne Erfolg geht eine Benachrichtigung hinaus. */
export const FAILING_NOTIFY_MS = 15 * 60_000;
/** Zeilen von HAProxy, die auf ein Ziel warten, das gerade nicht annimmt. Darüber fällt die älteste weg. */
const HAPROXY_QUEUE_MAX = 5000;

export interface ForwardState extends DbDoc {
  /** Die Kennung des letzten abgegebenen Eintrags. `null`: noch nie eingeschaltet. */
  cursor: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  /** Seit wann jede Abgabe scheitert. `null`: die letzte gelang. */
  failingSince: string | null;
}

const EMPTY_STATE: Omit<ForwardState, keyof DbDoc> = {
  cursor: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  failingSince: null,
};

export interface ForwardStatus {
  destination: ForwardDestination;
  enabled: boolean;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  failingSince: string | null;
  /** Einträge, die abgegeben sein könnten und es nicht sind, gezählt bis `BACKLOG_CAP`. `null`: nicht eingeschaltet. */
  backlog: number | null;
}

interface Memory {
  running: boolean;
  /** Der späteste Zeitpunkt, zu dem jemand einen Durchgang verlangt hat. */
  runAfter: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** Je Ziel: Fehlversuche in Folge und frühester nächster Versuch. */
  retry: Record<ForwardDestination, { attempts: number; notBefore: number }>;
  syslog: SyslogConnection | null;
  /** Die Einstellungen von eben, für den Mitschnitt von HAProxy: der fragt je Zeile, nicht je Minute. */
  settings: AuditSettings | null;
  haproxy: { connection: SyslogConnection | null; queue: string[]; sending: boolean; dropped: number };
  onFailing: ((destination: ForwardDestination, since: string, error: string) => void) | null;
}

const globalMemory = globalThis as unknown as { __hapmAuditForward?: Memory };

function memory(): Memory {
  return (globalMemory.__hapmAuditForward ??= {
    running: false,
    runAfter: 0,
    timer: null,
    retry: { syslog: { attempts: 0, notBefore: 0 }, http: { attempts: 0, notBefore: 0 } },
    syslog: null,
    settings: null,
    haproxy: { connection: null, queue: [], sending: false, dropped: 0 },
    onFailing: null,
  });
}

function text(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function host(): string {
  return localServer().name;
}

/* ── Stand je Ziel ── */

export async function readForwardState(destination: ForwardDestination): Promise<ForwardState> {
  try {
    const row = await getDocument<ForwardState>(COLLECTIONS.AUDIT_FORWARD_STATE, destination);
    return { ...EMPTY_STATE, ...row };
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    return { ...EMPTY_STATE, $id: destination, $createdAt: '', $updatedAt: '' };
  }
}

async function writeForwardState(destination: ForwardDestination, patch: Partial<ForwardState>): Promise<void> {
  try {
    await updateDocument<ForwardState>(COLLECTIONS.AUDIT_FORWARD_STATE, destination, patch);
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;
    await createDocument<ForwardState>(COLLECTIONS.AUDIT_FORWARD_STATE, { ...EMPTY_STATE, ...patch }, destination);
  }
}

/**
 * Ein Ziel wird eingeschaltet: die Marke steht ab jetzt. Weitergeleitet wird,
 * was von nun an geschieht, nicht das Protokoll des letzten Jahres. Wer das
 * Bisherige im SIEM haben will, exportiert es.
 */
export async function startForwardingFrom(destination: ForwardDestination, now: number = Date.now()): Promise<void> {
  await writeForwardState(destination, { ...EMPTY_STATE, cursor: idAtTime(now) });
  memory().retry[destination] = { attempts: 0, notBefore: 0 };
}

/* ── Nachrichten ── */

export function syslogTargetOf(settings: SyslogSettings): SyslogTarget | null {
  if (!settings.host) return null;
  return {
    host: settings.host,
    port: settings.port,
    protocol: settings.protocol,
    framing: settings.framing,
    caPem: settings.protocol === 'tls' ? settings.caPem : null,
  };
}

export function httpTargetOf(settings: HttpSettings): HttpTarget | null {
  if (!settings.url) return null;
  return {
    url: settings.url,
    headerName: settings.headerName,
    headerValue: settings.headerValue ? decrypt(settings.headerValue) : null,
    caPem: settings.caPem,
  };
}

/** Ein Eintrag als Syslog-Nachricht in der eingestellten Form. */
export function syslogLine(entry: AuditEntry, settings: SyslogSettings, node: string = host()): string {
  const label = labelOf(entry.action);
  const body =
    settings.format === 'cef'
      ? formatCef(entry, { host: node, version: pkg.version, name: label ? germanText(label) : entry.action })
      : JSON.stringify(auditPayload(entry, node));
  return formatRfc5424({
    facility: settings.facility,
    severity: entry.outcome === 'failure' ? SEVERITY.warning : SEVERITY.info,
    timestamp: entry.timestamp,
    hostname: node,
    appName: settings.appName,
    msgId: entry.action,
    text: body,
  });
}

function syslogConnection(target: SyslogTarget): SyslogConnection {
  const m = memory();
  if (m.syslog && !sameTarget(m.syslog.target, target)) {
    m.syslog.close();
    m.syslog = null;
  }
  return (m.syslog ??= new SyslogConnection(target));
}

/**
 * Einen Stapel abgeben. Antwort: wie viele Einträge vom Anfang des Stapels
 * angenommen sind, und der Fehler, an dem es danach scheiterte.
 */
async function deliver(
  destination: ForwardDestination,
  settings: AuditSettings,
  entries: AuditEntry[]
): Promise<{ delivered: number; error: string | null }> {
  try {
    if (destination === 'syslog') {
      const target = syslogTargetOf(settings.syslog);
      if (!target) return { delivered: 0, error: 'Kein Syslog-Server eingetragen.' };
      await syslogConnection(target).send(entries.map((entry) => syslogLine(entry, settings.syslog)));
      return { delivered: entries.length, error: null };
    }

    const target = httpTargetOf(settings.http);
    if (!target) return { delivered: 0, error: 'Kein Endpunkt eingetragen.' };
    if (settings.http.body === 'hec') {
      // Splunk nimmt mehrere Ereignisse in einem Rumpf, eins nach dem anderen.
      await postJson(target, entries.map((entry) => JSON.stringify(hecEvent(entry, host()))).join('\n'));
      return { delivered: entries.length, error: null };
    }
    let delivered = 0;
    for (const entry of entries) {
      try {
        await postJson(target, JSON.stringify(auditPayload(entry, host())));
        delivered += 1;
      } catch (err) {
        return { delivered, error: text(err) };
      }
    }
    return { delivered, error: null };
  } catch (err) {
    return { delivered: 0, error: text(err) };
  }
}

async function forwardTo(destination: ForwardDestination, settings: AuditSettings): Promise<void> {
  const m = memory();
  const enabled = destination === 'syslog' ? settings.syslog.enabled : settings.http.enabled;
  if (!enabled) return;
  if (Date.now() < m.retry[destination].notBefore) return;

  let state = await readForwardState(destination);
  if (!state.cursor) {
    await startForwardingFrom(destination);
    state = await readForwardState(destination);
  }
  let cursor = state.cursor as string;

  for (let round = 0; round < MAX_BATCHES; round += 1) {
    const rows = await queryAudit({ after: cursor, upTo: settledId() }, 'asc', BATCH);
    if (rows.length === 0) return;
    const entries = rows.map(toEntry);
    const result = await deliver(destination, settings, entries);
    const now = new Date().toISOString();

    if (result.delivered > 0) cursor = entries[result.delivered - 1].id;

    if (result.error) {
      const failingSince = state.failingSince ?? now;
      await writeForwardState(destination, { cursor, lastErrorAt: now, lastError: result.error.slice(0, 500), failingSince });
      const retry = m.retry[destination];
      retry.notBefore = Date.now() + RETRY_MS[Math.min(retry.attempts, RETRY_MS.length - 1)];
      retry.attempts += 1;
      scheduleRun(retry.notBefore - Date.now() + 50);
      if (Date.now() - Date.parse(failingSince) >= FAILING_NOTIFY_MS) {
        m.onFailing?.(destination, failingSince, result.error);
      }
      return;
    }

    m.retry[destination] = { attempts: 0, notBefore: 0 };
    await writeForwardState(destination, { cursor, lastSuccessAt: now, lastError: null, lastErrorAt: null, failingSince: null });
    state = { ...state, failingSince: null };
    if (rows.length < BATCH) return;
  }
  // Noch nicht am Ende: gleich weiter, ohne andere Arbeit des Prozesses zu verdrängen.
  scheduleRun(10);
}

/**
 * Einen Durchgang für später anmelden.
 *
 * Es gibt höchstens einen Zeitgeber. Wer einen Durchgang zu einem späteren
 * Zeitpunkt braucht, als der wartende Zeitgeber feuert, steht in `runAfter`:
 * der Durchgang dazwischen käme für ihn zu früh (der Eintrag, der ihn anstieß,
 * gilt dann noch nicht als fest), und danach wird noch einmal angesetzt.
 */
function scheduleRun(delayMs: number): void {
  const m = memory();
  const due = Date.now() + Math.max(0, delayMs);
  if (due > m.runAfter) m.runAfter = due;
  if (m.timer) return;
  m.timer = setTimeout(() => {
    m.timer = null;
    void runAuditForwarding();
  }, Math.max(0, delayMs));
  m.timer.unref?.();
}

/**
 * Ein Durchgang über beide Ziele. Wirft nie: die Weiterleitung darf weder
 * `logAudit` noch den Scheduler aufhalten. Läuft schon einer, hängt sich
 * dieser Aufruf hinten an.
 */
export async function runAuditForwarding(): Promise<void> {
  const m = memory();
  if (m.running) {
    m.runAfter = Math.max(m.runAfter, Date.now() + 1);
    return;
  }
  m.running = true;
  const startedAt = Date.now();
  try {
    const settings = await getAuditSettings();
    m.settings = settings;
    if (!settings.syslog.enabled) {
      m.syslog?.close();
      m.syslog = null;
    }
    for (const destination of FORWARD_DESTINATIONS) {
      await forwardTo(destination, settings).catch((err) =>
        console.error(`[audit] Weiterleitung an ${destination} abgebrochen: ${text(err)}`)
      );
    }
  } catch (err) {
    console.error(`[audit] Weiterleitung nicht gestartet: ${text(err)}`);
  } finally {
    m.running = false;
    // Jemand wollte einen Durchgang nach dem Beginn von diesem: noch einmal, zu seiner Zeit.
    if (m.runAfter > startedAt && !m.timer) scheduleRun(m.runAfter - Date.now());
  }
}

/** Nach einem neuen Eintrag: gleich weiterleiten, sobald der Rand des Protokolls fest ist. */
export function kickAuditForwarding(): void {
  const settings = memory().settings;
  // Vor dem ersten Durchgang ist unbekannt, ob etwas eingeschaltet ist: dann nachsehen.
  if (settings && !settings.syslog.enabled && !settings.http.enabled) return;
  scheduleRun(SETTLE_MS + 100);
}

/**
 * Beim Start des Schedulers: ab jetzt stößt jeder neue Eintrag einen Durchgang
 * an, und der erste holt nach, was während des Stillstands liegen blieb.
 */
export function startAuditForwarding(): void {
  setAuditKick(kickAuditForwarding);
  scheduleRun(SETTLE_MS + 100);
}

/** Wer erfahren will, dass ein Ziel seit einer Weile nichts annimmt (`lib/scheduler.ts` hängt die Mail an). */
export function onForwardingFailing(listener: (destination: ForwardDestination, since: string, error: string) => void): void {
  memory().onFailing = listener;
}

/** Nach dem Speichern der Einstellungen: der Mitschnitt und der nächste Anstoß sehen den neuen Stand. */
export function forwardingSettingsChanged(settings: AuditSettings): void {
  const m = memory();
  m.settings = settings;
  m.retry = { syslog: { attempts: 0, notBefore: 0 }, http: { attempts: 0, notBefore: 0 } };
  if (!settings.syslog.enabled || !settings.syslog.haproxyLog) {
    m.haproxy.connection?.close();
    m.haproxy.connection = null;
    m.haproxy.queue = [];
  }
  scheduleRun(SETTLE_MS + 100);
}

export async function forwardingStatus(settings?: AuditSettings): Promise<ForwardStatus[]> {
  const current = settings ?? (await getAuditSettings());
  return Promise.all(
    FORWARD_DESTINATIONS.map(async (destination) => {
      const enabled = destination === 'syslog' ? current.syslog.enabled : current.http.enabled;
      const state = await readForwardState(destination);
      return {
        destination,
        enabled,
        lastSuccessAt: state.lastSuccessAt,
        lastErrorAt: state.lastErrorAt,
        lastError: state.lastError,
        failingSince: state.failingSince,
        // Nur was schon fest ist: ein Eintrag der letzten Sekunde ist unterwegs, kein Rückstand.
        backlog: enabled && state.cursor ? await countAudit({ after: state.cursor, upTo: settledId() }, BACKLOG_CAP) : null,
      };
    })
  );
}

/* ── Testnachricht ── */

/** Ein Eintrag, den es im Protokoll nicht gibt: nur zum Prüfen des Wegs. */
export function testEntry(actor: { userId: string; userEmail: string; ip?: string }, now: Date = new Date()): AuditEntry {
  return {
    id: idAtTime(now.getTime()),
    timestamp: now.toISOString(),
    action: 'audit_forward_test',
    area: 'audit',
    actorType: 'user',
    actor: actor.userEmail,
    actorId: actor.userId,
    resource: 'audit_forwarding',
    resourceId: null,
    details: 'Testnachricht von HAPM. Kein Eintrag des Protokolls.',
    ip: actor.ip ?? null,
    outcome: 'success',
  };
}

/**
 * Eine Testnachricht über das gespeicherte Ziel, auch wenn es nicht
 * eingeschaltet ist. Über eine eigene Verbindung: ein Fehler hier soll die
 * laufende Weiterleitung nicht abreißen.
 */
export async function deliverTest(
  destination: ForwardDestination,
  settings: AuditSettings,
  entry: AuditEntry
): Promise<{ ok: boolean; error: string | null }> {
  try {
    if (destination === 'syslog') {
      const target = syslogTargetOf(settings.syslog);
      if (!target) return { ok: false, error: 'Kein Syslog-Server eingetragen.' };
      const connection = new SyslogConnection(target);
      try {
        await connection.send([syslogLine(entry, settings.syslog)]);
      } finally {
        connection.close();
      }
      return { ok: true, error: null };
    }
    const target = httpTargetOf(settings.http);
    if (!target) return { ok: false, error: 'Kein Endpunkt eingetragen.' };
    const body = settings.http.body === 'hec' ? hecEvent(entry, host()) : auditPayload(entry, host());
    await postJson(target, JSON.stringify(body));
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: text(err) };
  }
}

/* ── Das Zugriffslog von HAProxy ── */

/**
 * Zeilen aus dem Mitschnitt (`lib/haproxy-log.ts`) an das Syslog-Ziel, wenn
 * der Schalter an ist. Bestmöglich: es gibt keine Marke und keine
 * Wiederholung über einen Neustart hinweg. Nimmt das Ziel gerade nichts an,
 * warten bis zu `HAPROXY_QUEUE_MAX` Zeilen im Speicher, die ältesten fallen
 * weg. Ein Proxy schreibt tausende Zeilen in der Minute, und ein Rückstand
 * davon in der Datenbank wäre die Platte, die vollläuft.
 */
export function forwardHaproxyLines(lines: { stamp: string; text: string }[]): void {
  const m = memory();
  const settings = m.settings;
  if (!settings || !settings.syslog.enabled || !settings.syslog.haproxyLog || lines.length === 0) return;

  const node = host();
  for (const line of lines) {
    m.haproxy.queue.push(
      formatRfc5424({
        facility: settings.syslog.facility,
        severity: SEVERITY.info,
        timestamp: line.stamp,
        hostname: node,
        appName: 'haproxy',
        text: line.text,
      })
    );
  }
  trimHaproxyQueue();
  void drainHaproxy();
}

function trimHaproxyQueue(): void {
  const m = memory();
  const over = m.haproxy.queue.length - HAPROXY_QUEUE_MAX;
  if (over > 0) {
    m.haproxy.queue.splice(0, over);
    m.haproxy.dropped += over;
  }
}

async function drainHaproxy(): Promise<void> {
  const m = memory();
  if (m.haproxy.sending) return;
  m.haproxy.sending = true;
  try {
    while (m.haproxy.queue.length > 0) {
      const settings = m.settings;
      const target = settings?.syslog.enabled && settings.syslog.haproxyLog ? syslogTargetOf(settings.syslog) : null;
      if (!target) {
        m.haproxy.queue = [];
        return;
      }
      if (m.haproxy.connection && !sameTarget(m.haproxy.connection.target, target)) {
        m.haproxy.connection.close();
        m.haproxy.connection = null;
      }
      const connection = (m.haproxy.connection ??= new SyslogConnection(target));
      // Herausnehmen und bei einem Fehler zurücklegen: währenddessen kann der
      // Mitschnitt hinten anfügen und vorn kürzen.
      const batch = m.haproxy.queue.splice(0, 200);
      try {
        await connection.send(batch);
      } catch {
        // Der nächste Schub des Mitschnitts versucht es wieder.
        m.haproxy.queue.unshift(...batch);
        trimHaproxyQueue();
        return;
      }
    }
  } finally {
    m.haproxy.sending = false;
  }
}

/** Für die Seite: wie viele Zeilen von HAProxy weggefallen sind, seit HAPM läuft. */
export function haproxyForwardStatus(): { queued: number; dropped: number } {
  const m = memory();
  return { queued: m.haproxy.queue.length, dropped: m.haproxy.dropped };
}

/** Nur für Tests: der Zustand lebt im Prozess. */
export function resetForwardingMemory(): void {
  const m = memory();
  if (m.timer) clearTimeout(m.timer);
  m.syslog?.close();
  m.haproxy.connection?.close();
  setAuditKick(null);
  globalMemory.__hapmAuditForward = undefined;
}
