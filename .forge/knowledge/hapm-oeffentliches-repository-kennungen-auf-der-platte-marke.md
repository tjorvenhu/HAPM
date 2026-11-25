---
title: "HAPM: öffentliches Repository (Kennungen auf der Platte, Marke, Veröffentlichung über GHCR und install.sh)"
summary: "Was im öffentlichen Repository nicht stehen darf, welche Kennungen in haproxy.cfg und auf der Platte feststehen, woraus das Logo besteht und wie Abbild und Installation entstehen."
tags: ["entscheidung","build","ui","veröffentlichung"]
updated: "2026-11-25T17:48:09.784Z"
---

Stand 2026-11-25. HAPM ist ein öffentliches Werkzeug (github.com/tjorvenhu/HAPM, Abbild ghcr.io/tjorvenhu/hapm). `.forge/knowledge` wird mit eingecheckt.

## Was nicht ins Repository gehört (auch nicht in `.forge/knowledge`)
- Keine Namen von Vorgängerprojekten, Firmen, Paketen, aus denen Code stammt, oder Kunden. Kommentare und Doku begründen den Code aus sich selbst.
- Keine persönlichen Angaben: keine echten Domains, IPs, Servernamen, Mailadressen, lokalen Pfade mit Benutzernamen. In Beispielen `example.org`/`example.com`/`example.net`, `10.0.0.x`, `<repo>`.
- `ui/` und `lib/auth/core/` sind Code von HAPM: keine Abhängigkeit, kein `vendor/`, kein Token zum Bauen.

## Kennungen, die feststehen
- In `haproxy.cfg` und auf der Platte: Cookie `HAPMSRV`, `hapm_lock_<id>` und Feld `hapm_lock_password`, `/etc/haproxy/hapm-lock`, `.hapm-original`/`.hapm-previous`, `haproxy.cfg.hapm-new`, `.hapm-removing`. Nie umbenennen: bestehende Konfigurationen hängen daran. Passwortsperren mit anderem Präfix erkennt HAPM nicht, sie sind dann nur lesbar.
- Im Code: `createAuth`/`AuthInstance`/`AuthOptions`, `HAPM_SEP`, `HAPM_STDIN_EOF`, Token-Präfix `hapm_`, `MailSender` (der Fuß der Mails nennt die Installation, keine Firma).
- Testdaten: reservierte Domains (`example.org`, `example.net`), Gruppe `INTERN`/`KUNDEN`.

## Marke
Logo-Vorlage `assets/brand/hapm-logo-original.png`. Daraus nachgezeichnet (mit `sharp` und `potrace` in einem Wegwerf-Ordner): `public/hapm-logo.svg`, `-white.svg`, `hapm-mark.svg`, Favicons, `public/email/hapm-logo*.png` (284 x 56). Im Code: `ui/primitives/Logo.tsx`, `ui/static/logo.ts` (Text für Fehlerseiten, `tests/ui/static-logo.test.ts` vergleicht), `ui/mail/layout.ts`. Farben: `#044b39`, `#35826a`, Schrift `#042d20`. Das Logo steht mittig über der Seitenleiste, die Anmeldeseite zeigt nur das Logo.

## Veröffentlichung und Installation
- `.github/workflows/image.yml`: Push auf `main` prüft (mit Postgres als Dienst) und baut `ghcr.io/tjorvenhu/hapm:latest` für amd64 und arm64, ein Tag `v*` zusätzlich die Versionsnummern. Ein neues GHCR-Paket ist zuerst privat und muss einmal auf „Public" gestellt werden.
- `install.sh`: installiert Docker (Debian, Ubuntu), holt `docker-compose.yml` nach `/opt/hapm`, startet. Einzelheiten im Eintrag zu Datenordner und install.sh.
- Eine frische Installation hat KEINE Gruppe. Die Oberfläche fordert dazu auf, eine anzulegen (`firstScopeAnchor` in `lib/haproxy/config.ts`).
- Offen (Stand dieses Eintrags): eine Lizenz ist noch nicht gewählt, es gibt keine `LICENSE`.
