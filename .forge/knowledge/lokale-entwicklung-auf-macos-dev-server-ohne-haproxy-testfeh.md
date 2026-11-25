---
title: "Lokale Entwicklung auf macOS: Dev-Server ohne HAProxy, Testfehler durch GNU-Werkzeuge"
summary: "Was lokal (macOS, ohne Docker) geht und was nicht: welche Tests immer scheitern, wie man den Einrichtungsassistenten und DB-Seiten trotzdem im Browser prüft."
tags: ["entwicklung","tests","stolperfalle","setup"]
updated: "2026-11-25T17:49:15.778Z"
---

# Lokale Entwicklung auf macOS: Dev-Server ohne HAProxy, Testfehler durch GNU-Werkzeuge

## Tests, die auf macOS immer scheitern
`pnpm test` meldet auf macOS 19 Fehler in `tests/backup/archive.test.ts`, `tests/backup/backup.test.ts`, `tests/backup/restore.test.ts`, `tests/docker/put-file.test.ts` und `tests/haproxy/prune.test.ts`. Ursache sind GNU-Werkzeuge, die die Shell-Skripte voraussetzen und die macOS nicht hat (z. B. `head -n -N` in `pruneBackupsCommand`, `lib/haproxy/provision.ts`, außerdem GNU-tar). Geprüft am 2026-11-25: dieselben 19 scheitern auch auf dem unveränderten Stand. Im Linux-Container laufen sie. Kein Grund, an diesen Dateien etwas zu ändern, wenn man sie nicht angefasst hat.

## Dev-Server ohne Docker
- Auf dem Mac zur Entwicklung ist kein Docker installiert, `docker-compose.dev.yml` geht dort also nicht.
- `pnpm dev` läuft mit der FORGE-Testdatenbank (`DATABASE_URL` wird übergeben). In einem Agenten-Worktree startet die Test-Datenbank NICHT mit dem Dev-Server: erst `dev_control database start`, dann `dev-server restart`, sonst wartet HAPM 60 s auf den Postgres-Socket und beendet sich. Agenten-Worktrees haben einen eigenen Port (z. B. 4102), nicht 3000. Port 3000 kann von einem anderen Projekt belegt sein (vorher prüfen: `lsof -iTCP:3000 -sTCP:LISTEN`).
- `/etc/haproxy` ist fest verdrahtet: ohne HAProxy zeigen `/reverse-proxy` (Gruppen, Dialoge der Ziele) und die HAProxy-Karte unter Einstellungen nur den Fehlerzustand. Hochladen eines Zertifikats und Speichern eines eigenen ACME-Servers scheitern lokal (kein `/etc/haproxy`, kein acme.sh); die Fehlermeldung erscheint aber sauber, damit lässt sich die Oberfläche prüfen. Komponenten, die nur die Datenbank brauchen, lassen sich zum Ansehen kurz in eine Seite hängen, die ohne HAProxy rendert, danach wieder heraus.
- Neue Collection in `COLLECTIONS` (`lib/types.ts`): Tabelle entsteht beim Start (`ensureTable` in `lib/db/postgres-driver.ts`), also Dev-Server neu starten.
- Seiten in der App-Hülle scrollen in einem inneren Container: `preview_screenshot` mit `fullPage` zeigt nicht mehr, dafür `height: 2000` setzen. Der Assistent (`/setup`) steht außerhalb der Hülle: dort zeigt `fullPage` die echte Höhe der Karte (Ziel: passt in 1280x800).

## Einrichtungsassistent (`/setup`) lokal durchspielen
- Schritte (seit 2026-11-25 sieben): account, exposure, dns, certificates, mail, address, run.
- Frische Testdatenbank: Schritt 1 (Konto) erscheint. Nach dem Konto geht es mit Sitzung weiter.
- Schritte springen über `/setup?schritt=<step>` (nur schon erreichte).
- Stand direkt setzen: Tabelle `setup_state`, Zeile `id='main'`, Feld `data` (jsonb). Felder: `exposure`, `dns` (`pending|configured|skipped|manual`, `manual` = eigener DNS-Server), `certificates` (`pending|set`), `mail` (`pending|set|skipped`), `address` (`pending|set|skipped`), `domain`, `wildcard`, `execution`. Was bei „Zertifikate" und „SMTP-Konto" gewählt wurde, steht in den Einstellungen (`settings`, Zeile `main`: `certificateSource`, `acmeDirectory`, `acmeHttpReachable`, `smtpHost`, `smtpPort`, `smtpSecurity`, `smtpUser`, `smtpPass`, `mailFrom`).
  - direkt zum SMTP-Schritt: `data || '{"exposure":"public","dns":"manual","certificates":"set","mail":"pending"}'`
  - zurück auf Schritt 2: `data || '{"exposure":null,"dns":"pending","certificates":"pending","mail":"pending","address":"pending","execution":null}'`
  - Erfolgsansicht: `address` muss `"set"` sein (nicht `configured`), `domain` gesetzt, `certificates` `"set"`, `mail` `"set"` oder `"skipped"`, `execution` mit `running:false` und allen `stages[].status = "ok"` (Keys: scope, certificate, service, publicUrl).
- Testmail im SMTP-Schritt lokal: mit einem Host wie `smtp.invalid` kommt sofort die Meldung „lässt sich nicht auflösen" im Schritt, damit lässt sich die Fehleranzeige prüfen.
- Ein echter Lauf braucht HAProxy und acme.sh und geht lokal nicht. Ohne acme.sh steht in Schritt 2, 3 und 7 eine gelbe Warnung, die in Produktion fehlt (bei „nur hochladen" nicht); sie verlängert die Karte.
- Ein Dialog im Assistenten muss per `createPortal` an `document.body`: die Karte trägt eine `transform`-Animation, sonst ist `position: fixed` an die Karte gebunden.
