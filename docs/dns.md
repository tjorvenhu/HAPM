# DNS

**Lies das, bevor du an /dns, lib/dns/ oder der DNS-Anbindung des Reverse-Proxys etwas
änderst.**

Der Bereich „DNS" ist eine **Anbindung**, keine Verwaltung von Einträgen. HAPM hält den
Zugang zu Zonen bei zwei Anbietern, Cloudflare und Hetzner (das DNS in der
Cloud-Konsole), und schreibt damit nur, was es selbst braucht:

- **den Eintrag eines Ziels.** Beim Anlegen eines Ziels am Reverse-Proxy setzt
  `lib/dns/sync.ts` auf Wunsch den CNAME der Domain, und beim Löschen nimmt es ihn wieder
  weg (aus dem Lauf, `lib/haproxy/runner.ts`).
- **den Eintrag der Oberfläche im Einrichtungsassistenten.** `ensureAddressRecord`
  (`lib/dns/connect.ts`) setzt auf Knopfdruck den A- oder AAAA-Eintrag der Adresse von
  HAPM.

Alle übrigen Einträge verwaltet man beim Anbieter. `/dns` zeigt je angebundener Zone den
Anbieter, ob der Zugang funktioniert (zuletzt geprüft, Fehler) und ob die Nameserver auf
den Anbieter zeigen. Dort lässt sich eine Zone anbinden, ihr Token austauschen und die
Anbindung entfernen, mehr nicht. Eine Seite mit den Einträgen einer Zone gab es einmal;
sie ist mit Absicht weg: ein zweites Formular für Einträge neben dem des Anbieters ist
ein zweiter Ort, an dem etwas falsch stehen kann.

**Zertifikate über DNS-01 laufen nicht über diese Anbindung**, sondern über die
Zugangsdaten von acme.sh (Reverse-Proxy, Einstellungen, siehe
[`reverse-proxy.md`](reverse-proxy.md)). Es ist derselbe Anbieter und dasselbe Token,
und der Einrichtungsassistent richtet beides in einem Schritt ein: das Token geht an
acme.sh, und die Zone wird hier angebunden.

Die Zugänge liegen als Dokumente in Postgres (`dns_zones`), der Schlüssel für die Tokens
entsteht beim ersten Start von selbst. Für eine Hetzner-Zone gilt alles, was für eine
Cloudflare-Zone gilt.

## Ein Anbieter ist eine Schnittstelle, kein zweiter Bereich

`lib/dns/provider.ts` beschreibt, was HAPM von einem Anbieter braucht: die Zonen eines
Tokens auflisten, die Einträge einer Zone lesen, einen Eintrag anlegen, ändern, löschen.
Gelesen wird, um zu wissen, was unter einem Namen schon steht; geschrieben wird nur von
`sync.ts` und `ensureAddressRecord`. Dahinter stehen `cloudflare.ts` und `hetzner.ts`,
und nur dort entsteht eine Anfrage an den Anbieter. Routen, `sync.ts` und `connect.ts`
holen sich den Anbieter einer Zone mit `providerFor(zone)` und kennen keinen beim Namen.

| Datei | Was dort steht |
|---|---|
| `provider.ts` | die Schnittstelle (`DnsProvider`) und die Zuordnung Kennung → Anbieter |
| `cloudflare.ts`, `hetzner.ts` | je ein Anbieter: URL, Fehlermeldungen, Blättern |
| `hetzner-rrsets.ts` | RRSet ↔ Einträge, rein und ohne Netz |
| `records.ts` | was ein Eintrag ist, `PROVIDER_RULES`, `sameAddress` |
| `zones.ts` | Domain → Zone, `DnsProviderId`, `dnsProviderForHook`, `providerOf`, Prüfung des Zonennamens |
| `provider-info.ts` | Name, Zeichen und Konsole eines Anbieters für Oberfläche und Meldungen |
| `store.ts` | die eigene Datenbank: Zeilen, Token entschlüsseln, Ergebnis vermerken |
| `connect.ts` | eine Zone anbinden, den Token austauschen, einen Adress-Eintrag sicherstellen |
| `sync.ts` | der DNS-Teil eines Reverse-Proxy-Vorgangs |

**`dns_zones.provider` darf fehlen.** Eine Zeile ohne das Feld ist Cloudflare: sie
stammt aus der Zeit, in der es nur diesen Anbieter gab. Deshalb gibt es keine Migration,
und deshalb liest jede Stelle über `providerOf(zone)` und nie über das Feld
(`tests/dns/providers.test.ts`, `tests/dns/connect.test.ts`).

**Was nur ein Anbieter kennt, bleibt an ihm hängen.** Die Unterschiede stehen in
`PROVIDER_RULES` (`records.ts`), und wer schreibt, fragt dort:

| | Cloudflare | Hetzner |
|---|---|---|
| Proxy über die Server des Anbieters (`proxied`) | ja, HAPM schreibt immer `false` | gibt es nicht, das Feld geht nicht mit |
| „keine eigene TTL" | `ttl: 1` („automatisch", keine Sekunde) | `ttl: null`, es gilt die TTL der Zone |
| wem die TTL gehört | dem Eintrag | dem Namen samt Art (RRSet), also allen seinen Werten |

**Name, Zeichen und Konsole stehen genau einmal**, bei den Zugangsdaten für acme.sh
(`DNS_PROVIDERS` in `lib/haproxy/dns-credentials.ts`): es ist derselbe Anbieter und
dasselbe Token, ob acme.sh damit eine Wildcard ausstellt (Hook `dns_hetznercloud` bzw.
`dns_cf`) oder HAPM damit Einträge schreibt. `provider-info.ts` schlägt über den Hook
nach, `dnsProviderForHook` und `hookForDnsProvider` in `zones.ts` sind die Brücke.

## Es gibt keine Collection für die Einträge

Dieselbe Entscheidung wie beim Reverse-Proxy, aus demselben Grund: die Wahrheit über
eine Zone liegt beim Anbieter, und eine Spiegelung in der Datenbank wäre genau dann
falsch, wenn jemand dort (Dashboard, Konsole) etwas geändert hat. Wer wissen muss, was
unter einem Namen steht (`sync.ts`, `ensureAddressRecord`, `/api/dns/match`), liest die
Einträge der Zone in dem Moment beim Anbieter.

`dns_zones` trägt deshalb nur den **Zugang**: Anbieter, Name, Zone-ID, Token, und wann
er zuletzt funktioniert hat. Die Liste unter `/dns` prüft ihn bei jedem Aufruf: sie
fragt mit dem Token, welche Zonen er sieht (`listZones`). Steht die Zone darunter,
funktioniert der Zugang, und dieselbe Antwort sagt, ob die Nameserver auf den Anbieter
zeigen. Der Preis ist eine Abfrage je Zone und Poll-Takt, deshalb läuft die Seite im
60-Sekunden-Takt und nicht in 30.

## Der Token wird gespeichert, und das ist der Unterschied zu acme.sh

Bei den DNS-Zugangsdaten des Reverse-Proxys ist HAPM **Durchreiche und nicht
Tresor** ([`reverse-proxy.md`](reverse-proxy.md)): der Token geht in einem Vorgang in die
`account.conf` von acme.sh und steht danach nicht in der Datenbank. Hier ist es umgekehrt,
und zwar notwendigerweise: der Eintrag eines Ziels entsteht bei jedem neuen Ziel, nicht
einmalig beim Anbinden. Ohne gespeicherten Token gäbe es den Haken im Dienst-Dialog nicht.

Daraus folgen drei Dinge, die zusammengehören:

- **Verschlüsselt mit dem `encryptionKey` der Installation** (`lib/crypto.ts`,
  `lib/secrets.ts`), wie die TOTP-Geheimnisse. Der Schlüssel entsteht beim ersten Start
  und liegt im Daten-Volume; `ENCRYPTION_KEY` aus der Umgebung gewinnt, falls gesetzt.
  Kein Re-Encrypt-Pfad: wer den Schlüssel wechselt (oder das Volume verliert),
  hinterlegt die Tokens neu. `tokenOf()` sagt genau das, statt einen Entschlüsselungsfehler
  durchzureichen.
- **Er geht nie an den Browser.** `forClient()` nimmt ihn heraus. Zurück kommt nur, ob und wann er zuletzt
  funktioniert hat. Auch das Aktivitätsprotokoll trägt ihn nicht, nicht einmal gekürzt.
- **Er wird beim Anbinden benutzt und nicht geglaubt.** Die Zone-ID kommt aus der
  Antwort des Anbieters, nicht aus dem Formular. Findet der Token die Domain nicht,
  nennt die Meldung die Zonen, die er stattdessen sieht. Der häufigste Fehler ist ein
  Token, der für eine andere Domain (Cloudflare) oder ein anderes Projekt (Hetzner)
  erzeugt wurde, und „nicht gefunden" schickt einen dabei in die falsche Richtung.

Welcher Token es sein muss: bei Cloudflare ein API-Token mit „Zone → DNS → Bearbeiten"
auf der Zone, bei Hetzner ein Token des Projekts, in dem die Zone liegt, mit Lese- und
Schreibrecht. Der von Hetzner gilt für alle Zonen seines Projekts, und es ist derselbe,
den der acme.sh-Hook als `HETZNER_TOKEN` benutzt.

Jeder Aufruf vermerkt sein Ergebnis an der Zeile (`withZone`). Ohne das sähe eine Zone,
deren Token seit drei Wochen abgelaufen ist, aus wie jede andere. Auffallen würde es beim
nächsten Proxy-Ziel, also genau dann, wenn jemand es eilig hat. Am Ergebnis steht die
Meldung deutsch, wie eine Aufzeichnung; die Routen liefern sie in der Sprache der Anfrage
(`zoneErrorText`).

## Eine Zone anbinden: ein Weg, `connectZone`

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
  als `dns_zone_updated` und die Seite sagt „war schon angebunden".
- **`delegated` geht mit zurück.** Eine Zone kann beim Anbieter angelegt sein, ohne
  dass die Nameserver der Domain dorthin zeigen; Einträge darin wirken dann nicht.
  Cloudflare sagt es über den Status der Zone (`active`), Hetzner über seine eigene
  Prüfung (`delegation_status`). `null` heißt unbekannt (bei Hetzner: noch nicht
  geprüft) und nicht „ja". Die Seite warnt beim Anbinden nur bei einem klaren Nein und
  zeigt den Stand danach an jeder Zone.

**Den Token austauschen ist nicht dasselbe** (`replaceZoneToken`): dort muss der neue
Token genau DIESE Zone sehen. Mit dem längsten Suffix hätte ein Token, der
`intern.example.org` nicht sieht, aber `example.org`, den Zugang einer anderen Zone
ersetzt und wäre als „gespeichert" zurückgekommen.

`ensureAddressRecord` in derselben Datei sorgt dafür, dass ein Name als A (IPv4) oder
AAAA (IPv6) genau auf eine Adresse zeigt, bei Cloudflare ohne Proxy:

- Ein **CNAME** unter dem Namen wird nicht überschrieben, die Meldung nennt ihn. Ihn zu
  ersetzen hieße, eine Weiterleitung zu löschen, von der der Aufruf nichts weiß.
  Dasselbe gilt für einen Eintrag der eigenen Art, den der Anbieter gesperrt hat
  (`locked`, siehe unten).
- Ersetzt wird **nur die eigene Art**. Ein AAAA-Eintrag bleibt stehen, wenn eine
  IPv4-Adresse gesetzt wird, und umgekehrt: sonst nähme der zweite Aufruf für einen
  Server mit beiden Adressen den Eintrag des ersten wieder weg.
- Stehen unter dem Namen mehrere Einträge der Art, bleibt genau einer. Stimmt einer
  schon, bleibt der, samt TTL und Notiz.
- Verglichen wird die Adresse, nicht ihr Text (`sameAddress`): `2001:db8::1` und
  `2001:0db8:0:0:0:0:0:1` sind dieselbe.

`locked` kommt vom Anbieter. Bei Cloudflare sind es Einträge, die Cloudflare selbst
pflegt. Bei Hetzner sind es drei Dinge: ein Satz, den jemand dort gegen Änderungen
geschützt hat, der SOA, und die NS-Einträge der Zone selbst. Die setzt Hetzner beim
Anlegen der Zone, und ohne sie wird die Zone nicht mehr ausgeliefert.

## Domain → Zone ist ein Suffixvergleich

`lib/dns/zones.ts` importiert nichts außer dem reinen `lib/i18n`, aus demselben Grund
wie `lib/haproxy/config.ts`: das Formular im Browser stellt dieselbe Frage wie die Route
auf dem Server, und zwei Antworten darauf wären ein Dialog, der einen Haken anbietet,
den das Speichern anders auslegt. Der Vergleich ist bei beiden Anbietern derselbe: er
arbeitet auf dem Namen der Zone, und den führen beide gleich.

- **Der Punkt ist der Riegel.** `kunde.example` liegt nicht in der Zone `fremdekunde.example`,
  obwohl der Name darin vorkommt. Dieselbe Falle wie beim `-m end -i .kunde.example` der
  HAProxy-ACL.
- **Die längste Zone gewinnt.** Sind `kunde.example` und `intern.kunde.example` beide angebunden,
  gehört `app.intern.kunde.example` in die speziellere. Sonst schriebe das Werkzeug in eine
  Zone, die für diesen Namen gar nicht mehr zuständig ist.
- **Eine Wildcard ist keine Ausnahme.** `*.kunde.example` endet auf `.kunde.example` wie jeder
  andere Name darunter. Ihr das `*.` abzuschneiden wäre ein Fehler: dann sähe
  `*.kunde.example` aus wie die Zone selbst, und der Eintrag würde als „auf der Root nicht
  möglich" abgewiesen (`tests/dns/zones.test.ts`).
- **Der Name einer Zone ist eng geprüft** (`validateZoneName`): eine Zone `de` deckte jede
  deutsche Domain ab, und ein Name mit `*` oder `/` darin ist keiner.

## Hetzner rechnet in RRSets, HAPM in Einträgen

Hetzner kennt keinen einzelnen Eintrag mit Kennung. Es führt je Name und Art einen Satz
von Werten (`www/A` mit zwei Adressen), und die TTL gehört dem Satz. HAPM rechnet wie bei
Cloudflare mit einem Eintrag je Wert. Die Abbildung steht in
`lib/dns/hetzner-rrsets.ts`, rein und ohne Netz (`tests/dns/hetzner-rrsets.test.ts`).

**Die Kennung eines Eintrags ist Name, Art und Wert**, lesbar verpackt (base64url) und
nicht gehasht. So benennt Hetzner einen Wert selbst, und zum Entfernen braucht es den
Wert WÖRTLICH, wie Hetzner ihn führt: aus der gelesenen Form ist er nicht sicher
zurückzurechnen (`"a" "b"` und `"ab"` sind derselbe TXT-Text). Ändert jemand den Wert in
der Konsole, ist es ein anderer Eintrag mit anderer Kennung, und der alte ist „nicht
mehr da".

**Geschrieben wird je Wert, nie der ganze Satz.** `add_records` und `remove_records`
fassen bei Hetzner nur den genannten Wert an. Ein Satz, der hier gelesen, im Speicher
geändert und mit `set_records` zurückgeschrieben würde, nähme einen Wert mit, den jemand
anderes in der Zwischenzeit daneben gesetzt hat. Wichtig, weil die übrigen Werte eines
Namens beim Anbieter gepflegt werden und nicht hier.

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
- **Die TTL eines bestehenden Satzes ändert sich beim Anlegen nicht.** „Keine eigene
  TTL" heißt hier: so lassen, wie der Name sie hat, und nicht: die der Nachbarn
  zurücksetzen.
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

**Wie Hetzner Werte schreibt**, und was HAPM daraus macht (`readValue`, `writeValue`):

| Art | bei Hetzner | in HAPM |
|---|---|---|
| Name des Eintrags | relativ zur Zone, `@` für die Zone selbst | voller Name |
| CNAME, NS | Ziel mit Punkt am Ende: `example.org.` | Ziel ohne Punkt |
| MX | Priorität und Ziel in einem Wert: `10 mail.example.org.` | Priorität als eigenes Feld |
| TXT | in Anführungszeichen, ab 255 Zeichen in Stücke geteilt | der Text, ohne Anführungszeichen |
| A, AAAA, alles andere | wie es dasteht | wie es dasteht |

Ein Ziel OHNE Punkt am Ende wird beim Lesen relativ zur Zone verstanden (`www` ist
`www.example.org`, `@` die Zone), wie in einer Zonendatei. HAPM schreibt Ziele immer mit
Punkt, der Fall kommt also nur von Einträgen, die jemand anderes gesetzt hat.

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
nicht ausprobiert: dass ein Ziel ohne Punkt relativ zur Zone ist, dass `add_records`
ohne `ttl` an einem Satz mit eigener TTL diese behält (deshalb wird sie mitgeschickt),
wie Hetzner einen Namen wie `*` im Pfad erwartet, und in welchen Fällen es `locked` oder
`conflict` meldet. Wer hier einen Fehler findet, findet ihn in `hetzner.ts` oder
`hetzner-rrsets.ts` und sonst nirgends.

## Der Haken im Reverse-Proxy-Dialog

Liegt eine Domain des Dienstes in einer angebundenen Zone, steht sie im Abschnitt
„DNS-Einträge" des Dienst-Dialogs. Gefragt wird `/api/dns/match`, entprellt um eine halbe
Sekunde: die Antwort hängt an einem Feld, in das gerade jemand tippt.

**Gefragt wird der Server und nicht der Browser**, weil zwei Dinge nur dort bekannt sind:
der Token, und der ECHTE Bestand beim Anbieter. Ein Haken, der gesetzt ist, weil der
Eintrag schon steht, ist eine Aussage über die Zone. Geraten stünde sie genau dann
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
| die Zone selbst | aus, gesperrt | dort gehört ein A-Eintrag hin, beim Anbieter gepflegt |
| nichts | frei, Vorgabe **an** | der Schalter erscheint nur für angebundene Zonen, und die bindet man an, damit genau das passiert |

**Der Zustand hält fest, wer den Schalter AUSgeschaltet hat, nicht wer ihn angelassen
hat** (`dnsWanted[domain] !== false`). Mit `false` als Vorgabe müsste ein Effekt den
Zustand nachziehen, sobald die Antwort eintrifft, und dann stünde die Zeile einen Render
lang mit Haken da, ohne beim Speichern mitzuzählen. Dieselbe Überlegung wie beim
vorausgewählten DNS-Hook, der abgeleitet und nicht in den Zustand geschrieben wird.

**Der Eintrag ist ein CNAME auf die Zone selbst, nicht auf eine IP.** Das setzt voraus,
dass der A-Eintrag der Zone (die Root) auf diesen Server zeigt; er wird beim Anbieter
gepflegt, und `sync.ts` legt ihn nicht an. Jeder Dienst darunter hängt sich daran. Die
Adresse dieses Servers stattdessen in jeden Eintrag zu schreiben hieße, dieselbe IP in
dreißig Einträgen zu führen: ein Umzug wären dann dreißig Änderungen statt einer. Zeigt
die Root woandershin, zeigt auch der CNAME dorthin: dann den Haken auslassen und den
Eintrag beim Anbieter setzen.

**Nicht proxied.** Der Verkehr geht direkt an HAProxy: Let's Encrypt kommt sonst über
HTTP-01 nicht durch, und die Client-IP im Access-Log (Statistik, Admin-IPs, Absenderlisten)
wäre die von Cloudflare. Bei Hetzner gibt es die Frage nicht.

**Die Auswahl ist je Domain und nicht ein Schalter für alle.** Ein Dienst bedient oft
`kunde.example` (fremde Zone) und `app.example.com` (eine eigene), und gemeint ist dann nur
die zweite.

`selectedDnsDomains` schneidet die Liste aus dem Rumpf gegen die Domains des Dienstes.
Ohne diesen Riegel ließe sich über die Reverse-Proxy-Route ein Eintrag in einer beliebigen
angebundenen Zone anlegen, ohne dass am Proxy etwas damit zu tun hätte. Dieselbe
Überlegung wie bei `lockedDomains`.

## Die Reihenfolge im Lauf

Der DNS-Teil hängt in `lib/haproxy/runner.ts` und nicht in `provision.ts`: ein CNAME beim
DNS-Anbieter hat mit `haproxy.cfg` nichts zu tun, kein Kommando, keine Datei, kein Lock.
Umgekehrt kennt `lib/dns/sync.ts` kein HAProxy; es bekommt Domains und liefert Schritte.

- **Angelegt wird VOR dem Zertifikat** (Phase `dns`, vor `preflight`). Let's Encrypt prüft
  über HTTP-01, also über die Domain selbst; zeigt sie noch nirgendwohin, scheitert der
  Antrag, und ein Fehlversuch zählt gegen ein Kontingent. Ein Eintrag, der danach entstünde,
  käme für genau den Fall zu spät, für den man ihn braucht. Bei Hetzner kommt der Schritt
  erst zurück, wenn die Aktion ausgeführt ist (siehe oben), aus demselben Grund.
- **Ein Fehlschlag dabei hält den Vorgang nicht auf.** Der Dienst wird trotzdem angelegt,
  denn eine Domain, die schon woanders aufgelöst wird, funktioniert auch ohne unseren
  Eintrag. Der Schritt steht aber als Fehler in der Zeile, und der Lauf endet auf `error`.
- **Entfernt wird zuletzt und nur nach einem sauberen Lauf** (Phase `cleanup`). Ein
  gescheitertes Löschen lässt den Dienst stehen, und ihm dann den CNAME wegzunehmen nähme
  eine laufende Domain offline: der Fehler wäre nicht der abgebrochene Vorgang, sondern
  das, was danach fehlt.
- **Beim Löschen eines Ziels ist es ein Schalter im Bestätigungsdialog, vorbelegt auf an.**
  Angeboten wird er nur, wenn es tatsächlich einen eigenen Eintrag gibt: die Seite fragt
  dafür `/api/dns/match`, bevor sie den Dialog öffnet. Ein Häkchen „DNS-Eintrag
  mitlöschen" an einer Domain ohne angebundene Zone wäre eine Frage ohne Wirkung, und
  beim nächsten Mal glaubt man ihr nicht mehr. **Ohne `removeDns: true` im Rumpf fasst die
  Route DNS nicht an**: ein Löschvorgang, der bei einem Aufrufer ohne diese Angabe
  stillschweigend auch Einträge entfernt, hätte eine Nebenwirkung, die man ihm später
  nicht mehr ansieht.
- **Überschrieben wird nie.** Steht unter dem Namen schon etwas anderes, bleibt es stehen
  und der Schritt sagt, was dort steht. Entfernt wird nur, was `isProxyRecord` als eigenen
  Eintrag erkennt; ein A-Eintrag von Hand geht beim Löschen des Ziels nicht mit.
- **Beim Ändern verliert eine herausgefallene Domain ihren Eintrag.** Der Vergleich
  passiert in der Route und vor dem Schreiben: danach steht in der Konfiguration nur noch
  die neue Liste. Deshalb gibt `precheckUpdate` den Dienst zurück, wie `precheckDelete` es
  tut.
- **Die Schritte des DNS-Teils werden dem Ergebnis vorangestellt** (`prefix` im Runner).
  `provision.ts` meldet seine eigene Liste und weiß von ihnen nichts; ohne das Voranstellen
  verschwände der DNS-Schritt aus der Zeile, sobald der erste HAProxy-Schritt gemeldet wird.
- **Die Schritte werden am Lauf gespeichert.** Texte mit eingesetzten Werten bleiben
  deshalb deutsch, bis das Format `{ text, params }` trägt; die ohne Werte entstehen mit
  `msgid` und werden beim Zeigen übersetzt ([`i18n.md`](i18n.md)).

## Eine Anbindung zu entfernen ändert beim Anbieter nichts

Die Zone bleibt, ihre Einträge bleiben, alles läuft weiter. Das gilt bei Cloudflare wie
bei Hetzner: gelöscht wird nur die Zeile in `dns_zones`. Weg ist nur der Zugang von
hier, und damit der Haken im Proxy-Dialog. Der Bestätigungsdialog sagt genau das: ein
Knopf, der wie „aus der Liste nehmen" aussieht und eine ganze Domain offline nimmt,
wäre die teuerste Verwechslung, die diese Seite anbieten könnte.

Protokolliert wird `dns_zone_created`, `dns_zone_updated` und `dns_zone_deleted` für die
Anbindung, `dns_record_created` und `dns_record_updated` für den Eintrag, den der
Einrichtungsassistent setzt.
