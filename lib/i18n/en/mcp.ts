import type { Dictionary } from './index';

/** Der Zugang über MCP auf der Seite „API und MCP" (`components/reverse-proxy/McpAccess.tsx`). */
export const mcp: Dictionary = {
  'MCP': 'MCP',
  'Steuert HAPM aus Claude und anderen MCP-Clients. Es gelten dieselben API-Keys wie für die API.':
    'Controls HAPM from Claude and other MCP clients. The same API keys as for the API apply.',
  'Jedes Werkzeug läuft mit allen Rechten des Keys: Ziele anlegen, ändern und entfernen. Am besten einen eigenen Key für MCP anlegen.':
    'Every tool runs with the full rights of the key: create, change and remove targets. Best create a separate key for MCP.',
  'Adresse des Endpunkts': 'Endpoint address',
  'Kommt aus der Adresse von HAPM unter Allgemein. Ein Client von Anthropic (claude.ai, Claude Desktop) verbindet sich aus dem Internet: die Adresse muss von dort über HTTPS auf Port 443 erreichbar sein.':
    'Taken from the HAPM address under General. A client from Anthropic (claude.ai, Claude Desktop) connects from the internet: the address must be reachable from there over HTTPS on port 443.',
  'Die Adresse von HAPM ist noch nicht eingetragen. Sie steht unter {link}.':
    'The HAPM address is not set yet. It is under {link}.',
  'Befehl im Terminal': 'Command in the terminal',
  'Eigener Connector': 'Custom connector',
  'Claude Code im Projekt, VS Code und andere': 'Claude Code in a project, VS Code and others',
  'Clients, die nur lokale Server kennen': 'Clients that only know local servers',
  '{placeholder} durch den Key ersetzen.': 'Replace {placeholder} with the key.',
  'In Claude unter Connectors einen eigenen Connector (Custom connector) hinzufügen: als Adresse die oben, unter Request headers die Kopfzeile unten, ohne OAuth.':
    'In Claude, add a custom connector under Connectors: the address above as URL, the header below under Request headers, no OAuth.',
  'Die Verbindung kommt aus der Cloud von Anthropic. Eine Freigabeliste am Key muss deren Adressen enthalten oder leer sein.':
    'The connection comes from the Anthropic cloud. An allow list on the key must contain its addresses or be empty.',
  'Den Key als Umgebungsvariable {variable} setzen, dann steht er in keiner Datei.':
    'Set the key as environment variable {variable}, so it is not stored in any file.',
  'Für Clients, die nur lokale Server starten, etwa über {file}. Braucht Node.js.':
    'For clients that only start local servers, for example through {file}. Needs Node.js.',
  'Kopieren nicht möglich. Bitte von Hand markieren.': 'Copying is not possible. Please select the text by hand.',
};
