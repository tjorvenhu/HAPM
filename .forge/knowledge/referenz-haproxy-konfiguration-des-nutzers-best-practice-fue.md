---
title: "Referenz-HAProxy-Konfiguration (Best Practice für Standardwerte, Sperren, Wildcards, Pfad-Regeln)"
summary: "Eine produktiv bewährte haproxy.cfg als Vorgabe für die Standardwerte von HAPM: Grundaufbau, TLS, Header (auch X-Real-IP), Healthchecks, Sperren, Wildcards, Pfad-Regeln, Weiterleitung. Vor Änderungen an base-config.ts, config.ts oder dem Import danach richten."
tags: ["haproxy","konvention","reverse-proxy","referenz"]
updated: "2026-11-26T21:54:43.256Z"
---

Entscheidung vom 2026-11-25: Die Einstellungen einer produktiv betriebenen, ausgearbeiteten haproxy.cfg sind die Standardwerte von HAPM. Sie gelten als die besten Einstellungen für die meisten Nutzer.

**Wie nutzen:** Bei Änderungen an `lib/haproxy/base-config.ts` (Grundkonfiguration), an dem, was `lib/haproxy/config.ts` schreibt (Dienst-Blöcke, ACLs, Backends, Sperren, Healthcheck, Pfad-Regeln, Weiterleitungen) und am Import (`lib/haproxy/import.ts`) zuerst hier nachsehen. Weicht HAPM für einen Fall ab, der hier vorkommt, ist das entweder begründet (Tabelle unten) oder ein Fehler.

Geprüft am 2026-11-25: Die Blöcke, die `config.ts` für Dienst mit Healthcheck, Sperre auf Admin-IPs, Teilsperre (`lock_<id>`) und Wildcard schreibt, gleichen der Datei Zeichen für Zeichen.

**Datenschutz:** Das Repo ist öffentlich und `.forge/` wird mit eingecheckt. Domains, IPs, Servernamen und Gruppen der echten Datei stehen hier deshalb nur als Platzhalter (`example.com`, `10.0.0.x`). Nie die echte Datei hier einfügen.

## Grundaufbau
`global`, `defaults`, `frontend public_http` und `frontend public_https` entsprechen `renderBaseConfig` in `base-config.ts` (Cipher, `ssl-default-bind-options ssl-min-ver TLSv1.2 no-tls-tickets`, Timeouts, `errorfile` je Status unter `/etc/haproxy/errors/`, HTTP→HTTPS mit ACME-Ausnahme, `strict-sni`, `alt-svc` für HTTP/3, die Header unter `# Globale HTTPS-Settings`, `default_backend default_404`). Nur diese Abweichungen:

| Zeile | Referenz | HAPM `base-config.ts` | Bewertung |
|---|---|---|---|
| `limited-quic` (global) | vorhanden | seit 2026-11-25 auch bei HAPM | Laut Handbuch: schaltet QUIC-Listener frei, wenn die TLS-Bibliothek keine QUIC-API hat, sonst wirkungslos. Bestehende `haproxy.cfg` bekommen die Zeile nur über den Abgleich der Grundkonfiguration. |
| `http-request set-header X-Real-IP %[src]` (globale HTTPS-Zeilen) | fehlt | seit 2026-11-26 bei HAPM, direkt hinter `X-Forwarded-For` | **Absicht bei HAPM**, siehe unten. |
| `daemon` (global) | vorhanden | fehlt | **Absicht bei HAPM**: im Container läuft HAProxy im Vordergrund (master-worker mit `-S`). Nicht übernehmen. |
| `log stdout format short daemon` | short | `raw local0 info` | **Absicht bei HAPM:** `lib/haproxy-log.ts` schreibt das Log mit und setzt den Kopf selbst, `short` brächte ein `<PRI>` vor jede Zeile. |
| Sperre per Passwort | anderer Präfix | `hapm_lock_…`, `/etc/haproxy/hapm-lock/` | Aufbau der Regeln identisch. Kennungen auf der Platte nie umbenennen (CLAUDE.md). |
| IPv6-Binds | keine | nur mit Option `ipv6` | passt |

Im HTTPS-Frontend steht `acl admin_ips src …` unter `# Admin-IPs` direkt vor `# Globale HTTPS-Settings`.

### X-Real-IP (2026-11-26)
- Anlass: Vaultwarden meldet auf der Diagnoseseite „IP header No Match“ (seine Vorgabe ist `IP_HEADER=X-Real-IP`, HAPM schickte nur `X-Forwarded-For`).
- HAProxy setzt `X-Real-IP` nie von selbst (automatisch gibt es nur `X-Forwarded-For` über `option forwardfor`) und reicht eines vom Client unverändert durch. Ein Ziel, das die Kopfzeile liest, glaubt dann dem Aufrufer.
- Gemessen mit HAProxy 2.4, 2.8, 3.0 und lts: mit `set-header` kommt genau eine Kopfzeile mit `src` an, auch wenn der Client zwei in gemischter Schreibweise mitschickt. Ohne die Zeile kommt der gefälschte Wert an.
- **Stolperfalle:** Der Abgleich der Grundkonfiguration (`base-config-diff.ts`) schlägt Zeilen unter `# Globale HTTPS-Settings` nie vor (`managedIndexes`). Eine neue Vorgabe dort erreicht bestehende Installationen nicht. Sie tragen die Zeile unter Reverse-Proxy, Einstellungen selbst ein (oder per MCP `update_proxy_settings`).
- Je Ziel geht die Zeile nicht über die Maske: Kopfzeilen eines Ziels sind fester Text, `%[src]` würde zu `%%[src]` (`readHeaderLine`, `tests/haproxy/addons.test.ts`).
- HAPM selbst liest `X-Real-IP` nie (`getClientIP` in `lib/audit.ts`, `tests/security/client-ip.test.ts`).

## Fälle, die als Vorbild gelten
- **Einfacher Dienst mit Healthcheck:** `option httpchk`, `http-check send meth GET uri / ver HTTP/1.1 hdr Host <hauptdomain>`, `http-check expect status 200-399`, Leerzeile, `server <name> <ip>:<port> check`.
- **Dienst ohne Healthcheck** (Wildcard-Dienste, Sammeldienste): nur `server …` ohne `check`.
- **Sperre auf Admin-IPs:** `http-request deny deny_status 403 if host_<id> !admin_ips`. Nur einzelne Domains gesperrt: eigene ACL `lock_<id>` mit genau diesen Domains.
- **Wildcards:** `acl host_<id> hdr(host),lower -m end -i .<basis>` (führender Punkt).
- **Zusätzliche Antwort-Header je Dienst** (z. B. Nextcloud): `http-response set-header X-Robots-Tag "noindex,nofollow"` und `X-Permitted-Cross-Domain-Policies "none"` vor dem Healthcheck.
- **Pfad-Regeln mit WebSocket** (z. B. Coolify): eigene Backends `<id>_<regel>`, `acl path_<id>_<regel> path_beg …`, `use_backend` der Regeln vor dem des Dienstes, `timeout tunnel 1h` in jedem Backend des Eintrags, Pfad-Backends mit `check` ohne `option httpchk`.
- **HTTP-Weiterleitung:** Backend nur mit `http-request redirect location <url> code 302`.
- **Passwortsperre:** `stick-table type ipv6 size 10k expire 10m store http_req_rate(10m)` im Backend, im Frontend `track-sc2`, Drosselung mit 429 ab mehr als 10 POST, `wait-for-body`, Cookie-Prüfung über `sha2(256)` eines gesalzenen Passworts, Seiten aus Dateien (`lock.html`, `lock-wrong.html`, `lock-throttled.html`). Die Zeilen schreibt `passwordLockRules` in `config.ts` genau so, dort nachlesen.
- **Gruppen:** `# BEGIN AUTO <GRUPPE> SERVICES` / `… BACKENDS`, je Eintrag `# AUTO: <id>`. Mehrere Gruppen nebeneinander, Backends einer Gruppe unter einer Kommentar-Überschrift.
- **Backend-Ziele:** HTTP auf `:80` oder App-Port, Servername frei (z. B. `app-host`, `coolify-ui`, `server1`).

## Beispiel (Platzhalter, Aufbau wie im Original)
```
    # BEGIN AUTO APPS SERVICES
    # AUTO: paperless_app
    acl host_paperless_app hdr(host),lower -i paperless.example.com
    http-request deny deny_status 403 if host_paperless_app !admin_ips
    use_backend paperless_app if host_paperless_app
    # AUTO: manager_app
    acl host_manager_app hdr(host),lower -i manager.example.com status.example.com
    acl lock_manager_app hdr(host),lower -i manager.example.com
    http-request deny deny_status 403 if lock_manager_app !admin_ips
    use_backend manager_app if host_manager_app
    # AUTO: coolify_app
    acl host_coolify_app hdr(host),lower -i deploy.example.com
    acl path_coolify_app_terminal path_beg /terminal/ws
    acl path_coolify_app_restui path_beg /app/
    use_backend coolify_app_terminal if host_coolify_app path_coolify_app_terminal
    use_backend coolify_app_restui if host_coolify_app path_coolify_app_restui
    use_backend coolify_app if host_coolify_app
    # AUTO: api_wildcard
    acl host_api_wildcard hdr(host),lower -m end -i .api.example.com
    use_backend api_wildcard if host_api_wildcard
    # END AUTO APPS SERVICES
# BEGIN AUTO APPS BACKENDS
# AUTO: paperless_app
backend paperless_app
    option httpchk
    http-check send meth GET uri / ver HTTP/1.1 hdr Host paperless.example.com
    http-check expect status 200-399
    server app-host 10.0.0.3:8084 check
# AUTO: nextcloud_app
backend nextcloud_app
    http-response set-header X-Robots-Tag "noindex,nofollow"
    http-response set-header X-Permitted-Cross-Domain-Policies "none"
    option httpchk
    http-check send meth GET uri / ver HTTP/1.1 hdr Host cloud.example.com
    http-check expect status 200-399
    server app-host 10.0.0.3:80 check
# AUTO: coolify_app
backend coolify_app
    timeout tunnel 1h
    option httpchk
    http-check send meth GET uri / ver HTTP/1.1 hdr Host deploy.example.com
    http-check expect status 200-399
    server coolify-ui 10.0.0.5:8000 check
backend coolify_app_terminal
    timeout tunnel 1h
    server coolify-terminal 10.0.0.5:6002 check
# AUTO: api_wildcard
backend api_wildcard
    server app-host 10.0.0.3:80
# AUTO: redirect_mail
backend redirect_mail
    http-request redirect location https://webmail.example.net/ code 302
# END AUTO APPS BACKENDS
```
Eine zweite Gruppe (`TEST`) mit Passwortsperre steht im Original daneben, ihre Zeilen entsprechen `passwordLockRules`; das Backend dazu ist nur `stick-table …` und `server web-host 10.0.0.4:80`.
