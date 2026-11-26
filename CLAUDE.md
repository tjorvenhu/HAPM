# HAPM

Weboberfläche für **ein** HAProxy, das im selben Compose-Stack läuft. Zertifikate
über acme.sh, alles Weitere (Grundkonfiguration, acme.sh, Updates der Abbilder)
richtet HAPM selbst ein. Gedacht für `docker compose up -d` auf dem Server, der
der Reverse-Proxy sein soll.

Next.js (App Router) mit TypeScript strict, pnpm. Drei Container: HAPM, HAProxy
(offizielles Abbild) und Postgres. Dazu, abschaltbar, zwei für CrowdSec
(`hapm-crowdsec`, `hapm-crowdsec-bouncer`).

## Wo was steht

| Wenn du hier arbeitest | Lies vorher |
|---|---|
| `lib/haproxy/`, `app/(app)/reverse-proxy/`, `components/reverse-proxy/` | [`docs/reverse-proxy.md`](docs/reverse-proxy.md): dort steht zu fast jeder Zeile, warum die naheliegende Lösung einmal danebenging |
| `lib/dns/`, `app/(app)/dns/` | [`docs/dns.md`](docs/dns.md) |
| `app/api/internal/haproxy/` | [`docs/reverse-proxy-api.md`](docs/reverse-proxy-api.md) |
| `app/api/internal/` außerhalb von `haproxy/`, die `actions.ts`/`*-actions.ts` in `lib/` | [`docs/hapm-api.md`](docs/hapm-api.md), dazu [`docs/mcp.md`](docs/mcp.md), „Keine eigene Logik in den Werkzeugen" und „Was es bewusst nicht gibt" |
| `app/api/mcp/`, `lib/mcp/`, `lib/haproxy/api-actions.ts` | [`docs/mcp.md`](docs/mcp.md), dazu [`docs/reverse-proxy-api.md`](docs/reverse-proxy-api.md) und [`docs/hapm-api.md`](docs/hapm-api.md) |
| `lib/docker/`, `lib/updates/`, `lib/bootstrap.ts`, `Dockerfile`, Compose, `install.sh` | [`docs/betrieb.md`](docs/betrieb.md) |
| `lib/sync/`, `app/api/sync/`, `app/(app)/abgleich/`, `withProxyLock` in `lib/haproxy/provision.ts` | [`docs/hochverfuegbarkeit.md`](docs/hochverfuegbarkeit.md): Hauptknoten und Folgeknoten, was übertragen wird, warum ein Folgeknoten nichts ändert |
| `app/setup/`, `app/api/setup/`, `lib/setup/`, `lib/address-move/`, `lib/haproxy/challenge.ts` | [`docs/betrieb.md`](docs/betrieb.md), Abschnitt „Ersteinrichtung", und [`docs/reverse-proxy.md`](docs/reverse-proxy.md), „Interne Installation" |
| `lib/db/`, `lib/setup-db.ts`, `bin/hapm-admin.mjs` | [`docs/betrieb.md`](docs/betrieb.md), Abschnitt „Postgres" |
| `lib/crowdsec/`, `app/(app)/reverse-proxy/crowdsec/`, `app/api/crowdsec/`, `app/api/internal/crowdsec/` | [`docs/crowdsec.md`](docs/crowdsec.md) |
| `lib/audit.ts`, `lib/audit-log/`, `lib/db/audit-query.ts`, `app/(app)/protokoll/`, `app/api/audit/`, `app/api/internal/audit/` | [`docs/protokoll.md`](docs/protokoll.md): Lesen, Export, Weiterleitung an ein SIEM, Aufbewahrung, was nur mit Sitzung geht |
| `lib/branding/`, `app/(app)/system/darstellung/`, `app/branding.css`, `ui/primitives/Logo.tsx` | [`docs/betrieb.md`](docs/betrieb.md), Abschnitt „Darstellung" |
| `lib/auth/`, `lib/session.ts`, `lib/two-factor.ts`, `app/api/auth/`, `app/api/account/` | die Köpfe der Dateien: dort steht zu jeder Stelle, warum sie so ist |
| `ui/`, `components/`, jede Seite unter `app/`, `app/globals.css`, `app/hapm.css` | [`docs/oberflaeche.md`](docs/oberflaeche.md): Seitenkopf, lange Texte hinter dem „i", Wortwahl, Meldungen, Layout. Dazu unten „Regeln, die überall gelten", Punkte „Oberfläche" und „Design" |
| `lib/i18n/`, jeder Text für Nutzer (Seiten, Meldungen, Datum, Zahlen) | [`docs/i18n.md`](docs/i18n.md): `t()`, `msg()`, Wörterbuch, Glossar |

## Wie HAPM gebaut ist

- **Hochverfügbarkeit ist ein Abgleich, keine Serverliste** (`lib/sync/`,
  abschaltbar, Vorgabe aus): zwei vollständige Installationen, der Hauptknoten
  überträgt `/etc/haproxy` und den Stand von acme.sh an die Folgeknoten, dazu
  als Datenteil Konten, Einstellungen, DNS-Zonen, API-Keys und was in CrowdSec
  eingestellt ist (`lib/sync/data.ts`). Ein Folgeknoten ändert daran nichts,
  gesperrt in `withProxyLock` und `startHaproxyRun`, für den Datenteil mit
  `assertDataWritable`. Was nur dieser Knoten an sich tut, nimmt
  `withProxyLockLocal`. Statistik, Protokoll, Sicherung und Updates bleiben
  je Knoten.
- **Eine Maschine, und zwar diese.** Es gibt keine Serverliste und kein SSH.
  `lib/ssh.ts` führt Kommandos lokal im eigenen Container aus und heißt nur so,
  weil `lib/haproxy/` die Funktion unter diesem Namen aufruft (`sshExec`).
  `lib/helpers.ts` kennt genau einen Server (`LOCAL_SERVER_ID`, `getServer`).
  `serverId` in Routen und Läufen ist immer dieser, in der API darf sie fehlen.
  In der Oberfläche gibt es keine Auswahl einer Maschine.
- **„Auf der Maschine" heißt: im HAPM-Container.** Er teilt sich `/etc/haproxy`,
  `/run/haproxy` (Sockets) und das Log über Volumes mit dem HAProxy-Container
  (auf dem Server Unterordner von `HAPM_STORAGE`, Vorgabe `data/` neben
  `docker-compose.yml`).
  `haproxy …` im HAPM-Container ist ein Verweis auf `bin/hapm-ctl.mjs` und läuft
  im HAProxy-Container, `hapm-reload` lädt über den Master-Socket neu und meldet,
  ob der neue Prozess steht. Kein `systemctl`.
- **HAPM richtet HAProxy selbst ein:** Grundkonfiguration
  (`lib/haproxy/base-config.ts`, nur wenn `haproxy.cfg` fehlt), Fehlerseiten,
  Platzhalter-Zertifikat, acme.sh (`lib/bootstrap.ts`, `lib/acme.ts`). Danach
  ist `haproxy.cfg` die Wahrheit: gelesen wird bei jedem Aufruf aus der Datei,
  es gibt keine Kopie in der Datenbank. Eine frische Installation hat keine
  Gruppe: die erste legt der Benutzer an, oder der Assistent (Gruppe `HAPM`),
  wenn er die Oberfläche als Ziel einrichtet.
- **Die Ersteinrichtung ist ein Assistent** (`app/setup/`, `lib/setup/`): Konto,
  Art der Installation, DNS-Anbieter, Zertifikate, SMTP-Konto (überspringbar),
  Adresse der Oberfläche, Ausführen. Die
  Art (`exposure` in den Einstellungen) entscheidet, wie Zertifikate
  ausgestellt werden: `internal` heißt DNS-01 für jedes, `public` HTTP-01 und
  DNS-01 nur für Wildcards. Die eine Regel dafür steht in
  `lib/haproxy/challenge.ts`, die Routen geben die Art an den Vorgang mit
  (`challengeFor` in `lib/settings.ts`). Dazu kommt, woher Zertifikate kommen
  (`certificateSource`: über ACME oder nur hochgeladen) und bei welchem
  ACME-Server beantragt wird (`acmeDirectory`, mit `acmeHttpReachable` geht
  HTTP-01 auch intern). Hochgeladene Zertifikate sind PEM-Dateien in
  `/etc/haproxy/certs`, die acme.sh nicht führt (`lib/haproxy/cert-upload.ts`).
- **DNS bei vier Anbietern** (`lib/dns/`): Cloudflare, Hetzner, ein eigener
  Nameserver über RFC 2136 (`rfc2136.ts`, TSIG) und Infoblox (`infoblox.ts`,
  WAPI) hinter einer Schnittstelle (`provider.ts`). Die letzten beiden zählen
  nichts auf: wer liest, gibt Domain und Namen mit. Die Zugänge der Zonen
  liegen verschlüsselt in der Datenbank, die Einträge werden bei jedem Aufruf
  vom Anbieter gelesen.
  Hetzner rechnet in RRSets, die Abbildung auf einzelne Einträge steht in
  `hetzner-rrsets.ts`. Einen Zugang richtet nur `connectZone` ein
  (`connect.ts`), auch der Assistent.
- **Postgres als Dokumentenspeicher** (`lib/db/postgres-driver.ts`,
  `lib/db/sql.ts`). Je Collection eine Tabelle mit dem Dokument als `jsonb`, ein
  neues Feld braucht keine Migration. Wonach gefiltert wird, gehört in
  `INDEXES`. Postgres ist der dritte Container im Stack, ohne Netz, erreichbar
  nur über einen Unix-Socket.
- **Anmeldung über Better-Auth** (`lib/auth/config.ts`, `lib/auth/users.ts`,
  `lib/session.ts`). Der Kern liegt unter `lib/auth/core/`, seine Tabellen
  (`auth_*`) legt `lib/db/auth-tables.ts` an. Die Adresse von HAPM steht nicht
  in der Umgebung, sondern in den Einstellungen (`publicUrl`), und `auth()` baut
  die Instanz danach.
- **Der zweite Faktor ist freiwillig** (`lib/two-factor.ts`): wer keinen hat, ist
  nach dem Passwort angemeldet. **Passkeys gibt es nur, wenn die Adresse von
  HAPM und ein SMTP-Konto eingerichtet sind** (`lib/auth/passkey-rules.ts`,
  `requirePasskeys()`).
- **Die Geheimnisse entstehen beim ersten Start** und liegen im Daten-Volume
  (`lib/secrets.ts`). `encryptionKey` darf sich nie ändern.

## Regeln, die überall gelten

- **`lib/shell.ts` ist nicht optional.** Jedes Kommando entsteht aus einem argv
  (`buildCommand`, `withEnv`, `withStdin`), nie als zusammengesetzter Text.
- **Alles geht über `lib/db`.** Kein `postgres` außerhalb von `lib/db/`. Zwei
  Ausnahmen: `lib/auth/config.ts` reicht die Verbindung an den Anmeldedienst
  weiter, und `bin/hapm-admin.mjs` läuft ohne den Server.
  `listDocuments` ohne `Query.limit` liefert 25 Zeilen, wer alles will, nimmt
  `listAll`.
- **Die Docker-Engine nur über `lib/docker/`.** `engine.mjs` und `replace.mjs`
  sind reines JavaScript ohne Abhängigkeiten, weil `bin/hapm-ctl.mjs` sie ohne
  Build benutzt (auch aus dem Deploy-Hook von acme.sh heraus).
- **Ehrliche Nullwerte.** `updateAvailable: null` heißt unbekannt, nicht
  „aktuell". Eine leere `ss`-Ausgabe heißt unbekannt, nicht „alle Ports frei".
- **Routen:** `requireCsrf` → `requireSession` → Logik → `logAudit` → `ok()`,
  alles in `try/catch` mit `handleError(err)`. Die Routen unter
  `app/api/internal/` nehmen statt der Sitzung ein Token (`requireServiceToken`).
  Was Oberfläche, interne API und MCP gemeinsam können, steht als Funktion in
  `lib/` (sie schreibt auch das Audit) und wird nicht in eine Route kopiert.
- **Oberfläche:** `apiFetch` aus `useApp()`, nie nacktes `fetch`. `<Select>`
  statt `<select>`, `useConfirm()` statt `confirm()`, Schalter ist
  `.toggle-switch` in einem `label`. Meldungen nach einer Handlung sind Toasts.
  Jede Seite aktualisiert sich selbst (`usePolling`, `useNow`). Eine lange
  Seite mit getrennten Themen bekommt Reiter aus `components/AreaTabs.tsx`
  (`?bereich=` in der Adresse, Punkt für Ungespeichertes). Eine
  Client-Komponente importiert nichts, was `lib/db`, `lib/ssh` oder `lib/docker`
  erreicht (nur `import type`).
- **Einheitlich, auf jeder Seite** ([`docs/oberflaeche.md`](docs/oberflaeche.md)):
  Der Titel einer Seite ist ihr Name in der Seitenleiste, Unterseiten nehmen
  `PageHeading`. Eine Erklärung über 72 Zeichen steht hinter dem „i"
  (`InfoHint`), sichtbar bleiben nur Warnungen und Folgen
  (`tests/ui/long-text.test.ts`). Wegnehmen heißt „Entfernen", nie „Löschen".
  Ein Serverfehler nach dem Absenden ist ein Toast, ein unbekannter Fehler
  nennt nur eine Kennung mit „Anzeigen": was der Benutzer lesen soll, wirft die
  Route als `ApiError`.
- **Layout:** Eine Karte ist so hoch wie ihr Inhalt, eine kurze wird neben
  einer langen nie gestreckt. Was mit den Daten wächst, steht in der breiten
  Spalte, kurze Karten übereinander in einer schmalen daneben. Raster brechen
  nach der Breite um. Vor „fertig" jede geänderte Seite in drei Breiten
  ansehen (1440, 1024, 400) und mit vielen wie mit wenigen Einträgen.
- **Design:** `ui/` ist das Design von HAPM: Rahmen (`ToolShell`, Seitenleiste),
  Bausteine (`ui/tool/`, `ui/primitives/`, `ui/charts/`, `ui/auth/`), die
  Stylesheets hinter `ui/css/tool.css`, der Rahmen der Mails (`ui/mail/`) und
  die Fehlerseiten (`ui/static/`). Erst dort nachsehen, dann bauen.
  `app/globals.css` und `app/hapm.css` halten nur, was einzelne Seiten
  brauchen. Farben und Abstände über die CSS-Variablen, keine Hex-Literale.
  Die Klassennamen der Seiten prüft `tests/ui/css-classes.test.ts` gegen die
  Stylesheets.
- **Texte:** UI-Texte und Fehlermeldungen deutsch, Code englisch. Kurze,
  konkrete Sätze, keine Gedankenstriche in Texten für Nutzer. Icons aus
  `lucide-react`, keine Emoji. Jeder Text für Nutzer geht über `t()` (Seite),
  `msg()` (Meldung einer Route) oder `msgid()`, Datum und Zahlen über
  `lib/i18n/format.ts`; Englisch steht in `lib/i18n/en/`. Siehe
  [`docs/i18n.md`](docs/i18n.md).
- Kennungen, die in `haproxy.cfg` oder auf der Platte stehen (`hapm_lock_…`,
  `/etc/haproxy/hapm-lock`, `/etc/haproxy/hapm-ca/<name>.pem`, Cookie `HAPMSRV`, `.hapm-original`, `# hapm-app:`), werden nicht
  umbenannt: bestehende Konfigurationen hängen daran.

## Fertig heißt

```
pnpm lint && pnpm typecheck && pnpm test
```

`pnpm test` braucht eine echte Bash im PATH (unter Windows: aus Git Bash starten).
Die Tests gegen die Datenbank (Treiber, Konten, `hapm-admin`) laufen nur, wenn
`TEST_DATABASE_URL` auf ein Postgres zeigt, sonst werden sie übersprungen und
sagen das. Wie man eines startet, steht in `tests/helpers/test-database.ts`.
Was nur ein echtes HAProxy zeigen kann (Passwortsperre, Fehlerseiten), prüft
`pnpm haproxy:verify-pages` mit Docker, HTTPS zum Ziel `pnpm haproxy:verify-tls`,
CrowdSec (WAF, Sperren, Freigaben) gegen echtes HAProxy, CrowdSec und Bouncer
`pnpm crowdsec:verify`, den Abgleich zwischen Knoten (anwenden, ablehnen,
zurücktauschen) `pnpm sync:verify`, DNS über RFC 2136 samt acme.sh gegen BIND
und Pebble `pnpm dns:verify`. Den ganzen Stack lokal:
`docker compose -f docker-compose.dev.yml up -d --build`.
