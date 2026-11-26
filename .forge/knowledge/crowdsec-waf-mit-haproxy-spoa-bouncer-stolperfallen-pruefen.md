---
title: "CrowdSec (WAF) mit HAProxy: SPOA-Bouncer, Stolperfallen, Prüfen mit Docker"
summary: "Was beim Einbau von CrowdSec (SPOA-Bouncer, AppSec, Log-Parser, Freigaben, Abwählen per Compose-Profil) nur mit echten Containern auffiel und wie man es wieder prüft, auch im Dev-Stack. Vor Änderungen an lib/crowdsec, CROWDSEC_LINES oder den CrowdSec-Diensten in Compose lesen."
tags: ["crowdsec","stolperfalle","haproxy","docker","tests"]
updated: "2026-11-26T09:10:15.767Z"
---

# CrowdSec (WAF) mit HAProxy: Stolperfallen

Aufbau und Entscheidungen stehen in `docs/crowdsec.md`. Hier nur, was erst gegen echte Container auffiel (CrowdSec 1.8.2, `crowdsecurity/spoa-bouncer` 0.3.1, HAProxy 2.4 bis lts, Docker Compose 5.6).

## Prüfen

`pnpm crowdsec:verify` (`scripts/verify-crowdsec.ts`) startet HAProxy, CrowdSec, Bouncer und ein Ziel in einem Docker-Netz und prüft WAF, Sperre, Freigabe, Log-Szenario und Ausfall des Bouncers. Dauert 2 bis 4 Minuten (CrowdSec lädt beim ersten Start den Hub). Unter Windows aus Git Bash, Docker Desktop muss laufen.

## Abwählen in Compose

- **`scale: 0` reicht nicht:** Compose legt dann keine Container an, holt die Abbilder bei `pull` UND `up` aber trotzdem, und ist ein Abbild nicht erreichbar, scheitert `up -d` ganz.
- **Lösung: Profil aus einer Variablen**, `profiles: ["${HAPM_CROWDSEC_OFF:+ohne-crowdsec}"]`. Leer heißt für Compose immer dabei (Vorgabe an, auch ohne `.env`), gesetzt heißt ein Profil, das niemand einschaltet: kein Download, kein Container, `config --services` listet sie nicht.
- **Ein laufender Container eines abgewählten Dienstes bleibt stehen**, auch bei `up -d --remove-orphans` (er ist kein Waise, der Dienst steht noch in der Datei). `docker compose rm -sf crowdsec crowdsec-bouncer` nennt ihn ausdrücklich und entfernt ihn; `install.sh` tut das.
- `HAPM_CROWDSEC=0/1` geht mit Interpolation nicht auf ein Profil abzubilden (Compose kann keine Werte vergleichen), deshalb die Abschalt-Variable `HAPM_CROWDSEC_OFF`. `install.sh` nimmt `HAPM_CROWDSEC=0` als Eingabe weiter an und übersetzt eine alte Zeile in `.env`.

## Stolperfallen

- **Nachrichtennamen sind fest.** Der Bouncer beantwortet nur `crowdsec-http-body`, `crowdsec-http-no-body` (und `crowdsec-tcp`). Eine eigene Nachricht heißt im Bouncer-Log nur „Unknown message type", die Anfrage geht ungeprüft durch.
- **Das Docker-Abbild des Bouncers hat AppSec auskommentiert** (`appsec_url`). HAPM schreibt eine eigene `crowdsec-spoa-bouncer.yaml` (`renderBouncerConfig`). Ein `hosts`-Eintrag ohne Captcha-Anbieter erzeugt beim Start einmal „empty captcha provider" (level=error); ohne `hosts` stattdessen je WAF-Treffer eine Warnung „no host matched". HAPM nimmt das eine Mal beim Start.
- **Freigaben (`cscli allowlists`) schützen nur vor Sperren, nicht vor der WAF.** Lösung: HAPM spiegelt die Liste nach `/etc/haproxy/hapm-crowdsec/allow.lst`, HAProxy fragt für diese Adressen nicht (`hapm_crowdsec_allow`).
- **Eigener Parser in `s02-enrich` ohne `onsuccess: next_stage`**, sonst springt `http-logs` und damit kein Szenario mehr an.
- **Die Log-Quelle muss beim Start existieren**, sonst liest CrowdSec sie nie. HAPM legt sie beim Start an.
- **Unter Docker Desktop meldet inotify Änderungen an eingebundenen Windows-Dateien nicht:** im Prüfskript `poll_without_inotify: true`.
- **CrowdSec verlangt ein Volume für `/var/lib/crowdsec/data`**, sonst beendet es sich sofort.
- **Bouncer-Schlüssel:** das Abbild meldet Bouncer aus `/run/secrets/bouncer_key_<name>` an (nicht nur unter Swarm).
- **Der Bouncer beendet sich, wenn die lokale API beim Start nicht antwortet**; `restart: unless-stopped` holt das nach.
- **`filter spoe` gilt je Proxy**: die Zeilen stehen deshalb in jedem Backend des Ziels.
- **Kein Kommando hinter `withStdin`** (`lib/shell.ts`): steht hinter der Endmarke des Heredocs noch `&& …`, endet es nicht, und die Marke landet in der Datei (fiel als „unknown keyword 'HAPM_STDIN_EOF'" in `spoe.cfg` auf). Das Heredoc immer ans Ende.
- **`withStdin` hängt an leeren Inhalt `\n` an**: Vergleiche mit dem Dateiinhalt ohne Zeilenumbruch, sonst „ändert" sich die Datei bei jedem Abgleich.
- **Ältere HAProxy-Abbilder (2.4 bis 3.0) scheitern an der Grundkonfiguration (QUIC), nicht an CrowdSec.** Das Prüfskript entfernt diese Zeilen für alles außer `lts`.
- **WAF-Alarme tragen die Domain** in `events[].meta` (`target_fqdn`), Log-Szenarien das Backend nur über den eigenen Parser (`target_backend`).
- **i18n-Schlüssel „Sperren" ist schon „Lock"** (Passwortsperre, `proxyForms.ts`). Für CrowdSec eigene Schlüssel nehmen („Sperrliste", „Adresse sperren", „Treffer sperren").

## Dev-Stack (`docker-compose.dev.yml`)

- Wird `hapm` neu gebaut (`up -d --build hapm`), hängen HAProxy und Bouncer (`network_mode: service:hapm`) im Netz des alten Containers und lauschen ins Leere. Danach `up -d --force-recreate haproxy crowdsec-bouncer`.
- Der Dev-CrowdSec kopiert Quellen, Parser und Schlüssel nur beim Start aus dem Volume (Docker Desktop trägt keine Unix-Sockets in eingebundenen Ordnern, deshalb Volumes). Nach geänderten Regeln im Dev-Stack `docker restart hapm-dev-crowdsec`. Im Betrieb ist `HAPM_STORAGE/crowdsec/config` selbst `/etc/crowdsec`.
- Testen über die interne API: Token in `service_tokens` per `docker exec hapm-dev-postgres psql -U hapm -d hapm` anlegen (siehe Eintrag zum MCP-Endpunkt), Anfragen durch HAProxy mit `docker exec hapm-dev curl -sk --resolve hapm.invalid:443:127.0.0.1 https://hapm.invalid/.env` (das Platzhalter-Zertifikat heißt `hapm.invalid`, `strict-sni`).
- Log-Zeilen für Szenarien: Datei mit `docker cp` nach `hapm-dev:/tmp` und dort an `/var/log/haproxy/haproxy.log` hängen (Git Bash: Pfad als `C:/…`, `/tmp` gibt es für `docker cp` nicht).

## Lokal ansehen und README-Bilder

Der FORGE-Dev-Server unter Windows erreicht Docker Desktop über `//./pipe/docker_engine`. Mit `HAPM_CROWDSEC_CONTAINER=hapm-dev-crowdsec` und `HAPM_CROWDSEC_BOUNCER_CONTAINER=hapm-dev-crowdsec-bouncer` in einer vorübergehenden `.env.local` zeigt die Seite CrowdSec echte Daten aus dem Dev-Stack. `haproxy.cfg` gibt es lokal nicht. Die Übersicht für `docs/images/uebersicht.jpg` / `overview.en.jpg` entstand über eine Wegwerf-Seite mit nachgestelltem `/api/system` (siehe Eintrag „HAPM lokal im Browser ansehen"), Sprache über Konto → Sprache umschalten. Bildgröße 1280x900.
