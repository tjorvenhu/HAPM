# Der MCP-Server

`/api/mcp`: HAPM als Server für das Model Context Protocol. Damit steuert ein
Sprachmodell (Claude Code, Claude Desktop, claude.ai, jeder andere MCP-Client)
den Reverse-Proxy mit denselben Möglichkeiten wie die
[Reverse-Proxy-API](reverse-proxy-api.md), nur als Werkzeuge statt als
HTTP-Endpunkte.

Der erste Teil ist die Anleitung für den, der einen Client verbindet. Der
zweite („Für den, der den Server ändert") sagt, warum er so gebaut ist.

## Verbinden

Ein API-Key aus HAPM unter **Reverse-Proxy → API und MCP**
(`/reverse-proxy/api`). Es sind **dieselben Keys wie für die API**, es gibt
kein zweites Token-System. Auf derselben Seite steht im Reiter „MCP"
(`?bereich=mcp`) die
Adresse des Endpunkts und für jeden Client die fertige Konfiguration zum
Kopieren.

Die Adresse ist die Adresse von HAPM aus den Einstellungen (**Allgemein**,
`publicUrl`) mit `/api/mcp` dahinter, etwa `https://hapm.example.org/api/mcp`.
Ist dort nichts eingetragen, zeigt die Seite einen Hinweis statt einer Adresse.

**Claude Code**

```bash
claude mcp add --scope user --transport http hapm https://hapm.example.org/api/mcp \
  --header "Authorization: Bearer hapm_…"
```

`--scope user`, weil ohne Angabe `local` gilt: der Server stünde dann nur im
Ordner, in dem der Befehl lief. HAPM ist der Proxy für alle Projekte, der Key
gehört nicht in eine Datei im Repo.

Oder im Projekt als `.mcp.json`, mit dem Key in einer Umgebungsvariablen statt
in der Datei (VS Code und andere Clients mit HTTP-Transport lesen dieselbe
Form):

```json
{
  "mcpServers": {
    "hapm": {
      "type": "http",
      "url": "https://hapm.example.org/api/mcp",
      "headers": { "Authorization": "Bearer ${HAPM_TOKEN}" }
    }
  }
}
```

**Claude Desktop und claude.ai**: unter Connectors einen eigenen Connector
(„Custom connector") anlegen, als Adresse die von oben, unter „Request
headers" `Authorization: Bearer hapm_…`, ohne OAuth. Die Verbindung kommt dann
**aus der Cloud von Anthropic**, nicht vom eigenen Rechner. Daraus folgen zwei
Bedingungen: HAPM muss aus dem Internet über HTTPS auf Port 443 erreichbar
sein (eine als „intern" eingerichtete Installation ist es meist nicht), und
eine Adressliste am Key muss die Adressen von Anthropic enthalten oder leer
sein.

**Clients, die nur lokale Server starten** (etwa über
`claude_desktop_config.json`): über die Brücke `mcp-remote`, die Node.js
braucht.

```json
{
  "mcpServers": {
    "hapm": {
      "command": "npx",
      "args": ["mcp-remote", "https://hapm.example.org/api/mcp", "--header", "Authorization:${HAPM_AUTH}"],
      "env": { "HAPM_AUTH": "Bearer hapm_…" }
    }
  }
}
```

Das Leerzeichen steht in `env` und nicht in `args`, weil einige Clients
Leerzeichen in Argumenten nicht maskieren (steht so in der README von
`mcp-remote`).

### Was ein Key darf

**Alles.** Ein Key hat keine Bereiche, und jedes Werkzeug läuft mit seinen
vollen Rechten: Ziele anlegen, ändern und entfernen, Gruppen, die
Admin-Adressliste. Die Seite sagt das sichtbar über dem Endpunkt. Empfohlen
ist ein eigener Key für MCP: dann steht im Protokoll und in der Liste der
Vorgänge, was über ein Sprachmodell kam, und er lässt sich zurückziehen, ohne
ein Deploy-Skript zu treffen.

Alles, was für einen Key gilt, gilt hier unverändert (`lib/service-auth.ts`):
Bindung an Adressen (`403` mit Begründung), 20 Fehlversuche je Adresse und
Stunde (`429`), zurückgezogen heißt `401`.

## Die Werkzeuge

| Werkzeug | Art | Was es tut |
|---|---|---|
| `get_proxy` | lesen | das eine HAProxy: Gruppen, Admin-IPs, DNS-Hooks, `acmeReady`. Der Einstieg |
| `list_services`, `get_service` | lesen | Ziele, gefiltert über Gruppe oder exakte Domain |
| `create_service` | schreiben | Ziel anlegen → `runId`, `serviceId` |
| `update_service` | schreiben | Ziel ersetzen, **vollständige Definition** → `runId` |
| `delete_service` | schreiben | Ziel entfernen, DNS nur mit `removeDns: true` → `runId` |
| `list_streams`, `get_stream` | lesen | TCP-Weiterleitungen |
| `check_port` | lesen | ist der Port frei |
| `create_stream`, `update_stream`, `delete_stream` | schreiben | TCP-Weiterleitungen → `runId` |
| `create_scope`, `delete_scope` | schreiben | Gruppen → `runs` |
| `get_proxy_settings` | lesen | HTTPS-Zeilen und Admin-Adressliste |
| `update_proxy_settings` | schreiben | Teil-Patch der Einstellungen → `runId` |
| `get_run` | lesen | Stand eines Laufs, mit `waitSeconds` bis 50 s wartend |
| `list_runs` | lesen | die Historie, gefiltert |
| `list_certificates` | lesen | was acme.sh führt, samt „benutzt von" |
| `get_system_status` | lesen | die Übersicht: Container, acme.sh, Ziele ohne Backend, Zertifikate, Updates |
| `get_traffic_stats` | lesen | Summen und meistbesuchte Ziele aus der Statistik |
| `list_dns_zones` | lesen | angebundene Zonen und ob ihr Zugang gerade geht |

Jedes Werkzeug trägt die Hinweise der Spezifikation: `readOnlyHint` bei den
lesenden, `destructiveHint` bei Ändern und Entfernen, `openWorldHint` dort, wo
ein Lauf beim DNS-Anbieter oder bei Let's Encrypt etwas anfasst. Ein Client
fragt vor einem schreibenden Werkzeug nach, wenn er so eingestellt ist.

Die Regeln eines Feldes stehen in der Beschreibung des Werkzeugs, auf
Englisch, weil ein Sprachmodell sie liest. Ausführlich und auf Deutsch stehen
sie in [`reverse-proxy-api.md`](reverse-proxy-api.md), „Die Felder eines
Eintrags".

## Für den, der den Server ändert

**Lies das, bevor du `lib/mcp/`, `app/api/mcp/` oder
`lib/haproxy/api-actions.ts` anfasst.**

### Keine eigene Logik in den Werkzeugen

Jedes Werkzeug ruft eine Funktion, die auch eine Route ruft:

- `lib/haproxy/api-actions.ts` für alles, was die Reverse-Proxy-API kann. Bis
  zum MCP-Server stand diese Logik in den Routendateien unter
  `app/api/internal/haproxy/`. Sie ist umgezogen, damit es nicht zwei Kopien
  gibt: eine Kopie wäre die Stelle, an der eine Schutzregel fehlt (Ziel der
  Oberfläche, Vorabprüfung, Abgleich der DNS-Domains), die man an der Route
  später ergänzt. Die Routen prüfen jetzt das Token, lesen Rumpf und Adresse
  und rufen eine Funktion. Die Antworten der API sind dabei Feld für Feld
  dieselben geblieben.
- `systemOverview()` (Übersicht), `readStatsOverview()`
  (`lib/haproxy/stats-overview.ts`, Statistik) und `checkZones()`
  (`lib/dns/zone-check.ts`, DNS). Die beiden letzten standen vorher in ihren
  Routen und sind aus demselben Grund herausgezogen.

Wer an einer API-Route etwas ändert, ändert es in `api-actions.ts`, und der
MCP-Server hat es mit. Wer ein Werkzeug braucht, das es als Funktion noch
nicht gibt, legt die Funktion an und lässt Route und Werkzeug sie rufen.

### Was es bewusst nicht gibt

- **DNS-Zonen anbinden oder ändern.** Das braucht einen Token des Anbieters,
  und ein Geheimnis gehört nicht in den Verlauf eines Sprachmodells. Lesend
  gibt es die Zonen (`list_dns_zones`), angebunden werden sie in der
  Oberfläche.
- **Die DNS-Zugangsdaten für Wildcards**, aus demselben Grund wie bei der API
  (siehe dort, „Was es hier bewusst nicht gibt").
- **Zertifikate einzeln löschen oder ausstellen.** Sie entstehen und vergehen
  mit einem Ziel.
- **HAProxy neu starten, Updates, Sicherungen, Benutzer, Einstellungen von
  HAPM.** Die Reverse-Proxy-API kann das nicht, und ein Key soll über MCP nicht
  mehr dürfen als über HTTP. Wer das will, erweitert zuerst die API und ihre
  Regeln.

### Anmeldung (`app/api/mcp/route.ts`)

- **Dasselbe Token wie die API, kein OAuth.** Ein zweites Token-System hieße
  zwei Seiten zum Zurückziehen, und das eine, das man vergisst. OAuth bräuchte
  einen Autorisierungsserver in HAPM für einen Zugang, den ein Mensch ohnehin
  einmal einträgt. Die Clients, um die es geht, können einen festen
  `Authorization`-Header schicken.
- **`requireServiceToken(request)` steht als Erstes im POST**, wie unter
  `/api/internal`. Das prüft `tests/security/mcp-api.test.ts`.
- **Der Actor entsteht in der Route** (`haproxyActor(serviceActor(service),
  request)`) und geht über den `ToolContext` an jedes schreibende Werkzeug.
  Historie und Audit tragen damit den Namen des Tokens, genau wie bei der API.
  Lesende Werkzeuge schreiben kein Audit, aus demselben Grund wie die lesenden
  Routen: `get_run` wird gepollt.
- **Ein 401 trägt `WWW-Authenticate: Bearer realm="HAPM"`**, ohne
  `resource_metadata`. Ein Client, der das liest, weiß, dass er ein Token
  schicken soll, und sucht keinen Autorisierungsserver, den es nicht gibt.

### Transport

- **Das offizielle SDK** (`@modelcontextprotocol/sdk`) mit
  `WebStandardStreamableHTTPServerTransport`: der Transport für Web-Standard
  `Request`/`Response`, also genau das, was ein Route Handler von Next.js
  bekommt und zurückgibt. Die Node-Variante (`StreamableHTTPServerTransport`)
  will `IncomingMessage`/`ServerResponse` und passt nicht. Eine eigene
  JSON-RPC-Umsetzung war damit nicht nötig.
- **Zustandslos.** Je POST entstehen `McpServer` und Transport neu
  (`sessionIdGenerator: undefined`) und werden nach der Antwort geschlossen.
  Eine Sitzung im Speicher hielte nach einem Neustart von HAPM nichts mehr,
  wovon der Client etwas wüsste, und ein Server, der den Actor eines anderen
  Tokens festhält, wäre die eine Stelle, an der ein Aufruf unter fremdem Namen
  ins Audit gerät.
- **JSON statt SSE** (`enableJsonResponse: true`). Kein Werkzeug schickt
  Zwischenstände. Was lange dauert, ist ein Lauf mit `runId`, und den fragt
  `get_run` ab.
- **`GET` und `DELETE` antworten mit `405`.** Die Spezifikation erlaubt das für
  einen Server ohne Strom vom Server zum Client und ohne Sitzung.

### Antworten und Fehler

- **Ergebnisse sind eingerücktes JSON als Text**: dieselben Objekte wie bei der
  API. Schreibende Werkzeuge hängen `next` an, einen Satz, der dem Modell sagt,
  dass es `get_run` fragen soll.
- **Eine Ablehnung der Bibliothek ist ein Ergebnis mit `isError`**, kein
  Protokollfehler: `Error 409: …`. Nur so liest das Modell die Meldung und
  kann darauf reagieren (andere ID, erst `check_port`). Protokollfehler bleiben
  für ein unbekanntes Werkzeug und kaputtes JSON-RPC.
- **Die Meldungen sind englisch**, solange der Client kein
  `Accept-Language` schickt (`lib/mcp/locale.ts`). Ein MCP-Client hat weder
  Sitzung noch Cookie, und die Regel der Routen (ohne Kopfzeile Deutsch) gäbe
  einem Modell mit englischen Werkzeugbeschreibungen deutsche Fehler.
- **`get_run` wartet höchstens 50 Sekunden** (`waitSeconds`). Das liegt unter
  dem üblichen Timeout eines Werkzeugaufrufs in den Clients. Ein ganzer Lauf
  mit Zertifikat dauert bis zu fünf Minuten; das Modell fragt dann mehrmals.

### Die Schemas

Die Schemas (`zod`, im SDK zu JSON Schema umgewandelt) prüfen nur die Form:
Typen, Pflichtfelder, Aufzählungen wie `balance` und `backendTls` (dieselbe
Allow-Liste `BACKEND_TLS` wie in `validateCreateInput`, am Ziel und an jeder
Pfad-Regel). Was eine gültige Domain oder
ein freier Port ist, entscheidet die Bibliothek, mit derselben Meldung wie bei
der API. Zwei Regelwerke für dieselbe Eingabe laufen auseinander.

Zwei Abbildungen sind Absicht:

- `update_service` und `update_stream` nehmen `id` (die aktuelle) und `newId`
  (nur zum Umbenennen). In der API ist das der Pfad und das Feld `id` im
  Rumpf; ein Modell verwechselt die beiden leichter als zwei Namen.
- Ein fehlendes `passwordLock` bleibt fehlend und wird nicht zu `null`: fehlt
  es, bleibt die Art der Sperre, `null` stellt auf Admin-IPs um.

`serverId` gibt es in den Werkzeugen nicht. HAPM verwaltet genau ein HAProxy,
und ein Parameter, der nur einen Wert kennt, ist für ein Modell eine Frage zu
viel.

### Tests

- `tests/mcp/route.test.ts`: ein echter JSON-RPC-Ablauf (initialize,
  notifications/initialized, ping, tools/list, tools/call) gegen den
  Route-Handler, Anmeldung und Bibliothek ersetzt.
- `tests/mcp/tools.test.ts`: Namen, Hinweise, welche Werkzeuge schreiben, dass
  jedes davon den Actor weiterreicht, das Warten in `get_run`.
- `tests/security/mcp-api.test.ts`: Reihenfolge der Anmeldung in der Route.

Ein echter Lauf (Zertifikat, Reload) braucht HAProxy und acme.sh und geht nur
im Stack.
