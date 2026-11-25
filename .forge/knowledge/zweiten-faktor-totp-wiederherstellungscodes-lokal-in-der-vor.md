---
title: "Zweiten Faktor (TOTP, Wiederherstellungscodes) lokal in der Vorschau durchspielen"
summary: "Wie man Einrichtung und Anmeldung mit TOTP-Code oder Wiederherstellungscode im Dev-Server prüft, ohne Handy und ohne psql (Windows)."
tags: ["dev-umgebung","vorschau","ablauf","tests"]
updated: "2026-11-25T18:18:24.956Z"
---

# Zweiten Faktor lokal in der Vorschau durchspielen

Voraussetzung: Test-DB und Dev-Server laufen, Konto über `/setup` angelegt (siehe Eintrag „HAPM lokal im Browser ansehen“).

## TOTP-Code ohne Handy

Das Geheimnis liegt AES-GCM-verschlüsselt in `two_factor.data.secret`; der Schlüssel ist `sha256(encryptionKey)` (`lib/crypto.ts`), und `encryptionKey` steht im Dev-Server in `<worktree>/.data/secrets.json` (`lib/paths.ts`: ohne `HAPM_DATA_DIR` und außerhalb von production `.data/` im Arbeitsordner).

Kleines Skript **außerhalb des Repos** (z. B. `$TEMP/hapm-totp/totp.mjs`), das `postgres` und `otpauth` per `createRequire(<worktree>/package.json)` aus dem Projekt lädt, die Zeile liest, entschlüsselt und `new OTPAuth.TOTP({ algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).generate()` ausgibt. Ablauf: in der Vorschau „Einrichten“ → „Einrichtung starten“ → „Weiter“, dann das Skript laufen lassen und den Code in `.two-factor-code-input` tippen (30-s-Fenster, ±1 Schritt wird akzeptiert).

## Wiederherstellungscodes

- Die Codes stehen nur einmal im Dialog; aus dem Screenshot ablesen (Alphabet ohne 0/o/1/l/i, gut lesbar). In der DB stehen nur HMACs.
- Anmeldung: Abmelden über das Menü unten links (Name anklicken → „Abmelden“), dann `#email`, `#password`, `button.auth-submit`, auf `#twoFactorCode` warten, „Wiederherstellungscode verwenden“, `#recoveryCode`. Groß/klein und Leerzeichen sind egal.
- Altbestand ohne Codes nachstellen: `update two_factor set data = data - 'recoveryCodes' - 'recoveryCodesCreatedAt'`.

## Stolperfallen

- **Kein `psql` unter Windows** (Git Bash). Statt dessen `node -e` mit `require('postgres')` aus dem Worktree und der URL aus `dev_environment`. Die Audit-Tabelle heißt `audit_logs` (Plural).
- Die Test-DB kann nach `dev_control database start` einen **anderen Port** haben als `dev_environment` vorher zeigte: die URL aus der Antwort von `dev_control` nehmen.
- `preview_*` mit anderer `height` lädt die Seite neu: ein offener Dialog ist dann weg.
