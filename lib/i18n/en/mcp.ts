import type { Dictionary } from './index';

/** Der Zugang über MCP auf der Seite „API und MCP" (`components/reverse-proxy/McpAccess.tsx`). */
export const mcp: Dictionary = {
  'MCP': 'MCP',
  'Steuert HAPM aus MCP-Clients wie Claude, mit denselben API-Keys.':
    'Controls HAPM from MCP clients such as Claude, with the same API keys.',
  'Jedes Werkzeug läuft mit allen Rechten des Keys: Ziele entfernen, Updates einspielen, HAProxy neu starten, Einstellungen ändern. Am besten einen eigenen Key für MCP anlegen.':
    'Every tool runs with the full rights of the key: remove targets, install updates, restart HAProxy, change settings. Best create a separate key for MCP.',
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
  'Eigenen Connector in Claude anlegen: Adresse oben, Kopfzeile unten.':
    'Create a custom connector in Claude: address above, header below.',
  'Die Verbindung kommt aus der Cloud von Anthropic. Eine Freigabeliste am Key muss deren Adressen enthalten oder leer sein.':
    'The connection comes from the Anthropic cloud. An allow list on the key must contain its addresses or be empty.',
  'Den Key als Umgebungsvariable {variable} setzen, dann steht er in keiner Datei.':
    'Set the key as environment variable {variable}, so it is not stored in any file.',
  'Für Clients, die nur lokale Server starten, etwa über {file}. Braucht Node.js.':
    'For clients that only start local servers, for example through {file}. Needs Node.js.',

  // Meldungen der internen API außerhalb des Reverse-Proxys (`/api/internal/…`, MCP).
  'Update-Lauf nicht gefunden.': 'Update run not found.',
  'Sicherungslauf nicht gefunden.': 'Backup run not found.',
  'Die Adresse von HAPM lässt sich über die API nicht ändern. Der Umzug steht in der Oberfläche unter Allgemein.':
    'The HAPM address cannot be changed through the API. Moving it is done in the web interface under General.',
  'Das SMTP-Passwort lässt sich über die API nicht setzen. Es steht in der Oberfläche unter Benachrichtigungen.':
    'The SMTP password cannot be set through the API. It is set in the web interface under Notifications.',
  'Der SMTP-Server lässt sich über die API nicht ändern ({field}). Er steht in der Oberfläche unter Benachrichtigungen.':
    'The SMTP server cannot be changed through the API ({field}). It is in the web interface under Notifications.',
  'Ein Schlüssel für External Account Binding lässt sich über die API nicht setzen. Er steht in der Oberfläche unter Allgemein.':
    'An External Account Binding key cannot be set through the API. It is set in the web interface under General.',
  'Es fehlt die Domain, die geprüft werden soll.': 'The domain to check is missing.',
  'Die Adresse von HAPM konnte nicht geladen werden. Bitte laden Sie die Seite neu.': 'The HAPM address could not be loaded. Please reload the page.',
  'In Claude unter Connectors einen „Custom connector“ hinzufügen. Die Kopfzeile gehört unter „Request headers“. OAuth bleibt aus.': 'In Claude, add a “Custom connector” under Connectors. The header goes under “Request headers”. Leave OAuth off.',
};
