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
 *
 * ── Welche Sprache ──
 *
 * Diese Mails gehen an genau ein Konto, und zwar an das, um das es geht. Hat
 * dessen Inhaber unter „Konto" eine Sprache gewählt (`user_state.locale`),
 * gilt sie. Sonst gilt die Einstellung „Sprache der Mails" wie für jede andere
 * Mail. Die Einstellung ist global, weil eine Benachrichtigung an mehrere
 * Empfänger geht; für eine Mail an eine Person gibt es diesen Grund nicht.
 */

import { sendMail } from '../mail';
import { currentInstallation, escapeHtml, mailNote, mailSmall, mailText, renderHapmMail } from '../mail/layout';
import { createTranslator, msgid, type Locale } from '../i18n';
import { getSettings } from '../settings';
import { mailInLocale, type MailContent } from './core/mail';

/** Was auf dem Knopf steht, je Anlass. */
const ACTION_LABELS: Record<MailContent['kind'], string> = {
  'reset-password': msgid('Passwort festlegen'),
  'verify-email': msgid('E-Mail-Adresse bestätigen'),
  'change-email': msgid('Änderung bestätigen'),
};

/**
 * Die Sprache einer Mail an `email`: die Wahl am Konto, sonst die Einstellung.
 * Scheitert nie: im Zweifel Deutsch, die Mail soll trotzdem rausgehen.
 *
 * `./users` über einen dynamischen Import: es erreicht `./config`, und
 * `./config` importiert diese Datei.
 */
export async function accountMailLocale(email: string): Promise<Locale> {
  let fallback: Locale = 'de';
  try {
    fallback = (await getSettings()).mailLocale;
    const { findUserByEmail, getUserLocale } = await import('./users');
    const user = await findUserByEmail(email);
    return (user ? await getUserLocale(user.$id) : null) ?? fallback;
  } catch (err) {
    console.error('[auth] Sprache für die Mail nicht ermittelt:', err instanceof Error ? err.message : err);
    return fallback;
  }
}

export function authMail(mail: MailContent, locale: Locale = mail.locale): { subject: string; html: string; text: string } {
  const content = mailInLocale(mail, locale);
  const { t } = createTranslator(locale);
  const rendered = renderHapmMail(
    {
      subject: content.subject,
      eyebrow: t('Konto'),
      heading: content.headline,
      body:
        mailText(escapeHtml(t('Hallo {name},', { name: content.userName }))) +
        content.paragraphs.map((paragraph) => mailText(escapeHtml(paragraph))).join(''),
      action: { label: t(ACTION_LABELS[content.kind]), url: content.url },
      /*
       * Die Adresse steht lesbar da, nicht nur hinter dem Knopf, und als Text
       * statt als zweiter Link: ein Link, dessen Ziel man nicht sieht, ist die
       * Form, in der Betrugsmails auftreten.
       */
      afterAction:
        mailSmall(
          `${escapeHtml(t('Falls der Knopf nicht funktioniert oder Sie das Ziel prüfen möchten:'))}<br>` +
            `<span style="word-break:break-all">${escapeHtml(content.url)}</span>`
        ) +
        mailSmall(
          escapeHtml(
            t('Waren Sie das nicht, können Sie diese Nachricht ignorieren. Ihr bisheriges Passwort bleibt dann unverändert gültig.')
          )
        ),
    },
    { ...currentInstallation(), locale }
  );
  return { subject: content.subject, ...rendered };
}

/** Der Haken `sendMail` des Anmeldedienstes. Wirft, wenn der Versand scheitert. */
export async function sendAuthMail(mail: MailContent & { to: string }): Promise<void> {
  await sendMail({ to: mail.to, ...authMail(mail, await accountMailLocale(mail.to)) });
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
  publicUrl: string | null,
  locale: Locale = 'de'
): { subject: string; html: string; text: string } {
  const { t } = createTranslator(locale);
  const added = mail.change === 'added';
  const subject = added ? t('Neuer Passkey an Ihrem Konto') : t('Passkey von Ihrem Konto entfernt');
  const greeting = mail.userName ? t('Hallo {name},', { name: mail.userName }) : t('Hallo,');
  const sentence = added
    ? t('an Ihrem Konto bei HAPM wurde ein Passkey hinterlegt: {name}. Damit ist die Anmeldung ohne Passwort und ohne Code möglich.', {
        name: `<strong>${escapeHtml(mail.passkeyName)}</strong>`,
      })
    : t('von Ihrem Konto bei HAPM wurde ein Passkey entfernt: {name}. Mit ihm ist keine Anmeldung mehr möglich.', {
        name: `<strong>${escapeHtml(mail.passkeyName)}</strong>`,
      });
  const advice = t(
    'Ändern Sie bitte sofort Ihr Passwort (auf der Anmeldeseite über „Passwort vergessen?“) und entfernen Sie unbekannte Passkeys unter „Konto“.'
  );

  const rendered = renderHapmMail(
    {
      subject,
      eyebrow: t('Konto'),
      heading: subject,
      body:
        mailText(escapeHtml(greeting)) +
        mailText(sentence) +
        mailNote(escapeHtml(advice), 'warning', t('Das waren nicht Sie?')),
      // Nach `/konto` und nicht zum Zurücksetzen: dort stehen die Passkeys, und
      // der unbekannte muss zuerst weg.
      action: publicUrl ? { label: t('Konto öffnen'), url: `${publicUrl}/konto` } : undefined,
    },
    { ...currentInstallation(), locale }
  );
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
    const locale = await accountMailLocale(change.to);
    await sendMail({ to: change.to, ...passkeyChangeMail(change, publicUrl, locale) });
  } catch (err) {
    console.error(
      `[auth] Mail über den ${change.change === 'added' ? 'neuen' : 'entfernten'} Passkey nicht verschickt:`,
      err instanceof Error ? err.message : err
    );
  }
}
