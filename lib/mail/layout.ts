/**
 * Der Rahmen aller Mails von HAPM.
 *
 * Aufbau, Bausteine und Farben stehen in `ui/mail/layout.ts` und werden dort
 * geändert. Hier steht, wer der Absender ist: diese Installation, mit dem Namen
 * ihres Servers und der Adresse ihrer Oberfläche. HAPM betreibt, wer es
 * installiert hat. Im Fuß stehen deshalb keine Firmenangaben, und eine Mail
 * endet ohne Grußformel.
 *
 * Rein: keine Datenbank, kein Versand. Eine neue Mail baut ihren Inhalt aus den
 * Bausteinen (`mailText`, `mailFacts`, `mailNote`), nie aus eigenem HTML.
 */

import {
  htmlToText,
  mailSenderLines,
  renderMailHtml,
  type MailAction,
  type MailSender,
} from '@/ui/mail/layout';
import { localServer } from '../helpers';
import { knownPublicUrl } from './installation';

export {
  MAIL_LOGO_CID,
  MAIL_LOGO_DARK_CID,
  escapeHtml,
  escapeMultiline,
  htmlToText,
  mailButtons,
  mailFacts,
  mailLink,
  mailNote,
  mailQuote,
  mailSmall,
  mailSteps,
  mailSubheading,
  mailText,
} from '@/ui/mail/layout';
export type { MailAction, MailFact, MailNoteTone } from '@/ui/mail/layout';

export const MAIL_PRODUCT = 'HAPM';

/**
 * Warum jemand eine Mail von HAPM bekommt. Es gibt genau zwei Wege: die Adresse
 * gehört zu einem Konto, oder jemand hat sie unter „Benachrichtigungen"
 * angegeben (als Empfänger oder für die Testmail). Der Satz steht im Fuß hinter
 * „Diese Mail kommt von der HAPM-Installation auf dem Server …" und bezieht
 * sich darauf.
 */
export const MAIL_REASON =
  'Sie bekommen sie, weil Ihre Adresse dort bei einem Konto oder als Empfänger von Benachrichtigungen angegeben ist.';

export interface HapmMailContent {
  subject: string;
  heading: string;
  /** HTML aus den Bausteinen des Rahmens. */
  body: string;
  /** Stichwort über der Überschrift, etwa „Zertifikate". */
  eyebrow?: string;
  /** Knopf nach dem Inhalt. Ohne `http(s)`-Adresse fällt er weg. */
  action?: MailAction;
  /** Kleingedrucktes nach dem Knopf, bereits maskiertes HTML. */
  afterAction?: string;
  /** Zeile über dem Absender im Fuß, bereits maskiertes HTML. */
  footerNote?: string;
}

/** Wer die Mail verschickt: der Server und, wenn eingerichtet, die Adresse der Oberfläche. */
export interface MailInstallation {
  nodeName: string;
  publicUrl: string | null;
}

export function currentInstallation(): MailInstallation {
  return { nodeName: localServer().name, publicUrl: knownPublicUrl() };
}

const isHttpUrl = (value: string) => /^https?:\/\//i.test(value);

/**
 * Eine Mail von HAPM: das HTML im Rahmen und eine Textfassung mit demselben
 * Inhalt.
 *
 * Ohne `installation` gilt der Server, auf dem HAPM läuft, und die zuletzt
 * gelesene Adresse der Oberfläche (`lib/mail/installation.ts`).
 */
export function renderHapmMail(
  content: HapmMailContent,
  installation: MailInstallation = currentInstallation()
): { html: string; text: string } {
  const action = content.action && isHttpUrl(content.action.url) ? content.action : undefined;
  const sender: MailSender = {
    name: MAIL_PRODUCT,
    nodeName: installation.nodeName,
    url: installation.publicUrl,
    reason: MAIL_REASON,
  };

  const html = renderMailHtml(
    {
      subject: content.subject,
      eyebrow: content.eyebrow,
      heading: content.heading,
      body: content.body,
      action,
      afterAction: content.afterAction,
      footerNote: content.footerNote,
    },
    sender
  );

  const { origin, reason, url } = mailSenderLines(sender);
  const text = [
    content.heading,
    htmlToText(content.body),
    action ? `${action.label}: ${action.url}` : '',
    content.afterAction ? htmlToText(content.afterAction) : '',
    content.footerNote ? htmlToText(content.footerNote) : '',
    [reason ? `${origin} ${reason}` : origin, url ? `Oberfläche: ${url}` : ''].filter(Boolean).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');

  return { html, text };
}
