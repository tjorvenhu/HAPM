# Die interne API außerhalb des Reverse-Proxys

`/api/internal/**` ohne `haproxy/`: Updates, Sicherung, Einstellungen von
HAPM, GeoIP-Tabelle, Systemstatus, der Container von HAProxy und die
DNS-Zonen. Dazu unter `/api/internal/haproxy/` die Teile, die nicht zu einem
Ziel gehören: Grundkonfiguration, Fehlerseiten, Log, Statistik, Zertifikate
entfernen und erneut beantragen.

Zugang, Antwortform, Fehler und Bindung an Adressen sind dieselben wie bei der
[Reverse-Proxy-API](reverse-proxy-api.md) („Zugang", „Antwortform"). Es sind
**dieselben Keys**; ein Key hat keine Bereiche und darf alles, was hier steht.
Jedes Werkzeug des [MCP-Servers](mcp.md) ruft dieselbe Funktion wie eine Route
hier, die Tabelle dort sagt, welche.

## Endpunkte

| Endpunkt | Was er tut |
|---|---|
| `GET /system` | die Übersicht wie auf der Startseite (`systemOverview`) |
| `GET /system/haproxy` | der Container von HAProxy; `?logs=1` samt 200 Zeilen Ausgabe |
| `POST /system/haproxy` | `{ "action": "restart" }`: Neustart, Antwort mit dem Zustand danach |
| `GET /updates` | Stand je Bestandteil, letzte Läufe, Schalter; `?check=1` prüft vorher |
| `POST /updates/<component>` | Update von `haproxy`, `hapm` oder `acme` → `{ runId }` |
| `GET /updates/runs/<id>` | Stand eines Update-Laufs: `status`, `steps`, `log` |
| `GET /backup` | Einstellungen, Läufe, Archive im Ordner. `settings.encrypted` sagt, ob mit einem Sicherungsschlüssel verschlüsselt wird |
| `PATCH /backup` | Teil-Patch: `enabled`, `hostPath`, `time`, `keep`. Den Sicherungsschlüssel ändert er nicht |
| `POST /backup` | Sicherung jetzt → `{ runId }` |
| `GET /backup/runs/<id>` | Stand eines Sicherungslaufs |
| `GET /settings` | `{ settings, notifications }`, ohne SMTP-Passwort (`smtpPassSet`) |
| `PATCH /settings` | Teil-Patch wie `/api/settings`, ohne `publicUrl`, `smtpPass` und den SMTP-Server (`smtpHost`, `smtpPort`, `smtpSecurity`, `smtpUser`) |
| `PUT /settings/certificates` | `source`, `acmeDirectory`, `httpReachable`, ohne EAB-Schlüssel |
| `GET /settings/address?domain=` | Prüfung einer neuen Adresse für HAPM, nur lesend |
| `POST /mail/test` | `{ "to": "…" }`: Testmail, fünf je zehn Minuten und Key |
| `GET /geoip` | Stand der Länder-Tabelle |
| `PATCH /geoip` | `{ "autoRefresh": true }` |
| `POST /geoip/refresh` | jetzt von db-ip.com holen, wartet (Sekunden) |
| `GET /dns/zones` | angebundene Zonen und ob ihr Zugang geht |
| `GET /haproxy/stats` | Zeitreihe aus der Datenbank, `?hours=` `?scope=` |
| `GET /haproxy/log` | letzte Zeilen des Logs, `?lines=` `?filter=` `?q=` |
| `GET /haproxy/base-config` | Abgleich mit der Grundkonfiguration |
| `POST /haproxy/base-config` | `{ "ids": [...] }` übernehmen, synchron mit Schritten |
| `GET /haproxy/error-pages` | Fehlerseiten und ihr Stand zum gespeicherten Design |
| `POST /haproxy/error-pages` | im gespeicherten Design neu schreiben, synchron |
| `DELETE /haproxy/certificates?domain=` | ein Zertifikat von acme.sh entfernen, das kein Ziel hält |
| `POST /haproxy/certificates/issue` | `{ "mainDomain": "…" }`: nie ausgestellten Antrag erneut stellen → `{ runId }` |

Die Antworten sind Feld für Feld die der Routen hinter der Oberfläche
(`/api/updates`, `/api/backup`, `/api/settings`, …). Wer die Form eines Feldes
sucht, findet sie in der jeweiligen Funktion.

## Update von HAPM

`POST /updates/hapm` ersetzt den Container, der die Anfrage beantwortet. Die
Antwort mit `runId` kommt noch, danach ist die API etwa eine Minute nicht
erreichbar. Der alte Prozess übergibt an einen Helfer und schließt den Lauf
nicht; der neue Container schließt ihn beim Start (`reconcileUpdateRuns` in
`lib/updates/apply.ts`) mit `success` oder `error`. Ein Aufrufer pollt also
`GET /updates/runs/<runId>`, nimmt Verbindungsfehler eine Weile hin und liest
dann das Ergebnis. Kam nach zehn Minuten kein neuer Container, schließt
`expireStaleUpdateRuns` den Lauf als gescheitert.

Es läuft immer nur ein Update (`409`). Ein Update ohne neueres Abbild endet
mit „ist schon das laufende Abbild"; vorher `GET /updates?check=1` fragen.

## Was ein Key hier nicht darf

Die Gründe stehen in [`mcp.md`](mcp.md), „Was es bewusst nicht gibt". Kurz:

- `PATCH /settings` lehnt `publicUrl` ab (der Umzug ändert die Adresse der API
  und löscht alle Passkeys), `smtpPass` (ein Geheimnis) und den SMTP-Server
  (`smtpHost`, `smtpPort`, `smtpSecurity`, `smtpUser`): wer ihn umstellt,
  bekäme das gespeicherte Passwort bei der nächsten Anmeldung dort und die
  Mails zum Zurücksetzen eines Passworts, also ein Konto.
- `PUT /settings/certificates` lehnt `eabKeyId` und `eabHmacKey` ab.
- `DELETE /haproxy/certificates` nimmt nur `?domain=` (acme.sh), kein
  hochgeladenes Zertifikat: Hochladen geht nur in der Oberfläche.
- `GET /settings/address` prüft nur. Den Stand eines laufenden Umzugs liest
  die API nicht: wer ihn liest, gibt das alte Ziel zum Entfernen frei
  (`readAddressMoveView`), und das soll das Fenster tun, das umzieht.
- Kein Zurückspielen einer Sicherung, kein Sicherungsschlüssel (setzen, ändern,
  entfernen: nur in der Oberfläche, mit dem Passwort des Kontos), keine
  Benutzer, Passwörter, Passkeys, zweiter Faktor, API-Keys, DNS-Tokens, Design
  der Fehlerseiten, Darstellung.

## Für den, der die Routen ändert

- **Jede Route ruft eine Funktion, die die Oberfläche auch ruft**, und die
  schreibende Funktion schreibt ihr Protokoll selbst. Sie stehen in
  `lib/updates/actions.ts`, `lib/backup/actions.ts`, `lib/settings-actions.ts`,
  `lib/haproxy/certificate-actions.ts`, `lib/haproxy/maintenance-actions.ts`,
  `lib/haproxy/log-read.ts`, `lib/system/haproxy-container.ts` und
  `lib/geoip/actions.ts`. Vorher stand die Logik in den Routen unter
  `app/api/`; dort steht jetzt nur noch Anmeldung, Rumpf und Aufruf.
- **Der Actor ist `{ ...serviceActor(service), ip: getClientIP(request) }`**,
  bei Läufen am Reverse-Proxy `haproxyActor(serviceActor(service), request)`.
  `tests/security/internal-api.test.ts` verlangt `serviceActor` in jeder
  schreibenden Datei und `requireServiceToken(request)` vor allem anderen.
- **Lesende Routen schreiben kein Audit**, wie im Reverse-Proxy-Baum. „Jetzt
  prüfen" bei den Updates ist deshalb `GET /updates?check=1` und kein POST:
  es ändert nur den gespeicherten Stand und steht auch in der Oberfläche
  nicht im Protokoll.
- **Was ein Key nicht darf, lehnt die Funktion ab, nicht die Route**
  (`readServiceSettingsInput`, `allowEab`, `allowUploaded`): so gilt es für
  API und MCP gleich.
