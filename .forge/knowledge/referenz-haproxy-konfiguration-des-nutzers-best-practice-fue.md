---
title: "Referenz-HAProxy-Konfiguration des Nutzers (Best Practice für alle enthaltenen Fälle)"
summary: "Die produktive haproxy.cfg des Nutzers als Vorgabe für die Standardwerte von HAPM: Grundaufbau, TLS, Header, Healthchecks, Sperren, Wildcards, Pfad-Regeln, Weiterleitung. Vor Änderungen an base-config.ts, config.ts oder dem Import danach richten."
tags: ["haproxy","konvention","reverse-proxy","referenz"]
updated: "2026-11-25T17:22:05.481Z"
---

Der Nutzer betreibt eine ausgearbeitete haproxy.cfg produktiv und hat sie am 2026-11-25 als Vorgabe gesetzt: „generell die Einstellungen meiner config sollen so die Standard/Default Sachen von HAPM sein. Das sind ja die besten Einstellungen für die große Menge der Nutzer.“

**Wie nutzen:** Bei Änderungen an `lib/haproxy/base-config.ts` (Grundkonfiguration), an dem, was `lib/haproxy/config.ts` schreibt (Dienst-Blöcke, ACLs, Backends, Sperren, Healthcheck, Pfad-Regeln, Weiterleitungen) und am Import (`lib/haproxy/import.ts`) zuerst hier nachsehen. Weicht HAPM für einen Fall ab, der hier vorkommt, ist das entweder begründet (Tabelle unten) oder ein Fehler.

Geprüft am 2026-11-25: Die Blöcke, die `config.ts` für Dienst mit Healthcheck, Sperre auf Admin-IPs, Teilsperre (`lock_<id>`) und Wildcard schreibt, gleichen der Datei Zeichen für Zeichen.

**Datenschutz:** Das Repo ist öffentlich und `.forge/` wird mit eingecheckt. Domains, IPs, Servernamen und Gruppen der echten Datei stehen hier deshalb nur als Platzhalter (`example.com`, `10.0.0.x`). Nie die echte Datei hier einfügen.

## Grundaufbau

`global`, `defaults`, `frontend public_http` und `frontend public_https` entsprechen `renderBaseConfig` in `base-config.ts` (Cipher, `ssl-default-bind-options ssl-min-ver TLSv1.2 no-tls-tickets`, Timeouts, `errorfile` je Status unter `/etc/haproxy/errors/`, HTTP→HTTPS mit ACME-Ausnahme, `strict-sni`, `alt-svc` für HTTP/3, die Header unter `# Globale HTTPS-Settings`, `default_backend default_404`). Nur diese Abweichungen:

| Zeile | Nutzer | HAPM `base-config.ts` | Bewertung |
|---|---|---|---|
| `limited-quic` (global) | vorhanden | seit 2026-11-25 auch bei HAPM | Laut Handbuch (`limited-quic`): schaltet QUIC-Listener frei, wenn die TLS-Bibliothek keine QUIC-API hat, sonst wirkungslos. Bestehende `haproxy.cfg` bekommen die Zeile nur über den Abgleich der Grundkonfiguration. |
| `daemon` (global) | vorhanden | fehlt | **Absicht bei HAPM**, vom Nutzer bestätigt: im Container läuft HAProxy im Vordergrund (master-worker mit `-S`). Nicht übernehmen. |
| `log stdout format short daemon` | short | `raw local0 info` | **Absicht bei HAPM:** `lib/haproxy-log.ts` schreibt das Log mit und setzt den Kopf selbst, `short` brächte ein `<PRI>` vor jede Zeile. |
| Sperre per Passwort | `vsm_lock_…`, `/etc/haproxy/vsm-lock/` | `hapm_lock_…`, `/etc/haproxy/hapm-lock/` | Alter Name aus einem Vorgänger, Aufbau der Regeln identisch. Kennungen auf der Platte nie umbenennen (CLAUDE.md). |
| IPv6-Binds | keine | nur mit Option `ipv6` | passt |

Im HTTPS-Frontend steht `acl admin_ips src …` unter `# Admin-IPs` direkt vor `# Globale HTTPS-Settings`.

## Fälle, die als Vorbild gelten

- **Einfacher Dienst mit Healthcheck:** `option httpchk`, `http-check send meth GET uri / ver HTTP/1.1 hdr Host <hauptdomain>`, `http-check expect status 200-399`, Leerzeile, `server <name> <ip>:<port> check`.
- **Dienst ohne Healthcheck** (Wildcard-Dienste, Sammeldienste): nur `server …` ohne `check`.
- **Sperre auf Admin-IPs:** `http-request deny deny_status 403 if host_<id> !admin_ips`. Nur einzelne Domains gesperrt: eigene ACL `lock_<id>` mit genau diesen Domains.
- **Wildcards:** `acl host_<id> hdr(host),lower -m end -i .<basis>` (führender Punkt).
- **Zusätzliche Antwort-Header je Dienst** (z. B. Nextcloud): `http-response set-header X-Robots-Tag "noindex,nofollow"` und `X-Permitted-Cross-Domain-Policies "none"` vor dem Healthcheck.
- **Pfad-Regeln mit WebSocket** (z. B. Coolify): eigene Backends `<id>_<regel>`, `acl path_<id>_<regel> path_beg …`, `use_backend` der Regeln vor dem des Dienstes, `timeout tunnel 1h` in jedem Backend des Eintrags, Pfad-Backends mit `check` ohne `option httpchk`.
- **HTTP-Weiterleitung:** Backend nur mit `http-request redirect location <url> code 302`.
- **Passwortsperre:** `stick-table type ipv6 size 10k expire 10m store http_req_rate(10m)` im Backend, im Frontend `track-sc2`, Drosselung mit 429 ab mehr als 10 POST, `wait-for-body`, Cookie-Prüfung über `sha2(256)` eines gesalzenen Passworts, Seiten aus Dateien (`lock.html`, `lock-wrong.html`, `lock-throttled.html`). Die Zeilen schreibt `passwordLockRules` in `config.ts` genau so.
- **Gruppen:** `# BEGIN AUTO <GRUPPE> SERVICES` / `… BACKENDS`, je Eintrag `# AUTO: <id>`. Mehrere Gruppen nebeneinander, Backends einer Gruppe unter einer Kommentar-Überschrift.
- **Backend-Ziele:** HTTP auf `:80` oder App-Port, Servername frei (z. B. `vps-internal`, `coolify-ui`, `server1`).

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

    # BEGIN AUTO TEST SERVICES

    # AUTO: websites_test
    acl host_websites_test hdr(host),lower -m end -i .test.example.com
    acl pass_websites_test req.cook(vsm_lock_websites_test) -m str <COOKIE_HASH>
    http-request track-sc2 src table websites_test if host_websites_test !pass_websites_test METH_POST
    http-request return status 429 content-type "text/html; charset=utf-8" hdr Cache-Control no-store file /etc/haproxy/vsm-lock/lock-throttled.html if host_websites_test !pass_websites_test METH_POST { sc_http_req_rate(2,websites_test) gt 10 }
    http-request wait-for-body time 5s at-least 4k if host_websites_test !pass_websites_test METH_POST
    http-request return status 303 hdr Location https://%[req.hdr(host)]%[pathq] hdr Cache-Control no-store hdr Set-Cookie "vsm_lock_websites_test=<COOKIE_HASH>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax" if host_websites_test !pass_websites_test METH_POST { req.body_param(vsm_lock_password),url_dec(1),concat(<SALT>),sha2(256),hex,lower -m str <PASSWORD_HASH> }
    http-request return status 401 content-type "text/html; charset=utf-8" hdr Cache-Control no-store file /etc/haproxy/vsm-lock/lock-wrong.html if host_websites_test !pass_websites_test METH_POST
    http-request return status 401 content-type "text/html; charset=utf-8" hdr Cache-Control no-store file /etc/haproxy/vsm-lock/lock.html if host_websites_test !pass_websites_test
    use_backend websites_test if host_websites_test
    # END AUTO TEST SERVICES

# BEGIN AUTO APPS BACKENDS
# AUTO: paperless_app
backend paperless_app
    option httpchk
    http-check send meth GET uri / ver HTTP/1.1 hdr Host paperless.example.com
    http-check expect status 200-399

    server vps-internal 10.0.0.3:8084 check

# AUTO: nextcloud_app
backend nextcloud_app
    http-response set-header X-Robots-Tag "noindex,nofollow"
    http-response set-header X-Permitted-Cross-Domain-Policies "none"

    option httpchk
    http-check send meth GET uri / ver HTTP/1.1 hdr Host cloud.example.com
    http-check expect status 200-399

    server vps-internal 10.0.0.3:80 check

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
    server vps-internal 10.0.0.3:80

# AUTO: redirect_mail
backend redirect_mail
    http-request redirect location https://webmail.example.net/ code 302
# END AUTO APPS BACKENDS

# BEGIN AUTO TEST BACKENDS
# AUTO: websites_test
backend websites_test
    stick-table type ipv6 size 10k expire 10m store http_req_rate(10m)

    server vps-managed 10.0.0.4:80
# END AUTO TEST BACKENDS
```
