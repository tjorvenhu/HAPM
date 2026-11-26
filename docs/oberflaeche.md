# Oberfläche: Regeln für Aufbau, Texte und Meldungen

Was auf jeder Seite gleich ist und warum. Wer eine Seite baut oder ändert,
hält sich daran, auch wenn die Aufgabe nur „ein Feld dazu" heißt. Wo eine Regel
geprüft wird, steht der Test dabei: er ist die Regel, dieses Dokument erklärt
sie nur.

## Seitenkopf

- **Der Titel einer Seite ist ihr Name in der Seitenleiste** (`components/Sidebar.tsx`)
  und im Titel des Browsers: „Ziele", „DNS", „Statistik", „Logs". Nicht eine
  zweite, längere Fassung („Reverse-Proxy-Protokolle").
- **Unterseiten des Reverse-Proxys nehmen `components/PageHeading.tsx`**:
  Symbol, Titel, darunter der Rückweg als Pille. Die Pille nennt die Seite,
  auf die sie führt: „Ziele" für `/reverse-proxy`. „Übersicht" heißt nur das
  Dashboard.
- Unter dem Titel steht höchstens ein kurzer Satz, was die Seite ist. Die
  Erklärung dazu steht hinter dem „i" neben dem Titel (siehe „Lange Texte").
- Der Knopf zum Neuladen heißt „Aktualisieren" (`btn btn-secondary`,
  `RefreshCw`) und steht rechts im Kopf.

## Lange Texte

- **Eine Erklärung über 72 Zeichen (`LONG_TEXT`, `ui/primitives/hint-text`)
  steht nicht als Text unter einem Titel oder Feld, sondern hinter dem „i"
  (`InfoHint`).** Unter dem Titel bleibt ein kurzer Satz, am Feld nur, was man
  zum Ausfüllen braucht.
- **Sichtbar bleibt, was man vor dem Klick wissen muss:** Warnungen und Folgen
  („löscht alle Passkeys"), als `alert alert-warning` oder `alert-info`, nicht
  als langer grauer Absatz. Und der Zustand: Fehler, „noch nichts eingerichtet"
  mit dem, was zu tun ist.
- Geprüft von `tests/ui/long-text.test.ts`: jeder lange Text an einer dieser
  Stellen steht entweder hinter dem „i" oder mit Grund in der Liste der
  Ausnahmen im Test.

## Wortwahl

Das Glossar steht in [`i18n.md`](i18n.md). Für die Oberfläche zusätzlich:

- **Etwas wegnehmen heißt „Entfernen"**, nie „Löschen": Knopf, Tooltip, Titel
  der Rückfrage („… entfernen?"), Knopf der Rückfrage, Meldung („entfernt"),
  Fortschritt („Wird entfernt"). „Endgültig entfernen", wo der Name zur
  Bestätigung getippt wird. Geprüft in `tests/i18n` (kein Schlüssel endet auf
  „löschen"). Eigene Wörter haben nur: „Zurückziehen" (API-Key),
  „Zurücksetzen", „Leeren".
- Dieselbe Sache heißt überall gleich: „Speichern", „Aktualisieren" (neu
  laden), „Schritte ansehen" (das Fenster eines Laufs), „Dialog schließen"
  (das Kreuz), „noch nie" (ein Datum, das es nicht gibt).
- Kurze, konkrete Sätze. Kein Gedankenstrich, kein Emoji, „…" als ein Zeichen
  und ohne Leerzeichen davor, Anführungszeichen „so“.
- Ein Wert, den es nicht gibt, ist `MISSING` (`lib/i18n/format.ts`), keine
  leere Zelle.

## Meldungen

- **Das Ergebnis einer Handlung ist ein Toast** unten rechts
  (`useToast().notify`): der Erfolg, und die Absage des Servers nach dem
  Absenden (Titel „… fehlgeschlagen", das Fenster bleibt offen, die Eingabe
  steht noch da). Kopieren meldet „Kopiert" als Toast.
- **Als Text auf der Seite steht nur ein Zustand:** das Laden ist gescheitert
  (`alert alert-danger sys-block`, Text über `ErrorNote`), eine Warnung zum
  System, die Prüfung einer Eingabe VOR dem Absenden am Feld.
- **Auch vor der Anmeldung:** Anmeldung, „Passwort vergessen", „Passwort
  setzen" und der Assistent haben ihren eigenen `ToastProvider` im Layout
  (`errorDetails={false}`, das Fenster zu einer Kennung verlangt eine
  Sitzung). Die Absage des Servers ist dort ein Toast, am Feld steht nur die
  Prüfung vor dem Absenden („Die Passwörter stimmen nicht überein").
- Eine Rückfrage, deren `onConfirm` wirft, meldet das selbst
  (`ConfirmDialog`, Option `failedTitle`): im Callback werfen, nicht selbst
  einen Toast absetzen.
- Fehlertexte gehen durch `errorText(err, fallback)`
  (`components/errorText.ts`), nie `err.message` roh: sonst liest der Benutzer
  „Failed to fetch".
- **Ein unbekannter Fehler nennt nur eine Kennung** („Unbekannter Fehler.
  Kennung: F-3A9C1E"). Der Text dazu (Treiber, Pfade, Ausgabe eines Kommandos)
  bleibt auf dem Server (`lib/error-log.ts`) und im Log des Containers. Jede
  Meldung mit Kennung bietet „Anzeigen" an und öffnet die Einzelheiten
  (`components/ErrorDetails.tsx`, nur mit Sitzung). Deshalb: **was der Benutzer
  lesen soll, wirft die Route als `ApiError`**, nicht als `Error`.
- Laden prüft `if (!res.ok || !body.success) throw`. Sonst zeigt die Seite
  einen leeren Zustand, der etwas Falsches behauptet („Noch keine Domain").
- **Ein Schalter, dessen Wirkung dauert, sperrt nicht die Seite.** Er zeigt
  sofort den gewünschten Zustand mit einem Spinner daneben, die Änderung läuft
  im Hintergrund, und jeder andere Schalter bleibt bedienbar (Regeln von
  CrowdSec, `lib/crowdsec/rule-jobs.ts`). Der Lauf steht in der Pille unten
  rechts und wird nur verfolgt (`watchRun`), nicht als Fenster aufgerissen:
  an ihn hängen sich weitere Klicks an, und ein Fenster je Klick stünde im Weg.
- Ein Lauf am Reverse-Proxy meldet sein Ende über `startRun`
  (`components/runs/runs.ts`), nicht über einen eigenen Timer der Seite.

## Aufbau und Layout

Jede Seite wird vor „fertig" in drei Breiten angesehen: breit (1440), schmal
(1024) und Handy (400), und mit vielen UND mit wenigen Einträgen.

- **Eine Karte ist so hoch wie ihr Inhalt.** Eine kurze Karte neben einer
  langen wird nicht gestreckt: die leere Fläche darin sieht aus wie ein Fehler.
  Raster aus zwei Spalten stehen deshalb auf `align-items: start`
  (`.hapm-cols`).
- **Lang neben kurz heißt Hauptspalte und Seitenspalte:** was mit den Daten
  wächst (Liste, Tabelle), steht in der breiten Spalte. Kurze Karten (Zustand,
  Erklärung) stehen in einer schmalen Spalte übereinander, nicht jede in
  einer eigenen halben Seite: `.hapm-main-side` (schmale Spalte rechts) oder
  `.hapm-side-main` (links, wie CrowdSec, Übersicht), die Karten der schmalen
  Spalte in `.hapm-side`, alles in einem `.hapm-fit` (`app/hapm.css`).
  Mehrere Karten in der Hauptspalte stehen in einem `.hapm-stack`.
  Umgebrochen wird nach dem Platz des Bereichs (Container-Abfrage), nicht nach
  der Breite des Fensters.
- **Was für alle Zeilen einer Liste gilt, steht einmal über der Liste**, nicht
  in jeder Zeile („Alle Ziele prüfen ist an" über den geschützten Zielen). In
  der Zeile steht nur die Ausnahme.
- **Ein leerer Zustand steht mittig in der Karte**, in der sonst die Liste
  stünde (`empty-state`), mit dem Satz, was zu tun ist. Kein grauer Hinweis
  unter einer leeren Tabelle.
- Nur gleichartige Karten in einer Reihe sind gleich hoch (Kennzahlen, die
  Karten der Updates): dort ist das Raster die Aussage.
- **Raster brechen nach der Breite um**, bis zu einer Spalte. Kennzahlen
  stehen in vollen Reihen: acht als vier, zwei, eine (`.hapm-kpis-8`), fünf
  als drei und zwei (`.hapm-kpis-5`). Nie eine einzelne Kachel allein neben
  leerem Platz. Zählen sie etwas, trägt die Achse des Diagramms daneben nur
  ganze Zahlen (`integers`). Eine Seitenspalte rutscht unter die Hauptspalte, sobald
  die Hauptspalte sonst zu schmal würde (um 1100 px).
- **Tabellen auf dem Handy werden Karten je Zeile:** Klasse `table-cards` am
  `<table>` (`ui/css/tool-vocabulary.css`), dazu an jeder Zelle `data-label`:
  `"primary"` für die Hauptzelle (steht oben, ohne Etikett), `"actions"` für
  die Knöpfe (stehen unten, links), sonst der Text der Spaltenüberschrift
  (`data-label={t('Grund')}`). Ohne das läuft die Tabelle waagerecht, und
  der Knopf in der letzten Spalte ist nicht zu sehen. Eine Tabelle mit zwei
  Spalten braucht es nicht. Lange Kennungen ohne Leerzeichen brechen um
  (`overflow-wrap: anywhere`).
- **Auf dem Handy steht nichts rechtsbündig in einer eigenen Reihe.** Knöpfe
  im Seitenkopf, in einem Hinweis (`.hapm-flag-actions`) und am Ende einer
  Leiste rücken nur dann nach rechts, wenn sie neben ihrem Text stehen.
  Brechen sie um, stehen sie links unter dem Text. Deshalb kein
  `margin-left: auto` ohne Rücknahme unter 640 px: besser wächst der Text
  daneben (`flex: 1`) und schiebt den Knopf.
- In einer Karte hat alles unter der Kopfzeile denselben Abstand (16 px, Regel
  in `ui/css/tool-vocabulary.css`): kein Element klebt am vorigen.
- Laden ist ein Skeleton (`SkeletonRows`, `SkeletonCards`), nichts ist ein
  `empty-state` mit Symbol, Überschrift und einem Satz, was zu tun ist.
- Farben und Abstände über die CSS-Variablen, Klassen aus `ui/css/tool.css`,
  seitenspezifisches in `app/hapm.css`. Kein Inline-Stil für Abstände.

## Bewegung

- **Ein Wechsel des Reiters blendet den Inhalt kurz ein** (200 ms, 6 px von
  unten). Das macht die Leiste der Reiter selbst: `AreaTabs` setzt die Klasse,
  eine eigene Leiste (`.tabs`) nimmt `useTabMotion(value)` aus
  `components/AreaTabs.tsx`. Keine Seite baut dafür etwas Eigenes, und der
  Inhalt wird nicht neu aufgebaut (getippte Eingaben bleiben).
- Animiert werden nur `transform` und `opacity`, 120/200/300 ms, ohne
  Füllmodus. Mit `prefers-reduced-motion` fällt die Bewegung weg.

## Geführte Dialoge und die Hinweiszeile

- **Ein Dialog, der etwas in mehreren Teilen anlegt, führt durch Schritte**
  (Ziel, TCP-Weiterleitung): im Kopf ein Symbol mit Titel und einem Satz,
  darunter die Schritte über die ganze Breite, im Fuß links „Schritt 2 von 4"
  und rechts der Knopf, der den nächsten Schritt beim Namen nennt („Weiter zum
  Ziel"). Die Bausteine sind `FormSteps` und `FormWizardFooter`
  (`components/reverse-proxy/FormWizard.tsx`), das Aussehen steht unter
  „Geführter Dialog" in `ui/css/tool-vocabulary.css` (`form-wizard-*`).
- Die Schritte sind Reiter: springen ist erlaubt, alles bleibt im Zustand des
  Formulars. **Anlegen und Speichern gehen aus jedem Schritt, sobald nichts
  mehr fehlt.** Spätere Schritte sind oft Zusätze, durch die niemand klicken
  muss. Solange etwas fehlt, ist „Weiter zu …" der eine betonte Knopf.
- **Was noch fehlt, steht als eine Zeile über dem Fuß** (`FormHint`,
  `components/FormHint.tsx`): mit Symbol, in einer Zeile, außerhalb des
  scrollenden Teils, also in jedem Schritt zu sehen. `warning` für das, was
  noch fehlt, `danger` für eine Eingabe, die so nicht geht. Dieselbe Zeile
  nimmt der Assistent der Einrichtung für seine Prüfung vor dem Absenden. Keine
  rote Meldung am Kopf eines Formulars und kein zweiter Kasten in einer Spalte.
- Auf dem Handy steht der Kopf in einer Zeile (ohne den Satz), die Schritte
  sind eine Reihe aus Symbolen, und nur der gewählte trägt seinen Namen. Die
  Knöpfe im Fuß teilen sich die ganze Breite.
- **Ein Domainfeld schlägt die angebundenen DNS-Zonen vor** (`DomainInput`,
  `suggestDomains` in `lib/dns/zones.ts`): wer `app` tippt, bekommt
  `app.<Zone>`. Die Liste sieht aus wie die der Auswahlliste.

## Knöpfe und Rückfragen

- Ein Knopf, der etwas am Server auslöst, ist währenddessen gesperrt und zeigt
  `Loader2` an der Stelle seines Symbols. Nach einem Fehler ist er wieder frei.
- Rückfragen: `danger` für Entfernen und Zurückspielen, `warning` für
  Überschreiben und Umstellen. Der Titel ist eine Frage.
- Ein Knopf nur mit Symbol hat ein `aria-label`.
- Lange Listen zeigen das Wichtigste und klappen den Rest auf („Alle n
  anzeigen"), wie die Anwendungen unter CrowdSec, Regeln.
