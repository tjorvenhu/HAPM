/**
 * Der MCP-Server von HAPM: die Werkzeuge aus `tools.ts`, angemeldet an einem
 * `McpServer` des offiziellen SDK.
 *
 * Je Anfrage entsteht ein neuer Server (`app/api/mcp/route.ts`). Er kennt den
 * Aufrufer (`ToolContext`) und vergisst ihn mit der Antwort: es gibt keine
 * Sitzung, die zwischen zwei Anfragen etwas festhalten müsste, und ein
 * Server, der den Actor eines anderen Tokens im Speicher hält, wäre die eine
 * Stelle, an der ein Aufruf unter fremdem Namen ins Audit gerät.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import pkg from '../../package.json';
import { ApiError } from '../api';
import { translate } from '../i18n';
import { TOOLS, type ToolContext, type ToolDefinition } from './tools';

export const MCP_SERVER_NAME = 'hapm';

/** Was ein Client beim Verbinden liest, bevor er ein Werkzeug sieht. */
const INSTRUCTIONS = [
  'HAPM manages exactly one HAProxy reverse proxy with Let\'s Encrypt certificates (acme.sh) and optional DNS records.',
  'Start with get_proxy to learn the scope names and whether certificates can be issued.',
  'Every write tool for targets, TCP forwards, scopes and proxy settings starts a background run and returns a runId.',
  'Poll get_run with waitSeconds=50 until status is not "running"; issuing a certificate can take up to 5 minutes.',
  'update_service and update_stream replace the whole definition: read with get_service/get_stream first and send every field back.',
  'The target through which HAPM itself is reached (surface=true) cannot be deleted.',
  'Beyond the proxy: get_system_status for health, get_updates/start_update/get_update_run for image updates ' +
    '(updating "hapm" restarts this server, the connection drops for about a minute), get_backup/start_backup for backups, ' +
    'get_settings/update_settings for HAPM settings, plus logs, base configuration, error pages, certificates and the GeoIP table.',
  'Every tool runs with the full rights of the service token; write actions appear in the HAPM audit log under the token name.',
].join(' ');

/** Kurz und lesbar: eingerückt, damit ein Mensch im Client es auch lesen kann. */
function asText(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

/**
 * Ein Fehler als Ergebnis des Werkzeugs und nicht als Protokollfehler.
 *
 * Die Spezifikation trennt beides: ein Protokollfehler heißt „das Werkzeug gibt
 * es nicht" oder „die Anfrage ist kaputt", ein Ergebnis mit `isError` heißt
 * „das Werkzeug lief und sagt nein". Nur das zweite liest das Modell und kann
 * darauf reagieren (eine andere ID wählen, erst `check_port` fragen).
 *
 * Wie `handleError`: eine `ApiError` geht mit Status und übersetzter Meldung
 * hinaus, ein anderer Fehler mit seiner Meldung, und er steht im Log.
 */
export function toolError(err: unknown, locale: ToolContext['locale']): CallToolResult {
  if (err instanceof ApiError) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Error ${err.status}: ${err.localized(locale)}` }],
    };
  }
  console.error('[mcp]', err);
  const text = err instanceof Error ? translate(locale, err.message) : translate(locale, 'Unerwarteter Fehler');
  return { isError: true, content: [{ type: 'text', text: `Error 500: ${text}` }] };
}

export async function callTool(
  tool: ToolDefinition,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<CallToolResult> {
  try {
    const result = await tool.run(args, ctx);
    return { content: [{ type: 'text', text: asText(result) }] };
  } catch (err) {
    return toolError(err, ctx.locale);
  }
}

export function createMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, title: 'HAPM', version: pkg.version },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: tool.annotations,
      },
      (args: Record<string, unknown>) => callTool(tool, args ?? {}, ctx)
    );
  }
  return server;
}
