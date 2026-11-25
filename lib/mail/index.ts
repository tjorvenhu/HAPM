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
import { MAIL_BRAND_LOGO_CID, MAIL_BRAND_LOGO_DARK_CID, MAIL_LOGO_CID, MAIL_LOGO_DARK_CID } from './layout';
import { isMailConfigured, smtpConfig, smtpError, transportOptions } from './config';
import { knownMailBranding } from './installation';
import { loadBrandingImage } from '../branding/store';
import type { BrandingImageSlot } from '../branding/branding';

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
  contentType?: string;
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

const BRAND_LOGOS: { slot: BrandingImageSlot; cid: string; name: string }[] = [
  { slot: 'logo', cid: MAIL_BRAND_LOGO_CID, name: 'logo' },
  { slot: 'logoDark', cid: MAIL_BRAND_LOGO_DARK_CID, name: 'logo-dark' },
];

const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/webp': 'webp', 'image/svg+xml': 'svg' };

/**
 * Das eigene Logo aus der Darstellung als Anhang, wenn der Rahmen darauf
 * verweist (`lib/mail/branding.ts`: warum Anhang und nicht Adresse). Gelesen
 * bei jedem Versand aus der Datenbank: ein Speicher im Prozess zeigte nach dem
 * Ändern das alte. Fehlt das Bild, geht die Mail ohne es raus.
 */
async function brandLogoAttachments(html: string): Promise<Attachment[]> {
  const out: Attachment[] = [];
  for (const logo of BRAND_LOGOS) {
    if (!html.includes(`cid:${logo.cid}`)) continue;
    const image = await loadBrandingImage(logo.slot);
    if (!image) continue;
    out.push({
      filename: `${logo.name}.${EXTENSIONS[image.mime] ?? 'img'}`,
      content: Buffer.from(image.data, 'base64'),
      cid: logo.cid,
      contentType: image.mime,
    });
  }
  return out;
}

/** Verschickt eine Mail. Wirft `MailError`, wenn nichts eingerichtet ist oder der Server ablehnt. */
export async function sendMail(mail: OutgoingMail): Promise<void> {
  // Ohne eigenen Namen im Absender steht dort der Name aus der Darstellung.
  const config = smtpConfig(await getSettings(), decrypt, knownMailBranding()?.name);
  const transport = nodemailer.createTransport(transportOptions(config));
  try {
    await transport.sendMail({
      from: config.from,
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
      attachments: [...logoAttachments(mail.html), ...(await brandLogoAttachments(mail.html))],
    });
  } catch (err) {
    throw smtpError(err, config);
  } finally {
    transport.close();
  }
}
