---
title: "CrowdSec (WAF) mit HAProxy: SPOA-Bouncer, Stolperfallen, Prüfen mit Docker"
summary: "Was bei CrowdSec (SPOA-Bouncer, AppSec/OWASP, HTTP/3, erlaubte Methoden, Parser, Freigaben, Compose-Profil, Anwendungen je Ziel, Container-Log) erst gegen echte Container auffiel und wie man WAF-Regeln und Whitelists mit einem Wegwerf-Container prüft. Vor Änderungen an lib/crowdsec lesen."
tags: ["crowdsec","stolperfalle","haproxy","docker","tests"]
updated: "2026-11-26T17:03:13.519Z"
---

# CrowdSec (WAF) mit HAProxy: Stolperfallen

Aufbau und Entscheidungen stehen in `docs/crowdsec.md`. Hier nur, was erst gegen echte Container auffiel (CrowdSec 1.8.2, `crowdsecurity/spoa-bouncer` 0.3.1, HAProxy 2.4 bis lts, Docker Compose 5.6).

## Prüfen

`pnpm crowdsec:verify` (`scripts/verify-crowdsec.ts`) startet HAProxy, CrowdSec, Bouncer und ein Ziel in einem Docker-Netz und prüft WAF, Sperre, Freigabe, Log-Szenario und Ausfall des Bouncers. Dauert 2 bis 4 Minuten (CrowdSec lädt beim ersten Start den Hub). Unter Windows aus Git Bash, Docker Desktop muss laufen.

**Wegwerf-CrowdSec für schnelle Proben (ohne HAProxy, ohne Dev-Stack):**
```
docker run -d --name hapm-csprobe -p 17422:7422 -e CROWDSEC_BYPASS_DB_VOLUME_CHECK=true \
  -e BOUNCER_KEY_probe=<schlüssel> \
  -e COLLECTIONS="crowdsecurity/appsec-virtual-patching crowdsecurity/appsec-generic-rules crowdsecurity/appsec-crs-inband crowdsecurity/haproxy …" \
  crowdsecurity/crowdsec:latest
```
- Ohne `CROWDSEC_BYPASS_DB_VOLUME_CHECK` beendet sich das Abbild sofort (kein Volume für `/var/lib/crowdsec/data`).
- Sammlungen über `COLLECTIONS` beim Start, nicht nachträglich per `cscli`: eine `acquis.d`-Datei, die `crowdsecurity/appsec-default` nennt, bevor die Sammlung da ist, lässt CrowdSec in einer Neustart-Schleife hängen (`fatal … no appsec-config found`), und `docker exec` geht dann nicht mehr.
- Dateien per `docker cp "$(cygpath -w <datei>)" hapm-csprobe:/pfad` (Git Bash mit `MSYS_NO_PATHCONV=1`: der Quellpfad muss ein Windows-Pfad sein, sonst „GetFileAttributesEx C:\tmp… nicht gefunden").
- AppSec-Quelle: `acquis.d/appsec.yaml` mit `source: appsec`, `listen_addr: 0.0.0.0:7422`, `appsec_configs: [crowdsecurity/appsec-default, crowdsecurity/crs-inband]`, `labels: {type: appsec}`, dann `docker restart`. Anfragen per curl an `127.0.0.1:17422` mit `X-Crowdsec-Appsec-Ip/-Uri/-Host/-Verb/-Api-Key`; inband antwortet 403 bei Treffer. **`REQUEST_HEADERS:Host` kommt aus `X-Crowdsec-Appsec-Host`**, ein eigener `Host`-Header ist nicht nötig.
- Gute WAF-Probe für OWASP-Ausnahmen: `POST /wp-admin/post.php` mit `action=editpost&content=<script>alert(document.cookie)</script>` (WordPress-Plugin nimmt `ARGS:content` aus; anderer Pfad gibt 403).
- Whitelist prüfen: Datei nach `/etc/crowdsec/parsers/s02-enrich/`, `docker restart`, dann `cscli explain --type haproxy --log 'Nov 26 16:00:00 proxy haproxy[123]: 192.0.2.10:51234 [26/Nov/2026:16:00:00.000] https~ <backend>/<server> 0/0/1/2/3 404 120 - - ---- 1/1/0/0/0 0/0 "GET /pfad HTTP/1.1"'`. Treffer: „ignored by whitelist".
- Danach `docker rm -f hapm-csprobe`.

**Eine CRS-Regel im Dev-Stack prüfen:** zweiten AppSec-Listener in `hapm-dev-crowdsec` anlegen (`acquis.d/zz-test-crs.yaml`, Port 7424), aus `hapm-dev` per curl schicken (im CrowdSec-Container gibt es kein curl), Schlüssel aus `/run/secrets/bouncer_key_hapm`. Treffer mit `cscli alerts list` (nicht mit `-i` filtern) und `cscli alerts inspect <id> -d`. Danach Testdatei entfernen.

## OWASP CRS

- **Regel 920430** greift bei jeder Anfrage über HTTP/3: Lösung in `spoe.cfg`: `version=req.ver,regsub(^3,2)`.
- **Regel 911100**: ab Werk nur GET HEAD POST OPTIONS. Lösung: `crs-plugins/hapm/hapm-config.conf` (`renderCrsMethods`, `CRS_METHODS_FILE`), geladen aus dem Datenordner vor REQUEST-901. Muss für alle Hosts gelten, sonst weist OWASP die Oberfläche von HAPM ab.
- `crowdsecurity/crs` lädt `crs-plugins/*/*-config.conf`, dann `*-before.conf`, dann die Regeln, dann `*-after.conf`.
- **CRS-Regeln lassen sich per Hook nicht abschalten** (`RemoveOutBandRuleByID`/`RemoveInBandRuleByID` wirkungslos in 1.8.2). Einstellungen gehen über Plugin-Dateien.
- Nennt `acquis.d` eine appsec-config, die es nicht gibt, beendet sich CrowdSec beim Start.
- Der Bouncer gibt `url` als `X-Crowdsec-Appsec-Uri` weiter, bei HTTP/2 und 3 in voller Form. Löst keine Regel aus.

## Anwendungen je Ziel (`lib/crowdsec/apps.ts`, seit 2026-11-26)

Die Anwendung steht als `# hapm-app: <id>` im Backend des Ziels; `queueAppSync` gleicht nach jedem Lauf am Ziel und einmal je Start ab. Was dabei gegen 1.8.2 geprüft ist:
- **OWASP-Ausnahmen je Host:** jedes Plugin aus dem Hub prüft in `-before.conf` `TX:<name>-rule-exclusions-plugin_enabled "@eq 0"` (`ctl:ruleRemoveById` auf seinen Bereich); ohne gesetzte Variable gilt es überall. Kein Plugin setzt sie selbst (alle acht geprüft; phpMyAdmin setzt nur `_url_format`). HAPM schreibt `crs-plugins/hapm/hapm-apps-config.conf`: `SecAction … setvar:'tx.<name>-…_enabled=0'` und `SecRule REQUEST_HEADERS:Host "@rx ^(?:…)(?::[0-9]+)?$" "…,t:lowercase,setvar:…=1"`. Ergebnis: 200 auf dem Host des Ziels, 403 auf anderen; ohne Datei 200 überall.
- **Eigene Whitelists je Backend:** `evt.Parsed.backend_name in [...]` im `filter` geht schon in `s02-enrich` (kommt aus dem HAProxy-Parser in s01). Der eigene Parser `hapm-backend.yaml` (Meta `target_backend`) läuft in derselben Stufe, die Reihenfolge dort ist nicht verlässlich: nicht `evt.Meta.target_backend` nehmen.
- Whitelists aus dem Hub bleiben global (Parser ohne Bedingung je Ziel).
- Jeder Abgleich startet CrowdSec neu: `queueAppSync` reiht nur ein, wenn sich Dateien oder Hub-Stand ändern.

Weiter gilt:
- CRS-Ausnahmen laden nur Datendateien, die die CRS-Regel einbindet: ohne OWASP wirkungslos.
- **`http_path` ist bei HAProxy die ganze Anfrage samt Query.** `$` braucht `(\?.*)?`.
- **Whitelist als Parser in s02-enrich, nicht postoverflow** (`http-crawl-non_statics` behält nur 5 Ereignisse).
- **Backslashes zweimal escapen** (expr, dann YAML).
- `cscli hub list -o json` liefert alle installierten Arten auf einmal.

## Container-Log (`lib/crowdsec/log-lines.ts`)

- Zugriffszeilen der lokalen API enden bei 1.8 mit `"UA" "`: das Muster darf den Rest nicht verlangen.

## Abwählen und Abschalten

- `scale: 0` reicht nicht; `profiles: ["${HAPM_CROWDSEC_OFF:+ohne-crowdsec}"]`.
- Ein laufender Container eines abgewählten Dienstes bleibt stehen: `docker compose rm -sf crowdsec crowdsec-bouncer` (tut `install.sh`).
- Abschalten in der Oberfläche ist die Datei `hapm-disabled` im Ordner von CrowdSec.

## Stolperfallen

- Nachrichtennamen fest: `crowdsec-http-body`, `crowdsec-http-no-body`.
- Das Abbild des Bouncers hat AppSec auskommentiert: HAPM schreibt eine eigene Konfiguration.
- Freigaben schützen nur vor Sperren, nicht vor der WAF: HAPM spiegelt sie nach `allow.lst`.
- Eigener Parser in `s02-enrich` ohne `onsuccess: next_stage`.
- Die Log-Quelle muss beim Start existieren.
- SIGHUP lädt Sammlungen unzuverlässig: `reloadCrowdsec` startet den Container neu.
- Docker Desktop: inotify meldet Änderungen an Windows-Dateien nicht (`poll_without_inotify: true` im Prüfskript).
- Der Bouncer beendet sich, wenn die lokale API beim Start nicht antwortet; `restart: unless-stopped`.
- `filter spoe` gilt je Proxy: die Zeilen stehen in jedem Backend.
- Backend `hapm_crowdsec_spoa` zählt in der Statistik nicht als Ziel.
- Kein Kommando hinter `withStdin`; `withStdin` hängt an leeren Inhalt `\n` an.
- Ältere HAProxy-Abbilder scheitern an QUIC-Zeilen der Grundkonfiguration.
- WAF-Alarme tragen die Domain (`target_fqdn`), Log-Szenarien das Backend (`target_backend`).

## Dev-Stack (`docker-compose.dev.yml`)

- Wird `hapm` neu gebaut: `up -d --force-recreate haproxy crowdsec-bouncer`.
- Der Dev-CrowdSec kopiert beim Start Quellen, `parsers/s02-enrich/hapm-*.yaml`, `appsec-configs/hapm-*.yaml` und Schlüssel aus dem Volume. Sein Datenordner ist ein eigenes Volume: was HAPM nach `crowdsec/data/` schreibt (CRS-Plugins), kommt im Dev-Stack nicht an.
- Anfragen durch HAProxy: `docker exec hapm-dev curl -sk --resolve hapm.invalid:443:127.0.0.1 https://hapm.invalid/.env`.

## MCP der Produktion abfragen, wenn die Werkzeugliste der Session alt ist

Per JSON-RPC an dieselbe URL mit den Kopfzeilen aus `~/.claude.json` (`mcpServers.hapm`): `initialize`, `initialized`, dann `tools/call`. Token nicht ausgeben.

## Lokal ansehen

- Mit `HAPM_CROWDSEC_CONTAINER=hapm-dev-crowdsec`, `HAPM_CROWDSEC_BOUNCER_CONTAINER=hapm-dev-crowdsec-bouncer`, `HAPM_CROWDSEC_DIR=<Temp>` in einer vorübergehenden `.env.local` zeigt die Seite echte Daten aus dem Dev-Stack.
- Für feste Daten eine Wegwerf-Seite unter `app/(app)/zz-…/page.tsx` mit gemocktem `window.fetch` (für `/api/crowdsec/rules` braucht jede App `services`). Ein Formular eines Ziels lässt sich dort mit einem von Hand gebauten `ProxyRow` (`parseHaproxyConfig`/`parseScopes` auf `addService(renderBaseConfig(…))`, `crowdsecInStack: true`) öffnen. Nie committen.
- **Zweiter Dev-Server aus einem Git-Worktree:** `HAPM_DATA_DIR=<Hauptordner>\.data` und `DATABASE_URL` der Test-DB setzen, dann gilt die Anmeldung des Haupt-Dev-Servers auch dort (gleiche Geheimnisse, Cookies hängen nicht am Port). Next legt dabei `AGENTS.md` an: löschen. Beim Beenden per TaskStop bleibt `next dev` am Port hängen, den Prozess über den Port beenden.
