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

Fünf Schritte in einer Seite. Nach dem ersten besteht das Konto, alles danach
sind angemeldete Aufrufe unter `/api/setup/*` und darf scheitern oder liegen
bleiben.

1. **Konto** und die Adresse für Let's Encrypt (`POST /api/setup`, ohne Sitzung
   und nur, solange es kein Konto gibt).
2. **Erreichbarkeit:** nur im eigenen Netz oder aus dem Internet. Die Wahl steht
   sofort in den Einstellungen (`exposure`). An ihr hängt, ob Zertifikate über
   HTTP-01 oder immer über DNS-01 ausgestellt werden, siehe
   [`reverse-proxy.md`](reverse-proxy.md), „Interne Installation".
3. **DNS-Anbieter** (Hetzner, Cloudflare). Intern Pflicht, öffentlich nur für
   Wildcards nötig und überspringbar. Der Token wird dem Anbieter einmal
   vorgezeigt (`lib/setup/token-check.ts`) und geht dann über denselben Weg wie
   unter Reverse-Proxy, Einstellungen nach `account.conf`. HAPM speichert ihn
   nicht. Lehnt der Anbieter ihn ab, wird nichts abgelegt.
4. **Adresse der Oberfläche:** die Domain für HAPM, auf Wunsch mit einem
   Wildcard-Zertifikat für die Basis darüber. Den DNS-Eintrag auf diesen Server
   legt der Benutzer selbst an. Die Seite fragt das DNS, worauf die Domain
   zeigt, und sagt das Ergebnis. Aufgehalten wird damit niemand.
5. **Ausführen** (`lib/setup/run.ts`): Gruppe `HAPM`, Zertifikat, Ziel `hapm`
   auf `127.0.0.1:<PORT>`, `publicUrl`. Jeder Schritt ist ein gewöhnlicher Lauf
   mit derselben Vorabprüfung wie in der Oberfläche und steht in der Historie.

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
gab, trägt keinen Wert und gilt als abgeschlossen. Unter „Allgemein" lässt sich
die Art umstellen und die Einrichtung erneut öffnen.

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

HAPM spielt eine Sicherung nicht selbst zurück: dafür muss der Stack stehen,
in dem es läuft. Auf einem Server mit Docker, auf dem HAPM noch nicht läuft, in
einem leeren Ordner mit `docker-compose.yml` (hier `/opt/hapm`):

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
da. Der Lauf, aus dem das Archiv stammt, steht nach dem Zurückspielen als
abgebrochen in der Historie: der Stand der Datenbank wurde mitten in ihm
herausgeschrieben.

## Bauen

```bash
docker build -t hapm .
```

Ohne Secret und ohne Build-Argument, das nötig wäre (`HAPM_VERSION` setzt die
Versionsangabe). Die CI (`.github/workflows/image.yml`) baut für amd64 und arm64
und veröffentlicht nach GHCR. Ihre Tests gegen die Datenbank laufen nur, wenn
`TEST_DATABASE_URL` gesetzt ist.
