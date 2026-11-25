/**
 * Wo das eigene Aussehen liegt: Collection `branding`, eine Zeile `main` mit
 * den Einstellungen und je Bild eine eigene Zeile (`image-logo`,
 * `image-logoDark`, `image-icon`).
 *
 * Die Bilder stehen nicht in `main`, weil das Layout `main` bei jeder Seite
 * liest und ein Logo dort bis zu 256 KB mitschleppen würde. `main` kennt von
 * jedem Bild nur Art, Größe und Fingerabdruck.
 *
 * Kein Zwischenspeicher im Prozess: Layout, Routen und Seiten laufen in Next
 * in getrennten Modulgraphen, ein Speicher hier würde nach dem Speichern an
 * einer Stelle an der anderen weiter das Alte zeigen. Gelesen wird eine Zeile
 * über ihren Schlüssel.
 */

import { COLLECTIONS, deleteDocument, getDocument, getSingleton, updateDocument, createDocument } from '../db';
import {
  defaultBranding,
  imageMeta,
  normalizeBranding,
  toolName,
  type Branding,
  type BrandingImage,
  type BrandingImageSlot,
} from './branding';

const MAIN_ID = 'main';
const imageId = (slot: BrandingImageSlot) => `image-${slot}`;

export async function loadBranding(): Promise<Branding> {
  const row = await getSingleton<Branding>(COLLECTIONS.BRANDING, MAIN_ID, defaultBranding());
  return normalizeBranding(row);
}

/**
 * Für das Layout: scheitert nie. Ist die Datenbank nicht erreichbar, zeigt die
 * Seite das Aussehen von HAPM statt eines Fehlers. Liest, ohne anzulegen.
 */
export async function loadBrandingSafe(): Promise<Branding> {
  try {
    return normalizeBranding(await getDocument<Branding>(COLLECTIONS.BRANDING, MAIN_ID));
  } catch {
    return defaultBranding();
  }
}

export async function loadBrandingImage(slot: BrandingImageSlot): Promise<BrandingImage | null> {
  try {
    const row = await getDocument<BrandingImage>(COLLECTIONS.BRANDING, imageId(slot));
    return typeof row.data === 'string' && typeof row.mime === 'string' ? { mime: row.mime, data: row.data } : null;
  } catch {
    return null;
  }
}

/** Ein Bild: neu (`BrandingImage`), entfernt (`null`) oder unverändert (`undefined`). */
export type ImageChange = BrandingImage | null | undefined;

/**
 * Erwartet geprüfte Werte (`parsePill`, `parseName`, `parseAccent`,
 * `readBrandingImage`). Die Bilder zuerst: zeigt `main` auf ein Bild, gibt es
 * die Zeile dazu schon.
 */
export async function saveBranding(
  next: Pick<Branding, 'name' | 'pill' | 'accent'>,
  images: Partial<Record<BrandingImageSlot, ImageChange>>
): Promise<Branding> {
  const current = await loadBranding();
  const metas = { ...current.images };

  for (const [slot, change] of Object.entries(images) as [BrandingImageSlot, ImageChange][]) {
    if (change === undefined) continue;
    if (change === null) {
      delete metas[slot];
      continue;
    }
    const row = { mime: change.mime, data: change.data };
    const exists = await getDocument(COLLECTIONS.BRANDING, imageId(slot)).then(
      () => true,
      () => false
    );
    if (exists) await updateDocument<BrandingImage>(COLLECTIONS.BRANDING, imageId(slot), row);
    else await createDocument<BrandingImage>(COLLECTIONS.BRANDING, row, imageId(slot));
    metas[slot] = imageMeta(change);
  }

  const saved: Branding = { name: next.name, pill: next.pill, accent: next.accent, images: metas };
  // `updateDocument` mischt auf der obersten Ebene: jedes Feld steht hier, `images` ganz.
  await updateDocument<Branding>(COLLECTIONS.BRANDING, MAIN_ID, saved);

  // Erst wenn `main` nicht mehr darauf zeigt.
  for (const [slot, change] of Object.entries(images) as [BrandingImageSlot, ImageChange][]) {
    if (change === null) await deleteDocument(COLLECTIONS.BRANDING, imageId(slot)).catch(() => undefined);
  }
  return saved;
}

/** Der Name im Browser-Tab, für Seiten mit eigenem `generateMetadata`. */
export async function loadToolName(): Promise<string> {
  return toolName(await loadBrandingSafe());
}
