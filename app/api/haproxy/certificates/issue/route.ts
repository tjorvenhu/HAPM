import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { reissueCertificate } from '@/lib/haproxy/certificate-actions';

/**
 * Einen Antrag, den acme.sh führt, der aber nie durchgekommen ist, noch einmal
 * stellen. Warum es das gibt und wofür nicht: `reissueCertificate`.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ mainDomain?: unknown; dnsHook?: unknown }>(request);
    return ok(await reissueCertificate(body, { userId: session.userId, email: session.email, ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
