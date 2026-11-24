import { requireSession, requireCsrf } from '@/lib/session';
import { ok, handleError, jsonBody, ApiError } from '@/lib/api';
import { logAudit, getClientIP } from '@/lib/audit';
import { getProxyServer, type ProvisionStep } from '@/lib/haproxy/provision';
import { applyPageDesign } from '@/lib/haproxy/page-design-apply';
import { loadPageDesign, savePageDesign } from '@/lib/haproxy/page-design-store';
import {
  defaultPageDesign,
  isDefaultDesign,
  parsePageDesign,
  LOGO_TYPES,
  PAGE_MAX_BYTES,
  type PageDesign,
} from '@/lib/haproxy/page-design';
import { designSizeError } from '@/lib/haproxy/design-pages';
import type { ErrorPageEntry } from '@/lib/haproxy/error-pages';
import { LOCAL_SERVER_ID } from '@/lib/helpers';
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
 * danach mit 500 (`lib/haproxy/page-design.ts`).
 */

/** Ein Design mit dem größten Logo, das noch passt, bleibt weit darunter. */
const MAX_BODY_BYTES = 64 * 1024;

interface DesignResult {
  design: PageDesign;
  steps: ProvisionStep[];
  entries: ErrorPageEntry[];
}

/** Ausliefern, ohne dass ein Wurf die Auskunft „gespeichert" verschluckt. */
async function deliver(server: Server, design: PageDesign): Promise<DesignResult> {
  try {
    return { design, ...(await applyPageDesign(server)) };
  } catch (err) {
    return {
      design,
      steps: [
        {
          label: 'Ausliefern',
          ok: false,
          detail: err instanceof ApiError ? err.message : 'HAProxy ist nicht erreichbar.',
        },
      ],
      entries: [],
    };
  }
}

function describe(design: PageDesign): string {
  if (isDefaultDesign(design)) return 'Design von HAPM';
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
    return ok({ design: await loadPageDesign() });
  } catch (err) {
    return handleError(err);
  }
}

export async function PUT(request: Request) {
  try {
    await requireCsrf(request);
    const session = await requireSession();

    if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) {
      throw new ApiError(
        `Das Logo ist zu groß. Die ganze Seite darf samt Logo höchstens ${PAGE_MAX_BYTES.toLocaleString('de-DE')} Bytes haben.`,
        413
      );
    }
    const body = await jsonBody<{ serverId?: string; design?: unknown }>(request);

    const parsed = parsePageDesign(body.design);
    if (!parsed.ok) throw new ApiError(parsed.error);
    const tooLarge = designSizeError(parsed.design);
    if (tooLarge) throw new ApiError(tooLarge);

    const server = await getProxyServer(body.serverId || LOCAL_SERVER_ID);
    const result = await deliver(server, await savePageDesign(parsed.design));

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
    const result = await deliver(server, await savePageDesign(defaultPageDesign()));

    await audit(request, session, server, result);
    return ok(result);
  } catch (err) {
    return handleError(err);
  }
}
