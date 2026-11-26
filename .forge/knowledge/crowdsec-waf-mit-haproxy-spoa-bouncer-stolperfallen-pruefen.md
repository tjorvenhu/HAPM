---
title: "CrowdSec (WAF) mit HAProxy: SPOA-Bouncer, Stolperfallen, Prüfen mit Docker"
summary: "Was bei CrowdSec (SPOA-Bouncer, AppSec, Parser, Freigaben, Compose-Profil, Ausnahmen je Anwendung, Container-Log) erst gegen echte Container auffiel und wie man es prüft. Vor Änderungen an lib/crowdsec lesen."
tags: ["crowdsec","stolperfalle","haproxy","docker","tests"]
updated: "2026-11-26T10:36:12.116Z"
---

# CrowdSec (WAF) mit HAProxy: Stolperfallen

Aufbau und Entscheidungen stehen in `docs/crowdsec.md`. Hier nur, was erst gegen echte Container auffiel (CrowdSec 1.8.2, `crowdsecurity/spoa-bouncer` 0.3.1, HAProxy 2.4 bis lts, Docker Compose 5.6).

## Prüfen

`pnpm crowdsec:verify` (`scripts/verify-crowdsec.ts`) startet HAProxy, CrowdSec, Bouncer und ein Ziel in einem Docker-Netz und prüft WAF, Sperre, Freigabe, Log-Szenario und Ausfall des Bouncers. Dauert 2 bis 4 Minuten (CrowdSec lädt beim ersten Start den Hub). Unter Windows aus Git Bash, Docker Desktop muss laufen.

**Eine Whitelist (Ausnahme je Anwendung) gegen echtes CrowdSec prüfen:** Datei in den Container nach `/etc/crowdsec/parsers/s02-enrich/` legen, `docker restart`, dann `cscli explain --type haproxy --log '<Zeile im Format von haproxy.log>'`. Eine passende Zeile zeigt „whitelisted". Unter Git Bash `export MSYS_NO_PATHCONV=1`, sonst schreibt `docker cp`/`docker exec` aus `/etc/…` einen Windows-Pfad. So sind alle Fälle aus `tests/crowdsec/apps.test.ts` bestätigt.

## Ausnahmen je Anwendung (`lib/crowdsec/apps.ts`)

- **CRS-Ausnahmen (`appsec-crs-exclusion-plugin-*`) laden nur Datendateien**, die die CRS-Regel selbst einbindet. Ohne OWASP-Modus tun sie nichts; die appsec-config muss sie nicht nennen.
- **`http_path` ist bei HAProxy die ganze Anfrage samt Query** (`http-logs` überschreibt nicht, weil `Parsed.http_path` leer bleibt). `$` im Muster braucht `(\?.*)?`. `Parsed.request` ist dagegen ohne Query.
- **Whitelist als Parser in s02-enrich, nicht postoverflow:** `http-crawl-non_statics` behält nur 5 Ereignisse.
- **Backslashes zweimal escapen** (expr-String in einfachen Anführungszeichen, dann YAML); `localRuleExpression`/`renderAppWhitelist` machen das.
- `cscli hub list -o json` (ohne `-a`) liefert alle installierten Arten auf einmal.
- Hub-Parser für die Logs einer App (`*-logs`, Brute-Force) nützen HAPM nichts: es gibt nur das Log von HAProxy.
- Quellen der eigenen Ausnahmen: Issues im Repo `crowdsecurity/hub` und discourse.crowdsec.net. Aufgenommen nur mit belegtem Pfad und Status.

## Container-Log (`lib/crowdsec/log-lines.ts`)

- logrus-Textformat. Die Zugriffszeilen der lokalen API enden bei 1.8 mit `"UA" "` (Referer ohne schließendes Anführungszeichen, nach logfmt-Entschlüsselung): das Muster darf den Rest der Zeile nicht verlangen.
- Dauer in Go-Schreibweise über `goDurationMs` aus `data.ts` (rein, auch im Client nutzbar).

## Abwählen in Compose

- **`scale: 0` reicht nicht:** Compose legt dann keine Container an, holt die Abbilder bei `pull` UND `up` aber trotzdem, und ist ein Abbild nicht erreichbar, scheitert `up -d` ganz.
- **Lösung: Profil aus einer Variablen**, `profiles: ["${HAPM_CROWDSEC_OFF:+ohne-crowdsec}"]`. Leer heißt für Compose immer dabei (Vorgabe an, auch ohne `.env`), gesetzt heißt ein Profil, das niemand einschaltet: kein Download, kein Container, `config --services` listet sie nicht.
- **Ein laufender Container eines abgewählten Dienstes bleibt stehen**, auch bei `up -d --remove-orphans`. `docker compose rm -sf crowdsec crowdsec-bouncer` entfernt ihn; `install.sh` tut das.
- `HAPM_CROWDSEC=0/1` geht mit Interpolation nicht auf ein Profil abzubilden, deshalb `HAPM_CROWDSEC_OFF`. `install.sh` nimmt `HAPM_CROWDSEC=0` weiter an und übersetzt eine alte Zeile in `.env`.

## Stolperfallen

- **Nachrichtennamen sind fest.** Der Bouncer beantwortet nur `crowdsec-http-body`, `crowdsec-http-no-body` (und `crowdsec-tcp`). Eine eigene Nachricht heißt im Bouncer-Log nur „Unknown message type", die Anfrage geht ungeprüft durch.
- **Das Docker-Abbild des Bouncers hat AppSec auskommentiert** (`appsec_url`). HAPM schreibt eine eigene `crowdsec-spoa-bouncer.yaml` (`renderBouncerConfig`). Ein `hosts`-Eintrag ohne Captcha-Anbieter erzeugt beim Start einmal „empty captcha provider" (level=error); ohne `hosts` je WAF-Treffer eine Warnung „no host matched".
- **Freigaben (`cscli allowlists`) schützen nur vor Sperren, nicht vor der WAF.** HAPM spiegelt die Liste nach `/etc/haproxy/hapm-crowdsec/allow.lst` (`hapm_crowdsec_allow`).
- **Eigener Parser in `s02-enrich` ohne `onsuccess: next_stage`**, sonst springt `http-logs` und damit kein Szenario mehr an.
- **Die Log-Quelle muss beim Start existieren**, sonst liest CrowdSec sie nie. HAPM legt sie beim Start an.
- **Hub-Sammlungen per SIGHUP neu laden ist unzuverlässig**: `reloadCrowdsec` startet den Container neu.
- **Unter Docker Desktop meldet inotify Änderungen an eingebundenen Windows-Dateien nicht:** im Prüfskript `poll_without_inotify: true`.
- **CrowdSec verlangt ein Volume für `/var/lib/crowdsec/data`**, sonst beendet es sich sofort.
- **Bouncer-Schlüssel:** das Abbild meldet Bouncer aus `/run/secrets/bouncer_key_<name>` an.
- **Der Bouncer beendet sich, wenn die lokale API beim Start nicht antwortet**; `restart: unless-stopped` holt das nach.
- **`filter spoe` gilt je Proxy**: die Zeilen stehen deshalb in jedem Backend des Ziels.
- **Kein Kommando hinter `withStdin`** (`lib/shell.ts`): sonst landet die Endmarke in der Datei („unknown keyword 'HAPM_STDIN_EOF'"). Das Heredoc immer ans Ende.
- **`withStdin` hängt an leeren Inhalt `\n` an**: beim Vergleich mit dem Dateiinhalt trimmen.
- **Ältere HAProxy-Abbilder (2.4 bis 3.0) scheitern an der Grundkonfiguration (QUIC), nicht an CrowdSec.** Das Prüfskript entfernt diese Zeilen für alles außer `lts`.
- **WAF-Alarme tragen die Domain** in `events[].meta` (`target_fqdn`), Log-Szenarien das Backend nur über den eigenen Parser (`target_backend`).
- **i18n-Schlüssel „Sperren" ist schon „Lock"**. Für CrowdSec eigene Schlüssel („Sperrliste", „Adresse sperren", „Treffer sperren").

## Dev-Stack (`docker-compose.dev.yml`)

- Wird `hapm` neu gebaut (`up -d --build hapm`), hängen HAProxy und Bouncer (`network_mode: service:hapm`) im Netz des alten Containers. Danach `up -d --force-recreate haproxy crowdsec-bouncer`.
- Der Dev-CrowdSec kopiert Quellen, Parser und Schlüssel nur beim Start aus dem Volume. Nach geänderten Regeln `docker restart hapm-dev-crowdsec`. Im Betrieb ist `HAPM_STORAGE/crowdsec/config` selbst `/etc/crowdsec`.
- Testen über die interne API: Token in `service_tokens` per `docker exec hapm-dev-postgres psql -U hapm -d hapm` anlegen, Anfragen durch HAProxy mit `docker exec hapm-dev curl -sk --resolve hapm.invalid:443:127.0.0.1 https://hapm.invalid/.env`.
- Log-Zeilen für Szenarien: Datei mit `docker cp` nach `hapm-dev:/tmp` und dort an `/var/log/haproxy/haproxy.log` hängen.

## Lokal ansehen und README-Bilder

Der FORGE-Dev-Server unter Windows erreicht Docker Desktop über `//./pipe/docker_engine`. Mit `HAPM_CROWDSEC_CONTAINER=hapm-dev-crowdsec`, `HAPM_CROWDSEC_BOUNCER_CONTAINER=hapm-dev-crowdsec-bouncer` und `HAPM_CROWDSEC_DIR=<Temp-Ordner>` in einer vorübergehenden `.env.local` zeigt die Seite CrowdSec echte Daten aus dem Dev-Stack (Schalter der Regeln installieren dann wirklich im Dev-Container; eigene Whitelists landen im Temp-Ordner). `.env.local` danach löschen. `haproxy.cfg` gibt es lokal nicht. Bilder über eine Wegwerf-Seite (siehe „HAPM lokal im Browser ansehen"), Bildgröße 1280x900.
