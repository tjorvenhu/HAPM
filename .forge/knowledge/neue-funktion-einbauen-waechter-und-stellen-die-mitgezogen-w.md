---
title: "Neue Funktion einbauen: Wächter und Stellen, die mitgezogen werden müssen (Protokoll, Mails, Sperre, Abgleich, Health)"
summary: "Welche Tabellen, Tests und Listen eine neue Handlung, Mail, ein neuer Ordner unter /etc/haproxy oder ein neuer Schreibweg mit anfassen muss, und was beim Arbeiten mit parallelen Worktrees auffiel."
tags: ["konvention","stolperfalle","tests","entwicklung"]
updated: "2026-11-26T19:14:01.896Z"
---

# Neue Funktion einbauen: was mitgezogen werden muss

Stand November 2026, nach dem Einbau von Protokoll/SIEM, verschlüsselter Sicherung, eigenen CAs, DNS (RFC 2136, Infoblox), Abgleich (HA) und Health/Metriken.

## Wächter, die sonst erst beim Zusammenführen rot werden

- **Neue `AuditAction` (`lib/audit.ts`)**: braucht eine Zeile in `AUDIT_ACTIONS` (`lib/audit-log/labels.ts`, `Record<AuditAction, …>`, sonst scheitert `pnpm typecheck`) und die Übersetzung in `lib/i18n/en/audit.ts`. Ein neuer Bereich kommt in `AUDIT_AREAS` und `AUDIT_AREA_LABELS`; das MCP-Schema (`list_audit_log`) liest die Liste.
- **Neue Benachrichtigung**: Typ in `NOTIFICATION_EVENT_TYPES` (`lib/types.ts`), Variante in `lib/notifications/events.ts`, Mail in `mails.ts`, Beispiel in `tests/notifications/mails.test.ts`. Dort greifen Tests per Index zu (`SAMPLES[2]`, `[3]`, `[6]`): neue Beispiele hinter Index 9 einfügen, nie davor.
- **Neuer Schreibweg am Proxy**: über `withProxyLock` (`lib/haproxy/provision.ts`). Die Sperre fragt seit dem Abgleich die Rolle des Knotens aus der Datenbank und lehnt auf einem Folgeknoten mit 409 ab. Ein Test, der eine Funktion hinter der Sperre direkt ruft, braucht `vi.mock('@/lib/sync/role', () => ({ assertProxyWritable: async () => undefined, isReplica: async () => false }))`, sonst läuft er ohne Datenbank in die 5-Sekunden-Frist (so passiert in `tests/haproxy/backend-ca-provision.test.ts`). Was ein Knoten an sich selbst tut, nimmt `withProxyLockLocal`.
- **Neuer Ordner unter `/etc/haproxy`**: der Abgleich überträgt alles außer `EXCLUDED` in `lib/sync/bundle.ts`. Schreibt jeder Knoten den Ordner selbst, gehört er auf die Liste, sonst überschreiben sich Abgleich und Knoten. Der Name ist danach eine feste Kennung (CLAUDE.md, „Kennungen").
- **Etwas, das ausfallen kann**: eine Prüfung in `judge` (`lib/system/health.ts`, Eingabe über `HealthExtras`), eine Metrik in `lib/system/metrics.ts`, gelesen in `lib/system/monitoring.ts`, Zeile in `docs/hapm-api.md` („Überwachung"). Namen von Prüfungen und Metriken bleiben für immer.
- **Englisches Wörterbuch**: ein Schlüssel steht in genau einer Datei. Vor einem neuen Eintrag in `lib/i18n/en/*.ts` nach dem deutschen Text suchen, ein doppelter Schlüssel in derselben Datei ist TS1117. Kurze Wörter sind oft schon mit anderer Bedeutung belegt („Weiterleitung" = Redirect, „Nameserver", „Benutzer").

## Parallele Agenten in Worktrees

- Worktrees unter `.claude/worktrees/` liegen im Projektordner: solange dort geschrieben wird, lädt der Dev-Server (Turbopack) jede Seite ständig neu und die Vorschau zeigt nur das Ladegerüst. Vorschau erst nach dem Zusammenführen, Worktrees danach entfernen (`git worktree remove`, Reste von Hand löschen, sonst liegen dort auch Tests und Quelltext doppelt).
- Konflikte entstehen an denselben wenigen Stellen: `lib/audit.ts`, `lib/types.ts`, `lib/scheduler.ts`, `lib/notifications/*`, `components/Sidebar.tsx`, `Dockerfile` (apt-Zeile), `package.json` (Skripte), README, `docs/hapm-api.md`, `docs/mcp.md`, `docs/betrieb.md`, CLAUDE.md. Fast immer gilt „beide behalten".
- Nach `pnpm build` im Projektordner den Dev-Server neu starten, sonst kennt er geänderte Module nicht („… is not a function").
- Die Ports 55441 bis 55445 lassen sich unter Windows hier nicht binden (reserviert), ein Test-Postgres geht auf 127.0.0.1:25442 oder 15444.
- Ein Bash-Heredoc, dessen Inhalt drei einfache Anführungszeichen hintereinander enthält (Python-Text), scheitert im Harness mit „unexpected EOF". Skript mit dem Schreibwerkzeug als Datei anlegen und dann starten.
- Die Quelldateien liegen mit CRLF im Arbeitsbaum: Python-Patches mit `newline=''` lesen und schreiben.
- `next dev` in einem Worktree legt dort eine `AGENTS.md` an: nicht committen.

## Vorschau mit eigenem Konto

Ohne das Passwort des vorhandenen Testkontos: ein Wegwerf-Konto direkt in die FORGE-Testdatenbank schreiben (`auth_users` mit `id, name, email, email_verified`, dazu `auth_accounts` mit `provider_id = 'credential'`, `account_id = user_id`, `password` aus `hashPassword` in `bin/admin-password.mjs`), anmelden, am Ende die Zeile in `auth_users` löschen (die anderen gehen mit). `hapm-admin reset-password` dafür nicht nehmen: es beendet die Sitzungen des echten Testkontos.
