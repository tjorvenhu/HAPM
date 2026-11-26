# Hochverfügbarkeit: Abgleich zwischen Knoten

**Lies das, bevor du an `lib/sync/`, `app/api/sync/`, `app/(app)/abgleich/` oder
an `withProxyLock` in `lib/haproxy/provision.ts` etwas änderst.**

HAPM bleibt „eine Maschine, und zwar diese". Hochverfügbarkeit heißt deshalb
nicht, dass ein HAPM mehrere Server verwaltet, sondern: zwei (oder mehr)
vollständige Installationen, von denen eine der **Hauptknoten** ist und die
anderen **Folgeknoten**. Am Hauptknoten wird geändert. Er überträgt nach jeder
Änderung an die Folgeknoten, was HAProxy zum Ausliefern braucht, und dazu, was
man zum Bedienen braucht: Konten, Einstellungen, DNS-Zonen, API-Keys und was in
CrowdSec eingestellt ist. Fällt er aus, liefert ein Folgeknoten mit demselben
Stand weiter aus, und nach einer Beförderung arbeitet man dort mit denselben
Konten und Zugängen weiter.

Ohne Einrichtung ändert sich nichts: die Vorgabe ist „einzeln", und ein
einzelner Knoten spricht mit keinem anderen.

**Was HAPM dabei nicht tut:** die gemeinsame Adresse umschalten. Wer sie gerade
hält, regelt keepalived (VRRP) auf den Servern oder ein Load Balancer davor,
siehe „Die gemeinsame Adresse".

## Einrichten

1. Beide Server normal installieren. Auf dem zweiten reicht das Konto, Ziele
   braucht er nicht: der erste Abgleich ersetzt seine Konfiguration. **Er
   ersetzt auch seine Konten.** Wer am zweiten Knoten angemeldet ist, wird
   dabei abgemeldet und meldet sich mit einem Konto des Hauptknotens neu an.
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

### Der Datenteil: `lib/sync/data.ts`

Im selben Paket geht mit, was nicht in einer Datei steht und trotzdem auf
beiden Knoten gleich sein soll. Auch hier gilt das Abbild: ein Konto, das der
Hauptknoten nicht nennt, gibt es auf dem Folgeknoten danach nicht mehr.

| Was | Was mitgeht | Was je Knoten bleibt |
|---|---|---|
| Konten | Benutzer, Passwort-Hash, zweiter Faktor (TOTP), Passkeys | Sitzungen, offene Links zum Zurücksetzen, letzte Anmeldung, Sprache, der Zähler eines Passkeys |
| Einstellungen | „Allgemein" und „Benachrichtigungen": Adresse von HAPM, Art der Installation, Herkunft der Zertifikate, ACME-Server, Wartezeit bei DNS-01, SMTP-Konto samt Passwort, Absender, Empfänger, Ereignisse, Sprache der Mails (`SYNCED_SETTINGS`) | Selbsttätige Updates und ihre Uhrzeit (zwei Knoten sollen nicht in derselben Minute neu starten), Stand der Einrichtung |
| DNS-Zonen | Anbieter, Zone und der Zugang | Zustand und letzter Fehler beim Anbieter |
| API-Keys | Name, Hash, Freigabeliste der Adressen, ob zurückgezogen. Derselbe Key gilt damit auf beiden Knoten | Wann und von wo er zuletzt benutzt wurde |
| CrowdSec | Sperren von Hand, Freigaben, der Schalter der OWASP-Regeln, zugeschaltete Sammlungen | Was CrowdSec selbst sperrt, Ereignisse, Gemeinschaftsliste, Stand des Hubs, ob CrowdSec eingeschaltet ist |

**Geheimnisse gehen im Klartext in das Paket.** Was verschlüsselt in der
Datenbank liegt (TOTP-Geheimnis, Zugang einer Zone, SMTP-Passwort), ist mit dem
`encryptionKey` des Knotens verschlüsselt, und der ist auf jedem Knoten ein
anderer. Der Hauptknoten entschlüsselt vor dem Packen, der Folgeknoten
verschlüsselt mit seinem eigenen Schlüssel neu. Auf der Leitung schützt der
Umschlag, wie die privaten Schlüssel der Zertifikate im selben Paket.
`secrets.json` wird nie übertragen. Ein Geheimnis, das sich auf dem
Hauptknoten nicht lesen lässt, ist danach auch auf dem Folgeknoten unlesbar,
statt dort stillschweigend zu fehlen (ein zweiter Faktor fiele sonst weg).

**Wiederherstellungscodes gelten nur auf dem Knoten, auf dem sie entstanden.**
Ihre Hashes kommen mit, hängen aber am `encryptionKey` (`lib/recovery-codes.ts`).
Der Code aus der App gilt auf beiden. Nach einer Beförderung unter „Konto"
neue Codes erzeugen.

**Sitzungen bleiben je Knoten**, und sie überstehen einen Abgleich: ein Konto
mit derselben Kennung bleibt dieselbe Zeile. Zwei Ausnahmen: ein Konto, das der
Hauptknoten nicht mehr nennt, ist sofort draußen, und nach einem geänderten
Passwort enden die Sitzungen dieses Kontos auch auf dem Folgeknoten
(`lib/db/account-rows.ts`).

**Nicht im Datenteil** und deshalb je Knoten:

| In der Datenbank | Auf dem Folgeknoten |
|---|---|
| Hinterlegte Backend-Server (Eingabehilfe) | Nicht da. Sie stehen in keiner Zeile von `haproxy.cfg`, und die Dialoge, die sie anbieten, sind dort gesperrt. |
| Design der Fehlerseiten, Darstellung | Die fertigen Seiten kommen mit (`errors/`, `hapm-lock/`), das Design nicht. Die Seite „Fehlerseiten" vergleicht dort mit dem eigenen gespeicherten Design und zeigt deshalb womöglich Abweichungen. Ändern lässt sich dort nichts. |
| Sicherung, Updates, Weiterleitung des Protokolls | Je Knoten eingestellt. |
| Statistik, Logs, Protokoll, Historie | Je Knoten: jeder zählt, was er selbst ausliefert und tut. |

Eine zurückgespielte Sicherung des Hauptknotens bringt die Rolle „Hauptknoten"
samt eingetragener Folgeknoten mit: danach **als Erstes die Rolle umstellen**.

## Kopplung und Transport: `lib/sync/envelope.ts`

Ein Paket trägt die privaten Schlüssel aller Zertifikate, und ein Folgeknoten
ist oft nur über `http://…:7080` erreichbar. Der Schutz hängt deshalb nicht an
der Leitung:

- **Der Kopplungsschlüssel** (`hapmsync_…`, 256 Bit) entsteht auf dem
  Folgeknoten, wird dort einmal gezeigt und auf dem Hauptknoten eingetragen.
  Wer ihn hat, ersetzt auf dem Folgeknoten nicht nur Konfiguration und
  Zertifikate, sondern auch die Konten: er ist so viel wert wie ein Konto dort.
  Was der Abgleich an Konten, Einstellungen, Zonen und API-Keys ändert, steht
  deshalb im Protokoll des Folgeknotens (`sync_applied`).
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

**Der Datenteil wird geprüft wie die Dateien** (`parseSyncData`): jede Zeile
auf ihre Form, kein Zugang und kein Passkey ohne sein Konto, nichts doppelt,
und was die Typen nicht nennen, fällt weg. Ein Datenteil ohne Konto oder ohne
ein Konto mit Passwort lehnt das ganze Paket ab: der Folgeknoten ließe sich
danach nicht mehr bedienen. Die Einstellungen gehen beim Einsetzen durch
dieselbe Prüfung wie eine Eingabe in der Oberfläche (`settingsPatch`).

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
   Ein neues Passwort oder eine neue Sperre lädt HAProxy also nicht neu.
6. **Danach die Daten** (`data-apply.ts`): Einstellungen, Konten, DNS-Zonen,
   API-Keys, CrowdSec, jeder Teil für sich. Scheitert einer, laufen die
   übrigen trotzdem, und der Lauf gilt als gescheitert. Die Daten werden auch
   eingesetzt, wenn HAProxy die Dateien abgelehnt hat: ein entferntes Konto
   soll nicht daran hängen, ob eine `haproxy.cfg` dort lädt. Geschrieben wird
   nur, was abweicht.

Die Schritte 3 bis 5 hinter der Sperre der Läufe (`withProxyLockLocal`). Wird HAPM mitten im
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

Ebenso nichts aus dem Datenteil (`assertDataWritable`): Konten anlegen und
entfernen, Passwort ändern oder zurücksetzen, zweiten Faktor und Passkeys
einrichten oder entfernen, die abgeglichenen Einstellungen, DNS-Zonen anbinden
und entfernen, API-Keys anlegen, ändern und zurückziehen, Sperren von Hand und
die Regeln von CrowdSec. Gesperrt ist das in den Funktionen unter `lib/`
(`lib/auth/users.ts`, `lib/two-factor.ts`, `updateSettings`, `connectZone`,
`addDecision`), bei API-Keys, Passkeys und dem Zurücksetzen des Passworts in
ihren Routen. Die Antwort ist `409` mit dem Grund. Was jeder Knoten für sich
führt, geht weiter: selbsttätige Updates, Sprache, DNS-Einträge bei einem
Anbieter, eine Sperre aufheben, die das CrowdSec dieses Knotens selbst
verhängt hat, den Hub aktualisieren.

**`hapm-admin reset-password` auf einem Folgeknoten** schreibt an HAPM vorbei
in die Datenbank. Der Hauptknoten bemerkt die Abweichung und überträgt seinen
Stand erneut, spätestens nach einer Stunde. Ein Passwort setzt man deshalb auf
dem Hauptknoten zurück. Ist der nicht mehr da: erst befördern.

Für die Dateien ist an zwei Stellen gesperrt, die jeder Weg nimmt (Oberfläche,
API, MCP, Scheduler), nicht in den Routen:

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
- **Nach jeder Handlung an den Daten** (`lib/sync/kick.ts`). Für die Daten gibt
  es keine Sperre, die jeder Weg nimmt, aber jede Handlung schreibt eine Zeile
  ins Protokoll: `logAudit` stößt an, wenn der Bereich der Handlung zu den
  abgeglichenen gehört (Konten, Einstellungen, DNS, API-Keys, CrowdSec).
- **Nach dem täglichen Lauf von acme.sh**: eine Erneuerung über den
  Deploy-Hook geht an keiner Sperre vorbei.
- **Alle fünf Minuten** (Scheduler).
- **„Jetzt abgleichen"** (Seite, `POST /api/internal/sync`, `start_sync`).

Alle außer dem Knopf fragen jeden Folgeknoten nach seinem Stand und übertragen
nur, wenn ein Fingerabdruck abweicht, wenn er das Paket inzwischen anders
anpassen würde (CrowdSec wurde dort ein- oder ausgeschaltet) oder wenn dort
jemand Dateien oder Daten geändert hat. Der letzte Grund höchstens einmal je
Stunde: schreibt dort etwas dauerhaft dazwischen, wäre das sonst ein Abgleich
alle fünf Minuten. Der Knopf überträgt immer.

**Drei Fingerabdrücke** (`compare.ts`, `carriesState`):

- **Dateien:** SHA-256 über Pfade und Inhalte, ohne Rechte und Zeitstempel.
- **Daten:** über alles aus der Datenbank, in fester Reihenfolge und mit den
  Geheimnissen im Klartext (ein Chiffrat ist bei jedem Schreiben ein anderes).
  Nicht dabei, was jeder Knoten für sich führt, etwa der Zähler eines Passkeys:
  eine Anmeldung ist keine Änderung.
- **CrowdSec:** getrennt, weil es sich nicht immer lesen lässt (nach jeder
  Änderung an den Regeln startet es neu). Antwortet es gerade nicht, gilt der
  zuletzt gelesene Stand, und hat es seit dem Start von HAPM nie geantwortet,
  fehlt der Teil im Paket: der Folgeknoten behält dann, was er hat. Von einer
  Sperre zählen Adresse und Zeitpunkt, nicht das Ende: das rechnet HAPM aus der
  Restdauer, die `cscli` nennt, und die schwankt von Aufruf zu Aufruf.

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

**Ein Hinweis** ist: eine andere Fassung von HAPM oder HAProxy, CrowdSec dort
nicht eingeschaltet. Die Art der Installation ist keiner mehr: sie kommt mit
dem Abgleich. Ob eine neuere
`haproxy.cfg` auf einem älteren HAProxy lädt, lässt sich aus zwei
Versionsnummern nicht sagen. Das entscheidet dort `haproxy -c`, und lehnt es
ab, bleibt dort der alte Stand und der Abgleich meldet den Grund.

### CrowdSec

Der Bouncer, den HAProxy je Anfrage fragt, läuft im Stack des jeweiligen
Knotens, und jeder Knoten hat sein eigenes CrowdSec. Abgeglichen wird, was
jemand in HAPM eingestellt hat (`lib/crowdsec/mirror.ts`): die Sperren von
Hand, die Freigaben, der Schalter der OWASP-Regeln und die zuschaltbaren
Sammlungen. Was CrowdSec selbst tut, bleibt je Knoten: seine eigenen Sperren,
die Ereignisse, die Gemeinschaftsliste. Jede neue Sperre dort wäre sonst ein
Abgleich, und nach einem Ausfall erkennt der andere Knoten einen Angreifer an
dessen nächsten Anfragen selbst.

- **Sperren von Hand** setzt der Folgeknoten mit der Restdauer des
  Hauptknotens, hebt auf, was der nicht mehr nennt, und lässt stehen, was
  schon so gesperrt ist (das Ende darf zehn Minuten abweichen).
- **Regeln** schaltet er nur, wo sie abweichen: jede Änderung dort startet
  CrowdSec neu, und solange gehen Anfragen ungeprüft durch.
- **Ob CrowdSec eingeschaltet ist, bleibt je Knoten.** Ist es auf dem
  Folgeknoten aus, wird der Teil dort ausgelassen und steht so im Lauf.

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
- **Freigaben:** `hapm-crowdsec/allow.lst` kommt mit den Dateien vom
  Hauptknoten, die Liste in CrowdSec selbst mit dem Datenteil. Die Oberfläche
  des Folgeknotens zeigt sie damit auch, ändern lässt sie sich dort nicht.
- **Ausnahmen für Anwendungen** (`# hapm-app:`) gleicht der Folgeknoten nach
  jedem übernommenen Stand selbst ab (`queueAppSync`).

## Beförderung: wenn der Hauptknoten ausfällt

Solange der Hauptknoten nur kurz fehlt, ist nichts zu tun: der Folgeknoten
liefert aus, was er hat. Geändert und erneuert wird in der Zeit nicht.

Bleibt er länger weg:

1. Auf dem Folgeknoten „Abgleich", „Rolle": **Hauptknoten** (oder „Einzeln").
   Ab dann wird dort geändert, und die tägliche Erneuerung läuft dort. Konto
   und Erneuerungseinträge von acme.sh hat er aus dem Abgleich.
2. Konten, Einstellungen, DNS-Zonen und API-Keys sind die des bisherigen
   Hauptknotens. Je Knoten eingestellt sind Updates und Sicherung: dort
   nachsehen. Wer einen zweiten Faktor hat, erzeugt unter „Konto" neue
   Wiederherstellungscodes.
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
- **Was CrowdSec selbst sperrt, sperrt jeder Knoten für sich**, siehe oben.
  Abgeglichen sind die Sperren von Hand.
- **Statistik, Logs, Protokoll und Historie je Knoten.**
- **Von der Datenbank geht nur der Datenteil mit**, siehe „Was übertragen
  wird". Sicherung, Updates, Darstellung und das Design der Fehlerseiten
  stellt jeder Knoten für sich ein.
- **Angemeldet ist man je Knoten.** Wechselt die gemeinsame Adresse den
  Knoten, meldet man sich neu an: das Konto ist dasselbe, die Sitzung nicht.
- **Beide Knoten brauchen dieselbe Fassung des Abgleichs.** Mit dem Datenteil
  ist sie 2 (`SYNC_PROTOCOL`): bis beide Knoten aktualisiert sind, lehnt der
  Folgeknoten ab, und der Hauptknoten meldet das als gescheiterten Abgleich.
- **HTTP-01 nur dort, wo die Adresse gerade liegt.** Let's Encrypt erreicht
  den Knoten, der die gemeinsame Adresse hält. acme.sh antwortet auf dem
  Hauptknoten. Hält der Folgeknoten die Adresse, scheitern Anträge und
  Erneuerungen über HTTP-01, bis sie zurück ist oder er befördert wurde.
  DNS-01 hängt nicht daran.
- **Die Oberfläche hinter der gemeinsamen Adresse** ist die des Knotens, der
  sie hält. Den Hauptknoten zum Ändern über seine eigene Adresse ansprechen.
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
Werkzeug des Reverse-Proxys mit `409` ab, ebenso `update_settings` für die
abgeglichenen Einstellungen, `add_crowdsec_decision`, `update_crowdsec_rules`
(außer `upgrade`) und das Aufheben einer Sperre von Hand. Ein API-Key des
Hauptknotens gilt auch auf dem Folgeknoten, zum Lesen.

## Für den, der es ändert

| Datei | Was dort steht |
|---|---|
| `lib/sync/types.ts` | Rollen, `NodeReport`, Warnungen. Rein, die Seite importiert es. |
| `lib/sync/envelope.ts` | Kopplungsschlüssel, Umschlag, Kopfzeile, Einmalwerte. Rein. |
| `lib/sync/bundle.ts` | Ausschlussliste, Einsammeln, Fingerabdruck, Packen, Auspacken mit Prüfung. Nur `fs`. |
| `lib/sync/data.ts` | Der Datenteil: seine Form, die Liste der abgeglichenen Einstellungen, beide Fingerabdrücke, die Prüfung dessen, was ankommt, und was ein Folgeknoten an seinem CrowdSec tut. Rein. |
| `lib/sync/data-collect.ts` | Den Datenteil aus Datenbank und CrowdSec lesen. |
| `lib/sync/data-apply.ts` | Ihn auf dem Folgeknoten einsetzen, jeder Teil für sich. |
| `lib/sync/kick.ts` | Der Anstoß nach einer Handlung, über das Protokoll. |
| `lib/db/account-rows.ts` | Die Konten als Zeilen lesen und in einer Transaktion ersetzen. |
| `lib/crowdsec/mirror.ts` | CrowdSec lesen und auf dem Folgeknoten herstellen. |
| `lib/sync/swap.ts` | Bereitlegen, tauschen, zurücktauschen, Abbruch zurücknehmen. Nur `fs`. |
| `lib/sync/adapt.ts` | `haproxy.cfg` an den Folgeknoten anpassen (CrowdSec). Rein. |
| `lib/sync/apply-core.ts` | Der Ablauf des Anwendens, Prüfen und Neuladen als Funktionen hereingereicht. |
| `lib/sync/apply.ts` | Annehmen, Absagen, Anwenden hinter der Sperre, Lauf und Protokoll. |
| `lib/sync/receive.ts` | Der Endpunkt für andere Knoten und seine Prüfungen. |
| `lib/sync/compare.ts` | Absagen, Hinweise, „trägt den Stand". Rein. |
| `lib/sync/send.ts` | Packen, senden, abwarten, Runden, Anstoß. |
| `lib/sync/role.ts` | Die Rolle und die Sperren für Folgeknoten (`assertProxyWritable`, `assertDataWritable`). Klein, `provision.ts` importiert es. |
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
- **Etwas Neues im Datenteil** braucht vier Stellen: die Form und den
  Fingerabdruck in `data.ts` (samt `parseSyncData`), das Lesen in
  `data-collect.ts`, das Einsetzen in `data-apply.ts`, und die Sperre auf dem
  Folgeknoten (`assertDataWritable`) in der Funktion, die es ändert. Was jeder
  Knoten für sich führt (ein Zähler, ein „zuletzt benutzt"), gehört nicht in
  den Fingerabdruck: sonst wäre jede Anmeldung ein Abgleich.
- **Eine neue Einstellung** in `Settings` wird nur abgeglichen, wenn sie in
  `SYNCED_SETTINGS` steht.
- **Eine neue Handlung im Protokoll** stößt den Abgleich an, wenn ihr Bereich
  in `SYNCED_AREAS` (`kick.ts`) als abgeglichen gilt. Ein neuer Bereich muss
  dort eingetragen werden, sonst übersetzt `kick.ts` nicht.

## Prüfen

- `tests/sync/`: Umschlag (`envelope`), Paket samt bösartiger Pfade
  (`bundle`), Tausch und Zurücktauschen (`apply`), Absagen des Folgeknotens
  (`accept`), der Endpunkt über echtes HTTP (`receive`), Vergleich und
  Anpassung (`compare`), die Sperre auf Folgeknoten (`guard`), der Datenteil
  mit Fingerabdrücken, Prüfung und den Plänen für CrowdSec (`data`).
- `tests/sync/data-apply.test.ts` (braucht `TEST_DATABASE_URL`): einsammeln und
  einsetzen gegen ein echtes Postgres, samt Anmeldung danach, Sitzungen, neu
  verschlüsselten Geheimnissen und den Sperren auf einem Folgeknoten.
- `tests/crowdsec/mirror.test.ts`: welche `cscli`-Aufrufe ein Folgeknoten
  macht. Die Aufrufe selbst (`allowlists add -e 86400s`, `decisions add
  --duration 14400s`, die Absage für eine freigegebene Adresse) sind gegen
  CrowdSec 1.8.2 nachgesehen.
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
(zwei Server mit Docker, HAProxy, Postgres und CrowdSec) und das Umschalten der
Adresse.
