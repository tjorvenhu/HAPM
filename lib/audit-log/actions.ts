/**
 * Was die Seite „Protokoll" über das Lesen hinaus kann: die Einstellungen
 * (Aufbewahrung, Weiterleitung) ändern, eine Testnachricht schicken, einen
 * Export beginnen. Jede dieser Funktionen schreibt ihre Zeile im Protokoll
 * selbst.
 *
 * Gelesen wird über `readAuditLog` (`read.ts`), das auch die interne API und
 * das MCP-Werkzeug rufen. Was hier steht, gibt es nur mit Sitzung: siehe den
 * Kopf von `settings.ts`.
 */

import { ApiError } from '../api';
import { logAudit } from '../audit';
import { auditTotals } from '../db/audit-query';
import { msg, type Translator } from '../i18n/translate';
import type { Locale } from '../i18n/locale';
import { rateLimit } from '../rate-limit';
import { AUDIT_AREA_LABELS } from './labels';
import { auditExportStream, EXPORT_CONTENT_TYPES, EXPORT_FORMATS, exportFileName, type ExportFormat } from './export';
import {
  deliverTest,
  FORWARD_DESTINATIONS,
  forwardingSettingsChanged,
  forwardingStatus,
  haproxyForwardStatus,
  startForwardingFrom,
  testEntry,
  type ForwardDestination,
  type ForwardStatus,
} from './forward';
import { readAuditQuery } from './read';
import {
  AUDIT_RETENTION_MAX,
  AUDIT_RETENTION_MIN,
  auditSettingsView,
  getAuditSettings,
  mergeHttp,
  mergeSyslog,
  readRetention,
  saveAuditSettings,
  type AuditSettings,
  type AuditSettingsInput,
  type AuditSettingsView,
} from './settings';

export interface AuditActor {
  userId: string;
  userEmail: string;
  ip?: string;
}

export interface AuditOverview {
  settings: AuditSettingsView;
  forwarding: ForwardStatus[];
  /** Zeilen von HAProxy, die gerade warten oder seit dem Start weggefallen sind. */
  haproxyLog: { queued: number; dropped: number };
  /** Wie viele Einträge es gibt und von wann der älteste ist. */
  totals: { count: number; oldest: string | null };
  limits: { retentionMin: number; retentionMax: number };
}

export async function auditOverview(settings?: AuditSettings): Promise<AuditOverview> {
  const current = settings ?? (await getAuditSettings());
  const [forwarding, totals] = await Promise.all([forwardingStatus(current), auditTotals()]);
  return {
    settings: auditSettingsView(current),
    forwarding,
    haproxyLog: haproxyForwardStatus(),
    totals,
    limits: { retentionMin: AUDIT_RETENTION_MIN, retentionMax: AUDIT_RETENTION_MAX },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function readAuditSettingsInput(body: unknown): AuditSettingsInput {
  if (!isRecord(body)) throw new ApiError(msg('Ungültiger Request-Body'));
  const input: AuditSettingsInput = {};
  if (body.retentionDays !== undefined) input.retentionDays = body.retentionDays;
  if (body.syslog !== undefined) {
    if (!isRecord(body.syslog)) throw new ApiError(msg('{field} ist ein Objekt.', { field: 'syslog' }));
    input.syslog = body.syslog;
  }
  if (body.http !== undefined) {
    if (!isRecord(body.http)) throw new ApiError(msg('{field} ist ein Objekt.', { field: 'http' }));
    input.http = body.http;
  }
  return input;
}

/** Was sich geändert hat, für die Zeile im Protokoll. Ohne den Wert der Kopfzeile. */
function describeChange(before: AuditSettings, after: AuditSettings): string {
  const notes: string[] = [];
  if (before.retentionDays !== after.retentionDays) {
    notes.push(`Aufbewahrung: ${before.retentionDays} → ${after.retentionDays} Tage`);
  }
  if (JSON.stringify(before.syslog) !== JSON.stringify(after.syslog)) {
    const s = after.syslog;
    notes.push(
      `Syslog: ${s.enabled ? 'an' : 'aus'}` +
        (s.host ? `, ${s.protocol}://${s.host}:${s.port}, ${s.format.toUpperCase()}, ${s.facility}` : '') +
        (s.protocol === 'tls' ? `, eigene CA: ${s.caPem ? 'ja' : 'nein'}` : '') +
        `, Zugriffslog von HAProxy: ${s.haproxyLog ? 'an' : 'aus'}`
    );
  }
  if (JSON.stringify(before.http) !== JSON.stringify(after.http)) {
    const h = after.http;
    const header =
      before.http.headerValue === h.headerValue
        ? ''
        : h.headerValue
          ? ', Wert der Kopfzeile neu gesetzt'
          : ', Wert der Kopfzeile entfernt';
    notes.push(
      `HTTP-Endpunkt: ${h.enabled ? 'an' : 'aus'}` +
        (h.url ? `, ${h.url}, ${h.body === 'hec' ? 'Splunk HEC' : 'JSON'}` : '') +
        (h.headerName ? `, Kopfzeile ${h.headerName}` : '') +
        header
    );
  }
  return notes.join('; ');
}

export async function changeAuditSettings(input: AuditSettingsInput, actor: AuditActor): Promise<AuditOverview> {
  const before = await getAuditSettings();
  const next = {
    retentionDays: input.retentionDays === undefined ? before.retentionDays : readRetention(input.retentionDays),
    syslog: input.syslog ? mergeSyslog(before.syslog, input.syslog) : before.syslog,
    http: input.http ? mergeHttp(before.http, input.http) : before.http,
  };

  // Vor dem Speichern: der erste Durchgang nach dem Einschalten soll die Marke schon vorfinden.
  if (next.syslog.enabled && !before.syslog.enabled) await startForwardingFrom('syslog');
  if (next.http.enabled && !before.http.enabled) await startForwardingFrom('http');

  const after = await saveAuditSettings(next);
  const details = describeChange(before, after);
  if (details) {
    await logAudit({ ...actor, action: 'audit_settings_updated', resource: 'audit_settings', details });
  }
  forwardingSettingsChanged(after);
  return auditOverview(after);
}

const TEST_LIMIT = 10;
const TEST_WINDOW_MS = 10 * 60 * 1000;

export interface ForwardTestResult {
  destination: ForwardDestination;
  sent: boolean;
  error: string | null;
}

/** Eine Testnachricht über das gespeicherte Ziel, eingeschaltet oder nicht. */
export async function sendForwardTest(rawDestination: unknown, actor: AuditActor): Promise<ForwardTestResult> {
  if (typeof rawDestination !== 'string' || !(FORWARD_DESTINATIONS as readonly string[]).includes(rawDestination)) {
    throw new ApiError(msg('Diesen Empfänger der Weiterleitung gibt es nicht.'));
  }
  const destination = rawDestination as ForwardDestination;
  const settings = await getAuditSettings();
  if (destination === 'syslog' ? !settings.syslog.host : !settings.http.url) {
    throw new ApiError(msg('Der Empfänger ist noch nicht gespeichert. Erst speichern, dann testen.'));
  }

  // Jede Testnachricht ist eine echte Verbindung zu einem frei gewählten Server.
  const limit = rateLimit(`audit-forward-test:${actor.userId}`, TEST_LIMIT, TEST_WINDOW_MS);
  if (!limit.success) {
    throw new ApiError(
      msg('Zu viele Testnachrichten. Der nächste Versuch geht in {minutes} Minuten.', {
        minutes: Math.ceil((limit.retryAfter ?? 60) / 60),
      }),
      429
    );
  }

  const result = await deliverTest(destination, settings, testEntry(actor));
  const where = destination === 'syslog' ? `${settings.syslog.protocol}://${settings.syslog.host}:${settings.syslog.port}` : settings.http.url;
  await logAudit({
    ...actor,
    action: result.ok ? 'audit_forward_test_sent' : 'audit_forward_test_failed',
    resource: 'audit_settings',
    resourceId: destination,
    details: result.ok ? `Testnachricht an ${where}` : `Testnachricht an ${where}: ${result.error ?? ''}`,
  });
  return { destination, sent: result.ok, error: result.error };
}

export interface AuditExport {
  stream: ReadableStream<Uint8Array>;
  fileName: string;
  contentType: string;
}

/** Den Export beginnen. Der Eintrag im Protokoll nennt Format und Filter, nicht die Zahl: die steht erst am Ende fest. */
export async function startAuditExport(
  body: unknown,
  actor: AuditActor,
  language: { t: Translator['t']; locale: Locale }
): Promise<AuditExport> {
  if (!isRecord(body)) throw new ApiError(msg('Ungültiger Request-Body'));
  if (typeof body.format !== 'string' || !(EXPORT_FORMATS as readonly string[]).includes(body.format)) {
    throw new ApiError(msg('Das Format des Exports ist csv oder jsonl.'));
  }
  const format = body.format as ExportFormat;
  const query = readAuditQuery({ from: body.from, to: body.to, actor: body.actor, area: body.area, q: body.q });

  const filter = [
    query.from || query.to ? `Zeitraum ${query.from ?? 'Anfang'} bis ${query.to ?? 'jetzt'}` : 'gesamter Zeitraum',
    query.actor ? `Wer: ${query.actor}` : null,
    query.area ? `Bereich: ${AUDIT_AREA_LABELS[query.area]}` : null,
    query.q ? `Suche: ${query.q}` : null,
  ].filter(Boolean);
  await logAudit({
    ...actor,
    action: 'audit_exported',
    resource: 'audit_log',
    details: `${format === 'csv' ? 'CSV' : 'JSON Lines'}, ${filter.join(', ')}`,
  });

  return {
    stream: auditExportStream(query, format, language),
    fileName: exportFileName(format),
    contentType: EXPORT_CONTENT_TYPES[format],
  };
}
