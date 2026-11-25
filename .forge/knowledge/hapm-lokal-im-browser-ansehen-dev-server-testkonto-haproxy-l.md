---
title: "HAPM lokal im Browser ansehen (Dev-Server, Testkonto, HAProxy-Log, Karten ohne haproxy.cfg)"
summary: "Wie man HAPM-Seiten ohne Docker lokal per Vorschau prüft: Test-DB starten, Konto im Assistenten anlegen, Testdaten per psql, HAProxy-Log simulieren, Komponenten und ganze Seiten ohne haproxy.cfg über eine Wegwerf-Seite mit gemocktem fetch ansehen."
tags: ["dev-umgebung","vorschau","ablauf","stolperfalle"]
updated: "2026-11-25T18:04:37.824Z"
---

# HAPM lokal im Browser ansehen (Dev-Server, Testkonto, HAProxy-Log)

## Ablauf

1. Der Dev-Server bricht ohne Datenbank nach 60 s ab (wartet auf den Unix-Socket `/var/run/postgresql`). Erst die FORGE-Test-DB starten (`dev_control database start`), dann den Dev-Server (neu) starten: `DATABASE_URL` gewinnt in `lib/db/postgres-driver.ts` über den Socket. Gilt unter macOS und Windows.
2. Frische DB: `/setup` öffnen, Schritt 1 (Konto) ausfüllen (Passwort mind. 10 Zeichen, Groß/klein, Zahl), dann im zweiten Schritt „Später fertig machen" klicken. Danach ist man angemeldet und landet auf `/dashboard`. Per preview_interact: `input >> nth=0..3` tippen, `button:has-text("Konto anlegen")`, dann `text=Später`. Gibt dev_environment noch keine Adresse aus, die `url` direkt angeben (Worktree: `http://localhost:4100`).
3. Testdaten direkt per `psql <DATABASE_URL>`: jede Collection ist eine Tabelle `(id text, created_at, updated_at, data jsonb)`, z. B. `insert into haproxy_runs ... data = '{"action":"create","serviceId":..., "status":"success", "startedAt": ..., "steps":"[]"}'`.

## Seiten und Komponenten ohne haproxy.cfg ansehen

Lokal gibt es kein `/etc/haproxy/haproxy.cfg`, kein acme.sh und keine Umgebungsvariable, die den Pfad umbiegt. Alles, was die Datei liest, zeigt nur den Fehlerzustand („… ist nicht lesbar"). Weg: eine **Wegwerf-Seite** `app/(app)/zz-preview/page.tsx` anlegen (Client-Komponente, liegt unter dem AppShell-Layout, also nach Anmeldung erreichbar). Sie existiert im Repo absichtlich nicht: nach dem Prüfen löschen, nie committen.

- **Ganze Seite, die selbst lädt** (z. B. `/reverse-proxy/zertifikate`): in der Wegwerf-Seite den Default-Export importieren (`import Page from '../reverse-proxy/zertifikate/page'`) und rendern, auf Modulebene `window.fetch` umhängen und für die Route `{ success: true, data: … }` liefern, auch für DELETE/POST (Zustand in einer Modulvariable, dann sieht man nach `load()` das Ergebnis). Ein Fehlschlag lässt sich mit `{ success: false, error: '…' }` für einen bestimmten Parameter nachstellen.
- **Komponente mit Props** (z. B. `ServiceCard`, `ServiceFormModal`): Beispiel-Konfiguration mit `renderBaseConfig`/`addService` bauen, `parseHaproxyConfig`/`parseScopes` darauf rufen, ein `ProxyRow` von Hand füllen (`version`, `acmeReady: true`, `exposure: 'public'`, `certificateSource: 'acme'`, `scopes`, `services`, Rest leer).
- **Komponente, die selbst lädt** (z. B. `BaseConfigPanel`, `GeoipPanel`): wie bei der ganzen Seite `window.fetch` umhängen. `apiFetch` geht über `window.fetch`, so laufen Toggle, `useConfirm` und Toast echt durch. Die reinen Module (`lib/haproxy/config.ts`, `base-config-diff.ts`, `certs.ts`) laufen auch im Browser und rechnen die Antwort.

## Stolperfallen

- **preview_interact-Selektoren:** `button:text-is(...)` ist ungültig, und `.modal button` findet den Knopf des Bestätigungsdialogs nicht. Genau treffen mit `xpath=//button[normalize-space(.)='Übernehmen']`. Ein Knopf in einer Tabellenzeile: `xpath=//tr[.//code[text()='alt.example']]//button` (`tr:has-text(...) button[aria-label=...]` fand nichts).
- **preview_* merkt sich die Fensterhöhe** des letzten Aufrufs. Wer einen Sprung zu `#anker` prüfen will, muss `height` klein setzen, sonst passt die Seite ins Fenster und es gibt nichts zu scrollen.
- **React Strict Mode lädt doppelt:** ein `useEffect` mit `setTimeout` und Merker („schon gescrollt") darf den Merker erst im Timeout setzen, sonst räumt das zweite Rendern den Timer weg und es passiert nie.
- **`.hapm-form-actions` bricht um** (`flex-wrap: wrap`): zwei Icon-Knöpfe in einer schmalen Tabellenspalte stehen sonst untereinander. In der Zelle `style={{ flexWrap: 'nowrap' }}` setzen.
- **Kein Mitschnitt unter macOS/Windows:** `startLogFollower()` (`lib/haproxy-log.ts`) läuft nur unter Linux, und `/var/log/haproxy/haproxy.log` gibt es lokal nicht. Der Reiter „HAProxy-Log" unter `/reverse-proxy/logs` zeigt deshalb lokal nur den Leerzustand. Zum Ansehen der Tabelle kurzzeitig `HAPROXY_LOG_FILE` auf eine Datei in `/tmp` umbiegen (Zeilen im Format `2026-11-25T08:00:00Z haproxy: <text>`) und danach zurücksetzen, nicht committen.
- **`td data-label` hat kein globales CSS.** Das Dashboard setzt die Attribute, aber eine Kartenansicht für Mobilgeräte gibt es nur in `app/logs.css` (Container-Abfrage, Raster mit Etikett aus `attr(data-label)`). Wer sie anderswo braucht, kann das Muster von dort übernehmen.
- Eigene Stylesheets einer Seite muss `tests/ui/css-classes.test.ts` kennen: Liste `PAGE_CSS` ergänzen.
- `react-hooks/set-state-in-effect` ist in `eslint.config.mjs` nur für `app/**/page.tsx` aus. Ausgelagerte Ansichten (z. B. `RunsView.tsx`) brauchen beim `load()` im `useEffect` ein `eslint-disable-next-line` mit Grund.
- Lokal kein Docker: `pnpm haproxy:verify-pages` und `pnpm haproxy:verify-tls` brechen mit „Docker ist nicht erreichbar" ab.
- **Windows:** Tests aus Git Bash starten (`"C:/Program Files/Git/bin/bash.exe" -lc "cd … && pnpm vitest run tests/haproxy"`), sonst fehlt die echte Bash. Die meisten Quelldateien haben CRLF: Ersetzungen per Skript müssen `\r\n` beachten.
