---
title: "Abgleich (HA): Datenteil mit Konten, Einstellungen, DNS-Zonen, API-Keys, CrowdSec. Stolperfallen und Prüfen"
summary: "Was beim Einbau des Datenteils in den Abgleich zwischen Knoten auffiel: wo etwas Neues hin muss, warum manche Sperre beim Aufrufer sitzt, cscli-Verhalten, Tests gegen Postgres. Vor Änderungen an lib/sync/data*.ts, lib/crowdsec/mirror.ts, lib/db/account-rows.ts lesen."
tags: ["stolperfalle","tests","crowdsec","architektur","konvention"]
updated: "2026-11-26T21:46:56.725Z"
---

# Abgleich: der Datenteil (seit `SYNC_PROTOCOL` 2)

Was übertragen wird und warum, steht in `docs/hochverfuegbarkeit.md` („Der Datenteil", „Für den, der es ändert"). Hier nur, was beim Bauen auffiel.

## Aufbau in einem Satz

`lib/sync/data.ts` (rein: Form, zwei Fingerabdrücke, `parseSyncData`, Pläne für CrowdSec), `data-collect.ts` (lesen), `data-apply.ts` (einsetzen, jeder Teil für sich), `kick.ts` (Anstoß über `logAudit`), `lib/db/account-rows.ts` (Konten per SQL in einer Transaktion), `lib/crowdsec/mirror.ts`. Sperre auf dem Folgeknoten: `assertDataWritable(bereich)` in `lib/sync/role.ts`.

## Stolperfallen

- **`changeRules` und `queueRuleChange` müssen ohne `await` einreihen.** `tests/crowdsec/rule-jobs.test.ts` prüft die Reihenfolge zweier Änderungen im selben Augenblick. Eine Sperre mit `await` darin bricht 24 Tests. Deshalb ruft der Aufrufer vorher `assertRulesWritable(body)` (zwei Routen, ein MCP-Werkzeug). Eine Sperre im Job selbst wäre falsch: ein gescheiterter Job lädt CrowdSec am Ende des Laufs trotzdem neu.
- **Wiederherstellungscodes sind an den Knoten gebunden**: ihr HMAC hängt am `encryptionKey` (`lib/recovery-codes.ts`). Die Hashes gehen mit, gelten aber nur dort, wo sie entstanden.
- **Fingerabdruck nur über Stabiles.** Nicht hinein gehört, was eine Anmeldung ändert (Zähler eines Passkeys, `lastTotpStep`, `lastUsedAt` eines Keys, `user_state`), sonst ist jede Anmeldung ein Abgleich. Geheimnisse im Klartext vergleichen: `encrypt` liefert bei jedem Aufruf ein anderes Chiffrat. Bei Sperren von CrowdSec zählt `createdAt`, nicht `until`: das Ende rechnet HAPM aus der Restdauer von `cscli`, und die schwankt je Aufruf.
- **CrowdSec lässt sich nicht immer lesen** (startet nach jeder Regeländerung neu). Deshalb ein eigener Fingerabdruck, der im Paket fehlen darf (`null` = „dort bleibt, was ist"), und `collectCrowdsec` nimmt bei einem Lesefehler den zuletzt gelesenen Stand.
- **Zeitstempel aus `auth_*` als Text lesen** (`to_char(... at time zone 'UTC', ...)`), wie `ROW_COLUMNS` in `sql.ts`: Drizzle stellt an der geteilten Verbindung um, wie `timestamptz` ankommt. In postgres.js gehen `where id = any(${liste})` (auch leer) und `db.unsafe('…')` als Fragment in einer Vorlage.
- **Einstellungen nicht über `updateSettings` einsetzen**: das löschte beim Wechsel der Adresse alle Passkeys, die im selben Paket kommen. `data-apply.ts` prüft mit `settingsPatch` und schreibt die Zeile direkt.
- **Hinweis-Typ entfernt**: die Warnung `exposure` gibt es nicht mehr (kommt jetzt mit dem Abgleich). Das englische Wörterbuch darf keine unbenutzten Einträge führen (`tests/i18n/dictionary.test.ts`), alte Schlüssel also mit entfernen.

## cscli, nachgesehen gegen CrowdSec 1.8.2

- `cscli allowlists add hapm <adresse> -d <text> -e 86400s` nimmt Sekunden an, ebenso `decisions add --duration 14400s`.
- Eine Sperre für eine freigegebene Adresse lehnt es ab: `… is allowlisted by item … use --bypass-allowlist …` (Exit 1). `mirror.ts` nimmt das hin.
- `decisions delete --id <n>` hebt genau eine Sperre auf, `--ip` alle der Adresse (auch die von CrowdSec selbst).
- Wegwerf-Container zum Nachsehen: `docker run -d --name probe -e DISABLE_ONLINE_API=true -e CROWDSEC_BYPASS_DB_VOLUME_CHECK=true crowdsecurity/crowdsec:latest`, warten bis `cscli lapi status` 0 liefert, danach `docker rm -f probe`. Ohne die zweite Variable beendet sich der Container sofort (kein Volume für die Datenbank).

## Tests

- `tests/sync/data-apply.test.ts` läuft nur mit `TEST_DATABASE_URL`. Die FORGE-Testdatenbank taugt dafür (URL aus `dev_environment`), der Test legt ein eigenes Schema an und räumt es weg.
- `tests/sync/send.test.ts`: `send.ts` merkt sich über die Tests hinweg, wann zuletzt nachgezogen wurde (`globalThis.__hapmSyncSend.repaired`). `beforeEach` leert das, sonst frisst ein Test dem nächsten das Stundenbudget weg.
- `tests/acme-server.test.ts` (zwei Fälle `registerAccountScript`) scheitert unter Windows auch ohne Änderung: das Skript bekommt einen Pfad `C:\…\acme.sh` und lädt ihn mit `. "$0"`.
- Wer `@/lib/crowdsec/actions` mockt (`tests/mcp/tools.test.ts`), braucht jeden neuen Export darin, sonst „No … export is defined on the mock".
