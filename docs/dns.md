# DNS

**Lies das, bevor du an /dns, lib/dns/ oder der DNS-Anbindung des Reverse-Proxys etwas
änderst.**

HAPM verwaltet Zonen bei Cloudflare. `/dns` listet die, die es verwalten darf;
`/dns/<id>` zeigt und ändert ihre Einträge. Beim Anlegen eines Ziels am Reverse-Proxy
setzt es den passenden Eintrag auf Wunsch gleich mit.

Von selbst setzt und entfernt HAPM Einträge an genau einer Stelle: `lib/dns/sync.ts`,
aus dem Lauf des Reverse-Proxys (`lib/haproxy/runner.ts`). Alles andere ist eine Handlung
unter `/dns/<id>`. Die Zugänge liegen als Dokumente in Postgres (`dns_zones`), der
Schlüssel für die Tokens entsteht beim ersten Start von selbst.

## Es gibt keine Collection für die Einträge

Dieselbe Entscheidung wie beim Reverse-Proxy, aus demselben Grund: die Wahrheit über
eine Zone liegt bei Cloudflare, und eine Spiegelung in der Datenbank wäre genau dann
falsch, wenn jemand im Dashboard etwas geändert hat — also in dem Moment, in dem man
sie am dringendsten braucht. Jede Seite liest die Einträge bei jedem Aufruf.

`dns_zones` trägt deshalb nur den **Zugang**: Name, Zone-ID, Token, und wann er zuletzt
funktioniert hat. Der Preis ist eine Cloudflare-Abfrage je Zone und Poll-Takt, deshalb
laufen beide Seiten im 60-Sekunden-Takt und nicht in 30.

**`records: null` heißt unbekannt und nicht null Einträge.** Eine Zone, deren Token
abgelaufen ist, zeigt keinen Bestand — sie zeigt einen Fehler. Eine beruhigende 0 wäre
die schlechtere Auskunft: eine Null ist eine Aussage, und „unbekannt" ist eine andere.

## Der Token wird gespeichert, und das ist der Unterschied zu acme.sh

Bei den DNS-Zugangsdaten des Reverse-Proxys ist HAPM **Durchreiche und nicht
Tresor** ([`reverse-proxy.md`](reverse-proxy.md)): der Token geht in einem Vorgang in die
`account.conf` von acme.sh und steht danach nicht in der Datenbank. Hier ist es umgekehrt, und zwar notwendigerweise — die
Einträge werden gelesen und geschrieben, solange die Zone eingerichtet ist, nicht einmalig
beim Anlegen. Ohne gespeicherten Token gäbe es die Seite nicht.

Daraus folgen drei Dinge, die zusammengehören:

- **Verschlüsselt mit dem `encryptionKey` der Installation** (`lib/crypto.ts`,
  `lib/secrets.ts`), wie die TOTP-Geheimnisse. Der Schlüssel entsteht beim ersten Start
  und liegt im Daten-Volume; `ENCRYPTION_KEY` aus der Umgebung gewinnt, falls gesetzt.
  Kein Re-Encrypt-Pfad: wer den Schlüssel wechselt (oder das Volume verliert),
  hinterlegt die Tokens neu. `tokenOf()` sagt genau das, statt einen Entschlüsselungsfehler
  durchzureichen.
- **Er geht nie an den Browser.** `forClient()` nimmt ihn heraus. Zurück kommt nur, ob und wann er zuletzt
  funktioniert hat. Auch das Aktivitätsprotokoll trägt ihn nicht, nicht einmal gekürzt.
- **Er wird beim Einrichten benutzt und nicht geglaubt.** Die Zone-ID kommt aus der
  Antwort von Cloudflare, nicht aus dem Formular. Findet der Token die Domain nicht,
  nennt die Meldung die Zonen, die er stattdessen sieht — der häufigste Fehler ist ein
  Token, der für eine andere Domain erzeugt wurde, und „nicht gefunden" schickt einen
  dabei in die falsche Richtung.

Jeder Aufruf vermerkt sein Ergebnis an der Zeile (`withZone`). Ohne das sähe eine Zone,
deren Token seit drei Wochen abgelaufen ist, in der Liste aus wie jede andere — auffallen
würde es beim nächsten Proxy-Ziel, also genau dann, wenn jemand es eilig hat.

## Domain → Zone ist ein Suffixvergleich

`lib/dns/zones.ts` ist **ohne einen einzigen Import**, aus demselben Grund wie
`lib/haproxy/config.ts`: das Formular im Browser stellt dieselbe Frage wie die Route auf
dem Server, und zwei Antworten darauf wären ein Dialog, der einen Haken anbietet, den das
Speichern anders auslegt.

- **Der Punkt ist der Riegel.** `kunde.example` liegt nicht in der Zone `fremdekunde.example`,
  obwohl der Name darin vorkommt. Dieselbe Falle wie beim `-m end -i .kunde.example` der
  HAProxy-ACL.
- **Die längste Zone gewinnt.** Sind `kunde.example` und `intern.kunde.example` beide eingerichtet,
  gehört `app.intern.kunde.example` in die speziellere — sonst schriebe das Werkzeug in eine
  Zone, die für diesen Namen gar nicht mehr zuständig ist.
- **Eine Wildcard ist keine Ausnahme.** `*.kunde.example` endet auf `.kunde.example` wie jeder
  andere Name darunter. Ihr das `*.` abzuschneiden wäre ein Fehler: dann sähe
  `*.kunde.example` aus wie die Zone selbst, und der Eintrag würde als „auf der Root nicht
  möglich" abgewiesen (`tests/dns/zones.test.ts`).

## Was das Formular anfasst, und was nicht

`EDITABLE_TYPES` ist eine Allow-Liste (A, AAAA, CNAME, TXT, MX, NS): die Art bestimmt, welche Felder mitgehen, und
SRV oder CAA tragen Felder in einem `data`-Objekt, das dieses Formular nicht kennt.

**Was nicht in der Liste steht, wird angezeigt und nicht angefasst** — dieselbe Regel wie
bei einem HAProxy-Eintrag, der nicht dem Namensschema folgt. Ein Werkzeug, das einen
SRV-Eintrag beim Speichern auf drei bekannte Felder zusammenstreicht, ist schlimmer als
eines, das ihn nur zeigt. Geprüft wird das zweimal: die Knöpfe der Zeile sind gesperrt,
und die Route liest den Eintrag vor dem Schreiben noch einmal (`readCurrent`) — zwischen
Anzeige und Klick liegt ein Poll-Takt.

Zwei Prüfungen, die es nur gibt, weil der Fehler sonst still bleibt:

- **Ein CNAME auf der Domain selbst wird abgelehnt.** Er verdeckt NS und MX der Zone;
  Cloudflare baut daraus stillschweigend einen Flattening-Fall. Das ist eine Entscheidung
  und nichts, was man nebenbei im Dialog trifft.
- **`ttl: 1` ist „automatisch" und keine Sekunde.** Deshalb `formatTtl`, deshalb steht in
  der Tabelle `auto` und nicht `1 s`.

## Der Haken im Reverse-Proxy-Dialog

Liegt eine Domain des Dienstes in einer verwalteten Zone, steht sie im Abschnitt
„DNS-Einträge" des Dienst-Dialogs. Gefragt wird `/api/dns/match`, entprellt um eine halbe
Sekunde: die Antwort hängt an einem Feld, in das gerade jemand tippt.

**Gefragt wird der Server und nicht der Browser**, weil zwei Dinge nur dort bekannt sind:
der Token, und der ECHTE Bestand bei Cloudflare. Ein Haken, der gesetzt ist, weil der
Eintrag schon steht, ist eine Aussage über die Zone — geraten stünde sie genau dann
falsch da, wenn jemand den Eintrag im Dashboard gerade gelöscht hat.

Vier Zustände, und jeder sagt etwas anderes:

| Was gefunden wird | Schalter | Grund |
|---|---|---|
| genau unser CNAME | an, gesperrt | steht schon; Tooltip nennt Zone und Ziel |
| ein anderer Eintrag | aus, gesperrt | wird nicht angefasst, Tooltip nennt Art und Wert |
| die Zone selbst | aus, gesperrt | dort gehört ein A-Eintrag hin, von Hand gepflegt |
| nichts | frei, Vorgabe **an** | der Schalter erscheint nur für Zonen, die hier eingerichtet sind — und die richtet man ein, damit genau das passiert |

**Der Zustand hält fest, wer den Schalter AUSgeschaltet hat, nicht wer ihn angelassen
hat** (`dnsWanted[domain] !== false`). Mit `false` als Vorgabe müsste ein Effekt den
Zustand nachziehen, sobald die Antwort eintrifft — und dann stünde die Zeile einen Render
lang mit Haken da, ohne beim Speichern mitzuzählen. Dieselbe Überlegung wie beim
vorausgewählten DNS-Hook, der abgeleitet und nicht in den Zustand geschrieben wird.

**Der Eintrag ist ein CNAME auf die Zone selbst, nicht auf eine IP.** Das setzt voraus,
dass der A-Eintrag der Zone (die Root) auf diesen Server zeigt; er wird von Hand
gepflegt, unter `/dns/<id>` oder bei Cloudflare, und HAPM legt ihn nicht an. Jeder Dienst
darunter hängt sich daran. Die Adresse dieses Servers stattdessen in jeden Eintrag zu
schreiben hieße, dieselbe IP in dreißig Einträgen zu führen — ein Umzug wären dann
dreißig Änderungen statt einer. Zeigt die Root woandershin, zeigt auch der CNAME
dorthin: dann den Haken auslassen und den Eintrag von Hand setzen.

**Nicht proxied.** Der Verkehr geht direkt an HAProxy: Let's Encrypt kommt sonst über
HTTP-01 nicht durch, und die Client-IP im Access-Log (Statistik, Admin-IPs, Absenderlisten)
wäre die von Cloudflare.

**Die Auswahl ist je Domain und nicht ein Schalter für alle.** Ein Dienst bedient oft
`kunde.example` (fremde Zone) und `app.example.com` (eine eigene), und gemeint ist dann nur
die zweite.

`selectedDnsDomains` schneidet die Liste aus dem Rumpf gegen die Domains des Dienstes.
Ohne diesen Riegel ließe sich über die Reverse-Proxy-Route ein Eintrag in einer beliebigen
verwalteten Zone anlegen, ohne dass am Proxy etwas damit zu tun hätte — dieselbe
Überlegung wie bei `lockedDomains`.

## Die Reihenfolge im Lauf

Der DNS-Teil hängt in `lib/haproxy/runner.ts` und nicht in `provision.ts`: ein CNAME bei
Cloudflare hat mit `haproxy.cfg` nichts zu tun — kein Kommando, keine Datei, kein Lock.
Umgekehrt kennt `lib/dns/sync.ts` kein HAProxy; es bekommt Domains und liefert Schritte.

- **Angelegt wird VOR dem Zertifikat** (Phase `dns`, vor `preflight`). Let's Encrypt prüft
  über HTTP-01, also über die Domain selbst; zeigt sie noch nirgendwohin, scheitert der
  Antrag, und ein Fehlversuch zählt gegen ein Kontingent. Ein Eintrag, der danach entstünde,
  käme für genau den Fall zu spät, für den man ihn braucht.
- **Ein Fehlschlag dabei hält den Vorgang nicht auf.** Der Dienst wird trotzdem angelegt —
  eine Domain, die schon woanders aufgelöst wird, funktioniert auch ohne unseren Eintrag —,
  aber der Schritt steht als Fehler in der Zeile, und der Lauf endet auf `error`.
- **Entfernt wird zuletzt und nur nach einem sauberen Lauf** (Phase `cleanup`). Ein
  gescheitertes Löschen lässt den Dienst stehen, und ihm dann den CNAME wegzunehmen nähme
  eine laufende Domain offline: der Fehler wäre nicht der abgebrochene Vorgang, sondern
  das, was danach fehlt.
- **Beim Löschen eines Ziels ist es ein Schalter im Bestätigungsdialog, vorbelegt auf an.**
  Angeboten wird er nur, wenn es tatsächlich einen eigenen Eintrag gibt — die Seite fragt
  dafür `/api/dns/match`, bevor sie den Dialog öffnet. Ein Häkchen „DNS-Eintrag
  mitlöschen" an einer Domain ohne eingerichtete Zone wäre eine Frage ohne Wirkung, und
  beim nächsten Mal glaubt man ihr nicht mehr. **Ohne `removeDns: true` im Rumpf fasst die
  Route DNS nicht an**: ein Löschvorgang, der bei einem Aufrufer ohne diese Angabe
  stillschweigend auch Einträge entfernt, hätte eine Nebenwirkung, die man ihm später
  nicht mehr ansieht.
- **Überschrieben wird nie.** Steht unter dem Namen schon etwas anderes, bleibt es stehen
  und der Schritt sagt, was dort steht. Entfernt wird nur, was `isProxyRecord` als eigenen
  Eintrag erkennt — ein A-Eintrag von Hand geht beim Löschen des Ziels nicht mit.
- **Beim Ändern verliert eine herausgefallene Domain ihren Eintrag.** Der Vergleich
  passiert in der Route und vor dem Schreiben: danach steht in der Konfiguration nur noch
  die neue Liste. Deshalb gibt `precheckUpdate` den Dienst zurück, wie `precheckDelete` es
  tut.
- **Die Schritte des DNS-Teils werden dem Ergebnis vorangestellt** (`prefix` im Runner).
  `provision.ts` meldet seine eigene Liste und weiß von ihnen nichts; ohne das Voranstellen
  verschwände der DNS-Schritt aus der Zeile, sobald der erste HAProxy-Schritt gemeldet wird.

## Eine Domain zu entfernen ändert bei Cloudflare nichts

Die Zone bleibt, ihre Einträge bleiben, alles läuft weiter. Weg ist nur der Zugang von
hier — und damit der Haken im Proxy-Dialog. Der Bestätigungsdialog sagt genau das: ein
Löschknopf, der wie „aus der Liste nehmen" aussieht und eine ganze Domain offline nimmt,
wäre die teuerste Verwechslung, die diese Seite anbieten könnte.
