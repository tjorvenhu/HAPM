import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getT } from '@/lib/i18n/server';
import { getClientIP } from '@/lib/audit';
import {
  listCertificateAuthorities,
  removeCertificateAuthority,
  saveCertificateAuthority,
} from '@/lib/haproxy/ca-actions';

/**
 * Die hinterlegten Zertifizierungsstellen: womit HAProxy das Zertifikat eines
 * Ziels prüft, das aus einer eigenen CA kommt (`lib/haproxy/backend-ca.ts`).
 *
 * Wie bei den Zertifikaten steht keine Collection dahinter, der Ordner
 * `/etc/haproxy/hapm-ca` ist die Wahrheit. Die Logik samt Protokoll steht in
 * `lib/haproxy/ca-actions.ts`, dieselbe für die interne API und MCP.
 */
export async function GET() {
  try {
    await requireSession();
    const { t } = await getT();
    return ok(await listCertificateAuthorities(t));
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Eine Zertifizierungsstelle hinterlegen oder die Datei einer hinterlegten
 * austauschen (`replace: true`). Synchron: neu geladen wird nur, wenn ein Ziel
 * die Datei schon benutzt.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { t } = await getT();
    const body = await jsonBody<{ name?: unknown; certificate?: unknown; replace?: unknown }>(request);
    return ok(
      await saveCertificateAuthority(body, { userId: session.userId, userEmail: session.email, ip: getClientIP(request) }, t)
    );
  } catch (err) {
    return handleError(err);
  }
}

/** Eine Zertifizierungsstelle entfernen: `?name=`. Nur, solange kein Ziel sie benutzt. */
export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    return ok(
      await removeCertificateAuthority(new URL(request.url).searchParams.get('name'), {
        userId: session.userId,
        userEmail: session.email,
        ip: getClientIP(request),
      })
    );
  } catch (err) {
    return handleError(err);
  }
}
