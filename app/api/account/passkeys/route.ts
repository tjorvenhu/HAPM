import { headers } from 'next/headers';
import { requireCsrf, requireVerifiedSession } from '@/lib/session';
import {
  passkeyStatus,
  requirePasskeys,
  listOwnPasskeys,
  authErrorCode,
  isAuthRejection,
  isMissingUserVerification,
} from '@/lib/auth/passkeys';
import { cleanPasskeyName, MAX_PASSKEYS_PER_USER } from '@/lib/auth/passkey-rules';
import { notifyPasskeyChange } from '@/lib/auth/mail';
import { logAudit, getClientIP } from '@/lib/audit';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { msg } from '@/lib/i18n';
import { assertDataWritable } from '@/lib/sync/role';

/**
 * Die Passkeys des eigenen Kontos: auflisten und hinterlegen.
 *
 * Von hier gibt es keinen Weg zu den Passkeys eines anderen Kontos. Die Liste
 * hängt an der Sitzung, und jeder schreibende Aufruf geht über den
 * Anmeldedienst, der den Eigentümer selbst prüft (`lib/auth/passkeys.ts`).
 */

/**
 * Antwortet auch, wenn die Voraussetzungen fehlen: die Karte unter „Konto"
 * steht immer da und nennt dann, was einzurichten ist. Die Liste ist in dem
 * Fall leer, auch wenn noch Passkeys hinterlegt sind. Benutzbar sind sie nicht.
 */
export async function GET() {
  try {
    await requireVerifiedSession();
    const status = await passkeyStatus();
    if (!status.available) {
      return ok({ available: false, missing: status.missing, passkeys: [], max: MAX_PASSKEYS_PER_USER });
    }
    const passkeys = await requirePasskeys();
    return ok({
      available: true,
      missing: [],
      passkeys: await listOwnPasskeys(passkeys, await headers()),
      max: MAX_PASSKEYS_PER_USER,
    });
  } catch (err) {
    return handleError(err);
  }
}

/**
 * Schritt 2 beim Hinterlegen: die Antwort des Geräts prüfen und speichern.
 *
 * Die Aufgabe dazu kam aus `/api/account/passkeys/options`. Der Anmeldedienst
 * findet sie über das Cookie von dort, prüft, dass sie für dieses Konto gestellt
 * wurde, und verbraucht sie dabei.
 */
export async function POST(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireVerifiedSession();
    await assertDataWritable('accounts');
    const passkeys = await requirePasskeys();

    const { response: attestation, name } = await jsonBody<{ response?: unknown; name?: unknown }>(request);
    if (!attestation || typeof attestation !== 'object' || Array.isArray(attestation)) {
      throw new ApiError(msg('Die Antwort des Geräts war unvollständig.'));
    }
    const label = cleanPasskeyName(typeof name === 'string' ? name : null);
    const requestHeaders = await headers();

    // Noch einmal, nicht nur beim Stellen der Aufgabe: zwischen beiden Schritten
    // kann in einem anderen Fenster ein Passkey dazugekommen sein.
    const existing = await listOwnPasskeys(passkeys, requestHeaders);
    if (existing.length >= MAX_PASSKEYS_PER_USER) {
      throw new ApiError(
        msg('Mehr als {max} Passkeys je Konto sind nicht möglich. Bitte entfernen Sie zuerst einen.', {
          max: MAX_PASSKEYS_PER_USER,
        }),
        409
      );
    }

    const created = await passkeys
      .verifyPasskeyRegistration({
        body: { response: attestation, name: label },
        headers: requestHeaders,
      })
      .catch((err: unknown) => {
        if (isAuthRejection(err)) return { rejected: err };
        throw err;
      });

    if (!created || 'rejected' in created) {
      const rejected = created && 'rejected' in created ? created.rejected : null;
      if (rejected && isMissingUserVerification(rejected)) {
        throw new ApiError(
          msg('Dieses Gerät hat Sie nicht per Fingerabdruck, Gesicht oder PIN bestätigt. Ein solcher Passkey ersetzt keinen zweiten Faktor und wird nicht gespeichert.')
        );
      }
      if (authErrorCode(rejected) === 'SESSION_NOT_FRESH') {
        throw new ApiError(
          msg('Zu Ihrer Sicherheit melden Sie sich bitte einmal neu an. Danach können Sie den Passkey hinterlegen.'),
          403
        );
      }
      throw new ApiError(msg('Der Passkey konnte nicht hinterlegt werden. Bitte versuchen Sie es noch einmal.'));
    }

    await logAudit({
      userId: session.userId,
      userEmail: session.email,
      action: 'passkey_added',
      resource: 'passkey',
      resourceId: created.id,
      details: `Name: ${label}`,
      ip: getClientIP(request),
    });

    // Ohne `await`: der Passkey ist gespeichert, und ein Mailserver, der nicht
    // antwortet, soll die Antwort nicht aufhalten. Die Funktion wirft nie.
    void notifyPasskeyChange({
      to: session.email,
      userName: session.name,
      passkeyName: label,
      change: 'added',
    });

    return ok();
  } catch (err) {
    return handleError(err);
  }
}
