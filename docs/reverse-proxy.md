# Der Reverse-Proxy

Jede Entscheidung des Bereichs, mit ihrem Grund. **Lies das, bevor du an
/reverse-proxy oder lib/haproxy/ etwas änderst.**

HAPM verwaltet genau **ein** HAProxy: das im selben Compose-Stack. Eine Seite
(`/reverse-proxy`), drei Vorgänge: anlegen, ändern, löschen. Gegliedert nach den
Marker-Blöcken der Konfiguration, mit einer Suche über Domain, Dienst-ID und
Backend-Adresse (`matchesSearch`, rein und getestet).

### Der Aufbau

- **Eine Maschine, und zwar diese.** `localServer()` /
  `LOCAL_SERVER_ID = 'local'` (`lib/helpers.ts`) ist die eine, sie steht in
  keiner Tabelle. `sshExec` in `lib/ssh.ts` führt jedes Kommando lokal aus
  (`bash -c` im HAPM-Container). „Auf der Maschine"
  heißt in diesem Dokument: in diesem Container, der `/etc/haproxy` und
  `/run/haproxy` als Volumes mit dem HAProxy-Container teilt und
  `/var/log/haproxy` und `/root/.acme.sh` selbst hält. Beide Container laufen im
  Netz des Hosts. Aufbau, Volumes und Updates stehen in
  [`betrieb.md`](betrieb.md). Läufe und Metriken tragen eine `serverId` (immer
  `local`), die Routen liefern eine Liste `proxies` mit einem Eintrag. In der
  Oberfläche gibt es keine Auswahl und keine Spalte „Maschine".
- **`haproxy` und der Reload sind Kommandos des Abbilds.** `haproxy -c -f …`
  läuft über `/usr/local/bin/haproxy` → `bin/hapm-ctl.mjs` **im
  HAProxy-Container**, also mit genau der Version, die die Datei danach laden
  muss. Neu geladen wird mit `hapm-reload` (`RELOAD_ARGV` in `provision.ts`):
  über den Master-Socket
  (`/run/haproxy/master.sock`), der erst antwortet, wenn der neue Prozess steht
  oder gescheitert ist; ohne Socket über `SIGHUP` an den Container. Ein
  gestopptes HAProxy wird stattdessen gestartet. Auch der Deploy-Hook von
  acme.sh ruft `hapm-reload` auf.
- **Die Ersteinrichtung macht HAPM selbst** (`lib/bootstrap.ts`, bei jedem
  Start, nur was fehlt, nie überschreibend): Verzeichnisse, Fehlerseiten unter
  `/etc/haproxy/errors/`, ein selbst signiertes Platzhalter-Zertifikat
  (`000-hapm-default.pem`, damit `crt /etc/haproxy/certs/` nie leer ist), die
  Grundkonfiguration (`lib/haproxy/base-config.ts`, nur wenn `haproxy.cfg`
  fehlt) und acme.sh.
- **Vorbild der Grundkonfiguration und jedes geschriebenen Blocks** ist die
  Konfiguration, die der Betreiber von HAPM produktiv fährt: TLS-Optionen,
  Timeouts, errorfiles, Umleitung auf HTTPS mit Ausnahme für ACME,
  `strict-sni`, HTTP/3 mit `alt-svc` und `limited-quic`, die globalen Header,
  dazu Healthcheck, Sperren, Wildcards und Pfad-Regeln je Ziel. Was HAPM
  schreibt, soll dort genauso stehen. Bewusst anders sind nur zwei Zeilen im
  `global`-Block, beide wegen des Containers: kein `daemon` (HAProxy läuft im
  Vordergrund unter dem Master-Socket) und `log stdout format raw` statt
  `short` (HAPM schreibt das Log selbst mit, `lib/haproxy-log.ts`). Eine
  bestehende `haproxy.cfg` fasst das nicht an: die Grundkonfiguration entsteht
  nur, wenn die Datei fehlt.
- **acme.sh richtet HAPM ein und hält es aktuell** (`lib/acme.ts`): installiert
  aus `/opt/acme.sh` im Abbild in das Volume `/root/.acme.sh`, mit `--no-cron`
  (im Container gibt es keinen Cron) und Let's Encrypt als Vorgabe. Die tägliche
  Erneuerung (`acme.sh --cron`) stößt der Scheduler an (`lib/scheduler.ts`).
- **Das Access-Log ist ein Mitschnitt.** HAProxy schreibt im Container auf
  stdout; `lib/haproxy-log.ts` folgt dem Log des Containers und schreibt es nach
  `/var/log/haproxy/haproxy.log`, einen der Orte, an denen die Auswertung sucht.
- **Postgres mit Dokumenten statt Spalten.** Hinter `lib/db` liegt je
  Collection eine Tabelle mit dem Dokument als `jsonb`
  (`lib/db/postgres-driver.ts`, siehe [`betrieb.md`](betrieb.md)). Collections des
  Bereichs: `haproxy_runs`, `haproxy_metrics`, `geoip_table`, `dns_zones`,
  `service_tokens`, `page_design`, `page_files`.
- **Service-Token ohne Bereiche.** Ein Token gilt für die Reverse-Proxy-API
  (`/api/internal/haproxy/**`), andere Teilbäume gibt es nicht. Er lässt sich an
  Adressen binden. Siehe [`reverse-proxy-api.md`](reverse-proxy-api.md).
- **Feste Kennungen**, die in `haproxy.cfg` oder auf der Platte stehen und
  zurückgelesen werden: Cookie `HAPMSRV`, `hapm_lock_<id>`,
  `/etc/haproxy/hapm-lock/`, `.hapm-original` / `.hapm-previous`,
  `haproxy.cfg.hapm-new`, das Token-Präfix `hapm_`. Sie zu ändern hieße, dass
  bestehende Einträge nicht mehr wiedererkannt werden.

### Vier Arten, zwei Formulare

„Ziel anlegen" führt zuerst auf eine Auswahl (`TargetKindDialog`) und erst
danach ins Formular:

| Auswahl | Was daraus wird | Wo es steht |
|---|---|---|
| **Reverse-Proxy** | Eine Domain auf ein Ziel im Backend | Dienst, `ServiceFormModal` |
| **Lastverteilung** | Eine Domain auf mehrere Ziele, mit `balance` und auf Wunsch Sitzungsbindung | Dienst, `ServiceFormModal` |
| **HTTP-Weiterleitung** | Eine Domain antwortet mit 301/302 | Dienst, `ServiceFormModal` |
| **TCP-Weiterleitung** | Ein Port dieses Servers, durchgereicht | `listen`-Abschnitt, `StreamFormModal` |

**Jede Auswahl führt auf ein eigenes Formular, das nur seine Felder zeigt.** Im
Reverse-Proxy-Formular gibt es kein Verteilverfahren, keine Gewichtung und keine
Sitzungsbindung; im Weiterleitungs-Formular keine Backend-Zeilen, keine Header,
keinen Healthcheck und keine Pfad-Regeln. EIN Formular mit einem Umschalter in
der Mitte hätte geheißen: wer eine Weiterleitung will, füllt erst Backend-Zeilen
aus und findet den Schalter danach.

**Die ersten drei sind trotzdem derselbe Eintrag** — es gibt nur einen
`CreateServiceInput`, eine Prüfung und einen Schreibweg. Unterschiedlich ist,
welche Felder ein Formular zeigt.

Daraus folgt die Regel, an der alles hängt: **was ein Formular nicht zeigt,
schickt es auch nicht.** `balance` und `sticky` behalten beim Bearbeiten ihren
gelesenen Wert im Zustand, und ein Reverse-Proxy-Formular, das ihn mitschickte,
schriebe eine Einstellung zurück, die niemand sehen konnte. Deshalb setzt das
Formular jedes Feld seiner Nicht-Sorte hart auf den neutralen Wert.

**Und deshalb muss `serviceKind` vollständig sein.** Sie entscheidet, welches
Formular beim Bearbeiten aufgeht; nennt sie einen Eintrag mit Sitzungsbindung
`proxy`, verlöre er sie beim ersten Speichern — dieselbe Sorte Verlust, gegen
die `extras` überhaupt gebaut ist. Es zählt deshalb **jede** Eigenschaft, die
nur die Lastverteilung kann, und jede für sich allein: ein benanntes Verfahren,
die Bindung, eine Gewichtung, ein zweites Ziel.

Die Art wird **nirgends gespeichert** — es gibt keine Zeile in `haproxy.cfg`, in
der sie stünde, und ein Feld dafür wäre eines, das `toCreateInput` erfinden
müsste. Wer die Verteilung aus einem Eintrag herausnimmt, findet ihn beim
nächsten Öffnen als Reverse-Proxy vor, ohne dass irgendwo etwas umgestellt
wurde.

**Der eine Weg zwischen den Formularen ist ein Knopf und kein Feld.** Im
Reverse-Proxy-Formular steht beim Bearbeiten „auf Lastverteilung umstellen";
`ServiceFormModal` lässt diese Übersteuerung zu, weil das größere Formular alles
zeigt, was das kleinere zeigt. Die Gegenrichtung gibt es nicht als Knopf und
braucht sie nicht: wer in der Lastverteilung auf ein Ziel zurückgeht und das
Verfahren leert, hat danach einen Reverse-Proxy. Ohne den Knopf wäre ein zweiter
Webserver hinter einer laufenden Domain nur über Löschen und Neuanlegen zu
haben — Domain offline, Zertifikat weg, neuer Antrag gegen das Kontingent.

**Die vierte ist etwas anderes**, siehe „TCP-Weiterleitungen" weiter unten.

### Lastverteilung: `balance` und die Sitzungsbindung

Mehrere `server`-Zeilen sind bereits Lastverteilung — HAProxy verteilt sie
nach dem `balance` aus dem `defaults`-Block. Das Feld benennt das Verfahren:
ohne es landete eine `balance leastconn`-Zeile in `extras` und machte den
Eintrag unbearbeitbar.

- **`balance` ist ein eigenes Feld**: es gibt genau einen Wert, und er ist die
  Frage, um die es beim Verteilen geht. `null` heißt **keine Zeile** und nicht „roundrobin": was im `defaults`-Block
  steht, gilt weiter, und eine hingeschriebene Vorgabe wäre eine Behauptung über
  eine Datei, in die `config.ts` nicht sieht.
- **Der Wert kommt aus einer Allow-Liste** (`HAPROXY_BALANCE`), aus demselben
  Grund wie bei den DNS-Anbietern: er geht als Wort in eine Zeile der
  Konfiguration. Ein `balance` **mit Parameter** (`balance uri whole`) fällt
  durch und macht den Eintrag nur lesbar — der Parameter käme beim
  Neuschreiben nicht mit.
- **Die Sitzungsbindung zählt nur vollständig.** Sie besteht aus zwei Hälften,
  die zueinander gehören: `cookie HAPMSRV insert indirect nocache httponly secure`
  im Backend und `cookie <servername>` auf **jeder** server-Zeile. Die Zeile
  allein setzt einen Cookie, den niemand einlöst; die Marken allein werden nie
  gesetzt. Was halb dasteht, wird gelesen und nicht neu geschrieben.
- **Die Marke ist der Servername und nichts Eigenes.** HAProxy schickt den Wert
  aus dem Cookie an den Server, der so heißt. Ein abweichender Wert wäre die
  teure Sorte Fehler: neu geschrieben stünde dort der eigene Name, und alle
  gebundenen Sitzungen wanderten still auf ein anderes Ziel. Deshalb ist ein
  fremder Wert ein `extras`-Eintrag.
- **Die Gewichtung gibt es nur hier** (`weight`, 0 bis 256). Nicht beim
  Reverse-Proxy (ein Ziel bekommt ohnehin alles), nicht bei einer Pfad-Regel
  (die verteilt nichts, sie trennt) und nicht bei einer Weiterleitung. Sie hat
  deshalb ein eigenes Ziel-Modell: `RouteServerInput` kennt kein `weight`,
  und steht auf der server-Zeile einer Regel trotzdem eines, wird es **gelesen**
  und der Eintrag ist nur noch lesbar. Wegzuschreiben wäre dieselbe Sorte
  Verlust wie bei `extras`.
  `null` heißt wieder **keine Angabe** und nicht 1, aus demselben Grund wie bei
  `balance`. Die **0** ist kein Sonderfall, den man abfangen müsste, sondern ein
  eigener Zustand: das Ziel bekommt keine neuen Verbindungen mehr, behält aber
  seine gebundenen Sitzungen — der Weg, einen Server aus dem Betrieb zu nehmen,
  ohne jemanden mitten im Klicken hinauszuwerfen.
- **Verfahren und Bindung gelten nur für das eigene Backend**, nicht für die der
  Pfad-Regeln. Eine Regel hat ein Ziel, und wo sie mehrere hat, ist die Frage
  nach dem Verfahren eine andere.
- Eine Weiterleitung schließt beides aus, ablehnend statt still: sie hat keine
  Ziele, auf die sich etwas verteilen ließe.

### Servernamen und gespeicherte Ziele

**Die Dialoge fragen keinen Servernamen mehr.** Eine Zeile ist eine Adresse
(`host:port`), der Name entsteht beim Schreiben (`serverNames` in `config.ts`,
für Dienste, Pfad-Regeln und TCP-Weiterleitungen gleich). Gelesene Namen bleiben
im Zustand des Formulars und gehen unverändert zurück: an ihnen hängt die
Sitzungsbindung (die Cookie-Marke ist der Servername, siehe oben), und ein
Umbenennen schickte gebundene Sitzungen still auf ein anderes Ziel. Eine leere
Zeile bekommt den ersten freien Namen `serverN` ab ihrer Position und nicht stur
den Namen ihrer Position. Sonst hieße nach dem Entfernen von `server1` und dem
Anhängen einer neuen Zeile die neue ebenfalls `server2`, und zwei gleich
benannte Server lehnt HAProxy ab (`tests/haproxy/server-names.test.ts`).

**Gespeicherte Ziele sind eine Eingabehilfe und keine Verknüpfung**
(`lib/haproxy/saved-targets.ts`, Collection `saved_targets`, Routen
`/api/haproxy/targets`). In der Oberfläche heißen sie **Backend-Server** und
stehen als eigener Abschnitt auf `/reverse-proxy` zwischen Gruppen und HAProxy
(`SavedTargetsPanel`): „Ziel" ist in HAPM der Eintrag am Reverse-Proxy, und
dasselbe Wort für zwei Dinge auf einer Seite wäre eine Verwechslung. Nicht in
einer Gruppe, weil ein Server Ziele in mehreren Gruppen tragen kann. Ein Eintrag hat
Name, Host und einen freiwilligen Port. Neben jedem Adressfeld der Dialoge steht
die Auswahl (`SavedTargetPick`): mit Port setzt sie die ganze Adresse ein, ohne
Port nur den Host, und der Port im Feld bleibt stehen. Der Fall dafür ist ein
Server mit mehreren Diensten auf verschiedenen Ports. In `haproxy.cfg` steht
danach die Adresse selbst und keine Kennung: eine Verknüpfung müsste
`toCreateInput` beim Zurücklesen erfinden. Ein gespeichertes Ziel zu ändern oder
zu löschen fasst deshalb keinen Eintrag an. Die Auswahl zeigt beim Öffnen das
Ziel, dessen Adresse im Feld steht (`findSavedTarget`, mit Port vor ohne).

### Lange Verbindungen und `timeout tunnel`

WebSockets reicht HAProxy im HTTP-Modus ohne Zusatz durch. Was abbricht, ist die
offene Verbindung ohne Daten: ohne `timeout tunnel` gilt `timeout client` bzw.
`timeout server` aus `defaults`, in der Grundkonfiguration 50 Sekunden. Der
Schalter „Lange Verbindungen“ schreibt `TUNNEL_LINE` in die Backends eines
Ziels. In die globalen Einstellungen gehört es nicht: die stehen im Frontend,
und dort erlaubt HAProxy `timeout tunnel` nicht.

Steht `timeout tunnel` schon im `defaults`-Block, der für die Backends von HAPM
gilt (der letzte vor dem ersten Backend-Block, `parseDefaultsTunnel`), meldet
`/api/haproxy/services` den Wert als `defaultsTunnel`. Der Schalter steht dann
an und gesperrt mit „Gilt schon für alle Ziele“, solange das Ziel keine eigene
Zeile hat; eingeschaltet schriebe er dieselbe Wirkung ein zweites Mal hin. Hat
ein Ziel trotzdem eine, bleibt er bedienbar, damit sie sich entfernen lässt.

### Ziele, die HTTPS sprechen

Manche Ziele sprechen selbst nur HTTPS: Proxmox auf 8006, TrueNAS, eine
Anwendung mit eigenem Zertifikat. Ohne Zusatz spricht HAProxy dort Klartext
und bekommt einen Fehler oder einen Verbindungsabbruch zurück. Das Feld dafür
heißt `backendTls` und hat drei Werte; geschrieben wird es auf **jede**
server-Zeile des Backends (`serverParams`, `backendTlsParams`):

| `backendTls` | Formular | An der server-Zeile |
|---|---|---|
| `off` (Vorgabe) | HTTP | nichts |
| `insecure` | HTTPS | `ssl verify none sni req.hdr(host)` |
| `verify` | HTTPS, Zertifikat prüfen | `ssl verify required ca-file @system-ca sni req.hdr(host)` |

Mit Healthcheck (beim Dienst) bzw. Verbindungsprüfung (bei einer Regel) kommt
`check-sni <Hauptdomain>` dazu, siehe unten. Die Belege stehen im Handbuch der
Fassung hinter `haproxy:lts` (heute 3.4,
<https://www.haproxy.org/download/3.4/doc/configuration.txt>, Abschnitt 5.2).

- **Ein Feld mit drei Werten und nicht zwei Schalter.** „Prüfen ohne HTTPS"
  gibt es nicht, und ein Modell, das den Zustand zulässt, braucht eine Regel
  mehr, die ihn ablehnt. Die Werte kommen aus einer Allow-Liste
  (`BACKEND_TLS`), aus demselben Grund wie bei `balance`: die Art entscheidet
  über Wörter in der Datei.
- **Je Backend und nicht je Zeile.** Die Ziele einer Lastverteilung sind
  gleichartige Server; eine Wahl je Zeile wäre eine Spalte, die fast immer
  dieselbe Antwort hat. Gelesen wird trotzdem je Zeile
  (`HaproxyBackendServer.tls`). Stehen verschiedene Arten nebeneinander, gilt
  die der ersten Zeile, die anderen landen in `extras`, und der Eintrag ist nur
  lesbar (`readBackendTls`).
- **Eine Pfad-Regel hat ihre eigene Einstellung** (`RouteInput.backendTls`)
  und erbt nicht die des Dienstes. Eine Regel zeigt auf einen anderen Port,
  oft auf ein anderes Programm, und ob dort HTTPS gesprochen wird, ist eine
  Eigenschaft dieses Ports. Eine neue Regel beginnt mit HTTP.
- **`verify none` steht ausdrücklich da.** Ohne `verify` gilt die Vorgabe aus
  `global`, und die ist `required` („Unless "ssl_server_verify" appears in the
  global section, "verify" is set to "required" by default."). Ohne CA-Datei
  gibt es dann nichts, wogegen geprüft würde; `pnpm haproxy:verify-tls`
  prüft, dass `haproxy -c` ein nacktes `ssl` ablehnt.
- **`verify` prüft gegen die CAs des Systems, `ca-file @system-ca`.** „In
  order to use the trusted CAs of your system, the "@system-ca" parameter could
  be used in place of the cafile." Im Handbuch von 2.4 fehlt es, ab 2.6 steht
  es da (`supportsSystemCa`). Das offizielle Abbild installiert dafür
  `ca-certificates` (Dockerfile von 3.4, mit dem Kommentar „@system-ca").
  Auf einem älteren HAProxy lehnt die Vorabprüfung `verify` mit Grund ab
  (`assertTlsSupported` in `provision.ts`), und das Formular sperrt die Wahl.
  Eine eigene CA-Datei (interne CA) bietet HAPM nicht an: die Datei müsste
  HAPM verwalten. Eine Zeile mit eigener `ca-file` wird gelesen und ist nur
  lesbar.
- **SNI ist die Domain der Anfrage, `sni req.hdr(host)`.** Das Handbuch sagt
  zu `sni`: „SNI in HTTPS must always match the Host field" und verweist für
  HTTPS auf `req.hdr(host)`. Die Hauptdomain als fester SNI wäre bei einem
  Eintrag mit mehreren Domains falsch: ein Ziel mit einem Zertifikat je Domain
  (Caddy, Traefik, nginx mit mehreren `server`-Blöcken) gäbe für jede Domain
  das der Hauptdomain heraus, und mit `verify` scheiterte die Prüfung für alle
  anderen. Mit `verify` wird das Zertifikat gegen diesen Namen geprüft („the
  resulting name will also be matched against the server certificate's
  names"). Das Ziel braucht also ein Zertifikat für die öffentliche Domain;
  eins nur für `pve.lan` passt zu „HTTPS" ohne Prüfung. Leerlaufende
  Verbindungen teilt HAProxy nur zwischen Anfragen mit demselben SNI („the SNI
  is assigned to the connection name for "http-reuse""), das kostet bei vielen
  Domains auf einem Ziel ein paar Verbindungen mehr. Ab 3.3 setzt HAProxy
  dasselbe von selbst (`sni-auto`, `req.hdr(host),field(1,:)`); geschrieben
  wird es trotzdem, weil 2.6 bis 3.2 das nicht tun. Das `field(1,:)` (Port
  abschneiden) fehlt mit Absicht: die Host-ACL trifft nur Domains ohne Port,
  eine Anfrage mit `Host: x:8443` kommt hier nie an.
- **Der Healthcheck läuft von selbst über TLS**, aber ohne SNI. „When this
  option is used, health checks are automatically sent in SSL too unless there
  is a "port" or an "addr" directive", also kein `check-ssl`. Aber: „When
  "sni" or "alpn" are set on the server line, their value is not used for
  health checks", und ein Check ist keine Anfrage, `req.hdr(host)` gibt es
  dort nicht. Ein Ziel, das ohne SNI kein Zertifikat herausgibt (Caddy lehnt
  den Handshake ab), fiele durch, und HAProxy nähme ein funktionierendes Ziel
  aus dem Betrieb. Deshalb `check-sni <Hauptdomain>` (`backendCheckSni`): der
  HTTP-Healthcheck schickt sie ohnehin als Host-Header. `check-sni-auto` gibt
  es erst ab 3.3 und nur für den HTTP-Check, nicht für die TCP-Prüfung einer
  Regel. Ist die Hauptdomain eine Wildcard, gibt es keinen Namen und keinen
  `check-sni`. Für ihn gilt die Regel des Host-Headers im Healthcheck: ein
  `check-sni` mit einer anderen Domain würde beim Speichern still
  umgeschrieben, also ist er ein `extras`-Eintrag; ändert sich die
  Hauptdomain, zieht er mit.
- **Kein `alpn h2`.** Ohne ALPN spricht HAProxy HTTP/1.1 mit dem Ziel; „ALPN
  is required to connect to HTTP/2 servers", und nötig ist es für die Fälle
  hier nicht. Eine Zeile mit `alpn` ist nur lesbar.
- **Gelesen wird nur die ganze Folge**, Wort für Wort in der Reihenfolge, in
  der `serverParams` sie schreibt: `check`, `weight`, `cookie`, die
  HTTPS-Wörter, `check-sni`. Für HAProxy ist die Reihenfolge beliebig, hier
  nicht, aus demselben Grund wie bei den übrigen Parametern. Was davon
  abweicht (`ssl` allein, `verify none` ohne SNI, `verifyhost`, ein fester
  SNI, eine andere Reihenfolge), bleibt in `extras`
  (`tests/haproxy/backend-tls.test.ts` hält die Varianten fest).
- **Nicht bei TCP-Weiterleitungen.** Dort reicht HAProxy durch, was kommt; ob
  dahinter TLS gesprochen wird, macht der Client mit dem Ziel aus. Ein `ssl`
  auf einer server-Zeile eines `listen`-Abschnitts ist ein `extras`-Eintrag.
- **Nicht bei einer Weiterleitung**: sie hat keine Ziele. Die Prüfung lehnt
  es ab, `readServiceInput` setzt es dort auf `off` wie `balance`.
- **Die Art eines Eintrags (`serviceKind`) hängt nicht daran.** HTTPS gibt es
  im Reverse-Proxy- und im Lastverteilungs-Formular gleich.
- **Die Karte** trägt an jeder Zeile mit HTTPS ein Schild „HTTPS" mit
  `LockKeyhole`, an einer Regel das Symbol im Chip. Bewusst nicht das Schloss
  der Sperre: das sagt etwas darüber, wer hereinkommt, dieses darüber, wie
  HAProxy weiterspricht.
- **Der Import** (`lib/haproxy/import.ts`, `readServerTls`) übernimmt `ssl`
  auf einer server-Zeile, wenn sich das Ziel danach verhält wie vorher:
  - `verify none` mit beliebigem oder ohne `sni` wird `insecure`. Geprüft wird
    nichts, der SNI wählt nur das Zertifikat; weicht er von `req.hdr(host)`
    ab, steht ein Hinweis am Eintrag.
  - `verify required ca-file @system-ca` mit SNI aus dem Host
    (`req.hdr(host)`, auch mit `,field(1,:)` oder `,lower`) wird `verify`.
    Ohne `sni` oder mit festem prüfte HAProxy den Namen anders als HAPM
    danach, und ein Ziel, das heute durchkommt, fiele durch: ein Grund, kein
    Hinweis. Eine eigene `ca-file` ebenso.
  - `ssl` ohne `verify` gilt nach `ssl-server-verify none` in `global` als
    `insecure`, sonst lädt HAProxy die Zeile nicht.
  - `check-ssl` und `check-sni` entfallen: das eine ist bei `ssl` die
    Vorgabe, das andere schreibt HAPM selbst (`backendCheckSni`).
  - `verifyhost`, `alpn`, Client-Zertifikate (`crt`) und alles Weitere
    bleiben ein Grund. HTTP und HTTPS gemischt in einem Backend auch, und
    `ssl` an einer TCP-Weiterleitung.

### Gruppen

**Welche Gruppen es gibt, sagt die Datei und nicht der Code.** Eine Gruppe ist
ein Marker-Paar im Frontend (`# BEGIN AUTO <NAME> SERVICES` …
`# END AUTO <NAME> SERVICES`) und eines dahinter (`… BACKENDS`); `parseScopes`
liest sie aus `haproxy.cfg`. Der Name im Marker ist die Kennung, Beschriftung
und Adressteil werden daraus abgeleitet (`scopeLabel`/`scopeSlug`) und nirgends
gespeichert — zwei Quellen für denselben Namen wären genau dann verschieden,
wenn jemand in der Datei einen Block umbenennt. `INTERNE-TOOLS` heißt „Interne
Tools" und liegt unter `/reverse-proxy/interne-tools`. Eine Tabelle mit eigenen
Schreibweisen gibt es nicht: eine Gruppe heißt so, wie sie im Marker steht.
Genau eine Ausnahme steht in `scopeLabel`: das Wort `HAPM` behält seine
Großbuchstaben, in jeder Schreibweise des Markers. Es ist der Name des Produkts,
und die Einrichtung legt eine Gruppe dieses Namens an, die sonst „Hapm" hieße.
`HAPM-INTERN` heißt „HAPM Intern". Der Adressteil bleibt klein.

**Eine frische Installation hat keine Gruppe.** Die Grundkonfiguration
(`base-config.ts`) bringt keine mit, die erste legt der Nutzer in der
Oberfläche an. Ohne Gruppe lässt sich kein Ziel anlegen; `/reverse-proxy` zeigt
dann statt der Liste den Weg zur ersten.

- **Angelegt wird mit einem Lauf** (`POST /api/haproxy/scopes`). Vorabgeprüft
  wird, **bevor** der Lauf startet — sonst hinterließe ein Tippfehler eine Zeile
  in der Historie statt einer Meldung im Formular. Die Antwort trägt eine Liste
  `runs` mit genau einem Eintrag.
- **Der neue Block schließt an den LETZTEN Marker seiner Art an.** Der
  SERVICES-Teil muss im Frontend bleiben, der BACKENDS-Teil außerhalb.
- **Die erste Gruppe liest ihre Stelle am Marker der globalen Einstellungen ab**
  (`firstScopeAnchor`). Gibt es keinen Marker, an den sich anschließen ließe,
  sagt `# Globale HTTPS-Settings`, in welchem Frontend die Dienste liegen: der
  SERVICES-Teil kommt dort vor `default_backend` samt dem Kommentar darüber,
  eingerückt wie das Frontend, der BACKENDS-Teil hinter das Frontend, vor den
  nächsten Abschnitt samt seiner Überschrift (in der Grundkonfiguration: vor
  `backend acme_challenge`). Eine so angelegte Gruppe ist vollständig und
  entfernbar, und das Entfernen stellt die Datei Zeichen für Zeichen wieder her.
  Fehlt auch dieser Marker, ist das eine Meldung und keine Vermutung darüber,
  wo im Frontend ein Block hingehört.
- **Entfernt wird nur, was HAPM angelegt hat**: BEGIN **und** END in
  beiden Teilen und nichts als Leerzeilen dazwischen (`removable`). Ein
  vorgefundener Block ohne BEGIN fängt nirgends sichtbar an — sein Anfang ist
  „hinter dem Marker davor", und das ist im Frontend der ganze Kopf mit `bind`
  und den globalen Zeilen. Dazu muss die Gruppe leer sein, und das wird im Lauf
  noch einmal geprüft: zwischen Anzeige und Vorgang liegt Zeit, in der jemand
  einen Eintrag angelegt haben kann.
- **Umbenennen gibt es nicht.** Der Name steht im Marker, in der Adresse der
  Seite und in jeder Historienzeile; ihn zu ändern hieße, drei Dinge gleichzeitig
  umzuschreiben, von denen eines (die Historie) gar nicht geändert werden darf.
- **Einträge außerhalb aller Marker sind keine Gruppe.** HAPM fasst sie nicht
  an, also gibt es für sie keine eigene Seite. Dass es sie gibt, bleibt trotzdem
  sichtbar — die Übersicht nennt ihre **Anzahl** (`unmanagedCount`) und listet
  sie nicht. Ganz wegzulassen wäre ein stiller blinder Fleck, und der fällt erst
  auf, wenn eine Domain doppelt vergeben wird.

### Das Ziel der Oberfläche ist geschützt

Die Einrichtung legt die Gruppe `HAPM` und darin das Ziel `hapm` an: die Domain
der Oberfläche auf den Port von HAPM. Wer dieses Ziel entfernt, ihm die Domain
nimmt oder seine Gruppe abräumt, sperrt sich aus. Die Oberfläche, in der sich
das rückgängig machen ließe, ist danach nicht mehr erreichbar. Deshalb lehnt
HAPM das ab (`lib/haproxy/protected.ts`, rein, `tests/haproxy/protected.test.ts`).

- **Geschützt ist das Ziel, über das die Adresse von HAPM läuft**: das, dessen
  Domains den Host aus `publicUrl` (Einstellungen) treffen, exakt oder über eine
  Wildcard des Ziels (`ownsDomain`, die Semantik der ACL). Treffen zwei, gilt
  die obere Weiche, wie bei HAProxy. Ist `publicUrl` leer oder trägt kein Ziel
  die Domain, ist nichts geschützt.
- **An `publicUrl` und nicht am Namen.** Ein Name sagt nichts darüber, worüber
  die Oberfläche läuft: wer das Ziel von Hand angelegt oder umbenannt hat, wäre
  ungeschützt, und ein beliebiges Ziel namens `hapm` wäre unlöschbar. Die
  Konstanten `SETUP_SCOPE` und `SETUP_SERVICE_ID` kommen in der Regel nicht vor.
- **Drei Absagen** (jeweils `409` mit der Adresse und dem Ausweg im Text): das
  Ziel entfernen, das Ziel so ändern, dass es die Domain aus `publicUrl` nicht
  mehr trägt, und die Gruppe entfernen, in der es liegt. Alles andere bleibt
  möglich: Server, Healthcheck, weitere Domains, Sperren, auch der Umzug in eine
  andere Gruppe und, über die API, ein neuer Name. Der Schutz der Gruppe folgt
  dem Ziel.
- **In die Gruppe der Oberfläche legt niemand von Hand an**
  (`refuseSurfaceScopeEntry`): kein neues Ziel, keine TCP-Weiterleitung, kein
  Umzug hinein, auch nicht über Import, API oder MCP. Was schon darin liegt,
  bleibt änderbar. Die Gruppenseite zeigt dort kein „Ziel anlegen“, und die
  Dialoge bieten die Gruppe nicht an. Nur die Einrichtung legt dort an: sie ruft
  die Vorabprüfung ohne `SurfaceProtection` auf.
- **Der Ausweg** steht in jeder Meldung: unter „Allgemein" die Adresse von HAPM
  ändern. Danach trifft kein Ziel mehr die alte Adresse, und der Schutz greift
  dort nicht mehr. Die Einrichtung lässt sich nicht erneut öffnen und ist kein
  Ausweg.
- **`provision.ts` liest die Einstellungen nicht**, wie bei `exposure`. Die
  Routen lesen `publicUrl` und geben es als `SurfaceProtection` mit:
  `precheckDelete`, `precheckUpdate`, `precheckScope(…, 'remove', …)` und über
  `RunOptions.protection` an den Lauf, der im Lock noch einmal prüft. Der Runner
  hat keine Vorgabe: ein Lauf `delete`, `update` oder `scope-remove` ohne die
  Angabe scheitert, statt still ohne Schutz zu laufen. Das gilt für die
  Sitzungs-Routen und für `/api/internal/haproxy/**` gleich.
- **Die Einrichtung ist die eine Ausnahme.** Sie ändert die Domain des Ziels
  selbst und setzt `publicUrl` erst im letzten Schritt neu. Dafür gibt sie
  ausdrücklich `WITHOUT_SURFACE_PROTECTION` mit (`lib/setup/run.ts`, nur dort).
  Die Regel selbst kennt keine Ausnahme.
- **Die Oberfläche zeigt den Stand, statt einen Knopf anzubieten, der
  scheitert.** `/api/haproxy/services` trägt je Proxy `surface` (Ziel, Gruppe,
  Host, Adresse oder `null`). Die Karte des Ziels trägt die Marke „Oberfläche von
  HAPM", ihr Löschen-Knopf ist gesperrt. Die Gruppe trägt dieselbe Marke, und
  „Gruppe entfernen" steht gesperrt da (bei jeder anderen nicht leeren Gruppe
  fehlt der Knopf). Der Bearbeiten-Dialog prüft mit derselben Funktion wie die
  Route (`refuseSurfaceUpdate`) und sperrt das Speichern, solange die Domain
  fehlt. Die interne API nennt es am Eintrag als `surface: true`.

### Die Datei ist die Wahrheit

**Es gibt keine Collection dahinter.** `/etc/haproxy/haproxy.cfg` ist die
Wahrheit; die Seite liest sie bei jedem Aufruf. Eine Spiegelung
in der Datenbank wäre eine zweite Quelle, die genau dann falsch ist, wenn jemand
die Datei von Hand angefasst hat — also in dem Moment, in dem man sie am
dringendsten braucht. Der Preis ist eine Probe je Aufruf (`probeProxy`: Datei
lesen, Version, acme.sh, Stats-Socket), deshalb
pollt die Übersicht im 60-Sekunden-Takt und hat einen eigenen
Aktualisieren-Knopf daneben.

Die **Gruppenseite** pollt dagegen alle 20 Sekunden, und zwar wegen der
Healthcheck-Marke auf jeder Karte: die Konfiguration ändert sich nicht im
Minutentakt, ob ein Ziel antwortet, schon. Eine Farbe, die eine Minute alt sein
darf, sagt über ein totes Backend nichts mehr — der Ausweg wäre F5, und den soll
es nicht geben.

**Das Verfahren steht im Code und nicht als Shell-Skript neben HAProxy.** Was
ein Skript tut, lässt sich nicht testen, sondern nur ausprobieren, und seine
Antwort ist Text für einen Menschen, nicht Struktur für eine Oberfläche.
`lib/haproxy/config.ts` ist deshalb rein —
Konfigurationstext rein, Konfigurationstext raus, keine Importe — und
`tests/haproxy/config.test.ts` rechnet jede Einfügung an echtem
Konfigurationstext nach.

- **Eingefügt wird vor `# END AUTO … `, und jeder Eintrag trägt
  `# AUTO: <id>`.** Was HAPM angelegt hat, erkennt es an den Markern wieder;
  was jemand von Hand danebengeschrieben hat, bleibt lesbar stehen. Die Gruppe
  sagt nur, vor welchem Marker der Block landet.
- **Die Dienst-ID ergibt sich aus der Hauptdomain** (`serviceIdFor`): klein
  geschrieben, alles außer `a-z0-9` wird zu einem `_`, höchstens 48 Zeichen,
  eine Wildcard bekommt `wildcard_` davor (`*.example.org` und `example.org`
  sind oft zwei Einträge nebeneinander, und der zweite hieße sonst
  `example_org_2`). Als Feld im Formular war sie eine Frage, auf die fast jeder
  mit einer Abwandlung der Domain geantwortet hat.
  **Vergeben wird sie auf dem Server**, in der Vorabprüfung, die die Datei
  ohnehin liest (`assignServiceId` in `precheckCreate`): nur dort steht, was
  schon vergeben ist. Belegt ist eine ID, wenn ACL (`host_`, `lock_`, `pass_`),
  ein Abschnitt (`frontend`, `backend`, `listen`) oder der Name einer Pfad-Regel
  des neuen Eintrags sie schon tragen, und zwar mit derselben Funktion, mit der
  `addService` ablehnt (`serviceNameConflict`). Dann kommt ein Zähler dran
  (`_2`, `_3`, gekürzt wird davor). Zwischen Vorabprüfung und Schreiben liegt
  die Zertifikatsausstellung, also Minuten; ein zweiter Dialog läse in der Zeit
  dieselbe Datei. Deshalb merkt sich der Prozess vergebene, noch nicht
  geschriebene IDs (`reservedIds` in `provision.ts`, im Prozess wie der Lock,
  mit 30 Minuten Ablauf für einen Lauf, der gar nicht erst startet). Die
  Antwort der Route nennt die vergebene ID (`serviceId`), die Pille und die
  Historie tragen sie.
  **Danach ändert sie sich nicht**, auch nicht mit der Hauptdomain. Sie
  benennt ACL, Weiche und Backend, den Cookie der Passwortsperre und jede Zeile
  der Historie; sie mitzuziehen hieße, all das umzubenennen. Der
  Bearbeiten-Dialog zeigt sie nur lesend. Die interne API nimmt `id` weiter an
  (siehe [`reverse-proxy-api.md`](reverse-proxy-api.md)), und die Einrichtung
  gibt `hapm` fest mit.
  Eine TCP-Weiterleitung hält es genauso, nur aus dem Port: `tcp_5432`
  (`streamIdFor`, `assignStreamId`).
- **Der Bereich einer Zeile ergibt sich aus dem nächsten Marker DARUNTER**, nicht
  aus einem Zustand beim Lesen. Das ist die Semantik des Einfügens und stimmt
  auch ohne `# BEGIN`-Marker und bei vertauschten Blöcken.
- **Geprüft wird, bevor eingesetzt wird.** Die neue Datei geht als
  `haproxy.cfg.hapm-new` daneben und durch `haproxy -c -f`; erst danach
  Backup und `cp`. Wer erst schreibt und dann prüft, hat ein Fenster mit
  ungültiger Konfiguration und einen Rollback-Pfad, der selbst scheitern kann.
  So kann nur noch der Reload danebengehen, und dann kommt das Backup zurück.
- **`cp` und nicht `mv`**: der Zielinode bleibt derselbe, also Besitzer, Rechte
  und Kontext der Datei.
- **Zwei Riegel gegen den zweiten Schreiber.** Ein Lock im Prozess gegen HAPM
  selbst (es darf genau eine Instanz laufen, das setzt auch der Scheduler
  voraus), und ein
  SHA-256-Vergleich unmittelbar vor dem Einsetzen gegen alle anderen. Zwischen
  Lesen und Schreiben liegt die Zertifikatsausstellung, also Minuten. Wer in der
  Zeit ein `vim` offen hatte, behält seine Änderung: es wird abgebrochen, nicht
  überschrieben.
- **Eine belegte Domain wird abgewiesen, bevor ein Zertifikat beantragt wird.**
  HAProxy nimmt zwei ACLs mit derselben Domain klaglos an und schickt den Verkehr
  an die erste — eine fremde Seite verschwindet dann, ohne dass irgendwo ein
  Fehler steht. Und ein Fehlversuch bei Let's Encrypt zählt gegen ein Kontingent.
- **Beim Löschen wird das PEM VOR der Prüfung beiseitegelegt.** HAProxy lädt
  `/etc/haproxy/certs` als Ganzes, und ein leeres Verzeichnis hinter `crt …`
  lässt es beim nächsten Start scheitern. Wer erst reloadet und dann löscht,
  merkt das nicht heute, sondern beim nächsten Neustart von HAProxy. (Zusätzlich
  liegt das Platzhalter-Zertifikat aus `lib/bootstrap.ts` im Verzeichnis; die
  Reihenfolge gilt trotzdem, sie kostet nichts.)
- **Was nicht dem Namensschema folgt, wird angezeigt und nicht angefasst.**
  Löschbar ist ein Eintrag nur, wenn ACL (`host_<id>`), Weiche und Backend so
  heißen, wie sie hier vergeben werden, jeweils genau einmal vorkommen und im
  Marker-Block stehen. Sonst nähme das Entfernen etwas mit, wovon der Eintrag
  nichts weiß — und beim Reverse-Proxy ist das die Sorte Fehler, die eine fremde
  Domain offline nimmt.
- **Bearbeiten hat eine strengere Bedingung als Löschen: `editable`.** Ändern
  heißt hier entfernen und aus der Eingabemaske neu schreiben. Was die Maske
  nicht kennt — `balance leastconn`, eine `http-request`-Regel, ein `check inter
  2s fall 3` auf der server-Zeile, ein abweichendes Timeout — käme dabei nicht
  wieder mit. Der Parser sammelt solche Zeilen als `extras`, und ein Eintrag mit
  `extras` ist nur lesbar. Ein Werkzeug, das beim Ändern einer IP still eine
  Rate-Limit-Regel löscht, ist schlimmer als eines, das diesen einen Eintrag
  nicht anfassen kann. Löschen bleibt erlaubt: dabei geht der Block ohnehin
  komplett weg, und das steht im Bestätigungsdialog.
  Die Rücklese-Muster in `config.ts` sind das Gegenstück zu `renderBackendBlock`.
  Wer das eine erweitert, erweitert das andere — `tests/haproxy/edit.test.ts`
  rendert dafür jede Kombination aus Zusätzen und Healthcheck und besteht darauf,
  dass sie danach bearbeitbar ist und `toCreateInput` exakt die Eingabe
  zurückgibt; `tests/haproxy/routes.test.ts` tut dasselbe für die Pfad-Regeln.
  Die Healthcheck-Gruppe zählt dabei nur vollständig UND mit dem Host-Header der
  Hauptdomain: ein `hdr Host alt.example` unter einer inzwischen anders heißenden
  Domain würde beim Speichern still umgeschrieben.
- **Ändern ist EIN Schreibvorgang, kein Löschen-und-Anlegen.** Die neue
  Konfiguration entsteht in einem Text (`replaceService`), wird in einem
  `haproxy -c` geprüft und mit einem Reload gültig. Zwei Vorgänge wären zwei
  Reloads mit einer Lücke dazwischen, in der die Domain nicht erreichbar ist —
  und bei einem Fehlschlag im zweiten dauerhaft. `replaceService` entfernt
  deshalb ZUERST: erst danach sind ID, ACL-Name und Domains wieder frei, sonst
  meldete jede Änderung, die den Namen behält, einen Konflikt mit sich selbst.
- **Das Zertifikat wird nur angefasst, wenn es muss** (`certificateChanged`).
  Eine geänderte Backend-IP hat damit nichts zu tun. Die Reihenfolge zählt
  allerdings mit und nicht nur die Menge: die erste Domain ist die Hauptdomain,
  nach ihr heißt die PEM-Datei. Ändert sie sich, wird das alte Zertifikat samt
  Erneuerungseintrag abgeräumt — sonst blieben zwei Einträge für überlappende
  Domains stehen, die sich gegenseitig die Challenge wegnehmen. Und zwar erst
  **nach** dem erfolgreichen Reload: vorher gelöscht wäre es der Fall, in dem
  das Rollback auf eine Datei zeigt, die es nicht mehr gibt.
- **Pfad-Regeln: dieselbe Domain, ein anderer Port.** Der Fall ist Coolify —
  Oberfläche auf 8000, Terminal auf 6002, Live-Ansicht auf 6001, alles unter
  einer Domain. Eine Regel ist eine ACL (`path_<id>_<name>`, `path_beg`), eine
  Weiche und ein eigener Backend-Block (`<id>_<name>`); die Namen sind abgeleitet,
  weil die Konfiguration keine Kennung kennt und sich sonst beim Löschen nicht
  sagen ließe, welche der dreißig ACLs im Frontend dazugehört.
  **Die Weichen der Regeln stehen VOR der des Dienstes.** HAProxy nimmt die erste
  passende, und die Weiche ohne Pfadbedingung passt immer — stünde sie oben,
  liefe keine Regel darunter, und `haproxy -c` sieht daran nichts Falsches. Eine
  vorgefundene Konfiguration in dieser Reihenfolge wird deshalb **gelesen und
  nicht geändert**: das stillschweigend zu reparieren wäre eine
  Verhaltensänderung, die niemand angefordert hat.
  **Was mitgelöscht wird, wird gelesen und nicht aus dem Namen geraten.**
  `removeService` fragt den Parser, welche Weichen an derselben Host-ACL hängen.
  Ein Namenspräfix als Regel nähme einem Dienst „coolify" beim Löschen einen
  eigenständigen Dienst „coolify_ui" mit. Umgekehrt macht eine **fremde** Weiche
  auf dieser ACL den Dienst unlöschbar: die ACL ginge mit, und HAProxy startet
  danach nicht mehr.
  **Über der ganzen Gruppe steht EIN `# AUTO: <id>`**, nicht einer je Block.
  Die Backends eines Dienstes gehören zusammen; ein Kommentar je Block las sich
  beim Nachsehen von Hand wie drei einzelne Dienste, die zufällig ähnlich
  heißen. Fürs Wiederfinden reicht der eine: die Blöcke trennt HAProxy ohnehin
  am Schlüsselwort `backend`, und was zum Dienst gehört, sagt der Parser und
  nicht der Kommentar.
  **Eine Regel bekommt kein `option httpchk`, nur `check`.** Eine
  WebSocket-Strecke antwortet auf ein `GET /` nicht mit 200; ein HTTP-Check
  nähme sie dauerhaft aus dem Betrieb. Steht dort trotzdem einer, ist der
  Eintrag nur lesbar.
- **Eine Weiterleitung ist ein Backend aus einer Zeile** (`redirect`,
  `redirectLine`). Der Fall: eine Domain, die nicht mehr selbst bedient wird —
  eine alte Schreibweise, ein umgezogenes Projekt, eine gekaufte Domain, die auf
  die Hauptseite zeigen soll. Ohne diese Sorte Eintrag bräuchte das einen
  Server, der nichts tut, als 301 zu antworten.
  **Sie steht im Backend und nicht als `redirect … if host_<id>` im Frontend.**
  Damit bleibt alles andere unverändert: Weiche, Host-ACL, die Sperre auf
  Admin-IPs, Anlegen, Löschen, die Einfügereihenfolge, das Zertifikat. Eine
  zweite Sorte Frontend-Zeile hätte jede dieser Stellen um einen Sonderfall
  erweitert — und der Sonderfall wäre genau der, den beim Löschen niemand mehr
  wiederfindet.
  **Ein Zertifikat braucht sie trotzdem.** Die Weiterleitung antwortet über
  HTTPS, und der Browser prüft das Zertifikat, bevor er die Antwort liest.
  **Sie schließt Ziele, Pfad-Regeln, Zusätze und Healthcheck aus**, und zwar
  ablehnend statt still: alle vier setzen ein Backend mit Servern voraus. Bei
  den Zusätzen kommt dazu, dass HAProxy die Weiterleitung selbst beantwortet,
  und auf solche Antworten wirken `http-response`-Regeln nicht. Ein
  vorgefundener Block mit beidem wird gelesen, ist aber nur lesbar — ein
  Speichern ließe eine der beiden Hälften weg.
  **Zwei Entscheidungen bleiben, weil sie wirklich zwei sind.** `location` gegen
  `prefix` ist der Unterschied zwischen „von hier geht es dorthin" (`/preise` →
  `/`) und „diese Seite ist umgezogen" (`/preise` → `/preise`); die falsche
  Wahl fällt erst auf, wenn jemand einen alten Link öffnet. Und 302 gegen 301:
  Vorgabe ist 302, weil ein Browser sich eine 301 merkt und die alte Adresse
  danach gar nicht mehr aufruft — eine falsch gesetzte 301 nimmt man nicht
  zurück, ohne dass jeder Besucher seinen Cache leert.
  **Die Zieladresse ist eng geprüft** (`isValidRedirectUrl`), und der Grund
  steht in der Datei und nicht in der Shell: ein `#` darin machte den Rest der
  Zeile zum Kommentar, aus `code 301` würde nichts, und die Weiterleitung stünde
  ohne Code da. Leerzeichen trennen Argumente, ein Anführungszeichen bricht die
  Zeile auf.
- **Die Anwendung hinter einem Ziel ist ein Kommentar im eigenen Backend**,
  direkt unter `backend <id>`: `# hapm-app: nextcloud` (`APP_LINE_PREFIX`,
  `knownApp`). HAProxy liest ihn nicht, HAPM richtet danach die Ausnahmen von
  CrowdSec für das Ziel ein (docs/crowdsec.md, „Anwendungen“). Ein Kommentar
  und keine Datenbank, weil `haproxy.cfg` die Wahrheit über die Ziele ist: mit
  dem Ziel geht seine Anwendung. Nur im eigenen Backend, nicht in denen der
  Pfad-Regeln; deren Backends rechnet `appUsage` dem Ziel zu. Eine unbekannte
  Kennung liest sich als keine. Steht auf der Platte: nicht umbenennen.
- **Zusätze statt Presets: jeder ist EINE Zeile in JEDEM Backend des
  Eintrags**, auch in denen der Pfad-Regeln. Es gibt drei: feste Header der
  Antwort (`http-response set-header`), feste Header der Anfrage
  (`http-request set-header`) und den Schalter „Lange Verbindungen"
  (`TUNNEL_LINE`, `timeout tunnel 1h`). Geschrieben werden sie in dieser
  Reihenfolge (Timeout, Anfrage, Antwort: der Weg einer Anfrage), zwischen
  Verfahren und Healthcheck (`addonLines`).
  **Warum keine Presets mehr.** Ein Preset war eine feste Liste Zeilen, die es
  nur ganz oder gar nicht gab („Nextcloud" = zwei Header, „Coolify" = das
  Timeout). Wer nur einen der beiden Header wollte oder einen dritten, hatte
  einen Eintrag, den HAPM nicht mehr anfassen konnte. Einzelne Zeilen lassen
  sich einzeln zurücklesen, und damit fällt die Bedingung „vollständig oder gar
  nicht" weg.
  **Warum nur diese drei.** Ein Zusatz kommt nur dazu, wenn er sich als genau
  eine Zeile ausdrücken lässt, die sich eindeutig und verlustfrei zurücklesen
  lässt. Alles mit Bedingung, Ausdruck oder mehreren Zeilen bleibt eine fremde
  Zeile in `extras`, und der Eintrag ist nur lesbar.
  **Der Wert ist Text, kein Ausdruck** (`headerLine`). `set-header` nimmt ein
  Log-Format: `%[src]` würde zur Adresse des Besuchers, `%T` zur Uhrzeit. Und
  die Zeile geht durch den Parser der Konfiguration, der in Anführungszeichen
  `$NAME` durch eine Umgebungsvariable ersetzt und den Backslash als
  Maskierung liest. Ein Wert aus einem Formular soll so ankommen, wie er
  eingetippt wurde, deshalb wird `%` zu `%%`, und `"`, `$` und `\` bekommen
  einen `\` davor. Geprüft gegen HAProxy 2.4, 3.0 und 3.4 mit Werten wie
  `C:\pfad`, `a\ b`, `ende\`, `q\"x`, `\$HOME`, `50%` und `%[src]`: jeder kam
  Zeichen für Zeichen so beim Empfänger an. Erlaubt ist druckbares ASCII;
  Namen sind Tokens (Buchstaben, Ziffern, Bindestrich), Header der Übertragung
  (`Content-Length`, `Transfer-Encoding`, `Connection` …) sind ausgeschlossen,
  ein Name steht je Richtung höchstens einmal da (`set-header` ersetzt, der
  zweite überschriebe den ersten), höchstens 20 je Richtung
  (`validateHeaderRule`).
  **Zurückgelesen wird nur, was `headerLine` genau so geschrieben hätte**
  (`readHeaderLine`). Eine Zeile, die sich so nicht verlustfrei lesen lässt,
  bleibt fremd und unangetastet: ein `%[src]` von Hand, eine Zeile mit `if`,
  ein Wert ohne Anführungszeichen. Als Header gelesen stünde dort nach dem
  Speichern `%%[src]`, und aus der Adresse des Besuchers würde der Text
  „%[src]".
  **Bestehende Presets sind damit nur noch das, was sie in der Datei immer
  waren**: die Nextcloud-Zeilen werden als zwei Header der Antwort gelesen, die
  Coolify-Zeile als der Schalter, und ein Speichern ohne Änderung schreibt
  dieselben Zeilen Zeichen für Zeichen wieder hin
  (`tests/haproxy/addons.test.ts` hält eine Datei aus der Preset-Zeit fest).
  Die interne API nimmt `preset` weiter an und übersetzt es in genau diese
  Zusätze (`readServiceInput`); ein ausdrücklich genannter Header gewinnt.
  Gemeldet wird `preset` nirgends mehr, auch der Filter „Alle Presets" auf der
  Gruppenseite ist weg.
  **Keine Vorschläge im Dialog.** Es gab eine Zeit lang Knöpfe, die feste
  Header einfügten (Nextcloud, `X-Frame-Options`, `X-Robots-Tag: noindex`).
  Sie gaben eine Auswahl vor, die zu den wenigsten Zielen passte. Header trägt
  man von Hand ein; daneben steht ein Verweis, wo man nachliest
  (`HEADER_REFERENCES`: OWASP Secure Headers Project für die Antwort, MDN für
  die Anfrage).
  **Ein Header gleichen Namens im Frontend ist zweierlei**
  (`parseGlobalHeaders`, geprüft gegen 2.4, 2.8 und 3.0): `http-request`-Regeln
  laufen erst im Frontend, dann im Backend, ein Header der Anfrage am Ziel
  ersetzt also den globalen. `http-response`-Regeln laufen andersherum, ein
  Header der Antwort am Ziel wird vom Frontend wieder überschrieben und kommt
  nie an. Der Dialog sagt das an der Zeile, und zwar sichtbar: bei der Antwort
  hat der Eintrag sonst keine Wirkung, ohne dass es jemand merkt.
  **Der Schalter und kein Feld für die Dauer**: ohne `timeout tunnel` fallen
  WebSocket, Terminal und Live-Ansicht nach `timeout client` aus dem
  `defaults`-Block und reißen mitten in der Arbeit ab. Ein Feld für den Wert
  wäre eine Frage mehr im Formular, auf die niemand eine andere Antwort hat
  als „lange".
- **acme.sh ist eine Einrichtung und keine Nebenwirkung eines Klicks auf
  „Anlegen".** Es wird beim Start eingerichtet (`lib/bootstrap.ts` →
  `ensureAcme` in `lib/acme.ts`), zusammen
  mit dem Frontend und der Challenge-Weiterleitung auf Port 8888 aus der
  Grundkonfiguration. Der Vorgang „Anlegen" installiert nichts. Fehlt `acme.sh` oder das Zertifikatsverzeichnis trotzdem
  (die Einrichtung ist gescheitert; die Übersicht `/dashboard` zeigt den
  Zustand), sagt
  die Oberfläche das und der Knopf legt nichts an (`acmeReady`). **Die
  DNS-Zugangsdaten** gibt ein Mensch ein, unter
  Reverse-Proxy → Einstellungen, siehe „Wildcards".
- **Die Sicherungen der Konfiguration werden aufgeräumt** (`BACKUP_KEEP`, zehn).
  Jeder Schreibvorgang legt ein `haproxy.cfg.backup-<stamp>` an, und sonst
  räumt sie niemand weg. Aufgeräumt wird **nach** dem erfolgreichen Reload und
  best effort: vorher wäre es eine Handlung an Dateien, auf die das Rollback im
  selben Vorgang noch zeigen können muss. Zwei Fallen stecken im Befehl, und
  beide enden **still** in einem Aufräumen, das nie etwas tut: der ganze
  Ausdruck durch `shellEscape` macht aus dem Muster einen Dateinamen mit einem
  Sternchen darin, und `xargs` ohne `-0` trennt an Leerzeichen. Deshalb ist
  `pruneBackupsCommand` rein, und `tests/haproxy/prune.test.ts` lässt eine echte
  Bash ihn über ein Temp-Verzeichnis laufen.

### TCP-Weiterleitungen: `lib/haproxy/streams.ts`

Ein Port dieses Servers, durchgereicht an ein Ziel dahinter: eine Datenbank,
ein SSH-Sprungpunkt, ein SMTP-Relay. In der Konfiguration ist es ein
`listen`-Abschnitt in `mode tcp`, und das ist der Grund für die eigene Datei.

**Ein Dienst in `config.ts` ist eine Domain.** Er besteht aus Host-ACL, Weiche
und Backend, er braucht ein Zertifikat, er kann verdeckt werden (`shadowedBy`),
und die Reihenfolge seines Blocks trägt Bedeutung. Davon gilt hier nichts. Beides
in denselben Typ zu zwingen hieße, an jeder Stelle in `config.ts` ein
`if (stream)` einzuziehen — in der Domainprüfung, in der Einfügereihenfolge, im
Zertifikatspfad, im Sperrpfad.

Geteilt werden dafür die Marker-Blöcke: eine TCP-Weiterleitung liegt im
**BACKENDS**-Teil ihrer Gruppe, dem einzigen der beiden, der außerhalb des
Frontends liegt — ein `listen` innerhalb eines `frontend` wäre keine gültige
Konfiguration. Sie steht deshalb auf derselben Gruppenseite, unter eigener
Überschrift, und `scopeMarkers`/`scopeResolver` sind aus `config.ts` exportiert
statt hier ein zweites Mal geschrieben.

- **Der Port ist die einzige Stelle, an der `haproxy -c` nicht reicht.** Die
  Prüfung liest die Datei, sie **bindet keine Sockets**. Ein doppelt vergebener
  Port kommt also durch und scheitert erst beim Reload — also dann, wenn die
  Konfiguration schon eingesetzt ist. Deshalb zwei Prüfungen, die es sonst
  nirgends gibt: `bindConflict` gegen **jede** `bind`-Zeile der Datei (auch die,
  die dieses Modul nie schreiben würde, denn für den Konflikt zählt der Port und
  nicht die Form der Zeile) und `parseListeningPorts` gegen `ss -Hltn`. Beide
  laufen im Formular **und** noch einmal im Lauf innerhalb des
  Locks: nur im Formular wäre es eine Momentaufnahme von vorhin, nur im Lauf käme
  die Antwort zu spät, um im Feld zu stehen. (`ss` läuft im HAPM-Container. Es
  sieht die Ports des Servers, weil beide Container im Netz des Hosts laufen,
  `network_mode: host` in `docker-compose.yml`.)
- **Eine leere `ss`-Ausgabe heißt unbekannt, nicht frei.** Es lauscht immer
  etwas, mindestens HAPM selbst; leer
  heißt, `ss` fehlt. Als
  „alle Ports frei" gelesen ginge die Prüfung still durch. Der Vorgang läuft
  trotzdem weiter, mit dem, was die Datei hergibt — behauptet wird nur nichts.
- **Vier Ports sind gesperrt** (`RESERVED_PORTS`), jeder mit seinem Grund
  daneben: 22 (SSH, der Zugang zum Server), 80, 443 und
  8888 (die ACME-Challenge, ohne die sich kein Zertifikat mehr erneuern lässt).
- **Die Firewall macht dieser Vorgang nicht auf, und das steht im Formular.** Er
  schreibt eine Zeile in `haproxy.cfg` und lädt HAProxy neu, mehr nicht. Eine
  Firewall, die den Port verwirft, sieht davon nichts: `haproxy -c` geht durch,
  der Reload geht durch, die Karte steht grün — und von außen kommt trotzdem
  niemand an. HAPM fasst weder nftables noch die Firewall eines Anbieters
  an; beides ist eine Einrichtung und keine Nebenwirkung eines Klicks, dieselbe
  Überlegung wie bei acme.sh. Also steht der Satz dort, wo der Port eingetragen
  wird, und noch einmal im Tooltip der Karte: nach dem Anlegen ist sie das
  Einzige, was man noch sieht, und „HAProxy lauscht" ist nicht dasselbe wie „von
  außen erreichbar".
- **Die Absenderliste gehört dem Eintrag und ist keine gemeinsame Liste.** Anders als bei
  den Admin-IPs, und das aus zwei Gründen: wer an eine Datenbank darf, ist eine
  andere Frage als wer eine Verwaltungsoberfläche sehen darf — und technisch ist
  die ACL `admin_ips` im Frontend deklariert, gilt in HAProxy also nur dort. Die
  Regel steht inline (`tcp-request connection reject if !{ src … }`) und
  `connection` statt `content`: die Entscheidung hängt allein an der Quell-IP,
  also soll sie fallen, bevor ein Byte gelesen wird. **Leer heißt offen**, und
  die Karte sagt das mit einer roten Marke: bei einem Dienst hinter einem
  Zertifikat ist „offen für alle" der Normalfall, bei einem durchgereichten Port
  ist es die Sorte Entscheidung, die man trifft, ohne sie zu treffen.
- **`option tcplog` steht immer drin.** Ohne die Zeile gilt der `defaults`-Block,
  und dort steht `option httplog` — ein HTTP-Format für einen Abschnitt ohne
  HTTP. HAProxy meldet das bei jedem Start als Warnung und schreibt danach Zeilen
  mit leeren Feldern. Ein Abschnitt ohne die Zeile ist deshalb nur lesbar.
- **`balance uri` fehlt in der Auswahl** (`STREAM_BALANCE`), und das ist kein
  Versehen: es liest den angefragten Pfad, und den gibt es in `mode tcp` nicht.
  HAProxy lehnt die Datei ab. Eine Auswahl, die eine Möglichkeit anbietet, die
  danach abgelehnt wird, ist keine.
- **Ein Abschnittsname gilt über `frontend`, `backend` und `listen` hinweg.**
  `addStream` **und** `addService` prüfen deshalb gegen alle drei. Nur gegen die
  eigene Sorte zu prüfen ließe einen Dienst entstehen, der so heißt wie eine
  TCP-Weiterleitung daneben, und HAProxy lehnt die Datei als Ganzes ab.
- **Ein `listen` in `mode http` wird angezeigt und nicht angefasst.** Es ist
  keine TCP-Weiterleitung, aber ganz wegzulassen wäre ein blinder Fleck — und
  der fällt erst auf, wenn jemand denselben Port ein zweites Mal vergibt.
  Dieselbe Überlegung wie bei `unmanagedCount`, und die zählt sie mit.
- **Der Vorgang ist derselbe wie beim Dienst, nur ohne Zertifikat**: Lock,
  Prüfsumme, `haproxy -c`, Backup, `cp`, Reload, bei einem Fehlschlag zurück. Es
  gibt keine Domain, über die sich eine Challenge führen ließe, und was durch den
  Port geht, entschlüsselt dieser Proxy gar nicht. Geändert wird in **einem**
  Schreibvorgang: zwei Reloads hätten eine Lücke dazwischen, und bei einer
  durchgereichten Datenbankverbindung heißt das abgebrochene Sitzungen.
- **Eine Gruppe lässt sich nicht entfernen, solange eine darin steht.**
  `removeScope` bekommt die Kennungen als Parameter (`alsoOccupiedBy`), weil
  `config.ts` sie nicht selbst lesen kann: `streams.ts` liest seinerseits aus
  `config.ts`, und ein Import-Kreis wäre das Gegenteil dessen, was die Trennung
  erreicht. Der Aufrufer, der beides gelesen hat, ist `provision.ts`.
- **Die Historie trägt eigene Aktionen** (`stream-create`/`-update`/`-delete`).
  „wer hat einen Port nach draußen aufgemacht" wiegt schwerer als „wer hat eine
  Domain umgehängt" und soll sich einzeln suchen lassen. In `domains` steht bei
  ihnen der Port, in `targets` die Ziele, und die Absenderliste steht im
  Audit-Text: „Port 5432 offen" und „Port 5432 für zwei Adressen" sind zwei
  verschiedene Vorgänge.
- **Gelesen werden sie zusammen mit den Diensten** (`/api/haproxy/services`
  liefert beide): dieselbe Datei, dieselbe Probe. Geschrieben wird getrennt
  (`/api/haproxy/streams`), weil sich dort die Vorgänge unterscheiden.

Was es hier **nicht** gibt und auch nicht geben soll: Zertifikat, DNS-Eintrag,
Pfad-Regeln, Header, Sperre über die Admin-IPs. Alle fünf setzen HTTP voraus.
Die Kennung des `listen`-Abschnitts ergibt sich aus dem Port (`tcp_5432`), wie
die Dienst-ID aus der Domain, und bleibt, wenn sich der Port ändert.

### Der DNS-Eintrag zum Ziel

Liegt eine Domain des Dienstes in einer Zone, die unter `/dns` eingerichtet ist, bietet
der Dialog an, den passenden Eintrag gleich mit zu setzen: einen CNAME auf die Zone
selbst, deren A-Eintrag von Hand auf diesen Server zeigt. Angelegt wird er **vor** dem
Zertifikat (HTTP-01 prüft über die Domain); beim Löschen des Ziels fragt der
Bestätigungsdialog, ob er mitgeht — vorbelegt auf ja, und nur, wenn HAPM ihn
selbst gesetzt hat. Alles Weitere, samt der Tabelle der vier Zustände des Schalters, steht
in [`dns.md`](dns.md).

Das ist **nicht** dasselbe wie die DNS-Zugangsdaten weiter unten: die gehören acme.sh
(`account.conf`) und lösen eine Wildcard-Challenge. Der Cloudflare-Token unter `/dns` gehört
HAPM (verschlüsselt in `dns_zones`) und legt Einträge an. Zwei Tokens, zwei Zwecke, zwei Orte.

### Wildcards

Eine Wildcard ist eine Domain wie jede andere, nur mit `*.` davor — kein eigener
Typ, kein Schalter daneben. Sie steht in derselben Liste, in derselben ACL und im
selben Zertifikatsantrag, und alles, was über `domains` läuft (Suche, Sperrliste,
`toCreateInput`), läuft unverändert weiter.

**In der Konfiguration sind es zwei ACL-Zeilen mit demselben Namen**
(`hostAclLines`): eine mit `-i` für die exakten Domains, eine mit `-m end -i` für
die Wildcards. Zwei, weil `-i` je Zeile genau einen Vergleichsmodus hat; HAProxy
verodert gleichnamige ACLs. Der führende Punkt ist der Riegel und nicht Kosmetik:
`-m end -i .kunde.example` trifft `a.kunde.example`, aber weder `kunde.example` noch
`fremdekunde.example`. Die exakte Zeile steht zuerst, und das ist Bedingung fürs
Zurücklesen — eine andere Reihenfolge käme beim Speichern umsortiert heraus, und
die erste Domain benennt die PEM-Datei: aus einer geänderten Backend-IP würde ein
neuer Zertifikatsantrag. `aclCanonical` erzwingt beides.

**Die Reihenfolge im SERVICES-Teil bedeutet etwas.** Solange jede Domain exakt
ist, schließen die ACLs einander aus, und es gewinnt nicht die erste, sondern
die passende. Mit Wildcards gilt das nicht. Ein Eintrag `*.kunde.example`, danach
angelegt `app.kunde.example`: ein neuer Block am Ende landete darunter, seine Weiche käme nie zum Zug,
und `haproxy -c` sieht daran nichts Falsches — dieselbe Falle wie bei den Weichen
der Pfad-Regeln, nur zwischen Diensten statt innerhalb eines. Der Block hat
deshalb eine Invariante, die `insertServiceBlock` beim Einfügen herstellt: exakte
Blöcke zuerst, dann die Wildcards, unter den Wildcards das **engere** Muster
zuerst (längeres Suffix = engeres Muster). **Repariert wird nichts**: eine
vorgefundene Datei in falscher Reihenfolge wird gelesen und nicht umsortiert, aber
der verdeckte Eintrag trägt `shadowedBy` und die Karte sagt es. Ein Eintrag, der
dasteht, ein Zertifikat hat und trotzdem nicht antwortet, ist sonst nirgends
sichtbar.

**Zwei Deckungsregeln, die nicht dieselbe sind.** `-m end` in der ACL trifft jede
Tiefe (`a.b.kunde.example` auch), ein Zertifikat `*.kunde.example` deckt genau **eine**
Ebene ab. Deshalb `domainCovers` (ACL-Semantik, `config.ts`) neben `certCovers`
(Zertifikatssemantik, `certs.ts`). Sie zusammenzulegen ergibt genau einen von zwei
Fehlern: entweder wird für einen Host kein Zertifikat beantragt, den es nicht
abdeckt (Warnung im Browser), oder bei jedem Anlegen eins, das schon da ist
(Kontingent bei Let's Encrypt). Wer eine tiefere Ebene braucht, legt sie als
eigenen Eintrag an — die Einfügereihenfolge sorgt dafür, dass er die Wildcard
schlägt.

**Die DNS-Zugangsdaten liegen bei acme.sh, eingegeben werden sie unter
`/reverse-proxy/einstellungen`.**
HTTP-01 stellt keine Wildcard aus, das lässt Let's Encrypt nicht zu; es braucht
DNS-01 und damit Zugriff auf die Zone. acme.sh legt die Zugangsdaten als `SAVED_*`
in `account.conf` ab (im Volume `/root/.acme.sh`) und schreibt sie in die
Erneuerungskonfiguration der Domain —
die Erneuerung braucht danach keine erneute Eingabe, genau wie beim Deploy-Hook.
**HAPM ist dabei Durchreiche und nicht Tresor**: der Token kommt aus dem
Formular, geht in einem Vorgang in `account.conf` und steht danach weder in der
Datenbank noch im Protokoll. Ihn zusätzlich zu speichern wären zwei Quellen
für ein Geheimnis, von denen nur eine zählt — und die zweite wäre die, die niemand
anfasst, wenn rotiert wird. Zurück kommt deshalb nie der Token, sondern nur, ob
ein Hook eingerichtet ist.

**Welcher Hook eingerichtet ist, wird abgeleitet und nicht hinterlegt**
(`DNS_HOOK_PROBE` / `parseDnsHooks`): zu jedem `SAVED_*`-Namen wird die
`dnsapi/dns_*.sh` gesucht, die ihn liest. Damit findet die Erkennung auch einen
Hook, den jemand von Hand eingerichtet hat — sie hängt nicht an `DNS_PROVIDERS`.
Der gewählte Hook ist ein Parameter des **Vorgangs** und **nicht** Teil von
`CreateServiceInput`: er steht in keiner Zeile von `haproxy.cfg` und wäre dort ein
Feld, das `toCreateInput` erfinden müsste.

**`DNS_PROVIDERS` ist eine Allow-Liste.** Nicht der Wert ist die Einfallstelle,
sondern der
**Name**: er geht in einen regulären Ausdruck in einem Kommando, das als root
läuft. Der Wert
wird trotzdem geprüft, und zwar eng: acme.sh legt ihn als `KEY='wert'` ab, ein
Apostroph darin bräche `account.conf`, und eine kaputte `account.conf` nimmt beim
nächsten Lauf **jede** andere Zugangsdatum mit. Die Liste ist bewusst kurz:
acme.sh kennt über hundert Hooks, und die meisten brauchen andere Felder mit
anderen Regeln. Ein weiterer Anbieter ist ein Eintrag, kein Umbau.

**Zwei Anbieter passen nicht in „je Feld eine `SAVED_`-Zeile"**, und beschreiben
deshalb selbst, was aus dem Formular wird (`build`, `validate`, `access` am
Eintrag in `DNS_PROVIDERS`). Ihre Felder zeigt `components/dns/CredentialFields.tsx`
(Text, Geheimnis, Auswahl, PEM), ihre Prüfung steht in `lib/dns/access.ts`, je
Feld so eng, wie die Stelle es verlangt, an der der Wert landet.

- **RFC 2136 (`dns_nsupdate`)**: acme.sh ruft `nsupdate -k <Datei>` auf. Name,
  Verfahren und Geheimnis des TSIG-Schlüssels sind deshalb Felder des Formulars
  und keine Variablen: aus ihnen entsteht `/root/.acme.sh/hapm-nsupdate.key`
  (Rechte 600, in der Form von `tsig-keygen`). In `account.conf` stehen
  `SAVED_NSUPDATE_SERVER`, `SAVED_NSUPDATE_SERVER_PORT` und `SAVED_NSUPDATE_KEY`
  mit dem Pfad der Datei. **`NSUPDATE_ZONE` bleibt leer** und wird beim Setzen
  mit herausgenommen: acme.sh kennt je Installation nur eine, und `nsupdate`
  findet die Zone zu einem Namen selbst, indem es den genannten Nameserver
  fragt. So gilt ein Schlüssel für jede Zone, die er ändern darf. Das Abbild
  bringt `nsupdate` mit (`bind9-dnsutils` im `Dockerfile`).
- **Infoblox (`dns_infoblox`)**: der Hook liest `Infoblox_Creds`
  (`benutzer:passwort`), `Infoblox_Server` und `Infoblox_View` **ohne**
  `SAVED_` (er benutzt `_saveaccountconf`). So stehen sie in `account.conf`
  (`plainNames`). Die Erkennung der Hooks liest nur `SAVED_*`, darum steht der
  Name der Appliance (kein Geheimnis) zusätzlich als `SAVED_Infoblox_Server` da.
  `Infoblox_View` wird immer geschrieben: beim Entfernen des TXT-Eintrags setzt
  der Hook keine Vorgabe ein und fände ihn sonst nicht. Das Passwort darf alles
  außer Leerzeichen, Apostroph, Backslash und Umlauten, weil der Hook es mit
  `printf "%b"` liest und acme.sh es als `'…'` ablegt.
- **Dateien neben `account.conf`** (`credentialFiles`): ihr Inhalt geht über
  stdin wie der Token, geschrieben wird unter `umask 077` neben das Ziel und
  dann umbenannt. Beim Setzen entstehen sie vor der Zeile, die auf sie zeigt,
  beim Entfernen gehen sie nach ihr. Sie liegen im Volume von acme.sh und damit
  in jeder Sicherung.
- **Die Zertifizierungsstelle der Appliance** (`Infoblox_CA`, wahlweise): acme.sh
  prüft das Zertifikat der Appliance über `curl` gegen den Bestand des
  Containers. Die eigene CA liegt als `/root/.acme.sh/hapm-trust/infoblox.pem`
  im Volume und wird von dort in den Bestand gelegt (`TRUST_SYNC`:
  `/usr/local/share/ca-certificates`, dann `update-ca-certificates`), nach dem
  Speichern und bei jedem Start von HAPM (`ensureAcme`), weil ein neuer
  Container sie sonst nicht kennt. **Nicht über `CA_BUNDLE`**: das gälte auch
  für den ACME-Server und nähme ihm die öffentlichen Stellen weg. Wer in
  `account.conf` von Hand ein `CA_BUNDLE` gesetzt hat, muss die CA der
  Appliance dort selbst mit aufnehmen: `curl` liest dann nur diese Datei.

`tests/haproxy/dns-credentials.test.ts` lässt eine echte Bash alles nachrechnen
(auch, dass ein Passwort mit `"`, `$`, `&`, `|` und `` ` `` unverändert bei der
Shell ankommt), `pnpm dns:verify` den Hook `dns_nsupdate` und ein ganzes
Zertifikat gegen BIND und Pebble. Der Infoblox-Hook lief gegen keine Appliance.

**Geschrieben wird synchron und nicht als abgekoppelter Lauf.** Jeder andere
Schreibvorgang am Reverse-Proxy dauert Minuten (Zertifikat, `haproxy -c`, Reload);
dieser fasst HAProxy gar nicht an. Eine Lauf-Zeile, eine Pille unten rechts und
ein Abgleich beim Start wären Apparat für einen Vorgang, der fertig ist, bevor die
Pille erscheint. Der Lock läuft trotzdem mit — nicht wegen HAProxy, sondern
weil zwei gleichzeitige Speichervorgänge dieselbe Datei lesen. Drei Dinge am
Kommando (`writeCredentialsCommand`) enden sonst **still** im Schaden, und
`tests/haproxy/dns-credentials.test.ts` lässt eine echte Bash sie nachrechnen: der
Wert geht über **stdin** und nie als Argument (sonst steht der Token in `ps`);
gelesen und geschrieben wird in **einem** Kommando (dazwischen
könnte sonst ein Erneuerungslauf von acme.sh in dieselbe Datei
schreiben); und es ist `cat >` und nicht `mv`, damit der Zielinode und mit ihm die
600er-Rechte bleiben. Dazu die Falle von `grep -v`: Exit 1 heißt „keine Zeile
übrig" und ist der Normalfall, ein blindes `|| true` daneben verschluckte den
echten Fehler und ließe eine **leere** `account.conf` stehen.

**Der Rückabgleich ist nicht optional.** Zurückgegeben wird, was acme.sh
danach über seine Hooks sagt, und nicht, was gerade geschickt wurde. Ein Token, der
ankommt, aber unter einem Namen steht, den kein Hook liest, wäre sonst ein grüner
Haken ohne Deckung — auffallen würde er erst beim ersten Wildcard-Antrag.

**Es gibt genau einen Weg: DNS-01 mit einem Token, der die Zone erreicht.** Den
DNS-Alias-Modus (`--challenge-alias`, CNAME in der fremden Zone auf eine eigene)
gibt es bewusst nicht: zwei Wege zur selben Sache sind zwei, die man beim
Fehlersuchen auseinanderhalten muss.

**Die Grenze, die daraus folgt und die man kennen muss:** acme.sh kennt je
Variable genau einen Wert je Installation (`SAVED_CF_Token`). Zwei Tokens
desselben Anbieters gehen also nicht — der zweite überschreibt den ersten, und die
Erneuerung des ersten Zertifikats liefe danach mit dem falschen Token, sichtbar
erst zwei Monate später. Ein Token je Anbieter, der alle nötigen
Zonen abdeckt (bei Cloudflare ein Token über mehrere Zonen), ist deshalb keine
Bequemlichkeit, sondern die Bedingung. Für RFC 2136 heißt das: ein Nameserver
und ein Schlüssel für alle Zonen, für Infoblox: eine Appliance, ein Benutzer,
eine View. Der Bereich „DNS" kennt die Grenze nicht, dort trägt jede Zone
ihren eigenen Zugang.

**Ist genau ein Hook eingerichtet, steht er im Dialog vorausgewählt** und die
Auswahl trägt kein „Bitte wählen". Abgeleitet und nicht in den Zustand
geschrieben: die Hook-Liste kommt mit der Probe, und ein Wert, den ein
Effekt nachziehen müsste, stünde genau einen Render lang falsch da. Die Route
verlangt ihn in dem Fall auch nicht: fehlt `dnsHook`, nimmt sie den einen.

**Ein Wildcard-Zertifikat gehört nicht EINEM Dienst.** „Ein Zertifikat entsteht
und vergeht mit seinem Dienst" trägt hier nicht: `app.kunde.example` und
`api.kunde.example` sind zwei
Einträge auf einem Zertifikat, und genau dafür nimmt man Wildcards. Den ersten zu
löschen nähme dem zweiten das PEM weg, und auffallen würde es nicht beim
Löschen, sondern beim nächsten Start von HAProxy — dieselbe Sorte Fehler, wegen
der das PEM vor der Prüfung beiseitegelegt wird und nicht danach. Die Wahrheit
über die Zertifikate liegt deshalb da, wo auch die über die Konfiguration liegt:
auf der Platte (`acme.sh --list --listraw`, keine Collection). Daraus folgt
beides von selbst — **ausgestellt wird nur, was noch nicht da ist**
(`findCertificateFor`, spart einen Lauf gegen das Kontingent und einen zweiten
Erneuerungseintrag auf überlappende Domains), und **abgeräumt wird nur, was kein
übrig bleibender Dienst mehr braucht** (`certificateUsers`, geprüft **vor** dem
Beiseitelegen). Im Zweifel bleibt das Zertifikat stehen: ein überzähliges kostet
einen Erneuerungseintrag, ein fehlendes nimmt eine fremde Domain offline.

**Ausgestellt heißt nicht ausgerollt, und beantragt heißt nicht ausgestellt.**
acme.sh führt einen Antrag in `--list`, sobald er gestellt ist, auch wenn er
scheitert: mit Domains, ohne `Created` und ohne `Renew`. `findCertificateFor`
zählt deshalb nur, was ein Ausstellungsdatum hat. Das reicht nicht: scheitert
nach dem Antrag das Ausrollen (oder hat jemand von Hand ohne Deploy-Hook
ausgestellt), führt acme.sh ein Zertifikat, das in `/etc/haproxy/certs` nicht
liegt. Als „vorhanden" gezählt, entstünde das Ziel beim zweiten Versuch ohne
PEM, und HAProxy lieferte ein fremdes aus. `issueAndDeploy` rollt ein solches
vorhandenes Zertifikat deshalb aus (`deployCertificate`), statt ein zweites zu
beantragen oder stillschweigend nichts zu tun.

**Der PEM-Name wird gesetzt und nicht dem Hook überlassen** (`pemFileName`,
`DEPLOY_HAPROXY_PEM_NAME`). Die Vorgabe ist die Hauptdomain, und die hieße bei
einer Wildcard `*.kunde.example.pem` — ein Stern im Dateinamen ist in jedem
Shell-Muster ein Zeichen zu viel. Er wird zum Unterstrich; Nicht-Wildcards
behalten ihren Namen.

**Der Healthcheck verträgt keine Wildcard als Hauptdomain — und das ist eine
Bedingung, keine Meldung.** Er schickt `hdr Host <domains[0]>`, und `*.kunde.example`
ist als Host-Header kein gültiger Name: das Ziel antwortete mit 404, und HAProxy
nähme ein funktionierendes Backend aus dem Betrieb. Dieselbe Überlegung, aus der
eine Pfad-Regel gar kein `option httpchk` bekommt.

Ein Fehler aus `validateCreateInput` („stell eine echte Domain an den Anfang
oder schalte den Healthcheck ab") wäre eine Aufforderung, genau das zu tun, was
das Formular auch selbst kann, und er stünde im Weg, während jemand tippt.
Stattdessen `healthcheckPossible`: der Schalter geht aus und wird
gesperrt, mit dem Grund daneben — sichtbar und nicht still —, und
`readServiceInput` zieht ihn beim Normalisieren ebenfalls zurück, damit Formular
und Route dieselbe Eingabe gleich behandeln. Der Zustand des Schalters bleibt dabei
erhalten: wer die Hauptdomain wieder auf eine echte ändert, findet ihn so vor, wie
er ihn gesetzt hat. Eine leere Domainliste heißt „nichts spricht dagegen" und nicht
„unmöglich", sonst stünde der Schalter beim Öffnen des Dialogs gesperrt da.

**Eine Adresse unter der eigenen Wildcard lässt sich einzeln sperren.** „Gehört
zum Eintrag" heißt bei `*.kunde.example` mehr als „steht in der Liste"
(`ownsDomain`) — ein Dienst auf der Wildcard bedient `intern.kunde.example`, und genau
die zu sperren ist ein Anwendungsfall. Eine Prüfung „alle Domains
gesperrt" über die **Länge** beider Listen wäre deshalb falsch: `domains: ['*.kunde.example']` und
`lockedDomains: ['intern.kunde.example']` sind beide einelementig und meinen das
Gegenteil voneinander — über die Länge gegangen wäre der ganze Dienst gesperrt
statt einer einzigen Adresse. `locksEveryDomain` vergleicht die Mengen.

### Interne Installation: DNS-01 für jedes Zertifikat

Eine Installation ist entweder **öffentlich** oder **intern** (`exposure` in den
Einstellungen, gewählt in der Einrichtung, umschaltbar unter „Allgemein").
Intern heißt: Let's Encrypt erreicht den Server nicht. HTTP-01 scheiterte dort
bei jeder Domain, und jeder Fehlversuch zählt gegen das Kontingent. Also geht
dort **jedes** Zertifikat über DNS-01, nicht nur die Wildcard.

- **Die Regel steht an einer Stelle** (`lib/haproxy/challenge.ts`,
  `planChallenge`): DNS-01, wenn eine Wildcard dabei ist **oder** die
  Installation intern ist und kein eigener ACME-Server HAPM über Port 80
  erreicht, sonst HTTP-01; bei „nur hochladen" nie ein Antrag. Sie ist rein, und
  `tests/haproxy/challenge.test.ts` rechnet jede Kombination aus Art, Wildcard,
  HTTP-Schalter, Herkunft und Zahl der Hooks nach.
- **Was die Regel braucht, ist ein Wert** (`ChallengeChoice`: Art, Hook,
  Herkunft der Zertifikate, ACME-Server, HTTP-Schalter). Die Routen bauen ihn mit
  `challengeFor(settings, dnsHook)` aus den Einstellungen; der HTTP-Schalter
  zählt dort nur mit eigenem Server (`challengeChoice`), damit ein Schalter, der
  von früher noch an steht, Let's Encrypt nicht für erreichbar erklärt.
- **`provision.ts` liest die Einstellungen nicht.** Die Art kommt als Parameter
  des Vorgangs herein (`ChallengeChoice`: `exposure` und der gewählte Hook),
  aufgelöst in den Routen, weitergereicht vom Runner. Mitten in einem Vorgang,
  der HAProxy schreibt, wird keine Datenbank gefragt, und die Regel bleibt ohne
  sie prüfbar. Der Runner hat dafür **keine Vorgabe**: ein Lauf, der ein
  Zertifikat ausstellen kann und die Angabe nicht trägt, scheitert, statt auf
  einer internen Installation still HTTP-01 zu versuchen.
- **Der Hook ergibt sich, wenn es nur einen gibt.** Ist genau einer
  eingerichtet, wird er genommen, ohne dass der Aufrufer ihn nennt. Sind es
  mehrere, muss er gewählt sein: welcher Anbieter die Zone führt, lässt sich
  nicht raten. Ein genannter Hook, der nicht eingerichtet ist, wird abgelehnt,
  auch wenn genau ein anderer da wäre. Das gilt für Wildcards genauso, und für
  `/api/internal/haproxy/services` wie für die Oberfläche.
- **Ohne Hook sagt die Vorabprüfung, was fehlt**: bei einer internen
  Installation, dass sie intern ist und unter Reverse-Proxy, Einstellungen die
  DNS-Zugangsdaten fehlen, und welche Wege ohne sie bleiben (eigener
  ACME-Server über Port 80, hochgeladenes Zertifikat). Eine Meldung über
  Wildcards wäre dort falsch.
- **Erst wenn kein Antrag ginge, wird nachgesehen, ob schon eins daliegt**
  (`assertIssuable`). Eine Wildcard von früher oder ein hochgeladenes
  Zertifikat ist dann der Unterschied zwischen „geht" und „geht nicht". Vorher
  nachzusehen kostete in jeder Vorabprüfung ein `acme.sh --list`, und
  `issueAndDeploy` sieht vor dem Antrag ohnehin nach. Der Dialog weiß es aus
  `presentCertificates` (die Domains jeder gültigen PEM-Datei, ohne
  `acme.sh --list`, `readPemCoverage`) und verlangt dann keinen Hook.
- **Das Formular zeigt die Auswahl nur, wenn es etwas zu wählen gibt.** Ohne
  Wildcard steht in einer internen Installation ein Satz („das Zertifikat wird
  über DNS ausgestellt") und die Auswahl erst ab zwei Hooks. Sonst ginge sie bei
  jedem Ziel auf und zeigte immer denselben Eintrag. Was das Formular nicht
  zeigt, schickt es nicht: ohne Auswahl bleibt `dnsHook` leer, und die Route
  nimmt den einen Hook selbst. Die Art kennt das Formular aus
  `/api/haproxy/services` (`exposure` je Proxy).
- **Die Erneuerung bleibt unberührt.** acme.sh merkt sich die Methode je
  Zertifikat in dessen Erneuerungseintrag. Wer die Art umstellt, ändert nur
  künftige Anträge: ein über HTTP-01 ausgestelltes Zertifikat wird weiter über
  HTTP-01 erneuert. Das steht auch auf der Seite „Allgemein" neben dem Schalter.
- **Bei einem eigenen Nameserver und bei Infoblox wartet acme.sh, statt
  nachzusehen.** Nach dem Setzen des TXT-Eintrags fragt acme.sh sonst
  öffentliche Resolver (DNS over HTTPS), ob er sichtbar ist, bis zu 20 Minuten
  lang. Eine Zone im eigenen Netz sieht dort niemand: der Antrag liefe in den
  Abbruch, obwohl der Eintrag steht. Für Hooks mit `fixedWait`
  (`dns_nsupdate`, `dns_infoblox`) gibt `planChallenge` deshalb eine Wartezeit
  mit (`wait`), und `challengeArgs` macht daraus `--dnssleep <Sekunden>`. Der
  Wert ist eine Einstellung (`Settings.dnsWait`, 5 bis 900, Vorgabe 30),
  einzustellen bei den DNS-Zugangsdaten, sobald einer der beiden Hooks
  eingerichtet ist (`components/reverse-proxy/DnsWaitSetting.tsx`), und über
  `PATCH /settings`. Wer weitere Nameserver hat, die die Zone erst nachladen,
  erhöht ihn. acme.sh legt den Wert als `Le_DNSSleep` im Erneuerungseintrag
  des Zertifikats ab: die Erneuerung wartet so lange, wie beim Ausstellen
  galt. `pnpm dns:verify` zeigt beides gegen Pebble und BIND. Bei Hetzner und
  Cloudflare bleibt es bei der Prüfung von acme.sh.

**Die Anbieter heißen so, wie das mitgelieferte acme.sh sie führt.** Hetzner
ist `dns_hetznercloud` mit `HETZNER_TOKEN` (ein Token aus der Hetzner-Konsole,
Lesen und Schreiben). Den früheren Hook `dns_hetzner` gibt es in acme.sh nicht
mehr: ein Eintrag darunter speicherte scheinbar erfolgreich, und kein Hook galt
danach als eingerichtet. `tests/haproxy/dns-credentials.test.ts` lässt deshalb
eine echte Bash schreiben **und** erkennen und besteht darauf, dass der erkannte
Hook der des Anbieters ist. Der Hetzner-Hook legt beim ersten Antrag selbst
weitere `SAVED_*`-Zeilen ab (API-Adresse, TTL). Beim Entfernen gehen sie mit
(`alsoSaved`), sonst gälte der Hook ohne Token weiter als eingerichtet. Ein
eigener Nameserver ist `dns_nsupdate`, Infoblox `dns_infoblox`. Was die beiden
anders machen, steht oben unter „Wildcards".

### Ein Zertifikat ohne Ziel

`issueCertificate` (`provision.ts`) stellt ein Zertifikat aus, ohne dass ein
Ziel dazu entsteht. Der Fall ist die Wildcard aus der Einrichtung:
`example.org` samt `*.example.org` wird einmal ausgestellt, und jedes Ziel
darunter findet es danach vor (`findCertificateFor`), statt ein eigenes zu
beantragen.

- **Derselbe Antrag, derselbe Deploy-Hook.** Es ist `issueAndDeploy`, wie beim
  Anlegen eines Ziels, nur ohne die Konfiguration: `haproxy.cfg` nennt kein
  einzelnes Zertifikat, HAProxy lädt das Verzeichnis, und der Deploy-Hook lädt
  neu. Auch hier wird erst nachgesehen und nur beantragt, was fehlt.
- **Ein abgekoppelter Lauf wie die anderen** (`action: 'certificate'`), mit
  Vorabprüfung (`precheckCertificate`), Schritten und einer Zeile in der
  Historie. In `serviceId` steht die Hauptdomain, in `domains` alle.
- **Die Basis steht vorn, die Wildcard dahinter.** Die erste Domain benennt
  Erneuerungseintrag und PEM-Datei, und `example.org.pem` ist der Name, den man
  beim Nachsehen erwartet.
- **Abgeräumt wird es wie jedes andere:** es bleibt, solange ein Ziel es
  braucht (`certificateUsers`). Braucht es keines, steht es auf der
  Zertifikatsseite mit leerer Spalte „Benutzt von" und lässt sich dort löschen
  (siehe „Die Zertifikatsseite").
- Eine eigene Route dafür gibt es nicht. Aufgerufen wird es aus der Einrichtung
  (`lib/setup/run.ts`).

### Hochgeladene Zertifikate: `lib/haproxy/cert-upload.ts`

Nicht jede Installation kann über ACME ausstellen: eine interne ohne
DNS-Anbieter mit API erreicht Let's Encrypt weder über HTTP noch über DNS, und
manche Netze haben eine eigene CA ohne ACME. Dann bringt der Betreiber das
Zertifikat mit, auf der Zertifikatsseite (`POST /api/haproxy/certificates`) oder
im letzten Schritt des Assistenten.

- **Die Platte ist die Wahrheit, auch hier.** Ein hochgeladenes Zertifikat ist
  eine PEM-Datei in `/etc/haproxy/certs`, die acme.sh nicht führt
  (`uploadedCertificates`: alles außer dem Platzhalter und den Dateien, die
  `pemFileName` für ein ausgestelltes Zertifikat von acme.sh ergibt). Keine
  Collection, aus demselben Grund wie bei `haproxy.cfg`. Die Folge: eine Datei,
  die jemand von Hand dorthin gelegt hat, zählt als hochgeladen. Sie verhält sich
  genauso (niemand erneuert sie, ersetzt und entfernt wird sie auf der Seite),
  und eine eigene Markierung wäre eine zweite Quelle.
- **Gelesen wird je Datei nur das erste Zertifikat** (`certListingCommand`,
  `awk` hört nach dem ersten Block auf). Der Schlüssel verlässt die Datei beim
  Auflisten nie.
- **Geprüft wird vor dem Schreiben, mit node:crypto** (`inspectUpload`):
  lesbar, nicht verschlüsselt (HAProxy fragt nach keinem Passwort), Schlüssel
  passt (`checkPrivateKey`), das Zertifikat davor hat das der Domain ausgestellt
  (`checkIssued`), gültig ab jetzt und nicht abgelaufen, Namen aus den SANs
  (der CN nur ohne SANs). Erst nach dem Neuladen zu merken, dass der Schlüssel
  nicht passt, hieße ein `haproxy -c`, das an der ganzen Konfiguration
  scheitert statt an diesem Zertifikat. Geschrieben wird eine normalisierte
  Datei: Zertifikat, Kette, Schlüssel als PKCS#8. Das Zertifikat zum Schlüssel
  kommt nach vorn, HAProxy liest das erste als das der Domain. Der Schlüssel darf
  auch im Feld des Zertifikats stehen (eine fertige PEM-Datei für HAProxy).
- **Der Name folgt `pemFileName`**: die Hauptdomain (der CN, wenn er unter den
  SANs ist, sonst der erste SAN), der Stern wird zum Unterstrich.
- **Synchron und ohne Lauf** (`uploadCertificate`, `removeUploadedCertificate`).
  Es wird nichts beantragt, der Vorgang dauert Sekunden. Der eigentliche Grund
  ist der Schlüssel: ein Lauf trägt seine Angaben in `haproxy_runs`, bis er
  startet; der Schlüssel stünde in der Datenbank. So geht er aus der Anfrage
  über stdin in die Datei (`withStdin`, `umask 077`, danach `chmod 600`) und
  nirgends sonst hin. Im Protokoll stehen Datei, Domains, Ablauf und
  Aussteller.
- **Dieselben Riegel wie an `haproxy.cfg`**: der Lock, die bisherige Datei als
  Rückweg, `haproxy -c` vor dem Neuladen, und scheitert eins davon, kommt der
  alte Stand zurück. **Die Zwischendateien liegen in `/etc/haproxy`, nicht in
  `/etc/haproxy/certs`**: HAProxy lädt das Verzeichnis als Ganzes, jede Datei
  darin wäre beim nächsten Neuladen ein Zertifikat. Scheitert auch der
  Rückweg, bleiben die Sicherungen (`hapm-upload*.hapm-previous`) liegen.
- **Ersetzen nur ausdrücklich** (`replace`: der Dateiname der Zeile). Eine
  vorhandene Datei gleichen Namens wird sonst nicht überschrieben. Was die
  bisherige Datei für ein Ziel abgedeckt hat, muss das neue abdecken oder ein
  anderes Zertifikat (`strandedServices`), sonst stünde das Ziel nach dem
  Neuladen mit dem Platzhalter da. Abgelehnt wird auch ein Upload unter dem
  Namen eines Zertifikats von acme.sh: die nächste Erneuerung schriebe darüber.
- **Entfernen nur, wenn kein Ziel es braucht**, und „brauchen" heißt: eine
  Domain eines Ziels deckte danach kein anderes Zertifikat ab. Strenger als
  `certificateUsers`, weil es hier um einen Klick auf der Seite geht und nicht
  um das Ende eines Dienstes.
- **Ein Ziel nimmt sein hochgeladenes Zertifikat nicht mit.** `deleteService`
  und der Wechsel der Hauptdomain in `updateService` lassen eine hochgeladene
  Datei stehen und sagen es im Lauf. Vorher wurde eine PEM-Datei ohne Eintrag bei
  acme.sh beim Löschen gelöscht: bei einem hochgeladenen Zertifikat wäre das ein
  Verlust, den niemand von selbst wiederherstellt.
- **`findCertificateFor` sieht nur gültige** (`uploadedCoverage`). Ein
  abgelaufenes hochgeladenes Zertifikat deckt nichts ab, sonst beantragte HAPM
  für die Domain nie wieder eins. Beantragt acme.sh dann eins mit derselben
  Hauptdomain, schreibt der Deploy-Hook über die hochgeladene Datei; der Lauf
  sagt das.
- **Erinnerung vor dem Ablauf**: das Ereignis `certificate_expiring` meldet ein
  hochgeladenes Zertifikat schon 30 Tage vorher (`UPLOAD_WARN_DAYS`, ACME: 14),
  weil ein neues erst bei der CA beantragt werden muss. Übersicht und Seite
  zeigen es ebenso.

**„Nur hochladen" als Art der Installation** (`certificateSource: 'upload'`,
unter „Allgemein" oder im Assistenten): HAPM beantragt dann nie selbst.
`planChallenge` sagt für jede Domain „erst hochladen", und weil
`assertIssuable` vorher nachsieht, geht ein Ziel genau dann, wenn ein
vorhandenes Zertifikat es abdeckt. Der Dialog sagt das vor dem Speichern, mit
dem Weg zur Zertifikatsseite. Was acme.sh schon führt, erneuert es weiter: die
Erneuerung fragt diese Einstellung nicht.

### Ein eigener ACME-Server: `lib/acme-server.ts`, `lib/certificate-settings.ts`

Für die ganze Installation, nicht je Ziel: eine Directory-URL (etwa step-ca im
eigenen Netz), wahlweise mit External Account Binding, und der Schalter „Dieser
ACME-Server erreicht HAPM über HTTP (Port 80)". Eingestellt unter „Allgemein"
oder im Assistenten (`PUT /api/settings/certificates`, `/api/setup/certificates`).

- **Der Server geht als Wert in jeden Antrag** (`ChallengeChoice.acmeServer`,
  `acme.sh --issue --server`). `acmeServer()` in `lib/acme.ts` ist nur noch die
  Vorgabe (`HAPM_ACME_SERVER`, sonst Let's Encrypt); die Einstellung steht davor
  (`effectiveAcmeServer`). `provision.ts` liest die Einstellungen weiter nicht.
- **Die Adresse ist eng geprüft** (`validateAcmeDirectory`): nur `https://`,
  nur `[A-Za-z0-9._~:/-]`. Nicht wegen der Kommandozeile (das macht
  `buildCommand` sicher), sondern weil acme.sh sie als `Le_API='…'` in den
  Erneuerungseintrag jedes Zertifikats schreibt und bei jeder Erneuerung mit
  `eval` liest. Ein Apostroph bräche nicht heute, sondern beim ersten
  Erneuerungslauf.
- **Gespeichert wird erst, wenn acme.sh ein Konto bei ihm hat**
  (`registerAcmeAccount`). Eine falsche Adresse, ein Zertifikat des Servers, dem
  acme.sh nicht vertraut, oder ein abgelehnter EAB-Schlüssel fallen beim
  Speichern auf und nicht beim ersten Ziel in einem Lauf. Das ist der
  Rückabgleich dieser Einstellung.
- **EAB: HAPM ist Durchreiche und nicht Tresor**, wie bei den
  DNS-Zugangsdaten. Gebraucht werden Key-ID und HMAC-Schlüssel genau einmal, bei
  der Anmeldung; acme.sh legt sie danach selbst in der `ca.conf` dieses Servers
  ab. In der Datenbank und im Protokoll steht keins von beiden, zurück an den
  Browser geht nichts. **Der Schlüssel steht in keiner Kommandozeile**:
  `registerAccountScript` liest die Werte von stdin, setzt sie als Argumente
  und liest acme.sh mit `.` ein, statt es aufzurufen (acme.sh endet mit
  `main "$@"`). Ein Aufruf `acme.sh --eab-hmac-key …` stünde in `ps`.
  `tests/acme-server.test.ts` lässt eine echte Shell das mit einem falschen
  acme.sh nachrechnen. Nicht zu verhindern ist, was acme.sh selbst tut: es
  rechnet die Signatur mit `openssl dgst -mac HMAC -macopt hexkey:…` und gibt den
  Schlüssel dafür für einen Augenblick als Argument an openssl. Der Container
  gehört HAPM allein; wer dort `ps` lesen kann, ist ohnehin root.
- **Der HTTP-Schalter** gilt nur mit eigenem Server und nur intern: öffentlich
  ist HTTP-01 ohnehin der Weg. Typisch ist eine CA im selben Netz, die HAPM über
  Port 80 erreicht wie Let's Encrypt einen öffentlichen Server. Wildcards gehen
  auch dann nur über DNS-01 (RFC 8555).
- **Ein Wechsel ändert nur künftige Anträge.** acme.sh merkt sich den Server je
  Zertifikat (`Le_API` im Erneuerungseintrag) und erneuert dort, auch wenn die
  Einstellung längst auf einen anderen zeigt. Wer alle Zertifikate beim neuen
  Server will, muss sie neu ausstellen lassen; einen Knopf dafür gibt es nicht.
  Sonst laufen die alten beim bisherigen Server weiter, solange er erreichbar
  ist. Ist der alte Server weg, scheitert deren Erneuerung, und
  das Ereignis `certificate_renewal_failed` meldet es. Das steht auch auf der
  Seite „Allgemein" neben dem Schalter.
- **Vertrauen in die eigene CA** ist Sache des Abbilds: acme.sh spricht die
  Directory-URL über HTTPS an, mit den Zertifikaten, denen der HAPM-Container
  vertraut. Eine CA, deren Wurzel dort fehlt, scheitert bei der Anmeldung mit
  der Meldung von curl. Ein Feld dafür gibt es beim ACME-Server nicht. Die CA,
  die bei den Zugangsdaten von Infoblox hinterlegt wird, landet allerdings im
  selben Bestand (`TRUST_SYNC`, siehe „Wildcards"): stammt der ACME-Server von
  derselben Stelle, vertraut acme.sh ihm damit auch.

### Die Zertifikatsseite: `/reverse-proxy/zertifikate`

Was acme.sh führt und was hochgeladen ist, mit den abgedeckten Domains, dem
Erneuerungstermin oder Ablauf und den Diensten, die es benutzen. **Was acme.sh
führt, entsteht und vergeht mit einem Dienst und lässt sich hier nur löschen,
wenn es niemand hält.** Ein gebrauchtes hier zu löschen hieße, dem
Reverse-Proxy das PEM unter einer laufenden Domain wegzuziehen, und das fiele
beim nächsten Start von HAProxy auf, nicht heute. **Hochgeladene entstehen
dagegen nur hier**, also werden sie hier hochgeladen, ersetzt und entfernt
(siehe „Hochgeladene Zertifikate").

Die Spalte, für die es die Seite gibt, ist „Benutzt von": leer heißt, das
Zertifikat ist entweder von Hand ausgestellt oder von einem gelöschten Dienst
übrig. Beides wäre sonst unsichtbar; automatisch aufgeräumt wird es nicht. Steht dort ein Dienst, ist sein Name der Weg zu ihm
(`?dienst=<id>` auf der Gruppenseite öffnet den Bearbeiten-Dialog) — sonst müsste
man die Gruppe raten, die Seite suchen und dort unter dreißig Karten die richtige
finden. Der Adressteil kommt aus der Route und wird nicht in der Oberfläche
gerechnet: `scopeSlug` ist die eine Stelle, die aus einem Marker-Namen einen Pfad
macht. Aufgelöst wird der Link erst nach dem Laden und genau einmal — vorher ist
„gibt es nicht" nicht dasselbe wie „noch nicht gelesen", und ohne das Flag ginge
der Dialog nach jedem Poll-Takt wieder auf. Die Adresse wird danach aufgeräumt,
sonst öffnet ein Reload denselben Dialog erneut.

**„Benutzt von" heißt: HAProxy liefert es diesem Ziel aus**
(`certificateUse`, `servedCertificate` in `certs.ts`, `servedFiles` in
`cert-upload.ts`). Nicht: es deckt eine Domain des Ziels ab. HAProxy lädt das
Verzeichnis als Ganzes und wählt per SNI zuerst ein Zertifikat mit genau dem
Namen, erst danach eine Wildcard. Ein Ziel mit eigenem Zertifikat unter
`*.kunde.example` bekommt das eigene, und die Wildcard bedient es nicht.
Vorher zählte die Seite jedes abdeckende Zertifikat: das eigene **und** die
Wildcard standen beim Ziel, und es sah aus, als schriebe HAPM jedes Ziel unter
beide. Gezählt wird außerdem nur, was HAProxy überhaupt lädt: ein nie
ausgestellter Antrag (Spalte „Erneuerung": „Nie ausgestellt") und ein
ausgestelltes, aber nicht ausgerolltes Zertifikat („Nicht ausgerollt") haben
keine Datei und bedienen niemanden. Bei gleichen Namen gewinnt die erste
Datei in Byte-Reihenfolge, so liest HAProxy das Verzeichnis. Ein Ziel auf einer
Wildcard benutzt dazu jedes genaue Zertifikat darunter, dessen Name bei ihm
landet (erster Eintrag der Datei, dessen ACL den Namen trifft, wie
`shadowedBy`).

Für `certificateUsers` beim Löschen gilt das **nicht**: dort bleibt ein
Zertifikat stehen, solange es einen übrig bleibenden Dienst auch nur abdeckt.
Im Zweifel bleibt es stehen; die Seite dagegen soll zeigen, was ist.

**Ein Zertifikat von acme.sh, das niemand hält, lässt sich hier löschen**
(`DELETE /api/haproxy/certificates?domain=<Hauptdomain>`,
`removeAcmeCertificate`, Knopf in der Zeile; ab zwei Kandidaten auch
„Unbenutzte löschen", das dieselbe Route je Zertifikat nacheinander aufruft).
Der Fall: ein Ziel ist gelöscht, sein Zertifikat blieb wegen einer Wildcard
oder eines zweiten Ziels stehen, oder ein Antrag aus der Einrichtung kam nie
durch. Automatisch aufgeräumt wird weiter nichts.

- **„Hält" ist beides** (`certificateKeepers` in `certs.ts`): ein Ziel bekommt
  es ausgeliefert („Benutzt von", `certificateUse`), **oder** es deckt eine
  Domain eines Ziels ab (`certificateUsers`, dieselbe vorsichtige Regel wie
  beim Löschen eines Dienstes). Nur das Erste hieße: die Wildcard über Zielen
  mit eigenem Zertifikat ginge weg, und fiele eins dieser Zertifikate später
  weg, stünde das Ziel ohne da. Nur das Zweite übersähe den Dienst auf
  `*.kunde.example`, dem HAProxy ein genaues Zertifikat darunter ausliefert.
  Steht „Benutzt von" leer und das Zertifikat hält trotzdem jemand, sagt das
  ein „i" in der Zelle, mit den Zielen.
- **Ein nie ausgestellter Antrag hält niemand.** Er hat kein Zertifikat und
  deckt nichts ab (`findCertificateFor` übergeht ihn ohnehin). Typisch ist die
  gescheiterte Wildcard aus der Einrichtung, unter der längst Ziele mit eigenem
  Zertifikat stehen; mit „deckt ab" bliebe sie für immer. Eine Datei unter
  seinem Namen ist hochgeladen und bleibt.
- **Geprüft wird im Lock**, nicht in der Oberfläche: zwischen zwei Takten der
  Seite kann ein neues Ziel genau dieses Zertifikat gefunden haben. Auch ein
  laufender „Erneut beantragen"-Lauf hält den Lock, das Löschen sieht danach
  das ausgestellte Zertifikat.
- **Erst die Datei, dann acme.sh.** Eine ausgestellte PEM-Datei geht neben das
  Verzeichnis (`hapm-acme-old.pem.hapm-previous`), dann `haproxy -c` und
  Neuladen (`checkAndReload`, scheitert es, kommt sie zurück). Danach
  `acme.sh --remove` und das Domainverzeichnis (`<domain>_ecc`, bei RSA ohne
  Endung): `--remove` meldet nur ab und ließe den Schlüssel liegen. Die Datei
  lässt sich zurücklegen, ein abgemeldeter Eintrag nicht. Scheitert acme.sh
  danach, sagt die Meldung, dass die nächste Erneuerung die Datei wieder
  anlegt. Ohne Datei (nie ausgestellt, nicht ausgerollt) wird nicht neu
  geladen.
- Protokoll: `haproxy_certificate_removed` wie bei einem hochgeladenen, im
  Detail mit `acme.sh` davor.

**Ein nie ausgestellter Antrag lässt sich hier noch einmal stellen**
(`POST /api/haproxy/certificates/issue`, Knopf in der Zeile). Der typische Fall
ist die Wildcard aus der Einrichtung, die am DNS-Hook scheiterte: acme.sh
behält den Eintrag, ein Zertifikat gibt es nicht, und jedes Ziel darunter
bekommt ein eigenes. Einen Antrag ohne Ziel stellt sonst nur der Assistent,
der Eintrag bliebe für immer ein Zertifikat, das es nicht gibt. Nur für
Einträge ohne Ausstellungsdatum und nur mit deren Domains: Ausgestelltes
erneuert acme.sh selbst, und beliebige Zertifikate ohne Ziel sind nicht der
Zweck der Seite. Es ist derselbe Lauf wie aus dem Assistenten
(`action: 'certificate'`).

**Ziele mit eigenem Zertifikat wechseln danach nicht von selbst auf die
Wildcard**, und das ist Absicht: ihr Zertifikat ist gültig, wird erneuert, und
HAProxy liefert es vor der Wildcard aus. Auf die Wildcard käme ein Ziel nur,
wenn sein eigenes Zertifikat abgeräumt wird; das macht HAPM nicht ungefragt.
Ein Ziel neu zu speichern ändert daran nichts (`certificateChanged`: gleiche
Domains, kein Antrag).

Eine eigene Route und kein Feld auf `/api/haproxy/services`, weil
`acme.sh --list` über jedes Domainverzeichnis läuft: die Übersicht pollt im
Minutentakt, diese Seite alle zwei Minuten und nur, wenn sie offen ist.

### Was für alle Dienste gilt: `/reverse-proxy/einstellungen`

**Fünf Reiter** statt einer langen Seite: HTTPS, Zugriff (Admin-IPs und
Zugriffsschutz), DNS-Zugangsdaten, Länder-Tabelle, Grundkonfiguration. Der
gewählte steht als `?bereich=` in der Adresse (`zugriff`, `dns`, `laender`,
`grundkonfiguration`), Links anderswo führen damit direkt hin; ein alter Link
auf `#grundkonfiguration` öffnet den Reiter auch. Reiter, Adresse und Punkt
kommen aus `components/AreaTabs.tsx`, den auch andere Seiten nehmen. HTTPS-Zeilen, Admin-IPs und
Zugriffsschutz gehen in EINEM Vorgang in die Datei, deshalb steht ihr Speichern
oben in der Kopfzeile, und ein Reiter mit ungespeicherten Änderungen trägt
einen Punkt.

Was keinem Dienst gehört, sondern HAProxy als Ganzem: der Block unter
`# Globale HTTPS-Settings` im Frontend (HSTS, `option forwardfor`, die
`X-Forwarded-*`-Header), die Admin-Adressliste und der Zugriffsschutz (eigener
Abschnitt weiter unten). Sie stehen deshalb auf einer
eigenen Seite und nicht im Dienst-Dialog.

Eine Umleitung für unbekannte Domains (`backend default_404`) gehört bewusst
nicht dazu: der Fehlerfall wird mit einer eigenen Fehlerdatei bedient (in der
Grundkonfiguration: `http-request deny deny_status 404` im
`backend default_404`, die Seite dazu nennt der `defaults`-Block). Ein Feld, das
eine Zeile überschreibt, die sonst niemand über HAPM pflegt, wäre nur ein Weg,
sie versehentlich zu ändern.

- **Der Marker ist die Bedingung, nicht der Block.** Fehlt
  `# Globale HTTPS-Settings`, wird nichts angeboten: einen Block anzulegen hieße
  raten, an welche Stelle des Frontends er gehört, und eine `http-request`-Regel
  an der falschen Stelle wirkt auf die falschen Dienste.
- **Der Block ist Text, keine Schalter.** Ein Formular aus Schaltern für HSTS
  und die bekannten Zeilen müsste bei allem daneben (`X-Content-Type-Options`,
  ein eigenes `X-Forwarded-For`) den ganzen Block **unbearbeitbar** machen — nach
  derselben `extras`-Regel wie bei einem Dienst. Bei einem Dienst trägt die Regel:
  die Maske kennt Domains, Ziele und Zusätze, und was daneben steht, ist die
  Ausnahme. Hier ist es umgekehrt. Der Block ist die Stelle, an der ein Betreiber
  gerade die Zeile hinschreibt, die kein Formular vorhersieht; ein Werkzeug, das
  dann für ALLE Zeilen zumacht, ist genau dort keins mehr. Also wird nicht
  gedeutet: eine Zeile je Feld, gelesen wie sie dasteht, zurückgeschrieben wie sie
  eingegeben wurde. Geprüft wird sie von `haproxy -c` — die
  einzige Stelle, die HAProxy-Syntax wirklich kennt, und sie läuft ohnehin.
  Abgelehnt werden nur zwei Formen, und zwar vorab: ein Kommentar und eine Zeile,
  die einen neuen Abschnitt beginnt (`backend …`). Beide beenden den Block beim
  nächsten **Lesen**, und alles darunter stünde dann außerhalb — das fängt kein
  `haproxy -c`, weil die Datei dabei gültig bleibt. Ein leerer Block ist etwas
  anderes als ein fehlender Marker: `httpsLines: []` heißt bearbeitbar, `null`
  heißt, es gibt keine Stelle für die Zeilen.
- Für die Admin-IPs gilt das nicht: eine IP-Liste ist eine IP-Liste und bleibt
  ein Eingabefeld mit Prüfung.

**Die Admin-IPs sind EINE Liste**, nicht eine je Eintrag
(`acl admin_ips src …`). Dieselben Adressen an dreißig Stellen wären dreißig
Stellen, die auseinanderlaufen, sobald sich eine Büro-IP ändert; hier ändert man
sie einmal. Gesperrt wird ein Eintrag mit genau einer Zeile
(`http-request deny deny_status 403 if host_<id> !admin_ips`), umgelegt am
Schloss auf seiner Karte oder im Dialog unter „Zugriff". Beides schreibt
denselben vollständigen Eintrag und läuft über denselben abgekoppelten Vorgang.

**Im Dialog ist der Zugriff eine Karte mit einer Frage**: Offen, Nur Admin-IPs
oder Passwort. Vorher trug jede Domainzeile ein Schloss, daneben stand ein
Umschalter für die Art und darunter ein Satz; die Art stand damit auch dann im
Formular, wenn gar nichts gesperrt war. Was die Antwort braucht, steht darunter
und nur dann: bei „Nur Admin-IPs" die hinterlegten Adressen mit dem Weg zu
Reverse-Proxy, Einstellungen (fehlen sie, ist die Wahl gesperrt und der Grund
steht sichtbar da, ein Tooltip auf einem gesperrten Knopf erscheint nicht),
bei „Passwort" das Feld, und bei mehr als einer Domain „Für welche Domains"
mit „Alle Domains" als Vorgabe. Das Schloss in der Domainzeile ist nur noch
ein Kennzeichen. Das Modell dahinter ist dasselbe geblieben (`lockedDomains`,
`passwordLock`), und ein Eintrag behält beim Öffnen seine Art, auch wenn ihre
Voraussetzung inzwischen fehlt. „Offen" schickt keine gesperrte Domain, was
auch immer in der Auswahl noch steht.

**Ob ein Ziel antwortet, sagt HAProxy selbst.** Die Farbe der Healthcheck-Marke
auf der Karte (grün erreichbar, gelb teilweise, rot keins) kommt aus `show stat`
über den Stats-Socket — dessen Pfad aus derselben
Konfiguration gelesen wird, die ohnehin schon im Speicher liegt
(`parseStatsSocket`). Geraten wird er nicht: `/run/haproxy/admin.sock` und
`/var/run/haproxy.sock` sind beide üblich, und wer rät, findet bei der Hälfte
der Installationen nichts und hielte das für „alles unten" (die
Grundkonfiguration von HAPM schreibt `/run/haproxy/admin.sock`; gelesen wird
der Pfad trotzdem aus der Datei, sie darf von Hand geändert sein). Fehlt der
Socket, fehlt
`socat`, oder trägt kein Server ein `check`, bleibt die Marke **farblos** statt
grün — und ihr Tooltip sagt, woran es liegt — und ein Server mit `no check` zählt in `serviceHealth` gar nicht
mit. Gerechnet wird über alle Backends des Eintrags, auch die der Pfad-Regeln:
ein totes Terminal-Backend ist ein Teil des Dienstes, der nicht antwortet.

Was hier über die Sperre auf Admin-IPs steht, gilt für die Passwortsperre
genauso, soweit es um die Domains geht. Was an ihr anders ist, steht im nächsten
Abschnitt.

**Gesperrt sind DOMAINS, nicht Einträge** (`lockedDomains`). Ein Dienst bedient
oft `kunde.example` und `intern.kunde.example`, und gesperrt gehört nur die zweite — über
die Host-ACL ginge das nicht, die trägt beide. Sind alle Domains gemeint, tut es
trotzdem die Host-ACL; für einen
Teil kommt eine zweite ACL `lock_<id>` mit genau den gesperrten dazu. EIN Feld
und kein Schalter daneben: „gesperrt" ist keine eigene Tatsache neben „diese
Domains", sondern dieselbe. `lock_<id>` geht beim Löschen immer mit — auch wenn
der Eintrag gerade keine Teil-Sperre hat, denn eine ACL aus einem früheren Stand
bliebe sonst als Karteileiche stehen.

Drei Dinge daran fallen sonst erst beim nächsten Start von HAProxy auf, und dann
steht alles:

- **Eine Regel ohne ihre ACL ist „unknown acl", und die ganze Datei wird
  abgelehnt.** Deshalb geht die Deny-Regel beim Löschen des Dienstes mit — auch
  eine fremde, die jemand von Hand auf dieselbe Host-ACL geschrieben hat. Und
  deshalb lässt sich die Adressliste nicht leeren, solange ein Eintrag darauf
  zeigt; die Meldung nennt die Einträge.
- **Eine ACL muss VOR ihrer ersten Verwendung stehen.** Sie wird deshalb hinter
  der letzten `bind`-Zeile des Frontends eingefügt, in dem die Dienste liegen —
  nicht beim ersten Eintrag, der sie braucht.
- **Sperren ohne Adressen wird abgewiesen**, bevor irgendetwas geschrieben wird.
  Sonst scheiterte erst das `haproxy -c` des Vorgangs, mit einer Meldung, die
  nicht sagt, woran es liegt.

`403` und nicht `404`: „gibt es, darfst du nicht" ist die Wahrheit, und ein 404
schickt einen ausgesperrten Kollegen in die falsche Fehlersuche.
- Geschrieben wird über denselben Weg wie ein Dienst (Lock, Prüfsumme, `haproxy -c`,
  Backup, Reload) und als derselbe abgekoppelte Lauf, nur mit
  `action: 'settings'` und ohne Zertifikat.

### Der Zugriffsschutz: Adressen, Länder, Ratenbegrenzung

Drei Sperren für jeden Dienst, auf `/reverse-proxy/einstellungen` unter
„Zugriffsschutz" und im selben Speichern wie die Admin-IPs (`protection` in
`GlobalSettings`). In der Datei ein Block unter `# Zugriffsschutz` im
HTTPS-Frontend, geschrieben von `protectionLines` (`config.ts`):

```
    # Zugriffsschutz
    acl hapm_blocked_ips src 203.0.113.7 198.51.100.0/24
    http-request deny deny_status 403 if hapm_blocked_ips
    acl hapm_blocked_countries src -f /etc/haproxy/hapm-geo/CN.lst -f /etc/haproxy/hapm-geo/RU.lst
    http-request deny deny_status 403 if hapm_blocked_countries !admin_ips
    stick-table type ipv6 size 100k expire 20s store http_req_rate(10s)
    http-request track-sc1 src
    http-request deny deny_status 429 if { sc_http_req_rate(1) gt 300 } !admin_ips
```

- **Nur im HTTPS-Frontend.** Im HTTP-Frontend liegt die ACME-Prüfung, und
  Let's Encrypt prüft von Rechnern in mehreren Ländern aus: eine Ländersperre
  dort ließe HTTP-01 scheitern. Wer über HTTP kommt, landet per Umleitung ohnehin
  vor der Sperre.
- **Wo der Block steht:** hinter `acl admin_ips`, sonst hinter der letzten
  `bind`-Zeile des Frontends mit dem Marker der HTTPS-Einstellungen
  (`protectionAnchor`). Nicht die letzte `bind`-Zeile der Datei: die kann zu
  einer TCP-Weiterleitung gehören. Damit steht er vor jeder Regel der Dienste
  und vor den Kopfzeilen der HTTPS-Einstellungen.
- **Admin-IPs sind von Länder- und Ratensperre ausgenommen**, von der Sperre
  einzelner Adressen nicht (wer eine Adresse sperrt, meint sie). `!admin_ips`
  gibt es nur, solange die ACL existiert. Deshalb schreibt
  `applyGlobalSettings` den Block bei JEDEM Speichern neu, auch wenn das Feld
  fehlt: wer die Admin-IPs leert, nimmt die Ausnahme mit, sonst wäre die Datei
  „unknown acl".
- **Er zählt nur vollständig** (`parseProtection`), wie die Passwortsperre:
  gelesen wird ein Kandidat, und er gilt erst, wenn er neu geschrieben Zeile für
  Zeile so dasteht. Ein von Hand geänderter Block ist `protection: null`, wirkt
  weiter, wird nicht überschrieben, und ein Speichern mit Feld wird abgelehnt.
- **Höchstens 64 Wörter je Zeile** liest HAProxy, der Rest wird mit einer
  Warnung abgeschnitten. Lange Listen gehen auf mehrere Zeilen mit demselben
  ACL-Namen (40 Adressen, 20 Länder je Zeile), die HAProxy verodert.
- **Die Ratenbegrenzung zählt in einer `stick-table` des Frontends selbst**,
  über `sc1` (die Passwortsperre zählt über `sc2`). Zeiträume 10 s, 1 min,
  10 min, Ablauf das Doppelte. Ein zweites `stick-table` im selben Frontend,
  von Hand geschrieben, lehnt `haproxy -c` ab. Vorschlag beim Einschalten:
  300 Anfragen in 10 Sekunden, weil eine Seite beim ersten Laden leicht hundert
  Dateien holt und mehrere Menschen hinter einem Anschluss eine Adresse teilen.
- **Die Länder kommen als Dateien, eine je Land** (`/etc/haproxy/hapm-geo/XX.lst`,
  `lib/geoip/networks.ts`), erzeugt aus der GeoIP-Tabelle von HAPM als
  CIDR-Netze, IPv6 höchstens /64 (die Tabelle führt nur die oberen 64 Bit).
  Keine Map aller Bereiche: die hielte die ganze Welt im Speicher von HAProxy,
  auch für ein einziges Land, und welche Länder gesperrt sind, stünde nicht
  lesbar in `haproxy.cfg`. Größen mit dem Datensatz 2026-08: DE rund 51 000 Netze
  (0,9 MB), US rund 310 000 (5,8 MB, gut 2 s zum Erzeugen).
- **Die Dateien müssen liegen, bevor `haproxy -c` läuft.** `stageAndCheck` legt
  sie vor jeder Prüfung an (`ensureGeoBlockFiles`), sobald die Konfiguration auf
  sie zeigt, verglichen über die Prüfsumme. Geschrieben wird über
  `sh -c 'cat > "$1"'`, nicht `tee`: das gäbe Megabytes auf stdout zurück.
  Aufgeräumt wird nicht.
- **Eine neue GeoIP-Tabelle kommt sofort an:** nach Abruf, Upload und
  Zurücksetzen ruft `followGeoipChange` (`lib/geoip/follow.ts`) abgekoppelt
  `refreshGeoBlockFiles`. Hat sich eine Liste geändert, wird geprüft und neu
  geladen. Ein Fehler steht im Log und macht den Import nicht ungültig.
- **Ein Land, das die Tabelle nicht kennt, wird vorab abgelehnt**
  (`precheckSettings`), sonst gäbe es eine leere Liste und eine Sperre, die
  nichts sperrt. Ohne Tabelle lässt sich kein Land sperren.
- **Niemand sperrt sich selbst aus.** Die Oberfläche läuft über dasselbe
  HAProxy. Die Route `/api/haproxy/settings` lehnt mit 409 ab, wenn die eigene
  Adresse unter eine gesperrte Adresse fällt oder ihr Land gesperrt ist und sie
  keine Admin-IP ist (`lockoutReason`, `lib/haproxy/protection-guard.ts`). Die
  Seite nennt die eigene Adresse und ihr Land. Über `/api/internal` und MCP gibt
  es diese Prüfung nicht: dort ist der Aufrufer eine Maschine.
- **Der Abgleich mit der Grundkonfiguration** sieht den Block nicht
  (`managedIndexes` in `base-config-diff.ts`).

### Abgleich mit der Grundkonfiguration: `lib/haproxy/base-config-diff.ts`

Die Grundkonfiguration (`base-config.ts`) entsteht nur, wenn `haproxy.cfg`
fehlt. Danach ist die Datei die Wahrheit, und eine neue Vorgabe von HAPM
(zuletzt `limited-quic` in `global`) kommt bei einer bestehenden Installation
nie an. Die Karte „Grundkonfiguration" auf `/reverse-proxy/einstellungen` zeigt,
wo die Datei von dem abweicht, was `renderBaseConfig` mit den Optionen dieser
Installation ergäbe, und schreibt ausgewählte Punkte hinein. Die Vorgaben sind
die Konfiguration, die der Betreiber produktiv fährt und als Best Practice
festgelegt hat, deshalb lohnt sich das Nachziehen.

- **Verglichen wird nur, was die Grundkonfiguration besitzt:** `global`,
  `defaults` und die beiden Frontends, gefunden zuerst am Namen, sonst an der
  Rolle (Marker der globalen Einstellungen oder `bind :443` für HTTPS,
  `bind :80` für HTTP). Ein Abschnitt, der so nicht zu finden ist, wird
  genannt und nicht angelegt. Kommentare, Leerzeilen und die Reihenfolge zählen
  nicht. Die IPv6-Option steht in der Datei (`detectIpv6`), die Fehlerseiten
  sind alle, die HAPM kennt (`bootstrap.ts` legt die Dateien beim Start an).
- **Drei Arten Abweichung**: eine Zeile fehlt, sie hat einen anderen Wert, oder
  es gibt sie nur in der Datei. „Dieselbe Zeile" heißt derselbe Schlüssel
  (`directiveKey`): `timeout client`, `bind :443`,
  `http-response set-header alt-svc`. `*:443`, `0.0.0.0:443` und `:443` gelten
  als dieselbe Adresse, sonst schlüge der Abgleich einen zweiten Listener auf
  denselben Port vor.
- **Nie vorgeschlagen:** die Zeilen der globalen Einstellungen (Block unter
  `# Globale HTTPS-Settings`, `acl admin_ips`), weil zwei Stellen für dieselben
  Zeilen sich widersprechen; `log` in `global`, weil `raw` Absicht ist
  (`lib/haproxy-log.ts`); eine vorhandene `errorfile`-Zeile mit anderer Datei
  (503 mit der Seite der 404 ist ein verbreiteter Griff); alles zwischen
  `# BEGIN AUTO …` und `# END AUTO …`, also auch alte Kennungen wie
  `vsm_lock_…`.
- **Es wird nichts gelöscht.** Eine Zeile, die es nur in der Datei gibt, ist
  meist bewusst gesetzt und steht als Hinweis da, ohne Auswahl. `daemon`
  bekommt eine Begründung: das Abbild startet HAProxy mit `-db`, das hebt die
  Zeile auf.
- **Wohin eine fehlende Zeile kommt:** hinter ihren direkten Vorgänger aus der
  Grundkonfiguration, sonst vor ihren direkten Nachfolger. Steht sie dort als
  eigene Gruppe, kommt sie mit Leerzeile und ihrem Kommentar hinter die Gruppe
  des nächsten Vorgängers. Übernommen wird eine Abweichung nach der anderen,
  vor jeder wird neu verglichen. Der Test hält fest, dass eine ältere Datei nach
  dem Übernehmen aller Punkte Zeichen für Zeichen `renderBaseConfig` ergibt.
- **Die Auswahl geht als IDs an die Route** (`/api/haproxy/base-config`), und
  der Vorgang rechnet innerhalb des Locks neu. Gibt es eine ID nicht mehr,
  bricht er ab, statt etwas anderes zu schreiben als angeklickt.
- **Geschrieben wird synchron** wie bei den Fehlerseiten (kein Zertifikat),
  aber über denselben Weg wie jeder Vorgang an `haproxy.cfg`: Lock, Prüfsumme,
  `haproxy -c` neben der gültigen Datei, Backup, Reload, Rollback
  (`updateBaseConfig` in `provision.ts`). Audit: `haproxy_base_config_updated`
  bzw. `_failed`.
- Fehlen Zeilen, trägt die Karte von HAProxy auf `/reverse-proxy` eine Marke
  „N neue Vorgaben" mit Link auf die Karte (`baseConfigMissing` in
  `/api/haproxy/services`, aus demselben Text gerechnet, ohne eigene Runde).
- **Wer `base-config.ts` ändert**, schreibt zur neuen Zeile eine Begründung in
  `HINTS` (`base-config-diff.ts`) und prüft, ob `directiveKey` sie als
  dieselbe Direktive wie eine bestehende Zeile erkennt.

### Die Passwortsperre

Die zweite Art, eine Domain zu sperren: statt auf die Admin-IPs zu prüfen, zeigt
HAProxy eine Passwortabfrage. Gedacht für alles, was ein Kunde sehen soll und die
Öffentlichkeit noch nicht (Vorschau, Staging), wo eine Adressliste nicht geht,
weil niemand die Adresse des Kunden kennt.

**Welche Domains gesperrt sind, sagt `lockedDomains`. WIE, sagt
`passwordLock`:** `null` heißt Admin-IPs, gesetzt heißt Passwort. Eine Art je
Eintrag und nicht je Domain, weil es in der Datei eine ACL der gesperrten Domains
gibt (die Host-ACL oder `lock_<id>`), und an ihr hängt entweder die eine
Deny-Regel oder die Abfrage. Das Schloss auf der Karte fragt deshalb beim Sperren
nach der Art (`LockDialog`) und löst mit einem Klick.

**HAProxy macht alles selbst, HAPM ist danach nicht beteiligt.** Eine
gesperrte Seite soll nicht davon abhängen, ob HAPM läuft. Was je Eintrag in der
Datei steht
(`passwordLockRules`, `passAclLine`, `LOCK_TABLE_LINE`):

- eine ACL auf einen Cookie (`pass_<id>`, Cookie `hapm_lock_<id>`), die den
  Durchlass erkennt,
- sechs `http-request`-Regeln im Frontend, alle nur ohne gültigen Cookie: Versuch
  zählen, bei zu vielen 429, auf den Rumpf warten, bei richtigem Passwort Cookie
  setzen und per 303 auf dieselbe Adresse zurück, bei jeder anderen Eingabe die
  Seite mit Hinweis, sonst die Abfrage,
- eine `stick-table` im Backend des Eintrags für die Zählung.

Wer durchgelassen ist, erreicht das Ziel, als gäbe es die Sperre nicht.

- **Die Sperre zählt nur vollständig.** Dieselbe Regel wie bei Presets und
  Sitzungsbindung: aus Cookie-ACL und Passwort-Regel entsteht beim Lesen ein
  Kandidat, und er gilt erst, wenn alle sechs Regeln Wort für Wort so dastehen,
  wie dieses Modul sie schriebe (`readPasswordLock`). Eine geänderte Zahl, eine
  fehlende Regel oder eine fehlende `stick-table` machen den Eintrag nur lesbar.
  Neu geschrieben wäre aus der halben Sperre eine ganze geworden, oder aus
  fünfhundert erlaubten Versuchen zehn.
- **Das Passwort steht nirgends.** Nicht in der Datenbank, nicht in der Historie,
  nicht im Audit. In `haproxy.cfg` stehen Salz und SHA-256-Hash. Wer es verliert,
  setzt ein neues. Der Dialog belegt deshalb einen Vorschlag vor
  (`suggestPassword`) und sagt, dass jetzt die Gelegenheit zum Kopieren ist.
- **SHA-256 und kein langsamer Hash, und das ist eine Grenze von HAProxy.** Ein
  Formularfeld lässt sich dort nur mit eigenen Konvertern prüfen, und darunter
  gibt es kein bcrypt. Der Preis ist kleiner, als er klingt: wer `haproxy.cfg`
  lesen kann, braucht das Passwort nicht, denn der Cookie-Wert steht in derselben
  Datei. Gegen Raten von außen hilft die Zählung (zehn Eingaben je Adresse in zehn
  Minuten, `LOCK_MAX_ATTEMPTS`), nicht der Hash.
- **Der Cookie-Wert ist je Eintrag fest und entsteht mit dem Passwort neu.** Alle,
  die das Passwort kennen, tragen denselben Wert, 30 Tage lang
  (`LOCK_COOKIE_MAX_AGE`). Ein neues Passwort meldet damit alle ab. Eine geänderte
  Backend-Adresse tut das nicht, siehe nächster Punkt.
- **Hash und Cookie-Wert gehen nicht an den Browser, und ein Eintrag lässt sich
  trotzdem vollständig zurückschicken.** `/api/haproxy/services` liefert an ihrer
  Stelle `KEEP_PASSWORD` (`withoutLockSecret`), und `replaceService` setzt beim
  Schreiben wieder ein, was in der Datei steht. Dort und nicht in der Route, weil
  nur dort der alte Eintrag und die neue Eingabe nebeneinanderliegen, innerhalb
  des Locks. Ein neues Passwort geht als `lockPassword` neben dem Rumpf mit;
  daraus macht `readServiceRequest` (`lib/haproxy/password-lock.ts`) die Sperre.
  Ein mitgeschickter Hash wird nie übernommen: er hieße, dass ein Aufrufer den
  Cookie-Wert selbst bestimmt.
- **Ein Aufrufer, der das Feld nicht kennt, ändert die Art nicht**
  (`INHERIT_LOCK`). Über `/api/internal` baut ein Dienst den Rumpf aus den
  Feldern, die er kennt. Ein fehlendes `passwordLock` als „keine Passwortsperre"
  gelesen hieße: wer eine Backend-Adresse ändert, stellt nebenbei auf Admin-IPs
  um, und alle mit Passwort stehen vor einem 403. Die Oberfläche schickt das Feld
  immer, und ein ausdrückliches `null` heißt dort Admin-IPs.
- **Die Rücksprungadresse ist vollständig und fest `https://`.** Ein Pfad wie
  `//fremd.example` wäre als `Location` eine fremde Seite, und zwar direkt nach der
  Eingabe des richtigen Passworts.
- **Die Zählung liegt im Backend des Eintrags und nicht in einem gemeinsamen
  Abschnitt.** So geht sie beim Löschen von selbst mit, und es gibt keinen Block,
  von dem man wissen müsste, wer ihn noch braucht. Gezählt wird über `sc2` und mit
  benannter Tabelle: eine von Hand geschriebene Zählung im selben Frontend belegt
  am ehesten `sc0`, und die benannte Tabelle verhindert, dass ein fremder Zähler
  hier eine falsche Sperre auslöst. Belegt jemand `sc2` selbst, zählt die Sperre
  still nicht mehr. Das ist die Richtung, in die es kippen soll.
- **Die Admin-IPs braucht sie nicht**, und ein so gesperrter Eintrag steht dem
  Leeren der Adressliste nicht im Weg (`lockedServices`).
- **HAProxy ab 2.4** (`supportsPasswordLock`), wegen `http-request
  wait-for-body`. Ohne das Warten ist der Rumpf beim Prüfen noch nicht gelesen,
  und jedes Passwort gälte als falsch. Mit einem älteren HAProxy ist die Karte im
  Dialog aus und nennt die Version; eine unbekannte Version sperrt nichts aus,
  dann entscheidet `haproxy -c`.

**Die Seite, die der Besucher sieht, liegt als Datei neben der Konfiguration**
(`/etc/haproxy/hapm-lock/`, drei Fassungen: Abfrage, falsches Passwort, zu viele
Versuche). **Ihr Aufbau kommt aus `ui/static/page.ts`** und wird dort
geändert; `lib/haproxy/lock-page.ts` gibt die Texte und den Namen des Feldes
herein. Farben, Logo, Name, Fußzeile, Überschrift, Text und Knopf kommen aus dem
Design unter „Reverse-Proxy → Fehlerseiten" (nächster Abschnitt), Logo, Name
und Akzentfarbe sonst aus der Darstellung, auch wenn die Fehlerseiten eine
eigene HTML-Datei sind. Die Hinweise „Das Passwort stimmt nicht." und „Zu
viele Versuche" bleiben fest. HAProxy liest
die Dateien beim Laden der Konfiguration ein, und daraus folgt:

- **Eine Datei, nichts zum Nachladen, kein JavaScript.** Vor der Sperre bekäme
  jede weitere Anfrage an die Domain wieder diese Seite. Stil und Logo stehen im
  Dokument (ein eigenes Logo als Data-URI), die Schrift ist die des Systems, und
  das Formular schickt an die eigene Adresse.
- **Höchstens 15.000 Bytes** (`PAGE_MAX_BYTES` in `lib/haproxy/page-design.ts`,
  für die Fehlerseiten dieselbe Zahl). HAProxy hält die Seite in seinem Puffer
  (`tune.bufsize`, 16.384 Bytes). Gemessen mit 2.4 bis 3.4: ab 15.361 Bytes
  warnt `haproxy -c`, nimmt die Seite aber an, und ab rund 16.160 Bytes
  antwortet HAProxy dem Besucher mit 500. Diese zweite Grenze sieht keine
  Prüfung von HAProxy, deshalb prüft HAPM jede Seite vor dem Speichern selbst.
- **Ein geändertes Design wirkt sofort, eine geänderte Darstellung auch.**
  Speichern schreibt die drei Seiten mit (`page-design-apply.ts`), wenn die
  Konfiguration auf sie verweist, mit Sicherung, `haproxy -c`, Reload und
  Rückstellen bei einem Fehlschlag. Dasselbe tut das Speichern unter
  „Darstellung" und der Start von HAPM (`followPageChanges`, siehe „Nachziehen
  ohne Rückfrage" bei den Fehlerseiten). Die Seiten der Passwortabfrage gehören
  immer HAPM: von Hand geändert werden sie nicht, und jede Abweichung wird
  ersetzt.
- **Die Dateien müssen liegen, bevor `haproxy -c` läuft.** Fehlt eine, lehnt
  HAProxy die ganze Konfiguration ab. `stageAndCheck` stellt sie deshalb vor
  JEDER Prüfung sicher, sobald die Konfiguration darauf verweist, nicht nur beim
  Anlegen einer Sperre: sonst scheiterte ein Jahr später das Ändern einer fremden
  Backend-Adresse daran, dass jemand das Verzeichnis aufgeräumt hat. Verglichen
  wird über die Prüfsumme, geschrieben nur bei einer Abweichung, und zwar im
  gespeicherten Design (`activeDesign`, beim Start aus der Datenbank gelesen).
  So kommt auch eine geänderte Fassung der Seite mit dem nächsten Vorgang an.
  Aufgeräumt wird nicht.

**Geprüft wird gegen ein echtes HAProxy, und zwar mit einem Skript**
(`pnpm haproxy:verify-pages`, braucht Docker). Die Tests halten fest, dass
geschrieben wird, was zurückgelesen wird. Ob HAProxy die Zeilen so versteht, wie
sie gemeint sind, können sie nicht sagen, und dort liegen die Fehler, die
niemand sieht: ein Passwort mit Umlaut, das der Browser anders kodiert, als der
Hash es erwartet, ergibt eine gültige Datei und eine Sperre, durch die niemand
kommt. Das Skript baut dieselbe Konfiguration wie der Betrieb, startet HAProxy
2.4, 2.8 und 3.0 damit und schickt, was ein Browser-Formular schickt. Es prüft
auch die Fehlerseiten (nächster Abschnitt) und liefert ein Design genau an der
Größengrenze aus, einmal mit der Passwortabfrage, einmal mit der 503 als
größter Seite, dazu eigenes HTML genau an der Grenze: alle müssen vollständig
und mit ihrem Status ankommen.
**Wer `passwordLockRules`, `renderErrorFile` oder das Design der Seiten
ändert, lässt es laufen.**

Die Größe der Konfiguration ist keine Grenze: sie geht als Heredoc in EINEM
Kommando an die Shell, und ein einzelnes Argument fasst unter Linux 128 KB (ein
gesperrter Eintrag trägt rund 1,6 KB mehr als ein offener). `lib/ssh.ts` gibt
ein Kommando ab 64 KB deshalb als Datei an `bash` statt als Argument
(`INLINE_LIMIT`).

### Die Fehlerseiten

Was ein Besucher sieht, wenn ein Ziel nicht antwortet (502, 503, 504), eine
Domain unbekannt ist oder die Sperre auf Admin-IPs greift (403). Alles dazu
steht auf EINER Seite, `/reverse-proxy/fehlerseiten`: links das Design, rechts
die Vorschau, darunter welche Fehlerdateien die Konfiguration nennt und ein
Knopf, der sie auf den Stand des gespeicherten Designs bringt
(`lib/haproxy/error-pages.ts`, `ErrorPagesPanel`). Der Aufbau kommt aus
`ui/static/page.ts` (`renderErrorPage`): eine schlichte Kopfleiste mit Logo und
„Zurück“, mittig eine Marke mit dem Code, Überschrift, Satz und Knopf, ohne
Karte. Die Passwortabfrage aus demselben Modul ist dagegen die Anmeldekarte.

**Drei Arten** (`PageDesign.mode`, oben auf der Seite als Karten):

- **Standard** (`standard`, Vorgabe): die Seite von HAPM, mit Logo, Name und
  Akzentfarbe aus der Darstellung, siehe „Die Darstellung". Wählbar ist nur die
  Sprache der Vorgabetexte.
- **Selbst gestalten** (`designed`): dieselbe Seite mit eigenen Farben, Logo,
  Name, Fußzeile und Texten, siehe „Das Design“. Was dort nicht gesetzt ist,
  kommt aus der Darstellung.
- **Eigene HTML-Datei** (`custom`, `lib/haproxy/custom-page.ts`): eine Datei
  für alle Fehlerseiten, unverändert ausgeliefert, ohne Darstellung, siehe
  unten.

Die Felder der anderen Arten bleiben beim Wechsel gespeichert, was gilt, sagt
nur `mode` (`builtInDesign`). Eine Zeile ohne `mode` (von vor der Wahl) ist
`designed`, wenn sie eigene Farben, Logo, Name, Fußzeile oder Texte trägt, sonst
`standard`: beides schreibt dieselben Seiten wie vorher.

**Die Seite von HAPM** steht in der Schrift des Systems (`system-ui`,
`-apple-system`, `Segoe UI`, Roboto, Helvetica, Arial). Eine Webschrift kann sie
nicht laden, und für eine eingebettete fehlt der Platz; die frühere Serif fiel
deshalb fast überall auf Times zurück. **Hell und dunkel** folgt
`prefers-color-scheme`, aber nur ohne eigene Farben: wer Hintergrund, Text oder
Akzent setzt, hat eine Fassung gewählt. In der dunklen Fassung (und auf einem
eigenen dunklen Hintergrund) färbt CSS den Schriftzug des Logos hell. Die
Vorschau zeigt beide Fassungen über `color-scheme` am `iframe`, unabhängig vom
Rechner, an dem jemand HAPM bedient. Mit dieser Fassung haben sich die
Prüfsummen der Fehlerseiten geändert (die der Passwortabfrage nicht). Seitdem
zieht HAPM eine solche Änderung selbst nach, siehe „Nachziehen ohne
Rückfrage“.

**Die Darstellung** (`lib/haproxy/page-brand.ts`, `page-theme.ts`): Logo, Name
und Akzentfarbe unter „System → Darstellung“ gelten auch hier.

- **Wer gewinnt.** „Standard“ nimmt alles aus der Darstellung. Bei „Selbst
  gestalten“ gewinnt, was dort gesetzt ist: eine eigene Akzentfarbe, ein
  eigenes Logo, „Kein Logo“, ein eigener Schriftzug. Steht das Logo auf der
  Vorgabe, heißt der Knopf dafür „Aus der Darstellung“. `designed` ohne eigene
  Werte und `standard` ergeben weiter dieselben Dateien. Die eigene HTML-Datei
  bleibt, wie sie ist; die Passwortabfrage daneben folgt der Darstellung.
- **Ohne Darstellung Byte für Byte wie vorher.** `PageBrand` ist dann `null`,
  und die Prüfsummen in `tests/haproxy/page-design.test.ts` gelten
  unverändert. Eine Pille oder ein Symbol für den Tab allein zählen nicht.
- **Was wohin geht.** Mit Logo: das Logo als Data-URI, der Name als
  Alternativtext, kein Zeichen von HAPM. Ohne Logo, aber mit Name: der Name als
  Text an der Stelle des Logos. Mit einer Farbe allein: das Logo von HAPM in
  dieser Farbe. Die Farbe ist die, die auch die Oberfläche zeigt
  (`readableAccent`, weiße Schrift mindestens 4,5:1). Eine helle Fassung des
  Logos steht nur auf einer Fehlerseite, die hell und dunkel dem System folgt
  (also ohne Akzentfarbe): beide Bilder stehen in der Seite, CSS zeigt eines.
- **Die Größe.** Ein Logo der Darstellung darf 256 KB haben, eine Seite
  15.000 Bytes. `brandLogoFit` misst an den fertigen Seiten, die HAProxy
  bekäme (bei eigener HTML-Datei nur die Passwortabfrage): erst helles und
  dunkles Logo, dann nur das helle, sonst der Name als Text. Das Ergebnis gilt
  für alle Seiten zugleich, ein Logo auf der 503 und ein Name auf der
  Passwortabfrage sähen nach zwei Absendern aus. Die Seite „Fehlerseiten“ sagt
  es in einem Hinweis, statt still etwas wegzulassen, und ein zu großes Logo
  der Darstellung ist kein Grund, ein Design abzulehnen. Verkleinert wird
  nichts. Eine Datei, die allein größer ist als eine Seite, schickt die Route
  gar nicht erst an den Browser (`logoTooLarge`).
- **Woher die Seiten sie kennen.** Wie das Design: `loadPageDesign` liest die
  Darstellung mit und setzt sie für den Prozess (`activeBrand`), die Vorschau
  bekommt sie von `GET /api/haproxy/error-pages/design` und rechnet im Browser
  mit denselben Funktionen.
- **`page-theme.ts` importiert im Kreis** mit `error-pages.ts` und
  `lock-page.ts`: dort wird nach dem Aussehen gefragt, hier an ihren Seiten
  gemessen. Beides sind Funktionen, die erst beim Aufruf laufen. Rechnet eines
  der drei Module beim Laden etwas mit einem anderen aus, bricht das.

**Eigene HTML-Datei** (`custom-page.ts`):

- **Die Datei geht so hinaus, wie sie eingegeben wurde**, für jeden Status
  dieselbe. HAPM setzt nichts ein und legt keinen Rahmen darum: kein Doctype,
  kein Titel, kein `noindex`, keine Platzhalter. CSS gehört in ein `<style>` der
  Datei. Eine erste Fassung trennte HTML (Inhalt von `<body>`) und CSS, legte den
  Rahmen selbst darum und setzte Status und Texte über `{{status}}`, `{{title}}`
  und `{{text}}` ein. Gewünscht war das Gegenteil: wer eigenes HTML hinterlegt,
  will genau diese Datei ausgeliefert sehen. Ein früher gespeichertes `css`
  fällt beim Lesen weg.
- Den Zeichensatz nennt der Kopf der Antwort (`Content-Type: text/html;
  charset=utf-8`), den HAPM vor die Datei schreibt. Umlaute stimmen also auch
  ohne `<meta charset>` in der Datei.
- Gespeichert wird mit LF, ohne Steuerzeichen außer Tab, ohne Leerraum an den
  Enden: ein CR im Rumpf gäbe je nach Weg auf die Platte eine andere Prüfsumme.
- **Die Größe:** dieselbe Grenze wie beim Design, 15.000 Bytes je fertiger
  Datei samt Kopfzeilen (`PAGE_MAX_BYTES`, `designSizeError`). Eine Datei über
  dieser Zahl lehnt schon `parsePageDesign` ab. Abgelehnt wird sonst nur eine
  leere Datei. Formular und Route rufen
  dieselben Funktionen, die Meldung ist dieselbe. Die Route liest höchstens
  128 KB Rumpf.
- Geprüft wird nur, wenn `custom` gewählt ist: eine leere Datei hält das
  Speichern bei einer anderen Art nicht auf.
- Nicht geprüft und nicht verändert wird, was das HTML tut. Ein Skript bleibt
  stehen (wer HAPM bedient, bestimmt ohnehin, was der Proxy ausliefert), ein
  Bild oder eine Schrift von einer anderen Adresse lädt der Browser des
  Besuchers nach. Die Vorschau zeigt die Seite im `sandbox` ohne Skript.
- **Die Passwortabfrage bleibt die von HAPM.** Sie braucht ein Formular, das
  die Regel in `haproxy.cfg` versteht, und eine Vorlage dafür wäre ein zweiter
  Ort, an dem das Feld `LOCK_FIELD` stimmen muss.

**Das Design** (`lib/haproxy/page-design.ts`, gespeichert in der Collection
`page_design`, eine Zeile, samt Art und eigenem HTML) gilt bei „Selbst
gestalten“ für Fehlerseiten und Passwortabfrage zugleich:

- Einstellbar: drei Farben (Akzent, Hintergrund, Text; alles Weitere wie Fläche
  der Karte, Rahmen, gedämpfter Text, Schrift auf dem Knopf wird daraus
  abgeleitet), das Logo (das von HAPM, ein eigenes als SVG, PNG, JPEG oder WebP,
  oder keines), ein Name daneben, eine Fußzeile, je Fall Überschrift und Text,
  bei der Passwortabfrage auch der Knopf. Eine helle und eine dunkle Fassung
  kennen die Seiten nicht: ein dunkles Design ist ein dunkler Hintergrund.
- **Vorgabe heißt: nichts gesetzt, und daraus entsteht Byte für Byte die Seite
  von „Standard“.** `tests/haproxy/page-design.test.ts` hält die Prüfsummen
  fest: ändern sie sich, ist das eine Entscheidung, denn jede Installation sieht
  ihre Dateien danach als „Andere Seite“. Ein Text, der genau der Vorgabe
  entspricht, ist die Vorgabe.
- **Die Datei bleibt die Wahrheit.** Was HAProxy ausliefert, wird bei jedem
  Blick an der Datei abgelesen, nicht an der Zeile. Die Zeile sagt nur, was
  entstehen SOLL: aus einer fertigen Seite ließe sich nicht zurücklesen, welche
  Farbe gewählt war und welcher Text nur die Vorgabe.
- **Speichern heißt ausliefern** (`PUT /api/haproxy/error-pages/design`,
  `page-design-apply.ts`). Erst die Fehlerdateien über `updateErrorPages`, also
  denselben Weg wie der Knopf, dann die Seiten der Passwortabfrage, wenn die
  Konfiguration auf sie verweist. Jeder Teil sichert, prüft, lädt neu und
  stellt bei einem Fehlschlag seine eigenen Dateien zurück. Scheitert das
  Ausliefern, bleibt das Design gespeichert: die Dateien stehen dann wieder wie
  vorher, gelten als „Andere Seite", und der Knopf versucht es erneut. Weichen
  vor dem Speichern Dateien vom gespeicherten Stand ab (eine Seite von Hand),
  fragt die Seite nach, denn sie werden mit ersetzt. „Zurück auf das Design von
  HAPM" ist `DELETE` auf dieselbe Route.
- **Die Vorschau ist das Ergebnis, keine Nachbildung.** Sie rechnet im Browser
  mit denselben Funktionen, mit denen die Route schreibt (`design-pages.ts`), und
  zeigt das Dokument in einem `iframe` mit leerem `sandbox` über `srcDoc`: ohne
  Skript, ohne Formular, ohne Zugriff auf die Sitzung, und das `<style>` der
  Seite färbt die Oberfläche nicht um. Die CSP der Oberfläche musste dafür nicht
  geändert werden (`style-src 'unsafe-inline'` und `img-src data:` gab es schon).
- **Eingaben werden geprüft, nicht gedeutet.** Farben nur als `#rrggbb`, sonst
  geht nichts in das `<style>`. Texte in einer Zeile mit Höchstlänge, maskiert
  beim Schreiben. Das Logo wird am Inhalt erkannt (die ersten Bytes, bei SVG der
  Anfang des Dokuments, ein DOCTYPE mit eigenen Entitäten fällt durch), nicht an
  Endung oder angegebenem Typ, und steht als Data-URI in einem `<img>`: dort
  führt ein SVG kein Skript aus und lädt nichts nach. Ein SVG geht
  prozentkodiert hinein, wenn das kürzer ist als Base64.
- **Die Größe ist die Grenze von HAProxy, nicht unsere.** Jede fertige Seite
  darf samt Logo höchstens 15.000 Bytes haben (`PAGE_MAX_BYTES`, Herleitung im
  Abschnitt zur Passwortsperre und im Kopf von `page-design.ts`). Die Seite
  zeigt die größte Seite gegen diese Zahl, ein zu großes Logo wird beim Wählen
  abgelehnt, und die Meldung nennt, wie groß die Datei mit den jetzigen Texten
  sein darf (`logoByteBudget`). Die Route prüft dasselbe noch einmal. HAPM
  verkleinert kein Bild und installiert dafür nichts: ein Bild, das hier nicht
  passt, wäre nach einer stillen Verkleinerung ein Ergebnis, das niemand
  gesehen hat.
- Der Start (`lib/bootstrap.ts`) liest das Design, bevor er fehlende Dateien
  anlegt, und setzt es für den Prozess (`activeDesign`): daraus entstehen auch
  die Seiten der Passwortsperre bei jedem Schreibvorgang.

- **Geschrieben wird nur, worauf `haproxy.cfg` schon verweist.** Der Knopf
  legt keine Fehlerdatei an und schreibt keine `errorfile`-Zeile. Welche Fehler
  HAProxy mit einer eigenen Seite beantwortet und wo die Dateien liegen,
  ist eine Einrichtung, und die steht in der Datei. Dieselbe Regel wie beim
  Marker der globalen Einstellungen: ohne Zeile wird nichts angeboten.
  Die Einrichtung selbst macht der Start (`lib/bootstrap.ts`): fehlende
  Dateien entstehen unter `/etc/haproxy/errors/<status>.http` (`errorFiles()`),
  und die Grundkonfiguration nennt sie im `defaults`-Block. Vorhandene Dateien
  und eine vorhandene `haproxy.cfg` bleiben dabei unberührt.
- **Der Status kommt aus der DATEI, nicht aus der Zeile.**
  `errorfile 503 /etc/haproxy/errors/404.http` ist kein Tippfehler, sondern ein
  verbreiteter Griff: ein Backend ohne Server antwortet mit 503, und über die
  Fehlerdatei wird daraus die Seite „unbekannte Domain" mit Status 404. Nach der
  Zahl in der Zeile geschrieben würde aus der 404 eine 503. Was eine Datei ist,
  sagt ihre eigene erste Zeile (`HTTP/1.0 404 Not Found`), und der Status bleibt
  beim Neuschreiben derselbe. Eine Datei ohne lesbare Statuszeile bleibt, wie sie
  ist.
- **Nur unter `/etc/haproxy/`** (`isManageableErrorFile`). Der Pfad kommt aus
  einer Datei, die jeder von Hand ändern darf, und geht in ein Kommando, das als root schreibt:
  `errorfile 503 /etc/shadow` darf nicht dazu führen, dass diese Datei
  überschrieben wird. Alles andere wird angezeigt und nicht angefasst, und auch
  nicht gelesen.
- **Die bisherige Seite bleibt liegen.** Vor dem Schreiben entstehen zwei
  Sicherungen daneben: `.hapm-original` genau einmal (die Seite von Hand, sie wird
  von späteren Läufen nicht überschrieben) und `.hapm-previous` bei jedem Lauf (der
  Stand, auf den dieser eine Vorgang zurückstellt).
- **Nach dem Schreiben wird geprüft, und bei einem Fehlschlag zurückgestellt.**
  HAProxy liest die Dateien beim Laden ein. Eine kaputte lässt es die ganze
  Konfiguration ablehnen, und das fiele erst beim nächsten Neustart auf. Also
  `haproxy -c`, dann Reload, und scheitert eines von beiden, kommen alle Dateien
  zurück.
- **Eine Fehlerdatei ist eine rohe HTTP-Antwort mit CRLF, und sie geht als Base64
  ins Kommando.** Ein Heredoc wie bei der Konfiguration verliert die
  Wagenrückläufe (unter Git Bash; verlassen will man sich darauf auf keiner
  Shell). Was dann dasteht, hat eine andere Prüfsumme als das, was hier
  entstand, und gälte bei jedem Blick als „andere Seite".
  `tests/haproxy/error-pages.test.ts` lässt eine echte Bash das nachrechnen.
- **Ohne `Content-Length`.** HAProxy rechnet sie beim Laden aus, und eine
  hingeschriebene Zahl wäre die eine Stelle, an der die Datei nach der nächsten
  Textänderung nicht mehr stimmt.
- **Synchron und nicht als abgekoppelter Lauf**, wie die DNS-Zugangsdaten: kein
  Zertifikat, keine neue Konfiguration. Die Schritte kommen in der Antwort zurück
  und stehen im Audit, in der Historie der Läufe stehen sie nicht.
- **Eine neue Fassung der Seiten zieht HAPM selbst nach**, wenn die Datei von
  HAPM stammt, sonst zeigt sie sich als „Andere Seite" und der Knopf schreibt
  sie neu. Siehe den nächsten Absatz.

**Nachziehen ohne Rückfrage** (`followPageChanges` in `page-design-apply.ts`):
ändert ein Update von HAPM die Standardseite, oder ändert jemand die
Darstellung, schreibt HAPM die Fehlerdateien neu, die es selbst hinterlassen
hat. Ausgelöst beim Start (`lib/bootstrap.ts`, 20 Sekunden danach und ohne den
Start aufzuhalten: beim ersten `compose up` startet HAProxy erst, wenn HAPM
bereit ist) und nach dem Speichern unter „Darstellung“. Ein geändertes Design
braucht das nicht, sein Speichern schreibt ohnehin alles und fragt vorher.

- **Was HAPM hinterlassen hat, steht in der Collection `page_files`**
  (`page-files.ts`): je Pfad die Prüfsumme des zuletzt Geschriebenen, vermerkt
  nach jedem erfolgreichen Schreiben (nach `haproxy -c` und Reload) und beim
  ersten Anlegen. Ein gescheiterter Vorgang stellt die Dateien zurück und
  vermerkt nichts.
- **Die Regel** (`isOwnErrorFile`): gibt es einen Eintrag, wird die Datei nur
  geschrieben, wenn sie ihm genau entspricht. Jede Abweichung hat jemand anderes
  geschrieben, und eine Seite von Hand wird nicht ohne Rückfrage ersetzt. Ohne
  Eintrag (eine Installation von vor dieser Fassung) nur, wenn die Datei Byte
  für Byte eine Standardseite einer früheren oder der jetzigen Fassung ist
  (`page-history.ts`, de und en, gerechnet über jeden Commit: es gab zwei
  frühere Fassungen). Dateien aus einem früheren „Selbst gestalten“ ohne
  Eintrag kennt HAPM nicht und lässt sie stehen.
- **Warum das sicher ist.** Ersetzt wird nur, was nachweislich von HAPM stammt
  und seitdem niemand angefasst hat: dieselbe Prüfsumme wie beim Schreiben, oder
  eine Seite, die HAPM selbst so ausgeliefert hat. Was dabei verloren gehen
  kann, ist also nur eine ältere Fassung von HAPM. Der Weg ist derselbe wie
  beim Knopf: nur unter `/etc/haproxy/`, Sicherung `.hapm-previous` und
  `.hapm-original`, `haproxy -c`, Reload, bei einem Fehlschlag alles zurück.
  Läuft HAProxy beim Start noch nicht, scheitert der Reload, die Dateien
  stehen wie vorher, und der nächste Start versucht es wieder. Die eigene
  HTML-Datei ändert sich mit der Darstellung nicht und gilt deshalb gar nicht
  erst als abweichend.
- **Protokoll.** Was geschrieben wurde und was als Seite von Hand stehen
  blieb, steht im Log (`[fehlerseiten]`) und im Audit (`haproxy_error_pages_updated`
  bzw. `…_failed`, beim Start als `scheduler`, nach der Darstellung als der
  Benutzer, der gespeichert hat). Hat sich nichts geändert, steht nichts im
  Audit.
- **Ändert sich die Standardseite**, kommen ihre neuen Prüfsummen nach
  `page-history.ts`, die alten bleiben. `tests/haproxy/page-files.test.ts`
  scheitert, solange die jetzige Seite dort fehlt.
- **Die 404 heißt hier anders als im Baustein `ui/static/page.ts`.** Auf dem Proxy meint sie die ganze
  Domain („Unter dieser Adresse ist nichts eingerichtet"), und „Zur Startseite"
  führte auf dieselbe Seite.

### Die Statistik: `/reverse-proxy/statistiken`

Was über HAProxy läuft, und wer zugreift. Zwei Fragen, **zwei Quellen**,
und daran hängt der ganze Aufbau der Seite.

**Die Zahlen kommen aus HAProxy selbst.** `show stat` über denselben
Stats-Socket, aus dem schon die Healthcheck-Marke kommt, liefert je Abschnitt
Anfragen, Statusklassen, übertragene Bytes, Antwortzeiten, Fehler,
Wiederholungen und die gleichzeitigen Sitzungen. Nichts davon wird geschätzt und
nichts aus einem Log gezählt.

**Das ist die zweite Stelle, die diese CSV liest**, und beide sind absichtlich
verschieden breit: `parseStatsCsv` (`config.ts`) liest nur `status` je Server,
und `parseStatRows`
(`lib/haproxy/stats-parse.ts`) beide Sammelzeilen mit allem, was hier gebraucht
wird. Was sie teilen, ist die
eine Regel, die zählt: **die Spalten werden über
die Kopfzeile gefunden und nie über ihre Nummer.** HAProxy hängt zwischen den
Versionen Spalten an — eine feste Nummer läse auf der neueren Version eine andere
Zahl und meldete sie als Antwortzeit, und das fiele nie auf, weil eine plausible
Zahl herauskommt.

- **Es gibt eine Zeitreihe, weil `show stat` keine hat.** Die Ausgabe kennt nur
  Zähler seit dem Start des Prozesses. Ein Wert für ein Fenster ist die
  Differenz zweier Stände, und die müssen irgendwo stehen — sonst wäre jedes
  Öffnen der Seite ein Blick auf einen einzigen Punkt. Also `haproxy_metrics`,
  eine Runde **jede Minute** am Scheduler (`lib/scheduler.ts`). Für fünf Minuten
  spräche, ein Anfragenaufkommen sei eine Summe und
  verliere beim Zusammenfassen nichts. Das gilt für die Summe und nicht für die
  Form: eine Lastspitze über drei Minuten ist in einem Fünf-Minuten-Fenster kein
  Ausschlag mehr, sondern ein etwas höherer Wert. Der Preis dafür steht in der
  Aufbewahrung — vierzehn Tage
  (`HAPROXY_METRICS_RETENTION_DAYS`), weil es fünfmal so viele Zeilen sind.
- **Der Socket-Pfad wird gemerkt.** Er steht in `haproxy.cfg` und wird von dort
  gelesen und nicht geraten — nur nicht jedes Mal: die ganze Konfiguration im
  Minutentakt zu lesen wäre der teuerste Teil einer Runde, für eine Zeile, die
  sich praktisch nie ändert. Die
  Selbstheilung steckt in der Bedingung: liefert `show stat`
  über den gemerkten Pfad nichts, wird die Datei neu gelesen, und ein umgezogener
  Socket findet sich in der nächsten Runde von selbst.
- **Der Takt steht in `stats-series.ts` und nicht bei der Erfassung.** Die
  Live-Kennzahlen im Browser rechnen damit (`stats-live.ts`: Takt des Pollens,
  ab wann eine Runde veraltet ist); `stats-collect.ts` zieht über
  `lib/db` und `lib/ssh` Node-Module hinter sich her (`postgres`,
  `node:child_process`), und ein
  Import von dort in eine Client-Komponente fällt erst im Build auf.
  `stats-collect.ts` reicht die Konstante weiter, damit
  der Scheduler sie dort findet, wo der Rest seiner Erfassung steht.
- **Die erste Probe liefert `null` und nicht 0.** Sie hat keine Vorgängerin. Ein
  Balken der Höhe null behauptet „in diesem Fenster kam keine einzige
  Anfrage" — die Wahrheit ist „wir wissen es nicht". Dieselbe Regel bei einer zu
  großen Lücke (`MAX_GAP_MS`): eine saubere Summe über eine Auszeit von zwei
  Stunden, gezeichnet als EIN Punkt, wäre eine Spitze, die es nie
  gab.
- **Ein Reload wird an der LAUFZEIT erkannt und nicht am Rücksprung**
  (`StatSnapshot.uptimeSec`). Der Rücksprung ist der offensichtliche Fall und
  nicht der gefährliche: wird zwischen zwei Proben neu geladen und kommen danach
  mehr Anfragen als vorher gezählt waren, steigt der Zähler, die Differenz sieht
  plausibel aus und vergleicht trotzdem zwei verschiedene Prozesse. `Uptime_sec`
  aus `show info` verrät beides. Beide Abfragen gehen deshalb in **einem**
  Kommando über den
  Socket: zwischen zwei Kommandos läge ein Reload, nach dem die Laufzeit nicht
  mehr zu den Zählern passt.
- **Die Übersicht summiert die FRONTENDS, nicht die Backends.** Die Backends
  aufzuaddieren wäre falsch: eine Anfrage über eine Pfad-Regel zählt in deren
  eigenem Backend mit, und was das Frontend abweist, erreicht überhaupt keins.
  Umgekehrt liest der Drilldown auf einen Dienst ausdrücklich die
  BACKEND-Zeile — ein `listen`-Abschnitt (die TCP-Weiterleitungen) taucht unter
  EINEM Namen mit beiden Sammelzeilen auf, und ohne die Einschränkung käme jede
  seiner Sitzungen doppelt in die Summe.
- **Vier Spalten gibt es nur in einer BACKEND-Zeile**, und das ist die Falle
  daran: `qtime`, `ctime`, `rtime` und `ttime` stehen in einer FRONTEND-Zeile
  **leer**, ebenso `wretr`/`wredis`. Ein Frontend hat kein Ziel, also misst es
  keine Antwortzeit und wiederholt nichts. Die Übersicht liest aber die
  Frontends — ohne Weiteres blieben Antwortzeiten und Wiederholungen dort für
  immer leer, mit „keine Messwerte" darunter, was sich wie ein Fehler liest und
  keiner ist. `foldInBackends` trägt deshalb genau diese Felder aus den Backends
  nach; die Flussgrößen bleiben beim Frontend. `denied` und `errors` werden
  **addiert** statt ersetzt: `dreq`/`ereq` fallen an der Eingangsseite an,
  `dresp`/`econ`/`eresp` an der Zielseite, das sind verschiedene Ereignisse.
- **Das Backend zum CrowdSec-Bouncer (`hapm_crowdsec_spoa`) zählt nicht**
  (`trafficRows` in `stats-collect.ts`, beim Sammeln, in den Sekundenwerten und
  beim Lesen). Es ist TCP, jede Rückfrage von HAProxy ist eine Sitzung, also
  etwa eine je geprüfter Anfrage: in der Liste der Dienste stand es mit den
  meisten „Anfragen“, und seine Verbindungszeiten gingen über `foldInBackends`
  in die Antwortzeiten ein. Ein Ziel ist es nicht.
- **Drei Arten, ein Fenster zusammenzufassen, und der Mittelwert über alle
  Zeilen ist keine davon.** In einem Rasterfenster liegen mehrere Zeitpunkte
  *und* mehrere Abschnitte. Mengen (Anfragen, Bytes) werden über beides
  addiert. Momentanwerte (gleichzeitige Sitzungen) werden über die Abschnitte
  eines Zeitpunkts **addiert** und über die Zeitpunkte **gemittelt** — sonst
  wäre eine Stunde mit zwölf Proben zwölfmal so voll wie eine mit einer. Und
  HAProxys Mittelwerte werden mit den Anfragen der Zeile **gewichtet**:
  ungewichtet zöge ein Dienst mit drei Anfragen und 900 ms die Kurve so weit
  hoch wie einer mit zehntausend und 40 ms. Gerechnet wird das in
  `lib/haproxy/stats-series.ts` und nicht in der Route, damit es prüfbar ist.
- **Die erste Probe sieht aus wie ein Defekt und ist keiner.** Sie ist ein
  Zählerstand ohne Vorgängerin: die Momentanwerte stehen da, jede Differenz
  fehlt. Die Seite sagt das als eigene Fläche, solange weniger als zwei
  Rasterpunkte vorliegen (`samples`) — ohne den Satz stehen fünf Diagramme auf
  „keine Messwerte", und das liest niemand als „warte ein paar Minuten".
- **Gezeichnet werden Linien mit einer ungestapelten Fläche darunter**
  (`components/systems/MetricChart.tsx`, `area` ohne `stacked`). Zwei naheliegende
  Alternativen sind begründet und trotzdem falsch. Balken, mit dem Argument:
  ein Punkt ist die Summe über ein Fenster, eine Linie dazwischen behauptet
  einen Zwischenwert, den es nicht gibt. Nur teilt Recharts die Zeichenfläche
  unter den vorhandenen Punkten auf, und eine frische Zeitreihe mit drei Punkten
  wird damit zu Farbflächen über die halbe Kachel. Und ein
  Stapel für die Statusklassen, wegen der Zusammensetzung auf einen Blick — nur
  ist ein gestapeltes Band in `MetricChart` **deckend**, und damit stünde eine
  massive Farbfläche neben vier Diagrammen mit feinen Linien. Der Preis der
  Linien ist ehrlich: das Gesamtaufkommen ist nicht die Höhe eines Bandes, es
  steht als Kennzahl darüber.
  Die Fläche darunter ist kein Rückfall in den Stapel: ungestapelt zeichnet
  `TimeSeriesChart` je Reihe einen eigenen Verlauf, der nach unten ausläuft
  (bei drei und mehr Reihen oben 18 % Deckkraft). Die Flächen überlagern sich
  durchscheinend, keine trägt eine andere. Deckend ist nur `stacked`, und das
  bleibt draußen. Ohne `area` füllte `TimeSeriesChart` nur bis drei Reihen,
  „Anfragen nach Statusklasse" mit fünf stand deshalb als einziges Diagramm
  ohne Fläche da.
- **Die Live-Kennzahlen** (`components/reverse-proxy/LiveTraffic.tsx`) stehen
  oben auf der Übersicht und auf dieser Seite, eine Komponente für beide:
  Anfragen und Datenrate pro Sekunde, Antwortzeit der Ziele, offene
  Verbindungen, Anteil 5xx und 4xx, je mit der letzten halben Stunde als
  Verlaufslinie (`ui/charts/Sparkline.tsx`). Zwei Quellen: die **Zahlen** sind
  Sekundenwerte (nächster Punkt), die **Linien** und der Rückfall kommen aus
  `/api/haproxy/stats/live`, das dieselbe Tabelle wie die Zeitreihe liest und
  HAProxy nicht fragt. Die Route wird alle 15 s gepollt (`LIVE_POLL_MS`), damit
  eine neue Runde des Sammlers höchstens so spät erscheint.
  - **Gerechnet wird nach Runden, nicht nach Raster** (`lib/haproxy/stats-live.ts`).
    Eine Runde schreibt alle Zeilen mit demselben `collectedAt`, ihre
    Differenzen gelten seit der vorigen Runde, also ist deren Abstand das
    Fenster der Rate. Im Minutenraster lägen bei wanderndem Takt zwei Runden
    in einem Fenster, und die Rate verdoppelte sich für einen Punkt.
  - Fehlt einer Runde die Differenz (Reload), steht die Zahl der vorigen da,
    solange sie jünger als drei Takte ist. Ist die letzte Runde älter
    (`LIVE_STALE_MS`), stehen Striche: eine eingefrorene Rate sähe aus wie
    ruhiger Betrieb. Die Fehlerquote gilt für fünf Minuten, ohne Anfragen gibt
    es keine (Strich, nicht 0 %).
  - Im Drilldown (`?scope=`) alles aus der Backend-Zeile des Dienstes, sonst
    wie oben Flussgrößen aus den Frontends, Antwortzeit aus den Backends.
  - „Ziele erreichbar" ist keine Live-Kachel: der Zustand kommt aus
    `probeProxy` (Konfiguration und Socket) und steht auf der Übersicht als
    Kachel „Backend nicht erreichbar" darunter, im Takt der Übersicht.
- **Die Sekundenwerte** (`lib/haproxy/stats-sampler.ts`, gerechnet in
  `stats-seconds.ts`, Route `/api/haproxy/stats/live/now`). Mit nur dem
  Minutensammler war die Zahl auf einer Kachel, die „Live" heißt, bis zu einer
  Minute alt.
  - **Nachfragegetrieben.** Jede Abfrage der Kacheln (alle 2 s,
    `SECONDS_POLL_MS`) hält den Sampler am Leben, er liest HAProxy dann jede
    Sekunde (`SECONDS_SAMPLE_MS`). Kommt 30 s keine Abfrage (`SECONDS_IDLE_MS`),
    hört er auf. Ohne offene Seite bleibt es bei einer Abfrage je Minute.
    Versteckte Tabs fragen nicht (`usePolling`).
  - **Eine Schleife je Prozess, auf `globalThis`.** Fünf offene Tabs lesen
    denselben Puffer, HAProxy wird trotzdem einmal je Sekunde gefragt. Die
    Schleife wartet jede Probe ab, bevor sie die nächste plant: zwei Abfragen
    des Samplers am Socket gleichzeitig gibt es nicht. Die Runde des
    Minutensammlers kann daneben laufen, sie ist eine eigene Verbindung und
    stört nicht.
  - **`node:net` statt `socat`.** Der Stats-Socket liegt im geteilten Volume
    `/run/haproxy`, HAPM erreicht ihn direkt wie `hapm-ctl` den Master-Socket
    (`stats-socket.ts`). `show info;show stat` geht in **einer** Verbindung,
    damit zwischen Laufzeit und Zählern kein Reload liegt. Gemessen gegen
    HAProxy 3.0 mit 80 Abschnitten (40 Frontends, 40 Backends, 33 KB
    Antwort): **2,3 ms** je Probe im Median, rund 1 ms CPU in Node. Der Weg
    des Minutensammlers (bash, zweimal `socat`) braucht 9 ms und drei
    Prozesse; im Minutentakt egal, im Sekundentakt der größte Posten. Eine
    dauerhaft offene Verbindung (`prompt`) spart daneben nichts Messbares und
    hinge nach einem Reload am alten Prozess. Der Pfad kommt vom
    Minutensammler (`rememberedStatsSocket`) oder aus `haproxy.cfg`, gelesen
    höchstens alle 30 s, solange er fehlt; nach einem Fehlschlag wartet der
    Sampler 5 s.
  - **Nur im Speicher.** Die Proben bleiben fünf Minuten
    (`SECONDS_BUFFER_MS`, genau das Fenster der Fehlerquote) und gehen nicht
    nach `haproxy_metrics`. Die Zeitreihe bleibt beim Minutensammler: 86 400
    Zeilen je Abschnitt und Tag wären eine Tabelle für niemanden.
  - **Gerechnet aus Zählerständen, nicht aus Differenzen je Probe.** Eine
    Probe hält die rohen Zähler, jedes Fenster ist die Differenz zweier
    beliebiger Proben, und eine Pause des Samplers ändert an der Summe nichts.
    Ungültig macht sie nur ein Neustart von HAProxy dazwischen, und der wird
    strenger geprüft als beim Minutensammler: die Laufzeit muss mindestens um
    die vergangene Zeit gewachsen sein (`sameProcess`). Nach einer Pause von
    fünf Minuten kann ein neuer Prozess schon länger laufen, als der alte bei
    der vorigen Probe lief, und „Laufzeit gesunken" sähe das nicht.
  - **Raten über 5 s** (`SECONDS_RATE_MS`), geteilt durch den echten Abstand
    der Proben. Eine einzelne Sekunde springt bei wenig Verkehr zwischen 0 und
    2 Anfragen, die Ziffern flackerten. Eine 0 ist hier eine Messung („keine
    Anfrage in fünf Sekunden") und wird angezeigt.
  - **Die Antwortzeit** gewichtet mit den Anfragen über die ganze Spanne der
    Proben, nicht über 5 s: in 5 s antwortet bei wenig Verkehr kein Ziel, und
    die Zahl fiele dauernd zurück.
  - **Die Fehlerquote** erst, wenn die Proben die fünf Minuten der Beschriftung
    abdecken. Vorher wäre eine 503 unter zwanzig Anfragen fünf Prozent; bis
    dahin steht die Quote aus den Minutenrunden da.
  - **Rückfall je Kennzahl** (`mergeLive`): Sekundenwert, sonst der aus der
    letzten Minutenrunde, sonst Strich. Ohne Socket zeigen die Kacheln genau
    das, was sie vor den Sekundenwerten zeigten. Ist die letzte Probe älter
    als 10 s (`SECONDS_STALE_MS`), gilt sie nicht mehr. Der Kopf sagt, welche
    Quelle gerade steht („Sekundenwerte, Stand …" gegen „Messung von …").
  - **Die Linien bleiben bei den Minutenrunden über 30 Minuten**, nicht beim
    Puffer. Eine Linie aus Sekundenwerten wäre bei wenig Verkehr ein Kamm aus
    Ausschlägen, finge nach jeder Pause leer an und reichte nur fünf Minuten
    zurück. Die halbe Stunde zeigt, ob gerade mehr los ist als vorhin, und
    das ist die Frage, die eine Linie neben einer Zahl beantworten soll.
  - Im Drilldown dieselbe Regel wie oben: alles aus der Backend-Zeile des
    Dienstes, nie aus dem gleichnamigen Frontend eines `listen`-Abschnitts.
- **Nachladen ist leise.** Die Zeitreihe hat keinen eigenen Takt mehr:
  `LiveTraffic` meldet eine neue Runde (`onRound`), und erst dann lädt die
  Seite sie nach. Ein Zeitraum von dreißig Tagen wird so einmal je Minute
  gelesen und nicht alle fünfzehn Sekunden. Das Access-Log wertet die Seite
  alle zwei Minuten neu aus (`TRAFFIC_POLL_MS`), nie zwei Läufe zugleich, ohne
  Platzhalter; ein leiser Fehlschlag lässt die letzte Auswertung mit ihrem
  Zeitstempel stehen. Platzhalter gibt es nur nach einer Handlung (Zeitraum,
  Dienst, Knopf).

**Der Weg zu einem einzelnen Dienst geht auf drei Arten**, und das ist Absicht:
über die Dienstliste unten, über die Auswahl oben rechts (die auch im Drilldown
noch alle Dienste kennt — deshalb liest die Route die Backend-Zeilen dort
ungefiltert) und über den Statistik-Knopf auf der Zielkarte. Der trägt
`?dienst=<id>`, denselben Parameter, mit dem auch die Zertifikatsseite auf einen
Eintrag zeigt; die Adresse wandert beim Wechseln mit (`replace`, nicht `push` —
wer durch fünf Dienste klickt, will danach mit einem Schritt heraus).

**Pfade und die Log-Zahlen je Dienst gibt es nur im Drilldown.** Über alle
Dienste zusammen ist eine Pfad-Rangliste keine Auskunft: `/` steht dann für
dreißig verschiedene Websites. Erst innerhalb eines Dienstes gehören die Pfade
zueinander. Dasselbe für die Zahlen aus dem Log — welcher Dienst wie viel hatte,
sagt in der Übersicht schon die Dienstliste aus der Zeitreihe, und zwei Listen
derselben Sache aus zwei Quellen nebeneinander sind vor allem eine Frage danach,
welche denn nun stimmt.
- **Verdichtet wird in der Route und nicht im Browser.** Vierzehn Tage im
  Minutentakt sind 20 160 Punkte je Reihe für ein Diagramm, das 900 Pixel
  breit ist. Summen werden dabei **summiert**, Mittelwerte **gemittelt**: die
  Antwortzeit einer Stunde ist nicht die Summe von zwölf Antwortzeiten.

**Die Adressen kommen aus dem Access-Log**, und nur von dort. HAProxy führt über
Herkunft, Land und Pfad keine Zähler; das steht ausschließlich in den Zeilen, die
`option httplog` schreibt. Also `lib/haproxy/access-log.ts`.

- **Die Datei ist ein Mitschnitt** (`lib/haproxy-log.ts`). HAProxy
  schreibt im Container auf stdout (`log stdout format raw local0 info` in der
  Grundkonfiguration), also ins Log von Docker. Der Mitschnitt folgt diesem Log
  und schreibt es nach `/var/log/haproxy/haproxy.log`; ab 256 MB wird die Datei
  beiseitegelegt (`.1`, eine Vorgängerin bleibt). Nach einem Neustart von HAPM
  geht es beim Zeitstempel der letzten Zeile weiter.
- **Gerechnet wird mit `awk` und nicht im Node-Prozess.** Ein Proxy mit ein
  paar Seiten
  schreibt am Tag Millionen Zeilen — sie in den Prozess zu lesen wären Hunderte
  Megabyte für ein Ergebnis von zwei Kilobyte. Ein `awk` liefert die
  fertigen Summen, dieselbe Überlegung wie bei `ss -Hltn` in
  `streams.ts`.
- **Das Fenster ist ein `tail -n` und kein Datum.** Nur so steht vorher fest, was
  ein Lauf kostet; ein Filter „seit gestern" liest die Datei trotzdem ganz. Der
  Preis ist, dass das Fenster nicht rund ist — und **deshalb sagt das Ergebnis,
  welchen Zeitraum es tatsächlich abdeckt**, statt eine Überschrift zu tragen,
  die es nicht einlöst.
- **Die Felder werden gesucht, nicht gezählt.** Vor der eigentlichen Zeile steht
  ein syslog-Kopf, und der ist nicht überall gleich lang. Gesucht wird das Feld,
  das mit `[` anfängt — das Annahmedatum, das es in jeder Fassung genau einmal
  gibt; alles andere hat einen festen Abstand dazu.
- **Die Adresse wird von RECHTS getrennt.** HAProxy schreibt `%ci:%cp`, und bei
  IPv6 ist das `2001:db8::1:54321`: die Adresse enthält selbst Doppelpunkte. Von
  links getrennt käme `2001` heraus — eine Adresse, die es gibt, und damit ein
  Land, das nicht stimmt.
- **Sortiert wird mit `sort` und nicht in awk.** `asort` gibt es nur in gawk, auf
  Debian ist `awk` ein mawk. Ein Programm, das je nach installiertem `awk` still
  nichts liefert, ist keine Auswertung. `tests/haproxy/access-log.test.ts` lässt
  eine echte Bash das Kommando über eine Fixture laufen.
- **Ein Dienst-Filter grenzt ALLES ein**, nicht nur die Anzeige: er geht als
  `-v only=` in awk, und damit sind auch die eindeutigen Adressen und die Länder
  die dieses Dienstes. Er geht als awk-**Variable** und nie in den Programmtext —
  zusammengesetzt wäre er ein Stück awk, das jemand anderes geschrieben hat.
- **Kein Log gefunden heißt unbekannt, nicht „kein Verkehr".** Die Seite sagt
  dann, dass kein Log gefunden wurde, und die Zahlen aus `show stat`
  stehen unverändert daneben. Der Pfad kommt aus einer festen Liste
  (`LOG_CANDIDATES`) und nie aus einer Eingabe: er geht in ein Kommando, das als
  root läuft.
- **Sie wird NICHT gepollt.** Ein Lauf liest in der Vorgabe 200 000 Zeilen
  (`DEFAULT_LINE_LIMIT`, höchstens zwei Millionen) —
  das ist eine Handlung und kein Hintergrundtakt. Deshalb hat der Block seinen
  eigenen Knopf und seinen eigenen Zeitstempel, während die Zeitreihe darüber im
  Minutentakt nachlädt.

**Die Länder rechnet HAPM im eigenen Prozess und kein Dritter.**
`lib/geoip/` trägt eine Adressbereich-Tabelle, die im Prozess nachgeschlagen
wird. Der naheliegende Weg wäre ein Aufruf gegen einen Dienst wie ip-api.com;
dagegen spricht, was dabei abfließt: die Client-Adressen der
Besucher, einzeln und zeitgestempelt, an einen Dritten.

- **Nur die Bereichs-ANFÄNGE werden gespeichert**, und das ist exakt und keine
  Näherung: der Datensatz kachelt den Adressraum lückenlos. Findet die
  Übersetzung doch eine Lücke, schreibt sie an deren Anfang einen ausdrücklichen
  Unbekannt-Eintrag — ohne den liefe dort das Land des Bereichs davor weiter, und
  eine falsche Flagge ist schlimmer als ein Strich.
- **IPv6 wird auf 64 Bit gekürzt.** Volle Anfänge wären 5,6 MB allein für die
  Adressen; Länder werden nicht feiner als ein /64 vergeben (59 von 348 330
  Bereichen liegen darunter). Mit Delta und Varint sind es am Ende 773 KB im
  Repository statt 9,3 MB.
- **HAPM holt sich die Tabelle selbst** (`lib/geoip/fetch.ts`). Ein Upload von
  Hand, jeden Monat, ist genau die Sorte Aufgabe, die unterbleibt. Der Scheduler ruft `maybeRefreshGeoip()` kurz nach dem
  Start und einmal am Tag. Es tut nichts, wenn das Holen abgeschaltet ist, wenn
  die Tabelle vom laufenden Monat ist oder wenn der letzte Versuch keinen Tag
  her ist (23 Stunden 50 Minuten: bei genau 24 fiele der tägliche Aufruf zur
  selben Minute mal in die Sperre und mal nicht). Geholt wird die Datei des
  laufenden Monats; gibt es sie noch nicht (404, DB-IP stellt sie am
  Monatsanfang ein), die des Vormonats.
  Eine neuere Tabelle wird nie durch eine ältere ersetzt. „Jetzt erneuern" unter
  „Reverse-Proxy → Einstellungen" ist derselbe Abruf ohne die Sperre
  (`POST /api/geoip/refresh`).
- **Nach außen geht dabei eine Anfrage nach einer Datei, deren Name nur den
  Monat nennt.** Keine Besucheradresse, keine Domain. Geladen wird nur über
  https und nur von db-ip.com: Weiterleitungen werden von Hand verfolgt und auf
  einen fremden Host nicht befolgt, es gibt eine Zeitgrenze (zwei Minuten) und
  eine Größengrenze (32 MB, gezählt und nicht dem Kopf geglaubt). Das Holen
  lässt sich abschalten (Schalter „Selbsttätig erneuern", Vorgabe an).
- **Schalter und letzter Versuch stehen an der Zeile der Tabelle**
  (`autoRefresh`, `lastAttemptAt`, `lastAttemptError` in `geoip_table`), nicht in
  den Einstellungen: sie gehören zu dieser einen Sache. Der letzte Versuch wird
  zusätzlich im Prozess gemerkt, damit die Sperre auch hält, wenn das
  Schreiben scheitert. Dauerhaft steht er, damit ein Container, der in einer
  Schleife neu startet, db-ip.com nicht bei jedem Start anfragt.
- **Eine geholte oder hochgeladene Fassung gewinnt, und sie liegt in der
  Datenbank** (Collection `geoip_table`, also im Volume von Postgres).
  Nicht als Datei neben dem Build: ein neues Abbild ersetzt das
  Dateisystem des Containers, und die Datei wäre danach **still** weg, mit einer
  Zuordnung, die wieder auf den Stand des Repositories zurückfällt.
- **Der Upload von Hand bleibt als Nebenweg** für Server ohne Zugang nach außen.
  Abruf und Upload gehen durch dieselbe Funktion (`lib/geoip/import.ts`), mit
  denselben Grenzen und derselben Prüfung, ob aus der Datei überhaupt Bereiche
  wurden.
- **Der Stand kommt aus dem Dateinamen und nie aus dem Hochladedatum.** DB-IP
  schreibt den Monat nur dorthin, in der CSV selbst steht er nicht. Wer eine ein
  Jahr alte Datei von heute hochlädt, hätte sonst einen grünen Haken ohne
  Deckung. Fehlt der Monat, wird abgelehnt. Beim eigenen Abruf ist es der Monat,
  nach dem gefragt wurde.
- **Der Hinweis (`components/GeoipReminder.tsx`) gehört über die ÜBERSICHT
  (`/dashboard`) und nicht auf diese Seite.** Hier sähe
  man ihn erst, wenn man die Zahlen schon liest — also zu spät, um ihnen nicht zu
  glauben. Er ist nicht wegklickbar. Weil HAPM selbst holt, ist „alt" allein
  kein Anlass: er steht nur, wenn die Tabelle alt ist UND das Holen
  abgeschaltet ist oder der letzte Versuch scheiterte, und er nennt diesen
  Grund. `pnpm geoip:build` ist der Weg, mit dem der Ausgangsstand im
  Repository selbst erneuert wird.
- **Die Länderverteilung nennt ihre Abdeckung.** Aus dem Log kommen die
  häufigsten 3000 Adressen zurück, nicht alle — welcher Anteil der Anfragen
  darin steckt, steht neben dem Diagramm. Ohne die Zahl behauptete die Verteilung
  eine Vollständigkeit, die sie nicht hat. An den Browser gehen davon fünfzig:
  eine vollständige Liste der Besucheradressen muss nicht in
  einem Tab liegen, damit ein Balkendiagramm daraus wird.

### Der Vorgang läuft abgekoppelt

Anlegen, Ändern und Löschen dauern Minuten: Zertifikat, `haproxy -c`, Reload.
Ein Dialog, der so lange auf die Antwort wartet, hängt genau diese Zeit an einem
Spinner, und ein Reload der Seite hieße, das Ergebnis nie zu sehen. Deshalb ist
es ein abgekoppelter Lauf wie
die Updates (`lib/updates/apply.ts`), mit allem, was dazu
gehört (siehe [`betrieb.md`](betrieb.md)): eine Zeile in `haproxy_runs`, ein Eintrag in
`/api/activity`, ein Abgleich beim Start (`lib/haproxy/reconcile.ts`).

- **Die Zeile ist keine Spiegelung, sondern Historie.** Die Wahrheit über den
  Ist-Zustand bleibt `haproxy.cfg`; die Zeilen sagen, wer wann was verändert hat,
  und das steht sonst nirgends. Deshalb tragen sie Domains und Ziele
  **denormalisiert** mit: nach dem Löschen gibt es nichts mehr, woraus sie sich
  lesen ließen.
- **Der Abgleich beim Start braucht keine Rückfrage.** Der Vorgang läuft IN
  HAPM, es gibt kein Skript, das den Prozess überlebt: eine
  `running`-Zeile beim Start ist tot. Zurückgerollt wird trotzdem
  nichts — was durchkam, sagt der letzte Schritt, und ein Rollback auf Verdacht
  nimmt auf einem Reverse-Proxy fremde Domains offline.
- **Die Schritte werden nach jedem Schritt geschrieben, nicht am Ende**
  (`ProvisionReporter`). Sonst stünde in der Pille minutenlang „läuft" und danach
  das fertige Ergebnis — ein Fortschritt, der erst am Schluss erscheint, ist
  keiner. Und der abgebrochene Lauf hätte nichts, woran man sähe, wie weit er kam.
- **Was sich ohne Schreiben prüfen lässt, bleibt synchron** (`precheck*`):
  belegte Dienst-ID, fremde Domain, nicht bearbeitbarer Eintrag, fehlendes
  acme.sh. Ein Formular, das sich schließt und eine Minute später in der
  Historie „Dienst-ID bereits vergeben" hinterlässt, hat die Eingabe weggeworfen,
  statt sie zu bemängeln. Der Preis ist eine zweite Probe je Vorgang: der
  Lauf probt innerhalb des Locks noch einmal, weil die Antwort auf „ist die
  Domain frei" nicht aus einer Momentaufnahme von vorhin kommen darf.
- **Beim Start geht das Fenster des Laufs auf** (`components/runs/`, für alle
  Läufe dasselbe, siehe `docs/betrieb.md`, „Läufe im Hintergrund“). Früher kam
  nur ein Toast „… läuft“ mit einem Knopf zu den Schritten; jetzt ist der
  Fortschritt sofort zu sehen, und „Im Hintergrund weiterlaufen lassen“ gibt
  ihn an die Pille unten rechts ab. Die Platzhalterkarte zeigt nur noch die
  Phase als Marke, keine Schritte: ein zweiter Fortschritt in der Liste wäre
  derselbe Kasten, den das Fenster ersetzt.
- **Die Seite verfolgt ihre eigenen Vorgänge**, um in dem Moment
  nachzuladen, in dem einer fertig ist. Ohne das stünde die neue Domain bis zum
  nächsten Takt nicht in der Liste, und das sieht aus, als wäre nichts
  passiert.
- **Es sind mehrere, nicht einer** (`components/reverse-proxy/pendingRuns.ts`,
  getestet in `tests/haproxy/pending-runs.test.ts`). Die Gruppenseite hielt
  einmal ein einzelnes Feld für den laufenden Vorgang: wer drei Ziele kurz
  nacheinander anlegte, sah oben eine Platzhalterkarte statt drei, und nur der
  zuletzt gestartete Lauf bekam seine Meldung. Jetzt gilt: je laufendem Anlegen
  eine Platzhalterkarte, ein Intervall fragt alle Läufe ab, jeder fertige
  bekommt seinen eigenen Toast. Der Platzhalter verschwindet erst nach dem
  Nachladen, sonst stünde der Eintrag ein bis drei Sekunden lang weder als
  Platzhalter noch als Karte da. Steht die ID schon in der gelesenen
  Konfiguration, während der Lauf noch läuft, trägt die echte Karte den Lauf
  und der Platzhalter fällt weg, damit nichts doppelt dasteht.
- **Ein wartender Vorgang sagt, dass er wartet.** Alle Vorgänge am Proxy gehen
  durch einen Lock (`withProxyLock`). Steht schon einer davor, meldet der Lauf
  die Phase `queued` („Wartet"), bis er dran ist, und beginnt dann mit
  `preflight`. Vorher sah ein wartender Lauf minutenlang aus wie einer, der
  gerade die Konfiguration liest. `queued` steht nicht in `HAPROXY_PHASES`:
  Warten ist kein Schritt des Ablaufs, das Fenster zeigt es nur als Zeile.

### Derselbe Vorgang ohne Dialog: `/api/internal/haproxy/**`

Dienste, TCP-Weiterleitungen, Gruppen, Admin-IPs, die Zertifikatsliste und die
Historie gibt es auch ohne Browser: für ein Deploy-Skript, eine Pipeline oder
einen anderen Dienst, der eine Domain anlegen will, ohne dass jemand einen
Dialog ausfüllt. Der Zugang ist ein Service-Token statt einer Sitzung. Die
Anleitung für den Aufrufer samt Feldern und Beispielclient steht in
[`reverse-proxy-api.md`](reverse-proxy-api.md), ebenso die Regeln für jeden, der
dort eine Route anfasst (Abschnitt „Für den, der die Routen ändert").

**Der Baum bildet den Dialog vollständig ab, mit einer Ausnahme**: die
DNS-Zugangsdaten für Wildcards. Sie legen einen fremden API-Token in die
Konfiguration von acme.sh, und acme.sh kennt je Variable genau einen Wert — der
Grund steht unter
„Wildcards" weiter oben und gilt für einen Aufruf genauso wie für einen Klick.

**Es ist kein zweiter Schreibweg.** Die Routen dort nehmen denselben Rumpf
(`readServiceInput`), prüfen mit `validateCreateInput`, gehen durch dieselbe
Vorabprüfung und starten denselben Lauf. Alles auf dieser Seite gilt für sie
unverändert: die Reihenfolge im SERVICES-Teil, `editable`/`removable`, das
geteilte Wildcard-Zertifikat, der Lock und der Prüfsummenvergleich. Wer hier
eine Regel ergänzt, ergänzt sie für beide — genau dafür liegt die Logik in
`lib/haproxy/` und nicht in den Routen. Der Unterschied ist der Actor: die Zeile
in `haproxy_runs` trägt den Namen des Dienstes (`serviceActor`) statt einer
E-Mail-Adresse.

### Import einer bestehenden Konfiguration: `/reverse-proxy/import`

Wer von einem HAProxy umzieht, das er bisher von Hand gepflegt hat, soll seine
Domains nicht einzeln abtippen. Die Seite nimmt eine `haproxy.cfg` (Datei oder
eingefügt, höchstens 1 MB, nur Text), zeigt eine Vorschau, und die gewählten
Einträge entstehen in einem Lauf. Der Parser steht in `lib/haproxy/import.ts`
(rein), der Lauf in `lib/haproxy/import-run.ts`, die Routen unter
`app/api/haproxy/import/`.

**Es wird nicht geraten.** Eine fremde Konfiguration kann alles, was HAProxy
kann; HAPM bildet einen kleinen Teil davon ab. Zu übernehmen, was passt, und
den Rest wegzulassen, ergäbe Einträge, die grün in der Vorschau stehen und
kaputt sind: aus `server web 10.0.0.1:443 check ssl verify none` würde ein
Ziel, das Klartext mit einem TLS-Server spricht. Deshalb gilt die Regel von
`extras`, nur strenger: **ein halb erkannter Eintrag ist ein nicht übernommener
Eintrag**, mit Zeile und Grund. Was übernommen wird, verhält sich wie vorher.
Wo HAPM etwas bewusst selbst festlegt, steht ein Hinweis am Eintrag und nicht
still darin: TLS und Zertifikat, der Name des Cookies der Sitzungsbindung
(`HAPMSRV`), die Form des Healthchecks, `option forwardfor`.

**Was erkannt wird:**

- Host-ACLs: `hdr(host)`, `req.hdr(host)` (mit `,lower`, `-i`, `-m str`),
  `ssl_fc_sni`/`req.ssl_sni` im HTTP-Frontend, mehrere Domains und mehrere
  Zeilen je ACL, ein Port in der Domain (`example.org:443`), Inline-ACLs
  (`{ … }`). `hdr_end(host) -i .example.org` (oder `-m end`) wird
  `*.example.org`; ohne führenden Punkt und bei `hdr_dom` werden es Domain
  **und** Wildcard, mit Hinweis, denn beide treffen auch Namen, die HAPM nicht
  träfe.
- Weichen: `use_backend b if acl`, auch `acl1 or acl2`/`||`. Eine Weiche
  `if host_acl path_acl` (mit `path_beg`) wird eine Pfad-Regel des Eintrags,
  dessen Hauptweiche `if host_acl` ist. Domains mit demselben Weg werden ein
  Eintrag.
- Backends: `server` (Name, `host:port`, `weight`, `check`, HTTPS zum Ziel
  mit `ssl verify none` oder `ssl verify required ca-file @system-ca`), `balance` aus der
  Allow-Liste, `cookie … insert` mit Marke auf jeder server-Zeile (als
  Sitzungsbindung), `option httpchk`/`http-check` (nur als „Healthcheck an",
  HAPM prüft GET / mit 200 bis 399), `http-request`/`http-response set-header`
  mit festem Text, `timeout tunnel` von genau einer Stunde in jeder
  Schreibweise.
- Weiterleitungen: `http-request redirect location|prefix … code 301|302 if
  host_acl` und das ältere `redirect …`, im Frontend wie im Backend.
- TCP: `listen` in `mode tcp` und `frontend` in `mode tcp` mit
  `default_backend`; Port aus `bind :port`, `*:port`, `0.0.0.0:port`, Absender
  aus `tcp-request connection reject if !{ src … }` (auch mit benannter
  `src`-ACL).
- Der Modus kommt aus dem Abschnitt, sonst aus `defaults` (auch benannten mit
  `from`), sonst gilt HAProxys Vorgabe `tcp`. Ein Backend ohne `mode http`
  hinter einem HTTP-Frontend ist deshalb ein Grund und keine Annahme.

**Die Reihenfolge der Regeln wird gelesen**, weil HAProxy die erste passende
Weiche nimmt. Eine Regel, die HAPM nicht abbilden kann, nimmt jeder Domain
darunter etwas weg, wenn sie sie treffen kann (`use_backend x if
hdr_beg(host) -i dyn.`, eine Weiche nach `src`, eine ohne Bedingung): alles
darunter wird dann nicht übernommen. Eine Regel, die nie zum Zug kam (dieselbe
Domain zweimal, eine Pfad-Regel unter der Hauptweiche), fällt dagegen weg und
steht als „kam nie zum Zug" in der Liste: ohne sie verhält sich der Eintrag
genau wie vorher. Ebenso eine Domain, die eine Wildcard davor schon bedient:
HAPM sortiert exakte Domains vor Wildcards, sie käme danach zum Zug, und das
wäre eine Änderung. `http-request`-Regeln laufen in HAProxy vor jedem
`use_backend`, egal wo sie stehen; der Parser liest die Weiterleitungen
deshalb zuerst. Zwei Frontends (HTTP und HTTPS), die dieselbe Domain gleich
routen, ergeben einen Eintrag; routen sie verschieden, ist das ein Grund.

**Was bewusst nicht übernommen wird**, jeweils mit Grund in der Liste:
`global` und `defaults` (einmal je Abschnitt, nicht je Zeile), Ports, TLS und
Zertifikate der Frontends (`bind … ssl crt …`), die Umleitung auf HTTPS (macht
HAPM selbst), `default_backend` eines HTTP-Frontends (in HAPM antwortet dort die
Seite für unbekannte Domains), `stats`, `userlist`, Lua, Regeln mit Ausdrücken
oder Umgebungsvariablen (`%[src]`, `"$NAME"`), Map-Dateien, Weichen nach SNI in
`mode tcp` (Durchreichen von TLS nach Namen), IPv6-Ziele (`BACKEND_TARGET` in
`config.ts` kennt sie nicht), Parameter auf der server-Zeile außer `check`,
`weight`, `cookie` und den HTTPS-Wörtern (`inter`, `send-proxy`, `backup`, …;
was von `ssl` übernommen wird, steht unter „Ziele, die HTTPS sprechen"), TCP-Ports an
einer festen Adresse (HAPM bände an alle, der Port stünde weiter offen), Backends
ohne Weiche. Ein `\` am Zeilenende ist keine Fortsetzung: HAProxy kennt keine
(geprüft gegen 3.4) und lädt so eine Datei nicht, also wird nichts verbunden.

**Die Vorschau rechnet der Server**, obwohl der Parser rein ist. Die Konflikte
hängen an der Datei auf der Maschine: eine Domain, die schon ein Eintrag
bedient (`findDomainConflict`, dieselbe Prüfung wie `addService`), ein Port,
den die Datei bindet (`bindConflict`) oder auf dem schon etwas lauscht
(`checkStreamPort`), fehlende DNS-Zugangsdaten für eine Wildcard oder eine
interne Installation (`planChallenge`), fehlendes acme.sh. Zustände:
übernehmbar, Konflikt, hier nicht möglich, nicht übernehmbar. Die Kennung zeigt
die Vorschau als voraussichtlich; fest wird sie im Lauf (`assignServiceId`).

**Beim Ausführen wird der Vorschau nicht geglaubt.** Der Browser schickt den
Text und die Schlüssel der gewählten Einträge (`http:<domains>`,
`tcp:<port>`); die Route liest den Text erneut, prüft jeden gewählten Eintrag
gegen den jetzigen Stand und lehnt ab, was nicht mehr übernehmbar ist. Eine
neue Gruppe prüft `validateScopeName` samt der Namen der Unterseiten; der
Vorschlag ist deshalb `IMPORTIERT` und nicht `IMPORT`, dessen Seite unter
dieser hier läge.

**Zertifikate:** jeder Eintrag mit Domain bekommt sein Zertifikat über den
normalen Weg (HTTP-01, Wildcard oder interne Installation DNS-01). Vorhandene
PEM-Dateien werden nicht übernommen. Die Vorschau sagt das, sagt bei HTTP-01,
dass die Domains schon auf diesen Server zeigen müssen (DNS-Einträge legt der
Import nicht an), und zählt die Anträge gegen die Grenzen von Let's Encrypt
(Stand August 2026: 50 Zertifikate je registrierter Domain in 7 Tagen, 300
Bestellungen je Konto in 3 Stunden, 5 gescheiterte Prüfungen je Name in einer
Stunde; `certificateLoad`, grob nach den letzten beiden Teilen der Domain). Ab
der Hälfte einer Grenze warnt sie.

**Der Lauf** (`action: 'import'`) ist EIN abgekoppelter Lauf mit einer Zeile in
der Historie und legt die Einträge nacheinander über die vorhandenen Vorgänge
an: `precheckCreate` + `createService` bzw. `precheckStreamCreate` +
`createStream`, also mit Lock, Prüfsumme, `haproxy -c`, Reload und Rückweg je
Eintrag. Kein zweiter Schreibweg und keine Sammelfassung: ein Zertifikat, das
Let's Encrypt verweigert, nähme in einem gemeinsamen Schreibvorgang alle
anderen mit. Eine neue Gruppe entsteht vorher über `updateScopes`; scheitert
das, hört der Lauf auf. Ein Eintrag, dessen Domain oder Port seit der Vorschau
belegt wurde, wird übersprungen (kein Fehler, die Lage hat sich geändert), ein
Fehlschlag hält die übrigen nicht auf. Die Schritte tragen den Eintrag im
Namen, am Ende steht eine Zusammenfassung (angelegt, übersprungen,
gescheitert). Ein gescheiterter Eintrag macht den Lauf zu einem gescheiterten,
mit Mail wie bei jedem anderen. Die Seite verfolgt den Lauf über
`/api/haproxy/runs/[id]` und verlinkt in die Historie.


### Die Logs: `/reverse-proxy/logs`

Zwei Reiter, zwei Quellen. **„Vorgänge"** ist die Historie dessen, was HAPM an
der Konfiguration geändert hat (`haproxy_runs`, `GET /api/haproxy/runs`).
**„HAProxy-Log"** ist, was HAProxy selbst schreibt: jede Anfrage und jede
Meldung des Prozesses (`GET /api/haproxy/log`). Der Reiter steht in der Adresse
(`?ansicht=haproxy`). Die Seite liegt in `app/(app)/reverse-proxy/logs/`
(`page.tsx` mit den Reitern, `RunsView.tsx`, `HaproxyLogView.tsx`), ihr CSS in
`app/logs.css`, das `tests/ui/css-classes.test.ts` über `PAGE_CSS` mitliest.

- **Kein seitliches Scrollen.** Beide Tabellen haben `table-layout: fixed`,
  feste Breiten für die kurzen Spalten und kürzen lange Inhalte mit dem vollen
  Text im Tooltip (`.logs-tip` an der Hülle, nicht am kürzenden Element: dessen
  `overflow: hidden` schnitte die Sprechblase ab). Wird der Platz knapp, wird
  jede Zeile zur Karte mit den Etiketten aus `data-label`. Gemessen wird das
  über eine Container-Abfrage auf `.logs-table-wrap` und nicht über die
  Fensterbreite, weil die Seitenleiste ihren Teil nimmt. Bei den Vorgängen
  stehen „Ausgelöst von" unter dem Vorgang und die Dauer unter dem Zeitpunkt:
  neun Spalten passten neben der Seitenleiste nicht.
- **Gelesen wird nur die Datei des Mitschnitts** (`HAPROXY_LOG_FILE` aus
  `lib/haproxy-log.ts`), über `tail -n` aus `buildCommand`. Der Pfad ist eine
  Konstante, Suche und Filter laufen in Node über die gelesenen Zeilen und gehen
  in kein Kommando. Ohne Filter liest ein Aufruf so viele Zeilen, wie er zeigt
  (200 bis 2000). **Mit Filter liest er ein festes Fenster von 20 000 Zeilen**
  (`FILTER_WINDOW`): unter den letzten 200 ist auf einem belebten Proxy selten
  ein 5xx. Die Seite sagt, in wie vielen Zeilen gesucht wurde.
- **Zerlegt wird in `lib/haproxy/log-view.ts`**, rein und ohne Shell prüfbar
  (`tests/haproxy/log-view.test.ts`): Anfrage (`option httplog`),
  TCP-Verbindung (`option tcplog`), Verbindungsfehler vor der ersten Anfrage
  (`https/1: SSL handshake failure`), Meldung von HAProxy (`[NOTICE]`,
  `[WARNING]`, `[ALERT]` und die Sätze ohne Stufe wie `Server x/y is DOWN`).
  **Was keiner Form entspricht, kommt als rohe Zeile** und nicht gar nicht:
  eine unbekannte Zeile ist oft genau die gesuchte. Die Adresse wird wie in der
  Statistik von rechts vom Port getrennt (IPv6). Die Zeit ist die aus dem Kopf
  des Mitschnitts (UTC), nicht das Annahmedatum in der Zeile.
- **Ehrliche Nullwerte.** Die Route liefert `exists` und den Zustand des
  Mitschnitts (`logFollowerStatus()`, mit `started` und `connected`). Fehlt die
  Datei, sagt die Seite, warum (Mitschnitt läuft nicht, ist nicht verbunden,
  oder HAProxy hat noch nichts geschrieben) statt einer leeren Liste. Ist die
  Datei da, der Mitschnitt aber getrennt, steht über den Zeilen, dass sie der
  letzte Stand sind. Unter macOS läuft der Mitschnitt nie (`startLogFollower`
  nur unter Linux), lokal sieht man deshalb den Leerzustand.
- **Die Seite pollt alle zehn Sekunden**, solange „Mitlaufen" an ist. Wer eine
  Zeile liest, schaltet es ab, damit sie nicht wegrutscht. Die Vorgänge pollen
  wie bisher alle zwanzig Sekunden.
- Die rotierte Vorgängerin (`haproxy.log.1`) wird nicht gelesen: direkt nach
  dem Beiseitelegen zeigt der Reiter deshalb nur die wenigen neuen Zeilen.
