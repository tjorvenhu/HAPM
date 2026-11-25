import { requireCsrf, requireSession } from '@/lib/session';
import { ok, handleError, jsonBody } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { checkAddressMove, readAddressMoveView, startAddressMove } from '@/lib/address-move';

/**
 * Der Umzug auf eine neue Adresse (Assistent unter „Allgemein").
 *
 * GET ohne Parameter: Stand und letzter Umzug, für das Pollen während des
 * Laufs. GET mit `?domain=`: die Prüfung der neuen Domain (DNS, Zone,
 * Zertifikat). POST startet den Umzug und antwortet, sobald er läuft.
 */
export async function GET(request: Request) {
  try {
    await requireSession();
    const domain = new URL(request.url).searchParams.get('domain');
    if (domain !== null) return ok(await checkAddressMove(domain));
    return ok(await readAddressMoveView());
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const body = await jsonBody<{ domain?: unknown; confirmed?: unknown }>(request);

    const ip = getClientIP(request);
    const view = await startAddressMove(String(body.domain ?? ''), body.confirmed === true, {
      userId: session.userId,
      email: session.email,
      ip,
    });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'address_move_started',
      resource: 'settings',
      details: `${view.move?.previousUrl ?? 'ohne Adresse'} → https://${view.move?.domain ?? ''}`,
      ip,
    });

    return ok(view);
  } catch (err) {
    return handleError(err);
  }
}
