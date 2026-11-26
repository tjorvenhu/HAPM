# Die Reverse-Proxy-API

`/api/internal/haproxy/**`: alles, was der Dialog unter `/reverse-proxy` kann,
ohne Browser. Für ein Deploy-Skript, eine Pipeline, einen anderen Dienst.

Der größere Teil dieser Datei ist die Anleitung für den **Aufrufer**: was über
HTTP geht und welche Regeln dabei gelten. Der letzte Abschnitt („Für den, der
die Routen ändert") sagt, warum die Routen so gebaut sind. Die Regeln des
Reverse-Proxys selbst stehen in [`reverse-proxy.md`](reverse-proxy.md).

Dasselbe gibt es als MCP-Server für Sprachmodelle (Claude Code, Claude
Desktop, claude.ai): `/api/mcp`, mit denselben Keys und denselben Regeln,
beschrieben in [`mcp.md`](mcp.md).

Zwei Dinge vorweg:

- **Es gibt genau ein HAProxy.** `GET /proxies` liefert eine Liste mit einem
  Eintrag, seine `id` ist `local`. `serverId` gibt es als Parameter und
  als Feld in jeder Antwort; als Parameter ist es **überall weglassbar**, dann
  gilt die lokale Maschine. Ein anderer Wert als `local` gibt `404`.
- **Ein Token hat keine Bereiche.** Es gilt für diesen Baum und alles andere
  unter `/api/internal` (Updates, Sicherung, Einstellungen, Log,
  Grundkonfiguration: [`hapm-api.md`](hapm-api.md)). Es lässt sich an
  Adressen binden.

## Zugang

Ein API-Key, ausgestellt in HAPM unter **Reverse-Proxy → API und MCP**
(`/reverse-proxy/api`). Im Reiter „Endpunkte“ (`?bereich=endpunkte`) stehen
auch die fertige Basis-URL zum Kopieren und die Liste der Endpunkte. Verwaltet werden dieselben Token auch unter
`/service-tokens`. Der Klartext erscheint genau einmal, in der Antwort auf
das Anlegen — verloren heißt neu ausstellen, nicht wiederherstellen. Er beginnt
mit `hapm_`.

```http
Authorization: Bearer hapm_…
```

Ersatzweise `X-Service-Token: hapm_…`, falls ein Proxy dazwischen den
Authorization-Header für sich beansprucht.

- **Kein CSRF-Token.** Der schützt einen Browser mit Cookie; hier gibt es
  weder das eine noch das andere.
- **Basis-URL ist die Adresse, unter der HAPM erreichbar ist.**
- **20 Fehlversuche je Adresse und Stunde**, danach `429`. Gezählt werden nur
  Fehlversuche, ein Dienst sperrt sich also nicht durch Arbeit selbst aus.
- Ein zurückgezogenes Token antwortet mit `401`, genau wie ein unbekanntes. Der
  Unterschied hilft nur jemandem, der Token durchprobiert.

### Herkunft einschränken

Zu jedem Key gehört eine Liste erlaubter Adressen — einzelne IPs oder
CIDR-Bereiche, IPv4 und IPv6. **Leer heißt: von überall.** Steht etwas darin und
die Anfrage kommt von woanders, antwortet der Aufruf mit `403` und nennt die
Adresse, die angekommen ist:

```json
{ "success": false, "error": "Die Adresse 198.51.100.4 ist für dieses Token nicht freigegeben." }
```

Zwei Dinge sind dabei zu wissen, bevor man eine Liste einträgt:

- **Verglichen wird die Adresse, die bei HAPM ankommt** (`getClientIP` in
  `lib/audit.ts`): über das eigene HAProxy der **rechteste**
  `X-Forwarded-For`-Eintrag, direkt über den Port von HAPM die Gegenstelle der
  Verbindung. Der linkeste Eintrag ist vom Aufrufer frei wählbar; eine Freigabe,
  die sich mit einem Header umgehen lässt, wäre keine. `X-Real-IP` liest HAPM
  nie. Daraus folgt eine Bedingung an die globalen HTTPS-Zeilen: sie müssen
  `X-Forwarded-For` setzen (so die Grundkonfiguration) oder anhängen
  (`option forwardfor`). Wenn unklar ist,
  welche Adresse ankommt: einmal aufrufen und auf der Karte unter „Zuletzt
  benutzt" nachsehen.
- **IPv4 und IPv6 sind zwei Einträge.** Eine Freigabe `203.0.113.7` trifft keine
  IPv6-Adresse. Wer hinter einem Dual-Stack-Anschluss sitzt, trägt beide ein —
  sonst hängt der Zugang davon ab, welche Familie der Client gerade wählt.

Eine abgewiesene Adresse zählt als Fehlversuch (siehe die 20 oben) und steht
mit Namen im Aktivitätsprotokoll (`service_token_ip_rejected`).

## Antwortform

Jede Route, immer:

```ts
type ApiResponse<T> =
  | { success: true; data: T }
  | { success: false; error: string };
```

`error` ist ein **deutscher Satz für Menschen** („Die Domain kunde.example wird
bereits von website_kunde bedient."). Er ist zum Anzeigen und Protokollieren
gedacht, nicht zum Auswerten — verzweigt wird über den HTTP-Status:

| Status | Bedeutung |
|---|---|
| `400` | Die Eingabe stimmt nicht (ungültige Domain, unbekanntes Preset, fehlendes Pflichtfeld) |
| `401` | Token fehlt, ist unbekannt oder zurückgezogen |
| `403` | Das Token gilt, aber die Adresse des Aufrufers ist nicht freigegeben |
| `404` | Diese Dienst-ID oder diesen Lauf gibt es nicht, oder `serverId` ist nicht `local` |
| `409` | Konflikt in der Konfiguration: ID belegt, Domain gehört einem anderen Eintrag, Eintrag nicht bearbeitbar, Ziel der Oberfläche von HAPM (`surface`) |
| `429` | Zu viele Fehlversuche |
| `502` | Die Konfiguration von HAProxy ist nicht lesbar |

## Der Ablauf

Schreiben dauert Minuten: DNS-Eintrag, Zertifikat bei Let's Encrypt,
`haproxy -c`, Reload. Deshalb antwortet keine schreibende Route mit dem
Ergebnis, sondern mit einer **Lauf-ID**.

```
POST /api/internal/haproxy/services      → { runId }
GET  /api/internal/haproxy/runs/<runId>  → { status: "running", phase, steps }
   … alle 2 Sekunden, bis status !== "running"
```

In der Praxis kommen nur `success` und `error` heraus; rechne mit bis zu **fünf
Minuten**, allein die Zertifikatsausstellung darf so lange dauern.

**`status: "error"` heißt nicht, dass nichts passiert ist.** Der Vorgang hat
mehrere Teile, und ein Abbruch im vierten kann einen gesetzten DNS-Eintrag und
ein ausgestelltes Zertifikat hinterlassen haben. Was durchkam, steht in `steps`
— jeder Schritt mit `ok` und Begründung. Zurückgerollt wird auf Verdacht nichts:
das nähme auf einem Reverse-Proxy fremde Domains offline.

Was sich **ohne** Schreibvorgang beantworten lässt, kommt dagegen sofort als
Fehler zurück und landet gar nicht erst in einem Lauf: belegte Dienst-ID, fremde
Domain, fehlendes acme.sh, Wildcard ohne DNS-Hook. Ein Aufruf, der mit einer
Lauf-ID antwortet und eine Minute später „Dienst-ID bereits vergeben" in die
Historie schreibt, zwänge dich, den Fehlerfall aus einem Protokolltext zu lesen.

## Endpunkte

Alle unter `/api/internal/haproxy/`.

| Endpunkt | Was er tut |
|---|---|
| `GET /proxies` | das eine HAProxy: Gruppen, Admin-IPs, DNS-Hooks, `acmeReady` |
| `GET /services` | Einträge, gefiltert über `?scope=` `?domain=` |
| `POST /services` | anlegen → `{ runId, serviceId }` |
| `GET /services/<id>` | ein Eintrag, mit `editable` / `removable` / `health` |
| `PATCH /services/<id>` | ändern → `{ runId }` |
| `DELETE /services/<id>` | entfernen → `{ runId }` |
| `GET /streams` | TCP-Weiterleitungen; mit `?port=` stattdessen: ist der Port frei |
| `POST /streams` | anlegen → `{ runId, streamId }` |
| `GET`/`PATCH`/`DELETE /streams/<id>` | einzeln lesen, ändern, entfernen |
| `GET /runs` | die Historie, gefiltert über `?serviceId=` `?mine=true` |
| `GET /runs/<id>` | Stand des Vorgangs: `status`, `phase`, `steps` |
| `GET`/`POST`/`DELETE /scopes` | Gruppen |
| `GET`/`PATCH /settings` | HTTPS-Zeilen und die Admin-Adressliste |
| `GET /certificates` | was acme.sh führt, samt „benutzt von" |
| `DELETE /certificates?domain=` | ein übriges Zertifikat von acme.sh entfernen |
| `POST /certificates/issue` | einen nie ausgestellten Antrag erneut stellen → `{ runId }` |
| `GET`/`POST`/`DELETE /certificate-authorities` | Zertifizierungsstellen für die Prüfung der Ziele: auflisten, hinterlegen oder ersetzen, entfernen |

Grundkonfiguration, Fehlerseiten, Log und Statistik liegen ebenfalls unter
`/api/internal/haproxy/`, beschrieben in [`hapm-api.md`](hapm-api.md).

### `GET /proxies`

Womit eine Pipeline anfängt: die Gruppen und die Auskunft, ob überhaupt ein
Zertifikat ausgestellt werden kann. Die Antwort ist eine Liste mit genau einem
Eintrag. Eine frische Installation hat keine Gruppe: `scopes` ist dann leer,
und die erste entsteht über `POST /scopes` oder in der Oberfläche.

```ts
type Proxy = {
  id: string;              // immer "local"; die serverId für alle anderen Aufrufe
  name: string;            // HAPM_NODE_NAME oder der Hostname
  host: string;            // "127.0.0.1"
  version: string | null;  // null heißt unbekannt, nicht "nicht installiert"
  acmeReady: boolean;      // false → Anlegen scheitert, acme.sh fehlt
  dnsHooks: string[];      // eingerichtete acme.sh-DNS-Hooks, z. B. ["dns_cf"]
  scopes: {
    name: string;          // so heißt sie im Aufruf: "KUNDEN"
    slug: string;          // Adressteil in der Oberfläche
    label: string;         // Beschriftung
    complete: boolean;     // false → dort lässt sich nichts einfügen
    removable: boolean;
  }[];
  adminIps: string[];
  serviceCount: number;
  streamCount: number;     // TCP-Weiterleitungen, getrennt gezählt
  error: string | null;    // gesetzt: die Konfiguration ließ sich nicht lesen
};
// data: Proxy[]   (ein Eintrag)
```

`acmeReady: false` schließt nur die Einträge **mit Domain** aus. Eine
TCP-Weiterleitung braucht kein Zertifikat und geht auch dann. acme.sh richtet
HAPM beim Start selbst ein; `false` heißt, dass diese Einrichtung gescheitert
ist.

### `GET /services`

Alle Einträge. Filter: `?scope=` `?domain=` (und `?serverId=`, das nur `local`
kennt). Der Domainfilter vergleicht **exakt** — `kunde.example` findet nicht
`app.kunde.example` und schon gar nicht `fremdekunde.example`.

```ts
type Service = {
  serverId: string;            // "local"
  serverName: string;
  id: string;                  // die Dienst-ID = der Backend-Name
  scope: string | null;        // null: außerhalb aller Marker, von Hand gepflegt
  scopeSlug: string | null;
  domains: string[];           // domains[0] ist die Hauptdomain
  lockedDomains: string[];     // die gesperrten Domains
  lockMode: "ip" | "password" | null;   // wie sie gesperrt sind; null ohne gesperrte Domain
  // `weight: null` heißt: es steht KEINE weight-Angabe in der Zeile, es gilt
  // HAProxys Vorgabe. Nicht 1 — wer null als 1 zurückschickt, schreibt eine
  // Zahl in jede Zeile, in der vorher keine stand.
  servers: { name: string; target: string; check: boolean; weight: number | null }[];
  // Gesetzt: die Domains werden weitergeleitet statt bedient. Dann sind
  // `servers`, `routes` und die Header leer, `tunnel` und `healthcheck` false.
  redirect: { to: string; keepPath: boolean; permanent: boolean } | null;
  // Die Ziele einer Regel tragen KEIN weight: sie verteilen nichts.
  routes: {
    name: string;
    paths: string[];
    servers: { name: string; target: string; check: boolean }[];
    check: boolean;
    backendTls: 'off' | 'insecure' | 'verify' | `ca:${string}`;   // eigen je Regel, siehe unten
    backendVerifyHost: string | null;                              // eigen je Regel, siehe unten
  }[];
  // Das Verteilverfahren. null heißt: keine balance-Zeile, es gilt der
  // defaults-Block der Konfiguration — nicht "roundrobin".
  balance: 'roundrobin' | 'leastconn' | 'source' | 'uri' | 'random' | null;
  sticky: boolean;             // Sitzungsbindung über einen Cookie
  // Feste Header an den Besucher und an das Ziel, in der Reihenfolge der
  // Datei. `value` ist der Text, wie er ankommt (nicht maskiert).
  responseHeaders: { name: string; value: string }[];
  requestHeaders: { name: string; value: string }[];
  tunnel: boolean;             // `timeout tunnel 1h`: offene Verbindungen bleiben
  crowdsec: boolean;           // eigener Schalter: CrowdSec prüft dieses Ziel
  app: string | null;          // Anwendung hinter dem Ziel, Kennung aus get_crowdsec_rules
  healthcheck: boolean;
  // Wie HAProxy die Ziele anspricht: HTTP, HTTPS ohne Prüfung des Zertifikats,
  // HTTPS mit Prüfung gegen die CAs des Systems oder gegen eine hinterlegte
  // Zertifizierungsstelle ("ca:intern-root", Namen aus /certificate-authorities).
  backendTls: 'off' | 'insecure' | 'verify' | `ca:${string}`;
  // Der feste Name, gegen den das Zertifikat der Ziele geprüft wird, statt der
  // Domain der Anfrage ("app01.intern.example"). null: die Domain der Anfrage.
  // Immer in der Antwort: PATCH ersetzt die ganze Definition.
  backendVerifyHost: string | null;
  editable: boolean;           // false → PATCH wird abgelehnt
  removable: boolean;          // false → DELETE wird abgelehnt
  // true: über dieses Ziel läuft die Adresse von HAPM. DELETE wird abgelehnt,
  // auch bei removable: true, ebenso ein PATCH ohne die Domain der Adresse.
  surface: boolean;
  shadowedBy: string | null;   // ein Eintrag weiter oben nimmt ihm den Verkehr weg
  extras: string[];            // Zeilen, die dieser Weg nicht abbilden kann
  health: 'up' | 'down' | 'partial' | 'unknown';
};

// data: {
//   services: Service[];
//   unreachable: { serverId: string; serverName: string; error: string }[];
// }
```

`unreachable` ist ein eigenes Feld und keine Ausnahme: eine leere Liste hieße
sonst „es gibt keine Einträge" statt „die Konfiguration ließ sich nicht lesen" —
und darauf würde eine Pipeline etwas anlegen, das es längst gibt. **Prüf das
Feld, bevor du aus einer leeren Liste einen Schluss ziehst.**

### `POST /services`

```jsonc
{
  "serverId": "local",                // weglassbar
  "scope": "KUNDEN",                  // Pflicht, aus GET /proxies
  "id": "kunde_shop",                 // optional, a-z 0-9 _; fehlt sie, ergibt sie sich aus domains[0]
  "domains": ["kunde.example", "www.kunde.example"],   // Pflicht, die erste ist die Hauptdomain
  "servers": [{ "name": "", "target": "10.0.0.12:3000" }],   // Pflicht, außer bei redirect
  "redirect": null,                   // optional, siehe unten
  "routes": [],                       // optional
  "balance": null,                    // optional: Verteilverfahren
  "sticky": false,                    // optional: Sitzungsbindung
  "lockedDomains": [],                // optional
  "lockPassword": "…",                // optional: sperrt mit Passwort statt auf Admin-IPs
  "responseHeaders": [{ "name": "X-Frame-Options", "value": "SAMEORIGIN" }],   // optional
  "requestHeaders": [],               // optional
  "tunnel": false,                    // optional: lange Verbindungen (WebSocket, Terminal)
  "app": "nextcloud",                 // optional: Anwendung hinter dem Ziel, für CrowdSec
  "healthcheck": true,
  "backendTls": "off",                // optional: "insecure", "verify" oder "ca:<name>", wenn das Ziel HTTPS spricht
  "backendVerifyHost": null,          // optional: Name im Zertifikat des Ziels, wenn es nicht die Domain nennt
  "dnsDomains": "auto",               // optional
  "dnsHook": "dns_cf"                 // nur für DNS-01, und nur bei mehreren Hooks nötig
}
→ data: { runId: string; serverId: string; serviceId: string }
```

**`serviceId` in der Antwort ist die ID, unter der der Eintrag angelegt wird.**
Ohne `id` im Rumpf vergibt HAPM sie aus der Hauptdomain, wie im Dialog:
`shop.kunde.example` wird `shop_kunde_example`, `*.kunde.example` wird
`wildcard_kunde_example`, ist sie vergeben, kommt `_2`, `_3` dran. Unter dieser
ID steht der Eintrag danach in `GET /services/<id>`, und sie ändert sich nicht,
auch nicht mit der Hauptdomain. Wer die ID selbst bestimmen will, schickt sie
mit; dann gilt sie, oder es kommt `409`, wenn sie belegt ist.

**`preset` wird weiter angenommen** und in das übersetzt, was es in der Datei
immer war: `nextcloud` in die beiden Header der Antwort `X-Robots-Tag:
noindex,nofollow` und `X-Permitted-Cross-Domain-Policies: none`, `coolify` in
`tunnel: true`, `default` in nichts. Ein ausdrücklich in `responseHeaders`
genannter Header gleichen Namens gewinnt. Ein unbekanntes `preset` ergibt
`400`. In Antworten kommt `preset` nicht mehr vor: ein Eintrag aus der
Preset-Zeit steht dort mit seinen Headern bzw. `tunnel: true`.

Mehrere Einträge in `servers` sind Lastverteilung. Das reicht schon ohne
`balance` — dann verteilt HAProxy nach dem, was im `defaults`-Block steht. Mit
`balance` und `weight` bestimmst du, wie:

```jsonc
{
  "servers": [
    { "name": "web1", "target": "10.0.0.12:3000", "weight": 3 },
    { "name": "web2", "target": "10.0.0.13:3000", "weight": 1 }
  ],
  "balance": "leastconn",
  "sticky": true
}
```

Eine Pfad-Regel (gleiche Domain, anderer Port) sieht so aus:

```jsonc
"routes": [
  { "name": "terminal", "paths": ["/terminal"], "check": false,
    "servers": [{ "name": "", "target": "10.0.0.12:6002" }] }
]
```

### `GET /services/<id>`

Ein Eintrag. `404`, wenn es ihn nicht gibt. Antwort ist ein `Service` (siehe
oben).

### `PATCH /services/<id>`

**Der Rumpf ist vollständig, kein Teil-Patch.** Wer nur `servers` schickt,
bekommt einen Eintrag ohne Domains, und die Prüfung lehnt ihn ab. Der Weg ist:
`GET`, das Ergebnis ändern, `PATCH`. Die `id` im Pfad ist die **alte** — fehlt
sie im Rumpf, bleibt sie, steht dort eine andere, wird umbenannt. Das gilt auch
für `responseHeaders`, `requestHeaders`, `tunnel`, `crowdsec` und `app`: wer sie nicht mitschickt,
nimmt sie dem Eintrag weg. Ein Aufrufer, der noch `preset` schickt, sollte
deshalb auf GET, ändern, PATCH umstellen, sonst gehen Header verloren, die
jemand in der Oberfläche gesetzt hat.

Vorher `editable` prüfen. `false` heißt: der Block in der Konfiguration enthält
Zeilen, die dieser Weg nicht abbilden kann (`extras` sagt welche), und sie gingen
beim Speichern verloren. Löschen bleibt trotzdem erlaubt.

Domains, die aus der Liste fallen, verlieren ihren DNS-Eintrag — aber nur, wenn
HAPM ihn selbst gesetzt hat.

Bei `surface: true` muss die Domain aus der Adresse von HAPM in `domains`
bleiben (oder von einer Wildcard darin getroffen werden), sonst `409`. Alles
andere an dem Eintrag lässt sich ändern.

### `DELETE /services/<id>`

```jsonc
{ "removeDns": true }
```

**`removeDns` fehlt heißt: die DNS-Einträge bleiben stehen.** Der Dialog belegt
den Haken mit „ja" vor, weil ein Mensch ihn sieht und abwählen kann; ein Aufruf
ohne das Feld hat nichts gesagt. Entfernt wird ohnehin nur, was HAPM
selbst gesetzt hat — ein A-Eintrag von Hand bleibt stehen und sagt das als
Schritt.

**Das Ziel der Oberfläche lässt sich nicht entfernen** (`surface: true`, `409`).
Über es ist HAPM selbst erreichbar. Welches Ziel das ist, ergibt sich aus der
Adresse von HAPM in den Einstellungen, nicht aus einem Namen. Wer es wirklich
loswerden will, ändert zuerst diese Adresse in der Oberfläche unter
„Allgemein". Danach lässt sich das Ziel entfernen. Über die API geht das nicht. Siehe
[`reverse-proxy.md`](reverse-proxy.md), „Das Ziel der Oberfläche ist geschützt".

### `GET /streams`, `POST /streams`

TCP-Weiterleitungen: ein Port dieses Servers, durchgereicht an ein Ziel
dahinter. Kein HTTP, keine Domain, kein Zertifikat, kein DNS-Eintrag — dafür
ein Port, und der ist eine Ressource des Servers.

Filter beim Lesen: `?scope=`. Mit `?port=` beantwortet derselbe
Endpunkt stattdessen die andere Frage:

```jsonc
GET /streams?port=5432&exclude=pg_alt
→ data: { serverId, serverName, port: 5432, free: false,
          reason: "In der Konfiguration gebunden von \"listen pg_intern\"." }
```

**Frag das, bevor du anlegst.** `haproxy -c` bindet keine Sockets: ein belegter
Port kommt durch die Prüfung und scheitert erst beim Reload. `exclude` ist beim
Ändern die eigene Kennung, sonst meldet der Test einen Konflikt mit sich selbst.
`free: true` mit gesetztem `reason` heißt „es ließ sich nicht
feststellen" — das ist keine Zusage.

```ts
type Stream = {
  serverId: string;
  serverName: string;
  id: string;                  // Kennung = Name des listen-Abschnitts
  scope: string | null;
  scopeSlug: string | null;
  port: number | null;         // null: keine lesbare bind-Zeile, dann editable: false
  servers: { name: string; target: string; check: boolean; weight: number | null }[];
  balance: 'roundrobin' | 'leastconn' | 'source' | 'random' | null;
  check: boolean;              // TCP-Verbindungsprobe auf den Zielen
  allowedSources: string[];    // LEER HEISST: von überall erreichbar
  editable: boolean;
  removable: boolean;
  extras: string[];
  health: 'up' | 'down' | 'partial' | 'unknown';
};

// data: { streams: Stream[]; unreachable: […] }
```

```jsonc
POST /streams
{
  "serverId": "local",              // weglassbar
  "scope": "KUNDEN",                // Pflicht
  "id": "pg_kunde",                 // optional, a-z 0-9 _; fehlt sie: tcp_<port>
  "port": 5432,                     // Pflicht, 1–65535
  "servers": [{ "name": "db1", "target": "10.0.0.50:5432", "weight": null }],
  "balance": null,                  // optional; "uri" gibt es hier nicht
  "check": true,
  "allowedSources": ["10.0.0.0/8"]  // optional — leer heißt von überall
}
→ data: { runId: string; serverId: string; streamId: string }
```

Ohne `id` vergibt HAPM die Kennung aus dem Port (`tcp_5432`, ist sie vergeben,
`tcp_5432_2`) und nennt sie als `streamId`. Sie bleibt, auch wenn sich der Port
später ändert.

**`allowedSources` wegzulassen ist erlaubt und heißt „von überall".** HAPM setzt
dir nichts vor: welche Absender an diesen Port dürfen, weißt nur
du. Welche der beiden Formen es war, steht im Protokoll.

`balance` kennt hier vier Werte statt fünf. `uri` fehlt, weil es den angefragten
Pfad liest, und den gibt es in `mode tcp` nicht — HAProxy lehnt die Datei ab.

Vier Ports sind gesperrt und kommen als `400` zurück: **22** (SSH, der Zugang
zum Server), **80**, **443** und **8888** (die ACME-Challenge, ohne die sich
kein Zertifikat mehr erneuern lässt).

**Die Firewall macht dieser Aufruf nicht auf.** Er ändert `haproxy.cfg` und lädt
HAProxy neu, mehr nicht. Damit der Port von außen erreichbar ist, muss er
zusätzlich freigegeben sein — auf dem Server (nftables, ufw, firewalld) und in
der Firewall des Anbieters, falls davor eine liegt. Ein Lauf mit
`status: "success"` sagt darüber nichts: er sagt, dass HAProxy jetzt lauscht.

### `GET /streams/<id>`, `PATCH /streams/<id>`, `DELETE /streams/<id>`

Wie bei den Diensten: die `id` im Pfad ist die **alte**
(fehlt sie im Rumpf, bleibt sie; eine andere heißt umbenennen), und der
PATCH-Rumpf ist **vollständig**.
Vorher `editable` prüfen.

Für `allowedSources` heißt das ausdrücklich: **das Feld wegzulassen setzt die
Liste auf leer**, es erbt nicht den alten Stand. Ein PATCH, der eine
Absenderliste stillschweigend übernimmt, wäre der, nach dem niemand mehr sagen
kann, warum ein Port offen ist.

`DELETE` braucht keinen Rumpf (`serverId` ist weglassbar). Kein `removeDns` — es
gibt keinen Eintrag, der dazugehören könnte. Der Port nimmt danach keine
Verbindungen mehr an, und was gerade darüber läuft, bricht ab.

### `GET /runs`, `GET /runs/<runId>`

`GET /runs` ist die Historie, falls du deine Lauf-ID verloren hast — nach einem
Neustart zwischen POST und Poll, oder wenn ein Job aus einer Warteschlange neu
aufgesetzt wird. Filter: `?serviceId=` `?status=` `?action=`
`?limit=` (max. 100) `?offset=`, dazu `?mine=true` für die Vorgänge über diese
Schnittstelle (und `?serverId=`, das nur `local` kennt). `serviceId` ist bei
einer TCP-Weiterleitung ihre Kennung.

```ts
type Run = {
  id: string;
  serverId: string;             // "local"
  serverName: string;
  action:
    | 'create' | 'update' | 'delete'
    | 'stream-create' | 'stream-update' | 'stream-delete'
    | 'settings' | 'scope-add' | 'scope-remove';
  serviceId: string;
  renamedTo: string | null;
  status: 'running' | 'success' | 'error';
  phase:
    | 'queued' | 'dns' | 'preflight' | 'certificate'
    | 'checking' | 'installing' | 'cleanup' | 'done';
  startedAt: string;            // ISO
  completedAt: string | null;
  duration: number | null;      // Sekunden
  error: string | null;
  steps: { label: string; ok: boolean; detail?: string }[];
  log: string;                  // dieselben Schritte als Text
};
```

`phase` ist für eine Anzeige, nicht für eine Entscheidung. Die trifft `status`.
Ein `stream-*`-Lauf überspringt `dns` und `certificate` — er beantragt kein
Zertifikat. `queued` heißt: ein anderer Vorgang am selben HAProxy läuft noch,
dieser wartet dahinter und beginnt danach mit `preflight`.

`GET /runs` liefert dieselben Felder plus `domains`, `targets` und
`triggeredBy`, aber kein `log`. Bei einer TCP-Weiterleitung steht in `domains`
der Port statt einer Domainliste: nach dem Löschen gibt es nichts mehr, woraus
sich die Adresse lesen ließe, unter der sie erreichbar war.

### `GET /scopes`, `POST /scopes`, `DELETE /scopes`

```jsonc
POST   { "name": "KUNDEN" }
DELETE { "name": "KUNDEN" }
→ data: { name, runs: [{ runId, serverId, serverName }] }
```

Die Marker einer Gruppe stehen in `haproxy.cfg`. `runs` ist eine Liste mit
**genau einem Eintrag**. Wer über die Liste iteriert und alle abwartet, macht
das Richtige. Ein `serverId` nimmt die Route nicht.

Name: 2 bis 24 Zeichen, `a-z 0-9 _ -`, beginnt mit einem Buchstaben. Entfernen
geht nur, wenn die Gruppe leer ist. Umbenennen gibt es nicht. Die Gruppe, in
der das Ziel der Oberfläche liegt (`surface: true` am Eintrag), wird mit `409`
abgelehnt, mit diesem Grund statt mit „nicht leer".

`GET` liefert `[{ serverId, serverName, scopes, error }]` (ein Eintrag).

### `GET /settings`, `PATCH /settings`

Was keinem Dienst gehört, sondern HAProxy als Ganzem.

```ts
// GET
type Settings = {
  serverId: string;
  serverName: string;
  httpsLines: string[] | null;  // null: der Marker fehlt, es gibt keine Stelle dafür
  adminIps: string[];
  adminEditable: boolean;       // false: die ACL steht mehrfach da, wird nicht angefasst
  lockedServices: string[];     // Dienste, die gerade auf diese Liste zeigen
  protection: {                 // null: der Block # Zugriffsschutz ist von Hand geändert
    blockedIps: string[];       // 403 für jeden Dienst, auch für Admin-IPs
    blockedCountries: string[]; // ISO-Codes, 403 außer für Admin-IPs
    rateLimit: { requests: number; period: '10s' | '1m' | '10m' } | null;
  } | null;
  editable: boolean;
  dnsHooks: string[];
};
```

**Der einzige Teil-Patch der ganzen API** — was nicht im Rumpf steht, bleibt
stehen. Ein Aufruf zum Eintragen einer Adresse soll nicht nebenbei HSTS
entfernen.

```jsonc
PATCH { "addAdminIps": ["203.0.113.7"] }      // dazu
PATCH { "removeAdminIps": ["203.0.113.7"] }   // weg
PATCH { "adminIps": ["10.0.0.0/8"] }          // die ganze Liste ersetzen
PATCH { "httpsLines": ["option forwardfor", …] }
PATCH { "blockedCountries": ["RU", "CN"] }    // die ganze Liste ersetzen
PATCH { "blockedIps": ["203.0.113.0/24"] }
PATCH { "rateLimit": { "requests": 300, "period": "10s" } }
PATCH { "rateLimit": null }                   // abschalten
→ data: { runId, serverId, adminIps, protection }
```

Ein Land, das die GeoIP-Tabelle nicht kennt, wird mit `400` abgelehnt. Anders
als in der Oberfläche prüft die Route nicht, ob der Aufrufer sich selbst
aussperrt. Was die Sperren in `haproxy.cfg` schreiben, steht in
`docs/reverse-proxy.md`, „Der Zugriffsschutz".

`adminIps` zusammen mit `addAdminIps` wird mit `400` abgelehnt statt aufgelöst:
„setze auf A und nimm B dazu" hat zwei vertretbare Ergebnisse.

Die Liste **lässt sich nicht leeren, solange ein Eintrag darauf zeigt**
(`lockedServices`). Eine Regel ohne ihre ACL ist für HAProxy „unknown acl", und
dann wird die ganze Datei abgelehnt — HAProxy stünde beim nächsten Start.

### `GET /certificates`

Ein Zertifikat entsteht und vergeht mit seinem Ziel. Was übrig bleibt (von
einem gelöschten Ziel, von Hand ausgestellt, ein gescheiterter Antrag),
entfernt `DELETE /certificates?domain=<mainDomain>`, aber nur, solange kein
Ziel es hält: das prüft `removeAcmeCertificate` im Lock, dieselbe Regel wie
auf der Zertifikatsseite (`409` mit den Zielen sonst). Synchron, Antwort
`{ mainDomain, reloaded }`. Hochgeladene Zertifikate entfernt und ersetzt nur
die Oberfläche, weil nur sie hochladen kann.

`POST /certificates/issue` mit `{ "mainDomain": "*.example.com", "dnsHook"?: "dns_cf" }`
stellt einen Antrag erneut, den acme.sh führt, der aber nie ausgestellt wurde,
typisch eine Wildcard, deren DNS-Challenge bei der Einrichtung scheiterte. Nur
mit seinen eigenen Domains; ein ausgestelltes Zertifikat gibt `409`, das
erneuert acme.sh selbst. Antwort `{ runId }`, Stand unter `/runs/<runId>`.

```ts
type ProxyCertificates = {
  serverId: string;
  serverName: string;
  acmeReady: boolean;
  dnsHooks: string[];
  certificates: {
    mainDomain: string;
    domains: string[];
    keyLength: string | null;
    renewAt: string | null;   // roher Text von acme.sh
    usedBy: string[];         // Dienst-IDs; leer = übrig oder von Hand ausgestellt
  }[];
  error: string | null;
};
```

### `GET`, `POST`, `DELETE /certificate-authorities`

Die hinterlegten Zertifizierungsstellen, gegen die ein Ziel das Zertifikat
seines Backends prüfen kann (`backendTls: "ca:<name>"`). Gedacht für Ziele mit
Zertifikat aus einer internen CA. Das sind Vertrauensanker und keine
Zertifikate, die HAProxy Besuchern ausliefert (die stehen unter
`/certificates`).

```ts
type CertificateAuthorities = {
  warnDays: number;            // ab so vielen Tagen vor dem Ablauf gilt eine Stelle als „läuft bald ab"
  authorities: {
    name: string;              // "intern-root": so heißt sie in backendTls ("ca:intern-root")
    file: string;              // "/etc/haproxy/hapm-ca/intern-root.pem"
    certificates: {            // leer: die Datei ist nicht lesbar
      subject: string;
      issuer: string;
      notBefore: string;       // ISO
      notAfter: string;
      fingerprint: string;     // SHA-256, "AB:CD:…"
      selfSigned: boolean;
      ca: boolean;
    }[];
    notAfter: string | null;   // der früheste Ablauf der Datei
    daysLeft: number | null;   // negativ: abgelaufen
    usedBy: { id: string; slug: string | null }[];   // Ziele, die gegen sie prüfen
  }[];
  error: string | null;        // gesetzt: nicht lesbar, die Liste heißt dann „unbekannt"
};
```

`POST` mit `{ "name": "intern-root", "certificate": "-----BEGIN CERTIFICATE-----…", "replace"?: true }`
hinterlegt eine Stelle. `certificate` ist PEM, ein Zertifikat oder mehrere
hintereinander (Root und Zwischenstellen). Der Name: Kleinbuchstaben, Ziffern
und Bindestriche, höchstens 40 Zeichen. Er wird zum Dateinamen und bleibt.
Synchron, Antwort `{ name, file, certificates, notAfter, reloaded, usedBy, warnings }`.

- **Hochladen geht hier**, anders als bei `/certificates`: in der Datei steht
  kein Geheimnis. Ein privater Schlüssel im Text ergibt `400`, ebenso ein
  abgelaufenes Zertifikat und das Zertifikat eines Servers, das weder eine CA
  noch selbst signiert ist.
- **Ohne `replace: true` wird ein vergebener Name nicht überschrieben** (`409`).
  Mit `replace` wird die Datei einer vorhandenen Stelle ausgetauscht (`404`,
  wenn es sie nicht gibt). Benutzt ein Ziel sie, prüft HAProxy die
  Konfiguration und lädt neu (`reloaded: true`). Ziele, deren Zertifikat die
  neue Datei nicht bestätigt, antworten danach mit 503.
- `warnings` ist eine Liste von Sätzen, etwa dass ein selbst signiertes
  Zertifikat eines Servers nur genau dieses Ziel durchlässt.

`DELETE /certificate-authorities?name=<name>` entfernt eine Stelle, aber nur,
solange `haproxy.cfg` ihre Datei nirgends nennt (`409` mit den Zielen sonst):
mit einer `ca-file`, die fehlt, lädt HAProxy die ganze Konfiguration nicht
mehr. Antwort `{ name }`.

Ein Ziel mit `backendTls: "ca:<name>"`, dessen Stelle nicht hinterlegt ist,
wird beim Anlegen und Ändern mit `409` abgelehnt, bevor ein Lauf startet.

### Was es hier bewusst nicht gibt

**Die DNS-Zugangsdaten für Wildcards** (in der Oberfläche unter Reverse-Proxy →
Einstellungen). Sie legen einen Token in die Konfiguration von acme.sh, damit es
eine DNS-01-Challenge führen kann — eine Einrichtung, die man einmal macht, und
zwar für einen ganzen Anbieter: acme.sh kennt je Variable genau
einen Wert, ein zweiter überschreibt den ersten. Ein Aufruf, der das nebenbei
tut, nähme dem ersten Zertifikat bei der nächsten Erneuerung den richtigen
Token weg, und auffallen würde es zwei Monate später.

## Die Felder eines Eintrags

| Feld | Regel |
|---|---|
| `id` | Beim Anlegen freiwillig: fehlt sie, ergibt sie sich aus `domains[0]` und steht als `serviceId` in der Antwort. Gesetzt: `a-z 0-9 _`, beginnt mit Buchstabe oder Ziffer. Es ist der Backend-Name in der Konfiguration und muss dort frei sein. |
| `scope` | Der Name aus `GET /proxies`, in Großschreibung wie im Marker. |
| `domains` | Mindestens eine, kleingeschrieben, keine Dubletten. **`domains[0]` ist die Hauptdomain**: nach ihr heißt die PEM-Datei, und sie geht als Host-Header in den Healthcheck. Wildcards werden `*.kunde.example` geschrieben — ein Stern woanders ist ein Tippfehler und wird abgelehnt. |
| `servers` | Mindestens eins, außer bei einer Weiterleitung. `target` ist `host:port`, Port 1–65535. `name` darf leer sein, dann heißen sie `server1`, `server2`, … Mehr als eins ist Lastverteilung. |
| `servers[].weight` | Der Anteil eines Ziels im Verhältnis zu den anderen, 0 bis 256. **Fehlt oder `null` heißt: es wird keine `weight`-Angabe geschrieben** und HAProxys Vorgabe gilt (alle gleich) — nicht 1. **`0`** nimmt ein Ziel aus der Verteilung, ohne seine gebundenen Sitzungen abzuwerfen: der Weg, einen Server in Ruhe herauszunehmen. Es gibt sie **nur am Backend des Dienstes**, nicht an den Zielen einer Pfad-Regel: die verteilt nichts, sie trennt. |
| `balance` | `roundrobin`, `leastconn`, `source`, `uri` oder `random`. `null` schreibt keine `balance`-Zeile und lässt den `defaults`-Block der Konfiguration gelten. Bei einer Weiterleitung wird ein Wert abgelehnt: sie hat keine Ziele. |
| `sticky` | Sitzungsbindung über einen Cookie, den HAProxy selbst setzt und vor dem Ziel wieder aus der Anfrage nimmt. Nötig für alles, was Sitzungen im Arbeitsspeicher hält statt in einer gemeinsamen Datenbank; ohne das wird ein Besucher bei jeder Anfrage neu angemeldet. Schließt eine Weiterleitung aus. |
| `redirect` | Statt `servers`: die Domains werden weitergeleitet. `to` ist eine vollständige Adresse mit Schema (`https://example.com`) ohne Leerzeichen, `#` oder Anführungszeichen — sie steht unverändert in einer Zeile von `haproxy.cfg`. `keepPath: true` hängt Pfad und Query an (`/preise` → `…/preise`), `false` schickt alles auf die Zieladresse selbst. `permanent: true` ist 301, sonst 302. **Zusammen mit `servers`, `routes`, Headern oder `tunnel` wird der Rumpf abgelehnt**: alle setzen ein Backend mit Zielen voraus, und auf die Antwort einer Weiterleitung, die HAProxy selbst erzeugt, wirken Header-Regeln nicht. Ein Zertifikat wird trotzdem ausgestellt. |
| `routes` | Gleiche Domain, anderer Port (der Fall ist Coolify: Oberfläche 8000, Terminal 6002). `name` wie `id`, `paths` beginnen mit `/` und enthalten kein Leerzeichen, jeder Pfad nur einmal über alle Regeln. `check: true` ist ein reines TCP-`check` ohne HTTP-Prüfung — eine WebSocket-Strecke antwortet auf `GET /` nicht mit 200 und flöge sonst aus dem Betrieb. |
| `lockedDomains` | Die gesperrten Domains. Ohne weitere Angabe beim Anlegen: nur für die Admin-IPs erreichbar (HTTP 403 für alle anderen), und das setzt voraus, dass Admin-IPs eingetragen sind. Jede muss zum Eintrag gehören — bei `*.kunde.example` zählt auch `intern.kunde.example` dazu. |
| `lockPassword` | Sperrt die Domains aus `lockedDomains` mit einer Passwortabfrage statt auf die Admin-IPs. 8 bis 128 Zeichen. Gespeichert wird nur ein Hash in `haproxy.cfg`; zurück kommt das Passwort nie, `lockMode` im GET sagt nur die Art. Ein neues Passwort meldet alle ab, die schon durchgelassen sind. Braucht HAProxy 2.4 oder neuer, sonst `400`. |
| `passwordLock` | Nur beim Ändern von Belang. **Fehlt das Feld, bleibt die Art der Sperre, wie sie ist**: ein Eintrag mit Passwort behält es, einer auf Admin-IPs bleibt dort. Wer GET, ändern, PATCH macht, muss also nichts tun. `"unchanged"` verlangt ausdrücklich, dass das bestehende Passwort bleibt (`409`, wenn keins da ist). `null` stellt auf die Admin-IPs um. Ein Hash oder Cookie-Wert wird nie angenommen. |
| `responseHeaders`, `requestHeaders` | Feste Header an den Besucher bzw. an das Ziel, je `{ name, value }`, höchstens 20 je Richtung. Sie stehen in jedem Backend des Eintrags, auch in denen der Pfad-Regeln. `name`: Buchstaben, Ziffern, Bindestrich, je Richtung nur einmal; Header der Übertragung (`Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade` …) werden abgelehnt. `value`: druckbares ASCII, bis 1024 Zeichen, **wörtlich**: `%[src]` kommt als Text an und wird nicht ausgewertet. Ein Header der Antwort, den die globalen Einstellungen auch setzen, wird von dort überschrieben; einer der Anfrage ersetzt den globalen. Leere Einträge (`name` und `value` leer) fallen weg. |
| `tunnel` | `true` schreibt `timeout tunnel 1h` in jedes Backend des Eintrags. Ohne das reißen WebSocket, Terminal und Live-Ansicht nach der Zeit aus dem `defaults`-Block ab, üblicherweise nach einer Minute ohne Daten. |
| `app` | Welche Anwendung hinter dem Ziel läuft, eine Kennung aus `apps` von `GET /crowdsec/rules` (etwa `nextcloud`, `wordpress`). Steht als `# hapm-app: <id>` im Backend. HAPM holt danach die Ausnahmen von CrowdSec gegen bekannte Fehlsperren und lässt sie, wo CrowdSec das erlaubt, nur für dieses Ziel gelten (siehe docs/crowdsec.md, „Anwendungen“). **Fehlt das Feld, `null` oder leer: keine.** Wie bei den übrigen Feldern heißt ein PATCH ohne `app`, dass die Anwendung entfernt wird. Eine unbekannte Kennung ergibt `400`, bei einer Weiterleitung fällt das Feld weg. |
| `preset` | Nur noch angenommen, nie gemeldet: `nextcloud` wird zu den beiden Headern der Antwort, `coolify` zu `tunnel: true`, `default` zu nichts. Ein anderer Wert ergibt `400`. |
| `healthcheck` | **Geht nicht, wenn `domains[0]` eine Wildcard ist** — `*.kunde.example` ist als Host-Header kein gültiger Name, das Ziel antwortete mit 404 und HAProxy nähme ein funktionierendes Backend aus dem Betrieb. Der Wert wird in dem Fall stillschweigend auf `false` normalisiert, nicht abgelehnt. |
| `backendTls` | Wie HAProxy die Ziele anspricht. **Fehlt oder `"off"`: HTTP**, wie bisher. `"insecure"`: HTTPS, das Zertifikat des Ziels wird nicht geprüft (`ssl verify none`), für selbst signierte wie bei Proxmox (8006) oder TrueNAS. `"verify"`: HTTPS, das Zertifikat muss von einer CA stammen, der das System vertraut, und für die aufgerufene Domain gelten (`ssl verify required ca-file @system-ca`); braucht HAProxy 2.6 oder neuer, sonst `400`. `"ca:<name>"`: wie `"verify"`, aber gegen eine hinterlegte Zertifizierungsstelle statt der CAs des Systems, für Ziele mit Zertifikat aus einer internen CA (`ssl verify required ca-file /etc/haproxy/hapm-ca/<name>.pem`); der Name kommt aus `GET /certificate-authorities`, eine nicht hinterlegte Stelle ergibt `409`. Wo geprüft wird, muss das Zertifikat des Ziels für die aufgerufene Domain gelten, oder für den Namen in `backendVerifyHost`. Ohne `backendVerifyHost` geht in allen HTTPS-Fällen die Domain der Anfrage als SNI hinaus (`sni req.hdr(host)`), der Healthcheck bekommt `domains[0]` (`check-sni`). Gilt für alle `servers`; jede Pfad-Regel hat ein eigenes `routes[].backendTls` und erbt es **nicht**. Ein anderer Wert ergibt `400`, ebenso ein HTTPS-Wert zusammen mit `redirect`. |
| `backendVerifyHost` | Der Name, gegen den HAProxy das Zertifikat der Ziele prüft, wenn es nicht die Domain der Anfrage sein soll, etwa `"app01.intern.example"` bei einem Ziel mit Zertifikat aus einer internen CA. **Fehlt, `null` oder leer: die Domain der Anfrage**, wie bisher. HAProxy schickt den Namen dann als SNI (`sni str(<name>)`), auch im Healthcheck (`check-sni <name>`), und prüft das Zertifikat dagegen. Der Host-Header zum Ziel bleibt die Domain der Anfrage. Ein kleingeschriebener Hostname ohne Stern und ohne Port, keine IP-Adresse, sonst `400`. Wirkt nur bei `backendTls` `"verify"` und `"ca:<name>"`; bei `"off"` und `"insecure"` wird er verworfen und nicht gespeichert. Ein Name für alle `servers`; jede Pfad-Regel hat ein eigenes `routes[].backendVerifyHost` und erbt es **nicht**. `GET` liefert das Feld immer (`null` ohne Namen): wer es bei `PATCH` nicht zurückschickt, nimmt den Namen weg. |
| `dnsDomains` | Fehlt → beim DNS-Anbieter wird nichts angefasst. `"auto"` → jede Domain, für die unter `/dns` eine Zone eingerichtet ist. Eine Liste → genau diese, geschnitten mit `domains`. |
| `dnsHook` | Der acme.sh-Hook für DNS-01, aus `dnsHooks` von `GET /proxies`. DNS-01 gilt bei einer Wildcard und, in einer als intern eingerichteten Installation, bei jeder Domain. Ist genau ein Hook eingerichtet, darf das Feld fehlen. Bei mehreren muss es gesetzt sein. |

## Fallen, die Zeit kosten

- **`dnsDomains: "auto"` lässt die Zone selbst aus.** Auf `kunde.example` gehört ein
  A-Eintrag, und den pflegt ein Mensch; ein CNAME auf der Root verdeckte NS und
  MX. Ebenso ausgelassen wird jede Domain ohne eingerichtete Zone. Beides wäre
  sonst ein Schritt mit `ok: false` und setzte den ganzen Lauf auf `error`,
  obwohl der Eintrag steht. Wer den Fehlschlag sehen **will**, nennt die Domains
  einzeln.
- **Der DNS-Eintrag ist ein CNAME auf die Zone selbst.** Er führt nur dann zu
  diesem Server, wenn der A-Eintrag der Zone hierher zeigt. Siehe
  [`dns.md`](dns.md).
- **Eine belegte Domain wird abgewiesen, bevor ein Zertifikat beantragt wird.**
  HAProxy nähme zwei ACLs mit derselben Domain klaglos an und schickte den
  Verkehr an die erste — eine fremde Seite verschwände, ohne dass irgendwo ein
  Fehler steht.
- **Zwei gleichzeitige Schreibvorgänge** laufen
  nacheinander, und wer die Datei zwischendurch von Hand geändert hat, gewinnt:
  der Lauf bricht mit „Die Konfiguration hat sich geändert, seit sie gelesen
  wurde" ab, statt zu überschreiben. Wiederholen ist dann richtig.
- **Ein Wildcard-Zertifikat gehört nicht einem Dienst.** `app.kunde.example` und
  `api.kunde.example` können auf einem `*.kunde.example` liegen. Beim Löschen bleibt es
  deshalb stehen, solange ein anderer Eintrag es braucht — das steht als Schritt
  im Lauf und ist kein Fehler.
- **Umbenennen einer Gruppe gibt es nicht.** Anlegen und Entfernen, sonst nichts.
- **Das Ziel der Oberfläche von HAPM bleibt stehen.** `DELETE` darauf, ein
  `PATCH`, das ihm die Domain der Oberfläche nimmt, und `DELETE /scopes` auf
  seine Gruppe enden mit `409`. Vorher `surface` am Eintrag lesen.
- **Ein belegter Port fällt `haproxy -c` nicht auf.** Die Prüfung liest die
  Datei, sie bindet keine Sockets — der Fehlschlag käme erst beim Reload, und
  dann ist die Konfiguration bereits eingesetzt. `POST /streams` prüft das
  vorher und lehnt ab; wer es früher wissen will, fragt
  `GET /streams?port=…`.
- **`allowedSources: []` heißt „von überall".** Bei einem Dienst hinter einem
  Zertifikat ist das der Normalfall, bei einem durchgereichten Port ist es eine
  Entscheidung. Ein PATCH ohne das Feld setzt die Liste auf leer — er erbt sie
  nicht.
- **Ein Abschnittsname gilt über `frontend`, `backend` und `listen` hinweg.**
  Eine Dienst-ID und eine Stream-Kennung teilen sich denselben Namensraum; die
  zweite von beiden wird mit `409` abgelehnt.
- **`weight: null` ist nicht `weight: 1`.** Wer eine gelesene Zeile
  zurückschickt und dabei `null` in `1` übersetzt, schreibt eine Zahl in jede
  Zeile, in der vorher keine stand.

## Ein Client, der reicht

```ts
const BASE = process.env.HAPM_URL!;      // https://hapm.example.com
const TOKEN = process.env.HAPM_TOKEN!;   // hapm_…

async function hapm<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE}/api/internal/haproxy${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
    cache: 'no-store',
  });
  const body = await res.json();
  // Die Meldung ist bereits ein deutscher Satz — durchreichen, nicht ersetzen.
  if (!res.ok || !body.success) {
    throw new Error(body.error ?? `HAPM antwortete mit ${res.status}`);
  }
  return body.data as T;
}

/** Wartet, bis der Vorgang durch ist. Wirft, wenn er scheitert. */
async function awaitRun(runId: string, timeoutMs = 6 * 60_000): Promise<Run> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const run = await hapm<Run>(`/runs/${runId}`);
    if (run.status !== 'running') {
      if (run.status !== 'success') {
        // Die fehlgeschlagenen Schritte sagen, WAS nicht durchkam — und was
        // vorher schon passiert ist. "error" heißt nicht "nichts passiert".
        const failed = run.steps.filter((s) => !s.ok).map((s) => s.label);
        throw new Error(run.error ?? failed.join(', ') ?? 'Vorgang fehlgeschlagen');
      }
      return run;
    }
    if (Date.now() > until) throw new Error(`Vorgang ${runId} läuft noch nach ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

export async function createProxyTarget(input: {
  scope: string;
  domains: string[];
  target: string;
}) {
  // Ohne `id`: HAPM leitet sie aus domains[0] ab und nennt sie in der Antwort.
  const { runId, serviceId } = await hapm<{ runId: string; serviceId: string }>('/services', {
    method: 'POST',
    body: JSON.stringify({
      scope: input.scope,
      domains: input.domains,
      servers: [{ name: '', target: input.target }],
      routes: [],
      lockedDomains: [],
      healthcheck: true,
      dnsDomains: 'auto',
    }),
  });
  return { serviceId, run: await awaitRun(runId) };
}
```

Zwei Dinge daran sind Absicht: das Timeout liegt **über** den fünf Minuten, die
allein die Zertifikatsausstellung dauern darf, und ein Timeout wirft, ohne
aufzuräumen — der Vorgang läuft in HAPM weiter, und ihn hier für gescheitert
zu erklären hieße, ihn zweimal zu starten.

## Für den, der die Routen ändert

**Lies das, bevor du eine Route unter `app/api/internal/` anfasst oder anlegst.**

Der Baum ist die einzige Fläche, die an `requireSession` vorbeiläuft und dabei
**schreibt**. Es gibt ihn, damit ein Skript oder ein anderer Dienst ein Ziel
anlegen kann, ohne dass jemand einen Dialog ausfüllt. Die Richtung ist immer
**Aufrufer → HAPM**, nie umgekehrt.

### Authentifizierung (`lib/service-auth.ts`)

- **Jede Route unter dem Präfix MUSS mit `requireServiceToken(request)`
  beginnen**, vor `jsonBody` und vor jedem Lesen. Sie benutzt **nicht**
  `requireSession`. „Kommt ohne Anmeldung durch" heißt ausdrücklich nicht „ist
  offen". Das prüft ein Test über alle Routendateien
  (`tests/security/internal-api.test.ts`).
- **Kein Bereichs-Argument.** Es gibt unter `/api/internal` nur diesen einen
  Baum, also trägt ein Token keine Bereiche. Die Felder `scopes` und `areas` am
  Typ `ServiceToken` sind ohne Bedeutung und stehen als `null` da.
- **Ein Token kann seine Herkunft nennen** (`allowedIps`, `lib/ip-allow.ts`).
  Leer heißt „von überall": die Bindung ist freiwillig, und eine leere Liste
  als „von nirgendwo" zu lesen machte jedes Token ohne Bindung unbrauchbar.
  Geprüft wird gegen `getClientIP`. Die Ablehnung ist `403` **mit**
  Begründung und nicht `401`: der Aufrufer hat sein Token bereits bewiesen, ihm
  zu sagen, woran es lag, verrät nichts — und ein wortloses 401 ist an dieser
  Stelle die Sorte Fehler, an der jemand eine Stunde sucht, weil er einen
  falschen Schlüssel vermutet. Sie zählt als Fehlversuch und steht im Audit
  (`service_token_ip_rejected`).
- **Kein `requireCsrf`.** Ein CSRF-Token schützt einen Browser mit Cookie; hier
  gibt es weder das eine noch das andere. Der Aufrufer ist ein Programm mit
  einem Bearer-Token und gegen einen fremden Reiter immun.
- **Nur der Hash steht in der Datenbank** (`service_tokens.tokenHash`,
  SHA-256). Der Klartext existiert genau einmal, in der Antwort auf das
  Anlegen. Verloren heißt neu ausstellen. Das Präfix `hapm_` ist kein Schmuck:
  Secret-Scanner erkennen Token an ihrer Form, und ein Token ohne Form fällt
  beim versehentlichen Commit niemandem auf. Nachgeschlagen wird über den Hash
  (Index auf `tokenHash`), nicht über einen Vergleich in JavaScript.
- **Zurückziehen setzt `revokedAt`, es löscht nicht.** Ein Audit-Eintrag trägt
  den *Namen* des Dienstes (`serviceActor`), und der ist nur auflösbar, solange
  die Zeile existiert. Gelöscht würde aus „deploy-skript hat diese Domain
  angelegt" nachträglich ein `service:68a3f1c2`.
- **Der Fehlversuchszähler zählt nur Fehlversuche** (20 je Adresse und Stunde,
  danach `429`), eigener Zähler statt `lib/rate-limit.ts`: der zählt jeden
  Aufruf, und ein Dienst mit hundert Aufrufen am Tag hätte sich selbst
  ausgesperrt. Er lebt im Prozess (genau eine Instanz). Die Adresse kommt aus
  `getClientIP`, nie aus dem linken `X-Forwarded-For`-Eintrag: der ist vom
  Aufrufer gesetzt, und wer ihn je Versuch dreht, machte den Zähler wirkungslos.
- **`401` für unbekannt und zurückgezogen, mit derselben Meldung.** Ob ein
  Token nie existiert hat oder gesperrt wurde, geht den Aufrufer nichts an.
- **Die Audit-Pflicht gilt den schreibenden Handlern, nicht jeder Datei.** Wer
  schreibt, reicht `serviceActor(service)` in den Lauf (`haproxyActor`), damit
  Historie und Audit den Namen des Tokens tragen. Die lesenden Endpunkte liefern
  nichts Geheimes und werden im Sekundentakt abgefragt — wer einen Lauf pollt,
  schriebe neunzig Zeilen je Vorgang, und ein Protokoll, in dem die Vorgänge
  zwischen ihren eigenen Abfragen untergehen, beantwortet die Frage nicht mehr,
  für die es da ist.

### Die Routen (`lib/haproxy/internal.ts`, `lib/haproxy/api-actions.ts`)

**Die Logik einer Route steht in `lib/haproxy/api-actions.ts`**, nicht in der
Routendatei. Die Route prüft das Token, liest Rumpf und Adresse, baut den Actor
(`haproxyActor(serviceActor(service), request)`) und ruft eine Funktion. Der
MCP-Server ([`mcp.md`](mcp.md)) ruft dieselben Funktionen; eine Änderung an
einer Regel gilt damit für beide.

**Es gibt keinen zweiten Schreibweg.** Die Routen nehmen
denselben Rumpf (`readServiceInput`), prüfen mit derselben Funktion
(`validateCreateInput`), gehen durch dieselbe Vorabprüfung (`precheck*`) und
starten denselben abgekoppelten Lauf (`startHaproxyRun`) wie der Dialog. Ein
eigener Pfad „für Dienste" wäre der, in dem eine Regel fehlt, die man beim
Dialog später ergänzt — und aufgefallen wäre das im Betrieb, nicht hier. Der
einzige Unterschied ist der Actor.

Damit kann ein Aufrufer alles, was der Dialog auch kann — mit **einer**
Ausnahme, und die ist Absicht: die DNS-Zugangsdaten für Wildcards (Grund oben
unter „Was es hier bewusst nicht gibt"). Es ist eine Einrichtung und keine
Nebenwirkung.

Die TCP-Weiterleitungen (`lib/haproxy/streams.ts`) sind ein eigener Zweig und
kein Feld an `/services`: sie haben keine Domain, kein Zertifikat und keinen
DNS-Eintrag, dafür einen Port. **`GET /streams?port=` ist der
Endpunkt, den es sonst nirgends bräuchte**: `haproxy -c` bindet keine Sockets,
ein belegter Port kommt also durch die Prüfung und scheitert erst beim Reload.
Geprüft wird trotzdem auch im Lauf, innerhalb des Locks — die Antwort auf „ist
5432 frei" darf nicht aus einer Momentaufnahme von vorhin kommen.

Fünf Dinge daran sind Entscheidungen und keine Form:

- **Die schreibenden Routen antworten mit einer Lauf-ID, nicht mit dem
  Ergebnis.** DNS, Zertifikat, `haproxy -c` und Reload dauern Minuten; eine
  Route, die darauf wartet, läuft in jedes vernünftige Timeout.
- **Was sich ohne Schreibvorgang beantworten lässt, kommt sofort als Fehler
  zurück**: belegte Dienst-ID (409), fremde Domain (409), fehlendes acme.sh,
  Wildcard ohne DNS-Hook.
- **`serverId` gibt es, und es darf fehlen** (`resolveProxy`). Die Listen
  (`proxies`, `runs` bei Gruppen, `unreachable`) und das Feld in jeder Antwort
  gehören zur Schnittstelle; sie haben immer genau einen Eintrag. Ohne Angabe
  gilt die lokale Maschine, ein
  unbekannter Wert ist `404` mit den zur Auswahl stehenden — keine leere Liste,
  die sich wie „dort gibt es nichts" liest.
- **`dnsDomains: "auto"` heißt: jede Domain, für die es hier eine Zone gibt**
  (`autoDnsDomains`). Im Dialog wählt der Mensch aus, weil er die Zonen sieht;
  ein Aufrufer sieht sie nicht. Die Zone selbst fällt heraus und ebenso jede
  Domain ohne Zone. Ohne das Feld wird beim DNS-Anbieter nichts angefasst.
- **Ändern ist ein vollständiger Rumpf, die Einstellungen sind der einzige
  Teil-Patch.** Ein Eintrag entsteht aus EINEM Text, der in EINEM `haproxy -c`
  geprüft und mit EINEM Reload gültig wird; ihn aus „alt plus die Felder, die
  dastanden" zusammenzusetzen hieße, den Stand von vorhin festzuhalten. Bei den
  Einstellungen ist es umgekehrt begründet: der Dialog schickt immer beide
  Listen, weil beide auf dem Bildschirm stehen, ein Aufrufer schickt die eine
  Zeile, um die es ihm geht.
