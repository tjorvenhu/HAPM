import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { getSettings, settingsView as view, updateSettings, type SettingsInput } from '@/lib/settings';
import { ensureAcme } from '@/lib/acme';
import {
  NOTIFICATION_EVENT_TYPES,
  type Exposure,
  type NotificationEventType,
  type Settings,
  type SmtpSecurity,
} from '@/lib/types';

export async function GET() {
  try {
    await requireSession();
    return ok(view(await getSettings()));
  } catch (err) {
    return handleError(err);
  }
}

const TEXT_FIELDS = ['acmeEmail', 'publicUrl', 'smtpHost', 'smtpUser', 'mailFrom'] as const;

const FIELD_LABELS: Record<keyof SettingsInput, string> = {
  acmeEmail: 'E-Mail für Let\'s Encrypt',
  publicUrl: 'Adresse von HAPM',
  autoUpdateHaproxy: 'Selbsttätiges Update von HAProxy',
  autoUpdateTime: 'Uhrzeit für selbsttätige Updates',
  smtpHost: 'SMTP-Server',
  smtpPort: 'SMTP-Port',
  smtpSecurity: 'SMTP-Verschlüsselung',
  smtpUser: 'SMTP-Benutzer',
  smtpPass: 'SMTP-Passwort',
  mailFrom: 'Absender',
  notifyRecipients: 'Empfänger',
  notifyEvents: 'Ereignisse',
  exposure: 'Art der Installation',
  setupStatus: 'Einrichtung',
};

/** Die Eingabe auf ihre Form prüfen. Was die Werte bedeuten dürfen, prüft `updateSettings`. */
function readInput(body: Record<string, unknown>): SettingsInput {
  const input: SettingsInput = {};

  for (const field of TEXT_FIELDS) {
    if (!(field in body)) continue;
    const value = body[field];
    if (value !== null && typeof value !== 'string') throw new ApiError(`${FIELD_LABELS[field]}: erwartet wird ein Text.`);
    input[field] = value;
  }
  if ('autoUpdateHaproxy' in body) {
    if (typeof body.autoUpdateHaproxy !== 'boolean') {
      throw new ApiError('Der Schalter für selbsttätige Updates kennt nur an und aus.');
    }
    input.autoUpdateHaproxy = body.autoUpdateHaproxy;
  }
  if ('autoUpdateTime' in body) {
    if (typeof body.autoUpdateTime !== 'string') throw new ApiError('Die Uhrzeit hat nicht die Form HH:MM.');
    input.autoUpdateTime = body.autoUpdateTime;
  }
  if ('smtpPort' in body) {
    if (typeof body.smtpPort !== 'number') throw new ApiError('Der SMTP-Port ist eine Zahl zwischen 1 und 65535.');
    input.smtpPort = body.smtpPort;
  }
  if ('smtpSecurity' in body) {
    if (typeof body.smtpSecurity !== 'string') throw new ApiError('Die Verschlüsselung ist STARTTLS, TLS oder keine.');
    input.smtpSecurity = body.smtpSecurity as SmtpSecurity;
  }
  // Leer heißt unverändert, `null` heißt löschen.
  if ('smtpPass' in body && body.smtpPass !== '') {
    if (body.smtpPass !== null && typeof body.smtpPass !== 'string') {
      throw new ApiError('Das SMTP-Passwort muss ein Text sein.');
    }
    input.smtpPass = body.smtpPass;
  }
  if ('notifyRecipients' in body) {
    if (!Array.isArray(body.notifyRecipients)) throw new ApiError('Die Empfänger sind eine Liste von Adressen.');
    input.notifyRecipients = body.notifyRecipients as string[];
  }
  if ('notifyEvents' in body) {
    const events = body.notifyEvents;
    if (typeof events !== 'object' || events === null || Array.isArray(events)) {
      throw new ApiError('Die Ereignisse sind Schalter je Ereignis.');
    }
    input.notifyEvents = events as Partial<Record<NotificationEventType, boolean>>;
  }

  // `setupStatus` gehört dem Assistenten (`/api/setup/status`) und wird hier nicht angenommen.
  if ('exposure' in body) {
    if (typeof body.exposure !== 'string') {
      throw new ApiError('Die Installation ist entweder intern oder aus dem Internet erreichbar.');
    }
    input.exposure = body.exposure as Exposure;
  }

  if (Object.keys(input).length === 0) throw new ApiError('Es wurde nichts zum Ändern übergeben.');
  return input;
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

export async function PATCH(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const input = readInput(await jsonBody(request));

    const before = await getSettings();
    const after = await updateSettings(input);
    const changes = describeChanges(before, after, Object.keys(input) as (keyof SettingsInput)[]);

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
        userId: session.userId,
        userEmail: session.email,
        action: 'settings_updated',
        resource: 'settings',
        details: changes.join(', '),
        ip: getClientIP(request),
      });
    }

    return ok({ settings: view(after), acme });
  } catch (err) {
    return handleError(err);
  }
}
