# Hochverfügbarkeit: Abgleich zwischen Knoten

**Lies das, bevor du an `lib/sync/`, `app/api/sync/`, `app/(app)/abgleich/` oder
an `withProxyLock` in `lib/haproxy/provision.ts` etwas änderst.**

HAPM bleibt „eine Maschine, und zwar diese". Hochverfügbarkeit heißt deshalb
nicht, dass ein HAPM mehrere Server verwaltet, sondern: zwei (oder mehr)
vollständige Installationen, von denen eine der **Hauptknoten** ist und die
anderen **Folgeknoten**. Am Hauptknoten wird geändert. Er überträgt nach jeder
Änderung, was HAProxy zum Ausliefern braucht, an die Folgeknoten. Fällt er aus,
liefert ein Folgeknoten mit demselben Stand weiter aus.

Ohne Einrichtung ändert sich nichts: die Vorgabe ist „einzeln", und ein
einzelner Knoten spricht mit keinem anderen.

**Was HAPM dabei nicht tut:** die gemeinsame Adresse umschalten. Wer sie gerade
hält, regelt keepalived (VRRP) auf den Servern oder ein Load Balancer davor,
siehe „Die gemeinsame Adresse".

## Einrichten

1. Beide Server normal installieren. Auf dem zweiten reicht das Konto, Ziele
   braucht er nicht: der erste Abgleich ersetzt seine Konfiguration.
2. **Zweiter Knoten:** „Abgleich", Reiter „Rolle", „Folgeknoten" wählen. Danach
   im Reiter „Zustand" einen Kopplungsschlüssel erzeugen. Er wird einmal gezeigt.
3. **Erster Knoten:** „Abgleich", Reiter „Rolle", „Hauptknoten" wählen. Im
   Reiter „Zustand" „Folgeknoten hinzufügen": Adresse der Oberfläche des
   zweiten Knotens (`http://10.0.0.2:7080`) und den Kopplungsschlüssel.
   Gespeichert wird erst, wenn der zweite Knoten mit diesem Schlüssel
   geantwortet hat. Der erste Abgleich beginnt gleich danach.
4. Die gemeinsame Adresse einrichten (keepalived oder Load Balancer).

**Die Adresse eines Folgeknotens** ist die seiner Oberfläche, am einfachsten
direkt mit Port 7080. Über HTTPS und eine Domain geht es nur, wenn der
Hauptknoten ein Ziel für diese Domain trägt: nach dem Abgleich hat der
Folgeknoten dessen `haproxy.cfg` und keine eigene mehr. `http` ist dafür in
Ordnung, siehe „Kopplung und Transport". Steht ein Proxy zwischen den Knoten
(`HTTPS_PROXY`, `NODE_USE_ENV_PROXY`), gehört die Adresse des Folgeknotens in
`NO_PROXY`.

Die Uhren beider Knoten müssen stimmen (NTP): eine Anfrage, die mehr als fünf
Minuten abweicht, wird abgelehnt.

## Was übertragen wird

Die Regel heißt **alles außer einer kurzen Ausschlussliste** (`EXCLUDED` in
`lib/sync/bundle.ts`), nicht „diese Ordner". Ein Ordner, den eine spätere
Fassung unter `/etc/haproxy` anlegt, geht damit von selbst mit.

| Ordner | Was mitgeht | Was nicht, und warum |
|---|---|---|
| `/etc/haproxy` | `haproxy.cfg`, `certs/`, `errors/` (samt `.hapm-previous` und `.hapm-original`), `hapm-lock/`, `hapm-geo/`, `hapm-crowdsec/allow.lst`, jeder weitere Ordner | `haproxy.cfg.backup-*` (Sicherungskopien jedes Schreibvorgangs), `*.hapm-new` (vorläufige Dateien), `*.hapm-previous` in der obersten Ebene (Zwischenstände beim Hochladen), `.hapm-*` (Ordner von Zurückspielen und Abgleich), `hapm-crowdsec/spoe.cfg` (schreibt jeder Knoten bei seinem Start selbst) |
| `/root/.acme.sh` | `account.conf`, `ca/`, die Ordner der Zertifikate mit ihren Erneuerungseinträgen, die TSIG-Schlüsseldatei eines DNS-Hooks | `acme.sh`, `acme.sh.env`, `dnsapi/`, `deploy/`, `notify/` (das Programm installiert und aktualisiert jeder Knoten selbst, und HAPM führt es als root aus), `http.header` |

Verweise und Sonderdateien (Sockets) gehen nie mit. Was übergangen wurde,
steht als Hinweis am Folgeknoten.

Der Folgeknoten ist danach ein **Abbild**: was der Hauptknoten nicht mehr hat
(ein entferntes Zertifikat), gibt es dort auch nicht mehr. Was auf der
Ausschlussliste steht, bleibt beim Folgeknoten liegen, wie es ist.

**Die Datenbank wird nicht übertragen**, und `secrets.json` auch nicht. Jeder
Knoten hat seinen eigenen `encryptionKey`: was verschlüsselt in der Datenbank
liegt, wäre auf dem anderen nicht lesbar. Was das je Punkt heißt:

| In der Datenbank | Auf dem Folgeknoten |
|---|---|
| Gespeicherte Ziele (Eingabehilfe) | Nicht da. Sie stehen in keiner Zeile von `haproxy.cfg`, und die Dialoge, die sie anbieten, sind dort gesperrt. |
| Design der Fehlerseiten, Darstellung | Die fertigen Seiten kommen mit (`errors/`, `hapm-lock/`), das Design nicht. Die Seite „Fehlerseiten" vergleicht dort mit dem eigenen gespeicherten Design und zeigt deshalb womöglich Abweichungen. Ändern lässt sich dort nichts. |
| DNS-Zonen (Tokens) | Nicht da. Für Zertifikate über DNS-01 braucht es sie nicht: die Zugangsdaten von acme.sh stehen in `account.conf`, und die kommt mit. Soll HAPM nach einer Beförderung wieder Einträge setzen, werden die Zonen dort neu angebunden. |
| Art der Installation, Herkunft der Zertifikate, ACME-Server | Je Knoten eingestellt. Die Art der Installation wird verglichen und als Hinweis gezeigt. Vor einer Beförderung auf denselben Stand bringen. |
| Konten, API-Keys, SMTP, Benachrichtigungen, Sicherung | Je Knoten. |
| Statistik, Protokoll, Historie | Je Knoten: jeder zählt, was er selbst ausliefert und tut. |

Wer einen Folgeknoten als vollständige Kopie braucht (Konten, Einstellungen),
spielt dort vor der Kopplung eine Sicherung des Hauptknotens ein und stellt
**danach als Erstes die Rolle um**. Eine zurückgespielte Sicherung bringt die
Rolle „Hauptknoten" samt eingetragener Folgeknoten mit.

## Kopplung und Transport: `lib/sync/envelope.ts`

Ein Paket trägt die privaten Schlüssel aller Zertifikate, und ein Folgeknoten
ist oft nur über `http://…:7080` erreichbar. Der Schutz hängt deshalb nicht an
der Leitung:

- **Der Kopplungsschlüssel** (`hapmsync_…`, 256 Bit) entsteht auf dem
  Folgeknoten, wird dort einmal gezeigt und auf dem Hauptknoten eingetragen.
  Beide halten ihn verschlüsselt (`lib/crypto.ts`). Ein Hash wie bei den
  API-Keys reicht nicht: mit dem Schlüssel wird entschlüsselt.
- **Jede Anfrage und jede Antwort ist verschlüsselt und gegen Veränderung
  gesichert** (AES-256-GCM), mit Schlüsseln, die per HKDF aus dem
  Kopplungsschlüssel entstehen (einer für die Kopfzeile, einer für Anfragen,
  einer für Antworten). Die Antwort ist an den Einmalwert der Anfrage
  gebunden: der Hauptknoten weiß damit, dass der richtige Knoten geantwortet
  hat.
- **Die Kopfzeile `X-Hapm-Sync`** trägt Zeit, Einmalwert, Art, Länge und einen
  MAC darüber. Sie wird geprüft, bevor der Rumpf gelesen wird: GCM sagt erst am
  Ende, ob etwas stimmt, und ein Fremder soll keinen Rumpf von vielen Megabyte
  abladen können.
- **Gegen Wiedereinspielen:** die Zeit darf fünf Minuten abweichen, ein
  Einmalwert gilt einmal (im Speicher), und ein Folgeknoten nimmt kein Paket,
  dessen laufende Nummer nicht größer ist als die des zuletzt übernommenen
  (in der Datenbank, übersteht also einen Neustart).
- **Mit HTTPS** wird das Zertifikat des Folgeknotens zusätzlich wie üblich
  geprüft. Eine eigene CA dafür kennt Node nur über `NODE_EXTRA_CA_CERTS`.

**Der Endpunkt** ist `POST /api/sync/node` (`lib/sync/receive.ts`): die einzige
Route, die ohne Sitzung und ohne API-Key auskommt und trotzdem die
Konfiguration ersetzen kann. Er steht nicht unter `/api/internal` (dort
verlangt `tests/security/internal-api.test.ts` ein Service-Token). Die
Reihenfolge seiner Prüfungen hält `tests/security/sync-api.test.ts` fest:
Fehlversuche (20 je Adresse und Stunde, dann `429`), Kopfzeile, Länge (ein
Paket höchstens 96 MB, eine Frage 16 KB), Einmalwert, erst dann der Rumpf. Wer
den Schlüssel nicht zeigt, bekommt immer dieselbe Absage (`401`), auch wenn
hier gar keiner gesetzt ist.

Zwei Arten von Anfragen: `status` (die Auskunft, `NodeReport`) und `apply`
(ein Paket).

## Anwenden auf dem Folgeknoten: `lib/sync/apply.ts`, `apply-core.ts`

1. **Annehmen.** Das Paket wird ausgepackt und jede Angabe geprüft
   (`unpack`): nur Dateien und Ordner, kein `..`, kein absoluter Pfad, nichts
   von der Ausschlussliste, jede Prüfsumme. Dann die Absagen, siehe unten. Die
   Anfrage des Hauptknotens endet hier: angewendet wird abgekoppelt, weil das
   Neuladen eine Minute dauern kann und eine Anfrage über das HAProxy des
   Knotens nach 50 Sekunden abgeschnitten würde. Den Stand fragt der
   Hauptknoten über die Auskunft.
2. **Anpassen** (`adapt.ts`): nur CrowdSec hängt am Knoten, siehe „CrowdSec".
3. **Bereitlegen** nach `.hapm-sync-new` in jedem Ordner, **tauschen** (der
   alte Stand geht nach `.hapm-sync-old`), **prüfen** (`haproxy -c`), **neu
   laden** (`hapm-reload`). Erst tauschen, dann prüfen: `haproxy.cfg` nennt
   Zertifikate und Fehlerseiten mit festen Pfaden. Derselbe Gedanke wie beim
   Zurückspielen einer Sicherung.
4. **Lehnt HAProxy ab oder lädt nicht neu, kommt der alte Stand zurück**, und
   ein zweites Neuladen stellt sicher, dass er gilt. Die Meldung von HAProxy
   steht im Lauf auf beiden Knoten.
5. Liegt der Stand schon so vor, wird nichts getauscht und nicht neu geladen.

Alles hinter der Sperre der Läufe (`withProxyLockLocal`). Wird HAPM mitten im
Tausch beendet, liegt `.hapm-sync-old` noch da: beim nächsten Start
(`reconcileSync`) und vor jedem Anwenden kommt dann der alte Stand zurück.

**Ein Folgeknoten lehnt ein Paket ab,** wenn

- er kein Folgeknoten ist (`not_replica`),
- es von einem anderen Hauptknoten kommt als dem, von dem der erste Stand kam
  (`other_primary`). Ein neuer Kopplungsschlüssel löst die Bindung,
- es nicht neuer ist als das zuletzt übernommene (`stale`),
- gerade eines angewendet wird (`busy`).

Die ersten beiden heißen, dass zwei Knoten sich für den Hauptknoten halten. Sie
stehen danach auf der Seite „Abgleich" des ablehnenden Knotens, im Protokoll
(`sync_rejected`), und der sendende Hauptknoten meldet sie als gescheiterten
Abgleich.

## Was ein Folgeknoten nicht tut: `lib/sync/role.ts`

Er ändert nichts an dem, was der Abgleich überschreibt: Ziele,
TCP-Weiterleitungen, Gruppen, Einstellungen des Proxys, Zertifikate (ausstellen,
hochladen, entfernen), Fehlerseiten, Grundkonfiguration, Import,
DNS-Zugangsdaten von acme.sh, Freigaben von CrowdSec.

Gesperrt ist das an zwei Stellen, die jeder Weg nimmt (Oberfläche, API, MCP,
Scheduler), nicht in den Routen:

- `startHaproxyRun`: auf einem Folgeknoten entsteht kein Lauf, die Absage (`409`)
  geht an den Aufrufer.
- `withProxyLock`: unter der Sperre, für alles, was ohne Lauf schreibt, und
  noch einmal für die Läufe (die Rolle kann zwischen Anfrage und Lauf gewechselt
  haben).

Was ein Folgeknoten an sich selbst tut, nimmt `withProxyLockLocal` und steht
dort mit Grund: den Stand einsetzen, HAProxy nach einer neuen SPOE-Datei neu
laden, CrowdSec aus der eigenen Datei nehmen (`isLocalCrowdsecRemoval`). Still
ausgelassen werden das Nachziehen der Länderlisten und der Freigaben (sie
kommen mit dem Abgleich), das Nachziehen der Fehlerseiten beim Start, die
Anmeldung einer eigenen Adresse bei acme.sh und **die tägliche Erneuerung**
(`acme.sh --cron`): erneuert wird nur auf dem Hauptknoten.

Updates, Sicherung, Benutzer, Benachrichtigungen, Statistik und Logs bleiben je
Knoten bedienbar. Über den Seiten des Proxys steht ein Hinweis
(`components/ReplicaNotice.tsx`, aus `session.features.replica`).

## Wann abgeglichen wird: `lib/sync/send.ts`

- **Nach jedem Vorgang am Proxy.** `withProxyLock` ruft am Ende den Anstoß
  (`onProxyChange`, vom Scheduler gesetzt), gleich ob der Vorgang etwas
  geschrieben hat. Drei Sekunden später und zusammengefasst.
- **Nach dem täglichen Lauf von acme.sh**: eine Erneuerung über den
  Deploy-Hook geht an keiner Sperre vorbei.
- **Alle fünf Minuten** (Scheduler).
- **„Jetzt abgleichen"** (Seite, `POST /api/internal/sync`, `start_sync`).

Die ersten drei fragen jeden Folgeknoten nach seinem Stand und übertragen nur,
wenn der Fingerabdruck abweicht (SHA-256 über Pfade und Inhalte, ohne Rechte
und Zeitstempel), wenn er das Paket inzwischen anders anpassen würde (CrowdSec
wurde dort ein- oder ausgeschaltet) oder wenn dort jemand Dateien geändert
hat. Der letzte Grund höchstens einmal je Stunde: schreibt dort etwas dauerhaft
dazwischen, wäre das sonst ein Abgleich alle fünf Minuten. Der Knopf überträgt
immer.

**In der Historie** steht ein Lauf nur, wenn etwas übertragen wurde oder ein
Folgeknoten neu ausfällt. Derselbe Fehler bei jeder Prüfung ist eine Zeile,
nicht 288 am Tag. Ein gescheiterter Abgleich hält nichts auf: er steht am
Folgeknoten, im Protokoll (`sync_failed`) und geht als Mail hinaus (Ereignis
`sync_failed`, je Folgeknoten höchstens einmal am Tag).

## Vergleich: `lib/sync/compare.ts`

Vor jedem Abgleich und vor dem Eintragen eines Folgeknotens.

**Abgelehnt** wird, was sicher falsch ist: die Gegenstelle ist selbst
Hauptknoten oder arbeitet einzeln, sie ist an einen anderen Hauptknoten
gebunden, die Adresse führt zu diesem Knoten selbst (die gemeinsame Adresse
statt der des Folgeknotens), eine andere Fassung des Abgleichs
(`SYNC_PROTOCOL`).

**Ein Hinweis** ist: eine andere Fassung von HAPM oder HAProxy, eine andere Art
der Installation, CrowdSec dort nicht eingeschaltet. Ob eine neuere
`haproxy.cfg` auf einem älteren HAProxy lädt, lässt sich aus zwei
Versionsnummern nicht sagen. Das entscheidet dort `haproxy -c`, und lehnt es
ab, bleibt dort der alte Stand und der Abgleich meldet den Grund.

### CrowdSec

Der Bouncer, den HAProxy je Anfrage fragt, läuft im Stack des jeweiligen
Knotens, und Sperren, Regeln und der Schalter für OWASP gehören dem CrowdSec
dieses Knotens. Sie werden nicht abgeglichen.

- **Ist CrowdSec auf dem Folgeknoten nicht eingeschaltet** (abgewählt oder
  abgeschaltet), die Konfiguration benutzt es aber, nimmt der Folgeknoten die
  Zeilen beim Anwenden heraus. HAProxy ließe die Anfragen sonst zwar durch
  (fail-open, [`crowdsec.md`](crowdsec.md)), wartete aber bei jeder rund eine
  Sekunde. Das ist dieselbe Funktion, mit der ein einzelner Knoten in dieser
  Lage CrowdSec selbst aus seiner Datei nimmt. **Die Ziele laufen dort dann
  ohne WAF**, und beide Seiten zeigen das als Warnung.
- Wird CrowdSec dort später eingeschaltet, bemerkt der Hauptknoten das bei
  seiner nächsten Prüfung und überträgt erneut.
- Der Port des Bouncers (`HAPM_SPOA_PORT`) wird auf den des Folgeknotens
  gesetzt.
- **Freigaben:** `hapm-crowdsec/allow.lst` kommt vom Hauptknoten. HAProxy fragt
  CrowdSec für diese Adressen gar nicht erst, also auch dort nicht. Die Liste
  der Freigaben in der Oberfläche des Folgeknotens zeigt sie nicht (sie liest
  sein eigenes CrowdSec) und lässt sich dort nicht ändern.
- **Ausnahmen für Anwendungen** (`# hapm-app:`) gleicht der Folgeknoten nach
  jedem übernommenen Stand selbst ab (`queueAppSync`).

## Beförderung: wenn der Hauptknoten ausfällt

Solange der Hauptknoten nur kurz fehlt, ist nichts zu tun: der Folgeknoten
liefert aus, was er hat. Geändert und erneuert wird in der Zeit nicht.

Bleibt er länger weg:

1. Auf dem Folgeknoten „Abgleich", „Rolle": **Hauptknoten** (oder „Einzeln").
   Ab dann wird dort geändert, und die tägliche Erneuerung läuft dort. Konto
   und Erneuerungseinträge von acme.sh hat er aus dem Abgleich.
2. Art der Installation und ACME-Server unter „Allgemein" prüfen, DNS-Zonen
   bei Bedarf neu anbinden.
3. **Bevor der alte Hauptknoten zurückkommt**, muss er Folgeknoten werden:
   dort die Rolle umstellen, einen Kopplungsschlüssel erzeugen und ihn auf dem
   neuen Hauptknoten eintragen. Kommt er vorher zurück, überschreibt er
   nichts: sein Abgleich wird abgelehnt („ist selbst Hauptknoten"), steht auf
   beiden Seiten und geht als Mail hinaus. Er liefert aber seinen alten Stand
   aus, sobald er die gemeinsame Adresse wieder hält (deshalb `nopreempt`
   unten).

## Die gemeinsame Adresse

HAPM und HAProxy laufen im Netz des Hosts (`network_mode: host`). Eine Adresse,
die keepalived dem Server gibt, sieht HAProxy deshalb wie jede andere: `bind
:443` aus der Grundkonfiguration gilt auch für sie. Ein Beispiel für
keepalived auf beiden Servern (auf dem Host installiert, nicht im Stack). **Es
ist ein Ausgangspunkt, HAPM richtet es nicht ein und prüft es nicht:**

```
vrrp_script hapm_haproxy {
    # Nimmt HAProxy auf 443 Verbindungen an? Ohne zusätzliches Programm.
    script "/bin/bash -c '</dev/tcp/127.0.0.1/443'"
    interval 2
    fall 2
    rise 2
}

vrrp_instance HAPM {
    state BACKUP              # auf beiden: wer die Adresse hat, behält sie
    nopreempt
    interface eth0
    virtual_router_id 51
    priority 150              # auf dem Folgeknoten 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass geheim
    }
    virtual_ipaddress {
        203.0.113.10/24
    }
    track_script {
        hapm_haproxy
    }
}
```

- **`nopreempt`**, damit ein zurückkehrender Knoten die Adresse nicht sofort
  wieder an sich zieht, womöglich mit einem alten Stand.
- **Binden an eine bestimmte Adresse.** Wer in `haproxy.cfg` von Hand an die
  gemeinsame Adresse bindet statt an alle, braucht auf beiden Servern
  `net.ipv4.ip_nonlocal_bind=1`. Sonst lädt HAProxy auf dem Knoten, der sie
  gerade nicht hält, nicht neu, und der Abgleich meldet genau das.
- **Ein Load Balancer davor** (statt keepalived) prüft die Knoten selbst und
  braucht hier nichts. Die Admin-IPs und der Zugriffsschutz sehen dann seine
  Adresse, nicht die des Besuchers.
- Die DNS-Einträge der Ziele zeigen auf die gemeinsame Adresse.

## Grenzen

- **HAPM schaltet die Adresse nicht um** und weiß nicht, wer sie hält.
- **Kein geteilter Zustand in HAProxy:** Stick-Tables, Sitzungsbindung über
  Tabellen, Zähler der Anfragebegrenzung und offene Verbindungen gibt es je
  Knoten. Die Sitzungsbindung über den Cookie `HAPMSRV` trägt, weil sie im
  Cookie steht und die Namen der Ziele auf beiden Knoten dieselben sind. Eine
  Passwortsperre gilt auf beiden: Hash und Cookie-Wert stehen in den
  abgeglichenen Dateien. Die Zähler der Fehlversuche führt jeder Knoten selbst.
- **Sperren und Regeln von CrowdSec je Knoten**, siehe oben. Eine Adresse, die
  der eine sperrt, sperrt der andere nicht von selbst.
- **Statistik, Logs, Protokoll und Historie je Knoten.**
- **Die Datenbank wird nicht abgeglichen**, siehe „Was übertragen wird".
- **HTTP-01 nur dort, wo die Adresse gerade liegt.** Let's Encrypt erreicht
  den Knoten, der die gemeinsame Adresse hält. acme.sh antwortet auf dem
  Hauptknoten. Hält der Folgeknoten die Adresse, scheitern Anträge und
  Erneuerungen über HTTP-01, bis sie zurück ist oder er befördert wurde.
  DNS-01 hängt nicht daran.
- **Die Oberfläche hinter der gemeinsamen Adresse** ist die des Knotens, der
  sie hält, mit dessen Konten. Den Hauptknoten zum Ändern über seine eigene
  Adresse ansprechen.
- **Zwischen zwei Abgleichen** (Sekunden nach einer Änderung, bis zu fünf
  Minuten nach einem Fehler) trägt der Folgeknoten den vorigen Stand.
- **Ein Abgleich überträgt immer alles**, nicht nur die Änderung. Ein Proxy mit
  tausend Zertifikaten liegt bei wenigen Megabyte.

## API und MCP

`GET /api/internal/sync` (Rolle, Folgeknoten mit Zustand, Läufe),
`POST /api/internal/sync` („Jetzt abgleichen", Antwort `runId`),
`GET /api/internal/sync/runs/<id>`. Als Werkzeuge `get_sync`, `start_sync`,
`get_sync_run`. Rolle, Kopplungsschlüssel und Gegenstellen gibt es über einen
Key nicht ([`mcp.md`](mcp.md), „Was es bewusst nicht gibt").

Auf einem Folgeknoten lehnt jede schreibende Route und jedes schreibende
Werkzeug des Reverse-Proxys mit `409` ab.

## Für den, der es ändert

| Datei | Was dort steht |
|---|---|
| `lib/sync/types.ts` | Rollen, `NodeReport`, Warnungen. Rein, die Seite importiert es. |
| `lib/sync/envelope.ts` | Kopplungsschlüssel, Umschlag, Kopfzeile, Einmalwerte. Rein. |
| `lib/sync/bundle.ts` | Ausschlussliste, Einsammeln, Fingerabdruck, Packen, Auspacken mit Prüfung. Nur `fs`. |
| `lib/sync/swap.ts` | Bereitlegen, tauschen, zurücktauschen, Abbruch zurücknehmen. Nur `fs`. |
| `lib/sync/adapt.ts` | `haproxy.cfg` an den Folgeknoten anpassen (CrowdSec). Rein. |
| `lib/sync/apply-core.ts` | Der Ablauf des Anwendens, Prüfen und Neuladen als Funktionen hereingereicht. |
| `lib/sync/apply.ts` | Annehmen, Absagen, Anwenden hinter der Sperre, Lauf und Protokoll. |
| `lib/sync/receive.ts` | Der Endpunkt für andere Knoten und seine Prüfungen. |
| `lib/sync/compare.ts` | Absagen, Hinweise, „trägt den Stand". Rein. |
| `lib/sync/send.ts` | Packen, senden, abwarten, Runden, Anstoß. |
| `lib/sync/role.ts` | Die Rolle und die Sperre für Folgeknoten. Klein, `provision.ts` importiert es. |
| `lib/sync/store.ts` | Collections `sync_settings`, `sync_peers`, `sync_runs`. |
| `lib/sync/actions.ts` | Was Seite, API und MCP gemeinsam rufen, samt Protokoll. |

- **Ein neuer Ordner unter `/etc/haproxy`** geht von selbst mit. Führt ihn
  jeder Knoten selbst (aus eigenem Code oder eigener Datenbank geschrieben),
  gehört er auf die Ausschlussliste, sonst überschreiben sich Abgleich und
  Knoten gegenseitig.
- **Ein neuer Schreibweg an `haproxy.cfg` oder ihren Dateien** nimmt
  `withProxyLock`. Dann ist er auf Folgeknoten gesperrt und stößt den Abgleich
  an, ohne dass er davon weiß.
- **Was sich am Umschlag, am Paket oder an der Auskunft ändert,** hebt
  `SYNC_PROTOCOL`: zwei Knoten mit verschiedenen Zahlen gleichen nicht ab.

## Prüfen

- `tests/sync/`: Umschlag (`envelope`), Paket samt bösartiger Pfade
  (`bundle`), Tausch und Zurücktauschen (`apply`), Absagen des Folgeknotens
  (`accept`), der Endpunkt über echtes HTTP (`receive`), Vergleich und
  Anpassung (`compare`), die Sperre auf Folgeknoten (`guard`).
- `tests/security/sync-api.test.ts`: Sitzung und CSRF der Routen der
  Oberfläche, Reihenfolge der Prüfungen am Endpunkt für Knoten.
- **`pnpm sync:verify`** (`scripts/verify-sync.ts`, braucht Docker): der Stand
  eines Hauptknotens, erzeugt wie im Betrieb, wird auf den Ordner eines
  laufenden HAProxy angewendet. Geprüft wird, was nur HAProxy zeigt: es liefert
  danach mit dem neuen Zertifikat und der neuen Fehlerseite aus, ein Stand, den
  `haproxy -c` ablehnt, hinterlässt Datei für Datei den alten, ein Stand, mit
  dem es nicht neu lädt, ebenso, und ohne CrowdSec nimmt es die Datei ohne die
  Zeilen an.

Nicht automatisch geprüft ist der ganze Weg zwischen zwei vollständigen Stacks
(zwei Server mit Docker, HAProxy und Postgres) und das Umschalten der Adresse.
