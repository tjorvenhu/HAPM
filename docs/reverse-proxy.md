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
  `service_tokens`.
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
Sitzungsbindung; im Weiterleitungs-Formular keine Backend-Zeilen, kein Preset,
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

- **`balance` ist ein Feld und kein Preset.** Ein Preset ist eine feste Liste
  Zeilen, die man ganz oder gar nicht bekommt; hier gibt es genau einen Wert.
  `null` heißt **keine Zeile** und nicht „roundrobin": was im `defaults`-Block
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
  rendert dafür jede Kombination aus Preset und Healthcheck und besteht darauf,
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
  **Sie schließt Ziele, Pfad-Regeln, Preset und Healthcheck aus**, und zwar
  ablehnend statt still: alle vier setzen ein Backend mit Servern voraus. Ein
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
- **Ein Preset ist eine feste Liste Zeilen in JEDEM Backend des Dienstes**
  (`PRESET_BACKEND_LINES`). Nur so lässt es sich zurücklesen, ohne zu raten:
  steht die Liste vollständig da, ist es das Preset, sonst hat jemand von Hand
  etwas geändert und der Eintrag wird nicht mehr angefasst. `coolify` ist
  deshalb ein Preset und kein Eingabefeld — es setzt `timeout tunnel 1h`, ohne
  das fallen Terminal und Live-Ansicht nach `timeout client` aus dem
  `defaults`-Block und reißen mitten in der Arbeit ab. Ein Feld für den Wert
  hätte dieselbe Wirkung und wäre eine Frage mehr im Formular, auf die niemand
  eine andere Antwort hat als „1h".
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
Pfad-Regeln, Preset, Sperre über die Admin-IPs. Alle fünf setzen HTTP voraus.

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
Bequemlichkeit, sondern die Bedingung.

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
  Installation intern ist, sonst HTTP-01. Sie ist rein, und
  `tests/haproxy/challenge.test.ts` rechnet jede Kombination aus Art, Wildcard
  und Zahl der Hooks nach.
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
  DNS-Zugangsdaten fehlen. Eine Meldung über Wildcards wäre dort falsch.
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

**Die Anbieter heißen so, wie das mitgelieferte acme.sh sie führt.** Hetzner
ist `dns_hetznercloud` mit `HETZNER_TOKEN` (ein Token aus der Hetzner-Konsole,
Lesen und Schreiben). Den früheren Hook `dns_hetzner` gibt es in acme.sh nicht
mehr: ein Eintrag darunter speicherte scheinbar erfolgreich, und kein Hook galt
danach als eingerichtet. `tests/haproxy/dns-credentials.test.ts` lässt deshalb
eine echte Bash schreiben **und** erkennen und besteht darauf, dass der erkannte
Hook der des Anbieters ist. Der Hetzner-Hook legt beim ersten Antrag selbst
weitere `SAVED_*`-Zeilen ab (API-Adresse, TTL). Beim Entfernen gehen sie mit
(`alsoSaved`), sonst gälte der Hook ohne Token weiter als eingerichtet.

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
  Zertifikatsseite mit leerer Spalte „Benutzt von".
- Eine eigene Route dafür gibt es nicht. Aufgerufen wird es aus der Einrichtung
  (`lib/setup/run.ts`).

### Die Zertifikatsseite: `/reverse-proxy/zertifikate`

Was acme.sh führt, mit den abgedeckten Domains, dem
Erneuerungstermin und den Diensten, die es benutzen. **Nur lesend.** Ein
Zertifikat entsteht und vergeht mit einem Dienst; es hier einzeln zu löschen
hieße, dem Reverse-Proxy das PEM unter einer laufenden Domain wegzuziehen — und
das fiele beim nächsten Start von HAProxy auf, nicht heute.

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

Eine eigene Route und kein Feld auf `/api/haproxy/services`, weil
`acme.sh --list` über jedes Domainverzeichnis läuft: die Übersicht pollt im
Minutentakt, diese Seite alle zwei Minuten und nur, wenn sie offen ist.

### Was für alle Dienste gilt: `/reverse-proxy/einstellungen`

Was keinem Dienst gehört, sondern HAProxy als Ganzem: der Block unter
`# Globale HTTPS-Settings` im Frontend (HSTS, `option forwardfor`, die
`X-Forwarded-*`-Header) und die Admin-Adressliste. Sie stehen deshalb auf einer
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
  die Maske kennt Domains, Ziele und Preset, und was daneben steht, ist die
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
Schloss auf seiner Karte oder im Dialog — beides schreibt denselben vollständigen
Eintrag und läuft über denselben abgekoppelten Vorgang.

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
Versuche). **Ihr Aussehen kommt aus `ui/static/page.ts`** und wird dort
geändert; `lib/haproxy/lock-page.ts` gibt nur die drei Texte und den Namen des
Feldes herein. HAProxy liest die Dateien beim Laden der Konfiguration ein, und
daraus folgt:

- **Eine Datei, nichts zum Nachladen, kein JavaScript.** Vor der Sperre bekäme
  jede weitere Anfrage an die Domain wieder diese Seite. Stil und Logo stehen im
  Dokument, die Schrift ist die des Systems, und das Formular schickt an die
  eigene Adresse.
- **Unter 12 KB** (`LOCK_PAGE_MAX_BYTES`): die Antwort muss samt Kopfzeilen in
  HAProxys Puffer von 16 KB passen.
- **Ein geändertes Aussehen wirkt nicht von selbst.** Es kommt mit einem neuen
  Abbild von HAPM und dem nächsten Schreibvorgang an, siehe den nächsten Punkt.
- **Die Dateien müssen liegen, bevor `haproxy -c` läuft.** Fehlt eine, lehnt
  HAProxy die ganze Konfiguration ab. `stageAndCheck` stellt sie deshalb vor
  JEDER Prüfung sicher, sobald die Konfiguration darauf verweist, nicht nur beim
  Anlegen einer Sperre: sonst scheiterte ein Jahr später das Ändern einer fremden
  Backend-Adresse daran, dass jemand das Verzeichnis aufgeräumt hat. Verglichen
  wird über die Prüfsumme, geschrieben nur bei einer Abweichung. So kommt auch
  eine geänderte Fassung der Seite mit dem nächsten Vorgang an.
  Aufgeräumt wird nicht.

**Geprüft wird gegen ein echtes HAProxy, und zwar mit einem Skript**
(`pnpm haproxy:verify-pages`, braucht Docker). Die Tests halten fest, dass
geschrieben wird, was zurückgelesen wird. Ob HAProxy die Zeilen so versteht, wie
sie gemeint sind, können sie nicht sagen, und dort liegen die Fehler, die
niemand sieht: ein Passwort mit Umlaut, das der Browser anders kodiert, als der
Hash es erwartet, ergibt eine gültige Datei und eine Sperre, durch die niemand
kommt. Das Skript baut dieselbe Konfiguration wie der Betrieb, startet HAProxy
2.4, 2.8 und 3.0 damit und schickt, was ein Browser-Formular schickt. Es prüft
auch die Fehlerseiten (nächster Abschnitt). **Wer `passwordLockRules` oder
`renderErrorFile` ändert, lässt es laufen.**

Die Größe der Konfiguration ist keine Grenze: sie geht als Heredoc in EINEM
Kommando an die Shell, und ein einzelnes Argument fasst unter Linux 128 KB (ein
gesperrter Eintrag trägt rund 1,6 KB mehr als ein offener). `lib/ssh.ts` gibt
ein Kommando ab 64 KB deshalb als Datei an `bash` statt als Argument
(`INLINE_LIMIT`).

### Die Fehlerseiten

Was ein Besucher sieht, wenn ein Ziel nicht antwortet (502, 503, 504), eine
Domain unbekannt ist oder die Sperre auf Admin-IPs greift (403). Unter
„Reverse-Proxy → Einstellungen" steht, welche Fehlerdateien die
Konfiguration nennt, und ein Knopf bringt sie auf den Stand von HAPM
(`lib/haproxy/error-pages.ts`, `ErrorPagesPanel`). Das Aussehen selbst kommt aus
`ui/static/page.ts` (`renderErrorPage`): eine Seite mit schwebender Kopfleiste,
ohne Karte. Die Passwortabfrage aus demselben Modul ist dagegen die
Anmeldekarte.

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
- **Eine neue Fassung der Seiten zeigt sich als „Andere Seite"**: die Prüfsumme
  der Datei auf der Platte weicht dann von der ab, die jetzt entstünde. Der Knopf
  schreibt sie neu.
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
- **Der Takt steht in `stats-series.ts` und nicht bei der Erfassung.** Die Seite
  pollt in genau diesem Takt und braucht die Zahl; `stats-collect.ts` zieht über
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
- **Gezeichnet werden Linien, und eine Fläche nur bei einer
  einzelnen Reihe** (`components/systems/MetricChart.tsx`). Zwei naheliegende
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
- **Die Seite verfolgt ihren eigenen Vorgang**, aber nur, um in dem Moment
  nachzuladen, in dem er fertig ist. Ohne das stünde die neue Domain bis zum
  nächsten 60-Sekunden-Takt nicht in der Liste, und das sieht aus, als wäre
  nichts passiert.

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

