import { requireCsrf, requireSession } from '@/lib/session';
import { setUserLocale } from '@/lib/auth/users';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { isLocale, msg } from '@/lib/i18n';
import { setLocaleCookie } from '@/lib/i18n/server';

/**
 * Die Sprache der Oberfläche für das eigene Konto. Gespeichert am Konto
 * (`user_state`) und gespiegelt ins Cookie `hapm-lang`, damit das erste HTML
 * jeder Seite sie schon kennt.
 *
 * Ohne Eintrag im Protokoll: eine Vorliebe der Anzeige ändert keinen Zugang.
 */
export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const { locale } = await jsonBody<{ locale?: unknown }>(request);
    if (!isLocale(locale)) throw new ApiError(msg('Diese Sprache gibt es nicht.'));

    await setUserLocale(session.userId, locale);

    const response = ok({ locale });
    setLocaleCookie(response, locale);
    return response;
  } catch (err) {
    return handleError(err);
  }
}
