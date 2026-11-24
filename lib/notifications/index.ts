/**
 * Die eine Stelle, die Ereignisse annimmt und daraus Mails macht.
 *
 * Wer etwas zu melden hat, ruft `notify(event)` und kümmert sich um nichts
 * weiter: ob das Ereignis eingeschaltet ist, ob es Empfänger und ein SMTP-Konto
 * gibt und ob dieselbe Sache gerade erst gemeldet wurde, entscheidet sich hier.
 *
 * `notify` wirft nie. Ein Update, das gelungen ist, darf nicht an einem
 * Mailserver scheitern, der gerade nicht antwortet. Ein Fehlschlag steht im
 * Protokoll des Containers und als „letzter Versand" auf der Seite
 * „Benachrichtigungen".
 *
 * Dieses Modul erreicht weder `lib/haproxy` noch `lib/docker`: `runner.ts` und
 * `apply.ts` importieren es, ein Rückweg wäre ein Kreis. Die Prüfungen, die
 * selbst nach Ausfällen sehen, stehen in `checks.ts`.
 */

import { getSettings, publicOrigin } from '../settings';
import { localServer } from '../helpers';
import { MailError, mailConfigured, sendMail } from '../mail';
import { isMailConfigured } from '../mail/config';
import type { NotificationDelivery, Settings } from '../types';
import {
  REPEAT_AFTER_MS,
  deliveryDecision,
  eventSubject,
  repeatAfterMs,
  type DeliveryDecision,
  type NotificationEvent,
} from './events';
import { notificationMail, testMail, type NotificationMail, type NotificationMailContext } from './mails';
import { lastDelivery, readState, recordDelivery, recordSent, type DeliveryData } from './state';

export type { NotificationEvent } from './events';

export type NotifyOutcome = Exclude<DeliveryDecision, 'send'> | 'sent' | 'failed';

/** Nach einem gescheiterten Versand ruht dieselbe Sache so lange, statt alle zwei Minuten zu scheitern. */
const RETRY_PAUSE_MS = 15 * 60 * 1000;

interface Memory {
  /** Läuft gerade, ist eben gescheitert oder wurde verschickt: Schlüssel → frühester nächster Versuch. */
  blockedUntil: Map<string, number>;
}

const globalMemory = globalThis as unknown as { __hapmNotify?: Memory };

function memory(): Memory {
  return (globalMemory.__hapmNotify ??= { blockedUntil: new Map() });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function mailContext(settings: Settings, now: Date): NotificationMailContext {
  return {
    nodeName: localServer().name,
    publicUrl: publicOrigin(settings),
    now,
    recoveryEnabled: settings.notifyEvents.backend_recovered,
    autoUpdateHaproxy: settings.autoUpdateHaproxy,
    autoUpdateTime: settings.autoUpdateTime,
  };
}

/**
 * Eine Mail an jeden Empfänger einzeln: so sieht keiner die Adressen der
 * anderen, und eine abgelehnte Adresse hält die übrigen nicht auf. Liegt es am
 * Konto oder an der Verbindung, endet die Runde beim ersten Fehler.
 */
async function deliver(mail: NotificationMail, recipients: string[]): Promise<{ delivered: number; error: string | null }> {
  let delivered = 0;
  let error: string | null = null;
  for (const to of recipients) {
    try {
      await sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text });
      delivered += 1;
    } catch (err) {
      error ??= recipients.length > 1 ? `${to}: ${message(err)}` : message(err);
      if (!(err instanceof MailError) || err.reason === 'unavailable') break;
    }
  }
  return { delivered, error };
}

async function remember(delivery: DeliveryData): Promise<void> {
  await recordDelivery(delivery).catch((err) =>
    console.error('[notify] Der letzte Versand ließ sich nicht festhalten:', message(err))
  );
}

async function dispatch(event: NotificationEvent): Promise<NotifyOutcome> {
  const settings = await getSettings();
  const subject = eventSubject(event);
  const key = `${event.type}\n${subject}`;
  const now = Date.now();

  const quick = deliveryDecision({
    enabled: settings.notifyEvents[event.type] !== false,
    recipients: settings.notifyRecipients.length,
    configured: isMailConfigured(settings),
    lastSentAt: null,
    now,
    repeatAfterMs: repeatAfterMs(event.type),
  });
  if (quick !== 'send') return quick;

  const blocked = memory().blockedUntil;
  for (const [entry, until] of blocked) if (until <= now) blocked.delete(entry);
  if (blocked.has(key)) return 'dampened';
  // Vor dem ersten `await` nach der Prüfung: zwei gleichzeitige Meldungen derselben Sache ergeben eine Mail.
  blocked.set(key, now + RETRY_PAUSE_MS);

  try {
    const state = await readState(event.type, subject);
    const decision = deliveryDecision({
      enabled: true,
      recipients: settings.notifyRecipients.length,
      configured: true,
      lastSentAt: state?.lastSentAt ?? null,
      now,
      repeatAfterMs: repeatAfterMs(event.type),
    });
    if (decision !== 'send') {
      blocked.delete(key);
      return decision;
    }

    const at = new Date(now);
    const mail = notificationMail(event, mailContext(settings, at));
    const result = await deliver(mail, settings.notifyRecipients);

    await remember({
      at: at.toISOString(),
      ok: result.delivered === settings.notifyRecipients.length,
      kind: event.type,
      mailSubject: mail.subject,
      delivered: result.delivered,
      recipients: settings.notifyRecipients.length,
      error: result.error,
    });

    if (result.delivered === 0) {
      console.error(`[notify] ${event.type} (${subject}) nicht verschickt: ${result.error}`);
      return 'failed';
    }
    if (result.error) console.error(`[notify] ${event.type} (${subject}) nicht an alle verschickt: ${result.error}`);

    // Die Sperre im Prozess gilt auch dann, wenn das Festhalten scheitert: keine zweite Mail zwei Minuten später.
    blocked.set(key, now + REPEAT_AFTER_MS);
    await recordSent(event.type, subject, at.toISOString()).catch((err) =>
      console.error(`[notify] ${event.type} (${subject}) verschickt, aber nicht festgehalten: ${message(err)}`)
    );
    return 'sent';
  } catch (err) {
    console.error(`[notify] ${event.type} (${subject}) gescheitert: ${message(err)}`);
    return 'failed';
  }
}

/** Ein Ereignis melden. Wirft nie, das Ergebnis sagt, was daraus wurde. */
export async function notify(event: NotificationEvent): Promise<NotifyOutcome> {
  try {
    return await dispatch(event);
  } catch (err) {
    console.error(`[notify] ${event.type} gescheitert: ${message(err)}`);
    return 'failed';
  }
}

export interface TestMailResult {
  sent: boolean;
  to: string;
  /** Die Meldung des Mailservers, wenn er abgelehnt hat. */
  error: string | null;
}

/** Die Testmail. Wirft nicht: das Ergebnis samt Fehlermeldung ist die Antwort. */
export async function sendTestMail(to: string): Promise<TestMailResult> {
  const settings = await getSettings();
  const mail = testMail({ nodeName: localServer().name, publicUrl: publicOrigin(settings) });
  let error: string | null = null;
  try {
    await sendMail({ to, subject: mail.subject, html: mail.html, text: mail.text });
  } catch (err) {
    error = message(err);
  }
  await remember({
    at: new Date().toISOString(),
    ok: error === null,
    kind: 'test',
    mailSubject: mail.subject,
    delivered: error === null ? 1 : 0,
    recipients: 1,
    error,
  });
  return { sent: error === null, to, error };
}

export interface NotificationStatus {
  mailConfigured: boolean;
  recipients: number;
  /** `null` heißt: es wurde noch nie etwas verschickt, oder der Stand war nicht zu lesen. */
  lastDelivery: Omit<NotificationDelivery, '$id' | '$createdAt' | '$updatedAt'> | null;
}

export async function notificationStatus(): Promise<NotificationStatus> {
  const [configured, settings, last] = await Promise.all([
    mailConfigured(),
    getSettings(),
    lastDelivery().catch(() => null),
  ]);
  return {
    mailConfigured: configured,
    recipients: settings.notifyRecipients.length,
    lastDelivery: last
      ? {
          at: last.at,
          ok: last.ok,
          kind: last.kind,
          mailSubject: last.mailSubject,
          delivered: last.delivered,
          recipients: last.recipients,
          error: last.error,
        }
      : null,
  };
}
