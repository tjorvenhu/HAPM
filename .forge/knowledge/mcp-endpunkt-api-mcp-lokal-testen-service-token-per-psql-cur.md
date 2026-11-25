---
title: "MCP-Endpunkt /api/mcp lokal testen (Service-Token per psql, curl, SDK-Client)"
summary: "Wie man den MCP-Server von HAPM ohne Docker gegen den Dev-Server prüft: Token direkt in service_tokens anlegen, nötige Kopfzeilen, was ohne HAProxy geht."
tags: ["mcp","tests","dev-umgebung","ablauf"]
updated: "2026-11-25T08:46:19.832Z"
---

## Token ohne Oberfläche anlegen

Gespeichert wird nur der SHA-256 des Klartexts (`lib/service-auth.ts`). Direkt in die FORGE-Testdatenbank:

```bash
TOKEN=hapm_localtest...   # beliebig, muss mit hapm_ beginnen
HASH=$(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)
psql "$DATABASE_URL" -c "insert into service_tokens (id, created_at, updated_at, data) values ('mcptest1', now(), now(), '{\"name\":\"mcp-test\",\"prefix\":\"hapm_localte\",\"tokenHash\":\"$HASH\",\"allowedIps\":[],\"revokedAt\":null}'::jsonb)"
```

Stolperfalle: `created_at`/`updated_at` sind NOT NULL ohne Vorgabe, ein Insert nur mit `id, data` scheitert.

## Aufruf

- POST braucht `accept: application/json, text/event-stream` (sonst 406 vom SDK-Transport) und `content-type: application/json`.
- Zustandslos: `tools/list` und `tools/call` gehen ohne vorheriges `initialize` und ohne `Mcp-Session-Id`.
- GET/DELETE antworten mit 405, 401 trägt `WWW-Authenticate: Bearer realm="HAPM"`.
- Meldungen ohne `Accept-Language` englisch (`lib/mcp/locale.ts`).
- Gegenprobe mit dem offiziellen Client: ein kurzes `.mjs` im Projektordner (wegen der Auflösung von `@modelcontextprotocol/sdk`) mit `StreamableHTTPClientTransport` und `requestInit.headers.Authorization`, danach löschen.

## Was ohne HAProxy geht

Lokal gibt es kein `/etc/haproxy`: `get_proxy` liefert `error`, schreibende Werkzeuge scheitern an der Vorabprüfung (z. B. „haproxy.cfg is not readable"). Damit lässt sich die Fehlerform prüfen, ein echter Lauf mit Zertifikat und Reload nur im Stack. `list_runs`, `get_traffic_stats`, `list_dns_zones` und `get_run` (404) laufen gegen die Datenbank.

## In Tests

`getClientIP` (`lib/audit.ts`) liest `x-forwarded-for` (rechtester Eintrag), nicht `x-real-ip`. Ein Test, der den Actor samt IP prüft, setzt also `x-forwarded-for`.
