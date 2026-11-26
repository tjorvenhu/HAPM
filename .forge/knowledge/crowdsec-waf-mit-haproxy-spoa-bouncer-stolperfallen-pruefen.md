---
title: "CrowdSec (WAF) mit HAProxy: SPOA-Bouncer, Stolperfallen, Prüfen mit Docker"
summary: "Was bei CrowdSec (SPOA-Bouncer, AppSec/OWASP, HTTP/3, erlaubte Methoden, Parser, Freigaben, Compose-Profil, Ausnahmen je Anwendung, Container-Log) erst gegen echte Container auffiel und wie man eine CRS-Regel im Dev-Stack prüft. Vor Änderungen an lib/crowdsec lesen."
tags: ["crowdsec","stolperfalle","haproxy","docker","tests"]
updated: "2026-11-26T16:26:59.692Z"
---

# CrowdSec (WAF) mit HAProxy: Stolperfallen

Aufbau und Entscheidungen stehen in `docs/crowdsec.md`. Hier nur, was erst gegen echte Container auffiel (CrowdSec 1.8.2, `crowdsecurity/spoa-bouncer` 0.3.1, HAProxy 2.4 bis lts, Docker Compose 5.6).

## Prüfen

`pnpm crowdsec:verify` (`scripts/verify-crowdsec.ts`) startet HAProxy, CrowdSec, Bouncer und ein Ziel in einem Docker-Netz und prüft WAF, Sperre, Freigabe, Log-Szenario und Ausfall des Bouncers. Dauert 2 bis 4 Minuten (CrowdSec lädt beim ersten Start den Hub). Unter Windows aus Git Bash, Docker Desktop muss laufen.

**Eine Whitelist (Ausnahme je Anwendung) gegen echtes CrowdSec prüfen:** Datei in den Container nach `/etc/crowdsec/parsers/s02-enrich/` legen, `docker restart`, dann `cscli explain --type haproxy --log '<Zeile im Format von haproxy.log>'`. Eine passende Zeile zeigt „whitelisted". Unter Git Bash `export MSYS_NO_PATHCONV=1`, sonst schreibt `docker cp`/`docker exec` aus `/etc/…` einen Windows-Pfad. So sind alle Fälle aus `tests/crowdsec/apps.test.ts` bestätigt.

**Eine CRS-Regel im Dev-Stack prüfen (ohne HAProxy, ohne die Quellen von HAPM zu ändern):**
1. Im Dev-CrowdSec ist CRS meist aus. Zweiten AppSec-Listener anlegen: `/etc/crowdsec/acquis.d/zz-test-crs.yaml` mit `source: appsec`, `listen_addr: 0.0.0.0:7424`, `name: hapmtest`, `appsec_configs: [crowdsecurity/appsec-default, crowdsecurity/crs]`, `labels: {type: appsec}`; `docker restart hapm-dev-crowdsec` (~25 s). Die Datei übersteht den Neustart (der Start kopiert nur `hapm.yaml`).
2. Im CrowdSec-Container gibt es **kein curl**: aus `hapm-dev` schicken, `curl http://crowdsec:7424/` mit `X-Crowdsec-Appsec-Ip`, `-Uri`, `-Host`, `-Verb`, `-Api-Key` (Schlüssel: `docker exec hapm-dev-crowdsec cat /run/secrets/bouncer_key_hapm`), `-User-Agent`, `-Http-Version: 20`. Out-of-band antwortet immer 200.
3. Treffer: `cscli alerts list` (nicht mit `-i` filtern, das zeigte trotz Treffern „No active alerts"), Regel und Methode mit `cscli alerts inspect <id> -d` (`msg`, `matched_zones`, `method`). Jede Testreihe mit neuer Quell-IP (198.51.100.x).
4. Aufräumen: Testdatei entfernen, neu starten.

## OWASP CRS

- **Regel 920430** („HTTP protocol version is not allowed by policy") greift bei jeder Anfrage über HTTP/3: das CRS in CrowdSec 1.8 erlaubt nur 1.0, 1.1, 2. Lösung in `spoe.cfg`: `version=req.ver,regsub(^3,2)`.
- **Regel 911100** („Method is not allowed by policy"): ab Werk nur GET HEAD POST OPTIONS. Jedes PATCH/PUT/DELETE (also die Oberfläche von HAPM) gab `anomaly score out-of-band: anomaly: 5`. Lösung: CRS-Plugin-Datei `crowdsec/data/crs-plugins/hapm/hapm-config.conf` (`renderCrsMethods`), denn `crowdsecurity/crs` lädt `crs-plugins/*/*-config.conf` **aus dem Datenordner** (`/var/lib/crowdsec/data`, relativ zu dem auch `crs-setup.conf` liegt) vor REQUEST-901. Bestätigt: danach nur noch TRACE als Treffer.
- `anomaly: N` ohne Kategorie im Namen heißt: eine Regel ohne eigene Kategorie (Protokoll, Methode, Dateiendung); `lfi`, `rce`, `xss` usw. sind die CRS-Punkte je Kategorie. Die Beschreibungen für die Oberfläche: `lib/crowdsec/describe.ts`.
- **CRS-Regeln lassen sich in CrowdSec 1.8.2 nicht per Hook abschalten:** `RemoveOutBandRuleByID`/`RemoveInBandRuleByID` wirkten weder in `on_load` noch in `pre_eval`. Einstellungen gehen über Plugin-Dateien (siehe oben).
- **Nennt `acquis.d` eine appsec-config, die es nicht gibt, beendet sich CrowdSec beim Start** (`fatal … no appsec-config found`).
- Das Docker-Abbild verlinkt beim Start nur Dateien aus `/staging/var/lib/crowdsec/data`, die im Datenordner fehlen: eine vorher angelegte Datei von HAPM stört nicht.
- Der Bouncer gibt das SPOE-Argument `url` als `X-Crowdsec-Appsec-Uri` weiter; bei HTTP/2 und HTTP/3 ist das die volle Form `https://host/pfad`. Löst keine Regel aus.
- HAProxy liest `spoe.cfg` nur beim Laden: ändert sie sich mit einem Update, lädt `lib/bootstrap.ts` neu (`reloadForCrowdsec`).

## Ausnahmen je Anwendung (`lib/crowdsec/apps.ts`)

- **CRS-Ausnahmen (`appsec-crs-exclusion-plugin-*`) laden nur Datendateien**, die die CRS-Regel selbst einbindet. Ohne OWASP-Modus tun sie nichts. Das Nextcloud-Plugin hängt seine WebDAV-Methoden an `tx.allowed_methods` an.
- **`http_path` ist bei HAProxy die ganze Anfrage samt Query.** `$` im Muster braucht `(\?.*)?`. `Parsed.request` ist ohne Query.
- **Whitelist als Parser in s02-enrich, nicht postoverflow:** `http-crawl-non_statics` behält nur 5 Ereignisse.
- **Backslashes zweimal escapen** (expr-String, dann YAML); `localRuleExpression`/`renderAppWhitelist` machen das.
- `cscli hub list -o json` (ohne `-a`) liefert alle installierten Arten auf einmal.
- Hub-Parser für die Logs einer App nützen HAPM nichts: es gibt nur das Log von HAProxy.

## Container-Log (`lib/crowdsec/log-lines.ts`)

- logrus-Textformat. Die Zugriffszeilen der lokalen API enden bei 1.8 mit `"UA" "` (Referer ohne schließendes Anführungszeichen): das Muster darf den Rest der Zeile nicht verlangen.

## Abwählen und Abschalten

- **`scale: 0` reicht nicht** (Abbilder werden trotzdem geholt). Lösung: `profiles: ["${HAPM_CROWDSEC_OFF:+ohne-crowdsec}"]`.
- **Ein laufender Container eines abgewählten Dienstes bleibt stehen**, auch bei `--remove-orphans`. `docker compose rm -sf crowdsec crowdsec-bouncer`; `install.sh` tut das.
- **Abschalten in der Oberfläche** ist die Datei `hapm-disabled` im Ordner von CrowdSec (`DISABLED_FILE` in `lib/crowdsec/paths.ts`; kein DB-Feld, weil `crowdsecInstalled()` synchron gefragt wird). Erst Lauf am Reverse-Proxy (CrowdSec aus `haproxy.cfg`), dann Container anhalten; der Scheduler hält sie angehalten.

## Stolperfallen

- **Nachrichtennamen sind fest:** `crowdsec-http-body`, `crowdsec-http-no-body`. Eine eigene heißt im Bouncer-Log nur „Unknown message type", die Anfrage geht ungeprüft durch.
- **Das Docker-Abbild des Bouncers hat AppSec auskommentiert.** HAPM schreibt eine eigene `crowdsec-spoa-bouncer.yaml`. Ein `hosts`-Eintrag ohne Captcha erzeugt beim Start einmal „empty captcha provider".
- **Freigaben (`cscli allowlists`) schützen nur vor Sperren, nicht vor der WAF.** HAPM spiegelt sie nach `allow.lst` (`hapm_crowdsec_allow`).
- **Eigener Parser in `s02-enrich` ohne `onsuccess: next_stage`**, sonst springt `http-logs` nicht an.
- **Die Log-Quelle muss beim Start existieren.**
- **Hub-Sammlungen per SIGHUP neu laden ist unzuverlässig**: `reloadCrowdsec` startet den Container neu.
- **Unter Docker Desktop meldet inotify Änderungen an eingebundenen Windows-Dateien nicht:** `poll_without_inotify: true` im Prüfskript.
- **CrowdSec verlangt ein Volume für `/var/lib/crowdsec/data`.**
- **Bouncer-Schlüssel** aus `/run/secrets/bouncer_key_<name>`.
- **Der Bouncer beendet sich, wenn die lokale API beim Start nicht antwortet**; `restart: unless-stopped` holt das nach.
- **`filter spoe` gilt je Proxy**: die Zeilen stehen in jedem Backend des Ziels.
- **Das Backend `hapm_crowdsec_spoa`** (TCP zum Bouncer) erscheint in der Statistik mit sehr vielen „Anfragen": bei TCP zählt die Sitzung, und jede geprüfte HTTP-Anfrage ist ein SPOE-Austausch. Es ist kein Ziel und steht in keiner Gruppe.
- **Kein Kommando hinter `withStdin`**, das Heredoc immer ans Ende. **`withStdin` hängt an leeren Inhalt `\n` an**: beim Vergleich trimmen.
- **Ältere HAProxy-Abbilder (2.4 bis 3.0) scheitern an der Grundkonfiguration (QUIC).** Das Prüfskript entfernt diese Zeilen.
- **WAF-Alarme tragen die Domain** (`target_fqdn`), Log-Szenarien das Backend nur über den eigenen Parser (`target_backend`).
- **i18n-Schlüssel „Sperren" ist schon „Lock".**

## Dev-Stack (`docker-compose.dev.yml`)

- Wird `hapm` neu gebaut, hängen HAProxy und Bouncer im Netz des alten Containers: `up -d --force-recreate haproxy crowdsec-bouncer`.
- Der Dev-CrowdSec kopiert beim Start aus dem Volume (`/crowdsec` im HAPM-Container, `/hapm-crowdsec` im CrowdSec-Container): Quellen, `parsers/s02-enrich/hapm-*.yaml`, `appsec-configs/hapm-*.yaml`, Schlüssel. Sein Datenordner ist ein eigenes Volume: was HAPM nach `crowdsec/data/` schreibt (CRS-Plugin), kommt im Dev-Stack nicht an. Im Betrieb ist `HAPM_STORAGE/crowdsec/config` selbst `/etc/crowdsec` und `crowdsec/data` selbst `/var/lib/crowdsec/data`.
- Anfragen durch HAProxy: `docker exec hapm-dev curl -sk --resolve hapm.invalid:443:127.0.0.1 https://hapm.invalid/.env`.

## MCP der Produktion abfragen, wenn die Werkzeugliste der Session alt ist

Die MCP-Werkzeuge einer Claude-Session stehen ab ihrem Start fest. Neue Werkzeuge nach einem Update von HAPM erreicht man per JSON-RPC an dieselbe URL mit den Kopfzeilen aus `~/.claude.json` (`mcpServers.hapm`): `initialize`, die Benachrichtigung `initialized`, dann `tools/call`, Antwort ggf. als SSE (`data:`-Zeile). Token nicht ausgeben. `list_crowdsec_alerts` für 7 Tage ist oft zu groß für eine Antwort: die Ausgabe landet in einer Datei, dort mit grep zählen.

## Lokal ansehen

Der FORGE-Dev-Server erreicht Docker Desktop über `//./pipe/docker_engine`. Mit `HAPM_CROWDSEC_CONTAINER=hapm-dev-crowdsec`, `HAPM_CROWDSEC_BOUNCER_CONTAINER=hapm-dev-crowdsec-bouncer` und `HAPM_CROWDSEC_DIR=<Temp-Ordner>` in einer vorübergehenden `.env.local` zeigt die Seite CrowdSec echte Daten aus dem Dev-Stack. `.env.local` danach löschen. `haproxy.cfg` gibt es lokal nicht. Für einzelne Panels mit festen Daten: Wegwerf-Seite `app/(app)/zz-preview/page.tsx` mit gemocktem `window.fetch` für `/api/crowdsec/alerts`, `/decisions`, `/stats` (Form siehe `lib/crowdsec/data.ts`, `CrowdsecStats` braucht alle Felder samt `paths` und `bucketMs`).
