'use client';

import { Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import { BellRing, Languages, Loader2, Mail, Plus, Save, Send, Trash2, Users, X } from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { useConfirm } from '@/components/ConfirmDialog';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import Select from '@/components/Select';
import { SkeletonDetail, SkeletonRows } from '@/components/Skeleton';
import AreaTabs, { useArea, type Area } from '@/components/AreaTabs';
import { formatAgo, formatDateTime } from '@/components/system/format';
import { useT } from '@/lib/i18n/react';
import { LOCALES, LOCALE_NAMES, msgid, type Locale } from '@/lib/i18n';
// Rein: Ports und Beschriftungen der Verschlüsselung.
import { SMTP_DEFAULT_PORTS, SMTP_SECURITY_CHOICES } from '@/lib/mail/config';
// Rein: nur Namen und Sätze der Ereignisse.
import { CROWDSEC_EVENT_TYPES, NOTIFICATION_EVENT_GROUPS, NOTIFICATION_EVENT_LABELS } from '@/lib/notifications/events';
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


const POLL_MS = 30_000;

/**
 * Der Zustand steht über den Reitern, darunter je ein Thema: womit verschickt
 * wird, an wen, und wozu. Der gewählte steht als `?bereich=` in der Adresse.
 */
type NotificationArea = 'smtp' | 'empfaenger' | 'ereignisse';

const AREAS: Area<NotificationArea>[] = [
  { key: 'smtp', label: msgid('SMTP-Konto'), icon: Mail },
  { key: 'empfaenger', label: msgid('Empfänger'), icon: Users },
  { key: 'ereignisse', label: msgid('Ereignisse'), icon: BellRing },
];

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
  return (
    <Suspense fallback={<SkeletonDetail />}>
      <Notifications />
    </Suspense>
  );
}

function Notifications() {
  const { apiFetch, session } = useApp();
  const [area, selectArea] = useArea(AREAS, '/notifications');
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t, locale } = useT();
  const now = useNow(30_000);

  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [status, setStatus] = useState<NotificationStatus | null>(null);
  const [error, setError] = useState('');

  /** Nur was im Formular geändert wurde. So überschreibt eine Abfrage keine Eingabe. */
  const [draft, setDraft] = useState<SmtpForm | null>(null);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [clearingPassword, setClearingPassword] = useState(false);

  const [testTo, setTestTo] = useState('');
  const [testing, setTesting] = useState(false);

  const [recipient, setRecipient] = useState('');
  const [recipientError, setRecipientError] = useState('');
  const [savingRecipients, setSavingRecipients] = useState(false);
  const [savingEvent, setSavingEvent] = useState<NotificationEventType | null>(null);
  const [savingLocale, setSavingLocale] = useState(false);

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
      setError(t('Die Einstellungen konnten nicht geladen werden.'));
    }
    await loadStatus();
  }, [apiFetch, loadStatus, t]);

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
    if (!body.success) throw new Error(body.error || t('Die Einstellung ließ sich nicht speichern.'));
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
      setFormError(t('Der Port ist eine Zahl zwischen 1 und 65535.'));
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
      notify({
        variant: 'success',
        message:
          next.smtpHost && next.mailFrom
            ? t('Das SMTP-Konto ist gespeichert. Eine Testmail zeigt, ob der Server es annimmt.')
            : t('Gespeichert. Ohne Server und Absender wird nichts verschickt.'),
      });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: errorText(err, t('Das SMTP-Konto ließ sich nicht speichern.')),
      });
    } finally {
      setSaving(false);
    }
  }

  async function clearPassword() {
    const confirmed = await confirm({
      title: t('SMTP-Passwort löschen?'),
      message: t('HAPM meldet sich danach ohne Passwort am Mailserver an. Verlangt der Server eines, scheitert der Versand.'),
      confirmLabel: t('Passwort löschen'),
      variant: 'danger',
    });
    if (!confirmed) return;
    setClearingPassword(true);
    try {
      await patch({ smtpPass: null });
      if (draft) setDraft({ ...draft, smtpPass: '' });
      notify({ variant: 'success', message: t('Das SMTP-Passwort ist gelöscht.') });
    } catch (err: unknown) {
      notify({ variant: 'error', message: errorText(err, t('Das Passwort ließ sich nicht löschen.')) });
    } finally {
      setClearingPassword(false);
    }
  }

  async function sendTest(event: FormEvent) {
    event.preventDefault();
    setTesting(true);
    try {
      const res = await apiFetch('/api/mail/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ to: testTo.trim() || null }),
      });
      const body = await res.json();
      if (!body.success) {
        notify({ variant: 'error', message: body.error || t('Die Testmail ließ sich nicht verschicken.') });
        return;
      }
      // Das Ergebnis nur als Meldung unten rechts, nicht als Kasten im Formular:
      // Meldungen nach einer Handlung sind Toasts (CLAUDE.md).
      const result = body.data as TestMailResult;
      if (result.sent) {
        notify({
          variant: 'success',
          title: t('Testmail verschickt'),
          message: t('Der Mailserver hat die Testmail an {to} angenommen. Ob sie im Postfach ankommt, zeigt nur das Postfach.', {
            to: result.to,
          }),
        });
      } else {
        notify({
          variant: 'error',
          title: t('Testmail nicht verschickt'),
          message: result.error ?? t('Die Testmail wurde nicht verschickt.'),
        });
      }
    } catch {
      notify({ variant: 'error', message: t('Die Testmail ließ sich nicht verschicken.') });
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
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: errorText(err, t('Die Empfänger ließen sich nicht speichern.')),
      });
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
      setRecipientError(t('Diese Adresse steht schon in der Liste.'));
      return;
    }
    void saveRecipients(
      [...settings.notifyRecipients, address],
      t('{address} bekommt die Benachrichtigungen.', { address })
    );
  }

  async function toggleEvent(type: NotificationEventType, enabled: boolean) {
    setSavingEvent(type);
    try {
      await patch({ notifyEvents: { [type]: enabled } });
      const label = t(NOTIFICATION_EVENT_LABELS[type]);
      notify({
        variant: 'success',
        message: enabled ? t('„{label}“ ist eingeschaltet.', { label }) : t('„{label}“ ist ausgeschaltet.', { label }),
      });
    } catch (err: unknown) {
      notify({ variant: 'error', message: errorText(err, t('Der Schalter ließ sich nicht speichern.')) });
    } finally {
      setSavingEvent(null);
    }
  }

  async function saveMailLocale(next: Locale) {
    setSavingLocale(true);
    try {
      await patch({ mailLocale: next });
      notify({ variant: 'success', message: t('Mails von HAPM gehen ab jetzt auf {language} hinaus.', { language: LOCALE_NAMES[next] }) });
    } catch (err: unknown) {
      notify({ variant: 'error', message: errorText(err, t('Die Sprache ließ sich nicht speichern.')) });
    } finally {
      setSavingLocale(false);
    }
  }

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">{t('Benachrichtigungen')}</h1>
        <p className="page-subtitle">{t('Mails zu Ausfällen, Zertifikaten, Updates und Sicherung.')}</p>
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
  const lastKind = last ? (last.kind === 'test' ? t('Testmail') : t(NOTIFICATION_EVENT_LABELS[last.kind])) : null;
  const lastOutcome = last
    ? last.ok
      ? t('verschickt')
      : last.delivered > 0
        ? t('nicht an alle verschickt')
        : t('gescheitert')
    : '';

  return (
    <>
      {header}

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      <div className="card sys-block">
        <div className="card-header">
          <h2 className="card-title">{t('Zustand')}</h2>
          <span
            className={`badge-status ${
              configured && settings.notifyRecipients.length > 0 ? 'badge-success' : 'badge-neutral'
            }`}
          >
            <span className="dot" />
            {!configured
              ? t('Nicht eingerichtet')
              : settings.notifyRecipients.length === 0
                ? t('Kein Empfänger')
                : t('Eingerichtet')}
          </span>
        </div>
        <div className="dash-kv">
          <div className="dash-kv-row">
            <span className="dash-kv-label">{t('SMTP-Konto')}</span>
            <span className={`dash-kv-value ${configured ? '' : 'muted'}`}>
              {configured
                ? `${settings.smtpHost}:${settings.smtpPort}`
                : t('Server oder Absender fehlt. Es wird nichts verschickt.')}
            </span>
          </div>
          <div className="dash-kv-row">
            <span className="dash-kv-label">{t('Empfänger')}</span>
            <span className={`dash-kv-value ${settings.notifyRecipients.length > 0 ? '' : 'muted'}`}>
              {settings.notifyRecipients.length > 0
                ? settings.notifyRecipients.length
                : t('Keiner. Es werden keine Benachrichtigungen verschickt.')}
            </span>
          </div>
          <div className="dash-kv-row">
            <span className="dash-kv-label">{t('Letzter Versand')}</span>
            {status === null ? (
              <span className="dash-kv-value muted">{t('Unbekannt')}</span>
            ) : last === null ? (
              <span className="dash-kv-value muted">{t('Noch keiner')}</span>
            ) : (
              <span className={`dash-kv-value ${last.ok ? '' : 'is-danger'}`} data-tooltip={formatDateTime(last.at, locale)}>
                {t('{kind}, {ago}, {outcome}', { kind: lastKind ?? '', ago: formatAgo(now, last.at, locale), outcome: lastOutcome })}
              </span>
            )}
          </div>
        </div>
        {last && !last.ok && last.error && <div className="detail-error">{last.error}</div>}
      </div>

      {/* Der Entwurf des SMTP-Kontos liegt in der Seite und bleibt beim Wechsel des Reiters stehen. */}
      <AreaTabs areas={AREAS} value={area} onChange={selectArea} dirty={(key) => key === 'smtp' && draft !== null} />

      {area === 'smtp' && (
        <div className="card sys-block">
          <div className="card-header">
            <div>
              <h2 className="card-title">
                <Mail size={17} strokeWidth={1.5} />
                {t('SMTP-Konto')}
              </h2>
              <p className="card-subtitle">{t('Über dieses Konto verschickt HAPM alle Mails.')}</p>
            </div>
          </div>

          <div className="card-body">
          <form className="card-body" onSubmit={saveSmtp}>
            {formError && <div className="alert alert-danger">{formError}</div>}

            <div className="form-row">
              <div className="form-group">
                <label className="form-label" htmlFor="smtp-host">{t('Server')}</label>
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
                <label className="form-label" htmlFor="smtp-port">{t('Port')}</label>
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
                <label className="form-label" htmlFor="smtp-security">{t('Verschlüsselung')}</label>
                <Select
                  id="smtp-security"
                  value={form.smtpSecurity}
                  options={SMTP_SECURITY_CHOICES.map((option) => ({
                    ...option,
                    label: t(option.label),
                    hint: t(option.hint),
                  }))}
                  disabled={saving}
                  onChange={(value) =>
                    edit({
                      smtpSecurity: value,
                      smtpPort:
                        form.smtpPort === String(SMTP_DEFAULT_PORTS[form.smtpSecurity])
                          ? String(SMTP_DEFAULT_PORTS[value])
                          : form.smtpPort,
                    })
                  }
                />
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="mail-from">
                  {t('Absender')}
                  <InfoHint text={t('Eine Adresse, die das SMTP-Konto verschicken darf. Wahlweise mit Namen davor: HAPM <hapm@example.org>. Ohne Namen steht im Postfach „HAPM“.')} />
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
                <label className="form-label" htmlFor="smtp-user">{t('Benutzername')}</label>
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
                <p className="form-hint">{t('Leer, wenn der Server keine Anmeldung verlangt.')}</p>
              </div>
              <div className="form-group">
                <div className="form-label-row">
                  <label className="form-label" htmlFor="smtp-pass">{t('Passwort')}</label>
                  <span className={`badge-status ${settings.smtpPassSet ? 'badge-success' : 'badge-neutral'}`}>
                    <span className="dot" />
                    {settings.smtpPassSet ? t('Gesetzt') : t('Nicht gesetzt')}
                  </span>
                  <InfoHint text={t('Das Passwort liegt verschlüsselt in der Datenbank und wird nach dem Speichern nicht mehr angezeigt.')} />
                </div>
                <input
                  id="smtp-pass"
                  className="form-input"
                  type="password"
                  placeholder={settings.smtpPassSet ? t('Leer lassen, um es zu behalten') : ''}
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
                {t('Speichern')}
              </button>
              {settings.smtpPassSet && (
                <button
                  className="btn btn-ghost"
                  type="button"
                  onClick={() => void clearPassword()}
                  disabled={saving || clearingPassword}
                >
                  {clearingPassword ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Trash2 size={16} strokeWidth={1.5} />}
                  {t('Passwort löschen')}
                </button>
              )}
            </div>
          </form>

          <form className="card-body" onSubmit={sendTest}>
            <div className="form-group">
              <label className="form-label" htmlFor="test-to">
                {t('Testmail an')}
                <InfoHint text={t('Verschickt wird mit dem gespeicherten Konto, nicht mit dem, was gerade im Formular steht. Das Ergebnis steht danach unter „Letzter Versand“.')} />
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
                    !configured
                      ? t('Erst Server und Absender speichern.')
                      : draft !== null
                        ? t('Erst die Änderungen speichern.')
                        : undefined
                  }
                  data-tooltip-pos="left"
                >
                  {testing ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Send size={16} strokeWidth={1.5} />}
                  {t('Testmail senden')}
                </button>
              </div>
            </div>
          </form>
          </div>
        </div>
      )}

      {area === 'empfaenger' && (
        <>
          <div className="card sys-block">
            <div className="card-header">
              <div>
                <h2 className="card-title">
                  <Users size={17} strokeWidth={1.5} />
                  {t('Empfänger')}
                </h2>
                <p className="card-subtitle">{t('Jede Adresse bekommt jede Benachrichtigung als eigene Mail.')}</p>
              </div>
            </div>

            <div className="card-body">
              {recipientError && <div className="alert alert-danger">{recipientError}</div>}

              {settings.notifyRecipients.length === 0 ? (
                <p className="form-list-empty">{t('Noch kein Empfänger. Ohne Empfänger wird keine Benachrichtigung verschickt.')}</p>
              ) : (
                <div className="pill-list">
                  {settings.notifyRecipients.map((address) => (
                    <span className="pill" key={address}>
                      <span>{address}</span>
                      <button
                        type="button"
                        className="pill-remove"
                        aria-label={t('{address} entfernen', { address })}
                        disabled={savingRecipients}
                        onClick={() =>
                          void saveRecipients(
                            settings.notifyRecipients.filter((entry) => entry !== address),
                            t('{address} bekommt keine Benachrichtigungen mehr.', { address })
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
                  aria-label={t('Neue Empfängeradresse')}
                  placeholder="name@example.org"
                  value={recipient}
                  disabled={savingRecipients}
                  onChange={(event) => setRecipient(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button className="btn btn-secondary" type="submit" disabled={savingRecipients || !recipient.trim()}>
                  {savingRecipients ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Plus size={16} strokeWidth={1.5} />}
                  {t('Hinzufügen')}
                </button>
              </form>
            </div>
          </div>

          <div className="card sys-block">
            <div className="card-header">
              <div>
                <h2 className="card-title">
                  <Languages size={17} strokeWidth={1.5} />
                  {t('Sprache der Mails')}
                  <InfoHint text={t('Gilt für jede Mail von HAPM: Benachrichtigungen, Testmail und die Mails zum Konto. Eine Mail zum Konto (neues Passwort, Passkey) geht in der Sprache, die der Inhaber unter „Konto“ gewählt hat, wenn er eine gewählt hat.')} />
                </h2>
                <p className="card-subtitle">{t('Eine Sprache für alle Empfänger.')}</p>
              </div>
            </div>
            <div className="card-body">
              <div className="form-group">
                <Select
                  id="mail-locale"
                  value={settings.mailLocale}
                  disabled={savingLocale}
                  onChange={(value) => void saveMailLocale(value)}
                  options={LOCALES.map((entry) => ({ value: entry, label: LOCALE_NAMES[entry] }))}
                />
              </div>
            </div>
          </div>
        </>
      )}

      {area === 'ereignisse' && (
        <div className="card sys-block">
          <div className="card-header">
            <div>
              <h2 className="card-title">
                <BellRing size={17} strokeWidth={1.5} />
                {t('Ereignisse')}
                <InfoHint text={t('Dasselbe Ereignis für dieselbe Sache kommt höchstens einmal am Tag. Fällt ein Eintrag zehnmal aus, ist das eine Mail. Hält der Zustand an, kommt am nächsten Tag eine Erinnerung.')} />
              </h2>
              <p className="card-subtitle">{t('Zu welchen Ereignissen eine Mail rausgeht.')}</p>
            </div>
          </div>

          <div className="card-body">
            {NOTIFICATION_EVENT_GROUPS.filter(
              (group) => session.features?.crowdsec === true || !group.events.every((event) => CROWDSEC_EVENT_TYPES.includes(event.type))
            ).map((group) => (
              <div key={group.title}>
                <div className="form-section-title">{t(group.title)}</div>
                <div className="hapm-switch-list">
                  {group.events.map((event) => (
                    <label className="hapm-switch-row" key={event.type}>
                      <span className="hapm-switch-text">
                        <span className="form-label">{t(event.label)}</span>
                        <span className="form-hint">{t(event.description)}</span>
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
      )}
    </>
  );
}
