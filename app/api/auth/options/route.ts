import { passkeyStatus } from '@/lib/auth/passkeys';
import { mailConfigured } from '@/lib/mail';
import { getSettings } from '@/lib/settings';
import { ok, handleError } from '@/lib/api';

export const dynamic = 'force-dynamic';

/**
 * Was die Anmeldeseite anbieten darf. Öffentlich und ohne Sitzung.
 *
 * Deshalb zwei Wahrheitswerte und sonst nichts: ob es Passkeys gibt und ob
 * „Passwort vergessen" per Mail geht. Keine Adresse, kein Mailserver, keine
 * Auskunft über Konten.
 */
export async function GET() {
  try {
    const [passkeys, settings, mail] = await Promise.all([passkeyStatus(), getSettings(), mailConfigured()]);
    return ok({ passkeys: passkeys.available, passwordReset: Boolean(settings.publicUrl) && mail });
  } catch (err) {
    return handleError(err);
  }
}
