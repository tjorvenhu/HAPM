/**
 * Das Aussehen, mit dem die Seiten von HAProxy entstehen: Design und
 * Darstellung zusammen, und wie viel vom Logo der Darstellung hineinpasst.
 *
 * ── Gemessen an den fertigen Seiten ──
 *
 * Ob ein Logo passt, hängt an den Texten, an der Sprache und daran, welche
 * Seiten überhaupt ausgeliefert werden (bei eigener HTML-Datei nur die
 * Passwortabfrage). Gemessen wird deshalb das Ergebnis: jede Seite, die
 * HAProxy bekäme, mit der jeweiligen Fassung. Die erste, bei der die größte
 * Seite unter `PAGE_MAX_BYTES` bleibt, gilt für alle Seiten: ein Logo auf der
 * 503 und ein Name auf der Passwortabfrage sähen nach zwei Absendern aus.
 *
 * Reihenfolge: helles und dunkles Logo, nur das helle, der Name als Text.
 *
 * ── Warum dieses Modul im Kreis importiert ──
 *
 * `error-pages.ts` und `lock-page.ts` fragen hier nach dem Aussehen, und hier
 * wird an ihren Seiten gemessen. Beide Richtungen sind Funktionen, die erst
 * beim Aufruf laufen, und keines der drei Module rechnet beim Laden etwas mit
 * dem anderen aus. Das muss so bleiben.
 *
 * Rein, wie `page-design.ts`.
 */

import type { StaticTheme } from '@/ui/static/page';
import { LOCK_PAGE_FILES } from './config';
import { errorFileWithTheme, errorPageStatuses } from './error-pages';
import { lockPageWithTheme, type LockPageKind } from './lock-page';
import { builtInDesign, PAGE_MAX_BYTES, type PageDesign } from './page-design';
import { brandedTheme, usesBrandLogo, type BrandLogoFit, type PageBrand } from './page-brand';

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** Die größte Seite, die HAProxy mit diesem Aussehen bekäme. */
function largestPage(stored: PageDesign, theme: StaticTheme): number {
  const sizes = (Object.keys(LOCK_PAGE_FILES) as LockPageKind[]).map((kind) =>
    bytes(lockPageWithTheme(kind, stored, theme))
  );
  if (stored.mode !== 'custom') {
    for (const status of errorPageStatuses()) sizes.push(bytes(errorFileWithTheme(status, stored, theme)));
  }
  return Math.max(...sizes);
}

/** Das Formular rechnet bei jedem Tastendruck: je Design und Darstellung nur einmal messen. */
const fits = new WeakMap<PageDesign, WeakMap<PageBrand, BrandLogoFit>>();

/** Wie viel vom Logo der Darstellung in die Seiten dieses Designs passt. */
export function brandLogoFit(stored: PageDesign, brand: PageBrand | null): BrandLogoFit {
  const built = builtInDesign(stored);
  if (!brand || !usesBrandLogo(built, brand)) return 'both';
  if (!brand.logo) return 'name';

  const known = fits.get(stored)?.get(brand);
  if (known) return known;

  const candidates: BrandLogoFit[] = brand.logoDark ? ['both', 'light'] : ['light'];
  const fit =
    candidates.find((candidate) => largestPage(stored, brandedTheme(built, brand, candidate)) <= PAGE_MAX_BYTES) ??
    'name';
  const byBrand = fits.get(stored) ?? new WeakMap<PageBrand, BrandLogoFit>();
  byBrand.set(brand, fit);
  fits.set(stored, byBrand);
  return fit;
}

/** Das Aussehen einer Seite im Aufbau von HAPM. */
export function pageTheme(stored: PageDesign, brand: PageBrand | null): StaticTheme {
  return brandedTheme(builtInDesign(stored), brand, brandLogoFit(stored, brand));
}
