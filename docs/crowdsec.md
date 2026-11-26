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
| `crowdsec/data/crs-plugins/hapm/hapm-config.conf` | | | Von HAPM: erlaubte Methoden der OWASP-Regeln, auch PUT, PATCH, DELETE (`renderCrsMethods`) |
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
| `crowdsecurity/http-dos` | Schalter | Erkennt HTTP-Fluten |
| je Anwendung | Schalter | siehe „Anwendungen“ |

Die drei festen installiert Compose über `COLLECTIONS`. Die übrigen schaltet die
Oberfläche unter „Regeln" (`cscli collections install`/`remove`). **Die Liste
ist fest** (`OPTIONAL_COLLECTIONS` in `lib/crowdsec/files.ts`): der Name geht
als Argument an `cscli`, und was dort installiert wird, läuft danach in der WAF
jeder Anfrage. Ein freies Feld wäre ein Weg, beliebigen Code in den Pfad jeder
Anfrage zu legen.

**Erlaubte Methoden der OWASP-Regeln.** Ab Werk erlaubt das CRS nur GET, HEAD,
POST und OPTIONS. Regel 911100 („Method is not allowed by policy“) gab jedem
PUT, PATCH und DELETE 5 Punkte ohne Kategorie (`anomaly score out-of-band:
anomaly: 5`), also auch jedem Klick in der Oberfläche von HAPM. Gehäuft hätte
`crowdsec-appsec-outofband` die eigene Adresse gesperrt. HAPM schreibt deshalb
ein CRS-Plugin, das nur die Liste setzt (`renderCrsMethods`,
`crowdsec/data/crs-plugins/hapm/hapm-config.conf`). `crowdsecurity/crs` lädt
`crs-plugins/*/*-config.conf` aus dem Datenordner vor REQUEST-901, und 901160
setzt die Vorgabe nur, wenn die Liste fehlt. Plugins wie Nextcloud hängen ihre
WebDAV-Methoden an. TRACE und andere bleiben verboten. Geprüft mit CrowdSec
1.8.2: ohne die Datei melden PATCH, PUT und DELETE je `anomaly: 5`, mit ihr nur
noch TRACE.

### Anwendungen

Eine Zeile je Anwendung (`APP_RULES` in `lib/crowdsec/apps.ts`), ein Schalter
installiert oder entfernt alles, was dazugehört. Drei Arten:

- **Whitelists aus dem Hub** (`crowdsecurity/…-whitelist`, `…-allowlist`,
  Parser in `s02-enrich`). Sie prüfen `http_verb`, `http_status` und
  `http_path`, die das Log von HAProxy genauso liefert wie das von nginx.
- **Ausnahmen für OWASP** (`crowdsecurity/appsec-crs-exclusion-plugin-…`). Die
  Sammlung lädt nur Dateien, die die CRS-Regel selbst einbindet: **ohne
  OWASP-Regeln tun sie nichts**. Die Oberfläche zeigt das an der Spalte
  „Wirkt auf“.
- **Eigene Whitelists von HAPM** (`local`), wo der Hub nichts oder zu wenig hat
  (Matrix, Immich, Seafile, ONLYOFFICE, Synology, Audiobookshelf, Navidrome,
  Git-Server, Ergänzungen für Nextcloud, Jellyfin und Plex). Jedes Muster ist
  am Anfang und, wo der Pfad dort endet, am Ende verankert, und `..` im Pfad
  nimmt keine Ausnahme: ein Muster, das irgendwo passen darf, träfe auch die
  Parameter, und ein Scanner hängte den ausgenommenen Pfad einfach an. HAPM schreibt sie
  nach `config/parsers/s02-enrich/hapm-app-<id>.yaml` und beim Start neu, wenn
  sich die Liste mit einem Update geändert hat. Aufgenommen ist nur, was in
  einem Ticket oder im Forum von CrowdSec **mit Pfad und Status** belegt ist;
  die Quelle steht am Eintrag und als Kommentar in der Datei. Fälle ohne Pfad
  (Kavita, Outline, Vaultwarden) oder mit einem Szenario, das HAPM nicht
  installiert (Home Assistant, `http-generic-403-bf`), fehlen bewusst.

Stolperfallen beim Schreiben eigener Ausnahmen:

- **`http_path` ist bei HAProxy die ganze Anfrage samt `?…`.** `http-logs`
  überschreibt das Feld nicht, weil `Parsed.http_path` leer bleibt. Ein Muster
  mit `$` braucht davor `(\?.*)?`. `http-probing` zählt verschiedene
  `http_path`: dieselbe Adresse mit anderen Parametern zählt mehrfach.
- **Whitelist im Parser, nicht nach dem Überlauf.** `http-crawl-non_statics`
  behält nur fünf Ereignisse (`cache_size`), eine Whitelist in
  `postoverflows` sieht also nicht alle Anfragen.
- **Backslashes zweimal:** einmal für die Ausdruckssprache (expr, Text in
  einfachen Anführungszeichen), einmal für YAML. `localRuleExpression` und
  `renderAppWhitelist` erledigen beides, `tests/crowdsec/apps.test.ts` prüft die
  Muster gegen die Fälle aus den Quellen.
- Prüfen gegen das echte CrowdSec: die Datei in den Container legen, neu
  starten, dann
  `cscli explain --type haproxy --log '<Zeile aus haproxy.log>'`. Eine
  passende Zeile endet mit „whitelisted“.

**OWASP hat einen eigenen Schalter**, weil es nicht nur eine Sammlung ist: die
Konfiguration der WAF (`appsec_configs` in `acquis.d/hapm.yaml`) nennt
`crowdsecurity/crs` oder `crowdsecurity/crs-inband`. Den Modus liest HAPM aus
dieser Datei zurück (`readCrsMode`), es gibt keine Kopie in der Datenbank.

„Regeln aktualisieren" ist `cscli hub update` und `cscli hub upgrade`.

### Änderungen laufen in einer Warteschlange

Eine Änderung holt Regeln aus dem Hub und braucht danach einen Neustart von
CrowdSec. Das dauert länger, als eine Anfrage warten soll, und solange die
Seite darauf wartete, war jeder andere Schalter gesperrt. Jede Änderung reiht
sich deshalb ein (`lib/crowdsec/rule-jobs.ts`, im Speicher des Prozesses):

- **Die Oberfläche wartet nicht.** `PATCH /api/crowdsec/rules` prüft die
  Änderung, reiht sie ein und antwortet sofort mit `{ runId, key }`
  (`queueRuleChange`). Der Lauf steht in der Pille unten rechts, sein Ende
  kommt als Meldung, die Schritte liest das Fenster der Läufe unter
  `GET /api/crowdsec/rules/runs/<id>`. Ein Fenster je Klick geht nicht auf
  (`watchRun` statt `startRun`).
- **Es arbeitet immer nur ein Lauf, und was dazukommt, hängt sich an.** Die
  Änderungen laufen nacheinander: zwei `cscli` nebeneinander schrieben in
  denselben Hub. Wartet schon eine Änderung für denselben Schalter, tritt die
  spätere an ihre Stelle.
- **CrowdSec lädt je Lauf einmal neu, am Ende.** Jeder Neustart lässt für
  Sekunden Anfragen ungeprüft durch, drei Schalter hintereinander sollen das
  nicht dreimal tun. Neu geladen wird auch nach einem Fehler mittendrin: was
  schon installiert ist, soll gelten. Scheitert eine Änderung, laufen die
  übrigen weiter, und der Lauf endet als fehlgeschlagen. Was sich während des
  Neuladens einreiht, beginnt den nächsten Lauf.
- **Was aussteht, sagt `GET rules` in `pending`** (`crs`, `app:<id>`, Name der
  Sammlung, `hub`, jeweils mit dem gewünschten Zustand). Der Schalter zeigt
  danach sofort den Wunsch und ist gesperrt, bis CrowdSec neu geladen hat: erst
  dann gilt die Änderung. Die übrigen Schalter bleiben bedienbar. Während des
  Neustarts liefert `GET rules` den letzten Stand von `cscli hub list` statt
  eines Fehlers.
- **Interne API und MCP warten weiter auf das Ergebnis** (`changeRules`), mit
  derselben Antwort wie zuvor, gehen aber durch dieselbe Schlange: die Antwort
  kommt, wenn die eigene Änderung gelaufen ist und CrowdSec neu geladen hat.
- Der Abgleich im Scheduler setzt aus, solange ein Lauf arbeitet. Er startete
  CrowdSec nach einem Wechsel der OWASP-Regeln sonst mitten im Lauf neu.

Nach einem Neustart von HAPM ist die Schlange leer und die Läufe sind vergessen:
eine wartende Änderung hätte ihn ohnehin nicht überlebt. Das Audit steht je
Änderung im Protokoll.

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

**HTTP/3 geht als HTTP/2 an die WAF** (`version=req.ver,regsub(^3,2)`). Das
OWASP Core Rule Set in CrowdSec 1.8 kennt HTTP/3 nicht als erlaubte Version:
Regel 920430 gab jeder Anfrage eines Browsers über QUIC 5 Punkte, „Nur melden“
meldete die eigene Oberfläche hundertfach, „sperren“ hätte sie gesperrt. Die
Regel in CrowdSec abzuschalten geht nicht: `RemoveOutBandRuleByID(920430)` und
`RemoveInBandRuleByID` wirken bei den CRS-Regeln weder in `on_load` noch in
`pre_eval` (geprüft mit 1.8.2). Eine AppSec-Konfiguration, die `acquis.d`
nennt, die es aber nicht gibt, beendet CrowdSec beim Start (`fatal`). Ändert
sich die SPOE-Datei mit einem Update, lädt `lib/bootstrap.ts` HAProxy neu
(`reloadForCrowdsec`), sonst gälte sie erst nach dem nächsten Vorgang.
Nebenbei: der Bouncer gibt das Argument `url` als Adresse an die WAF weiter, bei
HTTP/2 und HTTP/3 ist das die volle Form (`https://host/pfad`). Das löst keine
Regel aus.

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
Mehrere Änderungen hintereinander teilen sich deshalb einen Neustart (siehe
„Änderungen laufen in einer Warteschlange").

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
  (links schmal Status, Statistik und System, rechts breit die geschützten
  Ziele mit dem Schalter für alle im Kopf der Karte), Sperren (aktive
  Entscheidungen, aufheben, Adresse von Hand sperren), Freigaben (hinzufügen,
  entfernen, eigene Adresse), Ereignisse (Filter nach Ziel, „CrowdSec leeren"),
  Regeln. Woher der Schutz eines Ziels kommt, steht einmal über der Liste
  („Alle Ziele prüfen ist an"), nicht in jeder Zeile. Prüft CrowdSec kein
  Ziel, steht das mittig in der Karte.
- **Gründe in Worten:** Ereignisse, Sperren und die Rangliste der Statistik
  nennen statt `anomaly score out-of-band: lfi: 5, …` oder
  `crowdsecurity/http-probing` eine Beschreibung („Zugriff auf Dateien des
  Servers"), Erklärung und Name bei CrowdSec stehen hinter dem „i"
  (`lib/crowdsec/describe.ts`, `components/crowdsec/AlertReason.tsx`). Ein
  unbekannter Name erscheint, wie er ist, statt geraten zu werden; Gründe von
  Hand bleiben immer wörtlich. Die API und MCP liefern weiter die Namen von
  CrowdSec. Bei OWASP ergibt dieselbe Kategorie mit anderer Punktzahl einen
  anderen Namen, die Rangliste fasst sie in Worten zu einer Zeile zusammen.
- **Je Ziel** der Schalter „CrowdSec (WAF)" im Dialog des Ziels, eine Marke auf
  der Karte und die Ereignisse des Ziels.
- **Logs:** dritter Reiter „CrowdSec", das Log des Containers von CrowdSec oder
  des Bouncers.
- **Statistik:** zweiter Reiter „CrowdSec": Ereignisse je Stunde oder Tag nach
  Art (WAF, Szenario, von Hand), häufigste Szenarien, Länder, Quellen, Ziele,
  Pfade, aktive Sperren, Größe der Community-Blocklist.
- **Übersicht:** Kennzahlen und Zeilen zu CrowdSec.
- **Updates:** beide Abbilder lassen sich wie HAProxy aktualisieren.
- **Benachrichtigungen**, Gruppe „CrowdSec" (nur, wo CrowdSec installiert ist):
  `crowdsec_down`, wenn CrowdSec oder der Bouncer zwei Prüfungen in Folge nicht
  läuft. Gemeldet wird nur, solange CrowdSec ein Ziel schützt, denn dann lässt
  HAProxy die Anfragen ungeprüft durch (fail-open). `crowdsec_report` einmal am
  Tag nach dem Lauf von acme.sh, mit Zahlen, häufigsten Regeln, Adressen und
  Zielen der letzten 24 Stunden, nur wenn es ein Ereignis gab. Vorgabe: Ausfall
  an, Tagesbericht aus (`lib/notifications/checks.ts`).
- **Interne API** unter `/api/internal/crowdsec`: `GET /`, `GET`/`POST`/`DELETE`
  `decisions`, `GET`/`POST`/`DELETE` `allowlist`,
  `GET alerts?window=24h|7d|30d&service=`, `DELETE alerts` (leeren),
  `GET stats?window=`,
  `GET`/`PATCH` `rules`. Siehe [`hapm-api.md`](hapm-api.md).
- **MCP:** `get_crowdsec`, `list_crowdsec_decisions`, `add_crowdsec_decision`,
  `remove_crowdsec_decision`, `list_crowdsec_allowlist`,
  `add_crowdsec_allowlist`, `remove_crowdsec_allowlist`,
  `list_crowdsec_alerts`, `clear_crowdsec`, `get_crowdsec_stats`,
  `get_crowdsec_rules`, `update_crowdsec_rules`. Siehe [`mcp.md`](mcp.md).

Alle drei rufen dieselben Funktionen in `lib/crowdsec/actions.ts`, die auch das
Audit schreiben.

## Leeren

„CrowdSec leeren" (Reiter Ereignisse, `DELETE alerts`, `clear_crowdsec`,
`clearCrowdsec` in `lib/crowdsec/actions.ts`) ist der frische Start: alle
Ereignisse weg, die Sperren, die CrowdSec daraus verhängt hat, aufgehoben,
Statistik und Zähler bei null. Es bleiben die Sperren von Hand, die Freigaben,
die Regeln und die Gemeinschaftsliste. Die Reihenfolge ist nicht beliebig:

1. **Sperren aufheben** (`cscli decisions delete --origin crowdsec`, je
   Herkunft außer `cscli`, `cscli-import`, `CAPI`, `lists`). Das setzt nur
   ihr Ende auf jetzt, die Zeile bleibt in der Datenbank.
2. **Warten, bis jeder laufende Bouncer abgeholt hat** (`last_pull` in
   `cscli bouncers list`, der Bouncer fragt alle 10 s, gewartet wird bis 25 s).
   Ein Bouncer erfährt von einer aufgehobenen Sperre nur, solange ihre Zeile
   noch da ist. Der nächste Schritt nimmt sie ganz weg: wer vorher nicht
   abgeholt hat, sperrt die Adresse weiter, obwohl die Sperrliste leer ist
   (nachgestellt mit 1.8.2 über `/v1/decisions/stream`). Holt der Bouncer
   nicht ab, bricht das Leeren mit 409 ab, die Ereignisse stehen noch da, und
   der nächste Versuch wartet wieder.
3. **Ereignisse entfernen** mit `cscli alerts delete --scope Ip` (und
   `Range`, je nachdem, was noch da ist). `alerts delete` kennt keinen Filter
   nach Herkunft. `--all` nähme auch die Ereignisse mit, an denen die
   Gemeinschaftsliste hängt (Quelle `CAPI`, `lists`), und die holt CrowdSec
   erst nach einem Neustart wieder vollständig.
4. **Sperren von Hand neu setzen.** Schritt 3 nimmt sie mit ihrem Ereignis
   weg, deshalb merkt sich HAPM sie vorher (`bansToRestore`) und setzt sie mit
   Restdauer und Grund neu. In der Liste stehen sie danach mit dem Zeitpunkt
   des Leerens. Was sich nicht neu setzen ließ, nennt die Antwort (`lost`).

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

**Die Community-Blocklist ist bei einer neuen Installation leer.** Die Central
API liefert sie nicht sofort: im Log von CrowdSec steht dann
`capi/community-blocklist : received 0 new entries (expected if you just installed crowdsec)`,
und `cscli decisions list -a --origin CAPI` zeigt nichts, obwohl
`cscli capi status` in Ordnung ist. CrowdSec fragt alle zwei Stunden erneut.
Die Oberfläche zeigt solange 0 und sagt das hinter dem „i" an der Zahl. Mit
„CrowdSec leeren" hat es nichts zu tun: das lässt die Liste stehen.

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

**Ganz, in der Oberfläche:** „CrowdSec abschalten“ oben auf der Seite CrowdSec,
wieder einschalten unter System, Allgemein, Reiter „CrowdSec“ (oder auf der
Seite selbst, die bleibt über die Adresse erreichbar). `setCrowdsecEnabled` in
`lib/crowdsec/actions.ts`, auch über `PATCH /api/internal/crowdsec` und das
MCP-Werkzeug `set_crowdsec_enabled`.

- Aus: ein Lauf am Reverse-Proxy nimmt CrowdSec aus `haproxy.cfg`, global und
  aus jedem Ziel (`crowdsecRemoveAll` in `applyGlobalSettings`, auch ein von
  Hand geänderter Block geht mit). Die Antwort kommt **sofort** mit
  `pending: true` und der Kennung des Laufs: er kann hinter einem Zertifikat
  anstehen, und eine Anfrage, die so lange wartet, schnitte HAProxy nach 50
  Sekunden ab, während der Lauf später trotzdem alles entfernte. **Erst wenn
  der Lauf durch ist**, hält HAPM beide Container an und legt
  `crowdsec/hapm-disabled` an (`finishSwitchOff`). Ob er gelungen ist, sagt die
  Datei und nicht der Status des Laufs: nennt `haproxy.cfg` CrowdSec noch,
  bleibt alles an. Die Oberfläche fragt `GET /api/crowdsec`, bis
  `status.switching` aus ist.
- Der Lauf trägt `fromFile`: HTTPS-Zeilen und Admin-IPs bleiben, wie sie beim
  Lauf in der Datei stehen. Mit den Werten vom Zeitpunkt der Anfrage schriebe
  er eine Änderung zurück, die davor in der Warteschlange stand.
- **Solange CrowdSec nicht eingeschaltet ist oder gerade abgeschaltet wird,
  nimmt kein Ziel es an** (`assertCrowdsecAvailable` in `provision.ts`, vor dem
  Lauf und im Lauf unter der Sperre, für Oberfläche, API und MCP). Sonst
  schriebe ein Vorgang, der hinter dem Abschalten ansteht, die Zeilen wieder
  hinein. Ein Update der beiden Container wird dann ebenfalls abgelehnt.
- **Steht CrowdSec noch in `haproxy.cfg`, obwohl es nicht eingeschaltet ist**
  (nach `install.sh --no-crowdsec` ohne vorheriges Ausschalten, nach dem
  Zurückspielen einer älteren Sicherung), nimmt der Abgleich im Scheduler es
  selbst heraus (`dropOrphanedCrowdsec`, höchstens alle sechs Stunden ein
  Versuch). HAProxy wartete sonst bei jeder Anfrage auf einen Bouncer, den es
  nicht gibt.
- Die Marke ist eine Datei und kein Feld in der Datenbank, weil
  `crowdsecInstalled()` an vielen Stellen ohne `await` gefragt wird. Mit Marke
  ist es `false`: Seitenleiste, Übersicht, Logs, Statistik, Updates,
  Benachrichtigungen, der Schalter im Dialog des Ziels und der Assistent
  blenden CrowdSec aus. `crowdsecPresent()` sagt, ob es trotzdem da ist (für den
  Schalter zum Einschalten, `features.crowdsecPresent`).
- Startet jemand die Container wieder (`docker compose up -d` bei einem
  Update), hält der Abgleich im Scheduler sie wieder an (`keepCrowdsecStopped`).
- An: Marke weg, Dateien schreiben, Container starten. Startet einer nicht,
  bleibt CrowdSec abgeschaltet, mit dem Grund in der Meldung. Halten die
  Container vom Abschalten gerade noch an (bis zu einer halben Minute je
  Container), wird das Einschalten abgelehnt statt mittendrin gestartet. Welche
  Ziele geprüft werden, bleibt aus. Sperren, Freigaben und Regeln liegen im
  Datenordner und gelten wieder.

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
