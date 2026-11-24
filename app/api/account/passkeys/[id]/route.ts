import { headers } from 'next/headers';
import { requireCsrf, requireVerifiedSession } from '@/lib/session';
import { requirePasskeys, listOwnPasskeys } from '@/lib/auth/passkeys';
import { cleanPasskeyName } from '@/lib/auth/passkey-rules';
import { notifyPasskeyChange } from '@/lib/auth/mail';
import type { PasskeyApi } from '@/lib/auth/core';
import { logAudit, getClientIP } from '@/lib/audit';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';

/**
 * Ein Passkey des eigenen Kontos: umbenennen und entfernen.
 *
 * Gesucht wird in der Liste des eigenen Kontos, nicht in der Tabelle. Eine
 * fremde Kennung und eine, die es nicht gibt, bekommen damit dieselbe Antwort,
 * und der Anmeldedienst prüft den Eigentümer beim Schreiben noch einmal selbst.
 */

type Params = { params: Promise<{ id: string }> };

async function loadOwnPasskey(passkeys: PasskeyApi, requestHeaders: Headers, id: string) {
  const passkey = (await listOwnPasskeys(passkeys, requestHeaders)).find((p) => p.id === id);
  if (!passkey) throw new ApiError(msg('Diesen Passkey gibt es nicht mehr.'), 404);
  return passkey;
}

export async function PATCH(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireVerifiedSession();
    const passkeys = await requirePasskeys();
    const { id } = await params;
    const { name } = await jsonBody<{ name?: unknown }>(request);

    const requestHeaders = await headers();
    const passkey = await loadOwnPasskey(passkeys, requestHeaders, id);
    const label = cleanPasskeyName(typeof name === 'string' ? name : null);
    if (label === passkey.name) return ok();

    await passkeys.updatePasskey({ headers: requestHeaders, body: { id, name: label } });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'passkey_renamed',
      resource: 'passkey',
      resourceId: id,
      details: `Vorher: ${passkey.name}, jetzt: ${label}`,
      ip: getClientIP(request),
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  try {
    await requireCsrf(request);
    const session = await requireVerifiedSession();
    const passkeys = await requirePasskeys();
    const { id } = await params;

    const requestHeaders = await headers();
    const passkey = await loadOwnPasskey(passkeys, requestHeaders, id);

    await passkeys.deletePasskey({ headers: requestHeaders, body: { id } });

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'passkey_removed',
      resource: 'passkey',
      resourceId: id,
      details: `Name: ${passkey.name}`,
      ip: getClientIP(request),
    });

    // Wie beim Hinterlegen: wer das nicht selbst war, soll es erfahren. Das
    // Umbenennen darüber schickt nichts, es ändert keinen Zugang.
    void notifyPasskeyChange({
      to: session.email,
      userName: session.name,
      passkeyName: passkey.name,
      change: 'removed',
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}
