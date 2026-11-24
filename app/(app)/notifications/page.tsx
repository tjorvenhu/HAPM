'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { BellRing, Loader2, Mail, Plus, Save, Send, Trash2, Users, X } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import Select, { type SelectOption } from '@/components/Select';
import { SkeletonDetail, SkeletonRows } from '@/components/Skeleton';
import { formatAgo, formatDateTime } from '@/components/system/format';
// Rein: nur Namen und Sätze der Ereignisse.
import { NOTIFICATION_EVENT_GROUPS, NOTIFICATION_EVENT_LABELS } from '@/lib/notifications/events';
// Nur Typen: die Dateien dahinter erreichen `lib/db` und `nodemailer`.
import type { SettingsView } from '@/lib/settings';
import type { NotificationStatus, TestMailResult } from '@/lib/notifications';
import type { NotificationEventType, SmtpSecurity } from '@/lib/types';

interface SmtpForm {
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: SmtpSecurity;
  smtpUser: string;
  smtpPass: string;
  mailFrom: string;
}

/** Der übliche Port je Verschlüsselung. Wechselt die eine, zieht der andere mit, solange er der übliche war. */
const DEFAULT_PORTS: Record<SmtpSecurity, string> = { starttls: '587', tls: '465', none: '25' };

const SECURITY_OPTIONS: SelectOption<SmtpSecurity>[] = [
  { value: 'starttls', label: 'STARTTLS', hint: 'Üblich auf Port 587' },
  { value: 'tls', label: 'TLS', hint: 'Üblich auf Port 465' },
  { value: 'none', label: 'Keine', hint: 'Unverschlüsselt, nur im eigenen Netz' },
];

const POLL_MS = 30_000;

function formFrom(settings: SettingsView): SmtpForm {
  return {
    smtpHost: settings.smtpHost ?? '',
    smtpPort: String(settings.smtpPort),
    smtpSecurity: settings.smtpSecurity,
    smtpUser: settings.smtpUser ?? '',
    smtpPass: '',
    mailFrom: settings.mailFrom ?? '',
  };
}

export default function NotificationsPage() {
  const { apiFetch, session } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const now = useNow(30_000);

  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [error, setError] = useState('');

  /** Nur was im Formular geändert wurde. So überschreibt eine Abfrage keine Eingabe. */
  const [draft, setDraft] = useState<SmtpForm | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);

  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestMailResult | null>(null);

  const [recipient, setRecipient] = useState('');
  const [recipientError, setRecipientError] = useState('');
  const [savingRecipients, setSavingRecipients] = useState(false);
  const [savingEvent, setSavingEvent] = useState<NotificationEventType | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const res = await apiFetch('/api/mail/status', { cache: 'no-store' });
      const body = await res.json();
      if (body.success) setStatus(body.data as NotificationStatus);
    } catch {
      // Der Stand von eben bleibt stehen, die nächste Abfrage holt ihn nach.
    }
  }, [apiFetch]);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/settings', { cache: 'no-store' });
      const body = await res.json();
      if (!body.success) throw new Error(body.error);
      setSettings(body.data as SettingsView);
      setError('');
    } catch {
      setError('Die Einstellungen konnten nicht geladen werden.');
    }
    await loadStatus();
  }, [apiFetch, loadStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(loadStatus, POLL_MS);

  async function patch(payload: Record<string, unknown>): Promise<SettingsView> {
    const res = await apiFetch('/api/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await res.json();
    if (!body.success) throw new Error(body.error || 'Die Einstellung ließ sich nicht speichern.');
    const next = body.data.settings as SettingsView;
    setSettings(next);
    void loadStatus();
    return next;
  }

  async function saveSmtp(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setFormError('');

    const port = Number(draft.smtpPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      setFormError('Der Port ist eine Zahl zwischen 1 und 65535.');
      return;
    }

    setSaving(true);
    try {
      const next = await patch({
        smtpHost: draft.smtpHost.trim() || null,
        smtpPort: port,
        smtpSecurity: draft.smtpSecurity,
        smtpUser: draft.smtpUser.trim() || null,
        // Leer heißt: das gespeicherte Passwort bleibt.
        ...(draft.smtpPass ? { smtpPass: draft.smtpPass } : {}),
        mailFrom: draft.mailFrom.trim() || null,
      });
      setDraft(null);
      setTestResult(null);
      notify({
        variant: 'success',
        message:
          next.smtpHost && next.mailFrom
            ? 'Das SMTP-Konto ist gespeichert. Eine Testmail zeigt, ob der Server es annimmt.'
            : 'Gespeichert. Ohne Server und Absender wird nichts verschickt.',
      });
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : 'Das SMTP-Konto ließ sich nicht speichern.');
    } finally {
      setSaving(false);
    }
  }

  async function clearPassword() {
    const confirmed = await confirm({
      title: 'SMTP-Passwort löschen?',
      message: 'HAPM meldet sich danach ohne Passwort am Mailserver an. Verlangt der Server eines, scheitert der Versand.',
      confirmLabel: 'Passwort löschen',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await patch({ smtpPass: null });
      if (draft) setDraft({ ...draft, smtpPass: '' });
      notify({ variant: 'success', message: 'Das SMTP-Passwort ist gelöscht.' });
    } catch (err: unknown) {
      notify({ variant: 'error', message: err instanceof Error ? err.message : 'Das Passwort ließ sich nicht löschen.' });
    }
  }

  async function sendTest(event: FormEvent) {
    event.preventDefault();
    setTesting(true);
    setTestResult(null);
    try {
      const res = await apiFetch('/api/mail/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testTo.trim() || null }),
      });
      const body = await res.json();
      if (!body.success) {
        notify({ variant: 'error', message: body.error || 'Die Testmail ließ sich nicht verschicken.' });
        return;
      }
      const result = body.data as TestMailResult;
      setTestResult(result);
      if (result.sent) notify({ variant: 'success', message: `Der Mailserver hat die Testmail an ${result.to} angenommen.` });
      else notify({ variant: 'error', title: 'Testmail nicht verschickt', message: 'Die Meldung des Mailservers steht beim Formular.' });
    } catch {
      notify({ variant: 'error', message: 'Die Testmail ließ sich nicht verschicken.' });
    } finally {
      setTesting(false);
      void loadStatus();
    }
  }

  async function saveRecipients(next: string[], message: string) {
    setRecipientError('');
    setSavingRecipients(true);
    try {
      await patch({ notifyRecipients: next });
      setRecipient('');
      notify({ variant: 'success', message });
    } catch (err: unknown) {
      setRecipientError(err instanceof Error ? err.message : 'Die Empfänger ließen sich nicht speichern.');
    } finally {
      setSavingRecipients(false);
    }
  }

  function addRecipient(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    const address = recipient.trim();
    if (!address) return;
    if (settings.notifyRecipients.some((entry) => entry.toLowerCase() === address.toLowerCase())) {
      setRecipientError('Diese Adresse steht schon in der Liste.');
      return;
    }
    void saveRecipients([...settings.notifyRecipients, address], `${address} bekommt die Benachrichtigungen.`);
  }

  async function toggleEvent(type: NotificationEventType, enabled: boolean) {
    setSavingEvent(type);
    try {
      await patch({ notifyEvents: { [type]: enabled } });
      notify({
        variant: 'success',
        message: `„${NOTIFICATION_EVENT_LABELS[type]}“ ist ${enabled ? 'eingeschaltet' : 'ausgeschaltet'}.`,
      });
    } catch (err: unknown) {
      notify({ variant: 'error', message: err instanceof Error ? err.message : 'Der Schalter ließ sich nicht speichern.' });
    } finally {
      setSavingEvent(null);
    }
  }

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">Benachrichtigungen</h1>
        <p className="page-subtitle">Mails zu Ausfällen, Zertifikaten, Updates und Sicherung.</p>
      </div>
    </div>
  );

  if (!settings) {
    return (
      <>
        {header}
        {error ? (
          <div className="alert alert-danger sys-block">{error}</div>
        ) : (
          <>
            <div className="sys-block">
              <SkeletonDetail />
            </div>
            <SkeletonRows count={4} />
          </>
        )}
      </>
    );
  }

  const form = draft ?? formFrom(settings);
  const edit = (change: Partial<SmtpForm>) => setDraft({ ...form, ...change });
  const configured = Boolean(settings.smtpHost && settings.mailFrom);
  const last = status?.lastDelivery ?? null;
  const lastKind = last ? (last.kind === 'test' ? 'Testmail' : NOTIFICATION_EVENT_LABELS[last.kind]) : null;

  return (
    <>
      {header}

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      <div className="card sys-block">
        <div className="card-header">
          <h2 className="card-title">Zustand</h2>
          <span
            className={`badge-status ${
              configured && settings.notifyRecipients.length > 0 ? 'badge-success' : 'badge-neutral'
            }`}
          >
            <span className="dot" />
            {!configured
              ? 'Nicht eingerichtet'
              : settings.notifyRecipients.length === 0
                ? 'Kein Empfänger'
                : 'Eingerichtet'}
          </span>
        </div>
        <div className="dash-kv">
          <div className="dash-kv-row">
            <span className="dash-kv-label">SMTP-Konto</span>
            <span className={`dash-kv-value ${configured ? '' : 'muted'}`}>
              {configured ? `${settings.smtpHost}:${settings.smtpPort}` : 'Server oder Absender fehlt. Es wird nichts verschickt.'}
            </span>
          </div>
          <div className="dash-kv-row">
            <span className="dash-kv-label">Empfänger</span>
            <span className={`dash-kv-value ${settings.notifyRecipients.length > 0 ? '' : 'muted'}`}>
              {settings.notifyRecipients.length > 0
                ? settings.notifyRecipients.length
                : 'Keiner. Es werden keine Benachrichtigungen verschickt.'}
            </span>
          </div>
          <div className="dash-kv-row">
            <span className="dash-kv-label">Letzter Versand</span>
            {status === null ? (
              <span className="dash-kv-value muted">Unbekannt</span>
            ) : last === null ? (
              <span className="dash-kv-value muted">Noch keiner</span>
            ) : (
              <span className={`dash-kv-value ${last.ok ? '' : 'is-danger'}`} data-tooltip={formatDateTime(last.at)}>
                {lastKind}, {formatAgo(now, last.at)}, {last.ok ? 'verschickt' : last.delivered > 0 ? 'nicht an alle verschickt' : 'gescheitert'}
              </span>
            )}
          </div>
        </div>
        {last && !last.ok && last.error && <div className="detail-error">{last.error}</div>}
      </div>

      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <Mail size={17} strokeWidth={1.5} />
              SMTP-Konto
            </h2>
            <p className="card-subtitle">Über dieses Konto verschickt HAPM alle Mails.</p>
          </div>
        </div>

        <div className="card-body">
        <form className="card-body" onSubmit={saveSmtp}>
          {formError && <div className="alert alert-danger">{formError}</div>}

          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="smtp-host">Server</label>
              <input
                id="smtp-host"
                className="form-input"
                type="text"
                placeholder="smtp.example.org"
                value={form.smtpHost}
                disabled={saving}
                onChange={(event) => edit({ smtpHost: event.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="smtp-port">Port</label>
              <input
                id="smtp-port"
                className="form-input"
                type="text"
                inputMode="numeric"
                value={form.smtpPort}
                disabled={saving}
                onChange={(event) => edit({ smtpPort: event.target.value.replace(/\D/g, '').slice(0, 5) })}
                autoComplete="off"
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="smtp-security">Verschlüsselung</label>
              <Select
                id="smtp-security"
                value={form.smtpSecurity}
                options={SECURITY_OPTIONS}
                disabled={saving}
                onChange={(value) =>
                  edit({
                    smtpSecurity: value,
                    smtpPort: form.smtpPort === DEFAULT_PORTS[form.smtpSecurity] ? DEFAULT_PORTS[value] : form.smtpPort,
                  })
                }
              />
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="mail-from">
                Absender
                <InfoHint text="Eine Adresse, die das SMTP-Konto verschicken darf. Wahlweise mit Namen davor: HAPM <hapm@example.org>. Ohne Namen steht im Postfach „HAPM“." />
              </label>
              <input
                id="mail-from"
                className="form-input"
                type="text"
                placeholder="hapm@example.org"
                value={form.mailFrom}
                disabled={saving}
                onChange={(event) => edit({ mailFrom: event.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label" htmlFor="smtp-user">Benutzer</label>
              <input
                id="smtp-user"
                className="form-input"
                type="text"
                value={form.smtpUser}
                disabled={saving}
                onChange={(event) => edit({ smtpUser: event.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="form-hint">Leer, wenn der Server keine Anmeldung verlangt.</p>
            </div>
            <div className="form-group">
              <div className="form-label-row">
                <label className="form-label" htmlFor="smtp-pass">Passwort</label>
                <span className={`badge-status ${settings.smtpPassSet ? 'badge-success' : 'badge-neutral'}`}>
                  <span className="dot" />
                  {settings.smtpPassSet ? 'Gesetzt' : 'Nicht gesetzt'}
                </span>
                <InfoHint text="Das Passwort liegt verschlüsselt in der Datenbank und wird nach dem Speichern nicht mehr angezeigt." />
              </div>
              <input
                id="smtp-pass"
                className="form-input"
                type="password"
                placeholder={settings.smtpPassSet ? 'Leer lassen, um es zu behalten' : ''}
                value={form.smtpPass}
                disabled={saving}
                onChange={(event) => edit({ smtpPass: event.target.value })}
                autoComplete="new-password"
              />
            </div>
          </div>

          <div className="hapm-form-actions">
            <button className="btn btn-primary" type="submit" disabled={saving || !draft}>
              {saving ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Save size={16} strokeWidth={1.5} />}
              Speichern
            </button>
            {settings.smtpPassSet && (
              <button className="btn btn-ghost" type="button" onClick={() => void clearPassword()} disabled={saving}>
                <Trash2 size={16} strokeWidth={1.5} />
                Passwort löschen
              </button>
            )}
          </div>
        </form>

        <form className="card-body" onSubmit={sendTest}>
          <div className="form-group">
            <label className="form-label" htmlFor="test-to">
              Testmail an
              <InfoHint text="Verschickt wird mit dem gespeicherten Konto, nicht mit dem, was gerade im Formular steht. Die Antwort des Mailservers steht danach hier." />
            </label>
            <div className="form-list-row">
              <input
                id="test-to"
                className="form-input"
                type="email"
                placeholder={session.email}
                value={testTo}
                disabled={testing}
                onChange={(event) => setTestTo(event.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                className="btn btn-secondary"
                type="submit"
                disabled={testing || !configured || draft !== null}
                data-tooltip={
                  !configured ? 'Erst Server und Absender speichern.' : draft !== null ? 'Erst die Änderungen speichern.' : undefined
                }
                data-tooltip-pos="left"
              >
                {testing ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Send size={16} strokeWidth={1.5} />}
                Testmail senden
              </button>
            </div>
          </div>
          {testResult &&
            (testResult.sent ? (
              <div className="alert alert-success">
                Der Mailserver hat die Testmail an {testResult.to} angenommen. Ob sie im Postfach ankommt, zeigt nur das Postfach.
              </div>
            ) : (
              <div className="alert alert-danger">{testResult.error ?? 'Die Testmail wurde nicht verschickt.'}</div>
            ))}
        </form>
        </div>
      </div>

      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <Users size={17} strokeWidth={1.5} />
              Empfänger
            </h2>
            <p className="card-subtitle">Jede Adresse bekommt jede Benachrichtigung als eigene Mail.</p>
          </div>
        </div>

        <div className="card-body">
          {recipientError && <div className="alert alert-danger">{recipientError}</div>}

          {settings.notifyRecipients.length === 0 ? (
            <p className="form-list-empty">Noch kein Empfänger. Ohne Empfänger wird keine Benachrichtigung verschickt.</p>
          ) : (
            <div className="pill-list">
              {settings.notifyRecipients.map((address) => (
                <span className="pill" key={address}>
                  <span>{address}</span>
                  <button
                    type="button"
                    className="pill-remove"
                    aria-label={`${address} entfernen`}
                    disabled={savingRecipients}
                    onClick={() =>
                      void saveRecipients(
                        settings.notifyRecipients.filter((entry) => entry !== address),
                        `${address} bekommt keine Benachrichtigungen mehr.`
                      )
                    }
                  >
                    <X size={14} strokeWidth={1.5} />
                  </button>
                </span>
              ))}
            </div>
          )}

          <form className="form-list-row" onSubmit={addRecipient}>
            <input
              className="form-input"
              type="email"
              aria-label="Neue Empfängeradresse"
              placeholder="name@example.org"
              value={recipient}
              disabled={savingRecipients}
              onChange={(event) => setRecipient(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <button className="btn btn-secondary" type="submit" disabled={savingRecipients || !recipient.trim()}>
              {savingRecipients ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Plus size={16} strokeWidth={1.5} />}
              Hinzufügen
            </button>
          </form>
        </div>
      </div>

      <div className="card sys-block">
        <div className="card-header">
          <div>
            <h2 className="card-title">
              <BellRing size={17} strokeWidth={1.5} />
              Ereignisse
              <InfoHint text="Dasselbe Ereignis für dieselbe Sache kommt höchstens einmal am Tag. Fällt ein Eintrag zehnmal aus, ist das eine Mail. Hält der Zustand an, kommt am nächsten Tag eine Erinnerung." />
            </h2>
            <p className="card-subtitle">Zu welchen Ereignissen eine Mail rausgeht.</p>
          </div>
        </div>

        <div className="card-body">
          {NOTIFICATION_EVENT_GROUPS.map((group) => (
            <div key={group.title}>
              <div className="form-section-title">{group.title}</div>
              <div className="hapm-switch-list">
                {group.events.map((event) => (
                  <label className="hapm-switch-row" key={event.type}>
                    <span className="hapm-switch-text">
                      <span className="form-label">{event.label}</span>
                      <span className="form-hint">{event.description}</span>
                    </span>
                    <span className="toggle-switch">
                      <input
                        type="checkbox"
                        checked={settings.notifyEvents[event.type]}
                        disabled={savingEvent !== null}
                        onChange={(change) => void toggleEvent(event.type, change.target.checked)}
                      />
                      <span className="toggle-slider" />
                    </span>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
