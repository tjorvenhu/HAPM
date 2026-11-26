# Protokoll

**Lies das, bevor du an `lib/audit.ts`, `lib/audit-log/`, `lib/db/audit-query.ts`,
`app/(app)/protokoll/`, `app/api/audit/` oder `app/api/internal/audit/` etwas änderst.**

Das Protokoll hält fest, wer was wann getan hat: jede Anmeldung, jede Änderung an
HAPM, jeder Lauf, den der Scheduler von selbst beginnt. Geschrieben wird es von
`logAudit` (`lib/audit.ts`) in die Collection `audit_logs`. Dieses Dokument
beschreibt, wie es gelesen, exportiert, weitergeleitet und aufgeräumt wird.

Was HAProxy an Anfragen sieht, ist etwas anderes und steht unter „Logs"
(`lib/haproxy-log.ts`). Was HAPM an HAProxy geändert hat, mit Schritten, steht
dort unter „Vorgänge" (`haproxy_runs`). Das Protokoll ist die eine Liste über
alles, auch über das, was kein Lauf ist: Anmeldungen, Konten, API-Keys,
Einstellungen.

## Wo was liegt

| Datei | Wofür |
|---|---|
| `lib/audit.ts` | `logAudit`, die Namen der Handlungen (`AuditAction`), wer der Aufrufer ist (`getClientIP`) |
| `lib/audit-log/labels.ts` | je Handlung ein Text und ein Bereich. Rein, die Seite lädt es |
| `lib/audit-log/read.ts` | `readAuditLog`: die eine Lesefunktion für Seite, API, MCP |
| `lib/db/audit-query.ts` | das SQL dazu: Filter, Suche, Blättern über die Kennung, Zählen |
| `lib/audit-log/export.ts` | CSV und JSON Lines als Strom |
| `lib/audit-log/settings.ts` | Aufbewahrung und Ziele der Weiterleitung, mit Prüfung |
| `lib/audit-log/options.ts` | Auswahlmöglichkeiten und Grenzen. Rein |
| `lib/audit-log/format.ts` | RFC 5424, Rahmung, JSON, CEF, Splunk HEC. Rein |
| `lib/audit-log/transport.ts` | UDP, TCP, TLS, HTTP(S). Nur Node, kein Kommando |
| `lib/audit-log/forward.ts` | die Weiterleitung: Marke, Reihenfolge, Wiederholung, Zustand |
| `lib/audit-log/kick.ts` | der Anstoß von `logAudit` an die Weiterleitung |
| `lib/audit-log/actions.ts` | was die Seite ändert, jeweils mit Zeile im Protokoll |

## Eine neue Handlung

1. Den Namen in `AuditAction` (`lib/audit.ts`) ergänzen. Fehlschläge enden auf
   `_failed`, Abweisungen auf `_rejected`: daran hängen die rote Marke in der
   Tabelle, `outcome` in API und Export und die Dringlichkeit der
   Syslog-Nachricht (`isFailure`).
2. In `AUDIT_ACTIONS` (`lib/audit-log/labels.ts`) Text und Bereich eintragen.
   Ohne die Zeile übersetzt TypeScript nicht (`Record<AuditAction, …>`).
3. Den Text in `lib/i18n/en/audit.ts` übersetzen.

`tests/audit-log/labels.test.ts` liest die Namen aus dem Quelltext von
`lib/audit.ts` und prüft, dass keiner ohne Text und Übersetzung ist.

Die `details` eines Eintrags bleiben deutsch und werden nie übersetzt
([`i18n.md`](i18n.md), „Was nicht übersetzt wird"): es ist eine Aufzeichnung,
und sie soll für jeden Leser dieselbe sein. Sie sind auf 2000 Zeichen
begrenzt. Geheimnisse gehören nicht hinein.

## Lesen: `readAuditLog`

Seite (`GET /api/audit`), interne API (`GET /api/internal/audit`) und das
MCP-Werkzeug `list_audit_log` rufen dieselbe Funktion mit denselben
Parametern, geprüft von `readAuditQuery`:

| Parameter | Bedeutung |
|---|---|
| `from`, `to` | Zeitraum, ISO 8601, beide Grenzen eingeschlossen |
| `actor` | `user` (Konto), `service` (API-Key) oder `system` (Scheduler) |
| `area` | ein Bereich aus `AUDIT_AREAS`, etwa `auth`, `proxy`, `backup` |
| `q` | Text, ohne Rücksicht auf Groß und Klein, in Wer, Handlung, Gegenstand, Einzelheiten, Adresse |
| `limit` | 1 bis 1000, ohne Angabe 50 |
| `before` | Kennung: Einträge, die älter sind (absteigend) |
| `after` | Kennung: Einträge, die neuer sind (aufsteigend) |
| `order` | `desc` (Vorgabe) oder `asc` |

Die Antwort: `{ entries, cursor, more }`. Ein Eintrag trägt `id`, `timestamp`
(UTC), `action`, `area`, `actorType`, `actor`, `actorId`, `resource`,
`resourceId`, `details`, `ip` und `outcome` (`success` oder `failure`).

- **Geblättert wird über die Kennung, nicht über eine Seitenzahl.** Im
  Protokoll kommt ständig etwas dazu, ein `OFFSET` verschöbe sich beim Lesen.
  Die Kennung ist UUIDv7 und ordnet sich nach der Zeit der Entstehung.
- **Wer aufsteigend liest, bekommt jeden Eintrag genau einmal.** Die Kennung
  entsteht vor dem Einfügen, zwei gleichzeitige Einträge können deshalb in
  umgekehrter Reihenfolge ankommen. Aufsteigend endet die Antwort
  `SETTLE_MS` (1,5 Sekunden) vor jetzt: davor kommt nichts mehr dazu. Ein SIEM
  reicht den `cursor` der Antwort als `after` in die nächste Anfrage. Kam
  nichts Neues, ist der `cursor` der alte.
- **Wer gehandelt hat, steht in `userId`:** `system`, `service:<Kennung des
  Keys>`, sonst die Kennung eines Kontos. Leer bei einer Anmeldung, die kein
  Konto fand. `actorType` leitet sich daraus ab.
- **Die Suche ist kein Muster.** `%` und `_` im Suchtext sind Zeichen
  (`likePattern`). Jeder Wert geht als Parameter in die Anweisung, nie in
  ihren Text (`tests/db/audit-query.test.ts`).
- Die Abfrage steht als eigenes SQL in `lib/db/audit-query.ts` und nicht über
  `listDocuments`: die Fassade kann mit Absicht kein ODER, kein Zählen und
  keine Suche im Text (`lib/db/driver.ts`).

## Export

`POST /api/audit/export` mit `{ format: 'csv' | 'jsonl', …Filter }` liefert
die gefilterten Einträge vom ältesten zum jüngsten als Datei.

- **POST und nicht GET:** der Export schreibt selbst eine Zeile ins Protokoll
  (`audit_exported`, mit Format und Filter), und was schreibt, verlangt den
  CSRF-Token.
- **Gestreamt, tausend Einträge je Abfrage.** Ein Jahr Protokoll steht weder
  im Speicher des Servers noch in einer Abfrage. Der Export endet an dem
  Eintrag, der beim Start der jüngste feste war.
- **CSV für Excel:** UTF-8 mit BOM, Zeilenende CRLF, jede Zelle in
  Anführungszeichen. Der Trenner folgt der Sprache der Anfrage (Deutsch `;`,
  Englisch `,`), weil Excel ihn nach der Sprache des Rechners erwartet. Der
  Zeitpunkt steht als ISO in UTC.
- **Formeln:** eine Zelle, die mit `=`, `+`, `-`, `@`, Tab oder
  Wagenrücklauf beginnt, bekommt ein `'` davor. In `details` steht Text, den
  auch Fremde bestimmen (der Name, mit dem sich jemand anzumelden versucht).
- **JSON Lines** trägt je Zeile dasselbe Objekt wie die API, unübersetzt.

## Weiterleitung an ein SIEM

Zwei Ziele, einzeln einschaltbar, unter „Protokoll", Reiter „Weiterleitung an
SIEM": ein Syslog-Server und ein HTTP-Endpunkt. Dazu der Abruf über die API
(„Lesen"), bei dem das SIEM selbst holt.

### In Reihenfolge und ohne Lücke

Je Ziel steht in `audit_forward_state` eine Marke: die Kennung des letzten
Eintrags, den das Ziel angenommen hat. Ein Durchgang (`runAuditForwarding`)
liest, was danach kommt, schickt es in der Reihenfolge des Protokolls und
setzt die Marke erst nach der Abgabe weiter. Scheitert die Abgabe, bleibt die
Marke stehen.

- **Sofort:** `logAudit` stößt nach dem Schreiben einen Durchgang an
  (`lib/audit-log/kick.ts`). Er beginnt `SETTLE_MS` später, wenn der Eintrag
  als fest gilt.
- **Wiederholung:** nach einem Fehler nach 5, dann 15, dann alle 60 Sekunden.
  Der Scheduler ruft zusätzlich jede Minute nach.
- **Über einen Neustart hinweg:** die Marke steht in der Datenbank. Was
  während des Stillstands liegen blieb, geht beim Start hinaus.
- **Mindestens einmal, nicht genau einmal:** stürzt HAPM zwischen Abgabe und
  Marke ab, kommt ein Eintrag doppelt. Jeder trägt seine Kennung (`id`), an
  der ein SIEM Doppelte erkennt.
- **Ab dem Einschalten:** die Marke beginnt bei „jetzt". Das Protokoll von
  vorher geht nicht hinaus, dafür gibt es den Export.
- **Verloren geht nur, was die Aufbewahrung löscht, bevor das Ziel es
  annimmt.** Hält eine Störung länger als 15 Minuten an, geht eine Mail hinaus
  (Ereignis `audit_forward_failed`, abschaltbar unter „Benachrichtigungen").
- **Der Anstoß hängt nicht an `lib/audit.ts`.** `kick.ts` hält nur einen Platz
  für eine Funktion, die der Scheduler beim Start einträgt
  (`startAuditForwarding`). Ohne ihn (Tests, `hapm-admin`) stößt ein Eintrag
  nichts an. Sonst lüde jede Datei, die `logAudit` ruft, Netz und
  Verschlüsselung mit.
- **Ein Zeitgeber, kein verlorener Anstoß.** Kommt ein Anstoß, während ein
  früherer Durchgang schon ansteht, feuert dieser zu früh für den neuen
  Eintrag. `scheduleRun` merkt sich deshalb den spätesten verlangten Zeitpunkt
  (`runAfter`) und setzt nach dem Durchgang noch einmal an.

Die Seite zeigt je Ziel: letzte Zustellung, Rückstand (gezählt bis 5000),
letzter Fehler. „Testnachricht senden" schickt über das gespeicherte Ziel
einen Eintrag mit der Handlung `audit_forward_test`, der nicht im Protokoll
steht, auch wenn das Ziel nicht eingeschaltet ist.

### Syslog

Nachrichten nach RFC 5424 über UDP, TCP oder TLS:

```
<134>1 2026-11-26T08:15:30.123Z proxy01 hapm - login - {"source":"hapm","host":"proxy01","id":"…","action":"login",…}
```

- **Priorität:** die gewählte Facility (`auth`, `authpriv`, `daemon`,
  `audit`, `local0` bis `local7`), Dringlichkeit `info`, bei einem Fehlschlag
  `warning`.
- **Kopf:** Hostname ist `HAPM_NODE_NAME`, sonst der Name des Servers.
  APP-NAME ist einstellbar (Vorgabe `hapm`), MSGID ist der Name der Handlung.
  Im Kopf steht nur druckbares ASCII.
- **Keine strukturierten Daten:** RFC 5424 verlangt für eigene Elemente eine
  bei der IANA eingetragene Nummer, HAPM hat keine. Die Felder stehen als JSON
  oder CEF im Text.
- **Der Text ist immer eine Zeile.** Jedes Steuerzeichen wird ein Leerzeichen,
  auch NEL, U+2028 und U+2029. Ein Zeilenumbruch in `details` wäre bei einem
  Empfänger, der am Zeilenende trennt, der Anfang einer zweiten, frei
  gewählten Nachricht. JSON maskiert Umbrüche ohnehin.
- **Trennung auf TCP und TLS** (RFC 6587): die Länge in Bytes voran (Vorgabe,
  für rsyslog und syslog-ng) oder ein Zeilenende (Graylog, Splunk). Über UDP
  ist ein Datagramm eine Nachricht.
- **CEF** (`CEF:0|HAPM|HAPM|<Fassung>|<Handlung>|<Text>|<3 oder 6>|…`): der
  Text der Handlung steht auf Deutsch, wie `details`. Woran ein SIEM eine
  Regel hängt, ist die Kennung der Signatur, der Name der Handlung.
- **TLS prüft immer.** Es gibt keinen Schalter „Zertifikat nicht prüfen". Ein
  Empfänger mit einem Zertifikat aus der eigenen PKI bekommt das CA-Zertifikat
  als PEM eingetragen.
- **Was „zugestellt" heißt:** bei UDP ist das Datagramm abgeschickt. Bei TCP
  und TLS hat das Betriebssystem die Bytes angenommen. Syslog kennt keine
  Quittung des Empfängers: eine gerade abgerissene Verbindung fällt erst beim
  nächsten Schreiben auf. Wer jede Nachricht quittiert haben will, nimmt den
  HTTP-Endpunkt.

**Das Zugriffslog von HAProxy** geht per Schalter an denselben Server, mit
dem APP-NAME `haproxy` und der Zeit der Zeile. Eingehängt ist es in den
Mitschnitt (`lib/haproxy-log.ts`, `forwardHaproxyLines`). Bestmöglich: es gibt
keine Marke und keine Wiederholung über einen Neustart. Nimmt der Server
nichts an, warten bis zu 5000 Zeilen im Speicher, ältere fallen weg, und die
Seite sagt, wie viele. Ein Rückstand davon in der Datenbank wäre die Platte,
die vollläuft.

### HTTP-Endpunkt

JSON per POST. Zugestellt heißt: der Endpunkt antwortet mit 2xx.

- **JSON:** je Eintrag eine Anfrage, der Rumpf ist der Eintrag mit `source`
  und `host`. Scheitert der dritte von fünf, steht die Marke hinter dem
  zweiten.
- **Splunk HEC:** für `/services/collector/event`. Ein Stapel in einem Rumpf,
  je Zeile `{ time, host, source, sourcetype: "hapm:audit", event }`.
- **Eine Kopfzeile mit Geheimnis:** Name und Wert sind frei, also
  `Authorization: Splunk <Token>` ebenso wie `Authorization: Bearer <Token>`
  oder `X-Api-Key`. Der Wert liegt verschlüsselt in der Zeile der
  Einstellungen (`lib/crypto.ts`), die Oberfläche erfährt nur, ob einer
  gesetzt ist. Ein Zeilenumbruch im Wert wird abgelehnt: er wäre eine zweite
  Kopfzeile.
- **Keine Weiterleitung:** einer Antwort mit 3xx folgt HAPM nicht, der Wert
  der Kopfzeile geht nur an die eingetragene Adresse.
- `http://` geht (ein Sammler im eigenen Netz), die Seite warnt dann sichtbar.
  Für `https://` mit eigener PKI das CA-Zertifikat als PEM.
- Verschickt wird mit `node:https` und nicht mit `fetch`, weil nur so eine CA
  je Ziel gilt. Ein ausgehender Proxy aus `HTTPS_PROXY` wird dabei nicht
  benutzt: ein SIEM steht im eigenen Netz ([`betrieb.md`](betrieb.md),
  „Ausgehende Verbindungen").

## Aufbewahrung

Unter „Protokoll", Reiter „Aufbewahrung": 30 bis 3650 Tage, Vorgabe 365. Der
tägliche Lauf des Schedulers (`runDaily`) entfernt, was älter ist. Kürzer
stellen verlangt eine Rückfrage, weil es Einträge unwiederbringlich entfernt.

## Was nur mit Sitzung geht

`GET /api/internal/audit` und `list_audit_log` lesen. Aufbewahrung,
Weiterleitung, Testnachricht und Export gibt es nur in der Oberfläche:

- Ein Key, der die Aufbewahrung kürzen oder die Weiterleitung umbiegen
  könnte, räumte hinter sich auf. Das Protokoll ist die Stelle, an der man
  nachliest, was ein gestohlener Key getan hat.
- Der Wert der Kopfzeile ist ein Geheimnis und gehört nicht in ein Skript
  oder in den Verlauf eines Sprachmodells ([`mcp.md`](mcp.md), „Was es bewusst
  nicht gibt").

`tests/security/audit-api.test.ts` hält fest, dass keine Datei unter
`app/api/internal/`, `app/api/mcp/` und `lib/mcp/` diese Funktionen erreicht.

## Tests

- `tests/audit-log/labels.test.ts`: jede Handlung hat Text, Übersetzung und
  Bereich.
- `tests/audit-log/format.test.ts`: RFC 5424, Rahmung, CEF, Steuerzeichen.
- `tests/audit-log/export.test.ts`: CSV-Zellen, Formeln, der Strom in Seiten.
- `tests/audit-log/settings.test.ts`: Prüfung der Ziele, der Kopfzeile und
  des CA-Zertifikats.
- `tests/audit-log/transport.test.ts`: gegen echte Empfänger auf 127.0.0.1
  (UDP, TCP, TLS, HTTP, HTTPS). Für TLS entsteht je Lauf ein selbst signiertes
  Zertifikat mit `openssl`.
- `tests/audit-log/forward.test.ts`: Marke, Reihenfolge, Wiederholung,
  Rückstand, mit ersetzter Datenbank und ersetztem Netz.
- `tests/audit-log/database.test.ts`: von der Route bis zum Empfänger gegen
  ein echtes Postgres (nur mit `TEST_DATABASE_URL`), samt Ausfall und
  Nachliefern.
- `tests/db/audit-query.test.ts`: das SQL ohne Verbindung.
- `tests/security/audit-api.test.ts`: Sitzung, CSRF, und was ein Key nicht
  erreicht.
