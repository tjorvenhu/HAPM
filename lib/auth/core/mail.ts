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
 */

/** An wen sich wendet, wer einer Nachricht nicht traut. */
const CONTACT = 'den Betreiber dieser Installation';

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
}

export interface MailContext {
  /** Anzeigename der Anwendung: "HAPM". Steht im Betreff und als Unterschrift. */
  appName: string;
  userName: string;
  url: string;
  /** Gültigkeitsdauer in Sekunden, wird als „eine Stunde" o. ä. ausformuliert. */
  expiresInSeconds: number;
}

function duration(seconds: number): string {
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return hours === 1 ? 'eine Stunde' : `${hours} Stunden`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? 'eine Minute' : `${minutes} Minuten`;
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
  parts: {
    subject: string;
    kind: MailKind;
    headline: string;
    paragraphs: string[];
    disclaimer: string;
    linkIntro: string;
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
    text: [
      `Hallo ${ctx.userName},`,
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
  return compose(ctx, {
    subject: `${ctx.appName}: neues Passwort festlegen`,
    kind: 'reset-password',
    headline: 'Neues Passwort festlegen',
    paragraphs: [
      `für Ihr Konto bei ${ctx.appName} wurde ein neues Passwort angefordert.`,
      `Der Link gilt ${duration(ctx.expiresInSeconds)} und lässt sich nur einmal verwenden.`,
    ],
    linkIntro: 'Über diesen Link können Sie eines festlegen:',
    disclaimer:
      'Waren Sie das nicht, können Sie diese Nachricht ignorieren. Ihr bisheriges ' +
      `Passwort bleibt dann unverändert gültig. Wenn Sie unsicher sind, wenden Sie sich an ${CONTACT}.`,
  });
}

export function verifyEmailMail(ctx: MailContext): MailContent {
  return compose(ctx, {
    subject: `${ctx.appName}: E-Mail-Adresse bestätigen`,
    kind: 'verify-email',
    headline: 'E-Mail-Adresse bestätigen',
    paragraphs: [`Der Link gilt ${duration(ctx.expiresInSeconds)}.`],
    linkIntro: `bitte bestätigen Sie diese Adresse für Ihr Konto bei ${ctx.appName}:`,
    disclaimer:
      'Haben Sie kein Konto angelegt, können Sie diese Nachricht ignorieren. ' +
      'Ohne Bestätigung passiert nichts weiter.',
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
  return compose(ctx, {
    subject: `${ctx.appName}: Änderung der E-Mail-Adresse bestätigen`,
    kind: 'change-email',
    headline: 'Änderung der E-Mail-Adresse',
    paragraphs: [
      `für Ihr Konto bei ${ctx.appName} wurde als neue E-Mail-Adresse ${ctx.newEmail} ` +
        'angefordert. Diese Nachricht geht bewusst an Ihre bisherige Adresse.',
      `Der Link gilt ${duration(ctx.expiresInSeconds)}.`,
    ],
    linkIntro: 'Bestätigen Sie die Änderung hier:',
    disclaimer:
      'Waren Sie das nicht, klicken Sie den Link NICHT an und wenden Sie sich umgehend an ' +
      `${CONTACT}. Ihr Konto bleibt bis dahin auf dieser Adresse.`,
  });
}
