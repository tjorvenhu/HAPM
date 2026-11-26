# DNS

**Lies das, bevor du an /dns, lib/dns/ oder der DNS-Anbindung des Reverse-Proxys etwas
änderst.**

Der Bereich „DNS" ist eine **Anbindung**, keine Verwaltung von Einträgen. HAPM hält den
Zugang zu Zonen bei vier Anbietern und schreibt damit nur, was es selbst braucht:

| Anbieter | Kennung | Zugang | acme.sh-Hook |
|---|---|---|---|
| Hetzner (das DNS in der Cloud-Konsole) | `hetzner` | API-Token | `dns_hetznercloud` |
| Cloudflare | `cloudflare` | API-Token | `dns_cf` |
| Ein eigener Nameserver über RFC 2136 (BIND und andere) | `rfc2136` | Nameserver und TSIG-Schlüssel | `dns_nsupdate` |
| Infoblox (WAPI) | `infoblox` | Appliance, Benutzer, Passwort, DNS-View | `dns_infoblox` |

Geschrieben wird:

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
[`reverse-proxy.md`](reverse-proxy.md)). Es ist derselbe Anbieter und derselbe Zugang,
und der Einrichtungsassistent richtet beides in einem Schritt ein: der Zugang geht an
acme.sh, und die Zone wird hier angebunden.

Die Zugänge liegen als Dokumente in Postgres (`dns_zones`), der Schlüssel für die Tokens
entsteht beim ersten Start von selbst. Was unten für Cloudflare und Hetzner steht, gilt
für RFC 2136 und Infoblox genauso, soweit ihr eigener Abschnitt nichts anderes sagt.

## Ohne Anbieter: der eigene DNS-Server

Nicht jede Installation hat einen Anbieter mit API. Ein Netz mit Pi-hole,
AdGuard Home oder dem Router trägt seine Einträge von Hand ein, und ein BIND,
für den niemand einen TSIG-Schlüssel freigeben will, ebenso. (Mit TSIG-Schlüssel
ist ein eigener Nameserver ein Anbieter wie die anderen, siehe „RFC 2136".)
Dafür steht im Assistenten neben den Anbietern die Karte „Eigener
DNS-Server" (`SetupState.dns: 'manual'`). Gewählt heißt: HAPM legt bei keinem
Anbieter etwas an, es gibt keine Zone unter „DNS", und überall, wo sonst ein
Eintrag entstünde, steht, was einzutragen ist (der Schritt „Adresse der
Oberfläche" nennt Name, Typ und Wert, „Wo" sagt „In Ihrem DNS-Server").

Was es nicht gibt, und warum: DNS-01 von Hand (acme.sh `--dns` ohne Hook, der
TXT-Eintrag wird abgetippt). Damit ließe sich ein Zertifikat einmal ausstellen,
aber nie erneuern, ohne dass alle 60 Tage jemand einen TXT-Eintrag setzt. Ohne
Anbieter mit API kommen Zertifikate deshalb über HTTP-01 (öffentlich, oder intern
mit einem eigenen ACME-Server, der HAPM über Port 80 erreicht) oder werden
hochgeladen, siehe [`reverse-proxy.md`](reverse-proxy.md), „Hochgeladene
Zertifikate" und „Ein eigener ACME-Server". Eine Wildcard geht dann nur
hochgeladen.

## Ein Anbieter ist eine Schnittstelle, kein zweiter Bereich

`lib/dns/provider.ts` beschreibt, was HAPM von einem Anbieter braucht: die Zonen eines
Zugangs nennen, die Einträge einer Zone lesen, einen Eintrag anlegen, ändern, löschen.
Gelesen wird, um zu wissen, was unter einem Namen schon steht; geschrieben wird nur von
`sync.ts` und `ensureAddressRecord`. Dahinter stehen `cloudflare.ts`, `hetzner.ts`,
`rfc2136.ts` und `infoblox.ts`, und nur dort entsteht eine Anfrage an den Anbieter.
Routen, `sync.ts` und `connect.ts` holen sich den Anbieter einer Zone mit
`providerFor(zone)` und kennen keinen beim Namen.

| Datei | Was dort steht |
|---|---|
| `provider.ts` | die Schnittstelle (`DnsProvider`) und die Zuordnung Kennung → Anbieter |
| `cloudflare.ts`, `hetzner.ts` | je ein Anbieter: URL, Fehlermeldungen, Blättern |
| `hetzner-rrsets.ts` | RRSet ↔ Einträge, rein und ohne Netz |
| `rfc2136.ts` | der eigene Nameserver: Abfragen und Änderungen über TCP, jede mit TSIG |
| `dns-wire.ts` | DNS-Nachrichten und TSIG als Bytes, rein und ohne Netz |
| `infoblox.ts` | die Appliance über die WAPI, mit `node:https` wegen der eigenen CA |
| `access.ts` | der Zugang zu RFC 2136 und Infoblox: Prüfung der Eingabe, Form als Text, rein |
| `errors.ts` | `DnsUnreachableError`: nicht erreichbar sagt nichts über die Zugangsdaten |
| `records.ts` | was ein Eintrag ist, `PROVIDER_RULES`, `sameAddress` |
| `zones.ts` | Domain → Zone, `DnsProviderId`, `dnsProviderForHook`, `providerOf`, Prüfung des Zonennamens |
| `provider-info.ts` | Name, Zeichen, Konsole und Felder eines Anbieters für Oberfläche und Meldungen, `accessFromInput` |
| `store.ts` | die eigene Datenbank: Zeilen, Token entschlüsseln, Ergebnis vermerken |
| `connect.ts` | eine Zone anbinden, den Token austauschen, einen Adress-Eintrag sicherstellen |
| `sync.ts` | der DNS-Teil eines Reverse-Proxy-Vorgangs |

**Der Zugang ist für alles außerhalb des Anbieters ein Text.** Bei Cloudflare und Hetzner
ist es der API-Token. Bei RFC 2136 und Infoblox sind es mehrere Angaben, als JSON
(`access.ts`). `connect.ts` und `store.ts` verschlüsseln und entschlüsseln ihn, ohne
hineinzusehen, und `dns_zones.apiToken` heißt weiter so. Wer den Zugang aus einem
Formular baut, nimmt `accessFromInput` (`provider-info.ts`): es prüft die Felder mit
derselben Funktion wie die Zugangsdaten für acme.sh.

**Nicht jeder Anbieter zählt auf.** Cloudflare und Hetzner nennen alle Zonen eines
Tokens und alle Einträge einer Zone. Ein Nameserver über RFC 2136 kann beides nicht
(ohne Zonentransfer), und ein Infoblox-Grid führt oft Tausende Zonen. Deshalb sagt
jeder Aufrufer dazu, worum es ihm geht:

- `listZones(token, near)` bekommt die Domain. Wer nicht aufzählt
  (`PROVIDER_RULES[...].listsZones === false`), liefert die Zone, in der sie liegt.
- `listRecords(token, zone, names)` bekommt die vollen Namen. Wer nicht aufzählt,
  liefert, was unter ihnen steht. `sync.ts`, `ensureAddressRecord` und
  `/api/dns/match` geben die Namen ihrer Zone mit.
- `assertWritable(token, zone)` gibt es nur, wo Lesen und Ändern zweierlei sind
  (RFC 2136). `connect.ts` ruft es vor dem Speichern.

Wer aufzählen kann, darf `near` und `names` übergehen. Für einen neuen Aufrufer heißt
das: immer mitgeben, sonst liest er bei RFC 2136 nichts.

**`dns_zones.provider` darf fehlen.** Eine Zeile ohne das Feld ist Cloudflare: sie
stammt aus der Zeit, in der es nur diesen Anbieter gab. Deshalb gibt es keine Migration,
und deshalb liest jede Stelle über `providerOf(zone)` und nie über das Feld
(`tests/dns/providers.test.ts`, `tests/dns/connect.test.ts`).

**Was nur ein Anbieter kennt, bleibt an ihm hängen.** Die Unterschiede stehen in
`PROVIDER_RULES` (`records.ts`), und wer schreibt, fragt dort:

| | Cloudflare | Hetzner | RFC 2136 | Infoblox |
|---|---|---|---|---|
| Proxy über die Server des Anbieters (`proxied`) | ja, HAPM schreibt immer `false` | gibt es nicht | gibt es nicht | gibt es nicht |
| „keine eigene TTL" | `ttl: 1` („automatisch", keine Sekunde) | `ttl: null`, es gilt die TTL der Zone | `ttl: null`: die TTL, die der Name schon hat, sonst eine Stunde | `ttl: null` (`use_ttl: false`), es gilt die der Zone |
| wem die TTL gehört | dem Eintrag | dem Namen samt Art (RRSet) | dem Namen samt Art (RRSet) | dem Eintrag |
| zählt Zonen und Einträge auf (`listsZones`) | ja | ja | nein | nein, gefragt wird gezielt |
| Kennung eines Eintrags | die des Anbieters | Name, Art und Wert | Name, Art und Wert (wie auf der Leitung) | die des Anbieters (`_ref`) |
| Notiz am Eintrag (`comment`) | ja | ja | gibt es nicht | ja |
| ob die Nameserver auf den Anbieter zeigen (`delegated`) | ja | ja | `null`, er ist selbst der Nameserver | `null` |

**Name, Zeichen, Konsole und Felder stehen genau einmal**, bei den Zugangsdaten für
acme.sh (`DNS_PROVIDERS` in `lib/haproxy/dns-credentials.ts`): es ist derselbe Anbieter
und derselbe Zugang, ob acme.sh damit eine Wildcard ausstellt oder HAPM damit Einträge
schreibt. `provider-info.ts` schlägt über den Hook nach, `dnsProviderForHook` und
`hookForDnsProvider` in `zones.ts` sind die Brücke. RFC 2136 und Infoblox haben kein
Zeichen unter `public/providers/`: `components/dns/ProviderName.tsx` zeigt für sie ein
Symbol. Ihre Felder zeigt an allen drei Stellen (Assistent, Zugangsdaten für acme.sh,
Zone anbinden) derselbe Baustein, `components/dns/CredentialFields.tsx`.

## Es gibt keine Collection für die Einträge

Dieselbe Entscheidung wie beim Reverse-Proxy, aus demselben Grund: die Wahrheit über
eine Zone liegt beim Anbieter, und eine Spiegelung in der Datenbank wäre genau dann
falsch, wenn jemand dort (Dashboard, Konsole) etwas geändert hat. Wer wissen muss, was
unter einem Namen steht (`sync.ts`, `ensureAddressRecord`, `/api/dns/match`), liest die
Einträge der Zone in dem Moment beim Anbieter.

`dns_zones` trägt deshalb nur den **Zugang**: Anbieter, Name, Zone-ID, Token, und wann
er zuletzt funktioniert hat. Die Liste unter `/dns` prüft ihn bei jedem Aufruf: sie
fragt mit dem Token, welche Zonen er sieht (`listZones`, mit dem Namen der Zone als
`near`). Steht die Zone darunter, funktioniert der Zugang, und dieselbe Antwort sagt, ob
die Nameserver auf den Anbieter zeigen. Der Preis ist eine Abfrage je Zone und
Poll-Takt, deshalb läuft die Seite im 60-Sekunden-Takt und nicht in 30. Bei RFC 2136
ist die Abfrage eine unterschriebene Frage nach dem SOA der Zone, bei Infoblox eine
Suche nach genau dieser Zone. Die „Zone-ID" ist dort keine Kennung des Anbieters,
sondern nennt, wen HAPM anspricht: den Nameserver (`ns1.example.org`, mit Port, wenn er
nicht 53 ist) oder Appliance und View (`infoblox.example.org/default`). Die Karte zeigt
sie unter diesem Namen und lässt die Zeile „Nameserver zeigen auf …" weg.

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
den der acme.sh-Hook als `HETZNER_TOKEN` benutzt. Bei RFC 2136 ist es ein TSIG-Schlüssel,
den der Nameserver für die Zone freigibt (`allow-update` oder `update-policy`), bei
Infoblox ein Konto mit API-Zugang und Schreibrecht auf die Zonen. Für beide gilt
dasselbe wie für den Token: verschlüsselt gespeichert, nie an den Browser, nie im
Protokoll. Zum Austauschen gibt man alle Angaben neu ein, weil sich keine anzeigen lässt.

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
- **Wer nicht aufzählt, wird nach der Domain gefragt.** RFC 2136 und Infoblox bekommen
  sie als `near` und liefern die Zone, in der sie liegt. Findet sich keine, nennt die
  Meldung keine Zonen, „die der Zugang stattdessen sieht": es gibt keine Liste, aus der
  sie kämen. Die Fehler davor (falscher Schlüssel, abgelehnte Anmeldung, falsche View)
  wirft der Anbieter selbst, mit seinem Grund.
- **Lesen dürfen heißt nicht ändern dürfen.** Wo der Anbieter das unterscheidet
  (`assertWritable`, heute nur RFC 2136), wird es vor dem Speichern geprüft. Ein
  Schlüssel ohne Freigabe fiele sonst erst beim ersten Ziel auf.

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
den das Speichern anders auslegt. Der Vergleich ist bei jedem Anbieter derselbe: er
arbeitet auf dem Namen der Zone, und den führen alle gleich.

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

Der Name eines Satzes ist bei Hetzner immer relativ, auch wenn er wie ein voller
aussieht: `app.example.org` in der Zone `example.org` ist
`app.example.org.example.org` (`rrsetFqdn`). Als voller Name gelesen stünde er als
Eintrag des Ziels `app.example.org` da, und HAPM hielte ihn für seinen eigenen.

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

## RFC 2136: ein eigener Nameserver

Für BIND und jeden Nameserver, der Änderungen als DNS-UPDATE (RFC 2136) mit einem
TSIG-Schlüssel (RFC 8945) annimmt. Eingegeben werden der primäre Nameserver (Name oder
Adresse, Port 53 als Vorgabe), der Name des Schlüssels, das Verfahren (HMAC-SHA256 als
Vorgabe, dazu SHA384 und SHA512) und das Geheimnis als Base64.

**HAPM spricht den Nameserver selbst**, in Node (`rfc2136.ts`, die Bytes in
`dns-wire.ts`), und ruft dafür kein `nsupdate` auf. Das Geheimnis geht so durch kein
Kommando und liegt für HAPMs eigene Aufrufe in keiner Datei, die Antwort wird geprüft
statt aus Text gelesen, und es läuft auch unter `pnpm dev` und in den Tests. `nsupdate`
liegt trotzdem im Abbild (`bind9-dnsutils`): acme.sh ruft es für die Challenge auf, siehe
[`reverse-proxy.md`](reverse-proxy.md).

- **Über TCP, jede Nachricht unterschrieben, jede Antwort geprüft.** Eine Antwort ohne
  gültige Unterschrift desselben Schlüssels ist ein Fehler (`verifyTsig`), kein
  „gespeichert". Die Uhren dürfen fünf Minuten auseinanderliegen, wie TSIG es vorsieht.
  Der Nameserver muss Port 53 über TCP annehmen.
- **Die Zone wird gesucht** (`findZone`): gefragt wird nach dem SOA der Domain und dann
  ihrer Eltern, bis der Nameserver einen als seinen eigenen beantwortet (`AA`). Führt er
  `example.org` und `intern.example.org`, gewinnt die engere. Verweist er auf andere
  Nameserver, führt er die Domain nicht.
- **Beim Anbinden geht eine Änderung ohne Inhalt hinaus** (`assertWritable`). Der
  Nameserver prüft daran Zone, Schlüssel und, bei `allow-update`, die Freigabe, und
  ändert nichts. Bei `update-policy` entscheidet er je Eintrag: dort zeigt sich eine
  fehlende Freigabe erst beim ersten Schreiben, mit derselben Meldung.
- **Gelesen wird gezielt**, je Name die Arten CNAME, A, AAAA, TXT, MX und NS. `NXDOMAIN`
  auf die erste Frage spart die übrigen. Einen Zonentransfer braucht es nicht.
- **Ein CNAME entsteht nur unter einem freien Namen**, und das entscheidet der
  Nameserver: die Änderung trägt die Vorbedingung „unter dem Namen steht nichts"
  (RFC 2136, 2.4.5). Ohne sie nimmt ein Nameserver einen CNAME neben anderen Daten an
  und wirft ihn still weg (3.4.2.2). Ein A-Eintrag trägt umgekehrt „hier steht kein
  CNAME". Nach jeder Änderung liest HAPM nach: steht der Eintrag nicht da, ist das ein
  Fehler.
- **Ändern ist eine Nachricht** (alter Wert weg, neuer hin): der Nameserver führt sie
  ganz aus oder gar nicht. Anders als bei Hetzner gibt es keinen Zwischenstand.
- **Die TTL gehört dem Namen samt Art.** Ein neuer Wert übernimmt die der vorhandenen.
  Hat der Name noch keine, ist es eine Stunde (`RFC2136_DEFAULT_TTL`): eine Vorgabe der
  Zone kennt das Protokoll nicht.
- **Ein Stern in der Zone antwortet für jeden Namen darunter**, und die Antwort trägt
  den erfragten Namen. Sie sähe aus wie ein Eintrag, den es nicht gibt, und HAPM
  meldete beim Anlegen eines Ziels „steht bereits". Deshalb die Gegenprobe
  (`synthesized`): antwortet ein erfundener Nachbarname genauso, fragt HAPM den
  Nameserver, ob es den Namen wirklich gibt, mit einer Änderung, die nur aus der
  Vorbedingung „der Name ist belegt" besteht und nichts ändert.
- **Was es nicht gibt:** GSS-TSIG (das Verfahren von Windows DNS mit Active Directory),
  HMAC-MD5 und HMAC-SHA1, Notizen an Einträgen, mehrere Nameserver für eine Zone. Wer
  zwei primäre hat, nennt einen.

**Geprüft gegen ein echtes BIND 9.20** mit `pnpm dns:verify` (Docker): Zone finden,
falsches Geheimnis, unbekannter Schlüssel, fehlende Freigabe (`allow-update` und
`update-policy`), Anlegen, Lesen, Ändern und Entfernen von CNAME, A, AAAA und TXT, der
Stern, dazu der Weg von acme.sh bis zum ausgestellten und erneuerten Zertifikat. Andere
Nameserver (Knot, PowerDNS) liefen nicht mit. Was dort abweichen kann: wie eine leere
Änderung beantwortet wird und ob eine verneinende Antwort den SOA der Zone nennt. Die
Tests gegen den nachgestellten Nameserver (`tests/dns/fake-nameserver.ts`) halten fest,
was HAPM erwartet.

Eingerichtet wird der Schlüssel auf dem Nameserver, bei BIND etwa so:

```
# tsig-keygen -a hmac-sha256 hapm
key "hapm" {
    algorithm hmac-sha256;
    secret "…";
};

zone "example.org" {
    type primary;
    file "example.org.zone";
    update-policy { grant hapm zonesub ANY; };
};
```

## Infoblox: die WAPI

Eingegeben werden die Appliance (Grid Master, Name oder Adresse, wahlweise mit Port),
Benutzer, Passwort, die DNS-View (Vorgabe `default`), wahlweise die Fassung der WAPI
(Vorgabe 2.2.2, dieselbe, die der acme.sh-Hook fest benutzt) und wahlweise das
Zertifikat einer eigenen Zertifizierungsstelle als PEM.

- **Je Eintragsart ein eigenes Objekt** (`record:a`, `record:aaaa`, `record:cname`,
  `record:txt`), gelesen mit vollem Namen und View. Ein Eintrag hat eine Kennung
  (`_ref`), Ändern und Entfernen gehen über sie.
- **Zonen werden gesucht, nicht gelistet**: `zone_auth?fqdn=` für die Domain und ihre
  Eltern. Findet sich keine, fragt HAPM nach der View: „die View gibt es nicht" ist eine
  andere Meldung als „keine Zone". Rückwärtszonen bleiben außen vor.
- **Ein Host-Eintrag** (`record:host`) ist bei Infoblox ein eigenes Objekt mit Adressen.
  Er erscheint als A oder AAAA und gesperrt: HAPM sieht ihn, damit unter dem Namen kein
  zweiter Eintrag entsteht, und ändert ihn nicht.
- **Nach dem Schreiben liest HAPM den Eintrag über seine Kennung**, statt die Eingabe zu
  glauben.
- **Das Zertifikat der Appliance wird geprüft, immer.** Einen Schalter dagegen gibt es
  nicht: darüber gehen Benutzer und Passwort. Die eigene CA gilt zusätzlich zu den
  öffentlichen Stellen, und das Zertifikat muss auf den eingetragenen Namen ausgestellt
  sein. Eine Appliance mit dem Werkszertifikat (ausgestellt auf `www.infoblox.com`)
  braucht also zuerst ein eigenes. Die Meldungen sagen, woran es liegt: unbekannte
  Stelle, falscher Name, abgelaufen.
- **`node:https` und nicht `fetch`**, weil nur dort eine eigene CA je Anfrage mitgehen
  kann. Ein Proxy für ausgehende Verbindungen (`HTTPS_PROXY`) gilt für diese Aufrufe
  nicht: die Appliance steht im eigenen Netz.
- **Das Passwort** kennt kein Leerzeichen, keinen Apostroph, keinen Backslash und keine
  Umlaute. Die Grenze kommt von acme.sh, das dieselben Zugangsdaten als Shell-Zeile
  ablegt, und sie gilt hier mit, damit unter „DNS" nichts durchgeht, was dort scheitert.
  Ein Benutzer der Form `DOMAIN\name` geht aus demselben Grund nicht.

**Was davon nie gegen eine echte Appliance lief: alles.** Beim Bau gab es keine. Die
Aufrufe folgen der WAPI-Dokumentation von Infoblox und dem acme.sh-Hook `dns_infoblox`,
der dieselbe Anmeldung, dieselbe Fassung und `view` als Parameter benutzt.
`tests/dns/infoblox.test.ts` prüft gegen einen Nachbau im Speicher und die Verbindung
selbst (eigene CA, falscher Name) gegen einen echten HTTPS-Server. Insbesondere nur aus
der Beschreibung gelesen: dass eine Folgeseite über `_page_id` ihre Felder behält, dass
`POST` die Kennung als JSON-Text zurückgibt, wie die Appliance einen CNAME neben
vorhandenen Daten ablehnt (erwartet: 400 mit `text`), dass `view?name=` für eine
unbekannte View eine leere Liste liefert, und die Namen der Felder an `record:host`.
Wer hier einen Fehler findet, findet ihn in `infoblox.ts` und sonst nirgends.

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

**Der Schalter arbeitet für jeden Anbieter gleich**, und `sync.ts` kennt keinen beim
Namen: es bekommt den Anbieter über `providerFor(zone)`. Angelegt wird derselbe Eintrag,
ein CNAME auf die Zone selbst. Was abweicht, kommt aus `PROVIDER_RULES`: die TTL ist die
Vorgabe des Anbieters (Cloudflare `1`, Hetzner und Infoblox die der Zone, RFC 2136 eine
Stunde), und `proxied: false` geht nur an Cloudflare mit. Bei Hetzner steht der Wert als
`example.org.` mit Punkt in der Zone und kommt ohne Punkt zurück, bei RFC 2136 und
Infoblox ebenfalls ohne Punkt und klein, `isProxyRecord` erkennt ihn also unverändert.
Die Zone selbst bekommt bei keinem Anbieter einen CNAME (`proxyRecordPlan`). Bei
RFC 2136 lehnte ihn zudem der Nameserver ab: dort steht immer schon der SOA.
`proxyRecordPlan` trägt weiter `ttl: 1` und `proxied: false`: das ist der Plan in der
Schreibweise von Cloudflare, und wer schreibt, nimmt die Vorgabe seines Anbieters.

**Jede Domain wird außerdem aufgelöst**, auch ohne angebundene Zone
(`resolution` in `DomainMatch`, `checkDomainAddress` aus `lib/setup/address.ts`,
derselbe Resolver wie im Einrichtungsassistenten). Der Abschnitt zeigt dann je
Domain, worauf sie zeigt und ob das eine Adresse dieses Servers ist. Löst sie
nicht auf und liegt sie in einer angebundenen Zone, ist das der Vorschlag: der
Schalter steht schon an, und die Zeile sagt, dass er den Eintrag anlegt. Gefragt
wird parallel zum Lesen der Zone, eine gescheiterte Abfrage heißt unbekannt und
nicht „kein Eintrag". Eine Wildcard wird nicht aufgelöst, sie hat keine eigene
Adresse.

**Löst die Domain schon auf, ohne in der Zone zu stehen, ist der Schalter aus.**
Die Antwort kommt dann von woanders, meist vom DNS-Server im eigenen Netz, und
die Domain ist absichtlich nur dort bekannt. Ein Eintrag in der angebundenen
Zone machte sie im ganzen Internet auflösbar. Der Schalter lässt sich trotzdem
einschalten, und die Zeile sagt genau das dazu (`resolvesElsewhere`,
`dnsChosen` im Dialog). Bei RFC 2136 trifft das auch einen Namen, den nur ein
Stern in der angebundenen Zone beantwortet: er löst auf, steht aber nicht als
eigener Eintrag da.

Fünf Zustände, und jeder sagt etwas anderes:

| Was gefunden wird | Schalter | Grund |
|---|---|---|
| genau unser CNAME | an, gesperrt | steht schon; Tooltip nennt Zone und Ziel |
| ein anderer Eintrag | aus, gesperrt | wird nicht angefasst, Tooltip nennt Art und Wert |
| die Zone selbst | aus, gesperrt | dort gehört ein A-Eintrag hin, beim Anbieter gepflegt |
| nichts | frei, Vorgabe **an** | der Schalter erscheint nur für angebundene Zonen, und die bindet man an, damit genau das passiert |
| nichts, aber die Domain löst schon auf | frei, Vorgabe **aus** | sie ist woanders eingetragen, meist intern; der Eintrag machte sie öffentlich |

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

Die Zone bleibt, ihre Einträge bleiben, alles läuft weiter. Das gilt bei jedem
Anbieter: gelöscht wird nur die Zeile in `dns_zones`. Die Zugangsdaten für acme.sh
(Reverse-Proxy, Einstellungen) bleiben dabei auch stehen: sie gehören acme.sh. Weg ist nur der Zugang von
hier, und damit der Haken im Proxy-Dialog. Der Bestätigungsdialog sagt genau das: ein
Knopf, der wie „aus der Liste nehmen" aussieht und eine ganze Domain offline nimmt,
wäre die teuerste Verwechslung, die diese Seite anbieten könnte.

Protokolliert wird `dns_zone_created`, `dns_zone_updated` und `dns_zone_deleted` für die
Anbindung, `dns_record_created` und `dns_record_updated` für den Eintrag, den der
Einrichtungsassistent setzt.
