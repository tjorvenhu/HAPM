---
title: "Durchsicht des ganzen Projekts (Nov 2026): gefundene Fehlerklassen und worauf man achten muss"
summary: "Fehlerklassen aus der Gesamtdurchsicht: Läufe hinter der Sperre, Zeitvergleiche, Whitelist-Muster, verschluckte Fehler in der Oberfläche, Python-Patches mit \\b. Vor ähnlichen Änderungen lesen."
tags: ["stolperfalle","konvention","tests","entwicklung","ui"]
updated: "2026-11-26T12:19:28.581Z"
---

# Durchsicht des ganzen Projekts: Fehlerklassen

Aus einer Durchsicht aller Bereiche (CrowdSec, Reverse-Proxy-Kern, Betrieb, Anmeldung/Einrichtung/DNS, Oberfläche). Die einzelnen Korrekturen stehen im Code und in den Docs; hier die Muster, die wiederkehren.

## Läufe am Reverse-Proxy stehen in einer Warteschlange

- **Nie in einer Anfrage auf einen Lauf warten.** `waitForRun` mit Frist meldete „gescheitert", während der Lauf hinter einem Zertifikat (bis 300 s) noch anstand und später doch alles änderte. HAProxy schneidet eine Anfrage an HAPM außerdem nach 50 s ab (`timeout server`). Muster: Lauf starten, `runId` zurückgeben, Rest abgekoppelt beenden (`finishSwitchOff` in `lib/crowdsec/actions.ts`).
- **Eingaben nicht vor der Sperre auflösen.** Wer `httpsLines`/`adminIps` zum Zeitpunkt der Anfrage liest und im Lauf schreibt, überschreibt die Änderung eines Laufs davor. Dafür gibt es `fromFile` (alles außer dem Gewollten bleibt, wie es beim Lauf dasteht) und `patch` (Teil-Patch wird im Lauf gegen die Datei ausgerechnet) in `GlobalSettingsInput`.
- **Prüfungen doppelt:** vor dem Lauf (Antwort ans Formular) UND im Lauf unter `withProxyLock` (dazwischen kann sich die Lage ändern). Beispiel `assertCrowdsecAvailable`, `assertNothingShadowed`.
- Was zählt, steht in der Datei: Erfolg an `haproxy.cfg` ablesen, nicht am Status des Laufs.

## Zeit

- Tägliche Uhrzeiten nicht mit der Minute der Uhr vergleichen (`lib/schedule-time.ts`): Sommerzeit (02:00 bis 02:59 gibt es einmal im Jahr nicht) und driftende Takte.
- Der HAProxy-Container läuft ohne `TZ` in UTC. Zeiten aus der eckigen Klammer der Logzeile sind seine Ortszeit; die Statistik nimmt den UTC-Kopf, den HAPM beim Mitschreiben davorsetzt.
- Text-Vergleich von `dd/Mon/yyyy` ist über Monatsgrenzen falsch.

## Ausnahmen für CrowdSec (Whitelists)

- Jedes Muster am Anfang und, wo möglich, am Ende verankern. `http_path` enthält bei HAProxy die Query: ein unverankertes Muster passt auf angehängte Parameter. `..` nimmt keine Ausnahme (`localRuleExpression`). Gegenproben gehören in `tests/crowdsec/apps.test.ts` und per `cscli explain` geprüft.

## Docker

- `State.Running` ist in der Pause einer Neustartschleife `true`: immer mit `!State.Restarting` (`lib/docker/index.ts`).
- `engine.stop` wartet bis 30 s je Container (CrowdSec im Abbild braucht die oft ganz): nicht in einer Anfrage abwarten, und nicht mittendrin wieder starten.

## Oberfläche

- `ConfirmDialog` meldet jetzt selbst, wenn `onConfirm` wirft (Option `failedTitle`): im Callback werfen statt selbst toasten.
- Laden: `if (!res.ok || !body.success) throw`. Sonst zeigt die Seite einen leeren Zustand, der etwas Falsches behauptet („Noch keine Domain").
- Fehlertexte über `errorText(err, fallback)` (`components/errorText.ts`), nie `err.message` roh.
- Serverfehler nach dem Absenden sind Toasts, das Fenster bleibt offen; Prüfungen vor der Anfrage bleiben am Feld. Die öffentlichen Seiten (/setup, /login …) haben keinen ToastProvider und bleiben bei Inline-Meldungen.
- `useArea` folgt `?bereich=` auch bei Links innerhalb der offenen Seite.

## Sicherheit

- Über einen API-Key lassen sich SMTP-Server-Felder nicht ändern (wer den Server umstellt, bekommt die Passwort-Links). `acmeEmail` nur mit `validateAcmeEmail` (acme.sh liest seine Datei als Shell).
- `/api/setup/*` nur bei `setupStatus === 'open'` und nicht während des Laufs (`assertSetupOpen`).
- `secrets.json`: nur ENOENT heißt „neu anlegen", sonst Start abbrechen.

## Werkzeug-Stolperfalle beim Patchen

Python-Skripte, die Quelltext ersetzen: `\b` in einem normalen String ist ein Backspace (0x08) und landete zweimal unbemerkt in einem Regex (`import.ts`, `CrowdsecLogView.tsx`), der dann nie traf. Für Text mit Backslashes das Edit-Werkzeug oder rohe Strings nehmen und danach `grep -rlP "[\x00-\x08]"` laufen lassen. Die FORGE-Policy blockt außerdem Bash-Aufrufe, die die Zeichenfolge eines rekursiven Löschens der Wurzel enthalten, auch in Testdaten: solche Dateien mit Write anlegen.

## Tests

- `tests/backup/restore.test.ts` (echte Shell) braucht unter Volllast mehr als 5 s je Fall: `timeout: 30_000` am `describe`.
- Bekannt rot unter Windows: zwei Fälle in `tests/acme-server.test.ts`.
