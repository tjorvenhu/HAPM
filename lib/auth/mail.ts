/**
 * Die Mails der Anmeldung: neues Passwort festlegen, Passkey hinterlegt oder
 * entfernt. Derselbe Rahmen und derselbe Versand wie jede andere Mail von HAPM
 * (`lib/mail`).
 *
 * ── Warum der Text nicht unverändert aus `./core/mail` kommt ──
 *
 * `./core/mail` liefert einen fertigen reinen Text samt Unterschrift. Die Mails
 * von HAPM tragen aber alle denselben Rahmen, und wer sie verschickt, steht
 * dort im Fuß. Aus `./core/mail` kommen deshalb die Bestandteile (Überschrift,
 * Absätze, Adresse). Der Hinweis für den Fall, dass es nicht der Empfänger
 * war, steht hier, und die Textfassung entsteht mit dem Rahmen.
 */

import { sendMail } from '../mail';
import { escapeHtml, mailNote, mailSmall, mailText, renderHapmMail } from '../mail/layout';
import { getSettings } from '../settings';
import type { MailContent } from './core';

/** Was auf dem Knopf steht, je Anlass. */
const ACTION_LABELS: Record<MailContent['kind'], string> = {
  'reset-password': 'Passwort festlegen',
  'verify-email': 'E-Mail-Adresse bestätigen',
  'change-email': 'Änderung bestätigen',
};

const IGNORE_HINT =
  'Waren Sie das nicht, können Sie diese Nachricht ignorieren. Ihr bisheriges Passwort bleibt dann unverändert gültig.';

export function authMail(mail: MailContent): { subject: string; html: string; text: string } {
  const rendered = renderHapmMail({
    subject: mail.subject,
    eyebrow: 'Konto',
    heading: mail.headline,
    body:
      mailText(escapeHtml(`Hallo ${mail.userName},`)) +
      mail.paragraphs.map((paragraph) => mailText(escapeHtml(paragraph))).join(''),
    action: { label: ACTION_LABELS[mail.kind], url: mail.url },
    /*
     * Die Adresse steht lesbar da, nicht nur hinter dem Knopf, und als Text
     * statt als zweiter Link: ein Link, dessen Ziel man nicht sieht, ist die
     * Form, in der Betrugsmails auftreten.
     */
    afterAction:
      mailSmall(
        'Falls der Knopf nicht funktioniert oder Sie das Ziel prüfen möchten:<br>' +
          `<span style="word-break:break-all">${escapeHtml(mail.url)}</span>`
      ) + mailSmall(escapeHtml(IGNORE_HINT)),
  });
  return { subject: mail.subject, ...rendered };
}

/** Der Haken `sendMail` des Anmeldedienstes. Wirft, wenn der Versand scheitert. */
export async function sendAuthMail(mail: MailContent & { to: string }): Promise<void> {
  await sendMail({ to: mail.to, ...authMail(mail) });
}

export interface PasskeyChange {
  to: string;
  userName: string;
  /** Der Name, den der Benutzer dem Passkey gegeben hat. */
  passkeyName: string;
  change: 'added' | 'removed';
}

export function passkeyChangeMail(
  mail: Omit<PasskeyChange, 'to'>,
  publicUrl: string | null
): { subject: string; html: string; text: string } {
  const added = mail.change === 'added';
  const subject = added ? 'Neuer Passkey an Ihrem Konto' : 'Passkey von Ihrem Konto entfernt';
  const greeting = mail.userName ? `Hallo ${mail.userName},` : 'Hallo,';
  const before = added
    ? 'an Ihrem Konto bei HAPM wurde ein Passkey hinterlegt:'
    : 'von Ihrem Konto bei HAPM wurde ein Passkey entfernt:';
  const after = added
    ? 'Damit ist die Anmeldung ohne Passwort und ohne Code möglich.'
    : 'Mit ihm ist keine Anmeldung mehr möglich.';
  const advice =
    'Ändern Sie bitte sofort Ihr Passwort (auf der Anmeldeseite über „Passwort vergessen?“) ' +
    'und entfernen Sie unbekannte Passkeys unter „Konto“.';

  const rendered = renderHapmMail({
    subject,
    eyebrow: 'Konto',
    heading: subject,
    body:
      mailText(escapeHtml(greeting)) +
      mailText(`${escapeHtml(before)} <strong>${escapeHtml(mail.passkeyName)}</strong>. ${escapeHtml(after)}`) +
      mailNote(escapeHtml(advice), 'warning', 'Das waren nicht Sie?'),
    // Nach `/konto` und nicht zum Zurücksetzen: dort stehen die Passkeys, und
    // der unbekannte muss zuerst weg.
    action: publicUrl ? { label: 'Konto öffnen', url: `${publicUrl}/konto` } : undefined,
  });
  return { subject, ...rendered };
}

/**
 * Dem Inhaber sagen, dass an seinem Konto ein Passkey dazukam oder wegfiel.
 *
 * Ein neuer Passkey ist ein neuer Weg ins Konto, an Passwort und Code vorbei.
 * War es nicht der Inhaber, soll er es erfahren, an die hinterlegte Adresse.
 *
 * Wirft nie: der Passkey ist zu diesem Zeitpunkt gespeichert oder entfernt, und
 * ein Mailserver, der nicht antwortet, ändert daran nichts. Der Fehlschlag
 * steht im Log.
 */
export async function notifyPasskeyChange(change: PasskeyChange): Promise<void> {
  try {
    const { publicUrl } = await getSettings();
    await sendMail({ to: change.to, ...passkeyChangeMail(change, publicUrl) });
  } catch (err) {
    console.error(
      `[auth] Mail über den ${change.change === 'added' ? 'neuen' : 'entfernten'} Passkey nicht verschickt:`,
      err instanceof Error ? err.message : err
    );
  }
}
