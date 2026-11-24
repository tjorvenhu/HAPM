# DNS

**Lies das, bevor du an /dns, lib/dns/ oder der DNS-Anbindung des Reverse-Proxys etwas
änderst.**

HAPM verwaltet Zonen bei zwei Anbietern: Cloudflare und Hetzner (das DNS in der
Cloud-Konsole). `/dns` listet die, die es verwalten darf; `/dns/<id>` zeigt und ändert
ihre Einträge. Beim Anlegen eines Ziels am Reverse-Proxy setzt es den passenden Eintrag
auf Wunsch gleich mit. Für eine Hetzner-Zone gilt alles, was für eine Cloudflare-Zone
gilt.

Von selbst setzt und entfernt HAPM Einträge an zwei Stellen: `lib/dns/sync.ts`, aus dem
Lauf des Reverse-Proxys (`lib/haproxy/runner.ts`), und `ensureAddressRecord`
(`lib/dns/connect.ts`), wenn der Einrichtungsassistent die Adresse der Oberfläche
einträgt. Alles andere ist eine Handlung unter `/dns/<id>`. Die Zugänge liegen als
Dokumente in Postgres (`dns_zones`), der Schlüssel für die Tokens entsteht beim ersten
Start von selbst.

## Ein Anbieter ist eine Schnittstelle, kein zweiter Bereich

`lib/dns/provider.ts` beschreibt, was der Bereich von einem Anbieter braucht: die Zonen
eines Tokens auflisten, die Einträge einer Zone lesen, einen Eintrag anlegen, ändern,
löschen. Dahinter stehen `cloudflare.ts` und `hetzner.ts`, und nur dort entsteht eine
Anfrage an den Anbieter. Routen, `sync.ts` und `connect.ts` holen sich den Anbieter
einer Zone mit `providerFor(zone)` und kennen keinen beim Namen.

| Datei | Was dort steht |
|---|---|
| `provider.ts` | die Schnittstelle (`DnsProvider`) und die Zuordnung Kennung → Anbieter |
| `cloudflare.ts`, `hetzner.ts` | je ein Anbieter: URL, Fehlermeldungen, Blättern |
| `hetzner-rrsets.ts` | RRSet ↔ Einträge, rein und ohne Netz |
| `records.ts` | was ein Eintrag ist, die Prüfung der Eingabe, `PROVIDER_RULES` |
| `zones.ts` | Domain → Zone, `DnsProviderId`, `dnsProviderForHook`, `providerOf` |
| `provider-info.ts` | Name, Zeichen und Konsole eines Anbieters für Oberfläche und Meldungen |
| `store.ts` | die eigene Datenbank: Zeilen, Token entschlüsseln, Ergebnis vermerken |
| `connect.ts` | eine Zone einrichten, einen Adress-Eintrag sicherstellen |
| `sync.ts` | der DNS-Teil eines Reverse-Proxy-Vorgangs |

**`dns_zones.provider` darf fehlen.** Eine Zeile ohne das Feld ist Cloudflare: sie
stammt aus der Zeit, in der es nur diesen Anbieter gab. Deshalb gibt es keine Migration,
und deshalb liest jede Stelle über `providerOf(zone)` und nie über das Feld
(`tests/dns/providers.test.ts`, `tests/dns/connect.test.ts`).

**Was nur ein Anbieter kennt, bleibt an ihm hängen.** Die Unterschiede stehen in
`PROVIDER_RULES` (`records.ts`), und Prüfung, Formular und Tabelle fragen dort:

| | Cloudflare | Hetzner |
|---|---|---|
| Proxy über die Server des Anbieters (`proxied`) | ja, je Eintrag | gibt es nicht: keine Spalte, kein Schalter |
| „keine eigene TTL" | `ttl: 1`, Anzeige `auto` | `ttl: null`, Anzeige „Vorgabe" (die TTL der Zone) |
| Grenzen der TTL | 60 bis 86400 | 60 bis 2147483647 |
| wem die TTL gehört | dem Eintrag | dem Namen samt Art (RRSet), also allen seinen Werten |

**Name, Zeichen und Konsole stehen genau einmal**, bei den Zugangsdaten für acme.sh
(`DNS_PROVIDERS` in `lib/haproxy/dns-credentials.ts`): es ist derselbe Anbieter und
dasselbe Token, ob acme.sh damit eine Wildcard ausstellt (Hook `dns_hetznercloud` bzw.
`dns_cf`) oder HAPM damit Einträge schreibt. `provider-info.ts` schlägt über den Hook
nach, `dnsProviderForHook` und `hookForDnsProvider` in `zones.ts` sind die Brücke.

## Es gibt keine Collection für die Einträge

Dieselbe Entscheidung wie beim Reverse-Proxy, aus demselben Grund: die Wahrheit über
eine Zone liegt beim Anbieter, und eine Spiegelung in der Datenbank wäre genau dann
falsch, wenn jemand dort (Dashboard, Konsole) etwas geändert hat — also in dem Moment,
in dem man sie am dringendsten braucht. Jede Seite liest die Einträge bei jedem Aufruf.

`dns_zones` trägt deshalb nur den **Zugang**: Anbieter, Name, Zone-ID, Token, und wann
er zuletzt funktioniert hat. Der Preis ist eine Abfrage beim Anbieter je Zone und
Poll-Takt (bei Hetzner eine je 50 Namen, mehr gibt die API je Seite nicht her), deshalb
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
  Antwort des Anbieters, nicht aus dem Formular. Findet der Token die Domain nicht,
  nennt die Meldung die Zonen, die er stattdessen sieht — der häufigste Fehler ist ein
  Token, der für eine andere Domain (Cloudflare) oder ein anderes Projekt (Hetzner)
  erzeugt wurde, und „nicht gefunden" schickt einen dabei in die falsche Richtung.

Welcher Token es sein muss: bei Cloudflare ein API-Token mit „Zone → DNS → Bearbeiten"
auf der Zone, bei Hetzner ein Token des Projekts, in dem die Zone liegt, mit Lese- und
Schreibrecht. Der von Hetzner gilt für alle Zonen seines Projekts, und es ist derselbe,
den der acme.sh-Hook als `HETZNER_TOKEN` benutzt.

Jeder Aufruf vermerkt sein Ergebnis an der Zeile (`withZone`). Ohne das sähe eine Zone,
deren Token seit drei Wochen abgelaufen ist, in der Liste aus wie jede andere — auffallen
würde es beim nächsten Proxy-Ziel, also genau dann, wenn jemand es eilig hat.

## Eine Zone einrichten: ein Weg, `connectZone`

`/dns` (Route `app/api/dns/zones`) und der Einrichtungsassistent rufen dieselbe
Funktion, `connectZone` in `lib/dns/connect.ts`. Drei Entscheidungen stehen dort:

- **Gesucht wird die Zone, in der die Domain LIEGT**, nicht eine Zone dieses Namens:
  der längste Suffix unter den Zonen, die der Token sieht (`matchZone`, dieselbe
  Funktion wie überall). Der Assistent kennt `hapm.example.org`, und wer unter `/dns`
  den Namen eines Dienstes eintippt, meint dessen Zone. Deshalb listet der Anbieter
  seine Zonen (`listZones`, bis zur letzten Seite) und sucht nicht über `?name=`.
- **Eine Domain, eine Zeile.** Steht die Zone schon, wird ihr Zugang ersetzt (Token,
  Zone-ID und Anbieter) und keine zweite angelegt: mit zwei Zeilen für denselben Namen
  wüsste niemand, in welche `sync.ts` schreibt. So zieht auch eine Domain um, die von
  Cloudflare zu Hetzner gewechselt ist. Ersetzt wird erst, nachdem der neue Token die
  Zone gezeigt hat; ein falscher lässt den alten stehen. Die Route protokolliert das
  als `dns_zone_updated` und die Seite sagt „war schon eingerichtet".
- **`delegated` geht mit zurück.** Eine Zone kann beim Anbieter angelegt sein, ohne
  dass die Nameserver der Domain dorthin zeigen; Einträge darin wirken dann nicht.
  Cloudflare sagt es über den Status der Zone (`active`), Hetzner über seine eigene
  Prüfung (`delegation_status`). `null` heißt unbekannt (bei Hetzner: noch nicht
  geprüft) und nicht „ja". Die Seite warnt nur bei einem klaren Nein.

**Den Token austauschen ist nicht dasselbe** (`replaceZoneToken`): dort muss der neue
Token genau DIESE Zone sehen. Mit dem längsten Suffix hätte ein Token, der
`intern.example.org` nicht sieht, aber `example.org`, den Zugang einer anderen Zone
ersetzt und wäre als „gespeichert" zurückgekommen.

`ensureAddressRecord` in derselben Datei sorgt dafür, dass ein Name als A (IPv4) oder
AAAA (IPv6) genau auf eine Adresse zeigt, bei Cloudflare ohne Proxy:

- Ein **CNAME** unter dem Namen wird nicht überschrieben, die Meldung nennt ihn. Ihn zu
  ersetzen hieße, eine Weiterleitung zu löschen, von der der Aufruf nichts weiß.
  Dasselbe gilt für einen Eintrag der eigenen Art, den der Anbieter gesperrt hat.
- Ersetzt wird **nur die eigene Art**. Ein AAAA-Eintrag bleibt stehen, wenn eine
  IPv4-Adresse gesetzt wird, und umgekehrt: sonst nähme der zweite Aufruf für einen
  Server mit beiden Adressen den Eintrag des ersten wieder weg.
- Stehen unter dem Namen mehrere Einträge der Art, bleibt genau einer. Stimmt einer
  schon, bleibt der, samt TTL und Notiz.
- Verglichen wird die Adresse, nicht ihr Text (`sameAddress`): `2001:db8::1` und
  `2001:0db8:0:0:0:0:0:1` sind dieselbe.

## Domain → Zone ist ein Suffixvergleich

`lib/dns/zones.ts` ist **ohne einen einzigen Import**, aus demselben Grund wie
`lib/haproxy/config.ts`: das Formular im Browser stellt dieselbe Frage wie die Route auf
dem Server, und zwei Antworten darauf wären ein Dialog, der einen Haken anbietet, den das
Speichern anders auslegt. Der Vergleich ist bei beiden Anbietern derselbe: er arbeitet
auf dem Namen der Zone, und den führen beide gleich.

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
Anzeige und Klick liegt ein Poll-Takt. Der Anbieter bekommt danach diesen frisch
gelesenen Eintrag (`current`) und nicht nur eine Kennung.

`locked` kommt vom Anbieter. Bei Cloudflare sind es Einträge, die Cloudflare selbst
pflegt. Bei Hetzner sind es drei Dinge: ein Satz, den jemand dort gegen Änderungen
geschützt hat, der SOA, und die NS-Einträge der Zone selbst. Die setzt Hetzner beim
Anlegen der Zone, und ohne sie wird die Zone nicht mehr ausgeliefert. Eine Delegation
unterhalb (`intern` NS) bleibt bearbeitbar.

Prüfungen, die es nur gibt, weil der Fehler sonst still bleibt:

- **Ein CNAME auf der Domain selbst wird abgelehnt.** Er verdeckt NS und MX der Zone;
  Cloudflare baut daraus stillschweigend einen Flattening-Fall. Das ist eine Entscheidung
  und nichts, was man nebenbei im Dialog trifft. Die Prüfung gilt für beide Anbieter.
- **`ttl: 1` ist bei Cloudflare „automatisch" und keine Sekunde.** Deshalb `formatTtl`,
  deshalb steht in der Tabelle `auto` und nicht `1 s`. Bei Hetzner ist die 1 eine
  Sekunde und damit unter der Grenze: „keine eigene TTL" heißt dort `null`, und die
  Prüfung nimmt die Regeln des Anbieters der Zone (`validateRecordInput(…, provider)`).
- **Eine TTL, die nicht zur Auswahl steht, bleibt im Formular wählbar.** acme.sh
  schreibt 120, in einer Konsole steht oft 7200. Stünde das Feld beim Bearbeiten leer
  da, änderte Speichern die TTL, ohne dass jemand es wollte, und bei Hetzner die aller
  Werte des Namens.

## Hetzner rechnet in RRSets, die Oberfläche in Einträgen

Hetzner kennt keinen einzelnen Eintrag mit Kennung. Es führt je Name und Art einen Satz
von Werten (`www/A` mit zwei Adressen), und die TTL gehört dem Satz. Die Oberfläche
zeigt weiter eine Zeile je Wert, wie bei Cloudflare. Die Abbildung steht in
`lib/dns/hetzner-rrsets.ts`, rein und ohne Netz (`tests/dns/hetzner-rrsets.test.ts`).

**Die Kennung eines Eintrags ist Name, Art und Wert**, lesbar verpackt (base64url) und
nicht gehasht. So benennt Hetzner einen Wert selbst, und zum Entfernen braucht es den
Wert WÖRTLICH, wie Hetzner ihn führt: aus der Anzeige ist er nicht sicher
zurückzurechnen (`"a" "b"` und `"ab"` sind derselbe TXT-Text). Ändert jemand den Wert in
der Konsole, ist es ein anderer Eintrag mit anderer Kennung, und der alte ist „nicht
mehr da". Genau das meldet der 404 aus `readCurrent`.

**Geschrieben wird je Wert, nie der ganze Satz.** `add_records` und `remove_records`
fassen bei Hetzner nur den genannten Wert an. Ein Satz, der hier gelesen, im Speicher
geändert und mit `set_records` zurückgeschrieben würde, nähme einen Wert mit, den jemand
anderes in der Zwischenzeit daneben gesetzt hat.

| Handlung | Aufrufe, in dieser Reihenfolge |
|---|---|
| Wert anlegen | `add_records` (legt den Satz an, wenn es ihn nicht gibt) |
| Wert ändern | `add_records` mit dem neuen, dann `remove_records` mit dem alten |
| CNAME ändern | `set_records`: ein Name trägt nur einen, „erst hinzufügen" geht nicht |
| nur die Notiz | `update_records` |
| TTL | `change_ttl`, gilt für alle Werte des Satzes |
| Name oder Art ändern | `add_records` im neuen Satz, dann `remove_records` im alten |
| Wert löschen | `remove_records` (der letzte Wert nimmt den Satz mit) |

- **Beim Ändern kommt der neue Wert zuerst.** So ist der Name nie leer (ein leerer Satz
  wird bei Hetzner samt seiner TTL gelöscht), und scheitert der zweite Schritt, stehen
  beide Werte da und keiner fehlt. Die Meldung sagt dann dazu, dass ein Teil schon
  ausgeführt ist.
- **Vor jedem Schreiben wird der betroffene Satz gelesen**, frisch und einzeln
  (`GET …/rrsets/{name}/{type}`). An ihm hängen drei Dinge: ob der Wert noch dasteht,
  ob der neue schon dasteht (dann 409 statt eines zweiten gleichen), und die TTL, die
  Hetzner beim Hinzufügen zu einem bestehenden Satz genau so verlangt.
- **Die TTL eines bestehenden Satzes ändert sich beim Anlegen nur auf Wunsch.** „Keine
  eigene TTL" im Formular zum Anlegen heißt: so lassen, wie der Name sie hat, und
  nicht: die der Nachbarn zurücksetzen. Beim Bearbeiten ist das Feld mit der TTL des
  Satzes vorbelegt, dort gilt, was dasteht. Das Formular sagt bei Hetzner dazu, dass
  die TTL für alle Einträge mit diesem Namen und Typ gilt.
- **Zwei Änderungen gleichzeitig am selben Satz** verlieren nichts, solange sie
  verschiedene Werte betreffen: jede fasst nur ihren an. Weist Hetzner einen Aufruf ab,
  weil an der Zone gerade eine andere Änderung läuft (`locked`, `conflict`), wird er
  bis zu dreimal wiederholt. Betreffen beide denselben Wert, gewinnt die erste, und die
  zweite bekommt „gibt es nicht (mehr)" oder „steht dort bereits".
- **Eine Änderung ist erst fertig, wenn ihre Aktion es ist.** Jeder schreibende Aufruf
  antwortet mit einer Aktion (`running`) und nicht mit dem fertigen Eintrag. `settle`
  in `hetzner.ts` fragt nach (`GET /actions/{id}`), bis sie `success` oder `error`
  meldet, gut 20 Sekunden lang. Danach ist es ein Fehler und kein stilles Weiter: ob
  der Eintrag steht, weiß dann niemand, und „gespeichert" wäre geraten. Für
  `sync.ts` zählt das doppelt, weil nach dem Eintrag das Zertifikat kommt.

**Wie Hetzner Werte schreibt**, und was die Oberfläche daraus macht (`readValue`,
`writeValue`):

| Art | bei Hetzner | in der Oberfläche |
|---|---|---|
| Name des Eintrags | relativ zur Zone, `@` für die Zone selbst | voller Name, im Formular der Teil davor |
| CNAME, NS | Ziel mit Punkt am Ende: `example.org.` | Ziel ohne Punkt |
| MX | Priorität und Ziel in einem Wert: `10 mail.example.org.` | Priorität als eigenes Feld |
| TXT | in Anführungszeichen, ab 255 Zeichen in Stücke geteilt | der Text, ohne Anführungszeichen |
| A, AAAA, alles andere | wie es dasteht | wie es dasteht |

Ein Ziel OHNE Punkt am Ende wird beim Lesen relativ zur Zone verstanden (`www` ist
`www.example.org`, `@` die Zone), wie in einer Zonendatei. HAPM schreibt Ziele immer mit
Punkt, der Fall kommt also nur von Einträgen, die jemand anderes gesetzt hat. Ein
TXT-Wert, der schon in Anführungszeichen eingegeben wird, geht unverändert durch.

**Benutzte Endpunkte** (alle unter `https://api.hetzner.cloud/v1`, Token als Bearer):
`GET /zones` (Seiten über `page` und `per_page=50`), `GET /zones/{id}/rrsets` (ebenso),
`GET /zones/{id}/rrsets/{name}/{type}`,
`POST /zones/{id}/rrsets/{name}/{type}/actions/{add_records|remove_records|set_records|update_records|change_ttl}`
und `GET /actions/{id}`. Quelle ist die Beschreibung der API, die Hetzner veröffentlicht
(`docs.hetzner.cloud/reference/cloud`, Abschnitte „Zones", „Zone RRSets" und „Actions"),
dazu der acme.sh-Hook `dns_hetznercloud`, der dieselben Aufrufe für TXT-Einträge macht
(`add_records`, `remove_records`, Warten auf die Aktion, `@` für die Zone selbst,
Anführungszeichen um den TXT-Wert).

**Was davon nie gegen eine echte Zone lief:** alles außer der Ablehnung eines falschen
Tokens. Es gab beim Bau kein Token. Insbesondere nur aus der Beschreibung gelesen und
nicht ausprobiert: dass ein Ziel ohne Punkt relativ zur Zone ist, dass `update_records`
mit leerer Notiz die Notiz entfernt, dass `add_records` ohne `ttl` an einem Satz mit
eigener TTL diese behält (deshalb wird sie mitgeschickt), wie Hetzner einen Namen wie
`*` im Pfad erwartet, und in welchen Fällen es `locked` oder `conflict` meldet. Wer
hier einen Fehler findet, findet ihn in `hetzner.ts` oder `hetzner-rrsets.ts` und
sonst nirgends.

## Der Haken im Reverse-Proxy-Dialog

Liegt eine Domain des Dienstes in einer verwalteten Zone, steht sie im Abschnitt
„DNS-Einträge" des Dienst-Dialogs. Gefragt wird `/api/dns/match`, entprellt um eine halbe
Sekunde: die Antwort hängt an einem Feld, in das gerade jemand tippt.

**Gefragt wird der Server und nicht der Browser**, weil zwei Dinge nur dort bekannt sind:
der Token, und der ECHTE Bestand beim Anbieter. Ein Haken, der gesetzt ist, weil der
Eintrag schon steht, ist eine Aussage über die Zone — geraten stünde sie genau dann
falsch da, wenn jemand den Eintrag dort gerade gelöscht hat. Die Antwort nennt den
Anbieter der Zone (`zone.provider`), damit der Dialog nur bei Cloudflare etwas über den
Proxy sagt.

**Der Schalter arbeitet für beide Anbieter gleich**, und `sync.ts` kennt keinen beim
Namen: es bekommt den Anbieter über `providerFor(zone)`. Angelegt wird derselbe Eintrag,
ein CNAME auf die Zone selbst. Was abweicht, kommt aus `PROVIDER_RULES`: die TTL ist die
Vorgabe des Anbieters (Cloudflare `1`, Hetzner die der Zone), und `proxied: false` geht
nur an Cloudflare mit. Bei Hetzner steht der Wert als `example.org.` mit Punkt in der
Zone und kommt ohne Punkt zurück, `isProxyRecord` erkennt ihn also unverändert.
`proxyRecordPlan` trägt weiter `ttl: 1` und `proxied: false`: das ist der Plan in der
Schreibweise von Cloudflare, und wer schreibt, nimmt die Vorgabe seines Anbieters.

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
gepflegt, unter `/dns/<id>` oder beim Anbieter, und `sync.ts` legt ihn nicht an. Jeder Dienst
darunter hängt sich daran. Die Adresse dieses Servers stattdessen in jeden Eintrag zu
schreiben hieße, dieselbe IP in dreißig Einträgen zu führen — ein Umzug wären dann
dreißig Änderungen statt einer. Zeigt die Root woandershin, zeigt auch der CNAME
dorthin: dann den Haken auslassen und den Eintrag von Hand setzen.

**Nicht proxied.** Der Verkehr geht direkt an HAProxy: Let's Encrypt kommt sonst über
HTTP-01 nicht durch, und die Client-IP im Access-Log (Statistik, Admin-IPs, Absenderlisten)
wäre die von Cloudflare. Bei Hetzner gibt es die Frage nicht.

**Die Auswahl ist je Domain und nicht ein Schalter für alle.** Ein Dienst bedient oft
`kunde.example` (fremde Zone) und `app.example.com` (eine eigene), und gemeint ist dann nur
die zweite.

`selectedDnsDomains` schneidet die Liste aus dem Rumpf gegen die Domains des Dienstes.
Ohne diesen Riegel ließe sich über die Reverse-Proxy-Route ein Eintrag in einer beliebigen
verwalteten Zone anlegen, ohne dass am Proxy etwas damit zu tun hätte — dieselbe
Überlegung wie bei `lockedDomains`.

## Die Reihenfolge im Lauf

Der DNS-Teil hängt in `lib/haproxy/runner.ts` und nicht in `provision.ts`: ein CNAME beim
DNS-Anbieter hat mit `haproxy.cfg` nichts zu tun — kein Kommando, keine Datei, kein Lock.
Umgekehrt kennt `lib/dns/sync.ts` kein HAProxy; es bekommt Domains und liefert Schritte.

- **Angelegt wird VOR dem Zertifikat** (Phase `dns`, vor `preflight`). Let's Encrypt prüft
  über HTTP-01, also über die Domain selbst; zeigt sie noch nirgendwohin, scheitert der
  Antrag, und ein Fehlversuch zählt gegen ein Kontingent. Ein Eintrag, der danach entstünde,
  käme für genau den Fall zu spät, für den man ihn braucht. Bei Hetzner kommt der Schritt
  erst zurück, wenn die Aktion ausgeführt ist (siehe oben), aus demselben Grund.
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

## Eine Domain zu entfernen ändert beim Anbieter nichts

Die Zone bleibt, ihre Einträge bleiben, alles läuft weiter. Das gilt bei Cloudflare wie
bei Hetzner: gelöscht wird nur die Zeile in `dns_zones`. Weg ist nur der Zugang von
hier — und damit der Haken im Proxy-Dialog. Der Bestätigungsdialog sagt genau das: ein
Löschknopf, der wie „aus der Liste nehmen" aussieht und eine ganze Domain offline nimmt,
wäre die teuerste Verwechslung, die diese Seite anbieten könnte.
