/**
 * Die Einstellungen von HAPM ändern, so wie es die Seiten „Allgemein",
 * „Benachrichtigungen" und „Updates" tun, die interne API
 * (`/api/internal/settings`) und der MCP-Server.
 *
 * Die Logik stand vorher in `app/api/settings/route.ts` und
 * `app/api/settings/certificates/route.ts`. Sie ist hier, damit jeder Weg
 * dieselbe Prüfung der Form, dieselbe Zeile im Protokoll und denselben
 * Nachlauf (Konto bei acme.sh) hat.
 *
 * ── Was ein Token nicht ändern darf ──
 *
 * `readServiceSettingsInput` lehnt zwei Felder ab, die die Oberfläche annimmt:
 *  - `publicUrl`: die Adresse von HAPM. Sie zu ändern löscht alle Passkeys und
 *    ändert die Adresse, über die API und MCP selbst erreichbar sind. Dafür
 *    gibt es den Umzug in der Oberfläche, der Ziel und Zertifikat mitnimmt.
 *  - `smtpPass`: ein Geheimnis gehört nicht in den Verlauf eines Sprachmodells
 *    und nicht in ein Skript. Lesen geht ohnehin nur als `smtpPassSet`.
 * Beim ACME-Server ebenso der EAB-Schlüssel (`changeCertificateSettings`).
 */

import { UPDATE_COMPONENTS } from './updates/actions';
import type { UpdateComponent } from './types';
import { ApiError } from './api';
import { msg } from './i18n';
import { logAudit } from './audit';
import { ensureAcme } from './acme';
import {
  getSettings,
  passkeysDroppedBy,
  readSmtpInput,
  settingsView,
  updateSettings,
  type SettingsInput,
  type SettingsView,
} from './settings';
import { readCertificateSettings, saveCertificateSettings } from './certificate-settings';
import { rateLimit } from './rate-limit';
import { validateEmail } from './validation';
import { mailConfigured } from './mail';
import { notificationStatus, sendTestMail } from './notifications';
import { NOTIFICATION_EVENT_TYPES, type Exposure, type NotificationEventType, type Settings } from './types';

export interface SettingsActor {
  userId: string;
  userEmail: string;
  ip?: string;
}

const TEXT_FIELDS = ['acmeEmail', 'publicUrl'] as const;

const FIELD_LABELS: Record<keyof SettingsInput, string> = {
  acmeEmail: 'E-Mail für Let\'s Encrypt',
  publicUrl: 'Adresse von HAPM',
  autoUpdateHaproxy: 'Selbsttätiges Update von HAProxy',
  autoUpdate: 'Selbsttätige Updates',
  autoUpdateTime: 'Uhrzeit für selbsttätige Updates',
  smtpHost: 'SMTP-Server',
  smtpPort: 'SMTP-Port',
  smtpSecurity: 'SMTP-Verschlüsselung',
  smtpUser: 'SMTP-Benutzer',
  smtpPass: 'SMTP-Passwort',
  mailFrom: 'Absender',
  notifyRecipients: 'Empfänger',
  notifyEvents: 'Ereignisse',
  mailLocale: 'Sprache der Mails',
  exposure: 'Art der Installation',
  certificateSource: 'Herkunft der Zertifikate',
  acmeDirectory: 'ACME-Server',
  acmeHttpReachable: 'ACME-Server erreicht HAPM über Port 80',
  dnsWait: 'Wartezeit nach dem DNS-Eintrag',
  setupStatus: 'Einrichtung',
};

/** Die Eingabe auf ihre Form prüfen. Was die Werte bedeuten dürfen, prüft `updateSettings`. */
export function readSettingsInput(body: Record<string, unknown>): SettingsInput {
  const input: SettingsInput = {};

  for (const field of TEXT_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value !== null && typeof value !== 'string') throw new ApiError(msg('Das Feld {field} erwartet einen Text.', { field }));
    input[field] = value;
  }
  Object.assign(input, readSmtpInput(body));
  if ('autoUpdateHaproxy' in body) {
    if (typeof body.autoUpdateHaproxy !== 'boolean') {
      throw new ApiError(msg('Der Schalter für selbsttätige Updates kennt nur an und aus.'));
    }
    input.autoUpdateHaproxy = body.autoUpdateHaproxy;
  }
  if ('autoUpdate' in body) {
    const list = body.autoUpdate;
    if (!Array.isArray(list) || !list.every((entry) => UPDATE_COMPONENTS.includes(entry as UpdateComponent))) {
      throw new ApiError(
        msg('Selbsttätige Updates sind eine Liste aus {components}.', { components: UPDATE_COMPONENTS.join(', ') })
      );
    }
    input.autoUpdate = list as UpdateComponent[];
  }
  if ('autoUpdateTime' in body) {
    if (typeof body.autoUpdateTime !== 'string') throw new ApiError(msg('Die Uhrzeit hat nicht die Form HH:MM.'));
    input.autoUpdateTime = body.autoUpdateTime;
  }
  if ('notifyRecipients' in body) {
    if (!Array.isArray(body.notifyRecipients)) throw new ApiError(msg('Die Empfänger sind eine Liste von Adressen.'));
    input.notifyRecipients = body.notifyRecipients as string[];
  }
  if ('notifyEvents' in body) {
    const events = body.notifyEvents;
    if (typeof events !== 'object' || events === null || Array.isArray(events)) {
      throw new ApiError(msg('Die Ereignisse sind Schalter je Ereignis.'));
    }
    input.notifyEvents = events as Partial<Record<NotificationEventType, boolean>>;
  }
  // Ob es eine Sprache ist, prüft `updateSettings`.
  if ('mailLocale' in body) input.mailLocale = body.mailLocale as SettingsInput['mailLocale'];

  // `setupStatus` gehört dem Assistenten (`/api/setup/status`) und wird hier nicht angenommen.
  if ('exposure' in body) {
    if (typeof body.exposure !== 'string') {
      throw new ApiError(msg('Die Installation ist entweder intern oder aus dem Internet erreichbar.'));
    }
    input.exposure = body.exposure as Exposure;
  }

  // Ob die Zahl im erlaubten Bereich liegt, prüft `updateSettings`.
  if ('dnsWait' in body) input.dnsWait = body.dnsWait as number;

  if (Object.keys(input).length === 0) throw new ApiError(msg('Es wurde nichts zum Ändern übergeben.'));
  return input;
}

/** Wie `readSettingsInput`, ohne Adresse von HAPM und SMTP-Passwort (siehe Kopf der Datei). */
export function readServiceSettingsInput(body: Record<string, unknown>): SettingsInput {
  if ('publicUrl' in body) {
    throw new ApiError(
      msg('Die Adresse von HAPM lässt sich über die API nicht ändern. Der Umzug steht in der Oberfläche unter Allgemein.')
    );
  }
  if ('smtpPass' in body) {
    throw new ApiError(msg('Das SMTP-Passwort lässt sich über die API nicht setzen. Es steht in der Oberfläche unter Benachrichtigungen.'));
  }
  // Wer den Server umstellt, bekommt die Mails: das gespeicherte Passwort bei
  // der nächsten Anmeldung dort, und den Link zum Zurücksetzen eines Passworts,
  // also ein Konto. Ein Key soll das nicht können.
  for (const field of ['smtpHost', 'smtpPort', 'smtpSecurity', 'smtpUser'] as const) {
    if (field in body) {
      throw new ApiError(
        msg('Der SMTP-Server lässt sich über die API nicht ändern ({field}). Er steht in der Oberfläche unter Benachrichtigungen.', { field })
      );
    }
  }
  return readSettingsInput(body);
}

/** Was sich geändert hat, als Text für das Protokoll. Das Passwort steht nie darin, auch nicht verschlüsselt. */
function describeChanges(before: Settings, after: Settings, fields: (keyof SettingsInput)[]): string[] {
  const changes: string[] = [];
  for (const field of fields) {
    const label = FIELD_LABELS[field];
    if (field === 'smtpPass') {
      if (before.smtpPass !== after.smtpPass) changes.push(`${label}: ${after.smtpPass ? 'neu gesetzt' : 'gelöscht'}`);
    } else if (field === 'notifyRecipients') {
      const was = before.notifyRecipients.join(', ');
      const now = after.notifyRecipients.join(', ');
      if (was !== now) changes.push(`${label}: ${was || 'keine'} → ${now || 'keine'}`);
    } else if (field === 'notifyEvents') {
      const toggled = NOTIFICATION_EVENT_TYPES.filter((type) => before.notifyEvents[type] !== after.notifyEvents[type]);
      if (toggled.length > 0) {
        changes.push(`${label}: ${toggled.map((type) => `${type} ${after.notifyEvents[type] ? 'an' : 'aus'}`).join(', ')}`);
      }
    } else if (before[field] !== after[field]) {
      changes.push(`${label}: ${String(before[field] ?? '')} → ${String(after[field] ?? '')}`);
    }
  }
  return changes;
}

export interface SettingsChangeResult {
  settings: SettingsView;
  /** Ob acme.sh die neue E-Mail angenommen hat. `null`: sie hat sich nicht geändert. */
  acme: { ok: boolean; detail: string } | null;
}

/** Speichern, acme.sh nachziehen, protokollieren. */
export async function changeSettings(input: SettingsInput, actor: SettingsActor): Promise<SettingsChangeResult> {
  const before = await getSettings();
  const after = await updateSettings(input);
  const changes = describeChanges(before, after, Object.keys(input) as (keyof SettingsInput)[]);
  // `updateSettings` hat sie gelöscht: an die alte Domain gebunden, melden sie niemanden mehr an.
  if (passkeysDroppedBy(before, after)) changes.push('alle Passkeys gelöscht');

  // acme.sh führt die Adresse selbst, im Konto bei der Zertifizierungsstelle. Dort muss sie ankommen.
  let acme: { ok: boolean; detail: string } | null = null;
  if (before.acmeEmail !== after.acmeEmail) {
    acme = await ensureAcme(after.acmeEmail).catch((err) => ({
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    }));
  }

  if (changes.length > 0) {
    await logAudit({
      ...actor,
      action: 'settings_updated',
      resource: 'settings',
      details: changes.join(', '),
    });
  }

  return { settings: settingsView(after), acme };
}

/**
 * Woher Zertifikate kommen und bei welchem ACME-Server beantragt wird.
 * `allowEab: false` lehnt einen EAB-Schlüssel ab (siehe Kopf der Datei).
 */
export async function changeCertificateSettings(
  body: Record<string, unknown>,
  actor: SettingsActor,
  options: { allowEab: boolean }
): Promise<{ settings: SettingsView; registered: boolean }> {
  if (!options.allowEab && (body.eabKeyId || body.eabHmacKey)) {
    throw new ApiError(
      msg('Ein Schlüssel für External Account Binding lässt sich über die API nicht setzen. Er steht in der Oberfläche unter Allgemein.')
    );
  }
  const input = readCertificateSettings(body);
  const result = await saveCertificateSettings(input);

  await logAudit({
    ...actor,
    action: 'settings_updated',
    resource: 'settings',
    details: result.audit,
  });

  return { settings: settingsView(result.settings), registered: result.registered };
}

/** Die Einstellungen ohne Geheimnisse, dazu der Stand des Mailversands. */
export async function settingsOverview() {
  const [settings, notifications] = await Promise.all([getSettings(), notificationStatus()]);
  return { settings: settingsView(settings), notifications };
}

const TEST_MAIL_LIMIT = 5;
const TEST_MAIL_WINDOW_MS = 10 * 60 * 1000;

/**
 * Eine Testmail über das gespeicherte SMTP-Konto. Lehnt der Server ab, ist das
 * kein Fehler: die Antwort trägt seine Meldung.
 *
 * `fallbackTo`: wohin ohne Angabe. In der Oberfläche die Adresse des
 * Angemeldeten; ein Token hat keine, dort ist `to` Pflicht.
 */
export async function sendTestMailAs(rawTo: unknown, actor: SettingsActor, fallbackTo: string | null) {
  if (rawTo !== undefined && rawTo !== null && typeof rawTo !== 'string') {
    throw new ApiError(msg('Die Adresse für die Testmail muss ein Text sein.'));
  }
  const to = (typeof rawTo === 'string' ? rawTo.trim() : '') || fallbackTo || '';
  if (!validateEmail(to)) throw new ApiError(msg('Die Adresse für die Testmail ist ungültig.'));

  if (!(await mailConfigured())) {
    throw new ApiError(msg('Es ist kein SMTP-Konto eingerichtet. Server und Absender zuerst speichern.'));
  }

  // Jede Testmail ist eine echte Mail an eine frei gewählte Adresse.
  const limit = rateLimit(`mail-test:${actor.userId}`, TEST_MAIL_LIMIT, TEST_MAIL_WINDOW_MS);
  if (!limit.success) {
    throw new ApiError(
      msg('Zu viele Testmails. Der nächste Versuch geht in {minutes} Minuten.', {
        minutes: Math.ceil((limit.retryAfter ?? 60) / 60),
      }),
      429
    );
  }

  const result = await sendTestMail(to);
  await logAudit({
    ...actor,
    action: result.sent ? 'mail_test_sent' : 'mail_test_failed',
    resource: 'settings',
    details: result.sent ? `Testmail an ${to}` : `Testmail an ${to}: ${result.error ?? ''}`,
  });
  return result;
}
