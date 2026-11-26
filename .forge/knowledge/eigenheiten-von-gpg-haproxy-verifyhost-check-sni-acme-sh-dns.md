---
title: "Eigenheiten von gpg, HAProxy (verifyhost, check-sni), acme.sh (dns_nsupdate, dns_infoblox), BIND und Pebble"
summary: "Was an den fremden Werkzeugen hinter Sicherungsschlüssel, eigener CA und DNS über RFC 2136 und Infoblox erst beim Prüfen gegen echte Container auffiel. Vor Änderungen an lib/backup, lib/dns, dns-credentials und HTTPS zum Ziel lesen."
tags: ["stolperfalle","docker","haproxy","acme","tests"]
updated: "2026-11-26T19:14:21.915Z"
---

# Eigenheiten fremder Werkzeuge (Stand November 2026)

## gpg (verschlüsselte Sicherung, `lib/backup/`)

- Im Abbild liegt nur das Paket `gpg`, ohne gpg-agent. `--symmetric` und `--decrypt` gehen dann nur mit `--passphrase-file` oder `--passphrase-fd`, `--batch --pinentry-mode loopback` und einem beschreibbaren `--homedir`. Fehlt der Ordner, endet gpg mit Exit 2, obwohl die Datei geschrieben ist.
- `localExec` (`lib/ssh.ts`) gibt das Kommando als Argument an `bash -c`. Ein Heredoc aus `withStdin` steht damit samt Inhalt in `ps`. Für den Sicherungsschlüssel deshalb eine Datei (600) statt stdin. Dasselbe gilt für die vorhandenen Stellen mit EAB-Schlüssel, DNS-Zugangsdaten und hochgeladenem PEM: dort ist es unverändert so.
- Ein verändertes Archiv schreibt gpg erst heraus und meldet den Fehler am Ende. Deshalb in eine `.part`-Datei entschlüsseln und erst nach `DECRYPTION_OKAY` (`--status-fd`) und Exit 0 umbenennen, von Hand nie `gpg | tar`.
- Ein falscher Schlüssel ist `BAD_PASSPHRASE` im Status, gelesen wird nie der Text für Menschen.
- gpg unter Git Bash braucht Pfade als `/c/…`, nicht `C:/…`.
- Der Helfer läuft mit `bash` und `pipefail` (sonst gälte ein gescheitertes `tar` als gelungen). Mit `pipefail` beendet ein `grep` ohne Treffer das Skript: `{ grep … || true; }`.

## HAProxy: Zertifikat des Ziels prüfen (`lib/haproxy/config.ts`, `pnpm haproxy:verify-tls`)

- Gegen welchen Namen geprüft wird, bestimmt der SNI: `sni str(<name>)` prüft auf 2.6, 3.0 und 3.4 gegen den Namen. `verifyhost` allein prüft bis 3.2 gegen den Namen, ab 3.3 nicht mehr (dort geht die Domain der Anfrage als SNI hinaus, 503). HAPM schreibt deshalb nur SNI und `check-sni`, kein `verifyhost`.
- Der Healthcheck prüft das Zertifikat gegen `check-sni`. Mit falschem Namen nimmt HAProxy das Ziel aus dem Betrieb.
- Der Host-Header zum Ziel bleibt die Domain der Anfrage. Ein Ziel, das SNI und Host gegeneinander prüft (Apache mit mehreren virtuellen Hosts), ist nicht gemessen.
- `X509Certificate.ca` von Node ist `false` für selbst signierte Roots der Fassung 1. `isVersion1` in `lib/haproxy/backend-ca.ts` liest die Fassung aus dem DER.
- `BackendTls` enthält den Template-Typ `ca:${string}`: ein `Record<BackendTls, …>` kompiliert, liefert für `ca:x` aber `undefined`. Für Beschriftungen `backendTlsKind()`.
- Echte Kommandos aus `provision.ts` prüfen: in einem Vitest-Test `@/lib/ssh` so mocken, dass `sshExec` per `docker exec -i <box> bash -c <command>` in einen `haproxy:lts`-Container geht (`-u root`, `--entrypoint sleep`, Stub für `hapm-reload`).
- Master-Socket unter Docker Desktop: `-S 0.0.0.0:9999` über TCP und `--tmpfs /run/haproxy`, ein eingebundener Windows-Ordner trägt keinen Unix-Socket (`pnpm sync:verify`).

## acme.sh: DNS-01 über eigene Nameserver (`lib/haproxy/dns-credentials.ts`, `pnpm dns:verify`)

- Ohne `--dnssleep` fragt acme.sh öffentliche DoH-Dienste, ob der TXT-Eintrag sichtbar ist. Eine interne Zone sieht dort niemand. Für `dns_nsupdate` und `dns_infoblox` setzt HAPM deshalb `--dnssleep` (Einstellung `dnsWait`, 5 bis 900, Vorgabe 30). Der Wert bleibt als `Le_DNSSleep` am Zertifikat und gilt auch bei der Erneuerung.
- `dns_nsupdate`: ohne `zone` fragt `nsupdate` den genannten Server nach dem SOA, `NSUPDATE_ZONE` bleibt leer, damit ein Schlüssel für mehrere Zonen gilt. Die Schlüsseldatei liegt unter `/root/.acme.sh/hapm-nsupdate.key` (600) und muss für die Erneuerung liegen bleiben.
- `dns_infoblox`: liest seine Variablen ohne `SAVED_`, und `dns_infoblox_rm` setzt keine Vorgabe für die View. `Infoblox_View` wird deshalb immer geschrieben. Gegen eine echte Appliance ist nichts davon geprüft.
- Eigene CA für die Appliance: über den Bestand des Containers (`/root/.acme.sh/hapm-trust/`, `TRUST_SYNC` nach dem Speichern und bei jedem Start), nicht über `CA_BUNDLE`: das gälte auch für den ACME-Server. Ein von Hand gesetztes `CA_BUNDLE` in `account.conf` (wie in `scripts/verify/README.md` für Pebble) schaltet `hapm-trust` aus.

## BIND und Pebble unter Docker Desktop

- BIND: Zonendateien mit `docker cp` hineinlegen und `chown`, ein eingebundener Ordner ist für das Journal nicht beschreibbar.
- Pebble: das Abbild hat keine Shell (`docker cp` statt `exec cat`). `PEBBLE_AUTHZREUSE=0` setzen, sonst überspringt die Erneuerung die Challenge.
- OpenSSL in Git Bash: `-subj "/CN=…"` braucht `MSYS_NO_PATHCONV=1` und dann relative Pfade. Aus Node per `execFileSync` geht es ohne.
