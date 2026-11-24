/**
 * Die Nachrichten, die Better-Auth verschickt.
 *
 * Zwei Regeln, beide keine Geschmacksfrage:
 *
 * **Die Adresse steht lesbar da.** Eine Nachricht mit einem Knopf, dessen Ziel
 * man nicht sieht, ist genau die Form, in der Betrugsmails auftreten. Ein
 * sichtbarer Link ist prüfbar — und wer gelernt hat, auf die Adresse zu
 * schauen, soll das auch bei diesen Mails können. Der Text hier ist deshalb
 * reiner Text, und die HTML-Fassung in `lib/auth/mail.ts` nennt die Adresse
 * noch einmal unter dem Knopf.
 *
 * **Der Text nennt die Gültigkeitsdauer und was zu tun ist, wenn es nicht der
 * Empfänger war.** Wer eine solche Mail bekommt, ohne sie angefordert zu
 * haben, hat genau eine Frage, und die soll dort beantwortet stehen statt in
 * einem Hilfeartikel.
 *
 * Unterschrieben wird mit dem Namen der Anwendung. HAPM betreibt, wer es
 * installiert hat: wer unsicher ist, wird an den Betreiber der Installation
 * verwiesen, nicht an eine Firma.
 *
 * Deutsch und Englisch (`MailContext.locale`, Vorgabe Deutsch). Better-Auth
 * ruft ohne Sprache auf; welche gilt, entscheidet der Versand
 * (`lib/auth/mail.ts`) und baut die Mail mit `mailInLocale` neu.
 */

import { createTranslator, DEFAULT_LOCALE, type Locale, type Translator } from '../../i18n';

export type MailKind = 'reset-password' | 'verify-email' | 'change-email';

export interface MailContent {
  subject: string;
  text: string;
  /**
   * Die Bestandteile, aus denen der Text gebaut wurde.
   *
   * Der fertige Text funktioniert allein. Die HTML-Fassung
   * (`lib/auth/mail.ts`) braucht aber die Teile und nicht die
   * Zeichenkette — die URL wieder aus dem Text zu fischen wäre ein regulärer
   * Ausdruck, der beim ersten geänderten Satz danebengreift.
   *
   * Für ein HTML-Layout gilt weiterhin: die Adresse muss LESBAR dastehen,
   * nicht nur hinter einem Knopf. Ein Link, dessen Ziel man nicht sieht, ist
   * die Form, in der Betrugsmails auftreten.
   */
  kind: MailKind;
  url: string;
  headline: string;
  /** Der Fließtext ohne Anrede, Link und Signatur. Absätze als Elemente. */
  paragraphs: string[];
  /** Was zu tun ist, wenn es nicht der Empfänger war. Eigener Absatz. */
  disclaimer: string;
  userName: string;
  expiresInSeconds: number;
  /** Damit sich dieselbe Mail in einer anderen Sprache neu bauen lässt (`mailInLocale`). */
  appName: string;
  locale: Locale;
  newEmail?: string;
}

export interface MailContext {
  /** Anzeigename der Anwendung: "HAPM". Steht im Betreff und als Unterschrift. */
  appName: string;
  userName: string;
  url: string;
  /** Gültigkeitsdauer in Sekunden, wird als „eine Stunde" o. ä. ausformuliert. */
  expiresInSeconds: number;
  /** Sprache der Mail. Vorgabe Deutsch. */
  locale?: Locale;
}

function duration(seconds: number, { plural }: Translator): string {
  if (seconds % 3600 === 0) return plural(seconds / 3600, { one: 'eine Stunde', other: '{count} Stunden' });
  return plural(Math.round(seconds / 60), { one: 'eine Minute', other: '{count} Minuten' });
}

/**
 * Der reine Text wird aus denselben Bestandteilen gebaut, die das Objekt
 * mitgibt.
 *
 * Nicht zwei Formulierungen nebeneinander: sonst weicht die HTML-Fassung
 * irgendwann vom Text ab, und welche der beiden gilt, entscheidet dann das
 * Mailprogramm des Empfängers.
 */
function compose(
  ctx: MailContext,
  translator: Translator,
  parts: {
    subject: string;
    kind: MailKind;
    headline: string;
    paragraphs: string[];
    disclaimer: string;
    linkIntro: string;
    newEmail?: string;
  }
): MailContent {
  return {
    subject: parts.subject,
    kind: parts.kind,
    url: ctx.url,
    headline: parts.headline,
    paragraphs: parts.paragraphs,
    disclaimer: parts.disclaimer,
    userName: ctx.userName,
    expiresInSeconds: ctx.expiresInSeconds,
    appName: ctx.appName,
    locale: translator.locale,
    ...(parts.newEmail === undefined ? {} : { newEmail: parts.newEmail }),
    text: [
      translator.t('Hallo {name},', { name: ctx.userName }),
      '',
      ...parts.paragraphs.flatMap((p) => [p, '']),
      parts.linkIntro,
      '',
      ctx.url,
      '',
      parts.disclaimer,
      '',
      ctx.appName,
    ].join('\n'),
  };
}

export function resetPasswordMail(ctx: MailContext): MailContent {
  const translator = createTranslator(ctx.locale ?? DEFAULT_LOCALE);
  const { t } = translator;
  const app = ctx.appName;
  return compose(ctx, translator, {
    subject: t('{app}: neues Passwort festlegen', { app }),
    kind: 'reset-password',
    headline: t('Neues Passwort festlegen'),
    paragraphs: [
      t('für Ihr Konto bei {app} wurde ein neues Passwort angefordert.', { app }),
      t('Der Link gilt {duration} und lässt sich nur einmal verwenden.', {
        duration: duration(ctx.expiresInSeconds, translator),
      }),
    ],
    linkIntro: t('Über diesen Link können Sie eines festlegen:'),
    disclaimer: t(
      'Waren Sie das nicht, können Sie diese Nachricht ignorieren. Ihr bisheriges Passwort bleibt dann unverändert gültig. Wenn Sie unsicher sind, wenden Sie sich an den Betreiber dieser Installation.'
    ),
  });
}

export function verifyEmailMail(ctx: MailContext): MailContent {
  const translator = createTranslator(ctx.locale ?? DEFAULT_LOCALE);
  const { t } = translator;
  const app = ctx.appName;
  return compose(ctx, translator, {
    subject: t('{app}: E-Mail-Adresse bestätigen', { app }),
    kind: 'verify-email',
    headline: t('E-Mail-Adresse bestätigen'),
    paragraphs: [t('Der Link gilt {duration}.', { duration: duration(ctx.expiresInSeconds, translator) })],
    linkIntro: t('bitte bestätigen Sie diese Adresse für Ihr Konto bei {app}:', { app }),
    disclaimer: t('Haben Sie kein Konto angelegt, können Sie diese Nachricht ignorieren. Ohne Bestätigung passiert nichts weiter.'),
  });
}

/**
 * Adressänderung — die Bestätigung geht an die **alte** Adresse.
 *
 * Andersherum wäre es wirkungslos: Wer ein Konto übernommen hat, trägt seine
 * eigene Adresse ein und bestätigt sich selbst. Die alte Adresse zu fragen ist
 * die einzige Prüfung, die der Angreifer nicht selbst beantworten kann.
 */
export function changeEmailMail(ctx: MailContext & { newEmail: string }): MailContent {
  const translator = createTranslator(ctx.locale ?? DEFAULT_LOCALE);
  const { t } = translator;
  const app = ctx.appName;
  return compose(ctx, translator, {
    subject: t('{app}: Änderung der E-Mail-Adresse bestätigen', { app }),
    kind: 'change-email',
    headline: t('Änderung der E-Mail-Adresse'),
    paragraphs: [
      t(
        'für Ihr Konto bei {app} wurde als neue E-Mail-Adresse {email} angefordert. Diese Nachricht geht bewusst an Ihre bisherige Adresse.',
        { app, email: ctx.newEmail }
      ),
      t('Der Link gilt {duration}.', { duration: duration(ctx.expiresInSeconds, translator) }),
    ],
    linkIntro: t('Bestätigen Sie die Änderung hier:'),
    disclaimer: t(
      'Waren Sie das nicht, klicken Sie den Link NICHT an und wenden Sie sich umgehend an den Betreiber dieser Installation. Ihr Konto bleibt bis dahin auf dieser Adresse.'
    ),
    newEmail: ctx.newEmail,
  });
}

/** Dieselbe Mail in einer anderen Sprache. Gleiche Sprache: unverändert. */
export function mailInLocale(mail: MailContent, locale: Locale): MailContent {
  if (mail.locale === locale) return mail;
  const ctx: MailContext = {
    appName: mail.appName,
    userName: mail.userName,
    url: mail.url,
    expiresInSeconds: mail.expiresInSeconds,
    locale,
  };
  switch (mail.kind) {
    case 'reset-password':
      return resetPasswordMail(ctx);
    case 'verify-email':
      return verifyEmailMail(ctx);
    case 'change-email':
      return changeEmailMail({ ...ctx, newEmail: mail.newEmail ?? '' });
  }
}
