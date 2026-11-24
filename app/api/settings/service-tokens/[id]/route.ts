import { requireSession, requireCsrf } from '@/lib/session';
import { getDocument, updateDocument } from '@/lib/db';
import { COLLECTIONS } from '@/lib/types';
import { logAudit, getClientIP } from '@/lib/audit';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { normaliseAllowedIps, serialiseAllowedIps } from '@/lib/ip-allow';
import type { ServiceToken } from '@/lib/types';

/**
 * Ein Token zurückziehen.
 *
 * DELETE als Methode, aber die Zeile bleibt stehen und bekommt `revokedAt`.
 * Der Grund steht in `lib/audit.ts`: ein Audit-Eintrag trägt den Namen des
 * Dienstes, und der ist nur auflösbar, solange die Zeile existiert. Ein
 * gelöschtes Token macht aus „deploy-skript hat diese Domain angelegt"
 * nachträglich ein „service:68a3f1c2 hat …".
 */
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;

    const token = await getDocument<ServiceToken>(COLLECTIONS.SERVICE_TOKENS, id);
    if (token.revokedAt) throw new ApiError(msg('Token ist bereits zurückgezogen.'));

    await updateDocument<ServiceToken>(COLLECTIONS.SERVICE_TOKENS, id, {
      revokedAt: new Date().toISOString(),
    });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'service_token_revoked',
      resource: 'service_token',
      resourceId: id,
      details: `${token.name} (${token.prefix}…)`,
      ip: getClientIP(request),
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Die Adressliste eines bestehenden Tokens ändern.
 *
 * Name und Beschreibung nicht, und den Klartext schon gar nicht (den gibt es
 * nicht mehr). Der Grund für eine eigene Methode statt „neu ausstellen": ein
 * Zugriff, den man ausweiten oder zurücknehmen will, soll nicht bedeuten, dass
 * in jeder Pipeline ein neues Token eingetragen werden muss. Zurücknehmen ist
 * dabei der wichtigere Fall, und der muss ohne Umweg gehen.
 *
 * **Ein Teil-Patch: angefasst wird nur, was im Rumpf steht.** Änderbar ist nur
 * die Adressliste. Ein Rumpf ohne `allowedIps` ändert nichts und wird abgelehnt.
 *
 * Ein zurückgezogenes Token bekommt keine neuen Rechte: `revokedAt` ist
 * endgültig, und ein Recht auf einer toten Zeile zu ändern sähe nach Wirkung
 * aus, wo keine ist.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { id } = await params;

    const token = await getDocument<ServiceToken>(COLLECTIONS.SERVICE_TOKENS, id);
    if (token.revokedAt) throw new ApiError(msg('Ein zurückgezogenes Token lässt sich nicht ändern.'));

    const body = await jsonBody<{ allowedIps?: string[] }>(request);

    const changes: Partial<ServiceToken> = {};
    const notes: string[] = [];

    if (body.allowedIps !== undefined) {
      let clean: string[];
      try {
        clean = normaliseAllowedIps(body.allowedIps);
      } catch (err) {
        throw new ApiError(err instanceof Error ? err.message : msg('Ungültige Adressliste.'));
      }
      changes.allowedIps = clean.length > 0 ? serialiseAllowedIps(clean) : null;
      notes.push(`Adressen: ${clean.length > 0 ? clean.join(', ') : 'alle'}`);
    }

    if (notes.length === 0) throw new ApiError(msg('Es wurde nichts zum Ändern angegeben.'));

    await updateDocument<ServiceToken>(COLLECTIONS.SERVICE_TOKENS, id, changes);

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'service_token_changed',
      resource: 'service_token',
      resourceId: id,
      details: `${token.name} (${token.prefix}…), ${notes.join(', ')}`,
      ip: getClientIP(request),
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}
