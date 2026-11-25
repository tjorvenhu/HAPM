import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { getClientIP } from '@/lib/audit';
import { getSettings, settingsView as view } from '@/lib/settings';
import { changeSettings, readSettingsInput } from '@/lib/settings-actions';

export async function GET() {
  try {
    await requireSession();
    return ok(view(await getSettings()));
  } catch (err) {
    return handleError(err);
  }
}

/** Prüfung, Protokoll und Nachlauf bei acme.sh stehen in `lib/settings-actions.ts`. */
export async function PATCH(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const input = readSettingsInput(await jsonBody(request));
    return ok(await changeSettings(input, { userId: session.userId, userEmail: session.email, ip: getClientIP(request) }));
  } catch (err) {
    return handleError(err);
  }
}
