'use client';

import { useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Activity, Download, Globe, Loader2, Save, Send, Server, Trash2 } from 'lucide-react';
import Select from '@/components/Select';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { formatAgo, formatDateTime } from '@/components/system/format';
import { formatCount } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
// Rein: Auswahlmöglichkeiten und Vorgaben.
import {
  HTTP_BODY_CHOICES,
  SYSLOG_DEFAULT_PORTS,
  SYSLOG_FORMAT_CHOICES,
  SYSLOG_FRAMING_CHOICES,
  SYSLOG_PROTOCOL_CHOICES,
  type HttpBody,
  type SyslogFormat,
  type SyslogProtocol,
} from '@/lib/audit-log/options';
import { SYSLOG_FACILITY_NAMES, type SyslogFacility, type SyslogFraming } from '@/lib/audit-log/format';
// Nur Typen: die Dateien dahinter erreichen `lib/db`.
import type { AuditOverview, ForwardTestResult } from '@/lib/audit-log/actions';
import type { ForwardDestination, ForwardStatus } from '@/lib/audit-log/forward';

/**
 * Der Reiter „Weiterleitung": Syslog und HTTP-Endpunkt, daneben der Zustand.
 *
 * Die Entwürfe der beiden Formulare liegen in der Seite (`page.tsx`), damit
 * sie beim Wechsel des Reiters stehen bleiben und der Reiter einen Punkt trägt.
 */

export interface SyslogDraft {
  enabled: boolean;
  host: string;
  port: string;
  protocol: SyslogProtocol;
  framing: SyslogFraming;
  facility: SyslogFacility;
  appName: string;
  format: SyslogFormat;
  caPem: string;
  haproxyLog: boolean;
}

export interface HttpDraft {
  enabled: boolean;
  url: string;
  body: HttpBody;
  headerName: string;
  headerValue: string;
  caPem: string;
}

export function syslogDraftFrom(overview: AuditOverview): SyslogDraft {
  const s = overview.settings.syslog;
  return {
    enabled: s.enabled,
    host: s.host ?? '',
    port: String(s.port),
    protocol: s.protocol,
    framing: s.framing,
    facility: s.facility,
    appName: s.appName,
    format: s.format,
    caPem: s.caPem ?? '',
    haproxyLog: s.haproxyLog,
  };
}

export function httpDraftFrom(overview: AuditOverview): HttpDraft {
  const h = overview.settings.http;
  return {
    enabled: h.enabled,
    url: h.url ?? '',
    body: h.body,
    headerName: h.headerName ?? '',
    headerValue: '',
    caPem: h.caPem ?? '',
  };
}

interface Props {
  overview: AuditOverview;
  now: number;
  syslogDraft: SyslogDraft | null;
  setSyslogDraft: (draft: SyslogDraft | null) => void;
  httpDraft: HttpDraft | null;
  setHttpDraft: (draft: HttpDraft | null) => void;
  /** Schickt einen Teil-Patch und übernimmt die Antwort. Wirft mit der Meldung des Servers. */
  save: (patch: Record<string, unknown>) => Promise<AuditOverview>;
  /** Schickt eine Testnachricht. Wirft mit der Meldung des Servers. */
  test: (destination: ForwardDestination) => Promise<ForwardTestResult>;
}

function StateRows({ status, now }: { status: ForwardStatus; now: number }) {
  const { t, locale } = useT();
  return (
    <div className="dash-kv">
      <div className="dash-kv-row">
        <span className="dash-kv-label">{t('Letzte Zustellung')}</span>
        {status.lastSuccessAt ? (
          <span className="dash-kv-value" data-tooltip={formatDateTime(status.lastSuccessAt, locale)}>
            {formatAgo(now, status.lastSuccessAt, locale)}
          </span>
        ) : (
          <span className="dash-kv-value muted">{t('Noch keine')}</span>
        )}
      </div>
      <div className="dash-kv-row">
        <span className="dash-kv-label">
          {t('Rückstand')}
          <InfoHint text={t('Einträge, die der Empfänger noch nicht angenommen hat. Sie gehen hinaus, sobald er wieder antwortet.')} />
        </span>
        <span className={`dash-kv-value ${status.backlog ? 'is-warning' : ''}`}>
          {status.backlog === null ? t('Unbekannt') : formatCount(locale, status.backlog)}
        </span>
      </div>
    </div>
  );
}

function StateBlock({ status, title, now }: { status: ForwardStatus; title: string; now: number }) {
  const { t } = useT();
  const failing = status.enabled && status.failingSince !== null;
  return (
    <div>
      <div className="audit-state-head">
        <span className="form-section-title">{title}</span>
        <span className={`badge-status ${!status.enabled ? 'badge-neutral' : failing ? 'badge-danger' : 'badge-success'}`}>
          <span className="dot" />
          {!status.enabled ? t('Aus') : failing ? t('Gestört') : t('Aktiv')}
        </span>
      </div>
      {status.enabled ? (
        <>
          <StateRows status={status} now={now} />
          {status.lastError && <div className="detail-error">{status.lastError}</div>}
        </>
      ) : (
        <p className="form-list-empty">{t('Es wird nichts weitergeleitet.')}</p>
      )}
    </div>
  );
}

export default function ForwardingView({
  overview,
  now,
  syslogDraft,
  setSyslogDraft,
  httpDraft,
  setHttpDraft,
  save,
  test,
}: Props) {
  const { t, locale } = useT();
  const { notify } = useToast();
  const confirm = useConfirm();

  const [saving, setSaving] = useState<ForwardDestination | null>(null);
  const [testing, setTesting] = useState<ForwardDestination | null>(null);
  const [syslogError, setSyslogError] = useState('');
  const [httpError, setHttpError] = useState('');

  const settings = overview.settings;
  const syslog = syslogDraft ?? syslogDraftFrom(overview);
  const http = httpDraft ?? httpDraftFrom(overview);
  const editSyslog = (change: Partial<SyslogDraft>) => setSyslogDraft({ ...syslog, ...change });
  const editHttp = (change: Partial<HttpDraft>) => setHttpDraft({ ...http, ...change });

  const statusOf = (destination: ForwardDestination) =>
    overview.forwarding.find((entry) => entry.destination === destination) as ForwardStatus;

  async function saveSyslog(event: FormEvent) {
    event.preventDefault();
    setSyslogError('');
    const port = Number(syslog.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setSyslogError(t('Der Port ist eine Zahl zwischen 1 und 65535.'));
      return;
    }
    if (syslog.enabled && !syslog.host.trim()) {
      setSyslogError(t('Zum Einschalten fehlt der Syslog-Server.'));
      return;
    }
    setSaving('syslog');
    try {
      await save({
        syslog: {
          enabled: syslog.enabled,
          host: syslog.host.trim() || null,
          port,
          protocol: syslog.protocol,
          framing: syslog.framing,
          facility: syslog.facility,
          appName: syslog.appName.trim(),
          format: syslog.format,
          caPem: syslog.protocol === 'tls' ? syslog.caPem.trim() || null : null,
          haproxyLog: syslog.haproxyLog,
        },
      });
      setSyslogDraft(null);
      notify({
        variant: 'success',
        message: syslog.enabled
          ? t('Gespeichert. Neue Einträge gehen ab jetzt an den Syslog-Server.')
          : t('Gespeichert. An den Syslog-Server geht nichts.'),
      });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: errorText(err, t('Die Weiterleitung ließ sich nicht speichern.')),
      });
    } finally {
      setSaving(null);
    }
  }

  async function saveHttp(event: FormEvent) {
    event.preventDefault();
    setHttpError('');
    if (http.enabled && !http.url.trim()) {
      setHttpError(t('Zum Einschalten fehlt die Adresse des Endpunkts.'));
      return;
    }
    setSaving('http');
    try {
      await save({
        http: {
          enabled: http.enabled,
          url: http.url.trim() || null,
          body: http.body,
          headerName: http.headerName.trim() || null,
          // Leer heißt: der gespeicherte Wert bleibt.
          ...(http.headerValue ? { headerValue: http.headerValue } : {}),
          caPem: http.caPem.trim() || null,
        },
      });
      setHttpDraft(null);
      notify({
        variant: 'success',
        message: http.enabled
          ? t('Gespeichert. Neue Einträge gehen ab jetzt an den Endpunkt.')
          : t('Gespeichert. An den Endpunkt geht nichts.'),
      });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: errorText(err, t('Die Weiterleitung ließ sich nicht speichern.')),
      });
    } finally {
      setSaving(null);
    }
  }

  async function clearHeaderValue() {
    const confirmed = await confirm({
      title: t('Wert der Kopfzeile entfernen?'),
      message: t('HAPM schickt die Kopfzeile danach nicht mehr mit. Verlangt der Endpunkt sie, lehnt er jede Nachricht ab.'),
      confirmLabel: t('Wert entfernen'),
      variant: 'danger',
      failedTitle: t('Entfernen fehlgeschlagen'),
      onConfirm: async () => {
        await save({ http: { headerValue: null } });
        if (httpDraft) setHttpDraft({ ...httpDraft, headerValue: '' });
      },
    });
    if (confirmed) notify({ variant: 'success', message: t('Der Wert der Kopfzeile ist entfernt.') });
  }

  async function sendTest(destination: ForwardDestination) {
    setTesting(destination);
    try {
      const result = await test(destination);
      if (result.sent) {
        notify({
          variant: 'success',
          title: t('Testnachricht gesendet'),
          message:
            destination === 'http'
              ? t('Der Endpunkt hat die Testnachricht angenommen.')
              : settings.syslog.protocol === 'udp'
                ? t('Die Testnachricht ist abgeschickt. Ob sie ankommt, zeigt bei UDP nur der Empfänger.')
                : t('Der Syslog-Server hat die Verbindung angenommen. Ob die Nachricht dort erscheint, zeigt der Empfänger.'),
        });
      } else {
        notify({
          variant: 'error',
          title: t('Testnachricht nicht gesendet'),
          message: result.error ?? t('Die Testnachricht ließ sich nicht senden.'),
        });
      }
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Testnachricht nicht gesendet'),
        message: errorText(err, t('Die Testnachricht ließ sich nicht senden.')),
      });
    } finally {
      setTesting(null);
    }
  }

  const syslogSaved = Boolean(settings.syslog.host);
  const httpSaved = Boolean(settings.http.url);
  const plainHttp = /^http:\/\//i.test(http.url.trim());

  return (
    <div className="hapm-fit">
      <div className="hapm-main-side sys-block">
        <div className="hapm-stack">
          <div className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">
                  <Server size={17} strokeWidth={1.5} />
                  Syslog
                  <InfoHint text={t('Jeder Eintrag geht als Nachricht nach RFC 5424 an einen Syslog-Server, in der Reihenfolge des Protokolls. Weitergeleitet wird, was ab dem Einschalten geschieht. Frühere Einträge liefert der Export.')} />
                </h2>
                <p className="card-subtitle">{t('Für rsyslog, syslog-ng, Graylog, QRadar und andere.')}</p>
              </div>
            </div>

            <form className="card-body" onSubmit={saveSyslog}>
              {syslogError && <div className="alert alert-danger">{syslogError}</div>}

              <label className="hapm-switch-row">
                <span className="hapm-switch-text">
                  <span className="form-label">{t('An den Syslog-Server weiterleiten')}</span>
                </span>
                <span className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={syslog.enabled}
                    disabled={saving !== null}
                    onChange={(event) => editSyslog({ enabled: event.target.checked })}
                  />
                  <span className="toggle-slider" />
                </span>
              </label>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="syslog-host">{t('Server')}</label>
                  <input
                    id="syslog-host"
                    className="form-input"
                    type="text"
                    placeholder="siem.example.org"
                    value={syslog.host}
                    disabled={saving !== null}
                    onChange={(event) => editSyslog({ host: event.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="syslog-port">{t('Port')}</label>
                  <input
                    id="syslog-port"
                    className="form-input"
                    type="text"
                    inputMode="numeric"
                    value={syslog.port}
                    disabled={saving !== null}
                    onChange={(event) => editSyslog({ port: event.target.value.replace(/\D/g, '').slice(0, 5) })}
                    autoComplete="off"
                  />
                </div>
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="syslog-protocol">{t('Übertragung')}</label>
                  <Select
                    id="syslog-protocol"
                    value={syslog.protocol}
                    disabled={saving !== null}
                    options={SYSLOG_PROTOCOL_CHOICES.map((option) => ({ ...option, hint: t(option.hint) }))}
                    onChange={(value) =>
                      editSyslog({
                        protocol: value,
                        // Der Port folgt, solange er der übliche der bisherigen Übertragung war.
                        port:
                          syslog.port === String(SYSLOG_DEFAULT_PORTS[syslog.protocol])
                            ? String(SYSLOG_DEFAULT_PORTS[value])
                            : syslog.port,
                      })
                    }
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="syslog-format">{t('Format')}</label>
                  <Select
                    id="syslog-format"
                    value={syslog.format}
                    disabled={saving !== null}
                    options={SYSLOG_FORMAT_CHOICES.map((option) => ({ ...option, hint: t(option.hint) }))}
                    onChange={(value) => editSyslog({ format: value })}
                  />
                </div>
              </div>

              {syslog.protocol !== 'tls' && (
                <div className="alert alert-warning">
                  {syslog.protocol === 'udp'
                    ? t('Über UDP geht das Protokoll unverschlüsselt durchs Netz, und eine verlorene Nachricht bemerkt niemand.')
                    : t('Über TCP geht das Protokoll unverschlüsselt durchs Netz.')}
                </div>
              )}

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="syslog-facility">
                    {t('Facility')}
                    <InfoHint text={t('Die Einordnung der Nachricht beim Empfänger. Viele Syslog-Server sortieren danach in Dateien.')} />
                  </label>
                  <Select
                    id="syslog-facility"
                    value={syslog.facility}
                    disabled={saving !== null}
                    options={SYSLOG_FACILITY_NAMES.map((value) => ({ value, label: value }))}
                    onChange={(value) => editSyslog({ facility: value })}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="syslog-app">
                    {t('Name der Anwendung')}
                    <InfoHint text={t('Steht im Kopf jeder Nachricht (APP-NAME). Daran erkennt der Empfänger, was von HAPM kommt.')} />
                  </label>
                  <input
                    id="syslog-app"
                    className="form-input"
                    type="text"
                    value={syslog.appName}
                    maxLength={48}
                    disabled={saving !== null}
                    onChange={(event) => editSyslog({ appName: event.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
              </div>

              {syslog.protocol !== 'udp' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="syslog-framing">
                    {t('Trennung der Nachrichten')}
                    <InfoHint text={t('Woran der Empfänger auf einer Verbindung das Ende einer Nachricht erkennt. Kommt dort nur eine einzige lange Zeile an, ist es die falsche Wahl.')} />
                  </label>
                  <Select
                    id="syslog-framing"
                    value={syslog.framing}
                    disabled={saving !== null}
                    options={SYSLOG_FRAMING_CHOICES.map((option) => ({ ...option, label: t(option.label), hint: t(option.hint) }))}
                    onChange={(value) => editSyslog({ framing: value })}
                  />
                </div>
              )}

              {syslog.protocol === 'tls' && (
                <div className="form-group">
                  <label className="form-label" htmlFor="syslog-ca">
                    {t('CA-Zertifikat (PEM)')}
                    <InfoHint text={t('Nur nötig, wenn das Zertifikat des Syslog-Servers aus einer eigenen PKI stammt. Leer: geprüft wird gegen die CAs des Systems. Das Zertifikat wird immer geprüft.')} />
                  </label>
                  <textarea
                    id="syslog-ca"
                    className="form-textarea mono"
                    rows={4}
                    placeholder="-----BEGIN CERTIFICATE-----"
                    value={syslog.caPem}
                    disabled={saving !== null}
                    onChange={(event) => editSyslog({ caPem: event.target.value })}
                    spellCheck={false}
                  />
                </div>
              )}

              <label className="hapm-switch-row">
                <span className="hapm-switch-text">
                  <span className="form-label">
                    {t('Zugriffslog von HAProxy mitschicken')}
                    <InfoHint text={t('Jede Zeile, die HAProxy schreibt, geht zusätzlich an diesen Server, mit dem Namen „haproxy“. Ohne Garantie: nimmt der Server nichts an, warten die letzten 5.000 Zeilen, ältere fallen weg.')} />
                  </span>
                  <span className="form-hint">{t('Jede Anfrage an den Proxy, das können sehr viele sein.')}</span>
                </span>
                <span className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={syslog.haproxyLog}
                    disabled={saving !== null}
                    onChange={(event) => editSyslog({ haproxyLog: event.target.checked })}
                  />
                  <span className="toggle-slider" />
                </span>
              </label>

              <div className="hapm-form-actions">
                <button className="btn btn-primary" type="submit" disabled={saving !== null || !syslogDraft}>
                  {saving === 'syslog' ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Save size={16} strokeWidth={1.5} />}
                  {t('Speichern')}
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void sendTest('syslog')}
                  disabled={testing !== null || !syslogSaved || syslogDraft !== null}
                  data-tooltip={
                    !syslogSaved ? t('Erst den Server speichern.') : syslogDraft !== null ? t('Erst die Änderungen speichern.') : undefined
                  }
                >
                  {testing === 'syslog' ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Send size={16} strokeWidth={1.5} />}
                  {t('Testnachricht senden')}
                </button>
              </div>
            </form>
          </div>

          <div className="card">
            <div className="card-header">
              <div>
                <h2 className="card-title">
                  <Globe size={17} strokeWidth={1.5} />
                  {t('HTTP-Endpunkt')}
                  <InfoHint text={t('Jeder Eintrag geht als JSON per POST an eine Adresse. Zugestellt heißt hier: der Endpunkt antwortet mit 2xx. Weitergeleitet wird, was ab dem Einschalten geschieht.')} />
                </h2>
                <p className="card-subtitle">{t('Für Splunk HEC, Elastic, Logstash und eigene Webhooks.')}</p>
              </div>
            </div>

            <form className="card-body" onSubmit={saveHttp}>
              {httpError && <div className="alert alert-danger">{httpError}</div>}

              <label className="hapm-switch-row">
                <span className="hapm-switch-text">
                  <span className="form-label">{t('An den Endpunkt weiterleiten')}</span>
                </span>
                <span className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={http.enabled}
                    disabled={saving !== null}
                    onChange={(event) => editHttp({ enabled: event.target.checked })}
                  />
                  <span className="toggle-slider" />
                </span>
              </label>

              <div className="form-group">
                <label className="form-label" htmlFor="http-url">{t('Adresse')}</label>
                <input
                  id="http-url"
                  className="form-input"
                  type="url"
                  placeholder="https://siem.example.org:8088/services/collector/event"
                  value={http.url}
                  disabled={saving !== null}
                  onChange={(event) => editHttp({ url: event.target.value })}
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>

              {plainHttp && (
                <div className="alert alert-warning">
                  {t('Über http:// gehen das Protokoll und der Wert der Kopfzeile unverschlüsselt durchs Netz.')}
                </div>
              )}

              <div className="form-group">
                <label className="form-label" htmlFor="http-body">{t('Aufbau')}</label>
                <Select
                  id="http-body"
                  value={http.body}
                  disabled={saving !== null}
                  options={HTTP_BODY_CHOICES.map((option) => ({ ...option, hint: t(option.hint) }))}
                  onChange={(value) => editHttp({ body: value })}
                />
              </div>

              <div className="form-row">
                <div className="form-group">
                  <label className="form-label" htmlFor="http-header-name">
                    {t('Kopfzeile')}
                    <InfoHint text={t('Der Name der Kopfzeile, mit der sich HAPM am Endpunkt ausweist. Meist Authorization.')} />
                  </label>
                  <input
                    id="http-header-name"
                    className="form-input"
                    type="text"
                    placeholder="Authorization"
                    value={http.headerName}
                    disabled={saving !== null}
                    onChange={(event) => editHttp({ headerName: event.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="form-group">
                  <div className="form-label-row">
                    <label className="form-label" htmlFor="http-header-value">{t('Wert')}</label>
                    <span className={`badge-status ${settings.http.headerValueSet ? 'badge-success' : 'badge-neutral'}`}>
                      <span className="dot" />
                      {settings.http.headerValueSet ? t('Gesetzt') : t('Nicht gesetzt')}
                    </span>
                    <InfoHint text={t('Der ganze Wert, etwa „Splunk <Token>“ oder „Bearer <Token>“. Er liegt verschlüsselt in der Datenbank und wird nach dem Speichern nicht mehr angezeigt.')} />
                  </div>
                  <input
                    id="http-header-value"
                    className="form-input"
                    type="password"
                    placeholder={settings.http.headerValueSet ? t('Leer lassen, um ihn zu behalten') : ''}
                    value={http.headerValue}
                    disabled={saving !== null}
                    onChange={(event) => editHttp({ headerValue: event.target.value })}
                    autoComplete="new-password"
                  />
                </div>
              </div>

              {!plainHttp && (
                <div className="form-group">
                  <label className="form-label" htmlFor="http-ca">
                    {t('CA-Zertifikat (PEM)')}
                    <InfoHint text={t('Nur nötig, wenn das Zertifikat des Endpunkts aus einer eigenen PKI stammt. Leer: geprüft wird gegen die CAs des Systems. Das Zertifikat wird immer geprüft.')} />
                  </label>
                  <textarea
                    id="http-ca"
                    className="form-textarea mono"
                    rows={4}
                    placeholder="-----BEGIN CERTIFICATE-----"
                    value={http.caPem}
                    disabled={saving !== null}
                    onChange={(event) => editHttp({ caPem: event.target.value })}
                    spellCheck={false}
                  />
                </div>
              )}

              <div className="hapm-form-actions">
                <button className="btn btn-primary" type="submit" disabled={saving !== null || !httpDraft}>
                  {saving === 'http' ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Save size={16} strokeWidth={1.5} />}
                  {t('Speichern')}
                </button>
                <button
                  className="btn btn-secondary"
                  type="button"
                  onClick={() => void sendTest('http')}
                  disabled={testing !== null || !httpSaved || httpDraft !== null}
                  data-tooltip={
                    !httpSaved ? t('Erst die Adresse speichern.') : httpDraft !== null ? t('Erst die Änderungen speichern.') : undefined
                  }
                >
                  {testing === 'http' ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Send size={16} strokeWidth={1.5} />}
                  {t('Testnachricht senden')}
                </button>
                {settings.http.headerValueSet && (
                  <button className="btn btn-ghost" type="button" onClick={() => void clearHeaderValue()} disabled={saving !== null}>
                    <Trash2 size={16} strokeWidth={1.5} />
                    {t('Wert entfernen')}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>

        <div className="hapm-side">
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">
                <Activity size={17} strokeWidth={1.5} />
                {t('Zustand')}
              </h2>
            </div>
            <div className="card-body">
              <StateBlock status={statusOf('syslog')} title="Syslog" now={now} />
              <StateBlock status={statusOf('http')} title={t('HTTP-Endpunkt')} now={now} />
            </div>
          </div>
          {settings.syslog.enabled && settings.syslog.haproxyLog && overview.haproxyLog.dropped > 0 && (
            <div className="alert alert-warning">
              {t('Seit dem Start von HAPM sind {count} Zeilen von HAProxy weggefallen, weil der Syslog-Server sie nicht annahm.', {
                count: formatCount(locale, overview.haproxyLog.dropped),
              })}
            </div>
          )}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">
                <Download size={17} strokeWidth={1.5} />
                {t('Selbst abholen')}
                <InfoHint text={t('Ein SIEM kann das Protokoll auch selbst holen: GET /api/internal/audit mit einem API-Key. Mit after=<cursor> liefert jede Anfrage, was seit der vorigen dazukam, jeden Eintrag genau einmal.')} />
              </h2>
            </div>
            <p className="form-list-empty">
              {t('Statt der Weiterleitung oder zusätzlich: über die API mit einem API-Key.')}
            </p>
            <div className="hapm-form-actions">
              <Link className="btn btn-secondary btn-sm" href="/reverse-proxy/api">
                {t('API und MCP')}
              </Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
