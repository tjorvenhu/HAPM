'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Bot, Copy } from 'lucide-react';
import Select from '@/components/Select';
import { useToast } from '@/components/Toast';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useT } from '@/lib/i18n/react';

/**
 * Der Zugang über MCP auf der Seite „API und MCP": Adresse des Endpunkts und
 * fertige Konfigurationen zum Kopieren.
 *
 * Die Adresse kommt aus der Adresse von HAPM in den Einstellungen und nicht
 * aus dem Browser wie die Basis-URL der API darüber: ein MCP-Client von
 * Anthropic (claude.ai, Claude Desktop) verbindet sich aus dem Internet, und
 * eine Adresse, unter der nur dieser Browser HAPM gerade erreicht (eine
 * interne IP, ein Tunnel), stünde dort falsch. Fehlt sie, steht ein Hinweis
 * statt einer Adresse, die nur halb stimmt. Siehe docs/mcp.md.
 */

type Client = 'claude-code' | 'connector' | 'mcp-json' | 'mcp-remote';

/** Platzhalter in den Schnipseln. Ersetzt ihn der Nutzer nicht, antwortet HAPM mit 401. */
const TOKEN_PLACEHOLDER = '<API-Key>';

/** `https://hapm.example.org` → `https://hapm.example.org/api/mcp`. `null` ohne gültige Adresse. */
export function mcpEndpoint(publicUrl: string | null): string | null {
  if (!publicUrl) return null;
  try {
    const url = new URL(publicUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return `${url.origin}/api/mcp`;
  } catch {
    return null;
  }
}

/** Die Schnipsel je Client. Kennungen und JSON bleiben, wie die Clients sie lesen. */
export function mcpSnippets(endpoint: string): Record<Exclude<Client, 'connector'>, string> {
  return {
    'claude-code': `claude mcp add --transport http hapm ${endpoint} --header "Authorization: Bearer ${TOKEN_PLACEHOLDER}"`,
    'mcp-json': JSON.stringify(
      {
        mcpServers: {
          hapm: {
            type: 'http',
            url: endpoint,
            headers: { Authorization: 'Bearer ${HAPM_TOKEN}' },
          },
        },
      },
      null,
      2
    ),
    'mcp-remote': JSON.stringify(
      {
        mcpServers: {
          hapm: {
            command: 'npx',
            args: ['mcp-remote', endpoint, '--header', 'Authorization:${HAPM_AUTH}'],
            env: { HAPM_AUTH: `Bearer ${TOKEN_PLACEHOLDER}` },
          },
        },
      },
      null,
      2
    ),
  };
}

export default function McpAccess({ publicUrl, loading }: { publicUrl: string | null; loading: boolean }) {
  const { t, rich } = useT();
  const { notify } = useToast();
  const [client, setClient] = useState<Client>('claude-code');

  const endpoint = mcpEndpoint(publicUrl);
  const snippets = endpoint ? mcpSnippets(endpoint) : null;

  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      notify({ message: t('Kopiert'), variant: 'success' });
    } catch {
      notify({ message: t('Kopieren nicht möglich. Bitte von Hand markieren.'), variant: 'error' });
    }
  }

  const copyLabel = t('Kopieren');

  return (
    <div className="card sys-block api-card">
      <div className="form-section-head">
        <span className="form-section-icon">
          <Bot size={17} />
        </span>
        <div>
          <div className="form-section-title">{t('MCP')}</div>
          <div className="form-section-sub">
            {t('Steuert HAPM aus Claude und anderen MCP-Clients. Es gelten dieselben API-Keys wie für die API.')}
          </div>
        </div>
      </div>

      <div className="alert alert-warning">
        {t(
          'Jedes Werkzeug läuft mit allen Rechten des Keys: Ziele anlegen, ändern und entfernen. Am besten einen eigenen Key für MCP anlegen.'
        )}
      </div>

      <div className="form-group">
        <label className="form-label">
          {t('Adresse des Endpunkts')}
          <InfoHint
            text={t(
              'Kommt aus der Adresse von HAPM unter Allgemein. Ein Client von Anthropic (claude.ai, Claude Desktop) verbindet sich aus dem Internet: die Adresse muss von dort über HTTPS auf Port 443 erreichbar sein.'
            )}
          />
        </label>
        {endpoint ? (
          <div className="form-list-row">
            <input className="form-input" value={endpoint} readOnly onFocus={(e) => e.target.select()} />
            <CopyButton text={endpoint} label={copyLabel} onCopy={copy} />
          </div>
        ) : loading ? (
          <input className="form-input" value="" readOnly disabled />
        ) : (
          <div className="alert alert-info">
            <span>
              {rich('Die Adresse von HAPM ist noch nicht eingetragen. Sie steht unter {link}.', {
                link: <Link href="/system">{t('Allgemein')}</Link>,
              })}
            </span>
          </div>
        )}
      </div>

      {snippets && endpoint && (
        <>
          <div className="form-group">
            <label className="form-label" htmlFor="mcpClient">
              {t('Client')}
            </label>
            <Select<Client>
              id="mcpClient"
              value={client}
              onChange={setClient}
              options={[
                { value: 'claude-code', label: 'Claude Code', hint: t('Befehl im Terminal') },
                { value: 'connector', label: 'Claude Desktop, claude.ai', hint: t('Eigener Connector') },
                { value: 'mcp-json', label: '.mcp.json', hint: t('Claude Code im Projekt, VS Code und andere') },
                { value: 'mcp-remote', label: 'mcp-remote', hint: t('Clients, die nur lokale Server kennen') },
              ]}
            />
          </div>

          {client === 'claude-code' && (
            <div className="form-group">
              <Snippet text={snippets['claude-code']} label={copyLabel} onCopy={copy} />
              <span className="form-hint">
                {rich('{placeholder} durch den Key ersetzen.', { placeholder: <code>{TOKEN_PLACEHOLDER}</code> })}
              </span>
            </div>
          )}

          {client === 'connector' && (
            <>
              <p className="form-hint">
                {t(
                  'In Claude unter Connectors einen eigenen Connector (Custom connector) hinzufügen: als Adresse die oben, unter Request headers die Kopfzeile unten, ohne OAuth.'
                )}
              </p>
              <div className="form-group">
                <label className="form-label">{t('Kopfzeile')}</label>
                <div className="form-list-row">
                  <input
                    className="form-input"
                    value={`Authorization: Bearer ${TOKEN_PLACEHOLDER}`}
                    readOnly
                    onFocus={(e) => e.target.select()}
                  />
                  <CopyButton text={`Authorization: Bearer ${TOKEN_PLACEHOLDER}`} label={copyLabel} onCopy={copy} />
                </div>
                <span className="form-hint">
                  {t('Die Verbindung kommt aus der Cloud von Anthropic. Eine Freigabeliste am Key muss deren Adressen enthalten oder leer sein.')}
                </span>
              </div>
            </>
          )}

          {client === 'mcp-json' && (
            <div className="form-group">
              <Snippet text={snippets['mcp-json']} label={copyLabel} onCopy={copy} />
              <span className="form-hint">
                {rich('Den Key als Umgebungsvariable {variable} setzen, dann steht er in keiner Datei.', {
                  variable: <code>HAPM_TOKEN</code>,
                })}
              </span>
            </div>
          )}

          {client === 'mcp-remote' && (
            <div className="form-group">
              <Snippet text={snippets['mcp-remote']} label={copyLabel} onCopy={copy} />
              <span className="form-hint">
                {rich('Für Clients, die nur lokale Server starten, etwa über {file}. Braucht Node.js.', {
                  file: <code>claude_desktop_config.json</code>,
                })}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

interface CopyProps {
  text: string;
  label: string;
  onCopy: (text: string) => void;
}

function CopyButton({ text, label, onCopy }: CopyProps) {
  return (
    <button
      type="button"
      className="btn btn-secondary btn-icon"
      data-tooltip={label}
      aria-label={label}
      onClick={() => onCopy(text)}
    >
      <Copy size={16} />
    </button>
  );
}

/** Ein mehrzeiliger Schnipsel mit dem Knopf daneben. */
function Snippet({ text, label, onCopy }: CopyProps) {
  return (
    <div className="form-list-row mcp-snippet">
      <pre className="code-block">{text}</pre>
      <CopyButton text={text} label={label} onCopy={onCopy} />
    </div>
  );
}
