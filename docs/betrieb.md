# Betrieb: Container, Ersteinrichtung, Updates

HAPM bringt HAProxy mit. Hier steht, wie die Container zusammenhängen, was beim
ersten Start geschieht und wie Updates, Benachrichtigungen und Sicherung
ablaufen.

## Die Container, ein Ordner mit Daten

| Container | Abbild | Aufgabe |
|---|---|---|
| `hapm` | `ghcr.io/tjorvenhu/hapm` | Oberfläche, Scheduler, acme.sh, das Kommando `hapm-ctl` |
| `hapm-haproxy` | `haproxy:lts` (offiziell, unverändert) | HAProxy |
| `hapm-postgres` | `postgres:17-alpine` (offiziell, unverändert) | Die Datenbank von HAPM |
| `hapm-crowdsec` | `crowdsecurity/crowdsec:latest` (offiziell, unverändert) | CrowdSec: liest das Log von HAProxy, lokale API, WAF. Abschaltbar, siehe [`crowdsec.md`](crowdsec.md) |
| `hapm-crowdsec-bouncer` | `crowdsecurity/spoa-bouncer:latest` (offiziell, unverändert) | Der SPOE-Agent, den HAProxy je Anfrage fragt. Abschaltbar |

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
| `crowdsec/` | `/crowdsec` | | | Alles für CrowdSec. HAPM schreibt dort bei jedem Start seine Dateien (`lib/crowdsec/setup.ts`) |

Die Unterordner von `crowdsec/` in den beiden CrowdSec-Containern:

| Unterordner | In `hapm-crowdsec` | In `hapm-crowdsec-bouncer` | Inhalt |
|---|---|---|---|
| `crowdsec/config/` | `/etc/crowdsec` | | Konfiguration, Hub, installierte Sammlungen, dazu `acquis.d/hapm.yaml` und `parsers/s02-enrich/hapm-backend.yaml` von HAPM |
| `crowdsec/data/` | `/var/lib/crowdsec/data` | | SQLite-Datenbank mit Sperren, Ereignissen und Freigabelisten, dazu die Daten der Regeln |
| `crowdsec/secrets/` | `/run/secrets` | | `bouncer_key_hapm`, der Schlüssel des Bouncers. CrowdSec meldet ihn beim Start damit an |
| `crowdsec/bouncer/` | | eingebunden als Konfiguration | `crowdsec-spoa-bouncer.yaml`, von HAPM geschrieben |
| `log/` | `/var/log/haproxy` (nur lesend) | | Das Log von HAProxy, Quelle der Szenarien |

Die SPOE-Datei und die Freigaben für HAProxy liegen nicht dort, sondern unter
`haproxy/hapm-crowdsec/` (`spoe.cfg`, `allow.lst`): HAProxy sieht nur
`/etc/haproxy`.

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

**Wer beim Entfernen im Ordner der Installation steht**, steht danach in einem
Ordner, den es nicht mehr gibt. Das Skript sagt das am Ende („bitte mit `cd`
herauswechseln"): herausholen kann es die Shell des Aufrufers nicht. Wird es
von dort aus erneut gestartet, meldet die Shell `getcwd() failed`, bevor das
Skript beginnt. Es arbeitet dann von `/` aus weiter und erklärt die Zeile
(`START_DIR`, `note_gone_dir`).

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

**CrowdSec und der Bouncer laufen im Netz des Stacks**, nicht im Netz des
Hosts. Sie brauchen keinen Port der Maschine: der Bouncer erreicht CrowdSec
unter dem Namen `crowdsec` (lokale API auf 8080, WAF auf 7422). Im Netz des
Hosts lägen beide Ports auf jeder Adresse des Servers, und 8080 ist oft schon
belegt. Veröffentlicht wird nur der Port des Bouncers, und der nur auf
`127.0.0.1:${HAPM_SPOA_PORT:-7423}`: dort erreicht ihn HAProxy aus dem Netz des
Hosts, von außen niemand. Beide Dienste tragen
`profiles: ["${HAPM_CROWDSEC_OFF:+ohne-crowdsec}"]`: ohne die Variable sind sie
dabei, mit `HAPM_CROWDSEC_OFF=1` in `.env` (oder `install.sh --no-crowdsec`)
sieht Compose sie nicht, holt keine Abbilder und legt keine Container an.
Abschalten im laufenden Stack: Variable setzen,
`docker compose rm -sf crowdsec crowdsec-bouncer`, dann `docker compose up -d`.
Warum so, steht in [`crowdsec.md`](crowdsec.md).

**Was HAPM zu CrowdSec wissen muss**, alles mit Vorgabe:

| Variable | Vorgabe | Wofür |
|---|---|---|
| `HAPM_CROWDSEC_OFF` | leer | `1`: der Stack bringt CrowdSec nicht mit. Compose (Profil) und HAPM (`crowdsecInStack`) lesen sie |
| `HAPM_SPOA_PORT` | `7423` | Port des Bouncers auf `127.0.0.1` des Servers, für Compose und `backend hapm_crowdsec_spoa` |
| `HAPM_CROWDSEC_CONTAINER` | `hapm-crowdsec` | Name des Containers, in dem `cscli` läuft |
| `HAPM_CROWDSEC_BOUNCER_CONTAINER` | `hapm-crowdsec-bouncer` | Name des Bouncers, für Log und Updates |
| `HAPM_CROWDSEC_DIR` | `/crowdsec` | Wo HAPM den Ordner `crowdsec/` sieht |

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
Kommando spricht ohne die Oberfläche mit der Datenbank. Vorher kommt der Weg
ohne Server: Wiederherstellungscodes des zweiten Faktors (`lib/two-factor.ts`,
`lib/recovery-codes.ts`), als HMAC in `two_factor` neben dem Geheimnis. Der
Schlüssel des HMAC ist aus `encryptionKey` abgeleitet: ein Abzug der Datenbank
allein reicht nicht zum Durchprobieren, und nach dem Zurückspielen einer
Sicherung gelten die Codes weiter, weil `secrets.json` mitkommt.

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

Sieben Schritte in einer Seite. Nach dem ersten besteht das Konto, alles danach
sind angemeldete Aufrufe unter `/api/setup/*` und darf scheitern oder liegen
bleiben.

1. **Konto** und die Adresse für Let's Encrypt (`POST /api/setup`, ohne Sitzung
   und nur, solange es kein Konto gibt). Die E-Mail-Adresse des Kontos wird
   Empfänger der Benachrichtigungen, bis jemand die Empfänger ändert.
   Den zweiten Faktor bietet nicht der Assistent an, sondern ein Fenster beim
   ersten Aufruf unter der Adresse von HAPM (`components/SecurityPrompt.tsx`,
   `/api/account/security`): in der Einrichtung läuft die Oberfläche noch unter
   IP und Port, ein Passwortmanager speicherte die Anmeldung für diese Adresse,
   und ein Passkey hängt an der Domain. Das Fenster erscheint ohne zweiten
   Faktor und ohne Passkey, bis jemand es wegklickt (`securityPromptDismissedAt`
   in `user_state`). „Passkey hinterlegen“ führt nach
   `/konto?bereich=passkeys&passkey=neu`, wo der Dialog gleich aufgeht.
   Nach einer Anmeldung mit einem Wiederherstellungscode geht es auf
   `/konto?bereich=zweiter-faktor`: dort stehen die übrigen Codes. Fehlen
   die Codes oder sind es drei oder weniger, steht die Warnung mit dem Knopf
   zum Erzeugen über den Reitern der Kontoseite, nicht nur im Reiter: wer
   „Konto“ öffnet, landet auf „Passwort“.
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
5. **SMTP-Konto** (`PUT /api/setup/mail`): Server, Port, Verschlüsselung,
   Absender, Benutzer und Passwort, gespeichert in den Einstellungen über
   dieselbe Regel wie unter „Benachrichtigungen" (`readSmtpInput`,
   `updateSettings`, das Passwort verschlüsselt und nie zurückgegeben). Der
   Grund für den Schritt: ohne SMTP-Konto gibt es keine Passkeys
   (`lib/auth/passkey-rules.ts`), und das Fenster „Konto absichern" böte
   keinen an. **Er lässt sich überspringen:** solange kein Server eingetragen
   ist, heißt „Weiter" „Überspringen" (`skip: true`, `mail: 'skipped'`), und
   übersprungen gilt als erledigt. Gespeichert wird nur mit Server und
   Absender, sonst verschickte HAPM nichts (`isMailConfigured`). „Testmail
   senden" speichert zuerst (`advance: false`, der Schritt bleibt offen) und
   schickt dann über `/api/mail/test` an die Adresse des Kontos.
   Der Schritt steht vor der Adresse und nicht dahinter: eine öffentliche
   Installation ohne Adresse endet mit der Adresse (`/api/setup/address`,
   `skip`), ein Schritt danach käme nie dran. Zeilen von vor dem Schritt
   kennen das Feld `mail` nicht (`mailAnswerOf`): wer dort die Adresse schon
   beantwortet oder das Ausführen begonnen hat, wird nicht zurückgeschickt, der
   Schritt gilt als übersprungen. Nach der Einrichtung nimmt die Route nichts
   mehr an, das Konto gehört dann der Seite „Benachrichtigungen".
6. **Adresse der Oberfläche:** die Domain für HAPM, auf Wunsch mit einem
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
   **Der Wert des Eintrags ist bei einer Installation aus dem Internet die
   öffentliche Adresse** (`recordAddresses`, `orderRecordAddresses`): ein
   Server bei einem Cloud-Anbieter oder hinter einem Router trägt an seiner
   Schnittstelle oft nur eine private, und die erreicht von außen niemand.
   Vorgeschlagen wird in dieser Reihenfolge: die Adresse aus der Adresszeile
   des Browsers, wenn es eine öffentliche IP ist (unter ihr hat der Aufrufer
   den Server gerade erreicht), eine öffentliche IPv4-Adresse einer
   Schnittstelle, sonst die Adresse, unter der ein Dienst außen den Server
   sieht (`lib/setup/public-address.ts`, siehe „Ausgehende Verbindungen"),
   dann eine öffentliche IPv6-Adresse, zuletzt die private. IPv4 geht vor: ein
   Eintrag nur für IPv6 ließe jeden ohne IPv6 draußen. Dasselbe gilt beim Ändern der Adresse.
   **Aus dem Internet lässt sich die Oberfläche auf Adressen und Netze
   beschränken** (`surfaceIps` in `setup_state`): der Schalter „Oberfläche nur
   von bestimmten Adressen aufrufbar", vorbelegt mit der Adresse des Aufrufers.
   Die Route lehnt eine Liste ab, in der die eigene Adresse fehlt. Das
   Ausführen trägt die Adressen in die Admin-IPs ein (Schritt `access`, dazu,
   nicht stattdessen) und legt das Ziel der Oberfläche gesperrt an
   (`lockedDomains`). Es ist dieselbe Sperre wie im Dialog eines Ziels und
   steht danach unter Reverse-Proxy, Einstellungen, Zugriff. Sie gilt für die
   Domain, nicht für den Port der Oberfläche: der bleibt offen, bis
   `HAPM_BIND=127.0.0.1` gesetzt ist, und ist damit auch der Weg zurück, wenn
   sich jemand ausgesperrt hat.
7. **Ausführen** (`lib/setup/run.ts`): Gruppe `HAPM`, Zertifikat, Ziel `hapm`
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
die Reihenfolge: das Token kommt in Schritt 3, die Domain in Schritt 6, und
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
`setup_state`: Art, gewählter Hook, ob Zertifikate und SMTP-Konto beantwortet
sind, Domain, Wildcard und der Stand des Ausführens. Welcher Schritt dran ist, wird daraus abgeleitet (`resumeStep`) und
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
unter „Allgemein" (die Adresse über den Assistenten im nächsten Abschnitt), die
Anbindung unter „DNS", das Ziel unter „Reverse-Proxy".

### Die Seite „Allgemein“: `/system`

Zwei Reiter: „Adresse“ (die Adresse von HAPM mit dem Assistenten unten) und
„Zertifikate“ (`?bereich=zertifikate`: Art der Installation, Herkunft der
Zertifikate, E-Mail für Let's Encrypt). Links, die auf die Herkunft der
Zertifikate zeigen, nehmen den zweiten Reiter. Der Assistent hängt nicht am
Reiter: läuft ein Umzug, geht er beim Laden auf jedem Reiter auf.

### Die Adresse ändern: `lib/address-move/`

Unter „Allgemein“, Reiter „Adresse“, steht die gültige Adresse mit dem Knopf „Adresse ändern"
(ohne Adresse „Adresse einrichten"). Er öffnet einen Assistenten im Fenster
(`components/system/AddressMoveWizard.tsx`), gebaut wie die Einrichtung:
Schrittleiste und Abschluss kommen aus `app/setup/setup.css`.

1. **Adresse:** die neue Domain. Darunter „Nur die Adresse eintragen, ohne
   Zertifikat und Ziel" für HAPM hinter einem anderen Reverse-Proxy, über
   `PATCH /api/settings` wie bisher.
2. **Prüfung** (`GET /api/settings/address?domain=`): worauf die Domain im DNS
   zeigt (dieselbe Abfrage wie in der Einrichtung), wie das Zertifikat entsteht
   und ob schon eins sie abdeckt. Weiter geht es nur nach `checkGate`
   (`rules.ts`): zeigt sie auf diesen Server, sofort; zeigt sie woanders hin
   oder ging die Abfrage nicht, nur mit ausdrücklicher Bestätigung (hinter
   einer Adressumsetzung ist das richtig); **ohne Eintrag gar nicht**, auch
   wenn das Zertifikat über DNS-01 entstünde: am Ende ist das alte Ziel weg,
   und HAPM wäre unter keiner Adresse mehr erreichbar. Eine Domain, die schon
   ein Ziel bedient, das nicht zu HAPM führt, wird abgelehnt.
   **Fehlt der Eintrag, bietet der Assistent an, ihn anzulegen**
   (`offerRecord`): nur bei einer Installation aus dem Internet und nur, wenn
   die Zone unter „DNS" eingerichtet ist. Gesetzt wird erst nach Bestätigung
   (`PUT /api/settings/address/dns-record`, `ensureAddressRecord`), der Wert
   ist vorbelegt mit der ersten Adresse des Servers und änderbar (hinter NAT
   trägt der Server seine öffentliche Adresse nicht selbst). Intern gehört der
   Eintrag in den DNS-Server des eigenen Netzes.
3. **Umzug** (`POST /api/settings/address`, `startAddressMove`): Zertifikat,
   neues Ziel, `publicUrl`, altes Ziel entfernen. Jeder Schritt mit HAProxy
   ist ein gewöhnlicher Lauf mit Vorabprüfung und steht in der Historie.

**Ein neues Ziel statt die Domain am alten zu tauschen.** Getauscht wäre die
Oberfläche unter der alten Adresse in dem Augenblick weg, in dem HAProxy neu
lädt, und beide Domains an einem Ziel verlangten ein Zertifikat für beide
(`findCertificateFor` sucht eins, das alle Domains eines Ziels abdeckt). Das
neue Ziel übernimmt vom alten Sperre, Kopfzeilen und Ziele (`toCreateInput`),
sonst stünde die Oberfläche nach dem Umzug offen, wo sie gesperrt war. Es heißt
`hapm`, wenn der Name frei ist, sonst nach der Domain. Das alte Ziel geht als
letzter Schritt, und zwar erst, wenn `publicUrl` schon umgestellt ist: vorher
schützt `protected.ts` es. Trägt es weitere Domains, wird nur die alte
entfernt; lief die alte Adresse über eine Wildcard, bleibt es stehen. Sein
Zertifikat geht mit, wenn es niemand sonst braucht (wie beim Löschen eines
Ziels).

**Das alte Ziel geht erst, wenn das Fenster es weiß.** Ein ganzer Umzug
dauert keine fünfzehn Sekunden (gemessen: Zertifikat über DNS-01 8 s, Ziel
anlegen 1 s, Ziel entfernen 1 s). Das Fenster fragt alle zwei Sekunden über die
alte Adresse, und jedes Neuladen von HAProxy kostet es ein, zwei Abfragen. Ohne
Warten war die alte Adresse weg, bevor eine Abfrage „Adresse umgestellt“
gesehen hatte, und das Fenster stand auf „Zertifikat“, obwohl alles durch war.
Deshalb wartet der letzte Schritt, bis eine Abfrage des Stands die umgestellte
Adresse gelesen hat (`__hapm_move_seen`), höchstens 90 Sekunden; danach geht er
auch ohne Zuschauer.

**Das Fenster fragt den Stand über die alte Adresse ab, und die geht durch
jedes Neuladen von HAProxy** (Zertifikat, neues Ziel). Einmal blieb danach
jede Abfrage ohne Antwort hängen, und die Anzeige stand auf „Zertifikat",
während der Umzug auf dem Server durchlief. Deshalb hat jede Abfrage ein
Zeitlimit (6 s), eine neue geht erst los, wenn die alte fertig ist, und vier
Fehlschläge in Folge heißen „diese Adresse antwortet gerade nicht", nicht
„gescheitert". Ist das neue Ziel schon da, oder hakt es länger als etwa eine
Minute, bietet das Fenster „Neue Adresse öffnen" an. Der Abschluss erscheint,
sobald die neue Adresse gilt; das Entfernen des alten Ziels zeigt er mit
seinem Stand.

**Passkeys:** Ändert sich der Host der Adresse oder fällt sie weg, löscht
`updateSettings` alle Passkeys (`deleteAllPasskeys`). Sie hängen an der
Domain und melden unter der neuen niemanden an. Das gilt für jeden Weg: den
Assistenten, „Nur eintragen", „Adresse entfernen" und die Einrichtung.

**Wer den Assistenten unter der alten Adresse offen hat, verliert sie mit dem
letzten Schritt.** Bricht das Pollen ab, nachdem die neue Adresse gilt, zeigt
das Fenster den Abschluss mit dem Hinweis, dass die alte nicht mehr antwortet.
Ob der letzte Schritt ganz durch ist, steht danach unter „Allgemein" (ein
gescheiterter Umzug als rote Meldung mit Schritt und Grund).

Der Stand liegt in der Collection `address_move` (eine Zeile `current`). Wie
die Einrichtung läuft der Umzug im Prozess: nach einem Neustart gilt er als
abgebrochen und lässt sich erneut starten, was schon da ist (Zertifikat, Ziel),
wird dabei vorgefunden. Läuft er, öffnet „Allgemein" das Fenster beim Laden.

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
- **CrowdSec und der Bouncer:** ihre Abbilder meldet und tauscht die Seite
  ebenso, sofern der Stack sie mitbringt (ohne `HAPM_CROWDSEC_OFF`). Solange der
  Bouncer getauscht wird, gehen Anfragen ungeprüft durch (fail-open, siehe
  [`crowdsec.md`](crowdsec.md)).

Beim Ersetzen bleibt nur, was am Container eingestellt wurde, nicht was sein
Abbild vorgab (`recreateBody`): sonst stünde im neuen Container
`HAPROXY_VERSION` des alten Abbilds.

**Selbsttätig** aktualisiert HAPM einmal am Tag zur eingestellten Uhrzeit, was
unter „Updates" angekreuzt ist (`Settings.autoUpdate`, eine Liste von
Bestandteilen). Vorgabe: HAProxy, acme.sh, CrowdSec und der Bouncer, also alles
außer HAPM selbst: HAPM ersetzt dabei den eigenen Container, die Oberfläche ist
eine Minute weg, und ein Fehler dort trifft genau das Werkzeug, mit dem man ihn
beheben würde. Es lässt sich trotzdem ankreuzen. Gibt es für mehrere etwas
Neues, laufen die Updates nacheinander (`runAutoUpdates` im Scheduler), HAPM
zuletzt (`AUTO_UPDATE_ORDER`). Eine Einstellung von vor der Auswahl behält ihren
Wert für HAProxy (`autoUpdateHaproxy`), die übrigen bekommen die Vorgabe. Die
API nimmt `autoUpdateHaproxy` weiter an und setzt damit nur HAProxy in der Liste.

**In der Oberfläche** steht ein laufendes Update nicht auf der Seite, sondern im
Fenster der Läufe (siehe unten, „Läufe im Hintergrund“). Auf der Karte des
Bestandteils bleibt nur die Marke „Wird aktualisiert“. Beim Tausch von HAPM ist
die Oberfläche kurz weg: das Fenster sagt das, fragt weiter, und sobald HAPM
wieder antwortet (oder der Lauf mit dem Schritt „Übergabe“ endet), lädt die
Seite neu, weil sie noch aus dem alten Abbild stammt. Danach ist das Fenster
wieder offen und zeigt das Ergebnis.

## Läufe im Hintergrund: `components/runs/`

Updates, Sicherung, Zurückspielen und die Vorgänge am Reverse-Proxy (auch der
Import) laufen abgekoppelt und haben eine Zeile in der Datenbank (das
Zurückspielen eine Datei unter `/data/.restore/`). Sie stehen nie als Kasten in
einer Seite, sondern in einem Fenster (`RunOverlay.tsx`):

- **Beim Start geht es auf** (`startRun` aus `runs.ts`). „Im Hintergrund
  weiterlaufen lassen“ schließt nur das Fenster, der Lauf geht auf dem Server
  weiter. Die Pille unten rechts (`ActivityIndicator.tsx`, Quelle
  `/api/activity`) zeigt jeden laufenden Lauf, ein Klick öffnet sein Fenster
  wieder. Eine Meldung oder die Historie öffnet es über `openRun`.
- **Ein Neuladen der Seite öffnet kein Fenster**, wie beim Reverse-Proxy: dann
  zeigt nur die Pille den Lauf. Ausnahme ist das Neuladen, das HAPM selbst nach
  dem Tausch oder dem Zurückspielen auslöst (`reloadKeepingRun`, in
  `sessionStorage`, 30 Minuten gültig, auch über die Anmeldung hinweg).
- **Am Ende** zeigt das Fenster Erfolg oder Fehler, bei einem Fehler den ersten
  fehlgeschlagenen Schritt, und es kommt ein Toast. Der Toast kommt für jeden
  hier gestarteten Lauf und für jedes Update, jede Sicherung und jedes
  Zurückspielen, das die Pille laufen gesehen hat (auch nach Zeitplan). Das
  Ende eines Reverse-Proxy-Vorgangs melden dessen Seiten selbst, weil sie
  danach die Liste nachladen.
- Je Art liest das Fenster seinen Endpunkt (`sources.ts`):
  `/api/haproxy/runs/[id]`, `/api/updates/runs/[id]`, `/api/backup/runs/[id]`,
  `/api/backup/restore/runs/[id]`. Ein Reverse-Proxy-Vorgang zeigt Phasen und
  Protokoll, die anderen ihre Schritte untereinander (`RunStepList.tsx`, auch
  in den Historien), samt der noch kommenden aus `lib/updates/plan.ts` und
  `lib/backup/plan.ts`.
- Antwortet HAPM nicht (Tausch von HAPM oder HAProxy, Zurückspielen), bleibt
  das Fenster stehen und sagt, warum. Neu lädt die Pille: sie weiß, welcher
  laufende Lauf HAPM ersetzt.

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

**Tägliche Uhrzeiten** (Erneuerung, Sicherung, selbsttätige Updates) vergleicht
er nicht mit der Minute der Uhr, sondern fragt, ob der Zeitpunkt seit dem
letzten Takt erreicht wurde (`timeReached` in `lib/schedule-time.ts`). Am Tag
der Umstellung auf Sommerzeit gibt es 02:00 bis 02:59 nicht, die Sicherung um
02:30 fiele sonst aus, und ein Takt, der sich um Millisekunden verschiebt,
überspringt irgendwann eine Minute. Nach einem Neustart zählt erst, was ab dann
erreicht wird: es wird nichts nachgeholt.

**Ein Update beginnt nicht, während eine Sicherung oder ein Zurückspielen
läuft** (`startUpdate`), und umgekehrt: beide halten Container an oder
ersetzen sie.

## Benachrichtigungen: `lib/notifications/`, `lib/mail/`

HAPM verschickt Mails über ein SMTP-Konto, das unter „Benachrichtigungen"
eingetragen wird. Es gibt keine Vorgabe aus der Umgebung: ohne Server und
Absender geht nichts raus, ohne Empfänger auch nicht. Das Passwort liegt
verschlüsselt in der Datenbank (`encryptionKey` aus `lib/secrets.ts`), die
Oberfläche erfährt nur, ob eines gesetzt ist. Ändert sich der Schlüssel, ist es
nicht mehr lesbar und muss neu eingetragen werden.

Die Seite hat über den Reitern den Zustand (Konto, Empfänger, letzter
Versand), darunter drei Reiter: „SMTP-Konto“ mit Testmail, „Empfänger“
(`?bereich=empfaenger`, dazu die Sprache der Mails) und „Ereignisse“
(`?bereich=ereignisse`). Ein Entwurf des SMTP-Kontos bleibt beim Wechsel des
Reiters stehen, der Reiter trägt dann einen Punkt.

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
| `crowdsec_down` | der Container von CrowdSec oder des Bouncers läuft bei zwei Prüfungen in Folge nicht, solange CrowdSec ein Ziel schützt | alle zwei Minuten |
| `crowdsec_report` | was CrowdSec in 24 Stunden gemeldet hat, nur wenn etwas war; **Vorgabe aus** | täglicher Lauf |

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
`node node_modules/tsx/dist/cli.mjs scripts/preview-mail.ts`, mit einer
Darstellung `… scripts/preview-mail.ts de --brand` (Name, Farbe und Logo
einzeln mit `--brand-name=`, `--brand-color=`, `--brand-logo=`).

**Die Mails folgen der Darstellung** (`lib/mail/branding.ts`, `mailBrand` und
`mailAccent` in `lib/mail/layout.ts`):

- **Logo als Anhang, nicht als Adresse.** Ein eigenes Logo hängt wie das von
  HAPM mit `cid:` an der Mail (`brand-logo`, die helle Fassung
  `brand-logo-dark` für dunkles Design). Erwogen war ein Bild über
  `publicUrl` + `/api/branding/logo/light?v=…`. Dagegen sprach: der Rahmen lädt
  bewusst nichts nach (das Öffnen überträgt sonst die IP des Empfängers), viele
  Programme zeigen Bilder von außen erst nach einem Klick, und bei einer
  internen Installation erreicht ein Telefon unterwegs die Adresse nicht. Der
  Preis: das Logo reist mit jeder Mail. SVG zeigen Gmail und das klassische
  Outlook auf keinem der beiden Wege, WebP das klassische Outlook nicht. Vorher
  stand dann ein leerer Rahmen mit dem Namen darin in der Mail. Deshalb rechnet
  der Versand ein solches Logo mit `sharp` in ein PNG um (96 px hoch, dreimal
  die Anzeigehöhe, im Prozess gemerkt); gelingt das nicht, hängt unter
  derselben Kennung das Logo von HAPM.
- **Größe.** Aus dem Kopf der Datei gelesen (`imageDimensions`), angezeigt 32
  Pixel hoch und höchstens 200 breit, mit `width` und `height` für Outlook.
  Lässt sie sich nicht lesen, bleibt der Kopf von HAPM.
- **Name** fett im Fuß und als Alternativtext am Logo, und als Anzeigename des
  Absenders, wenn der eingetragene Absender keinen eigenen nennt. Der Satz
  „Diese Mail kommt von der HAPM-Installation …“ bleibt: er meint die Software.
- **Farbe.** Dieselbe Regel wie in der Oberfläche (`deriveAccent`): Weiß auf dem
  Akzent mindestens 4,5:1, dazu Töne für Hinweisflächen und dunkles Design,
  jeweils mit 4,5:1 für die Schrift darauf. Die Bausteine schreiben das Grün als
  feste Werte; der Rahmen tauscht sie am Ende aus, aber nur, wo sie als Wert
  stehen (`:#…`, `="#…"`), nie im Text.
- **Ohne Darstellung Byte für Byte wie vorher**, die Tests in `tests/mail/`
  blieben dafür unverändert. Der Rahmen ist synchron: die Darstellung liegt am
  Prozessobjekt (`knownMailBranding`), gelesen beim Start und nach dem
  Speichern unter „Darstellung“, das Logo selbst erst beim Versand.

## Darstellung: `lib/branding/`

Unter „Darstellung" (`app/(app)/system/darstellung`) gibt der Betreiber der
Oberfläche ein eigenes Logo (dazu eine helle Fassung für dunkle Flächen und
ein Symbol für den Tab), eine Pille neben dem Logo, einen Namen für den
Browser-Tab und eine Akzentfarbe. Ohne Einstellung ist alles wie vorher: das
Layout schreibt dann nichts in den Kopf der Seite und lässt die Favicons aus
`public/` stehen.

- **Wo es liegt.** Collection `branding`: die Zeile `main` mit Name, Pille,
  Farbe und je Bild Art, Größe und Fingerabdruck, je Bild eine eigene Zeile
  (`image-logo`, `image-logoDark`, `image-icon`) mit der Datei als Base64. Das
  Layout liest bei jeder Seite nur `main`, über den Schlüssel, ohne
  Zwischenspeicher im Prozess (Layout und Routen laufen in Next in getrennten
  Modulgraphen, ein Speicher zeigte nach dem Speichern an einer Stelle das
  Alte). Die Sicherung nimmt alles mit, es steht in der Datenbank.
- **Farben an der Wurzel, Server-gerendert.** `brandingStyle` schreibt eine
  Regel `:root:root{--accent:…}` in den Kopf: die doppelte Pseudoklasse
  schlägt `:root` und `html:has(.app-shell)` aus `ui/css`, unabhängig von der
  Reihenfolge der Stylesheets. Gesetzt werden `--accent`, `--accent-hover`,
  `--accent-light`, `--accent-subtle`, `--accent-glow`, die Neutralskala
  `--n-*` im Farbton des Akzents, `--overlay` und `--brand-tint` (getönte
  Flächen im Assistenten, ohne eigene Farbe `--success`). Alle Werte rechnet
  `lib/branding/color.ts` aus, aus der Eingabe geht nichts unverändert hinein.
- **Kontrast.** Auf dem Akzent steht weiße Schrift, und derselbe Wert
  (`--primary-fg`) steht auf „Löschen" und „Warnung". Erreicht Weiß auf der
  gewählten Farbe nicht 4,5:1 (WCAG AA), nimmt die Oberfläche die hellste
  dunklere Fassung in OKLCH, die es schafft. Die Seite zeigt beide Farben und
  den Kontrast. Gespeichert bleibt die gewählte Farbe.
- **Bilder.** SVG, PNG und WebP bis 256 KB, geprüft an den ersten Bytes
  (`sniffLogoType` aus den Fehlerseiten). Ein SVG mit Skript, Ereignis,
  `javascript:`, `foreignObject` oder Entitäten wird abgelehnt. Ausgeliefert
  ohne Anmeldung von `/api/branding/logo/light|dark` und
  `/api/branding/favicon`, mit `?v=<Fingerabdruck>` ein Jahr im Cache, ohne
  ihn `no-cache` mit ETag. Dort gilt `Content-Security-Policy: sandbox`, eine
  eigene Regel in `next.config.ts`: die allgemeine CSP von dort überschriebe
  eine, die die Route selbst setzt.
- **Symbol im Tab.** Ein hochgeladenes gilt immer. Sonst mit Namen dessen
  Anfangsbuchstabe auf dem Akzent, mit Farbe allein das Zeichen von HAPM in
  der Farbe. Aus einem breiten Logo wird kein Quadrat geschnitten.
- **Mails und Fehlerseiten folgen.** Die Mails nehmen Name, Logo und Farbe
  (siehe „Benachrichtigungen“), die Fehlerseiten von HAProxy und die
  Passwortabfrage ebenso, soweit dort unter „Selbst gestalten“ nichts anderes
  gesetzt ist ([`reverse-proxy.md`](reverse-proxy.md), „Die Fehlerseiten“).
  Speichern schreibt die Fehlerdateien neu, die HAPM selbst geschrieben hat,
  mit Sicherung, `haproxy -c` und Reload; eine Seite von Hand bleibt stehen.
  Die Route antwortet mit `pages` (geschrieben, stehen geblieben, Fehler), und
  die Seite meldet ein Scheitern in einem eigenen Toast.
- **Logo in Bausteinen.** `ui/primitives/Logo.tsx` liest `useBrand()`
  (`ui/primitives/brand.tsx`, Provider im Wurzel-Layout) und zeigt das eigene
  Logo samt Pille. Seitenleiste, Anmeldung, Assistent und die Fehlerseiten der
  Oberfläche bekommen es damit ohne Änderung. Die helle Fassung nimmt
  `<Logo background="dark">`; die Oberfläche hat heute keine dunkle Fläche,
  zu sehen ist sie in der Vorschau.
- **Der Name** steht im Tab (`DocumentTitle`, `generateMetadata` der Seiten
  außerhalb der Hülle) und als Alternativtext des Logos. Texte, die „HAPM"
  sagen, bleiben: sie meinen die Software.
- **Was nicht folgt.** Der Name in Authenticator-Apps (`lib/totp.ts`) und bei
  Passkeys: ein geänderter Name dort passte nicht mehr zu schon eingerichteten
  Geräten. Die Palette der Diagramme (`--viz-*` in `ui/css/charts.css`) ist
  gegen Farbsehschwächen geprüft und bleibt ebenfalls. Eine eigene HTML-Datei
  für die Fehlerseiten geht unverändert hinaus. Bis 0.6 folgten auch Mails und
  Fehlerseiten nicht; gewünscht ist inzwischen, dass sie es tun.

## Sicherung: `lib/backup/`

Unter „Sicherung", Reiter „Einstellungen“, stellt man einen Ordner **auf dem
Server** ein, eine Uhrzeit und wie viele Archive liegen bleiben. Die anderen
Reiter: „Zurückspielen“ (`?bereich=zurueckspielen`) und „Historie“
(`?bereich=historie`, die Läufe mit ihren Schritten). Ein laufender Lauf steht
im Fenster der Läufe, nicht auf der Seite. Ein Lauf (täglich oder auf Knopfdruck)
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

Unter „Sicherung", Reiter „Zurückspielen" (`lib/backup/restore.ts`,
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

Der laufende Vorgang steht im Fenster der Läufe; auf dem Reiter steht nur eine
Zeile mit „Fortschritt ansehen“. Die Seite verliert die Verbindung, während
HAPM neu startet. Das Fenster sagt das und fragt weiter, die Pille lädt neu,
sobald HAPM antwortet; ohne Sitzung führt das zur Anmeldung, und danach geht das
Fenster mit dem Ergebnis wieder auf. Das Ergebnis steht außerdem auf dem Reiter.

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

## Ausgehende Verbindungen (Firmennetz, Firewall, Proxy)

Was der Server nach außen erreichen muss, wenn eine Firewall ausgehend nur
Freigegebenes durchlässt oder ein Proxy dazwischensteht. Außer DNS, NTP und
SMTP ist alles HTTPS auf TCP 443.

**Freigaben nach Namen, nicht nach Adressen.** Hinter fast allen Hosts stehen
CDNs (Cloudflare, CloudFront, Fastly) mit wechselnden Adressen. Eine Freigabe
nach IP veraltet ohne Vorwarnung. Die Firewall braucht Regeln nach Hostname
(FQDN, SNI) oder einen Proxy, der nach Namen filtert.

Die Liste ist im November 2026 aus dem Code von HAPM, dem Quelltext von
acme.sh und den Dokumentationen von Docker und CrowdSec zusammengestellt. Die
Weiterleitungen von Docker Hub und GHCR sind nachgemessen.

### Allgemein

| Ziel | Port | Wer | Wofür | Nötig |
|---|---|---|---|---|
| DNS-Server des Netzes | 53 UDP und TCP | Host, alle Container | Namensauflösung | ja |
| NTP-Server des Netzes | 123 UDP | Host | Uhrzeit. Zertifikate, zweiter Faktor und Ablaufzeiten von Sperren hängen daran | ja |
| Paketquellen der Distribution, `download.docker.com` | 443 (oder 80) | `install.sh` | Docker installieren, falls es fehlt | nur bei der Installation |
| `raw.githubusercontent.com` | 443 | `install.sh`, `curl` von Hand | `install.sh` und `docker-compose.yml` holen | nur bei der Installation |

### Öffentliche Adresse des Servers (Container `hapm`)

| Ziel | Port | Wofür | Nötig |
|---|---|---|---|
| `api.ipify.org`, sonst `ipv4.icanhazip.com` | 443 | Vorschlag für den DNS-Eintrag der Oberfläche: unter welcher Adresse der Server von außen gesehen wird | nein |

Gefragt wird nur bei einer Installation aus dem Internet, deren Schnittstellen
keine öffentliche IPv4-Adresse tragen, und nur im Assistenten und beim Ändern der
Adresse. Mitgeschickt wird nichts außer der Anfrage. Ohne Freigabe fehlt der
Vorschlag, und die Adresse wird von Hand eingetragen.

### Abbilder

Abbilder holt die **Docker-Engine auf dem Host**, nicht HAPM: bei der
Installation, bei `docker compose pull` und bei jedem Update aus der
Oberfläche. Ob es ein neues gibt, fragt dagegen **HAPM selbst** (alle sechs
Stunden, `lib/docker/registry.ts`), und zwar dieselben Hosts.

| Ziel | Port | Wer | Wofür | Nötig |
|---|---|---|---|---|
| `ghcr.io` | 443 | Docker-Engine, HAPM | Abbild von HAPM, Token für den anonymen Abruf | ja |
| `pkg-containers.githubusercontent.com` | 443 | Docker-Engine, HAPM | Schichten der Abbilder von GHCR (`ghcr.io` leitet dorthin weiter) | ja |
| `registry-1.docker.io` | 443 | Docker-Engine, HAPM | HAProxy, Postgres, CrowdSec, Bouncer von Docker Hub | ja |
| `auth.docker.io` | 443 | Docker-Engine, HAPM | Token für den anonymen Abruf | ja |
| `production.cloudfront.docker.com` | 443 | Docker-Engine, HAPM | Schichten von Docker Hub (Weiterleitung) | ja |
| `production.cloudflare.docker.com` | 443 | Docker-Engine, HAPM | Schichten von Docker Hub, je nach Ort und Zeitpunkt statt CloudFront | empfohlen |

Docker nennt die Hosts in der [Freigabeliste für Docker Desktop](https://docs.docker.com/desktop/enterprise/allow-list/),
die Engine braucht davon nur die zum Holen. Gemessen im November 2026 leitete
Docker Hub auf `production.cloudfront.docker.com` weiter; Docker hat beide
Namen schon benutzt, deshalb stehen beide hier.

### Zertifikate und DNS (Container `hapm`)

| Ziel | Port | Wer | Wofür | Nötig |
|---|---|---|---|---|
| `acme-v02.api.letsencrypt.org` | 443 | acme.sh | Zertifikate von Let's Encrypt | mit Let's Encrypt |
| `acme-staging-v02.api.letsencrypt.org` | 443 | acme.sh | `HAPM_ACME_SERVER=letsencrypt_test` | nur zum Testen |
| `acme.zerossl.com` | 443 | acme.sh | `HAPM_ACME_SERVER=zerossl` | nur dann |
| Eigener ACME-Server | sein Port | acme.sh | Eintrag unter „Allgemein“ | nur dann |
| `api.cloudflare.com` | 443 | HAPM, acme.sh (`dns_cf`) | DNS-Einträge, TXT-Einträge für DNS-01 | mit Cloudflare |
| `api.hetzner.cloud` | 443 | HAPM, acme.sh (`dns_hetznercloud`) | dasselbe bei Hetzner | mit Hetzner |
| `cloudflare-dns.com`, sonst `dns.google`, `dns.alidns.com` oder `doh.pub` | 443 | acme.sh | Nach dem Setzen des TXT-Eintrags fragt acme.sh über DNS over HTTPS, ob er sichtbar ist | für DNS-01 einer davon |

**Der letzte Punkt fällt leicht durch.** acme.sh nimmt den ersten der vier
DoH-Dienste, der antwortet. Erreicht es keinen, wartet es 20 Minuten auf einen
Eintrag, den es nie sieht, und bricht ab (`_check_dns_entries` in `acme.sh`).
HAPM setzt `--dnssleep` nicht, die Prüfung läuft also bei jedem Zertifikat über
DNS-01. Für eine interne Installation, die nur DNS-01 kennt, heißt das: ohne
`cloudflare-dns.com` (oder einen der anderen) kein Zertifikat.

### Updates, Länder, Mails (Container `hapm`)

| Ziel | Port | Wer | Wofür | Nötig |
|---|---|---|---|---|
| `api.github.com` | 443 | HAPM | Neueste Fassung von acme.sh (`lib/acme.ts`) | für die Anzeige auf „Updates“ |
| `github.com`, `codeload.github.com` | 443 | acme.sh `--upgrade` | Neue Fassung von acme.sh | nur beim Update von acme.sh |
| `download.db-ip.com` | 443 | HAPM (`lib/geoip/fetch.ts`) | Neue Länder-Tabelle. HAPM folgt nur Weiterleitungen innerhalb von `db-ip.com` | nein, die mitgelieferte gilt weiter |
| SMTP-Server | 587, 465 oder der eingetragene Port | HAPM | Mails | wenn Mails eingerichtet sind |

**SMTP geht nicht über einen HTTP-Proxy.** HAPM verbindet sich direkt mit dem
Mailserver. Ist das gesperrt, braucht es eine Freigabe in der Firewall oder
einen Mailserver im eigenen Netz.

### CrowdSec (Container `hapm-crowdsec`)

| Ziel | Port | Wer | Wofür | Nötig |
|---|---|---|---|---|
| `cdn-hub.crowdsec.net` | 443 | `cscli` | Hub: Sammlungen, Parser, Szenarien, Regeln der WAF. Beim Start, beim Schalten von Regeln, bei „Regeln aktualisieren“ | ja |
| `hub-data.crowdsec.net` | 443 | `cscli` | Daten, die Regeln laden (Listen, GeoIP-Datenbanken) | ja |
| `api.crowdsec.net` | 443 | lokale API | Central API: Signale melden, Community-Blocklist holen | nein, ohne sie keine Community-Blocklist |
| `blocklists.api.crowdsec.net` | 443 | lokale API | Blocklisten laden | mit der Central API |
| `papi.api.crowdsec.net` | 443 | lokale API | Steuerung aus der CrowdSec Console | nur nach `cscli console enroll` |
| `version.crowdsec.net` | 443 | `cscli` | Neueste Fassung von CrowdSec | nein |

Quelle: [CrowdSec, „Network management“](https://docs.crowdsec.net/docs/next/configuration/network_management).
Die Namen haben sich zwischen Fassungen von CrowdSec geändert; wer eine Fassung
festschreibt, sieht in der Dokumentation dieser Fassung nach. Die Central API
lässt sich abschalten (`DISABLE_ONLINE_API=true`, siehe
[`crowdsec.md`](crowdsec.md)). **Der Bouncer** spricht nur mit CrowdSec im Netz
des Stacks und braucht nach außen nichts.

### Eingehend, der Vollständigkeit halber

| Port | Wer | Wofür |
|---|---|---|
| 80 TCP | HAProxy | HTTP, Weiterleitung auf HTTPS, HTTP-01 von Let's Encrypt |
| 443 TCP | HAProxy | HTTPS |
| 443 UDP | HAProxy | HTTP/3 (QUIC) |
| 7080 TCP | HAPM | Oberfläche, bis sie unter ihrer Domain erreichbar ist |
| Ports der TCP-Weiterleitungen | HAProxy | was dort eingerichtet ist |

HAProxy selbst braucht nach außen nichts außer den Zielen, zu denen es
weiterleitet. Postgres hat kein Netz.

### Durch einen Proxy

Drei Stellen, jede für sich:

**1. Die Docker-Engine** (Abbilder holen). Sie liest keine Variablen aus der
Shell, sondern aus ihrem Dienst. Als systemd-Ergänzung
`/etc/systemd/system/docker.service.d/http-proxy.conf`:

```ini
[Service]
Environment="HTTP_PROXY=http://proxy.example.org:3128"
Environment="HTTPS_PROXY=http://proxy.example.org:3128"
Environment="NO_PROXY=localhost,127.0.0.1"
```

```bash
systemctl daemon-reload && systemctl restart docker
```

Oder in `/etc/docker/daemon.json` unter `"proxies"` (`http-proxy`,
`https-proxy`, `no-proxy`), dann `systemctl restart docker`. Siehe
[Docker, „Daemon proxy configuration“](https://docs.docker.com/engine/daemon/proxy/).
Das gilt nur für die Engine, nicht für die Container.

**2. Die Container**, über eine `docker-compose.override.yml` neben
`docker-compose.yml`. Compose liest sie von selbst, und ein neues
`docker-compose.yml` überschreibt sie nicht:

```yaml
services:
  hapm:
    environment:
      HTTP_PROXY: http://proxy.example.org:3128
      HTTPS_PROXY: http://proxy.example.org:3128
      NO_PROXY: localhost,127.0.0.1
      NODE_USE_ENV_PROXY: "1"
  crowdsec:
    environment:
      HTTP_PROXY: http://proxy.example.org:3128
      HTTPS_PROXY: http://proxy.example.org:3128
      NO_PROXY: localhost,127.0.0.1,0.0.0.0,crowdsec
```

Danach `docker compose up -d`.

- **HAPM** läuft auf Node 24 (`node:24-bookworm-slim` im `Dockerfile`). Dessen
  `fetch`, über das HAPM alle eigenen Abrufe macht (Registry, GitHub, Cloudflare,
  Hetzner, db-ip), beachtet `HTTP_PROXY` und `HTTPS_PROXY` **nur mit
  `NODE_USE_ENV_PROXY=1`** ([Node.js, `NODE_USE_ENV_PROXY`](https://nodejs.org/docs/latest-v24.x/api/cli.html#node_use_env_proxy1),
  seit 24.0.0, Stabilität „Active Development“). Der Docker-Socket ist ein
  Unix-Socket und geht nie über den Proxy. acme.sh benutzt `curl`, und `curl`
  liest `HTTPS_PROXY` und `NO_PROXY` selbst. Ein eigener ACME-Server im
  eigenen Netz gehört mit in `NO_PROXY`.
- **CrowdSec** beachtet `HTTP_PROXY`, `HTTPS_PROXY` und `NO_PROXY` laut seiner
  [Dokumentation](https://docs.crowdsec.net/docs/next/configuration/network_management).
  `cscli` spricht im Container die lokale API unter `http://0.0.0.0:8080` an,
  daher `0.0.0.0` in `NO_PROXY`; ohne das ginge auch dieser Aufruf an den Proxy.
- **Der Bouncer, HAProxy und Postgres** brauchen keinen Proxy.

Was am Container von HAPM eingestellt ist, übernimmt ein Update aus der
Oberfläche (`recreateBody`, siehe „Updates“), die Variablen bleiben also.

**3. SMTP** geht an keinem Proxy vorbei und durch keinen hindurch, siehe oben.

**Prüfen:** „Updates“ zeigt bei jedem Bestandteil, ob die Abfrage gelang
(unbekannt heißt: kein Weg zur Registry). Unter „Reverse-Proxy, CrowdSec“,
Reiter „Regeln“, meldet „Regeln aktualisieren“ einen Fehler, wenn der Hub nicht
erreichbar ist. Von Hand:

```bash
docker exec hapm-crowdsec cscli hub update
docker exec hapm node -e "fetch('https://api.github.com').then(r => console.log(r.status))"
```

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
