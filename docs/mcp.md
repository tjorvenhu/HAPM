# Der MCP-Server

`/api/mcp`: HAPM als Server für das Model Context Protocol. Damit steuert ein
Sprachmodell (Claude Code, Claude Desktop, claude.ai, jeder andere MCP-Client)
HAPM mit denselben Möglichkeiten wie die interne API: den Reverse-Proxy
([Reverse-Proxy-API](reverse-proxy-api.md)) und alles Weitere, was sich
automatisieren lässt, etwa Updates, Sicherung und Einstellungen
([`hapm-api.md`](hapm-api.md)). Nur als Werkzeuge statt als HTTP-Endpunkte.

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

**Alles, was die API kann.** Ein Key hat keine Bereiche, und jedes Werkzeug
läuft mit seinen vollen Rechten: Ziele anlegen, ändern und entfernen, Gruppen,
die Admin-Adressliste, Updates einspielen (auch von HAPM selbst), HAProxy neu
starten, Sicherungen, Einstellungen. Die Seite sagt das sichtbar über dem Endpunkt. Empfohlen
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
| `get_updates` | lesen | Stand je Bestandteil, letzte Läufe; `check: true` fragt vorher die Registries |
| `start_update` | schreiben | Update von `haproxy`, `hapm` oder `acme` → `runId` |
| `get_update_run` | lesen | Stand eines Update-Laufs, mit `waitSeconds` |
| `get_backup` | lesen | Einstellungen, Läufe, Archive der Sicherung |
| `update_backup_settings` | schreiben | Teil-Patch der Sicherung |
| `start_backup` | schreiben | Sicherung jetzt → `runId` |
| `get_backup_run` | lesen | Stand eines Sicherungslaufs, mit `waitSeconds` |
| `get_settings` | lesen | Einstellungen von HAPM und Stand des Mailversands |
| `update_settings` | schreiben | Teil-Patch, ohne Adresse und SMTP-Passwort |
| `update_certificate_settings` | schreiben | Herkunft der Zertifikate, ACME-Server, ohne EAB |
| `send_test_mail` | schreiben | Testmail an eine Adresse |
| `check_address` | lesen | Prüfung einer neuen Adresse für HAPM |
| `get_haproxy_container` | lesen | Container von HAProxy, auf Wunsch mit Ausgabe |
| `restart_haproxy` | schreiben | Neustart des Containers |
| `get_haproxy_log` | lesen | letzte Zeilen des Logs, gefiltert |
| `delete_certificate` | schreiben | übriges Zertifikat von acme.sh entfernen |
| `reissue_certificate` | schreiben | nie ausgestellten Antrag erneut stellen → `runId` |
| `get_base_config_diff`, `apply_base_config` | lesen, schreiben | Abgleich mit der Grundkonfiguration, Auswahl übernehmen |
| `get_error_pages`, `redeploy_error_pages` | lesen, schreiben | Fehlerseiten, im gespeicherten Design neu schreiben |
| `get_geoip`, `refresh_geoip`, `set_geoip_auto_refresh` | lesen, schreiben | Länder-Tabelle |

Welche Route zu welchem Werkzeug gehört:

| Bereich | API-Route (`/api/internal/…`) | MCP-Werkzeug |
|---|---|---|
| Reverse-Proxy | `haproxy/proxies`, `services`, `streams`, `scopes`, `settings`, `runs` | `get_proxy` bis `list_runs` |
| Zertifikate | `GET`/`DELETE haproxy/certificates`, `POST haproxy/certificates/issue` | `list_certificates`, `delete_certificate`, `reissue_certificate` |
| Systemstatus | `GET system` | `get_system_status` |
| Statistik | `GET haproxy/stats` | `get_traffic_stats` |
| DNS | `GET dns/zones` | `list_dns_zones` |
| Updates | `GET updates` (`?check=1`), `POST updates/<component>`, `GET updates/runs/<id>` | `get_updates`, `start_update`, `get_update_run` |
| Sicherung | `GET`/`PATCH`/`POST backup`, `GET backup/runs/<id>` | `get_backup`, `update_backup_settings`, `start_backup`, `get_backup_run` |
| Einstellungen | `GET`/`PATCH settings`, `PUT settings/certificates` | `get_settings`, `update_settings`, `update_certificate_settings` |
| Benachrichtigungen | `POST mail/test` (Stand in `GET settings`) | `send_test_mail` |
| Adresse von HAPM | `GET settings/address?domain=` | `check_address` |
| HAProxy-Container | `GET`/`POST system/haproxy` | `get_haproxy_container`, `restart_haproxy` |
| Log | `GET haproxy/log` | `get_haproxy_log` |
| Grundkonfiguration | `GET`/`POST haproxy/base-config` | `get_base_config_diff`, `apply_base_config` |
| Fehlerseiten | `GET`/`POST haproxy/error-pages` | `get_error_pages`, `redeploy_error_pages` |
| GeoIP | `GET`/`PATCH geoip`, `POST geoip/refresh` | `get_geoip`, `set_geoip_auto_refresh`, `refresh_geoip` |

Jedes Werkzeug trägt die Hinweise der Spezifikation: `readOnlyHint` bei den
lesenden, `destructiveHint` bei Ändern und Entfernen, `openWorldHint` dort, wo
ein Lauf beim DNS-Anbieter oder bei Let's Encrypt etwas anfasst. Ein Client
fragt vor einem schreibenden Werkzeug nach, wenn er so eingestellt ist.

Die Regeln eines Feldes stehen in der Beschreibung des Werkzeugs, auf
Englisch, weil ein Sprachmodell sie liest. Ausführlich und auf Deutsch stehen
sie in [`reverse-proxy-api.md`](reverse-proxy-api.md), „Die Felder eines
Eintrags".

## Für den, der den Server ändert

**Lies das, bevor du `lib/mcp/`, `app/api/mcp/`, `app/api/internal/`,
`lib/haproxy/api-actions.ts` oder eine der `*-actions.ts` anfasst.**

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
- Für alles außerhalb des Reverse-Proxys je Bereich eine Datei:
  `lib/updates/actions.ts`, `lib/backup/actions.ts`, `lib/settings-actions.ts`,
  `lib/haproxy/certificate-actions.ts`, `lib/haproxy/maintenance-actions.ts`
  (Grundkonfiguration, Fehlerseiten), `lib/haproxy/log-read.ts`,
  `lib/system/haproxy-container.ts`, `lib/geoip/actions.ts`. Die Logik stand in
  den Routen hinter der Oberfläche (`app/api/updates/`, `app/api/backup/`, …);
  sie ist herausgezogen, und die Routen der Oberfläche, die der internen API
  und die Werkzeuge rufen dieselbe Funktion. **Eine schreibende Funktion
  schreibt ihr Protokoll selbst**, damit kein Weg ohne Zeile im Audit bleibt.
  Was ein Key nicht darf, lehnt die Funktion ab und nicht die Route
  (`readServiceSettingsInput`, `allowEab`, `allowUploaded`).

Wer an einer API-Route etwas ändert, ändert es in der Funktion, und der
MCP-Server hat es mit. Wer ein Werkzeug braucht, das es als Funktion noch
nicht gibt, legt die Funktion an, dann die Route unter `/api/internal`, dann
das Werkzeug. **Kein Werkzeug ohne Route**: ein Key soll über MCP nicht mehr
dürfen als über HTTP.

Die Übersichten (`get_updates`, `get_backup`) lassen die Schritte der Läufe
weg (`runSummary`), damit die Antwort für ein Modell klein bleibt. Die
Schritte eines Laufs liefern `get_update_run` und `get_backup_run`.

### Was es bewusst nicht gibt

Gilt für API und MCP gleich; die Funktionen lehnen es ab, nicht die Werkzeuge.

| Bereich | Warum nicht |
|---|---|
| Geheimnisse anlegen oder ausgeben: DNS-Tokens (Zonen anbinden, Token tauschen), DNS-Zugangsdaten für Wildcards, SMTP-Passwort, EAB-Schlüssel, API-Keys erzeugen | Ein Geheimnis gehört nicht in den Verlauf eines Sprachmodells und nicht in ein Skript. Gelesen wird nur, ob es gesetzt ist (`smtpPassSet`). Zu den Wildcard-Zugangsdaten außerdem [`reverse-proxy-api.md`](reverse-proxy-api.md), „Was es hier bewusst nicht gibt“. |
| Zertifikate hochladen, hochgeladene entfernen | Der private Schlüssel stünde im Rumpf oder im Verlauf. Und was die API nicht hochladen kann, soll sie nicht löschen, weil sie es nicht zurückbringt. Zertifikate von acme.sh entfernen geht (`delete_certificate`), aber nur, wenn kein Ziel sie hält. |
| Sicherung zurückspielen | Die Oberfläche verlangt dafür das Passwort eines Menschen, und ein Key hat keins. Das Zurückspielen ersetzt die Datenbank samt Konten und API-Keys (der Key, der es auslöst, ist danach womöglich ungültig) und startet HAPM neu. Wer zurückspielt, sieht vorher in der Oberfläche, was im Archiv steht. Sichern, Einstellungen und Läufe gehen. |
| Adresse von HAPM ändern (Umzug) | Er ändert die Adresse, über die API und MCP selbst erreichbar sind, und löscht alle Passkeys. Den Stand eines laufenden Umzugs liest die API auch nicht: wer ihn liest, gibt das alte Ziel zum Entfernen frei, und das soll das Fenster tun, das umzieht. Die Prüfung einer neuen Domain geht (`check_address`), die aktuelle Adresse steht in `get_settings`. |
| Benutzer, Passwörter, zweiter Faktor, Passkeys, Konto | Ein Key ist kein Mensch. Wer über einen Key Konten anlegen oder Passwörter setzen könnte, hätte aus einem zurückziehbaren Schlüssel einen Zugang gemacht, der nach dem Zurückziehen bleibt. |
| Design der Fehlerseiten, Darstellung (Logo, Farben) | Gestaltung mit Vorschau und Datei-Upload, keine Automatisierung. Die Fehlerseiten im gespeicherten Design neu schreiben geht (`redeploy_error_pages`). |
| GeoIP-Tabelle hochladen oder zurücksetzen | Der Upload ist eine Datei von 4,5 MB für Server ohne Zugang nach außen, das Zurücksetzen der Weg zurück nach einem falschen Upload. Erneuern und der Schalter gehen. |
| Konfiguration importieren | Einmalige Übernahme einer fremden `haproxy.cfg` mit Vorschau, die ein Mensch durchsieht. |
| Gespeicherte Ziele (Eingabehilfe der Dialoge) | `haproxy.cfg` erfährt davon nichts; wer automatisiert, schreibt die Adresse direkt. |
| Fehlgeschlagene Läufe als gesehen markieren | Ein Zustand der Anzeige in der Oberfläche, kein Zustand des Proxys. |
| Live-Kennzahlen (Sekundenwerte) | Noch nicht: daran wird parallel gearbeitet. `get_traffic_stats` liefert die gespeicherte Zeitreihe. |
| Einrichtungsassistent | Läuft einmal, vor dem ersten Key. |

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
  jedes davon den Actor weiterreicht, das Warten in `get_run`,
  `get_update_run` und `get_backup_run`, und dass `update_settings` weder
  Adresse noch SMTP-Passwort kennt.
- `tests/mcp/actions.test.ts`: die gemeinsamen Funktionen, soweit sie einem
  Key etwas verweigern (Adresse, SMTP-Passwort, EAB, hochgeladene
  Zertifikate) und den Bestandteil eines Updates prüfen.
- `tests/security/internal-updates-api.test.ts`: Updates und Sicherung über
  die API laufen unter dem Namen des Keys.
- `tests/security/mcp-api.test.ts`: Reihenfolge der Anmeldung in der Route.

Ein echter Lauf (Zertifikat, Reload) braucht HAProxy und acme.sh und geht nur
im Stack.
