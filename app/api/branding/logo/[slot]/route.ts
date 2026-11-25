import { loadBrandingImage, loadBrandingSafe } from '@/lib/branding/store';
import { imageResponse } from '@/lib/branding/response';

/**
 * Das eigene Logo, ohne Anmeldung: die Anmeldeseite zeigt es. Liefert nur das
 * Bild, sonst nichts. `light` ist das Logo für helle Flächen, `dark` die helle
 * Fassung für dunkle. Ohne eigenes Bild 404: die Seiten nehmen dann das Logo
 * von HAPM aus `public/`.
 */
const SLOTS = { light: 'logo', dark: 'logoDark' } as const;

export async function GET(request: Request, { params }: { params: Promise<{ slot: string }> }) {
  const { slot } = await params;
  const key = SLOTS[slot as keyof typeof SLOTS];
  if (!key) return new Response(null, { status: 404 });

  const [branding, image] = await Promise.all([loadBrandingSafe(), loadBrandingImage(key)]);
  const meta = branding.images[key];
  if (!image || !meta) return new Response(null, { status: 404 });
  return imageResponse(request, image.mime, Buffer.from(image.data, 'base64'), meta.hash);
}
