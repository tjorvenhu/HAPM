/**
 * Die Darstellung für die Mails lesen (`knownMailBranding`).
 *
 * ── Das Logo hängt an, es wird nicht geladen ──
 *
 * Ein eigenes Logo geht wie das von HAPM als Anhang mit der Mail (`cid:`,
 * `lib/mail/index.ts`), nicht als Adresse auf `/api/branding/logo/light`:
 *
 *  - Ein Bild von einem Server lädt das Mailprogramm beim Öffnen und
 *    überträgt dabei die IP des Empfängers. Der Rahmen lädt deshalb nichts
 *    nach (`ui/mail/layout.ts`), und das soll für ein eigenes Logo genauso
 *    gelten.
 *  - Viele Programme zeigen Bilder von außen erst nach einem Klick. Ein Anhang
 *    steht sofort da.
 *  - Bei einer internen Installation erreicht ein Telefon unterwegs die
 *    Adresse von HAPM nicht, und ohne eingetragene Adresse gäbe es gar keine.
 *
 * Der Preis ist die Größe: das Logo (bis 256 KB) reist mit jeder Mail. Ein SVG
 * zeigen Gmail und das klassische Outlook in keinem der beiden Wege. Die
 * Seite „Darstellung“ rät deshalb zu einem PNG.
 *
 * ── Die Größe ──
 *
 * Das klassische Outlook zeigt ein Bild ohne `width` und `height` in seiner
 * natürlichen Größe. Gelesen wird sie aus dem Kopf der Datei
 * (`imageDimensions`), angezeigt wird das Logo 32 Pixel hoch und höchstens
 * 200 breit. Lässt sie sich nicht lesen, bleibt der Kopf von HAPM.
 */

import { loadBrandingImage, loadBrandingSafe } from '../branding/store';
import { base64ToBytes } from '../haproxy/page-design';
import { imageDimensions } from '../branding/branding';
import { rememberMailBranding, type MailBranding } from './installation';

const LOGO_HEIGHT = 32;
const LOGO_MAX_WIDTH = 200;

/** Die Anzeigegröße zu einer natürlichen Größe. */
export function mailLogoSize(natural: { width: number; height: number }): { width: number; height: number } {
  const ratio = natural.width / natural.height;
  const width = Math.round(LOGO_HEIGHT * ratio);
  if (width <= LOGO_MAX_WIDTH) return { width: Math.max(1, width), height: LOGO_HEIGHT };
  return { width: LOGO_MAX_WIDTH, height: Math.max(1, Math.round(LOGO_MAX_WIDTH / ratio)) };
}

export async function loadMailBranding(): Promise<MailBranding | null> {
  const branding = await loadBrandingSafe();
  let logo: MailBranding['logo'] = null;
  if (branding.images.logo) {
    const image = await loadBrandingImage('logo');
    const bytes = image ? base64ToBytes(image.data) : null;
    const natural = bytes && image ? imageDimensions(bytes, image.mime) : null;
    logo = natural ? mailLogoSize(natural) : null;
  }
  const result: MailBranding | null =
    branding.name || branding.accent || logo
      ? { name: branding.name, accent: branding.accent, logo, logoDark: !!logo && !!branding.images.logoDark }
      : null;
  rememberMailBranding(result);
  return result;
}
