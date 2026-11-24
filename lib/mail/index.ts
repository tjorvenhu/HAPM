/**
 * Mailversand über das SMTP-Konto aus den Einstellungen.
 *
 * Die beiden Funktionen sind die Zusage an den Rest des Codes (Anmeldung,
 * Benachrichtigungen): `mailConfigured` sagt, ob ein SMTP-Konto eingerichtet
 * ist, `sendMail` verschickt oder wirft mit einem Satz, der so an der
 * Oberfläche stehen kann. Wie eine Mail aussieht, steht in `layout.ts`.
 */

import fs from 'node:fs';
import path from 'node:path';
import nodemailer from 'nodemailer';
import { decrypt } from '../crypto';
import { getSettings } from '../settings';
import { MAIL_LOGO_CID, MAIL_LOGO_DARK_CID } from './layout';
import { isMailConfigured, smtpConfig, smtpError, transportOptions } from './config';

export { MailError } from './config';

export interface OutgoingMail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function mailConfigured(): Promise<boolean> {
  return isMailConfigured(await getSettings());
}

interface Attachment {
  filename: string;
  content: Buffer;
  cid: string;
}

const LOGOS = [
  { filename: 'hapm-logo.png', cid: MAIL_LOGO_CID },
  { filename: 'hapm-logo-dark.png', cid: MAIL_LOGO_DARK_CID },
];

let logoCache: Attachment[] | null = null;

/**
 * Die beiden Logos als Anhang, auf die der Rahmen mit `cid:` verweist. PNG und
 * Anhang, weil Gmail und das klassische Outlook weder SVG noch data-URIs
 * zeigen. Fehlen die Dateien, geht die Mail ohne sie raus: eine Störungsmeldung
 * mit leerem Bildrahmen ist besser als keine.
 */
function logoAttachments(html: string): Attachment[] {
  if (!logoCache) {
    try {
      logoCache = LOGOS.map((logo) => ({
        ...logo,
        content: fs.readFileSync(path.resolve(process.cwd(), 'public', 'email', logo.filename)),
      }));
    } catch (err) {
      console.error('[mail] Logos unter public/email nicht lesbar:', err instanceof Error ? err.message : err);
      return [];
    }
  }
  return logoCache.filter((logo) => html.includes(`cid:${logo.cid}`));
}

/** Verschickt eine Mail. Wirft `MailError`, wenn nichts eingerichtet ist oder der Server ablehnt. */
export async function sendMail(mail: OutgoingMail): Promise<void> {
  const config = smtpConfig(await getSettings(), decrypt);
  const transport = nodemailer.createTransport(transportOptions(config));
  try {
    await transport.sendMail({
      from: config.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: logoAttachments(mail.html),
    });
  } catch (err) {
    throw smtpError(err, config);
  } finally {
    transport.close();
  }
}
