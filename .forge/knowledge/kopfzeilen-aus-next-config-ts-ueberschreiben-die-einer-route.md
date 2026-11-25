---
title: "Kopfzeilen aus next.config.ts überschreiben die einer Route (CSP), Route per curl testen"
summary: "Warum eine Route ihre eigene Content-Security-Policy nicht setzen kann und wie man geschützte Routen lokal per curl mit Sitzung und CSRF aufruft."
tags: ["stolperfalle","tests","dev-umgebung","ablauf"]
updated: "2026-11-25T11:32:11.739Z"
---

## CSP einer Route wird überschrieben

`next.config.ts` setzt unter `headers()` für `/(.*)` u. a. `Content-Security-Policy`. Next legt diese Regeln **über** die Antwort einer Route: setzt ein Route-Handler selbst `Content-Security-Policy`, kommt beim Browser trotzdem die allgemeine an (geprüft mit `curl -D -`, Next 16).

Lösung: eine zweite Regel in `next.config.ts` **nach** der allgemeinen, mit engerem `source` (bei gleichem Schlüssel gewinnt die spätere). Beispiel: `/api/branding/:path(logo/.*|favicon)` mit `sandbox`-CSP für hochgeladene SVGs (`lib/branding/response.ts`). Änderungen an `next.config.ts` brauchen einen Neustart des Dev-Servers.

## Geschützte Route lokal per curl

```bash
B=http://localhost:<port>
curl -s -c jar -b jar -X POST $B/api/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"…","password":"…"}'
CSRF=$(curl -s -b jar $B/api/auth/me | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["csrfToken"])')
curl -s -b jar -X PATCH $B/api/… -H 'Content-Type: application/json' -H "X-CSRF-Token: $CSRF" -d '…'
```

Nützlich, wenn die Vorschau etwas nicht kann, etwa eine Datei in ein `<input type="file">` legen: Bilder als Base64 direkt an die Route schicken. Die Vorschau hat danach eigene Cookies, dort separat anmelden.
