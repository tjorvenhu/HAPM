---
title: "MCP-Endpunkt /api/mcp und interne API lokal testen (Service-Token per psql oder Node, curl, SDK-Client)"
summary: "Wie man den MCP-Server und /api/internal von HAPM ohne Docker gegen den Dev-Server prüft: Token direkt in service_tokens anlegen (psql oder unter Windows per Node-Skript), nötige Kopfzeilen, was ohne HAProxy und Docker geht."
tags: ["mcp","tests","dev-umgebung","ablauf"]
updated: "2026-11-25T20:22:52.408Z"
---

# MCP-Endpunkt /api/mcp und interne API lokal testen

## Token ohne Oberfläche anlegen

Gespeichert wird nur der SHA-256 des Klartexts (`lib/service-auth.ts`). Direkt in die FORGE-Testdatenbank:

```bash
TOKEN=hapm_localtest...   # beliebig, muss mit hapm_ beginnen
HASH=$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
psql "$DATABASE_URL" -c "insert into service_tokens (id, created_at, updated_at, data) values ('mcptest1', now(), now(), '{\"name\":\"mcp-test\",\"prefix\":\"hapm_localte\",\"tokenHash\":\"$HASH\",\"allowedIps\":[],\"revokedAt\":null}'::jsonb)"
```

Stolperfalle: `created_at`/`updated_at` sind NOT NULL ohne Vorgabe, ein Insert nur mit `id, data` scheitert.

Unter Windows gibt es meist kein `psql`: ein kurzes `.mjs` im Projektordner (damit `postgres` aufgelöst wird) mit `postgres(process.env.DB_URL)`, `createHash('sha256')` und `sql.json({...})` für `data`. Darin auch gleich die Aufrufe per `fetch`, am Ende Zeile und Skript löschen. Die Tabellen gibt es erst, wenn der Dev-Server einmal angefragt wurde (`/api/health`). Erst `dev_control database start`, dann den Dev-Server neu starten, sonst wartet er auf den Socket `/var/run/postgresql` und beendet sich nach 60 s.

## Aufruf

- POST braucht `accept: application/json, text/event-stream` (sonst 406 vom SDK-Transport) und `content-type: application/json`.
- Zustandslos: `tools/list` und `tools/call` gehen ohne vorheriges `initialize` und ohne `Mcp-Session-Id`.
- GET/DELETE antworten mit 405, 401 trägt `WWW-Authenticate: Bearer realm="HAPM"`.
- Meldungen ohne `Accept-Language` englisch (`lib/mcp/locale.ts`).
- Antworten der internen API sind `{ success, data }` (`ok()` in `lib/api.ts`), auch in Routen-Tests.

## Was ohne HAProxy und Docker geht

Lokal gibt es kein `/etc/haproxy` und keinen Docker-Socket: `get_proxy` liefert `error`, schreibende Reverse-Proxy-Werkzeuge scheitern an der Vorabprüfung. Gegen die Datenbank laufen: `list_runs`, `get_traffic_stats`, `list_dns_zones`, `get_run`/`get_update_run` (404), `get_settings`, `update_settings` (Audit trägt den Token-Namen), `get_backup` (`available: false`), `get_updates` (Fehler „Docker-Socket nicht erreichbar" je Bestandteil), `get_geoip`, `get_haproxy_log` (`exists: false`). Ein echter Lauf mit Zertifikat, Reload oder Update nur im Stack.

## In Tests

`getClientIP` (`lib/audit.ts`) liest `x-forwarded-for` (rechtester Eintrag), nicht `x-real-ip`. Ein Test, der den Actor samt IP prüft, setzt also `x-forwarded-for`.

`pnpm test` unter Windows: `tests/acme-server.test.ts` (registerAccountScript) und `tests/backup/restore.test.ts` (RESTORE_SCRIPT) scheitern dort an `bash -c 'sh' …`, unabhängig von Änderungen an der API.
