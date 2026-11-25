import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { getClientIP } from '@/lib/audit';
import { haproxyContainer, restartHaproxy } from '@/lib/system/haproxy-container';

/** Der Container von HAProxy, mit `?logs=1` samt seiner letzten Ausgabe. */
export async function GET(request: Request) {
  try {
    await requireSession();
    const wantsLogs = new URL(request.url).searchParams.get('logs') === '1';
    return ok(await haproxyContainer({ logs: wantsLogs }));
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ action?: string }>(request);
    if (body.action !== 'restart') throw new ApiError(msg('Unbekannte Aktion.'));
    return ok(await restartHaproxy({ userId: session.userId, userEmail: session.email, ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
