---
title: "HAPM: öffentliches Repository ohne Vanturis-Bezug (Herkunft, Marke, umbenannte Kennungen, Veröffentlichung)"
summary: "HAPM wird öffentlich und trägt im Repository keinen Verweis mehr auf Vanturis. Woher der Code trotzdem stammt, was umbenannt wurde und wie Abbild und Installation entstehen."
tags: ["entscheidung","build","ui","auth","veröffentlichung"]
updated: "2026-11-24T17:07:37.641Z"
---

Stand 2026-11-24. Entscheidung des Nutzers: HAPM ist sein eigenes, öffentliches Werkzeug (github.com/tjorvenhu/HAPM, Abbild ghcr.io/tjorvenhu/hapm). Das Repository soll keinen Verweis auf Vanturis enthalten. Dieser Eintrag ist die einzige Stelle, an der die Herkunft steht: `.forge/` und `.claude/` stehen in `.gitignore`.

## Herkunft (steht nicht mehr im Repository)
- `lib/haproxy/`, `components/reverse-proxy/`, die Reverse-Proxy-Seiten und -Routen, `lib/dns/`, `lib/geoip/` stammen aus `internal-manager` (VSM).
- `ui/` stammt aus `@vanturis/ui` 0.10.2 (`tool`, `shell`, `primitives`, `charts`, `auth`, `mail`, `static`, die Stylesheets hinter `tool.css`), `lib/auth/core/` aus `@vanturis/auth` 0.7.0. Beides ist jetzt schlicht Code von HAPM: keine Abhängigkeit, kein `vendor/`, kein Token zum Bauen. Wer dort etwas nachziehen will, vergleicht von Hand.
- Im Repository gilt die Regel: Kommentare und Doku begründen den Code, ohne Vorgänger, Pakete oder Firmennamen zu nennen. Ein Suchlauf nach `vanturis|VSM|internal-manager` und nach Kundennamen muss leer bleiben.

## Was umbenannt wurde (weicht vom VSM ab, beim Nachziehen beachten)
- In `haproxy.cfg` und auf der Platte: Cookie `HAPMSRV` (war `VSMSRV`), `hapm_lock_<id>` und Feld `hapm_lock_password` (war `vsm_lock_`), `/etc/haproxy/hapm-lock` (war `vsm-lock`), `.hapm-original`/`.hapm-previous`, `haproxy.cfg.hapm-new`, `.hapm-removing`.
- Im Code: `createAuth`/`AuthInstance`/`AuthOptions` (war `createVanturisAuth` …), `HAPM_SEP`, `HAPM_STDIN_EOF`, Token-Präfix `hapm_` (war `vsk_`), `MailSender` statt `MailOperator` (der Fuß der Mails nennt die Installation, keine Firma).
- Die Gruppen-Aliase (`SCOPE_ALIASES`) gibt es nicht mehr. Eine Konfiguration aus dem VSM lässt sich deshalb nicht unverändert übernehmen: Passwortsperren und Sitzungsbindung dort wären „nur lesbar".
- Testdaten: reservierte Domains (`example.org`, `example.net`), Gruppe `INTERN`/`KUNDEN`.
- Unbenutztes aus dem Vorgänger ist entfernt (einige Bausteine unter `ui/primitives`, Prüfungen in `lib/validation.ts`).

## Marke
Logo-Vorlage `assets/brand/hapm-logo-original.png` (vom Nutzer). Daraus nachgezeichnet (mit `sharp` und `potrace` in einem Wegwerf-Ordner): `public/hapm-logo.svg`, `-white.svg`, `hapm-mark.svg`, Favicons, `public/email/hapm-logo*.png` (284 x 56). Im Code: `ui/primitives/Logo.tsx`, `ui/static/logo.ts` (Text für Fehlerseiten, `tests/ui/static-logo.test.ts` vergleicht), `ui/mail/layout.ts`. Farben: `#044b39`, `#35826a`, Schrift `#042d20`. Das Logo steht mittig über der Seitenleiste, die Anmeldeseite zeigt nur das Logo.

## Veröffentlichung und Installation
- `.github/workflows/image.yml`: Push auf `main` prüft (mit Postgres als Dienst) und baut `ghcr.io/tjorvenhu/hapm:latest` für amd64 und arm64, ein Tag `v*` zusätzlich die Versionsnummern. Ein neues GHCR-Paket ist zuerst privat und muss einmal auf „Public" gestellt werden.
- `install.sh`: installiert Docker (Debian, Ubuntu), holt `docker-compose.yml` nach `/opt/hapm`, startet. Variablen `HAPM_DIR`, `HAPM_PORT`, `HAPM_IMAGE`, `HAPM_SOURCE` (auch `file:///…`), `HAPM_FORCE`. Geprüft in einem Debian-13-Container gegen die Docker-Engine des Rechners, inklusive zweitem Lauf.
- Eine frische Installation hat KEINE Gruppe. Die Oberfläche fordert dazu auf, eine anzulegen (`firstScopeAnchor` in `lib/haproxy/config.ts`).
- Offen (Stand dieses Eintrags): die Lizenz des Projekts hat der Nutzer noch nicht gewählt, es gibt keine `LICENSE`.
