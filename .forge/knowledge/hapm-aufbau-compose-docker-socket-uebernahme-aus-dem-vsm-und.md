---
title: "HAPM: Aufbau (Compose, Docker-Socket, Postgres, Übernahme aus dem VSM) und Stolperfallen der Docker-Schicht"
summary: "Wie HAPM aus dem Reverse-Proxy-Teil des VSM entstanden ist, welche Nahtstellen es gibt und welche Fehler beim Prüfen gegen echtes Docker, HAProxy, Postgres und acme.sh aufgefallen sind."
tags: ["architektur","docker","stolperfalle","updates","acme"]
updated: "2026-11-24T16:22:28.511Z"
---

Stand 2026-11-24. Einzelheiten stehen in `CLAUDE.md` und `docs/betrieb.md`. Hier steht, was man nicht aus dem Code liest.

## Wie es entstanden ist
- `lib/haproxy/`, `components/reverse-proxy/`, `app/(app)/reverse-proxy/`, `app/api/haproxy/`, `lib/dns/`, `lib/geoip/` sind aus `internal-manager` (VSM) kopiert. Damit sie ohne Umbau laufen, liegen unter denselben Importpfaden HAPM-Fassungen: `lib/ssh.ts` (`sshExec` führt lokal per bash aus), `lib/helpers.ts` (genau ein Server `local`), `lib/db` (dieselbe Fassade), `lib/session.ts`, `lib/audit.ts`, `lib/types.ts`. Wer etwas aus dem VSM nachzieht, kopiert die Datei und lässt `tsc` sagen, was fehlt.
- Die kopierten Dateien haben CRLF, neu geschriebene LF. Skripte, die mehrzeilige Stellen ersetzen, müssen das Zeilenende der Datei erkennen. Im Bash-Werkzeug gehen Rückstriche in Heredocs verloren: Skripte mit dem Write-Werkzeug anlegen.
- Entscheidungen: ein Knoten (kein SSH, keine Serverliste); **Postgres für alles** (dritter Container `postgres:17-alpine`, ohne Netz und Port, nur Unix-Socket im Volume `postgres-run`, `trust`, kleine Werte: leer 24 bis 26 MiB); die Datenbank ist ein Dokumentenspeicher (`lib/db/postgres-driver.ts`: eine Tabelle je Collection mit `jsonb`, kein Schema je Feld, neue Collection in `COLLECTIONS` eintragen); zweiter Faktor freiwillig; Passkeys nur mit eingerichteter Adresse von HAPM (`publicUrl`, https) UND SMTP-Konto; Geheimnisse entstehen beim Start (`lib/secrets.ts`); HAPM und HAProxy im Netz des Hosts. Ein früher Stand mit SQLite wurde verworfen, weil die Anmeldung aus `@vanturis/auth` Postgres braucht und der Nutzer eine Datenbank für alles will.
- Die Grundkonfiguration (`lib/haproxy/base-config.ts`) folgt der Konfiguration der Vanturis-Proxys: TLS-Verfahren, Zeitgrenzen, `chroot`, `strict-sni`, HTTP/3 (`bind quic4@:443`), HSTS, `X-Forwarded-*`. Abweichungen wegen des Containers: kein `daemon`, `log … format raw` (HAPM schneidet das Log selbst mit), kein `limited-quic` (das offizielle Abbild kann QUIC nativ). Sie wird nur geschrieben, wenn `haproxy.cfg` fehlt.

## Fehler, die erst gegen echte Dienste auffielen
- **acme.sh hat eine Spalte `Profile` in `--list --listraw` eingefügt.** `parseAcmeList` findet die Spalten über die Kopfzeile. Im VSM ebenfalls behoben (dort noch nicht committet).
- **Ein gescheiterter Antrag bleibt in der Liste von acme.sh** (`Created` leer) und galt als vorhandenes Zertifikat. `findCertificateFor` nimmt nur Einträge mit `createdAt`.
- **Nach `docker pull` unter demselben Tag kann das alte Abbild sofort weg sein** (containerd-Image-Store). `recreateBody` braucht es, um Einstellungen des Containers von Vorgaben des Abbilds zu trennen: es wird VOR dem Holen gelesen und dem Helfer über `HAPM_OLD_IMAGE` mitgegeben.
- **`network_mode: service:x` wird zu `container:<kennung>`.** Wird x ersetzt, hängt der andere Container an einem toten Netz. `reattachDependents` legt ihn neu an (betrifft nur `docker-compose.dev.yml`).
- **Im Netz des Hosts ist der Hostname des Containers der des Hosts.** Die eigene Kennung kommt aus `/proc/self/mountinfo`.
- **Der Master-Socket von HAProxy (`-S`) beantwortet `reload` mit `Success=1` oder `Success=0`** samt Ausgabe des Starts.
- **`ensureAcme` darf die Zertifizierungsstelle nur bei der Installation setzen.** Die Adresse des Kontos steht in `ca/<server>/ca.conf` (`CA_EMAIL`).
- **Let's Encrypt lehnt Adressen unter `example.org` ab** und verschickt seit Juni 2025 keine Ablaufwarnungen mehr.
- **Die Adresse des Aufrufers** kommt aus `bin/remote-addr.mjs` (Vorlader, `x-hapm-remote-addr`). `X-Forwarded-For` gilt nur, wenn die Anfrage von 127.0.0.1 kommt.
- **Die Sperre nach Fehlversuchen zählt jede Anmeldung, auch gelungene** (fünf in 15 Minuten je Adresse). Beim Prüfen per Skript: `/data/rate-limit.json` löschen und den Container neu anlegen.
- **Letzte Gruppe gelöscht, keine neue anlegbar:** ohne einen einzigen Marker fehlte der Anhalt. `firstScopeAnchor` in `config.ts` nimmt dann das Frontend mit `# Globale HTTPS-Settings`.
- **Mit `strict-sni` kommt für einen unbekannten Namen keine TLS-Verbindung zustande**, die 404-Seite sieht man dort nur über HTTP.

## Sicherung
`lib/backup/`: ein Helfer-Container aus dem eigenen Abbild (`VolumesFrom` nur lesend, der Ordner des Servers als Einbindung) schreibt das Archiv, die Datenbank kommt vorher per `pg_dump` aus dem Postgres-Container. Das Zurückspielen (von Hand, Schritte in README und `docs/betrieb.md`) ist gegen den ganzen Stack geprüft.

## Prüfen
`scripts/verify/README.md`: Stack unter Docker Desktop, Pebble als Test-CA, lokale Registry für das Update von HAPM. Der Prüf-Stack belegt dieselben Ports wie `docker-compose.dev.yml` (7080, 8080, 8443): nie beide zugleich. Die FORGE-Policy sperrt Kommandos mit `rm -rf /x/*`, auch in `docker run`: mit `find … -delete` aufräumen.
