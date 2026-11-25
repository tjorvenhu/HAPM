import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { getLocale } from '@/lib/i18n/server';
import { msg } from '@/lib/i18n';
import { loadBranding, saveBranding } from '@/lib/branding/store';
import {
  BRANDING_IMAGE_MAX_BYTES,
  BRANDING_IMAGE_SLOTS,
  BRANDING_IMAGE_TYPES,
  imageUrl,
  parseBrandingInput,
  type Branding,
  type BrandingView,
} from '@/lib/branding/branding';

/**
 * Das eigene Aussehen der Oberfläche: lesen und speichern. Die Bilder liefern
 * `logo/[slot]` und `favicon` aus, ohne Anmeldung.
 *
 * `PATCH` nimmt den ganzen Stand der Karte: Name, Pille, Farbe und je Bild
 * neu, entfernt oder nichts. Zurücksetzen ist dasselbe mit den Vorgaben.
 */

/** Drei Bilder an der Grenze, als Base64 in JSON, und Luft für den Rest. */
const MAX_BODY_BYTES = Math.ceil((BRANDING_IMAGE_MAX_BYTES * BRANDING_IMAGE_SLOTS.length * 4) / 3) + 16 * 1024;

function view(branding: Branding): BrandingView {
  const images = Object.fromEntries(
    BRANDING_IMAGE_SLOTS.map((slot) => {
      const meta = branding.images[slot];
      const url = imageUrl(slot, meta);
      return [slot, meta && url ? { url, mime: meta.mime, bytes: meta.bytes } : null];
    })
  ) as BrandingView['images'];
  return { name: branding.name, pill: branding.pill, accent: branding.accent, images };
}

/** Was sich geändert hat, für das Protokoll. Bilder nur mit Art und Größe. */
function describeChanges(before: Branding, after: Branding): string[] {
  const changes: string[] = [];
  if (before.name !== after.name) changes.push(`Name: ${before.name ?? 'HAPM'} → ${after.name ?? 'HAPM'}`);
  if (before.accent !== after.accent) {
    changes.push(`Akzentfarbe: ${before.accent ?? 'HAPM'} → ${after.accent ?? 'HAPM'}`);
  }
  if (before.pill.text !== after.pill.text || before.pill.enabled !== after.pill.enabled) {
    changes.push(`Pille: ${after.pill.enabled ? `„${after.pill.text}“` : 'aus'}`);
  }
  for (const slot of BRANDING_IMAGE_SLOTS) {
    const was = before.images[slot];
    const now = after.images[slot];
    if (was?.hash === now?.hash) continue;
    changes.push(
      now ? `Bild ${slot}: ${BRANDING_IMAGE_TYPES[now.mime] ?? now.mime}, ${now.bytes} Bytes` : `Bild ${slot}: entfernt`
    );
  }
  return changes;
}

export async function GET() {
  try {
    await requireSession();
    return ok(view(await loadBranding()));
  } catch (err) {
    return handleError(err);
  }
}

export async function PATCH(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const locale = await getLocale();

    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
      throw new ApiError(msg('Die Eingabe ist zu groß.'), 413);
    }
    const parsed = parseBrandingInput(await jsonBody(request), locale);
    if ('error' in parsed) throw new ApiError(parsed.error);

    const before = await loadBranding();
    const { images, ...rest } = parsed.value;
    const after = await saveBranding(rest, images);

    const changes = describeChanges(before, after);
    if (changes.length > 0) {
      await logAudit({
        userId: session.userId,
        userEmail: session.email,
        action: 'branding_updated',
        resource: 'branding',
        details: changes.join(', '),
        ip: getClientIP(request),
      });
    }
    return ok(view(after));
  } catch (err) {
    return handleError(err);
  }
}
