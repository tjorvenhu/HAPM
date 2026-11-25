# Betrieb: Container, Ersteinrichtung, Updates

HAPM bringt HAProxy mit. Hier steht, wie die Container zusammenhängen, was beim
ersten Start geschieht und wie Updates, Benachrichtigungen und Sicherung
ablaufen.

## Drei Container, ein Ordner mit Daten

| Container | Abbild | Aufgabe |
|---|---|---|
| `hapm` | `ghcr.io/tjorvenhu/hapm` | Oberfläche, Scheduler, acme.sh, das Kommando `hapm-ctl` |
| `hapm-haproxy` | `haproxy:lts` (offiziell, unverändert) | HAProxy |
| `hapm-postgres` | `postgres:17-alpine` (offiziell, unverändert) | Die Datenbank von HAPM |

Alle Daten liegen in einem Ordner auf dem Server: `HAPM_STORAGE`, ohne Angabe
`data` neben `docker-compose.yml` (mit dem Installationsskript also
`/opt/hapm/data`). Die Container bekommen seine Unterordner einzeln eingebunden:

| Unterordner | In `hapm` | In `hapm-haproxy` | In `hapm-postgres` | Inhalt |
|---|---|---|---|---|
| `hapm/` | `/data` | | | `secrets.json`, Zähler der Anmeldeversuche |
| `haproxy/` | `/etc/haproxy` | `/etc/haproxy` (nur lesend) | | `haproxy.cfg`, `certs/`, `errors/`, `hapm-lock/`, Sicherungen |
| `run/haproxy/` | `/run/haproxy` | `/run/haproxy` | | `admin.sock` (Stats), `master.sock` (Neuladen) |
| `log/` | `/var/log/haproxy` | | | `haproxy.log`, der Mitschnitt für die Statistik |
| `acme/` | `/root/.acme.sh` | | | acme.sh, Konto, Zertifikate, Erneuerungseinträge |
| `postgres/` | | | `/var/lib/postgresql/data` | Die Datenbank: Konten, Sitzungen, Passkeys, Einstellungen, Protokoll, Statistik |
| `run/postgres/` | `/var/run/postgresql` | | `/var/run/postgresql` | Der Unix-Socket von Postgres, sonst nichts |

**Ordner statt Docker-Volumes**, damit auf dem Server sichtbar ist, wo alles
liegt, und damit sich der Ort wählen lässt (eine eigene Platte, ein Ordner, den
ohnehin jemand sichert). Die Sockets liegen mit darin: das geht, weil der
Ordner auf einem Linux-Dateisystem liegt. `docker-compose.dev.yml` und
`scripts/verify/compose.yml` bleiben bei Volumes, unter Docker Desktop trägt ein
eingebundener Ordner des Rechners keinen Unix-Socket.

**`install.sh`** legt den Ordner nur für root lesbar an (dort liegen private
Schlüssel, die Container brauchen den Zugang von außen nicht) und schreibt eine
Kennung hinein (`.hapm-storage`). An ihr erkennt `--uninstall`, dass der Ordner
HAPM gehört. Gelöscht werden dort nur die Unterordner aus der Tabelle: liegt
daneben etwas anderes, etwa ein Ordner mit Sicherungen, bleibt es liegen. Ein
Abbild entfernt `--uninstall` nur, wenn kein anderer Container daraus läuft,
und fragt das vorher ab: trägt ein Abbild zwei Namen, löst `docker image rm`
den einen auch dann, wenn ein fremder Container unter ihm läuft.

**Umzug aus 0.2.0.** Bis dahin lagen die Daten in Docker-Volumes (`hapm_data`,
`hapm_haproxy-etc`, …). Findet `install.sh` das Volume `hapm_postgres-data` und
noch keine Datenbank im Ordner, hält es den Stack an und kopiert die Volumes
hinein, bevor es mit der neuen `docker-compose.yml` startet. Die Volumes bleiben
liegen, bis jemand sie löscht. Wer von Hand aktualisiert (`docker compose pull`
mit neuer `docker-compose.yml`), ohne das Skript, stünde vor einem leeren HAPM.

Dieselben Pfade in HAPM und HAProxy sind der Punkt: `lib/haproxy/` schreibt
`/etc/haproxy/haproxy.cfg.hapm-new` und lässt `haproxy -c -f` darauf laufen,
und das Kommando findet die Datei im anderen Container unter demselben Namen.

**HAPM und HAProxy laufen im Netz des Hosts** (`network_mode: host`). HAProxy, weil eine
TCP-Weiterleitung jeden Port der Maschine belegen kann und ein veröffentlichter
Port ein neu angelegter Container wäre. HAPM, weil acme.sh die HTTP-01-Anfrage
auf `127.0.0.1:8888` annimmt (HAProxy leitet sie dorthin) und weil `ss -Hltn`
die Ports des Servers zeigen muss, nicht die eines Container-Netzes. Das gibt es
nur unter Linux. `docker-compose.dev.yml` stellt dasselbe Bild für Docker
Desktop nach: HAProxy teilt sich das Netz mit dem HAPM-Container.

**HAProxy startet als root** (`user: root` in Compose), um 80 und 443 im Netz
des Hosts zu binden, und gibt die Rechte danach ab (`user haproxy` in der
Konfiguration). Im Netz des Hosts greift die Erleichterung nicht, mit der Docker
sonst unprivilegierten Containern niedrige Ports erlaubt.

## Postgres

Die Anmeldung läuft über Better-Auth (`lib/auth/`, mit Passkeys), und das setzt
eine SQL-Datenbank voraus. Damit es bei einer Datenbank bleibt, liegen auch alle
anderen Daten von HAPM dort (`lib/db/`).

**Kein Netz, kein Port, kein Passwort.** Der Container läuft mit
`network_mode: none`, Postgres lauscht nur auf seinem Unix-Socket
(`listen_addresses=''`). Der Socket liegt im Ordner `run/postgres`, den HAPM
unter demselben Pfad einbindet. Wer den Socket erreicht, ist HAPM, deshalb
`POSTGRES_HOST_AUTH_METHOD: trust`: ein Passwort schützte hier vor niemandem
und wäre nur ein Wert mehr, der in einer Umgebungsvariable steht. Von außen
führt kein Weg zur Datenbank. HAPM läuft als root und darf den Socket deshalb
öffnen, obwohl dessen Verzeichnis dem Benutzer `postgres` gehört.

**Die Hauptversion steht fest** (`postgres:17-alpine`, kein `latest`). Postgres
liest das Datenverzeichnis einer älteren Hauptversion nicht: ein Sprung von 17
auf 18 braucht einen Umzug der Daten (`pg_upgrade`, oder sichern und in eine
leere Datenbank einspielen). Neue Abbilder derselben Hauptversion holt
`docker compose pull`. HAPM aktualisiert Postgres nicht selbst.

**Kleine Werte.** HAPM ist ein Werkzeug mit einer Handvoll Benutzern und einer
Zeile Statistik je Minute und Abschnitt. Postgres läuft deshalb mit
`shared_buffers=32MB`, höchstens 20 Verbindungen, einem Autovacuum-Prozess,
ohne parallele Abfragen und ohne JIT, und HAPM hält höchstens fünf Verbindungen
offen, die sich im Leerlauf nach 20 Sekunden schließen (`lib/db/postgres-driver.ts`).
Im Leerlauf belegt der Container damit rund 25 MiB, während einer Anfrage
kurzzeitig mehr.

**Was HAPM dazu wissen muss**, alles mit Vorgabe:

| Variable | Vorgabe | Wofür |
|---|---|---|
| `HAPM_DATABASE_SOCKET` | `/var/run/postgresql` | Verzeichnis des Sockets |
| `HAPM_DATABASE_NAME`, `HAPM_DATABASE_USER` | `hapm` | Datenbank und Benutzer |
| `HAPM_POSTGRES_CONTAINER` | `hapm-postgres` | Name des Containers, für die Sicherung |
| `DATABASE_URL` | nicht gesetzt | Gewinnt, wenn gesetzt. Für Tests und die Entwicklung ohne Compose (TCP) |

**Tabellen.** Jede Collection aus `lib/types.ts` ist eine Tabelle mit vier
Spalten: Kennung, zwei Zeitstempel und das Dokument als `jsonb`. Ein neues Feld
braucht keine Migration. Wonach gefiltert wird, steht als Ausdrucksindex in
`INDEXES` (`lib/db/sql.ts`). Daneben stehen die sechs Tabellen des
Anmeldedienstes (`auth_*`), ausgeschrieben in `lib/db/auth-tables.ts`. Ein Test
vergleicht sie mit den Definitionen in `lib/auth/core/schema.ts` und sagt im
Kopf der Datei, was zu tun ist, wenn beide auseinanderlaufen. Alle Tabellen
entstehen beim Start, falls sie fehlen.

**Start.** `instrumentation.ts` wartet als Erstes bis zu 60 Sekunden auf
Postgres (`lib/setup-db.ts`) und legt dann die Tabellen an. Compose startet
HAPM zwar erst, wenn Postgres gesund ist, nach einem Neustart des Servers kommt
HAPM aber manchmal zuerst hoch. Antwortet Postgres in der Zeit nicht, steht der
Grund im Log und der Prozess beendet sich: Docker startet ihn neu und versucht
es damit wieder. `/api/health` meldet erst gesund, wenn die Datenbank bereit
ist.

**Prüfen.** Der Treiber wird gegen ein echtes Postgres getestet, sobald
`TEST_DATABASE_URL` gesetzt ist (`tests/helpers/test-database.ts`). Ohne die
Variable werden diese Tests übersprungen und sagen das in einer Zeile.

**Der Notweg.** `docker exec -it hapm hapm-admin users` zeigt die Konten,
`… reset-password <e-mail>` setzt ein neues Passwort, schaltet den zweiten
Faktor ab, entfernt die Passkeys und beendet die Sitzungen des Kontos. Das
Kommando spricht ohne die Oberfläche mit der Datenbank.

## Der Docker-Socket

HAPM bindet `/var/run/docker.sock` ein. Das ist voller Zugriff auf Docker und
damit auf den Host. Gebraucht wird er für drei Dinge, und ohne ihn gibt es keines
davon:

- **Prüfen mit dem HAProxy, das läuft.** `haproxy -c` muss dieselbe Fassung sein,
  die die Datei danach lädt. Also `exec` im HAProxy-Container statt einer zweiten
  Installation im HAPM-Abbild, die bei jedem Update auseinanderliefe.
- **Updates.** Abbild holen, Container ersetzen.
- **Das Log.** HAProxy schreibt auf stdout, HAPM folgt dem Log des Containers.

Die Engine wird nur über `lib/docker/` angesprochen (`engine.mjs`, HTTP über den
Socket, keine Abhängigkeit, kein Docker-CLI im Abbild).

## `hapm-ctl`: prüfen und neu laden

`bin/hapm-ctl.mjs` steht im Abbild hinter zwei Verweisen:

- `/usr/local/bin/haproxy` führt `haproxy <argumente>` im HAProxy-Container aus
  und reicht Ausgabe und Exit-Code durch.
- `/usr/local/bin/hapm-reload` lädt neu. Über den Master-Socket
  (`-S /run/haproxy/master.sock`), denn der antwortet erst, wenn der neue Prozess
  steht oder gescheitert ist, und sagt welches (`Success=1` oder `Success=0` mit
  der Ausgabe des Starts). Ein Signal (`SIGHUP`) wäre nur ein Auftrag ohne
  Antwort und ist der Rückfall, wenn es den Socket nicht gibt. Läuft der
  Container nicht, wird er gestartet.

Beide sind Kommandos und keine Funktionen der Anwendung, weil der Deploy-Hook
von acme.sh sie bei jeder Erneuerung aufruft
(`DEPLOY_HAPROXY_RELOAD='haproxy -c -f … && hapm-reload'`), auch wenn die
Oberfläche gerade etwas anderes tut.

## Ersteinrichtung: `lib/bootstrap.ts`

Läuft bei jedem Start, nachdem die Datenbank bereit ist und bevor der Server
Anfragen annimmt, und tut nur, was fehlt:

1. Verzeichnisse.
2. Fehlerseiten unter `/etc/haproxy/errors` (aus `lib/haproxy/error-pages.ts`).
3. Ein selbst signiertes Zertifikat `certs/000-hapm-default.pem`, wenn das
   Verzeichnis leer ist. HAProxy lädt `crt /etc/haproxy/certs/` als Ganzes und
   startet mit einem leeren Verzeichnis nicht. Der Name sortiert es nach vorn:
   es ist das Zertifikat für Anfragen, zu deren Namen keines passt.
4. `haproxy.cfg` aus `lib/haproxy/base-config.ts`, **nur wenn die Datei fehlt**.
   Danach ist die Datei die Wahrheit. Sie enthält noch keine Gruppe. IPv6 wird
   nur gebunden, wenn die Maschine es hat.
5. acme.sh ins Volume installieren (`--no-cron`, die Erneuerung stößt der
   Scheduler an), Let's Encrypt als Vorgabe, Konto mit der Adresse aus der
   Ersteinrichtung.
6. HAProxy starten, falls sein Container steht.

Der HAProxy-Container wartet in Compose auf `service_healthy` von HAPM, und der
Healthcheck (`/api/health`) antwortet erst nach diesen Schritten. Das Ergebnis
steht in der Übersicht.

Was danach der Benutzer tut, führt der Assistent unter `/setup` (nächster
Abschnitt). Wer ihn überspringt, legt unter „Reverse-Proxy" selbst eine Gruppe
an und in der Gruppe das erste Ziel. Eine Gruppe ist ein Marker-Paar in
`haproxy.cfg`, und jedes Ziel steht in einer. Solange es keine gibt, führen
Übersicht und die Seite „Reverse-Proxy" zum Anlegen der ersten.

### Der Assistent: `/setup`, `lib/setup/`

Sechs Schritte in einer Seite. Nach dem ersten besteht das Konto, alles danach
sind angemeldete Aufrufe unter `/api/setup/*` und darf scheitern oder liegen
bleiben.

1. **Konto** und die Adresse für Let's Encrypt (`POST /api/setup`, ohne Sitzung
   und nur, solange es kein Konto gibt). Die E-Mail-Adresse des Kontos wird
   Empfänger der Benachrichtigungen, bis jemand die Empfänger ändert.
2. **Erreichbarkeit:** nur im eigenen Netz oder aus dem Internet. Die Wahl steht
   sofort in den Einstellungen (`exposure`). An ihr hängt, ob Zertifikate über
   HTTP-01 oder immer über DNS-01 ausgestellt werden, siehe
   [`reverse-proxy.md`](reverse-proxy.md), „Interne Installation".
3. **DNS-Anbieter** (Hetzner, Cloudflare oder „Eigener DNS-Server"). Der Token
   eines Anbieters wird ihm einmal vorgezeigt (`lib/setup/token-check.ts`) und
   geht dann über denselben Weg wie unter Reverse-Proxy, Einstellungen nach
   `account.conf`. Lehnt der Anbieter ihn ab, wird nichts abgelegt.
   **„Eigener DNS-Server"** (`dns: 'manual'`) heißt: HAPM richtet bei keinem
   Anbieter etwas ein und nennt stattdessen die Einträge (Name, Typ, Wert), die
   von Hand gesetzt werden. Die Karte ersetzt „Überspringen", das dasselbe hieß,
   ohne es zu sagen, und intern nicht erlaubt war. Jetzt ist es intern wie
   öffentlich eine Antwort; was intern dann für Zertifikate fehlt, fragt der
   nächste Schritt. Zeilen mit `dns: 'skipped'` aus der Zeit davor gelten
   öffentlich weiter, `PUT /api/setup/dns` nimmt `skip` weiter an.
4. **Zertifikate** (`PUT /api/setup/certificates`): Let's Encrypt, ein eigener
   ACME-Server oder hochladen. Gespeichert wird in den Einstellungen und sofort
   (`certificateSource`, `acmeDirectory`, `acmeHttpReachable`, derselbe Weg wie
   unter „Allgemein", `lib/certificate-settings.ts`); in `setup_state` steht nur,
   dass die Frage beantwortet ist (`certificates: 'set'`). Angeboten wird, was
   mit den Antworten davor geht (`certificatePathOpen`): Let's Encrypt erreicht
   eine interne Installation nur über einen DNS-Anbieter mit API, die Karte ist
   dann gesperrt und sagt warum. Ein eigener Server braucht intern ohne
   DNS-Anbieter den Schalter „erreicht HAPM über HTTP (Port 80)"; er ist in dem
   Fall vorbelegt, und ohne ihn lehnt die Route die Wahl ab. Ein eigener Server
   wird erst übernommen, wenn acme.sh ein Konto bei ihm hat (siehe
   [`reverse-proxy.md`](reverse-proxy.md), „Ein eigener ACME-Server").
   `resumeStep` zählt die Antwort nur, solange sie einen Weg zum Zertifikat
   hat: wer danach auf „intern" umstellt, landet wieder hier.
5. **Adresse der Oberfläche:** die Domain für HAPM, auf Wunsch mit einem
   Wildcard-Zertifikat für die Basis darüber. Die Basis ist kein Feld, sondern
   immer die Domain eine Ebene über der Oberfläche (`wildcardBaseOf`: aus
   `hapm.example.org` wird `*.example.org`). Eine andere Basis deckte die
   Oberfläche nicht ab, und das Feld änderte fast nie jemand. Liegt die Domain
   direkt unter der Top-Level-Domain, fehlt der Schalter. Die Seite zeigt den DNS-Eintrag
   auf diesen Server und legt ihn auf Knopfdruck beim Anbieter an
   (`PUT /api/setup/dns-record`). Bei einer internen Installation sagt sie,
   dass der Eintrag in den DNS-Server des eigenen Netzes gehört. Sie fragt das
   DNS, worauf die Domain zeigt, und sagt das Ergebnis. Aufgehalten wird damit
   niemand.
   Die Wildcard gibt es nur über ACME mit einem DNS-Anbieter
   (`wildcardPossible`); hochgeladen wird, was das Zertifikat abdeckt.
6. **Ausführen** (`lib/setup/run.ts`): Gruppe `HAPM`, Zertifikat, Ziel `hapm`
   auf `127.0.0.1:<PORT>`, `publicUrl`. Jeder Schritt ist ein gewöhnlicher Lauf
   mit derselben Vorabprüfung wie in der Oberfläche und steht in der Historie.
   **Bei „nur hochladen" stellt der Schritt das Zertifikat nicht aus**, er kann
   es nicht. Er zeigt stattdessen, ob eins die Domain abdeckt
   (`SetupView.presentCertificate`, nur dann gelesen, weil es ein
   `acme.sh --list` kostet), und bietet das Hochladen an, mit demselben Dialog
   wie die Zertifikatsseite. „Jetzt einrichten" ist gesperrt, bis eins da ist,
   und der Schritt „Zertifikat ausstellen" scheitert mit derselben Auskunft,
   falls jemand die Route direkt ruft.

**Das Token liegt für die Dauer der Einrichtung beim Assistenten**
(`SetupState.dnsAccess`, verschlüsselt wie die Tokens der Zonen). Der Grund ist
die Reihenfolge: das Token kommt in Schritt 3, die Domain in Schritt 4, und
erst mit der Domain steht fest, welche Zone gemeint ist. Mit dem Speichern der
Adresse richtet der Assistent diese Zone unter „DNS" ein (`connectZone`), wo
das Token danach wie bei jeder Zone liegt, und der Knopf setzt den Eintrag über
denselben Weg wie die Seite dort (`ensureAddressRecord`). Der Wert des
Eintrags kommt aus dem Formular: hinter einer Adressumsetzung trägt der Server
seine öffentliche Adresse nicht selbst. `getSetupState` liest das Feld nicht,
es erreicht den Browser also nie, und mit dem Ende der Einrichtung
(abgeschlossen oder übersprungen) wird es gelöscht. Ein übernommener Hook
(„Mit Cloudflare weiter") bringt kein Token mit: dann gibt es den Knopf nicht.

**Der Zustand liegt in der Datenbank**, in einer Zeile der Collection
`setup_state`: Art, gewählter Hook, Domain, Wildcard und der Stand des
Ausführens. Welcher Schritt dran ist, wird daraus abgeleitet (`resumeStep`) und
nicht gespeichert. Ein Neuladen oder eine Rückkehr nach Tagen landet deshalb
dort, wo noch etwas fehlt.

**Scheitern ist kein Ende.** Jeder Schritt des Ausführens fragt zuerst die
Maschine, ob er schon getan ist. Nach einem falschen Token wird dieselbe Folge
noch einmal gestartet, und Gruppe oder Zertifikat werden vorgefunden. Die Folge
läuft im Prozess: nach einem Neustart von HAPM gilt sie als abgebrochen und
lässt sich erneut starten.

**Offen, abgeschlossen, übersprungen** (`setupStatus` in den Einstellungen).
Solange die Einrichtung offen ist, steht oben in der Übersicht eine Fläche, die
zurück in den Assistenten führt. Eine Installation, die es vor dem Assistenten
gab, trägt keinen Wert und gilt als abgeschlossen. **Abgeschlossen und
übersprungen sind endgültig**: die Einrichtung lässt sich nicht erneut öffnen
(`/api/setup/status` nimmt nur noch `skipped`, und nur solange sie offen ist).
Was sie eingerichtet hat, ändert man danach an seiner Stelle: Art und Adresse
unter „Allgemein", die Anbindung unter „DNS", das Ziel unter „Reverse-Proxy".

## Updates: `lib/updates/`

**Erkennen** (`check.ts`): alle sechs Stunden und auf Knopfdruck. Für die
Abbilder wird der Digest des Tags in der Registry (`HEAD` auf das Manifest,
anonym) mit dem des lokalen Abbilds verglichen. Geholt wird nichts. Gibt es
einen neuen, liest HAPM aus dessen Beschreibung die Version (`HAPROXY_VERSION`
bzw. das Label `org.opencontainers.image.version`), damit dort „3.4.8 → 3.4.9"
steht. Für acme.sh fragt es die neueste Veröffentlichung bei GitHub.
`updateAvailable: null` heißt unbekannt und wird so angezeigt.

**Einspielen** (`apply.ts`), als abgekoppelter Lauf mit Schritten:

- **HAProxy:** Abbild holen. Dann prüft **das neue Abbild die vorhandene
  Konfiguration** (ein einmaliger Container mit denselben Volumes, ohne Netz).
  Lehnt es sie ab, endet der Lauf und nichts hat sich geändert. Sonst wird der
  Container ersetzt (`replace.mjs`): anhalten, beiseitelegen, neu anlegen mit
  derselben Einrichtung, starten. Steht der neue nach 90 Sekunden nicht, kommt
  der alte zurück. HAProxy ist dabei wenige Sekunden nicht erreichbar.
- **HAPM selbst:** ein Prozess kann den Container, in dem er läuft, nicht
  ersetzen. Er startet aus dem neuen Abbild einen Helfer (`hapm-updater`), der
  nur `hapm-ctl replace` ausführt. Der neue HAPM findet den Lauf beim Start
  offen vor und schließt ihn (`reconcileUpdateRuns`): läuft er in einem anderen
  Abbild als vorher, ist es gelungen.
- **acme.sh:** `acme.sh --upgrade`.

Beim Ersetzen bleibt nur, was am Container eingestellt wurde, nicht was sein
Abbild vorgab (`recreateBody`): sonst stünde im neuen Container
`HAPROXY_VERSION` des alten Abbilds.

HAProxy lässt sich zu einer Uhrzeit selbsttätig aktualisieren (Einstellung unter
„Updates"). Für HAPM selbst gibt es das mit Absicht nicht.

## Das Log

`log stdout format raw local0` in der Grundkonfiguration. `lib/haproxy-log.ts`
folgt dem Log des Containers über die Engine und schreibt
`/var/log/haproxy/haproxy.log`, mit einem Kopf wie von syslog. Das ist einer der
Orte, an denen `lib/haproxy/access-log.ts` sucht. Nach einem Neustart von HAPM
geht es beim Zeitstempel der letzten geschriebenen Zeile weiter. Ab 256 MB wird
die Datei beiseitegelegt, eine Vorgängerin bleibt liegen.

## Scheduler

In diesem Prozess, also genau eine Instanz: jede Minute die Zähler von HAProxy
(Statistik), alle sechs Stunden die Update-Prüfung, täglich um 03:17 die
Erneuerung der Zertifikate (`acme.sh --cron`) und das Aufräumen (Metriken nach
14 Tagen, Historie nach 180, Protokoll nach 365). Alle zwei Minuten sieht er für
die Benachrichtigungen nach, ob HAProxy läuft und die Ziele antworten.

## Benachrichtigungen: `lib/notifications/`, `lib/mail/`

HAPM verschickt Mails über ein SMTP-Konto, das unter „Benachrichtigungen"
eingetragen wird. Es gibt keine Vorgabe aus der Umgebung: ohne Server und
Absender geht nichts raus, ohne Empfänger auch nicht. Das Passwort liegt
verschlüsselt in der Datenbank (`encryptionKey` aus `lib/secrets.ts`), die
Oberfläche erfährt nur, ob eines gesetzt ist. Ändert sich der Schlüssel, ist es
nicht mehr lesbar und muss neu eingetragen werden.

Wer etwas zu melden hat, ruft `notify(event)` (`lib/notifications/index.ts`).
Die Funktion wirft nie und hält ihren Aufrufer nicht auf. Sie entscheidet der
Reihe nach: ist das Ereignis eingeschaltet, gibt es Empfänger, ist das Konto
eingerichtet, wurde dieselbe Sache gerade erst gemeldet. Jeder Empfänger
bekommt eine eigene Mail.

| Ereignis | Wann | Woher |
|---|---|---|
| `certificate_renewal_failed` | `acme.sh --cron` endet mit einem Fehler | täglicher Lauf |
| `certificate_expiring` | ein Zertifikat ist weniger als 14 Tage gültig, eine Mail für alle | täglicher Lauf |
| `haproxy_down` | der Container läuft bei zwei Prüfungen in Folge nicht | alle zwei Minuten |
| `backend_down` | kein Ziel eines Eintrags antwortet, bei zwei Prüfungen in Folge | alle zwei Minuten |
| `backend_recovered` | ein Eintrag, dessen Ausfall gemeldet wurde, antwortet zweimal in Folge wieder | alle zwei Minuten |
| `run_failed` | ein Vorgang am Reverse-Proxy endet mit einem Fehler | `lib/haproxy/runner.ts` |
| `update_available` | die Update-Prüfung findet eine neue Fassung, einmal je Fassung | `lib/updates/check.ts` |
| `update_completed`, `update_failed` | Ende eines Update-Laufs, auch beim Abgleich nach dem Start | `lib/updates/apply.ts` |
| `backup_failed` | die Sicherung ruft `notify({ type: 'backup_failed', detail })` | Sicherung |

**Dämpfung.** Dasselbe Ereignis für dieselbe Sache (ein Eintrag, ein
Bestandteil) kommt höchstens einmal am Tag, gerechnet mit 23 Stunden, damit ein
täglicher Lauf nicht jede zweite Meldung verliert. Hält ein Zustand an, kommt
am nächsten Tag eine Erinnerung. Der Stand liegt in der Collection
`notification_state` und übersteht einen Neustart. Scheitert der Versand, ruht
dieselbe Sache 15 Minuten. Der letzte Versand samt Fehlermeldung des
Mailservers steht auf der Seite, alles Weitere im Protokoll des Containers
(`[notify]`).

**Zwei Prüfungen in Folge** gelten für HAProxy und seine Ziele
(`lib/notifications/checks.ts`). Ein Neuladen von HAProxy oder ein Container,
der beim Update ersetzt wird, löst so nichts aus. Ist der Zustand unbekannt (Docker-Socket weg, kein
Stats-Socket, Ziel ohne Healthcheck), wird nichts gemeldet.

**Was die Mails nicht können.** Läuft HAPM selbst nicht, verschickt niemand
etwas: einen Ausfall von HAPM oder des ganzen Servers meldet nur eine
Überwachung von außen. Ein Mailserver, der über das eigene HAProxy erreichbar
ist, bekommt die Meldung über dessen Ausfall nicht.

Die Mails tragen den Rahmen aus `ui/mail/layout.ts` (`lib/mail/layout.ts`,
`renderHapmMail`). Im Fuß steht diese Installation (Name des Servers, Adresse
der Oberfläche). Links in die Oberfläche gibt es nur, wenn unter „Allgemein"
die Adresse von HAPM eingetragen ist. Alle
Mails ansehen, ohne etwas zu verschicken:
`node node_modules/tsx/dist/cli.mjs scripts/preview-mail.ts`.

## Sicherung: `lib/backup/`

Unter „Sicherung" stellt man einen Ordner **auf dem Server** ein, eine Uhrzeit
und wie viele Archive liegen bleiben. Ein Lauf (täglich oder auf Knopfdruck)
schreibt `hapm-backup-JJJJMMTT-HHMMSS.tar.gz` dorthin:

| Im Archiv | Inhalt |
|---|---|
| `manifest.json` | Fassung von HAPM, Zeitpunkt, Art des Laufs, Fingerabdruck des Schlüssels (seit 0.5, `lib/backup/manifest.ts`) |
| `database.sql` | die Datenbank, mit `pg_dump` im Postgres-Container geschrieben |
| `data/secrets.json` | der Schlüssel zu den verschlüsselten Werten |
| `haproxy/` | `/etc/haproxy`: Konfiguration, Zertifikate, Fehlerseiten |
| `.acme.sh/` | acme.sh mit Konto, Zertifikaten und Erneuerungseinträgen |

Nicht im Archiv: das Zugriffsprotokoll und die Abbilder.

- **Ein Helfer-Container schreibt, nicht HAPM.** Der Ordner liegt auf dem
  Server und wird in der Oberfläche eingestellt, und ein laufender Container
  kann sich keinen Ordner nachträglich einbinden. Also startet HAPM je Lauf
  einen zweiten Container aus dem eigenen Abbild, der die Volumes von HAPM nur
  lesend und den Ordner bekommt. Ein anderer Ordner braucht damit weder eine
  Änderung an Compose noch einen Neustart.
- **Der Ordner geht als Einbindung an Docker und nie in ein Kommando.** Geprüft
  wird er trotzdem eng (`checkHostPath`): ein Doppelpunkt trennt in einer
  Einbindung Quelle, Ziel und Optionen, und in Ordnern des Systems räumt kein
  Lauf als root Dateien weg.
- **Geschrieben wird unter einem vorläufigen Namen**, erst danach umbenannt.
  Ein abgebrochener Lauf hinterlässt kein Archiv, das wie ein fertiges aussieht
  und als jüngstes ein gutes verdrängt.
- **Aufgeräumt wird nur, was wie ein Archiv von HAPM heißt.** Was sonst im
  Ordner liegt, bleibt liegen. `tests/backup/backup.test.ts` lässt eine echte
  Shell das Skript des Helfers nachrechnen.
- **Das Archiv ist nicht verschlüsselt** und enthält private Schlüssel. Es hat
  die Rechte 600, mehr Schutz gibt HAPM ihm nicht.
- Scheitert ein Lauf, geht eine Mail hinaus (`backup_failed`), wenn
  Benachrichtigungen eingerichtet sind.

### Zurückspielen

Unter „Sicherung", Karte „Sicherung zurückspielen" (`lib/backup/restore.ts`,
das Skript des Helfers in `lib/backup/restore-script.ts`). Der Ablauf:

1. **Bereitlegen.** Ein Archiv aus dem Ordner (die Liste stammt aus dem
   letzten Lauf; ein kurzer Helfer kopiert es, denn HAPM sieht den Ordner
   nicht) oder hochgeladen, etwa beim Umzug von einem anderen Server. Der
   Upload geht gestreamt auf die Platte, höchstens 512 MB: eine Sicherung ist
   ein paar MB plus die Datenbank, und die wächst vor allem mit Statistik und
   Protokoll. Es liegt immer höchstens ein Archiv bereit, in
   `/data/.restore/`, und es wird nach dem Lauf oder beim Verwerfen gelöscht.
2. **Prüfen**, bevor irgendetwas angefasst wird (`lib/backup/archive.ts`):
   `tar -t` liest das Archiv bis zum Ende, es muss `database.sql`,
   `data/secrets.json`, `haproxy/haproxy.cfg` und `.acme.sh/` enthalten, die
   Datenbank muss mit der Schlusszeile von `pg_dump` enden, Namen außerhalb
   des Ordners, Verweise dorthin und Geräte werden abgelehnt. Die Namen tragen
   teils `./` davor (der Zwischenordner wird mit `-C … .` gepackt), teils
   nicht. Ein Archiv ohne `manifest.json` (vor 0.5) gilt mit unbekannter
   Fassung, der Zeitpunkt kommt dann aus dem Dateinamen. Die Seite zeigt
   Zeitpunkt, Fassung, Größe und Inhalt.
3. **Bestätigen** mit dem Passwort des Kontos und einem abgetippten Wort. Die
   Seite sagt vorher sichtbar, was ersetzt wird, dass alle Sitzungen enden und
   dass man sich danach mit den Konten aus der Sicherung anmeldet.
4. **Vorher sichern.** HAPM sichert den aktuellen Stand über den gewöhnlichen
   Weg. Mit eingestelltem Ordner dorthin, als
   `hapm-backup-…-vor-ruecksicherung.tar.gz`: die Aufbewahrung räumt nur Namen
   ohne Zusatz weg, diese Archive bleiben also, bis jemand sie löscht. Ohne
   Ordner nach `hapm-before-restore.tar.gz` im Daten-Ordner (`data/hapm/` auf
   dem Server), eine frühere wird ersetzt. Scheitert diese Sicherung, wird
   nicht zurückgespielt. Die herausgeschriebene Datenbank bleibt als
   `before.sql` für ein Zurückrollen liegen.
5. **Der Helfer.** HAPM startet `hapm-restore` (Name des eigenen Containers mit
   `-restore` dahinter) aus dem eigenen Abbild, mit allen Volumes von HAPM
   schreibend und darüber dem Docker-Socket, wie `hapm-updater` beim
   Selbst-Update. Er packt das Archiv aus und legt den neuen Stand in jedem
   Volume neben den alten (`.hapm-restore-new`), solange HAPM noch läuft und
   nichts verändert ist. Dann der Reihe nach:
   - **HAPM anhalten** (`hapm-ctl stop`), Postgres läuft weiter.
   - **Datenbank einspielen** (`hapm-ctl restore-db`): die Datei geht über die
     Engine nach `/tmp` im Postgres-Container, dort `psql
     --single-transaction -v ON_ERROR_STOP=1` mit `DROP SCHEMA public
     CASCADE`, `CREATE SCHEMA public`, der Datei und dem Löschen der
     Sitzungen, alles in einer Transaktion. Geleert wird das Schema, weil eine
     Sicherung aus einer älteren Fassung nicht jede Tabelle kennt; was fehlt,
     legt HAPM beim Start an. Scheitert eine Zeile, ist nichts verändert.
   - **Dateien tauschen**: in `/etc/haproxy` und `/root/.acme.sh` geht der
     alte Stand nach `.hapm-restore-old`, der neue hinein, alles Umbenennungen
     auf demselben Dateisystem. Dazu `secrets.json`.
   - **Prüfen** (`hapm-ctl check`, `haproxy -c` im HAProxy-Container, steht er,
     in einem einmaligen Container aus seinem Abbild), dann **neu laden**
     (`hapm-ctl reload`). HAProxy lädt die Konfiguration aus der Sicherung nie
     ungeprüft.
   - **HAPM starten.**

   Scheitert ein Schritt nach dem Anhalten, tauscht der Helfer die Dateien
   zurück, spielt `before.sql` ein (ohne die Sitzungen zu löschen: wer
   zurückspielen wollte, bleibt angemeldet), lädt HAProxy noch einmal, falls
   es den neuen Stand schon geladen hatte, und startet HAPM. Scheitert das
   Zurücktauschen selbst, bleibt `.hapm-restore-old` liegen, und ein neuer Lauf
   beginnt erst, wenn es von Hand geprüft und entfernt ist.
6. **Abschluss.** Der Helfer schreibt jeden Schritt nach
   `/data/.restore/progress`, weil die Datenbank gerade ersetzt wird. Der neue
   HAPM-Prozess liest die Datei beim Start (`reconcileRestore`), trägt den Lauf
   in `restore_runs` und ins Protokoll der zurückgespielten Datenbank ein, dazu
   den Lauf der Sicherung von vorher in `backup_runs`, und räumt
   `/data/.restore/` auf. Scheitert der Helfer, bevor er HAPM anhält, schließt
   der laufende Prozess den Lauf bei der nächsten Abfrage der Seite.

**Der Schlüssel.** `encryptionKey` kommt mit `data/secrets.json` aus der
Sicherung zurück. `ENCRYPTION_KEY` aus der Umgebung gewinnt aber auch danach.
Das Manifest nennt den Fingerabdruck des Schlüssels, mit dem die Datenbank der
Sicherung verschlüsselt ist; passt der, mit dem HAPM danach liefe, nicht dazu,
wird nicht zurückgespielt (die Seite sagt, welche Variable zu setzen oder zu
entfernen ist). Ohne Manifest bleibt es bei einer Warnung, falls
`ENCRYPTION_KEY` gesetzt ist. Nach dem Neustart vergleicht HAPM den Schlüssel,
mit dem es läuft, noch einmal und schreibt das Ergebnis als Schritt in den Lauf.

Die Seite verliert die Verbindung, während HAPM neu startet. Sie fragt dann
`/api/health` und lädt neu, sobald HAPM antwortet; ohne Sitzung führt das zur
Anmeldung. Das Ergebnis steht danach in der Karte.

Steht der Helfer mitten im Lauf still (Neustart von Docker), bleibt HAPM
angehalten: `docker start hapm`, beim Start schließt HAPM den Lauf als
abgebrochen ab, und die Schritte zeigen, wie weit er kam.

#### Von Hand

Der Rückfall, wenn HAPM selbst nicht mehr läuft oder der Server neu ist und
die Oberfläche nicht starten soll. Auf einem Server mit Docker, auf dem HAPM
noch nicht läuft, in einem leeren Ordner mit `docker-compose.yml` (hier
`/opt/hapm`):

```bash
cd /opt/hapm

# 1. Das Archiv auspacken
mkdir /tmp/hapm-restore
tar -xzf /srv/hapm-backup/hapm-backup-JJJJMMTT-HHMMSS.tar.gz -C /tmp/hapm-restore

# 2. Nur die Datenbank starten und einspielen
docker compose up -d --wait postgres
docker exec -i hapm-postgres psql -U hapm -d hapm -q -v ON_ERROR_STOP=1 < /tmp/hapm-restore/database.sql

# 3. Schlüssel, HAProxy und acme.sh in den Ordner der Daten legen
mkdir -p data/hapm data/haproxy data/acme
cp -a /tmp/hapm-restore/data/. data/hapm/
cp -a /tmp/hapm-restore/haproxy/. data/haproxy/
cp -a /tmp/hapm-restore/.acme.sh/. data/acme/
rm -rf /tmp/hapm-restore

# 4. Starten
docker compose up -d
```

Die Namen im Archiv sind die aus dem Container (`data/`, `haproxy/`,
`.acme.sh/`), die Unterordner auf dem Server heißen `hapm/`, `haproxy/` und
`acme/`: daher das Kopieren Stück für Stück. HAPM darf erst starten, wenn die
Datenbank eingespielt ist, sonst legt es eine frische an.

Geprüft im November 2026 gegen den ganzen Stack: mit `install.sh --uninstall`
alles entfernt,
zurückgespielt, danach Anmeldung, Ziele und das ausgestellte Zertifikat wieder
da. Der Lauf, aus dem das Archiv stammt, steht nach dem Zurückspielen von Hand
als abgebrochen in der Historie: der Stand der Datenbank wurde mitten in ihm
herausgeschrieben. Über die Oberfläche schließt HAPM ihn danach als gelungen
ab (`settleArchiveRun`).

Das Zurückspielen über die Oberfläche ist im November 2026 gegen einen eigenen
Stack unter Docker Desktop geprüft (Kopie von `scripts/verify/compose.yml`):
Konto A, Gruppe und TCP-Ziel angelegt, gesichert; dann Konto B statt A, Ziel
geändert; aus dem Ordner zurückgespielt. Danach meldete sich A an, B nicht
mehr, Ziel und `haproxy.cfg` waren die der Sicherung, HAProxy lief mit ihnen,
die Sicherung `…-vor-ruecksicherung` lag im Ordner. Ebenso geprüft: ein
beschädigtes und ein fremdes Archiv werden beim Hochladen abgelehnt und nichts
ändert sich; ein Archiv mit ungültiger Konfiguration endet am Schritt „Prüfen",
Dateien und Datenbank kommen zurück, die Sitzung bleibt; ein Archiv ohne
Manifest und ohne zwei Tabellen spielt sich ein, die Tabellen legt HAPM beim
Start an; ohne Ordner landet die Sicherung von vorher in
`hapm-before-restore.tar.gz` im Daten-Ordner. Der Zähler der Anmeldeversuche
liegt im Daten-Ordner und gehört nicht zur Sicherung: er bleibt beim
Zurückspielen, wie er ist.

## Bauen

```bash
docker build -t hapm .
```

Ohne Secret und ohne Build-Argument, das nötig wäre (`HAPM_VERSION` setzt die
Versionsangabe). Die CI (`.github/workflows/image.yml`) baut für amd64 und arm64
und veröffentlicht nach GHCR. Jede Architektur baut auf einem Rechner ihrer Art
(`ubuntu-latest`, `ubuntu-24.04-arm`) und legt ihr Abbild unter seiner
Prüfsumme ab, der Job `merge` fasst beide unter den Namen zusammen. Beide auf
einem amd64-Rechner zu bauen hieße arm64 im Emulator: das brauchte rund 18
Minuten. Ihre Tests gegen die Datenbank laufen nur, wenn
`TEST_DATABASE_URL` gesetzt ist.
