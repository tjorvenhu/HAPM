import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { getProxyServer, type ProvisionStep } from '@/lib/haproxy/provision';
import { applyPageDesign } from '@/lib/haproxy/page-design-apply';
import { loadPageBrand, loadPageDesign, savePageDesign } from '@/lib/haproxy/page-design-store';
import { activeBrand } from '@/lib/haproxy/page-brand';
import {
  defaultPageDesign,
  isDefaultDesign,
  parsePageDesign,
  requestTooLargeMessage,
  LOGO_TYPES,
  type PageDesign,
} from '@/lib/haproxy/page-design';
import { designSizeError } from '@/lib/haproxy/design-pages';
import type { ErrorPageEntry } from '@/lib/haproxy/error-pages';
import { LOCAL_SERVER_ID } from '@/lib/helpers';
import { msgid, type Locale } from '@/lib/i18n';
import { getLocale } from '@/lib/i18n/server';
import type { Server } from '@/lib/types';

/**
 * Das Design der Fehlerseiten und der Passwortabfrage: lesen, speichern,
 * zurücksetzen.
 *
 * ── Speichern heißt ausliefern ──
 *
 * Ein gespeichertes Design, das HAProxy noch nicht zeigt, wäre ein Zustand, den
 * man erklären müsste. `PUT` und `DELETE` schreiben deshalb die Zeile und
 * bringen danach die Dateien auf ihren Stand (`applyPageDesign`).
 *
 * Scheitert das Ausliefern, bleibt das Design gespeichert, und die Antwort
 * nennt den Schritt: die Dateien stehen wieder wie vorher, gelten auf der Seite
 * als „Andere Seite", und der Knopf dort versucht es erneut. Das Design deshalb
 * zu verwerfen hieße, eine Eingabe wegzuwerfen, an der es nicht lag.
 *
 * Geprüft wird vorher und vollständig, auch die Größe jeder fertigen Seite:
 * eine zu große Passwortabfrage nimmt `haproxy -c` an und beantwortet HAProxy
 * danach mit 500 (`lib/haproxy/page-design.ts`). Für eigenes HTML und CSS
 * dieselben zwei Funktionen wie im Formular (`parsePageDesign`,
 * `designSizeError`), also dieselben Meldungen.
 *
 * Die Gründe kommen aus der Prüfung schon in der Sprache der Anfrage: sie setzt
 * übersetzte Teile (Feld, Seite, Zahl) in einen Satz, den `msg()` nicht trüge.
 * `handleError` findet zu einem fertigen Satz keinen Eintrag und lässt ihn stehen.
 */

/**
 * Ein Design mit dem größten Logo, das noch passt, und HTML und CSS bis zur
 * Grenze einer Seite bleibt darunter, auch wenn JSON jedes Anführungszeichen
 * verdoppelt.
 */
const MAX_BODY_BYTES = 128 * 1024;

interface DesignResult {
  design: PageDesign;
  steps: ProvisionStep[];
  entries: ErrorPageEntry[];
}

/** Ausliefern, ohne dass ein Wurf die Auskunft „gespeichert" verschluckt. */
async function deliver(server: Server, design: PageDesign, locale: Locale): Promise<DesignResult> {
  try {
    return { design, ...(await applyPageDesign(server)) };
  } catch (err) {
    return {
      design,
      steps: [
        {
          // Schlüssel wie die Schritte aus `applyPageDesign`: die Seite zeigt sie mit `t()`.
          label: msgid('Ausliefern'),
          ok: false,
          detail: err instanceof ApiError ? err.localized(locale) : msgid('HAProxy ist nicht erreichbar.'),
        },
      ],
      entries: [],
    };
  }
}

function describe(design: PageDesign): string {
  if (isDefaultDesign(design)) return 'Design von HAPM';
  const language = design.locale === 'en' ? 'Vorgabetexte englisch' : '';
  if (design.mode === 'standard') return ['Seite von HAPM', language].filter(Boolean).join(', ');
  if (design.mode === 'custom') {
    const size = (text: string) => new TextEncoder().encode(text).length;
    return [`eigene HTML-Datei (${size(design.custom.html)} Bytes)`, language]
      .filter(Boolean)
      .join(', ');
  }
  const colors = Object.entries(design.colors)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name} ${value}`);
  const logo =
    design.logo.kind === 'custom'
      ? `eigenes Logo (${LOGO_TYPES[design.logo.mime]})`
      : design.logo.kind === 'none'
        ? 'ohne Logo'
        : 'Logo von HAPM';
  const texts = Object.keys(design.errors).length + Object.values(design.lock).filter(Boolean).length;
  return [
    ...colors,
    logo,
    design.brand ? `Schriftzug „${design.brand}“` : '',
    design.footer ? 'Fußzeile' : '',
    texts ? `${texts} eigene Texte` : '',
    language,
  ]
    .filter(Boolean)
    .join(', ');
}

async function audit(
  request: Request,
  session: { userId: string; email: string },
  server: Server,
  result: DesignResult
): Promise<void> {
  const failed = result.steps.find((step) => !step.ok);
  await logAudit({
    userId: session.userId,
    userEmail: session.email,
    action: failed ? 'haproxy_error_pages_failed' : 'haproxy_error_pages_updated',
    resource: 'server',
    resourceId: server.$id,
    details:
      `Design der Fehlerseiten gespeichert: ${describe(result.design)}. Ausliefern: ` +
      result.steps.map((step) => `${step.ok ? '' : 'fehlgeschlagen: '}${step.label}`).join(', '),
    ip: getClientIP(request) ?? undefined,
  });
}

export async function GET() {
  try {
    await requireSession();
    // Die Darstellung kommt mit: die Vorschau rechnet im Browser dieselben Seiten.
    const design = await loadPageDesign();
    return ok({ design, brand: activeBrand() });
  } catch (err) {
    return handleError(err);
  }
}

export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();
    const locale = await getLocale();

    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
      throw new ApiError(requestTooLargeMessage(locale), 413);
    }
    const body = await jsonBody<{ serverId?: string; design?: unknown }>(request);

    const parsed = parsePageDesign(body.design, locale);
    if (!parsed.ok) throw new ApiError(parsed.error);
    const tooLarge = designSizeError(parsed.design, locale, await loadPageBrand());
    if (tooLarge) throw new ApiError(tooLarge);

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);
    const result = await deliver(server, await savePageDesign(parsed.design), locale);

    await audit(request, session, server, result);
    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}

/** Zurück auf das Design von HAPM: Farben, Logo und jeder Text. */
export async function DELETE(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    const server = await getProxyServer(LOCAL_SERVER_ID);
    const result = await deliver(server, await savePageDesign(defaultPageDesign()), await getLocale());

    await audit(request, session, server, result);
    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}
