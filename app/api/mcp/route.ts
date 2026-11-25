import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-auth';
import { handleError } from '@/lib/api';
import { serviceActor } from '@/lib/audit';
import { createTranslator } from '@/lib/i18n';
import { haproxyActor } from '@/lib/haproxy/internal';
import { createMcpServer } from '@/lib/mcp/server';
import { mcpLocale } from '@/lib/mcp/locale';

/**
 * Der MCP-Endpunkt: „Streamable HTTP" nach der Spezifikation, zustandslos.
 *
 * Anmeldung wie unter `/api/internal`: ein Service-Token
 * (`Authorization: Bearer hapm_…`), samt Bindung an Adressen und
 * Fehlversuchszähler. Kein zweites Token-System, kein OAuth. Schreibende
 * Werkzeuge reichen `serviceActor` in den Lauf, Historie und Audit tragen den
 * Namen des Tokens. Warum es so gebaut ist: docs/mcp.md.
 *
 * Je POST entstehen Server und Transport neu und werden nach der Antwort
 * geschlossen. Es gibt keine Sitzung (`sessionIdGenerator: undefined`) und
 * keinen SSE-Strom (`enableJsonResponse`): kein Werkzeug schickt
 * Zwischenstände, und eine Sitzung im Speicher hielte nach einem Neustart von
 * HAPM nichts mehr, wovon der Client etwas wüsste.
 */

/**
 * Ein 401 sagt dem Client, dass er ein Bearer-Token schicken soll
 * (RFC 6750). Ohne `resource_metadata`: es gibt kein OAuth, das ein Client
 * entdecken könnte, das Token kommt aus HAPM unter „API und MCP".
 */
function withAuthChallenge(response: NextResponse): NextResponse {
  if (response.status === 401) {
    response.headers.set('WWW-Authenticate', 'Bearer realm="HAPM"');
  }
  return response;
}

export async function POST(request: Request) {
  try {
    const service = await requireServiceToken(request);

    const locale = mcpLocale(request);
    const server = createMcpServer({
      actor: haproxyActor(serviceActor(service), request),
      locale,
      t: createTranslator(locale).t,
    });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    try {
      await server.connect(transport);
      // Im JSON-Modus kommt die Antwort erst, wenn alle Aufrufe des Rumpfs
      // beantwortet sind. Danach darf geschlossen werden.
      return await transport.handleRequest(request);
    } finally {
      await server.close();
    }
  } catch (err) {
    return withAuthChallenge(await handleError(err));
  }
}

/**
 * Kein Strom vom Server zum Client: die Spezifikation lässt dafür 405 zu, und
 * ein Client fragt dann nur noch per POST.
 */
export function GET() {
  return methodNotAllowed();
}

/** Ohne Sitzung gibt es nichts zu beenden. */
export function DELETE() {
  return methodNotAllowed();
}

function methodNotAllowed() {
  return NextResponse.json(
    { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null },
    { status: 405, headers: { Allow: 'POST' } }
  );
}
