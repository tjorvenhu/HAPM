import { requireSession, requireCsrf } from '@/lib/session';
import { listAll, createDocument, Query } from '@/lib/db';
import { COLLECTIONS } from '@/lib/types';
import { validateName } from '@/lib/validation';
import { logAudit, getClientIP } from '@/lib/audit';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import {
  generateServiceToken,
  hashServiceToken,
  tokenPrefix,
} from '@/lib/service-auth';
import { normaliseAllowedIps, parseAllowedIps, serialiseAllowedIps } from '@/lib/ip-allow';
import type { ServiceToken } from '@/lib/types';

/**
 * Service-Token verwalten. Von einem angemeldeten Menschen, nicht von einem Dienst.
 *
 * Die Liste enthält nie einen Hash und nie einen Klartext — nur Name, Präfix
 * und Nutzungsspuren. Ein Hash in der Antwort wäre kein unmittelbares Leck,
 * aber er gehört auf keinen Bildschirm und in kein Browser-Log.
 */
export async function GET() {
  try {
    await requireSession();
    const tokens = await listAll<ServiceToken>(COLLECTIONS.SERVICE_TOKENS);

    const safe = tokens.map((t) => ({
      $id: t.$id,
      $createdAt: t.$createdAt,
      name: t.name,
      prefix: t.prefix,
      description: t.description,
      createdBy: t.createdBy,
      lastUsedAt: t.lastUsedAt,
      lastUsedIp: t.lastUsedIp,
      revokedAt: t.revokedAt,
      allowedIps: parseAllowedIps(t.allowedIps),
    }));

    safe.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return ok(safe);
  } catch (err) {
    return handleError(err);
  }
}

export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const { name, description, allowedIps } = await jsonBody<{
      name?: string;
      description?: string;
      /** Erlaubte Adressen und CIDR-Bereiche. Leer heißt: von überall. */
      allowedIps?: string[];
    }>(request);

    if (!name || !validateName(name)) throw new ApiError(msg('Ungültiger Name.'));

    // Wirft bei einem ungültigen Eintrag, statt ihn wegzulassen: eine
    // gespeicherte Liste ohne die Zeile, die jemand getippt hat, sähe enger aus
    // als sie ist. Siehe lib/ip-allow.ts.
    let cleanIps: string[];
    try {
      cleanIps = normaliseAllowedIps(allowedIps);
    } catch (err) {
      throw new ApiError(err instanceof Error ? err.message : msg('Ungültige Adressliste.'));
    }

    const active = await listAll<ServiceToken>(COLLECTIONS.SERVICE_TOKENS, [
      Query.equal('name', name),
      Query.isNull('revokedAt'),
    ]);
    if (active.length > 0) {
      throw new ApiError(
        msg(
          'Es gibt bereits ein aktives Token namens "{name}". Zwei gleichnamige wären im Audit-Log nicht auseinanderzuhalten.',
          { name }
        )
      );
    }

    const token = generateServiceToken();

    const created = await createDocument<ServiceToken>(COLLECTIONS.SERVICE_TOKENS, {
      name,
      tokenHash: hashServiceToken(token),
      prefix: tokenPrefix(token),
      description: description?.trim() || null,
      createdBy: session.email,
      lastUsedAt: null,
      lastUsedIp: null,
      revokedAt: null,
      // Ein Token gilt für die ganze Schnittstelle: Bereiche und Scopes vergibt
      // HAPM nicht. Die Felder stehen am Typ und bleiben leer.
      scopes: null,
      areas: null,
      allowedIps: cleanIps.length > 0 ? serialiseAllowedIps(cleanIps) : null,
    });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'service_token_created',
      resource: 'service_token',
      resourceId: created.$id,
      // Ohne den Klartext. Ein Audit-Log, in dem Zugangsdaten stehen, ist ein
      // zweiter Ort, an dem sie gestohlen werden können.
      details: `${name} (${created.prefix}…), Adressen: ${cleanIps.length > 0 ? cleanIps.join(', ') : 'alle'}`,
      ip: getClientIP(request),
    });

    // Das einzige Mal, dass der Klartext existiert. Danach ist nur noch der
    // Hash da, und der ist nicht rückrechenbar — verloren heißt neu ausstellen.
    return ok({ ...created, token, tokenHash: undefined });
  } catch (err) {
    return handleError(err);
  }
}
