# <img src="../public/brands/crowdsec.png" alt="" width="20" height="20"> CrowdSec: WAF und Sperren

HAPM bringt [CrowdSec](https://www.crowdsec.net) als Modul mit: eine WAF, die
jede Anfrage prüft, bevor HAProxy sie weitergibt, dazu Szenarien, die das Log
von HAProxy lesen und auffällige Adressen sperren. Hier steht, wie das gebaut
ist, welche Dateien HAPM schreibt und warum es so ist und nicht anders.

**Vorgabe: im Stack, aber aus.** Die beiden Container laufen nach
`docker compose up -d` mit. Geprüft wird aber nichts, bis jemand CrowdSec in der
Oberfläche global oder für ein Ziel einschaltet. Eine WAF, die nach einem Update
ungefragt Anfragen ablehnt, wäre ein Ausfall, den niemand bestellt hat. Die
Ausnahme ist der Assistent: wer dort „aus dem Internet erreichbar" wählt, dem
schlägt er vor, CrowdSec global einzuschalten (Häkchen, vorbelegt).

## Zwei Container mehr

| Container | Abbild | Netz | Aufgabe |
|---|---|---|---|
| `hapm-crowdsec` | `crowdsecurity/crowdsec:latest` (CrowdSec 1.8) | Netz des Stacks, kein Port nach außen | Liest das Log von HAProxy, lokale API (8080), AppSec/WAF auf 7422 |
| `hapm-crowdsec-bouncer` | `crowdsecurity/spoa-bouncer:latest` (Bouncer 0.3) | Netz des Stacks, Port 7423 nur auf `127.0.0.1` des Servers | Der SPOE-Agent, den HAProxy je Anfrage fragt |

**Im Netz des Stacks, nicht im Netz des Hosts.** HAPM und HAProxy laufen im Netz
des Hosts, weil sie Ports der Maschine belegen und sehen müssen (siehe
[`betrieb.md`](betrieb.md)). Die beiden CrowdSec-Container brauchen das nicht:
der Bouncer spricht die lokale API unter dem Namen `crowdsec` an, und die WAF
erreicht er unter `crowdsec:7422`. Im Netz des Hosts lägen 8080 und 7422 auf
jeder Adresse der Maschine, und 8080 ist ein Port, den oft schon etwas anderes
belegt. Nach außen geht nur der Port des Bouncers, und der nur auf
`127.0.0.1:${HAPM_SPOA_PORT:-7423}`: HAProxy im Netz des Hosts erreicht ihn
dort, von außen niemand.

**Abwählen über ein Profil, das sich selbst setzt.** Beide Dienste tragen
`profiles: ["${HAPM_CROWDSEC_OFF:+ohne-crowdsec}"]`. Ohne die Variable ist das
Profil leer, und ein leeres Profil ist für Compose immer dabei: wer nur
`docker-compose.yml` herunterlädt (Weg 1 im README) oder den Inhalt in
Portainer einfügt, bekommt CrowdSec ohne weitere Angabe. Mit
`HAPM_CROWDSEC_OFF=1` heißt das Profil `ohne-crowdsec`, das niemand einschaltet:
Compose sieht die beiden Dienste dann gar nicht, holt ihre Abbilder nicht und
legt keine Container an. HAPM liest dieselbe Variable (`crowdsecInStack()` in
`lib/crowdsec/paths.ts`).

Zuerst stand dort `scale: ${HAPM_CROWDSEC:-1}`. Mit `0` legte Compose zwar
keine Container an, holte die Abbilder aber bei `pull` und `up` trotzdem, und
ein nicht erreichbares Abbild (Firmennetz) ließ `docker compose up -d` ganz
scheitern. Ein gewöhnliches Profil (`profiles: [crowdsec]`) hätte die Vorgabe
umgedreht: ohne `COMPOSE_PROFILES` in `.env` gäbe es CrowdSec nie.

Ein Container aus der Zeit davor bleibt beim Abwählen stehen: Compose räumt
Dienste, die es nicht sieht, nicht weg. `install.sh` entfernt ihn dann
ausdrücklich (`docker compose rm -sf crowdsec crowdsec-bouncer`).

`install.sh --no-crowdsec` (oder `HAPM_CROWDSEC=0` in der Umgebung) schreibt
`HAPM_CROWDSEC_OFF=1` in `.env`, `--crowdsec` nimmt die Zeile wieder heraus.
Eine Zeile `HAPM_CROWDSEC=…` aus der ersten Fassung des Skripts wird dabei
übernommen und entfernt.

**Variablen**, alle mit Vorgabe:

| Variable | Vorgabe | Wofür |
|---|---|---|
| `HAPM_CROWDSEC_OFF` | leer | `1`: der Stack bringt CrowdSec nicht mit. Compose (Profil) und HAPM lesen sie |
| `HAPM_SPOA_PORT` | `7423` | Port des Bouncers auf `127.0.0.1` des Servers. Compose veröffentlicht ihn dort, HAPM schreibt ihn in `backend hapm_crowdsec_spoa` |
| `HAPM_CROWDSEC_CONTAINER` | `hapm-crowdsec` | Name des Containers, in dem `cscli` läuft |
| `HAPM_CROWDSEC_BOUNCER_CONTAINER` | `hapm-crowdsec-bouncer` | Name des Bouncers, für Log und Updates |
| `HAPM_CROWDSEC_DIR` | `/crowdsec` | Wo HAPM den Ordner `HAPM_STORAGE/crowdsec` sieht |

## Was wo liegt

Alles unter `HAPM_STORAGE/crowdsec/`. HAPM bindet den ganzen Ordner unter
`/crowdsec` ein und schreibt seine Dateien bei jedem Start neu
(`lib/crowdsec/setup.ts`, aufgerufen aus `lib/bootstrap.ts`). Compose startet
die CrowdSec-Container erst, wenn HAPM gesund ist: dann liegen die Dateien schon
da.

| Auf dem Server | In `hapm-crowdsec` | In `hapm-crowdsec-bouncer` | Inhalt |
|---|---|---|---|
| `crowdsec/config/` | `/etc/crowdsec` | | Konfiguration von CrowdSec, Hub, installierte Sammlungen |
| `crowdsec/config/acquis.d/hapm.yaml` | | | Von HAPM: die Quellen (Log von HAProxy, WAF) |
| `crowdsec/config/parsers/s02-enrich/hapm-backend.yaml` | | | Von HAPM: Backend einer Anfrage als `target_backend` |
| `crowdsec/data/` | `/var/lib/crowdsec/data` | | SQLite-Datenbank: Sperren, Ereignisse, Freigabelisten, dazu die Daten der Regeln |
| `crowdsec/secrets/bouncer_key_hapm` | `/run/secrets/bouncer_key_hapm` | | Schlüssel des Bouncers, von HAPM erzeugt (Rechte 600) |
| `crowdsec/bouncer/crowdsec-spoa-bouncer.yaml` | | Konfiguration des Bouncers | Von HAPM: Adresse der API, Schlüssel, `listen_tcp` |
| `log/` | `/var/log/haproxy` (nur lesend) | | Die Kopie des HAProxy-Logs, die HAPM ohnehin schreibt |
| `haproxy/hapm-crowdsec/spoe.cfg` | | | Von HAPM: die SPOE-Datei für HAProxy |
| `haproxy/hapm-crowdsec/allow.lst` | | | Von HAPM: freigegebene Adressen, eine je Zeile |

**Den Bouncer meldet CrowdSec selbst an.** Das Abbild von CrowdSec liest beim
Start Docker-Secrets der Form `bouncer_key_<name>` und legt den Bouncer mit
diesem Schlüssel an. HAPM schreibt den Schlüssel deshalb nur in die Datei und
in die Konfiguration des Bouncers. Lief CrowdSec schon, bevor es die Datei gab,
holt `reconcileCrowdsec` die Anmeldung über `cscli bouncers add` nach (im
Scheduler, eine Minute nach dem Start und danach alle 15 Minuten).

**Die Datei ist die Wahrheit, auch hier.** Was HAPM schreibt, schreibt es bei
jedem Start neu, nur wenn sich etwas ändert (`writeIfChanged`). Wer in
`acquis.d/hapm.yaml` von Hand etwas ändert, verliert es. Eigene Quellen gehören
in eine eigene Datei daneben in `acquis.d/`.

## Die Regeln

| Sammlung | Wann | Was |
|---|---|---|
| `crowdsecurity/haproxy` | immer | Parser für das Log von HAProxy und die Szenarien für HTTP |
| `crowdsecurity/appsec-virtual-patching` | immer | Virtuelle Patches gegen bekannte Lücken |
| `crowdsecurity/appsec-generic-rules` | immer | Allgemeine Regeln der WAF |
| `crowdsecurity/appsec-crs` | OWASP „nur melden" | OWASP Core Rule Set, außerhalb der Anfrage geprüft |
| `crowdsecurity/appsec-crs-inband` | OWASP „sperren" | OWASP Core Rule Set, lehnt die Anfrage ab |
| `crowdsecurity/appsec-wordpress` | Schalter | Virtuelle Patches für WordPress |
| `crowdsecurity/http-dos` | Schalter | Erkennt HTTP-Fluten |
| `crowdsecurity/appsec-crs-exclusion-plugin-nextcloud`, `…-wordpress` | Schalter | Ausnahmen, damit OWASP Nextcloud und WordPress nicht fälschlich sperrt |

Die drei festen installiert Compose über `COLLECTIONS`. Die übrigen schaltet die
Oberfläche unter „Regeln" (`cscli collections install`/`remove`). **Die Liste
ist fest** (`OPTIONAL_COLLECTIONS` in `lib/crowdsec/files.ts`): der Name geht
als Argument an `cscli`, und was dort installiert wird, läuft danach in der WAF
jeder Anfrage. Ein freies Feld wäre ein Weg, beliebigen Code in den Pfad jeder
Anfrage zu legen.

**OWASP hat einen eigenen Schalter**, weil es nicht nur eine Sammlung ist: die
Konfiguration der WAF (`appsec_configs` in `acquis.d/hapm.yaml`) nennt
`crowdsecurity/crs` oder `crowdsecurity/crs-inband`. Den Modus liest HAPM aus
dieser Datei zurück (`readCrsMode`), es gibt keine Kopie in der Datenbank.

„Regeln aktualisieren" ist `cscli hub update` und `cscli hub upgrade`.

## HAProxy: die Datei ist die Wahrheit

<img src="../public/brands/haproxy.png" alt="" width="16" height="16"> HAProxy
fragt den Bouncer über SPOE (Stream Processing Offload Engine). Für ein Ziel mit
CrowdSec stehen in **jedem Backend des Ziels** diese Zeilen
(`CROWDSEC_LINES` in `lib/haproxy/config.ts`):

```
filter spoe engine crowdsec config /etc/haproxy/hapm-crowdsec/spoe.cfg
acl hapm_crowdsec_done var(txn.crowdsec.remediation) -m found
acl hapm_crowdsec_big req.body_size -m int gt 8192
acl hapm_crowdsec_allow src -f /etc/haproxy/hapm-crowdsec/allow.lst
http-request wait-for-body time 1s at-least 8k unless hapm_crowdsec_done || hapm_crowdsec_allow
http-request send-spoe-group crowdsec crowdsec-http-body unless hapm_crowdsec_done || hapm_crowdsec_big || hapm_crowdsec_allow
http-request send-spoe-group crowdsec crowdsec-http-no-body if hapm_crowdsec_big !hapm_crowdsec_done !hapm_crowdsec_allow
http-request deny deny_status 403 if { var(txn.crowdsec.remediation) -m str ban captcha }
```

**Global** steht derselbe Block unter dem Marker `# CrowdSec` im HTTPS-Frontend,
hinter dem Zugriffsschutz. Dahinter, weil eine Adresse, die der Zugriffsschutz
ohnehin sperrt, dann keine Frage an den Bouncer kostet; vor jeder Regel der
Dienste steht er trotzdem. Ob er da ist, liest HAPM aus der Datei
(`parseCrowdsecGlobal`): steht er anders da, als HAPM ihn schreibt, ist der
Zustand `null` (unbekannt), und HAPM lässt ihn unberührt.

**Einmal je Anfrage.** Ist CrowdSec global und am Ziel an, hat das Frontend
schon gefragt, und `hapm_crowdsec_done` lässt das Backend aus. Ein zweiter
Durchlauf durch die WAF zählte jeden Treffer doppelt.

**Im Backend, nicht in den Regeln des Frontends.** Ein Ziel ist in
`haproxy.cfg` ein Backend (oder mehrere, bei Pfad-Regeln). Die Zeilen dort
gelten für genau dieses Ziel, ohne eine ACL über die Domains, die bei jeder
Änderung der Domains mitgezogen werden müsste.

**Das Backend zum Bouncer** (`backend hapm_crowdsec_spoa`, `mode tcp`,
`server bouncer 127.0.0.1:7423 check`) legt HAPM an, sobald irgendetwas
CrowdSec benutzt, und entfernt es, wenn nichts mehr es tut
(`syncCrowdsecBackend`). HAProxy lehnt eine SPOE-Datei ab, deren `use-backend`
es nicht gibt, und ein Backend ohne Nutzer prüfte nur einen Bouncer, den
vielleicht niemand betreibt (Meldungen im Log). Ein vorhandenes Backend bleibt,
wie es ist, auch mit anderem Port: wer es von Hand geändert hat, meint es so.
Entfernt wird nur der Block mit dem Marker von HAPM.

**Die SPOE-Datei** schreibt `lib/bootstrap.ts` bei jedem Start, auch ohne
CrowdSec im Stack, und legt `allow.lst` leer an, falls sie fehlt (danach führt
sie der Abgleich der Freigaben). Beide sind klein und werden nur geladen, wenn
`haproxy.cfg` sie nennt; eine Konfiguration, die sie nennt, startet damit nie an
einer fehlenden Datei. Die Namen der Nachrichten (`crowdsec-http-body`,
`crowdsec-http-no-body`) erwartet der Bouncer genau so.

**Abgelehnt wird mit 403** über die Fehlerseite von HAPM (`errorfile 403`), also
im Aussehen der übrigen Fehlerseiten.

**Fällt der Bouncer aus, gehen Anfragen durch** (fail-open). Die SPOE-Datei setzt
`option set-on-error error` und `timeout processing 500ms`: antwortet der
Bouncer nicht, steht nur `txn.crowdsec.error` an der Anfrage, und keine der
Zeilen lehnt ab. Gemessen mit angehaltenem Bouncer: rund eine Sekunde
Verzögerung, dann die Antwort des Ziels. Die andere Wahl (fail-closed) hätte bei
jedem Update von CrowdSec alle Ziele mit CrowdSec abgeschaltet.

**Rumpf bis 8 KB.** `wait-for-body` wartet höchstens eine Sekunde auf die ersten
8 KB, und bis 8192 Byte geht der Rumpf mit an die WAF. Ein größerer passt nicht
in einen SPOE-Rahmen der Vorgabegröße (16 KB samt Kopfzeilen); dann prüft die WAF
nur Methode, Pfad, Abfrage und Kopfzeilen. Hochladen großer Dateien geht damit
weiter, nur eben ohne Prüfung des Inhalts.

**HAProxy 2.4 oder neuer.** `http-request wait-for-body` gibt es erst seit 2.4.
`pnpm crowdsec:verify` prüft die Zeilen gegen 2.4, 2.8, 3.0 und `lts`.

**Captcha gibt es nicht.** Ein Captcha bräuchte Schlüssel bei einem Anbieter
(hCaptcha, reCAPTCHA, Turnstile) und eine Seite, die HAProxy ausliefert. Eine
Captcha-Entscheidung wird wie eine Sperre behandelt: HAProxy lehnt `ban` und
`captcha` ab. Durchlassen hieße, eine Sperre zu übergehen. Die Konfiguration
des Bouncers hat deshalb keinen `captcha`-Block; ohne Anbieter stünde er nur
als Fehler in dessen Log.

**Regeln wechseln heißt Neustart.** Nach einem Wechsel der OWASP-Regeln oder
einer Sammlung startet HAPM den Container von CrowdSec neu, statt ihm nur ein
Signal zu schicken: neue Quellen der WAF übernimmt er so sicher. In den
Sekunden des Neustarts gehen Anfragen ungeprüft durch, wie bei jedem Ausfall.

## Freigaben

HAPM führt in CrowdSec eine Freigabeliste mit dem Namen `hapm`
(`cscli allowlists`). Andere Listen zeigt die Oberfläche, ändert sie aber nicht.

**Eine Freigabe in CrowdSec allein reicht nicht.** Geprüft mit CrowdSec 1.8:
eine Adresse auf der Liste wird nicht mehr gesperrt, die WAF lehnt ihre
Anfragen bei einem Treffer aber trotzdem ab. Wer eine Adresse freigibt, meint
„die kommt immer durch". Deshalb schreibt HAPM dieselben Adressen nach
`/etc/haproxy/hapm-crowdsec/allow.lst` (`lib/crowdsec/allow-file.ts`), und
HAProxy schickt Anfragen von dort gar nicht erst an CrowdSec. Nach jeder
Änderung lädt HAProxy neu. Abgelaufene Einträge nimmt der Scheduler alle
15 Minuten aus der Datei; CrowdSec selbst wertet das Ablaufdatum ohnehin aus.

## Wie HAPM mit CrowdSec spricht: `cscli`

HAPM ruft `docker exec hapm-crowdsec cscli … -o json` über die Engine auf
(`lib/crowdsec/cscli.ts`, argv über `engine.exec`, keine Shell), wie
`haproxy -c` im HAProxy-Container. **Nicht über die lokale API**, weil sie zwei
Arten Zugang kennt und keine passt: ein Bouncer darf nur Sperren lesen, eine
Maschine braucht eigene Zugangsdaten und kann Freigabelisten trotzdem nicht
ändern. `cscli` kann alles, was die Seite braucht, und gibt JSON aus. Läuft der
Container nicht, antworten die Routen mit 503 und sagen, welcher Container fehlt.

**Ereignisse einem Ziel zuordnen.** Ein Ereignis der WAF trägt den Host der
Anfrage (`target_fqdn`), daraus folgt das Ziel über seine Domains. Ein Szenario
aus dem Log von HAProxy kennt den Host nicht; dafür schreibt HAPM den Parser
`hapm-backend.yaml`, der das Backend der Logzeile als `target_backend` an das
Ereignis hängt. Der Parser steht ohne `onsuccess: next_stage`: das übersprünge
die übrigen Parser der Stufe, darunter `http-logs`, ohne den kein Szenario
anspringt.

## Oberfläche, API, MCP

- **Reverse-Proxy, CrowdSec** (`/reverse-proxy/crowdsec`), Reiter: Übersicht
  (Zustand, globaler Schalter, geschützte Ziele), Sperren (aktive
  Entscheidungen, aufheben, Adresse von Hand sperren), Freigaben (hinzufügen,
  entfernen, eigene Adresse), Ereignisse (Filter nach Ziel), Regeln.
- **Je Ziel** der Schalter „CrowdSec (WAF)" im Dialog des Ziels, eine Marke auf
  der Karte und die Ereignisse des Ziels.
- **Logs:** dritter Reiter „CrowdSec", das Log des Containers von CrowdSec oder
  des Bouncers.
- **Statistik:** zweiter Reiter „CrowdSec": Ereignisse je Stunde oder Tag nach
  Art (WAF, Szenario, von Hand), häufigste Szenarien, Länder, Quellen, Ziele,
  Pfade, aktive Sperren, Größe der Community-Blocklist.
- **Übersicht:** Kennzahlen und Zeilen zu CrowdSec.
- **Updates:** beide Abbilder lassen sich wie HAProxy aktualisieren.
- **Interne API** unter `/api/internal/crowdsec`: `GET /`, `GET`/`POST`/`DELETE`
  `decisions`, `GET`/`POST`/`DELETE` `allowlist`,
  `GET alerts?window=24h|7d|30d&service=`, `GET stats?window=`,
  `GET`/`PATCH` `rules`. Siehe [`hapm-api.md`](hapm-api.md).
- **MCP:** `get_crowdsec`, `list_crowdsec_decisions`, `add_crowdsec_decision`,
  `remove_crowdsec_decision`, `list_crowdsec_allowlist`,
  `add_crowdsec_allowlist`, `remove_crowdsec_allowlist`,
  `list_crowdsec_alerts`, `get_crowdsec_stats`, `get_crowdsec_rules`,
  `update_crowdsec_rules`. Siehe [`mcp.md`](mcp.md).

Alle drei rufen dieselben Funktionen in `lib/crowdsec/actions.ts`, die auch das
Audit schreiben.

## Die Central API von CrowdSec

CrowdSec spricht in der Vorgabe mit der Central API (`api.crowdsec.net`): es
meldet die Adressen, die es gesperrt hat, samt Szenario und Zeitpunkt, und
bekommt dafür die Community-Blocklist. Das ist das Verhalten des Abbilds von
CrowdSec, HAPM ändert daran nichts. Wer das nicht will, setzt im Dienst
`crowdsec` die Variable `DISABLE_ONLINE_API=true` (über eine
`docker-compose.override.yml`, siehe unten bei der Fehlersuche). Dann gibt es
keine Community-Blocklist, die eigenen Regeln arbeiten weiter. Der Hub mit den
Regeln (`cdn-hub.crowdsec.net`, `hub-data.crowdsec.net`) wird trotzdem
gebraucht. Welche Hosts das sind und wie es durch einen Proxy geht, steht in
[`betrieb.md`](betrieb.md), „Ausgehende Verbindungen".

## Nachrüsten

Eine Installation von vor CrowdSec hat eine `docker-compose.yml` ohne die beiden
Dienste und ohne den Ordner `/crowdsec` in HAPM. HAPM erkennt das am fehlenden
Ordner (`crowdsecInstalled()` in `lib/crowdsec/paths.ts`) und blendet CrowdSec
aus wie bei einer abgewählten Installation: kein Eintrag in der Seitenleiste,
kein Reiter unter Logs und Statistik, kein Schalter im Ziel-Dialog, kein
Bereich in der Übersicht, keine Updates dafür. Die Seite selbst (direkt
aufgerufen) nennt den Befehl zum Nachrüsten: `install.sh` erneut ausführen, es
holt die neue `docker-compose.yml` und startet mit. Über „Updates" geht das
nicht: das tauscht nur Abbilder bestehender Container und behält deren
Einrichtung (`recreateBody`), ein neuer Container oder ein neuer Ordner kommt so
nicht dazu.

Abgewählt (`HAPM_CROWDSEC_OFF=1`) sieht für die Oberfläche genauso aus; die
Seite nennt dann `install.sh --crowdsec`. Ein Ziel, das die Zeilen von früher
noch trägt, zeigt seinen Schalter weiter, damit es sie loswerden kann.

## Abschalten

**Für alle Ziele, Stack bleibt:** in der Oberfläche den globalen Schalter und
die Schalter der Ziele aus. Danach steht in `haproxy.cfg` nichts mehr von
CrowdSec, und `backend hapm_crowdsec_spoa` verschwindet mit.

**Aus dem Stack:**

```bash
cd /opt/hapm
echo "HAPM_CROWDSEC_OFF=1" >> .env
docker compose rm -sf crowdsec crowdsec-bouncer
docker compose up -d
```

Oder `sh install.sh --no-crowdsec`, das erledigt beides. Schalten Sie CrowdSec
vorher in der Oberfläche überall aus: steht der Block noch in `haproxy.cfg`,
läuft HAProxy weiter (fail-open), wartet aber bei jeder Anfrage auf einen
Bouncer, den es nicht gibt. Der Ordner `crowdsec/` bleibt liegen. Wieder
einschalten: `HAPM_CROWDSEC_OFF` aus `.env` entfernen (oder `--crowdsec`) und
`docker compose up -d`.

## Prüfen

```bash
pnpm crowdsec:verify
```

`scripts/verify-crowdsec.ts` startet echtes HAProxy, CrowdSec und den Bouncer in
Docker, mit Konfigurationen, die über dieselben Funktionen entstehen wie im
Betrieb. Geprüft wird, was nur die echten Programme zeigen: `haproxy -c` nimmt
die Zeilen in 2.4, 2.8, 3.0 und `lts` an; die WAF lehnt `/.env` mit 403 ab, nur
bei Zielen mit CrowdSec, global bei allen, und das Ereignis nennt die Domain;
eine Sperre von Hand trifft die Adresse, eine Freigabe hebt sie auf; ein
Szenario aus dem Log trägt `target_backend`; ohne Bouncer gehen Anfragen durch.
Braucht Docker und Netz (CrowdSec holt beim ersten Start seine Regeln). Wer
`CROWDSEC_LINES`, die SPOE-Datei oder die Dateien für CrowdSec ändert, lässt es
laufen.

## Grenzen

- **Kein Captcha**, siehe oben. Eine Captcha-Entscheidung sperrt.
- **Rümpfe über 8 KB** prüft die WAF nicht, nur Methode, Pfad, Abfrage und
  Kopfzeilen.
- **OWASP CRS kann Falsches sperren.** Die Regeln sind allgemein und kennen die
  Anwendung nicht. Erst „nur melden", die Ereignisse ansehen, dann „sperren".
  Für Nextcloud und WordPress gibt es Ausnahmen als Schalter.
- **Freigaben gelten für HAProxy, nicht für jede Quelle.** Eine freigegebene
  Adresse geht an CrowdSec vorbei. Was CrowdSec über sie aus dem Log erfährt,
  führt nicht zu einer Sperre.
- **Ein Szenario sperrt erst nach dem Lesen des Logs.** Das Log kommt über HAPM
  (`lib/haproxy-log.ts`). Läuft HAPM nicht, sieht CrowdSec keine neuen Zeilen;
  die WAF prüft trotzdem weiter.

## Fehlersuche

Alles mit `cscli` im Container:

```bash
docker exec hapm-crowdsec cscli decisions list     # aktive Sperren
docker exec hapm-crowdsec cscli alerts list        # Ereignisse
docker exec hapm-crowdsec cscli bouncers list      # ist der Bouncer "hapm" angemeldet, wann zuletzt gesehen
docker exec hapm-crowdsec cscli metrics            # was gelesen, geparst, von der WAF geprüft wurde
docker exec hapm-crowdsec cscli allowlists inspect hapm
docker exec hapm-crowdsec cscli collections list
```

- **Nichts wird abgelehnt.** Ist CrowdSec für das Ziel oder global an? Steht
  der Block in `haproxy.cfg`? Meldet `cscli bouncers list` den Bouncer `hapm`
  mit einer frischen Zeit? Läuft der Bouncer (`docker logs hapm-crowdsec-bouncer`)?
  Ist die Adresse freigegeben (`allow.lst`)?
- **Der Bouncer fehlt in `bouncers list`.** HAPM holt die Anmeldung eine
  Minute nach dem Start und danach alle 15 Minuten nach. Schneller geht es mit
  `docker restart hapm`.
- **Szenarien springen nicht an.** `cscli metrics`, Abschnitt „Acquisition":
  liest CrowdSec `/var/log/haproxy/haproxy.log`? Abschnitt „Parsers": wird
  `crowdsecurity/haproxy-logs` getroffen?
- **Hub nicht erreichbar.** Im Log von `hapm-crowdsec` stehen Fehler zu
  `cdn-hub.crowdsec.net`. Ausgehende Verbindungen und Proxy:
  [`betrieb.md`](betrieb.md), „Ausgehende Verbindungen".

Eigene Einstellungen am Dienst (Proxy, `DISABLE_ONLINE_API`) gehören in eine
`docker-compose.override.yml` neben `docker-compose.yml`. Compose liest sie
von selbst, und ein Update von `docker-compose.yml` überschreibt sie nicht.
