# HAPM

Weboberfläche für **ein** HAProxy, das im selben Compose-Stack läuft. Zertifikate
über acme.sh, alles Weitere (Grundkonfiguration, acme.sh, Updates der Abbilder)
richtet HAPM selbst ein. Gedacht für `docker compose up -d` auf dem Server, der
der Reverse-Proxy sein soll.

Next.js (App Router) mit TypeScript strict, pnpm. Drei Container: HAPM, HAProxy
(offizielles Abbild) und Postgres.

## Wo was steht

| Wenn du hier arbeitest | Lies vorher |
|---|---|
| `lib/haproxy/`, `app/(app)/reverse-proxy/`, `components/reverse-proxy/` | [`docs/reverse-proxy.md`](docs/reverse-proxy.md): dort steht zu fast jeder Zeile, warum die naheliegende Lösung einmal danebenging |
| `lib/dns/`, `app/(app)/dns/` | [`docs/dns.md`](docs/dns.md) |
| `app/api/internal/` | [`docs/reverse-proxy-api.md`](docs/reverse-proxy-api.md) |
| `lib/docker/`, `lib/updates/`, `lib/bootstrap.ts`, `Dockerfile`, Compose | [`docs/betrieb.md`](docs/betrieb.md) |
| `lib/db/`, `lib/setup-db.ts`, `bin/hapm-admin.mjs` | [`docs/betrieb.md`](docs/betrieb.md), Abschnitt „Postgres" |
| `lib/auth/`, `lib/session.ts`, `lib/two-factor.ts`, `app/api/auth/`, `app/api/account/` | die Köpfe der Dateien: dort steht zu jeder Stelle, warum sie so ist |
| `ui/`, `components/`, `app/globals.css`, `app/hapm.css` | unten „Regeln, die überall gelten", Punkte „Oberfläche" und „Design" |

## Wie HAPM gebaut ist

- **Eine Maschine, und zwar diese.** Es gibt keine Serverliste und kein SSH.
  `lib/ssh.ts` führt Kommandos lokal im eigenen Container aus und heißt nur so,
  weil `lib/haproxy/` die Funktion unter diesem Namen aufruft (`sshExec`).
  `lib/helpers.ts` kennt genau einen Server (`LOCAL_SERVER_ID`, `getServer`).
  `serverId` in Routen und Läufen ist immer dieser, in der API darf sie fehlen.
  In der Oberfläche gibt es keine Auswahl einer Maschine.
- **„Auf der Maschine" heißt: im HAPM-Container.** Er teilt sich `/etc/haproxy`,
  `/run/haproxy` (Sockets) und das Log über Volumes mit dem HAProxy-Container.
  `haproxy …` im HAPM-Container ist ein Verweis auf `bin/hapm-ctl.mjs` und läuft
  im HAProxy-Container, `hapm-reload` lädt über den Master-Socket neu und meldet,
  ob der neue Prozess steht. Kein `systemctl`.
- **HAPM richtet HAProxy selbst ein:** Grundkonfiguration
  (`lib/haproxy/base-config.ts`, nur wenn `haproxy.cfg` fehlt), Fehlerseiten,
  Platzhalter-Zertifikat, acme.sh (`lib/bootstrap.ts`, `lib/acme.ts`). Danach
  ist `haproxy.cfg` die Wahrheit: gelesen wird bei jedem Aufruf aus der Datei,
  es gibt keine Kopie in der Datenbank. Eine frische Installation hat keine
  Gruppe, die erste legt der Benutzer an.
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
- **Oberfläche:** `apiFetch` aus `useApp()`, nie nacktes `fetch`. `<Select>`
  statt `<select>`, `useConfirm()` statt `confirm()`, Schalter ist
  `.toggle-switch` in einem `label`. Meldungen nach einer Handlung sind Toasts.
  Jede Seite aktualisiert sich selbst (`usePolling`, `useNow`). Eine
  Client-Komponente importiert nichts, was `lib/db`, `lib/ssh` oder `lib/docker`
  erreicht (nur `import type`).
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
  `lucide-react`, keine Emoji.
- Kennungen, die in `haproxy.cfg` oder auf der Platte stehen (`hapm_lock_…`,
  `/etc/haproxy/hapm-lock`, Cookie `HAPMSRV`, `.hapm-original`), werden nicht
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
`pnpm haproxy:verify-pages` mit Docker. Den ganzen Stack lokal:
`docker compose -f docker-compose.dev.yml up -d --build`.
