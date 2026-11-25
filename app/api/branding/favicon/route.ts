import { loadBrandingImage, loadBrandingSafe } from '@/lib/branding/store';
import { faviconSvg, imageHash, faviconHref } from '@/lib/branding/branding';
import { imageResponse } from '@/lib/branding/response';

/**
 * Das Symbol im Browser-Tab, ohne Anmeldung. Ein hochgeladenes Symbol, sonst
 * ein erzeugtes in der Akzentfarbe (`faviconSvg`). Ohne beides 404: das Layout
 * verweist dann auf die Favicons in `public/` und fragt hier nicht nach.
 */
export async function GET(request: Request) {
  const branding = await loadBrandingSafe();
  if (!faviconHref(branding)) return new Response(null, { status: 404 });

  const meta = branding.images.icon;
  const icon = meta ? await loadBrandingImage('icon') : null;
  if (meta && icon) return imageResponse(request, icon.mime, Buffer.from(icon.data, 'base64'), meta.hash);

  const svg = faviconSvg(branding);
  return imageResponse(request, 'image/svg+xml', Buffer.from(svg, 'utf8'), imageHash(svg));
}
