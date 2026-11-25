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
 *
 * Die Sprache gehört zur Installation (`MailInstallation.locale`): die
 * Einstellung „Sprache der Mails", gelesen von dem, der die Mail verschickt.
 * Ohne Angabe Deutsch.
 *
 * Ebenso die Darstellung (`MailInstallation.branding`): Name, Logo und
 * Akzentfarbe. Ohne sie ist jede Mail Byte für Byte die von HAPM.
 */

import { createTranslator, msgid, type Locale } from '../i18n';
import { accentTone, deriveAccent, readableOn } from '../branding/color';

import {
  htmlToText,
  mailSenderLines,
  renderMailHtml,
  type MailAccent,
  type MailAction,
  type MailBrand,
  type MailSender,
} from '@/ui/mail/layout';
import { localServer } from '../helpers';
import { knownMailBranding, knownPublicUrl, type MailBranding } from './installation';

export {
  MAIL_BRAND_LOGO_CID,
  MAIL_BRAND_LOGO_DARK_CID,
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
export const MAIL_REASON = msgid(
  'Sie bekommen sie, weil Ihre Adresse dort bei einem Konto oder als Empfänger von Benachrichtigungen angegeben ist.'
);

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
  /** Sprache der Mail. Vorgabe `de`. */
  locale?: Locale;
  /**
   * Name, Logo und Akzentfarbe aus der Darstellung. `undefined`: die zuletzt
   * gelesene (`knownMailBranding`), `null`: keine.
   */
  branding?: MailBranding | null;
}

export function currentInstallation(): MailInstallation {
  return { nodeName: localServer().name, publicUrl: knownPublicUrl() };
}

/**
 * Die Farben der Mail zu einer Akzentfarbe. Dieselbe Regel wie in der
 * Oberfläche (`deriveAccent`): reicht Weiß auf der Farbe nicht für 4,5:1, gilt
 * die hellste dunklere Fassung, die es schafft. Damit steht sie auch als Link
 * auf der weißen Karte mit 4,5:1. Die Flächen der Hinweise sind Töne derselben
 * Farbe, die Schrift darauf wird so weit abgedunkelt, bis sie wieder 4,5:1
 * erreicht. In dunklem Design steht der Akzent als heller Ton auf der Karte.
 */
export function mailAccent(chosen: string): MailAccent {
  const palette = deriveAccent(chosen);
  const tint = accentTone(palette.accent, 0.955, 0.03);
  return {
    accent: palette.accent,
    accentTint: tint,
    accentTintText: readableOn(palette.accent, tint),
    darkAccent: palette.hover,
    darkAccentText: accentTone(palette.accent, 0.86, 0.08),
    darkAccentTint: accentTone(palette.accent, 0.27, 0.05),
  };
}

/** Was der Rahmen aus der Darstellung bekommt, oder nichts. */
export function mailBrand(branding: MailBranding | null): MailBrand | undefined {
  if (!branding) return undefined;
  const brand: MailBrand = {
    ...(branding.name ? { name: branding.name } : {}),
    ...(branding.logo ? { logo: { ...branding.logo, dark: branding.logoDark } } : {}),
    ...(branding.accent ? { accent: mailAccent(branding.accent) } : {}),
  };
  return Object.keys(brand).length > 0 ? brand : undefined;
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
  const { t, locale } = createTranslator(installation.locale);
  const brand = mailBrand(installation.branding === undefined ? knownMailBranding() : installation.branding);
  const sender: MailSender = {
    name: MAIL_PRODUCT,
    nodeName: installation.nodeName,
    url: installation.publicUrl,
    reason: t(MAIL_REASON),
    locale,
    ...(brand ? { brand } : {}),
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
    [reason ? `${origin} ${reason}` : origin, url ? `${t('Oberfläche:')} ${url}` : ''].filter(Boolean).join('\n'),
  ]
    .filter(Boolean)
    .join('\n\n');

  return { html, text };
}
