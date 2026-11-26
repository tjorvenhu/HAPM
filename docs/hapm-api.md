# Die interne API außerhalb des Reverse-Proxys

`/api/internal/**` ohne `haproxy/`: Updates, Sicherung, Einstellungen von
HAPM, GeoIP-Tabelle, Systemstatus, der Container von HAProxy, die
DNS-Zonen und das Protokoll. Dazu unter `/api/internal/haproxy/` die Teile, die nicht zu einem
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
| `GET /health` | das Urteil für eine Überwachung: 200 oder 503, siehe „Überwachung“ |
| `GET /metrics` | dasselbe als Metriken im Textformat von Prometheus |
| `GET /system/haproxy` | der Container von HAProxy; `?logs=1` samt 200 Zeilen Ausgabe |
| `POST /system/haproxy` | `{ "action": "restart" }`: Neustart, Antwort mit dem Zustand danach |
| `GET /updates` | Stand je Bestandteil, letzte Läufe, Schalter; `?check=1` prüft vorher |
| `POST /updates/<component>` | Update von `haproxy`, `hapm` oder `acme` → `{ runId }` |
| `GET /updates/runs/<id>` | Stand eines Update-Laufs: `status`, `steps`, `log` |
| `GET /backup` | Einstellungen, Läufe, Archive im Ordner. `settings.encrypted` sagt, ob mit einem Sicherungsschlüssel verschlüsselt wird |
| `PATCH /backup` | Teil-Patch: `enabled`, `hostPath`, `time`, `keep`. Den Sicherungsschlüssel ändert er nicht |
| `POST /backup` | Sicherung jetzt → `{ runId }` |
| `GET /backup/runs/<id>` | Stand eines Sicherungslaufs |
| `GET /sync` | Abgleich zwischen Knoten: Rolle, Folgeknoten mit Zustand, Läufe ([`hochverfuegbarkeit.md`](hochverfuegbarkeit.md)) |
| `POST /sync` | „Jetzt abgleichen", nur auf einem Hauptknoten → `{ runId }` |
| `GET /sync/runs/<id>` | Stand eines Laufs des Abgleichs |
| `GET /settings` | `{ settings, notifications }`, ohne SMTP-Passwort (`smtpPassSet`) |
| `PATCH /settings` | Teil-Patch wie `/api/settings`, ohne `publicUrl`, `smtpPass` und den SMTP-Server (`smtpHost`, `smtpPort`, `smtpSecurity`, `smtpUser`). Dazu gehört `dnsWait`: Sekunden, die acme.sh bei DNS-01 über `dns_nsupdate` oder `dns_infoblox` nach dem TXT-Eintrag wartet (5 bis 900) |
| `PUT /settings/certificates` | `source`, `acmeDirectory`, `httpReachable`, ohne EAB-Schlüssel |
| `GET /settings/address?domain=` | Prüfung einer neuen Adresse für HAPM, nur lesend |
| `POST /mail/test` | `{ "to": "…" }`: Testmail, fünf je zehn Minuten und Key |
| `GET /geoip` | Stand der Länder-Tabelle |
| `PATCH /geoip` | `{ "autoRefresh": true }` |
| `POST /geoip/refresh` | jetzt von db-ip.com holen, wartet (Sekunden) |
| `GET /dns/zones` | angebundene Zonen und ob ihr Zugang geht |
| `GET /audit` | das Protokoll: `?from=` `?to=` `?actor=` `?area=` `?q=` `?limit=`, weiter mit `?before=` oder `?after=` |
| `GET /haproxy/stats` | Zeitreihe aus der Datenbank, `?hours=` `?scope=` |
| `GET /haproxy/log` | letzte Zeilen des Logs, `?lines=` `?filter=` `?q=` |
| `GET /haproxy/base-config` | Abgleich mit der Grundkonfiguration |
| `POST /haproxy/base-config` | `{ "ids": [...] }` übernehmen, synchron mit Schritten |
| `GET /haproxy/error-pages` | Fehlerseiten und ihr Stand zum gespeicherten Design |
| `POST /haproxy/error-pages` | im gespeicherten Design neu schreiben, synchron |
| `DELETE /haproxy/certificates?domain=` | ein Zertifikat von acme.sh entfernen, das kein Ziel hält |
| `POST /haproxy/certificates/issue` | `{ "mainDomain": "…" }`: nie ausgestellten Antrag erneut stellen → `{ runId }` |
| `GET /haproxy/certificate-authorities` | hinterlegte Zertifizierungsstellen für die Prüfung der Ziele, samt „benutzt von" |
| `POST /haproxy/certificate-authorities` | `{ "name": "…", "certificate": "PEM", "replace"?: true }`: hinterlegen oder ersetzen, synchron |
| `DELETE /haproxy/certificate-authorities?name=` | eine Stelle entfernen, die kein Ziel benutzt |

Die Antworten sind Feld für Feld die der Routen hinter der Oberfläche
(`/api/updates`, `/api/backup`, `/api/settings`, …). Wer die Form eines Feldes
sucht, findet sie in der jeweiligen Funktion.

## Überwachung

Zwei lesende Endpunkte für Werkzeuge, die HAPM von außen beobachten. Beide
rechnen aus derselben Übersicht wie `GET /system` (`lib/system/monitoring.ts`)
und brauchen ein Token wie jede Route hier. Ohne Token antwortet nur
`/api/health`: das ist der Healthcheck des Containers und sagt allein, ob der
Prozess läuft.

### `GET /health`

```bash
curl -H "Authorization: Bearer hapm_…" https://hapm.example.org/api/internal/health
```

```json
{
  "success": true,
  "data": {
    "status": "warn",
    "generatedAt": "2026-11-26T12:00:00.000Z",
    "version": "0.7.0",
    "checks": [
      { "id": "haproxy", "status": "ok", "message": null },
      { "id": "targets", "status": "warn", "message": "Ein Ziel hat kein erreichbares Backend." }
    ]
  }
}
```

**Der Statuscode ist das Urteil:** 200 bei `ok` und `warn`, 503 bei `fail`.
Mit `?strict=1` ist auch `warn` ein 503. Die Meldungen kommen in der Sprache
der Anfrage (`Accept-Language`).

| Prüfung | `fail` | `warn` |
|---|---|---|
| `bootstrap` | Einrichtung beim Start gescheitert | läuft noch |
| `docker` | Engine nicht erreichbar | |
| `haproxy` | Container steht, fehlt oder meldet sich nicht bereit | |
| `targets` | | Ziel ohne oder mit nur einem Teil der Backends |
| `certificates` | ein Zertifikat ist abgelaufen | läuft bald ab, Erneuerung überfällig, Ablauf nicht lesbar |
| `renewal` | | die letzte tägliche Erneuerung meldet einen Fehler |
| `scheduler` | Zeitplan läuft nicht | Abruf der Statistik gescheitert |
| `runs` | | gescheiterter Vorgang, den niemand abgehakt hat |
| `crowdsec` | | CrowdSec oder Bouncer steht, obwohl Ziele ihn benutzen. Fehlt, wenn kein Ziel CrowdSec benutzt |
| `backup` | | letzte Sicherung gescheitert oder älter als 50 Stunden. Fehlt ohne tägliche Sicherung |
| `audit_forwarding` | | die Weiterleitung des Protokolls an ein SIEM scheitert. Fehlt, wenn kein Ziel eingeschaltet ist |

- **`fail` heißt: der Proxy selbst arbeitet nicht.** Ein Ziel ohne Backend ist
  deshalb nur `warn`: das Backend ist kaputt, nicht der Proxy, und wer daran
  auf einen zweiten Knoten umschaltete, nähme alle Ziele mit, die laufen.
- **`unknown` ist nicht `ok`.** Was nicht zu erfahren war (Docker-Socket weg,
  Konfiguration nicht lesbar), steht als `unknown` da und zieht das
  Gesamturteil auf `warn`.
- Die Namen der Prüfungen bleiben, neue können dazukommen.

### `GET /metrics`

Text im Format von Prometheus (`lib/system/metrics.ts`), nicht die Hülle
`{ success, data }`. Ein Job dafür:

```yaml
scrape_configs:
  - job_name: hapm
    scheme: https
    metrics_path: /api/internal/metrics
    authorization:
      credentials: hapm_…
    static_configs:
      - targets: ['hapm.example.org']
```

| Metrik | Bedeutung |
|---|---|
| `hapm_info{version}` | immer 1 |
| `hapm_health_status` | Gesamturteil: 0 `ok`, 1 `warn`, 2 `fail` |
| `hapm_check_status{check,status}` | je Prüfung und Zustand, 1 beim aktuellen |
| `hapm_docker_up`, `hapm_haproxy_up`, `hapm_scheduler_up`, `hapm_log_follower_connected` | 1 oder 0 |
| `hapm_container_running{container}`, `hapm_container_restarts{container}`, `hapm_container_start_time_seconds{container}` | HAProxy, mit CrowdSec im Stack auch `crowdsec` und `crowdsec-bouncer` |
| `hapm_targets{kind}`, `hapm_targets_checked`, `hapm_targets_unhealthy{state}` | Ziele (`service`) und TCP-Weiterleitungen (`stream`), davon `down` und `partial` |
| `hapm_target_unhealthy{target,kind,state}` | je Ziel ohne oder mit einem Teil der Backends, sonst keine Zeile |
| `hapm_certificates`, `hapm_certificates_due` | Zertifikate, davon fällig |
| `hapm_certificate_expiry_timestamp_seconds{domain,source}` | Ablauf je Zertifikat, `source` ist `acme` oder `uploaded` |
| `hapm_certificate_renewal_ok` | Ergebnis des letzten täglichen Laufs |
| `hapm_runs_failed`, `hapm_runs_running` | Vorgänge am Reverse-Proxy |
| `hapm_update_available{component}` | 1, wenn es ein neueres Abbild gibt |
| `hapm_stats_last_run_timestamp_seconds` | wann die Zähler von HAProxy zuletzt gelesen wurden |
| `hapm_backup_enabled`, `hapm_backup_last_success_timestamp_seconds`, `hapm_backup_last_run_ok` | Sicherung |
| `hapm_audit_forward_failing{destination}`, `hapm_audit_forward_backlog{destination}` | Weiterleitung des Protokolls je eingeschaltetem Ziel (`syslog`, `http`) |
| `hapm_crowdsec_active_decisions`, `hapm_crowdsec_protected_targets` | CrowdSec, nur wenn der Stack es mitbringt |

- **Unbekannt fehlt, statt 0 zu sein.** `hapm_haproxy_up 0` heißt, HAProxy
  steht. Fehlt die Zeile, war es nicht zu erfahren: dafür `absent(hapm_haproxy_up)`
  oder `hapm_check_status{status="unknown"} == 1`.
- Ein Zertifikat, das in 14 Tagen abläuft:
  `hapm_certificate_expiry_timestamp_seconds - time() < 14 * 86400`.
- **Die Zahlen des Verkehrs stehen hier nicht.** HAPM führt davon Minutenwerte
  (`GET /haproxy/stats`). Wer Anfragen und Antwortzeiten in Prometheus will,
  nimmt den Exporter, den HAProxy mitbringt.
- Namen und Labels bleiben: fremde Regeln und Tafeln hängen daran.

## Das Protokoll abholen

`GET /audit` liefert `{ entries, cursor, more }`, ohne Angaben das Neueste
zuerst. Ein SIEM, das nichts verpassen will, liest aufsteigend:

```bash
# Erster Abruf: vom Ältesten an (oder ab einem Zeitpunkt mit ?from=).
curl -H "Authorization: Bearer $KEY" "https://hapm.example.org/api/internal/audit?order=asc&limit=500"
# Jeder weitere: was seit dem letzten cursor dazukam.
curl -H "Authorization: Bearer $KEY" "https://hapm.example.org/api/internal/audit?after=$CURSOR&limit=500"
```

Aufsteigend endet die Antwort anderthalb Sekunden vor jetzt, damit jeder
Eintrag genau einmal kommt. Kam nichts Neues, ist `cursor` der alte. Die
Felder eines Eintrags, die Bereiche und der Grund für die Lücke am Rand
stehen in [`protokoll.md`](protokoll.md), „Lesen". Statt abzuholen kann HAPM
auch selbst schicken (Syslog, HTTP-Endpunkt): das wird in der Oberfläche
eingerichtet.

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
- Das Protokoll nur lesen: Aufbewahrung, Weiterleitung an ein SIEM und Export
  gibt es nur in der Oberfläche. Ein Key, der sie ändern könnte, räumte hinter
  sich auf.
- Kein Zurückspielen einer Sicherung, kein Sicherungsschlüssel (setzen, ändern,
  entfernen: nur in der Oberfläche, mit dem Passwort des Kontos), keine
  Benutzer, Passwörter, Passkeys, zweiter Faktor, API-Keys, DNS-Tokens, Design
  der Fehlerseiten, Darstellung.
- Beim Abgleich zwischen Knoten nur Lesen und Anstoßen: Rolle,
  Kopplungsschlüssel und Folgeknoten ändert nur die Oberfläche.
- Auf einem Folgeknoten lehnt jede Route, die am Proxy etwas ändert, mit `409`
  ab (`lib/sync/role.ts`): geändert wird am Hauptknoten.

## Für den, der die Routen ändert

- **Jede Route ruft eine Funktion, die die Oberfläche auch ruft**, und die
  schreibende Funktion schreibt ihr Protokoll selbst. Sie stehen in
  `lib/updates/actions.ts`, `lib/backup/actions.ts`, `lib/settings-actions.ts`,
  `lib/haproxy/certificate-actions.ts`, `lib/haproxy/ca-actions.ts`, `lib/haproxy/maintenance-actions.ts`,
  `lib/haproxy/log-read.ts`, `lib/system/haproxy-container.ts`,
  `lib/geoip/actions.ts`, `lib/audit-log/read.ts` und `lib/sync/actions.ts`. Vorher stand die Logik in den Routen unter
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
