/** CrowdSec (WAF): Seite, Logs, Statistik, Übersicht, Ziel-Dialog, Assistent, Meldungen. */
export const crowdsec: Readonly<Record<string, string>> = {
  // Übersicht (Dashboard)
  'Live-Verkehr': 'Live traffic',
  'Sicherheit (CrowdSec)': 'Security (CrowdSec)',
  'Bestandteile und Betrieb': 'Components and operation',
  'Letzte Vorgänge und Zertifikate': 'Recent tasks and certificates',
  'Geprüfte Ziele': 'Checked targets',
  'CrowdSec läuft nicht': 'CrowdSec is not running',
  'von {count}': 'of {count}',
  'Aktive Sperren': 'Active bans',
  'WAF-Treffer in 24 Stunden': 'WAF hits in 24 hours',
  'Ereignisse in 24 Stunden': 'Events in 24 hours',
  Anpassen: 'Customize',
  'CrowdSec-Bouncer': 'CrowdSec bouncer',
  'Übersicht anpassen': 'Customize overview',
  'Reihenfolge und sichtbare Bereiche gelten für diesen Browser.': 'Order and visible sections apply to this browser.',
  'Nach oben': 'Move up',
  'Nach unten': 'Move down',
  Vorgabe: 'Default',

  // Seite CrowdSec
  CrowdSec: 'CrowdSec',
  'CrowdSec (WAF)': 'CrowdSec (WAF)',
  Freigaben: 'Allowlist',
  Regeln: 'Rules',
  Sperrliste: 'Bans',
  // Reiter im Dialog eines Ziels
  'Zugriff und Schutz': 'Access and protection',
  Erweitert: 'Advanced',
  'WAF, Sperren und Freigaben': 'WAF, bans and allowlist',
  'CrowdSec ist nicht erreichbar.': 'CrowdSec is not reachable.',
  'CrowdSec für alle Ziele': 'CrowdSec for all targets',
  'Die Einstellungen von HAProxy lassen sich gerade nicht ändern.': 'The HAProxy settings cannot be changed right now.',
  'CrowdSec für alle Ziele einschalten?': 'Turn on CrowdSec for all targets?',
  'CrowdSec für alle Ziele ausschalten?': 'Turn off CrowdSec for all targets?',
  'HAProxy fragt danach für jede Anfrage an jedes Ziel bei CrowdSec nach, auch für die Oberfläche von HAPM. Eine WAF kann harmlose Anfragen fälschlich sperren. Die eigene Adresse lässt sich unter „Freigaben“ ausnehmen.':
    'HAProxy then asks CrowdSec about every request to every target, including the HAPM interface. A WAF can block harmless requests by mistake. Your own address can be excluded under "Allowlist".',
  'Danach prüft CrowdSec nur noch Ziele mit eigenem Schalter.': 'CrowdSec then only checks targets with their own switch.',
  Einschalten: 'Turn on',
  Ausschalten: 'Turn off',
  'CrowdSec ist bei dieser Installation abgeschaltet': 'CrowdSec is turned off for this installation',
  'Bei der Installation wurde CrowdSec abgewählt. Einschalten: die Zeile HAPM_CROWDSEC_OFF in der Datei .env neben docker-compose.yml entfernen und docker compose up -d ausführen, oder install.sh mit --crowdsec erneut starten.':
    'CrowdSec was deselected at installation. To turn it on, remove the HAPM_CROWDSEC_OFF line from the .env file next to docker-compose.yml and run docker compose up -d, or run install.sh again with --crowdsec.',
  'CrowdSec läuft nicht vollständig.': 'CrowdSec is not fully running.',
  'CrowdSec ist auf diesem Server noch nicht eingerichtet': 'CrowdSec is not set up on this server yet',
  'Die Installation stammt von vor CrowdSec: ihre docker-compose.yml kennt die beiden Container noch nicht. Nachrüsten mit dem Installationsskript, es holt die neue Datei und startet CrowdSec mit. Daten und Einstellungen bleiben.':
    'This installation predates CrowdSec: its docker-compose.yml does not know the two containers yet. Add it with the install script, which fetches the new file and starts CrowdSec as well. Data and settings stay.',
  'Solange CrowdSec oder der Bouncer fehlt, gehen alle Anfragen ungeprüft durch. Mehr sagt der Reiter „CrowdSec“ unter Logs.':
    'While CrowdSec or the bouncer is missing, all requests pass unchecked. More in the "CrowdSec" tab under Logs.',
  'Alle Ziele prüfen': 'Check all targets',
  'Steht im HTTPS-Frontend von HAProxy und gilt damit auch für Ziele, die später dazukommen. Ohne den Schalter prüft CrowdSec nur Ziele, bei denen es im Dialog des Ziels eingeschaltet ist.':
    'Lives in the HTTPS frontend of HAProxy and so also applies to targets added later. Without the switch, CrowdSec only checks targets where it is turned on in the target dialog.',
  'Eigener Schalter': 'Own switch',
  'Lokale API': 'Local API',
  Antwortet: 'Responding',
  'Antwortet nicht': 'Not responding',
  'Bouncer angemeldet': 'Bouncer registered',
  'Ja, zuletzt {ago}': 'Yes, last {ago}',
  'Nein. HAPM holt das in den nächsten Minuten nach.': 'No. HAPM catches up within the next minutes.',
  'OWASP-Regeln': 'OWASP rules',
  'Den Container {name} gibt es nicht.': 'The container {name} does not exist.',
  Gemeinschaftsliste: 'Community blocklist',

  // Sperren
  '1 Stunde': '1 hour',
  '4 Stunden': '4 hours',
  '1 Tag': '1 day',
  '7 Tage': '7 days',
  '30 Tage': '30 days',
  '1 Jahr': '1 year',
  Erkannt: 'Detected',
  Blockliste: 'Blocklist',
  '{value} ist gesperrt.': '{value} is banned.',
  'Sperren fehlgeschlagen': 'Ban failed',
  'Sperre aufheben?': 'Lift ban?',
  '{value} kommt danach wieder durch, bis CrowdSec die Adresse erneut erkennt.':
    '{value} gets through again until CrowdSec detects the address again.',
  Aufheben: 'Lift',
  'Die Sperre für {value} ist aufgehoben.': 'The ban for {value} is lifted.',
  'Aufheben fehlgeschlagen': 'Lifting failed',
  'Adresse freigeben?': 'Allow address?',
  '{value} kommt danach immer durch: CrowdSec sperrt die Adresse nicht mehr, und HAProxy fragt für sie nicht bei der WAF nach. Bestehende Sperren hebt CrowdSec dabei auf.':
    '{value} then always gets through: CrowdSec no longer bans the address, and HAProxy does not ask the WAF about it. CrowdSec lifts existing bans.',
  'Adresse sperren': 'Ban address',
  'Eine Adresse oder ein Netz, etwa 203.0.113.7 oder 198.51.100.0/24.': 'An address or a network, for example 203.0.113.7 or 198.51.100.0/24.',
  'Gesperrt in HAPM': 'Banned in HAPM',
  'Gesperrte Adressen bekommen von jedem geprüften Ziel eine 403.': 'Banned addresses get a 403 from every checked target.',
  'Keine Sperre': 'No ban',
  'Ohne Verbindung zu CrowdSec sind die Sperren unbekannt.': 'Without a connection to CrowdSec the bans are unknown.',
  'Ohne Verbindung zu CrowdSec sind die Freigaben unbekannt.': 'Without a connection to CrowdSec the allowlist is unknown.',
  'Gerade ist keine Adresse von CrowdSec oder von Hand gesperrt.': 'No address is currently banned by CrowdSec or by hand.',
  Endet: 'Ends',
  'Sperre aufheben': 'Lift ban',
  'Das ist keine Adresse und kein Netz.': 'This is neither an address nor a network.',

  // Freigaben
  Unbefristet: 'Permanent',
  '{value} ist freigegeben.': '{value} is allowed.',
  'Freigeben fehlgeschlagen': 'Allowing failed',
  'Freigabe entfernen?': 'Remove from allowlist?',
  '{value} ist die eigene Adresse. Danach prüft CrowdSec auch die eigenen Anfragen und kann sie sperren.':
    '{value} is your own address. CrowdSec then also checks your own requests and can ban them.',
  'Danach prüft CrowdSec die Anfragen von {value} wieder.': 'CrowdSec then checks requests from {value} again.',
  'Die Freigabe für {value} ist entfernt.': '{value} is removed from the allowlist.',
  'Adresse freigeben': 'Allow address',
  'Freigegebene Adressen sperrt CrowdSec nicht. Die WAF prüft sie nicht.': 'CrowdSec does not ban allowed addresses. The WAF does not check them.',
  'Eigene Adresse': 'Own address',
  'Eigene Adresse eintragen': 'Enter own address',
  Gilt: 'Valid for',
  Beschreibung: 'Description',
  'Büro, Monitoring, Partner': 'Office, monitoring, partner',
  Freigeben: 'Allow',
  'Keine Freigabe': 'No allowed address',
  'CrowdSec prüft alle Adressen.': 'CrowdSec checks all addresses.',
  'Gilt bis': 'Valid until',

  // Ereignisse
  WAF: 'WAF',
  Szenario: 'Scenario',
  'Von Hand': 'By hand',
  Sonstiges: 'Other',
  'Alle Ziele': 'All targets',
  'Nur die Ereignisse von {target}.': 'Only the events of {target}.',
  'WAF-Treffer, Szenarien aus dem Log von HAProxy und Sperren von Hand.': 'WAF hits, scenarios from the HAProxy log and bans by hand.',
  'Filter entfernen': 'Remove filter',
  'Keine Ereignisse': 'No events',
  'Im gewählten Zeitraum hat CrowdSec nichts gemeldet.': 'CrowdSec reported nothing in the selected period.',
  Was: 'What',
  Von: 'From',
  'mit Sperre': 'with ban',
  '{count} Anfrage': '{count} request',
  '{count} Anfragen': '{count} requests',
  'Ohne Ziel': 'No target',

  // Regeln
  Aus: 'Off',
  'Log von HAProxy: Scanner, Raten von Passwörtern, bekannte Lücken': 'HAProxy log: scanners, password guessing, known vulnerabilities',
  'WAF: virtuelle Patches für bekannte Lücken': 'WAF: virtual patches for known vulnerabilities',
  'WAF: allgemeine Angriffsmuster': 'WAF: generic attack patterns',
  'OWASP Core Rule Set': 'OWASP Core Rule Set',
  'Zusätzliche, strengere Prüfung jeder Anfrage auf typische Angriffe.': 'Additional, stricter check of every request for typical attacks.',
  'Weniger anzeigen': 'Show less',
  'Alle {count} Anwendungen anzeigen': 'Show all {count} applications',
  'Anwendung suchen…': 'Search applications…',
  'Anwendung suchen': 'Search applications',
  Regelsammlungen: 'Rule collections',
  'Aus dem Hub von CrowdSec.': 'From the CrowdSec hub.',
  'Regeln aktualisieren': 'Update rules',
  Sammlung: 'Collection',
  'Immer an': 'Always on',
  'HTTP-Flut': 'HTTP flood',
  'Erkennt Adressen, die in kurzer Zeit sehr viele Anfragen schicken, und sperrt sie. Vorsicht bei Diensten, die viele Anfragen von einer Adresse bekommen, etwa Apps zum Abgleich hinter einem gemeinsamen Ausgang (Firmennetz, Mobilfunk). Solche Adressen gehören in die Freigaben.':
    'Detects addresses that send very many requests in a short time and bans them. Take care with services that get many requests from one address, such as sync apps behind a shared exit (company network, mobile carrier). Such addresses belong in the allowlist.',

  'HAProxy hat die neue Anbindung an CrowdSec geladen.': 'HAProxy loaded the new CrowdSec connection.',

  // Ganz ab- und einschalten
  'CrowdSec hält gerade noch an. Bitte in einer Minute noch einmal einschalten.':
    'CrowdSec is still stopping. Please switch it on again in a minute.',
  'CrowdSec wird gerade abgeschaltet. Bitte warten, bis der Vorgang fertig ist.':
    'CrowdSec is being switched off. Please wait until the task has finished.',
  '{names} ließ sich nicht starten, CrowdSec bleibt abgeschaltet. Auf dem Server legt docker compose up -d im Ordner der Installation die Container an.':
    '{names} could not be started, CrowdSec stays switched off. On the server, docker compose up -d in the installation folder creates the containers.',
  '{file} ist nicht lesbar. CrowdSec bleibt an.': '{file} cannot be read. CrowdSec stays on.',
  'CrowdSec ist auf dieser Installation nicht eingeschaltet. Einschalten lässt es sich unter System, Allgemein.':
    'CrowdSec is not switched on for this installation. You can switch it on under System, General.',
  'CrowdSec ist auf dieser Installation nicht eingeschaltet.': 'CrowdSec is not switched on for this installation.',
  'In der Oberfläche abgeschaltet.': 'Switched off in the web interface.',
  'Das Netz {value} ist zu groß. Das größte erlaubte ist /{min}.': 'The network {value} is too large. The largest allowed is /{min}.',
  '{value} trifft Ihre eigene Adresse ({ip}). Sie sperrten sich damit selbst aus.':
    '{value} covers your own address ({ip}). You would lock yourself out.',
  'Erwartet wird installed: true oder false.': 'Expected installed: true or false.',
  'Läuft, antwortet nicht': 'Running, not responding',
  'Im Zeitraum gibt es mehr Ereignisse, als hier Platz haben. Gezeigt sind die neuesten. Ein kürzerer Zeitraum oder ein einzelnes Ziel zeigt alle.':
    'There are more events in this period than fit here. The newest are shown. A shorter period or a single target shows all of them.',
  'Im Zeitraum gab es mehr Ereignisse, als sich auswerten lassen. Die Zahlen sind eine Untergrenze und decken nur die neuesten ab.':
    'There were more events in this period than can be evaluated. The figures are a lower bound and cover only the newest.',
  'CrowdSec abschalten': 'Switch off CrowdSec',
  'CrowdSec einschalten': 'Switch on CrowdSec',
  'CrowdSec ist wieder an. Welche Ziele es prüft, schalten Sie unter CrowdSec ein.':
    'CrowdSec is on again. Choose which targets it checks under CrowdSec.',
  'CrowdSec ist abgeschaltet.': 'CrowdSec is switched off.',
  'CrowdSec ist abgeschaltet': 'CrowdSec is switched off',
  'CrowdSec ganz abschalten?': 'Switch off CrowdSec entirely?',
  'HAPM nimmt CrowdSec aus allen Zielen und aus der globalen Einstellung, lädt HAProxy neu und hält beide Container an. Danach prüft niemand mehr Anfragen, und CrowdSec verschwindet aus Übersicht, Logs, Statistik und Benachrichtigungen. Sperren, Freigaben und Regeln bleiben gespeichert. Wieder einschalten lässt es sich unter System, Allgemein.':
    'HAPM removes CrowdSec from all targets and from the global setting, reloads HAProxy and stops both containers. After that nothing checks requests, and CrowdSec disappears from the overview, logs, statistics and notifications. Bans, allowlist and rules stay stored. You can switch it on again under System, General.',
  'Abgeschaltet nimmt HAPM CrowdSec aus jedem Ziel, hält beide Container an und blendet CrowdSec in der Oberfläche aus. Sperren, Freigaben und Regeln bleiben gespeichert. Eingeschaltet laufen die Container wieder, welche Ziele geprüft werden, stellen Sie danach unter Reverse-Proxy, CrowdSec ein.':
    'When switched off, HAPM removes CrowdSec from every target, stops both containers and hides CrowdSec in the interface. Bans, allowlist and rules stay stored. When switched on, the containers run again; choose which targets are checked afterwards under Reverse proxy, CrowdSec.',
  'WAF und Sperren für die Ziele hinter HAProxy.': 'WAF and bans for the targets behind HAProxy.',
  'CrowdSec verwenden': 'Use CrowdSec',
  'Kein Ziel wird geprüft, und beide Container stehen. Sperren, Freigaben und Regeln sind gespeichert und gelten wieder, sobald CrowdSec läuft.':
    'No target is checked, and both containers are stopped. Bans, allowlist and rules are stored and apply again as soon as CrowdSec runs.',
  'Erwartet wird enabled: true oder false.': 'Expected enabled: true or false.',
  'CrowdSec ist auf dieser Installation nicht vorhanden.': 'CrowdSec is not present on this installation.',
  'HAProxy ließ sich nicht umstellen, CrowdSec bleibt an. Was gescheitert ist, steht unter Logs, Vorgänge.':
    'HAProxy could not be switched over, CrowdSec stays on. What failed is under Logs, Tasks.',

  // Benachrichtigungen
  'CrowdSec prüft nicht': 'CrowdSec is not checking',
  'CrowdSec oder Bouncer läuft nicht, Anfragen gehen ungeprüft durch.':
    'CrowdSec or the bouncer is not running, requests pass unchecked.',
  Tagesbericht: 'Daily report',
  'Einmal am Tag, was CrowdSec erkannt hat. Nur, wenn etwas war.':
    'Once a day, what CrowdSec detected. Only if something happened.',
  'alle Ziele': 'all targets',
  'Der Bouncer von CrowdSec läuft nicht': 'The CrowdSec bouncer is not running',
  'Der Container {container} auf {node} läuft nicht.': 'The container {container} on {node} is not running.',
  'HAProxy erreicht den Bouncer nicht und lässt jede Anfrage ungeprüft durch, damit die Ziele erreichbar bleiben. Weder WAF noch Sperren wirken.':
    'HAProxy cannot reach the bouncer and lets every request through unchecked, so the targets stay reachable. Neither the WAF nor bans take effect.',
  'Die WAF prüft keine Anfrage, und aus dem Log von HAProxy entstehen keine neuen Sperren. Die Ziele bleiben erreichbar.':
    'The WAF checks no requests, and no new bans come from the HAProxy log. The targets stay reachable.',
  Geschützt: 'Protected',
  'CrowdSec ansehen': 'View CrowdSec',
  'CrowdSec: {count} Ereignis in 24 Stunden': 'CrowdSec: {count} event in 24 hours',
  'CrowdSec: {count} Ereignisse in 24 Stunden': 'CrowdSec: {count} events in 24 hours',
  'Was CrowdSec erkannt hat': 'What CrowdSec detected',
  'Zwischen {from} und {to} hat CrowdSec auf {node} {count} gemeldet.': 'Between {from} and {to}, CrowdSec on {node} reported {count}.',
  '{count} Ereignis': '{count} event',
  '{count} Ereignisse': '{count} events',
  'Erkannt im Log': 'Detected in the log',
  'Von Hand gesperrt': 'Banned manually',
  'Jetzt aktive Sperren': 'Bans active now',
  'Häufigste Regeln': 'Most frequent rules',
  'Häufigste Adressen': 'Most frequent addresses',
  'Betroffene Ziele': 'Affected targets',
  'Was zu tun ist: Nichts, solange die Treffer von außen kommen. Steht eine eigene Adresse oder die eines Nutzers darunter, gehört sie unter CrowdSec in die Freigaben.':
    'What to do: nothing, as long as the hits come from outside. If one of your own addresses or that of a user is listed, add it to the allowlist under CrowdSec.',
  'Ereignisse ansehen': 'View events',

  // Regeln, Anwendungen
  Anwendungen: 'Applications',
  Anwendung: 'Application',
  'Ausnahmen gegen bekannte Fehlsperren einzelner Anwendungen.':
    'Exclusions against known false bans of individual applications.',
  'Wirkt auf': 'Applies to',
  Log: 'Log',
  OWASP: 'OWASP',
  'Ausnahmen für die Erkennung im Log von HAProxy': 'Exclusions for detection in the HAProxy log',
  'Virtuelle Patches in der WAF': 'Virtual patches in the WAF',
  'Ausnahmen für die OWASP-Regeln': 'Exclusions for the OWASP rules',
  'Wirkt erst, wenn die OWASP-Regeln an sind.': 'Only takes effect when the OWASP rules are on.',
  'Nur ein Teil ist installiert. Einschalten holt den Rest.': 'Only part is installed. Switching on fetches the rest.',
  Teilweise: 'Partial',
  'Overseerr und Jellyseerr': 'Overseerr and Jellyseerr',

  // Regeln ändern: der Lauf im Hintergrund (`lib/crowdsec/rule-jobs.ts`), Pille und Fenster
  'CrowdSec-Regeln': 'CrowdSec rules',
  'CrowdSec-Regeln werden geändert': 'Changing CrowdSec rules',
  'CrowdSec-Regeln geändert': 'CrowdSec rules changed',
  'CrowdSec-Regeln: Änderung fehlgeschlagen': 'CrowdSec rules: change failed',
  'CrowdSec hat die Regeln neu geladen.': 'CrowdSec has reloaded the rules.',
  'OWASP-Regeln: aus': 'OWASP rules: off',
  '{name} einschalten': 'Switch on {name}',
  '{name} ausschalten': 'Switch off {name}',
  'CrowdSec neu laden': 'Reload CrowdSec',
  'Eine spätere Änderung hat diese ersetzt, bevor sie an der Reihe war.':
    'A later change replaced this one before its turn came.',
  'Matrix (Synapse, Element)': 'Matrix (Synapse, Element)',
  'Git-Server (GitLab, Gitea, Forgejo)': 'Git server (GitLab, Gitea, Forgejo)',
  'Nextcloud lädt Vorschaubilder, Avatare und Dateien über WebDAV in schneller Folge und antwortet dabei oft mit 403 oder 404, etwa für fehlende Vorschauen oder beim Hochladen. CrowdSec hält das für einen Scanner und sperrt die eigenen Nutzer. Die Ausnahmen aus dem Hub nehmen WebDAV, Vorschauen, Fotos, Memories, Mail, Text und Lesezeichen aus. HAPM ergänzt Fälle, die dort noch fehlen: den Abgleich der Mobil-App (HEAD auf WebDAV), Kalender und Kontakte mit 403, abgelaufene Sitzungen im Text-Editor, Karten in Deck, die Anmeldung neuer Geräte und Talk. Dazu kommen Ausnahmen für die OWASP-Regeln, die sonst Dateinamen, Kalender und Kontakte als Angriff lesen. Die wirken nur, wenn die OWASP-Regeln an sind.':
    'Nextcloud loads previews, avatars and files over WebDAV in quick succession and often answers 403 or 404, for missing previews or while uploading. CrowdSec takes that for a scanner and bans your own users. The exclusions from the hub cover WebDAV, previews, Photos, Memories, Mail, Text and Bookmarks. HAPM adds cases still missing there: the mobile app sync (HEAD on WebDAV), calendars and contacts with 403, expired sessions in the text editor, cards in Deck, signing in new devices and Talk. On top come exclusions for the OWASP rules, which otherwise read file names, calendars and contacts as attacks. Those only apply when the OWASP rules are on.',
  'Zwei Teile. Virtuelle Patches: die WAF lehnt Anfragen auf bekannte Lücken in WordPress und verbreiteten Plugins ab, auch wenn das Update noch fehlt. Ausnahmen für die OWASP-Regeln: Block-Editor, REST-API und Verwaltung schicken HTML, Skripte und Shortcodes im Text, die die OWASP-Regeln sonst als XSS oder Injection sperren. Die Ausnahmen wirken nur, wenn die OWASP-Regeln an sind.':
    'Two parts. Virtual patches: the WAF rejects requests for known vulnerabilities in WordPress and common plugins, even before the update is installed. Exclusions for the OWASP rules: the block editor, REST API and admin area send HTML, scripts and shortcodes in the body, which the OWASP rules would otherwise block as XSS or injection. The exclusions only apply when the OWASP rules are on.',
  'Drupal schickt beim Bearbeiten von Inhalten und in der Verwaltung HTML und Formulardaten, die die OWASP-Regeln als Angriff lesen, etwa aus dem Text-Editor oder den Ansichten (Views). Die Ausnahmen des OWASP-Projekts nehmen diese Felder aus. Wirkt nur, wenn die OWASP-Regeln an sind.':
    'When editing content and in the admin area, Drupal sends HTML and form data that the OWASP rules read as attacks, for example from the text editor or Views. The exclusions from the OWASP project cover these fields. Only applies when the OWASP rules are on.',
  'phpMyAdmin schickt SQL im Klartext, das ist seine Aufgabe. Ohne Ausnahmen sperren die OWASP-Regeln jede Abfrage als SQL-Injection. Die Ausnahmen nehmen die Felder für SQL und Import aus. Wirkt nur, wenn die OWASP-Regeln an sind. Besser ist, phpMyAdmin gar nicht öffentlich erreichbar zu machen (Passwortschutz oder Sperre nach Adresse am Ziel).':
    'phpMyAdmin sends plain SQL, that is its job. Without exclusions the OWASP rules block every query as SQL injection. The exclusions cover the SQL and import fields. Only applies when the OWASP rules are on. Better still, do not make phpMyAdmin publicly reachable at all (password protection or address restriction on the target).',
  'DokuWiki speichert Seiten als Wiki-Text mit Code-Blöcken, Links und HTML. Beim Speichern und in der Vorschau lesen die OWASP-Regeln das als XSS oder Injection. Die Ausnahmen nehmen den Editor und die Verwaltung aus. Wirkt nur, wenn die OWASP-Regeln an sind.':
    'DokuWiki stores pages as wiki text with code blocks, links and HTML. On save and in the preview the OWASP rules read that as XSS or injection. The exclusions cover the editor and the admin area. Only applies when the OWASP rules are on.',
  'Beiträge mit BBCode, Code-Schnipseln oder Links lösen die OWASP-Regeln aus, ebenso Teile der Verwaltung. Die Ausnahmen nehmen Beitragstext, Vorschau und Verwaltung aus. Wirkt nur, wenn die OWASP-Regeln an sind.':
    'Posts with BBCode, code snippets or links trigger the OWASP rules, as do parts of the admin area. The exclusions cover post text, preview and admin area. Only applies when the OWASP rules are on.',
  'Dateimanager, Editor und Einstellungen von cPanel und WHM schicken Pfade, Code und Befehle, die die OWASP-Regeln sperren. Die Ausnahmen nehmen diese Bereiche aus. Wirkt nur, wenn die OWASP-Regeln an sind.':
    'The file manager, editor and settings of cPanel and WHM send paths, code and commands that the OWASP rules block. The exclusions cover these areas. Only applies when the OWASP rules are on.',
  'Die Apps von Jellyfin melden beim Abspielen laufend den Fortschritt, und viele Clients fragen beim Blättern Bilder ab, die es nicht gibt (Roku, Swiftfin, Infuse). Die Antworten 403 und 404 sehen für CrowdSec wie ein Scanner aus. Der Hub nimmt den Fortschritt und die Vorschaubilder aus. HAPM ergänzt Hintergrundbilder, Untertitel (Swiftfin und VLC mit „Immer abspielen“) und den Startbildschirm von Swiftfin auf dem Apple TV.':
    'The Jellyfin apps report playback progress continuously, and many clients request images that do not exist while browsing (Roku, Swiftfin, Infuse). The 403 and 404 answers look like a scanner to CrowdSec. The hub covers progress and thumbnails. HAPM adds backdrops, subtitles (Swiftfin and VLC with "Always play") and the Swiftfin splash screen on Apple TV.',
  'Plex holt beim Abspielen und Blättern viele Segmente, Untertitel, Vorschaubilder und Metadaten, teils mit 403 oder 404 als Antwort. Das sieht für CrowdSec wie ein Scanner aus. Der Hub nimmt Transcoder, Timeline, Metadaten und Wiedergabelisten aus. Neuere Apps (etwa auf dem Apple TV) laden beim Stöbern zusätzlich Dutzende Übersichten in wenigen Sekunden, das gilt als Crawler. HAPM nimmt diese Abfragen (/hubs, /library, /playlists und andere) bei Antwort 200 aus.':
    'While playing and browsing, Plex fetches many segments, subtitles, thumbnails and metadata, some answered with 403 or 404. That looks like a scanner to CrowdSec. The hub covers the transcoder, timeline, metadata and play queues. Newer apps (for example on Apple TV) also load dozens of overviews within seconds while browsing, which counts as a crawler. HAPM excludes these requests (/hubs, /library, /playlists and others) when they answer 200.',
  'Beim Blättern fragen Overseerr und Jellyseerr für jeden Film und jede Serie eine eigene Adresse ab (/api/v1/movie/123). Viele verschiedene Adressen ohne Dateiendung in kurzer Zeit hält CrowdSec für einen Crawler. Die Ausnahmen nehmen diese Abfragen aus.':
    'While browsing, Overseerr and Jellyseerr request a separate address for every movie and series (/api/v1/movie/123). CrowdSec takes many different addresses without a file extension in a short time for a crawler. The exclusions cover these requests.',
  'Element und andere Matrix-Clients fragen beim Öffnen von Räumen nach Zuständen, Ereignissen und Geräten, die es oft nicht gibt, und bekommen 404. Vorschaubilder und Linkvorschauen kommen als viele einzelne Adressen. CrowdSec sperrt deshalb aktive Nutzer als Scanner oder Crawler. Der Hub hat dafür nichts. HAPM nimmt die belegten Fälle aus: Verschlüsselung und Ereignisse von Räumen, Geräte, Föderation, Relationen, Vorschaubilder, Linkvorschau, Anmeldedaten, TURN-Server und /.well-known/matrix.':
    'When opening rooms, Element and other Matrix clients ask for states, events and devices that often do not exist, and get 404. Thumbnails and link previews come as many separate addresses. CrowdSec therefore bans active users as scanners or crawlers. The hub has nothing for this. HAPM excludes the documented cases: room encryption and events, devices, federation, relations, thumbnails, link preview, auth metadata, TURN server and /.well-known/matrix.',
  'Immich lädt in der Zeitleiste jedes Vorschaubild über eine eigene Adresse (/api/assets/…/thumbnail). Beim Scrollen durch eine große Bibliothek sind das Hunderte Abrufe ohne Dateiendung, die CrowdSec für einen Crawler hält. Der Hub hat dafür nichts. HAPM nimmt die Vorschaubilder aus.':
    'In the timeline, Immich loads every thumbnail from its own address (/api/assets/…/thumbnail). Scrolling through a large library means hundreds of requests without a file extension, which CrowdSec takes for a crawler. The hub has nothing for this. HAPM excludes the thumbnails.',
  'Der Sync-Client von Seafile holt Dateien in Blöcken, jeden Block über eine eigene Adresse ohne Dateiendung. Schon ein einziger Abgleich sieht für CrowdSec deshalb wie ein Crawler aus. Der Hub hat dafür nichts. HAPM nimmt die Blöcke aus.':
    'The Seafile sync client fetches files in blocks, each block from its own address without a file extension. A single sync therefore looks like a crawler to CrowdSec. The hub has nothing for this. HAPM excludes the blocks.',
  'Der Document Server von ONLYOFFICE lädt Schriften als Dateien ohne Endung, für ein einziges Dokument oft über achtzig. Dazu kommt die Verbindung des Editors (WebSocket). CrowdSec hält das für einen Crawler. Der Hub hat dafür nichts. HAPM nimmt Schriften und Editor-Verbindung aus, auch unter einem Unterpfad wie /onlyoffice.':
    'The ONLYOFFICE Document Server loads fonts as files without an extension, often more than eighty for a single document. On top comes the editor connection (WebSocket). CrowdSec takes that for a crawler. The hub has nothing for this. HAPM excludes fonts and the editor connection, also under a sub path such as /onlyoffice.',
  'Audio Station und File Station holen Cover und Vorschaubilder über dieselbe Adresse mit wechselnden Parametern. Fehlt ein Bild, antwortet DSM mit 404. Weil sich die Parameter unterscheiden, zählt CrowdSec jede Anfrage als eigenen Versuch eines Scanners. Der Hub hat dafür nichts. HAPM nimmt diese beiden Abrufe aus.':
    'Audio Station and File Station fetch covers and thumbnails from the same address with changing parameters. If an image is missing, DSM answers 404. Because the parameters differ, CrowdSec counts every request as a separate scanner attempt. The hub has nothing for this. HAPM excludes these two requests.',
  'Die App von Audiobookshelf lädt nach der Einrichtung die Bilder aller Autoren. Fehlt eins auf dem Server, antwortet er mit 404, und viele davon hintereinander sehen für CrowdSec wie ein Scanner aus. Der Hub hat dafür nichts. HAPM nimmt die Autorenbilder aus.':
    'After setup, the Audiobookshelf app loads the images of all authors. If one is missing on the server, it answers 404, and many of those in a row look like a scanner to CrowdSec. The hub has nothing for this. HAPM excludes the author images.',
  'Clients wie Substreamer fragen Bilder von Künstlern ab, die es nicht gibt. Navidrome antwortet mit 404, und viele davon hintereinander sehen für CrowdSec wie ein Scanner aus. Der Hub hat dafür nichts. HAPM nimmt diese Bildabrufe aus.':
    'Clients such as Substreamer request artist images that do not exist. Navidrome answers 404, and many of those in a row look like a scanner to CrowdSec. The hub has nothing for this. HAPM excludes these image requests.',
  'Wer ein Repository über HTTPS holt, etwa als Submodul, ruft Adressen auf, die auf .git enden. Genau diese Endung sucht CrowdSec bei Scannern, die nach versehentlich veröffentlichten Repositories suchen, und sperrt nach wenigen Abrufen. Belegt ist das für GitLab, bei Gitea und Forgejo sehen die Adressen gleich aus. HAPM nimmt Abrufe der Form /gruppe/projekt.git aus, wenn der Server sie beantwortet (200, Weiterleitung oder Anmeldung). Eine Anfrage auf /.git, wie Scanner sie stellen, bleibt erkannt.':
    'Fetching a repository over HTTPS, for example as a submodule, requests addresses ending in .git. CrowdSec looks for exactly this ending from scanners searching for accidentally published repositories, and bans after a few requests. This is documented for GitLab; Gitea and Forgejo use the same addresses. HAPM excludes requests of the form /group/project.git when the server answers them (200, redirect or sign-in). A request for /.git, as scanners send it, is still detected.',
  'Rocket.Chat lädt die Avatare aller Mitglieder eines Raums einzeln. Die vielen Abrufe unter /avatar/ hält CrowdSec für einen Crawler. Die Ausnahme nimmt sie aus.':
    'Rocket.Chat loads the avatars of all members of a room one by one. CrowdSec takes the many requests under /avatar/ for a crawler. The exclusion covers them.',
  'Zammad lädt Anhänge von Tickets über je eine eigene Adresse, und die Vorschau eines Anhangs ohne Recht antwortet mit 403. Beides kann für CrowdSec wie ein Crawler oder Scanner aussehen. Die Ausnahmen nehmen die Anhänge aus.':
    'Zammad loads ticket attachments from one address each, and previewing an attachment without permission answers 403. Both can look like a crawler or scanner to CrowdSec. The exclusions cover the attachments.',
  'Calibre-Web lädt jedes Buchcover über eine eigene Adresse. Eine Bibliothek mit vielen Büchern sieht für CrowdSec deshalb wie ein Crawler aus. Die Ausnahme nimmt die Cover aus.':
    'Calibre-Web loads every book cover from its own address. A library with many books therefore looks like a crawler to CrowdSec. The exclusion covers the covers.',
  'Actual Budget lädt beim Start die Migrationen seiner Datenbank als einzelne .sql-Dateien. Viele solche Abrufe in kurzer Zeit sehen für CrowdSec wie ein Crawler aus. Die Ausnahme nimmt diese Pfade aus.':
    'On start, Actual Budget loads its database migrations as individual .sql files. Many such requests in a short time look like a crawler to CrowdSec. The exclusion covers these paths.',
  'Music Assistant lädt Cover über /imageproxy/ mit einer langen Kennung je Bild, fehlende Bilder antworten mit 404. Das sieht für CrowdSec wie ein Crawler oder Scanner aus. Die Ausnahme nimmt diese Abrufe aus.':
    'Music Assistant loads covers via /imageproxy/ with a long identifier per image, and missing images answer 404. That looks like a crawler or scanner to CrowdSec. The exclusion covers these requests.',

  // Logs und Statistik
  'Was CrowdSec und sein Bouncer melden, die neueste Zeile oben.':
    'What CrowdSec and its bouncer report, newest line first.',
  Verkehr: 'Traffic',
  'Was CrowdSec erkannt und abgelehnt hat: WAF-Treffer, Szenarien, Sperren.': 'What CrowdSec detected and rejected: WAF hits, scenarios, bans.',
  'Bouncer für HAProxy': 'Bouncer for HAProxy',
  Container: 'Container',
  'Den Container gibt es nicht': 'The container does not exist',
  '{name} läuft auf diesem Server nicht. Ist CrowdSec bei der Installation abgewählt worden?':
    '{name} is not running on this server. Was CrowdSec deselected at installation?',
  'Alle Meldungen': 'All messages',
  'Warnungen und Fehler': 'Warnings and errors',
  'Nur Fehler': 'Errors only',
  'Routine-Anfragen': 'Routine requests',
  'Keine passenden Zeilen': 'No matching lines',
  '{count} Routine-Anfrage an die lokale API ist ausgeblendet.': '{count} routine request to the local API is hidden.',
  '{count} Routine-Anfragen an die lokale API sind ausgeblendet.': '{count} routine requests to the local API are hidden.',
  'Im gelesenen Teil des Logs steht nichts, das zu den Filtern passt.': 'Nothing in the part of the log that was read matches the filters.',
  '{count} Zeile': '{count} line',
  '{count} Zeilen': '{count} lines',
  '{count} Routine-Anfrage ausgeblendet': '{count} routine request hidden',
  '{count} Routine-Anfragen ausgeblendet': '{count} routine requests hidden',
  Stufe: 'Level',
  Bereich: 'Area',
  'WAF-Treffer': 'WAF hits',
  Szenarien: 'Scenarios',
  'Zu den Ereignissen': 'Go to events',
  'Verschiedene Adressen': 'Distinct addresses',
  'Ereignisse je Tag': 'Events per day',
  'Ereignisse je Stunde': 'Events per hour',
  'WAF-Treffer sind abgelehnte Anfragen mit einem bekannten Angriff. Szenarien sind Adressen, die im Log von HAProxy aufgefallen sind, meist mit Sperre. Von Hand sind Sperren aus HAPM oder cscli.':
    'WAF hits are rejected requests with a known attack. Scenarios are addresses noticed in the HAProxy log, usually with a ban. By hand are bans from HAPM or cscli.',

  // Updates
  'Der Container von CrowdSec wird durch das neue Abbild ersetzt. Sperren, Freigaben und Regeln bleiben, sie liegen im Ordner der Daten. Während des Tauschs gehen Anfragen ungeprüft durch.':
    'The CrowdSec container is replaced with the new image. Bans, allowlist and rules stay, they live in the data folder. During the swap, requests pass unchecked.',
  'Der Bouncer wird durch das neue Abbild ersetzt. Während des Tauschs gehen Anfragen ungeprüft durch.':
    'The bouncer is replaced with the new image. During the swap, requests pass unchecked.',

  // Ziel-Dialog und Karte
  'CrowdSec prüft die Anfragen an dieses Ziel.': 'CrowdSec checks the requests to this target.',
  'CrowdSec prüft die Anfragen an alle Ziele.': 'CrowdSec checks the requests to all targets.',
  'CrowdSec-Ereignisse dieses Ziels': 'CrowdSec events of this target',
  'CrowdSec prüft jede Anfrage an dieses Ziel: bekannte Angriffe (WAF) und Adressen, die gesperrt sind. Abgelehnt wird mit 403. Antwortet CrowdSec nicht, gehen Anfragen durch. Sperren und Freigaben stehen unter Reverse-Proxy, CrowdSec.':
    'CrowdSec checks every request to this target: known attacks (WAF) and banned addresses. Rejections use 403. If CrowdSec does not respond, requests go through. Bans and allowlist are under Reverse proxy, CrowdSec.',
  'CrowdSec ist bei dieser Installation abgeschaltet.': 'CrowdSec is turned off for this installation.',
  'Gilt schon für alle Ziele.': 'Already applies to all targets.',
  'Gilt schon für alle Ziele. Der eigene Schalter ist überflüssig.':
    "Already applies to all targets. This target's own switch is redundant.",
  'Anfragen an dieses Ziel prüft CrowdSec.': 'CrowdSec checks requests to this target.',
  'Anfragen an dieses Ziel prüft CrowdSec nicht.': 'CrowdSec does not check requests to this target.',

  // Assistent und Einrichtung
  'CrowdSec (WAF) für alle Ziele einschalten': 'Turn on CrowdSec (WAF) for all targets',
  'Empfohlen für einen Server im Internet. CrowdSec prüft jede Anfrage auf bekannte Angriffe und sperrt Adressen, die scannen oder Passwörter raten. Abgelehnt wird mit 403. Später unter Reverse-Proxy, CrowdSec zu ändern, auch je Ziel.':
    'Recommended for a server on the internet. CrowdSec checks every request for known attacks and bans addresses that scan or guess passwords. Rejections use 403. Can be changed later under Reverse proxy, CrowdSec, also per target.',
  'CrowdSec für alle Ziele einschalten': 'Turn on CrowdSec for all targets',
  'Ist schon eingeschaltet.': 'Already turned on.',
  'Eingeschaltet. Sperren und Freigaben stehen unter Reverse-Proxy, CrowdSec.': 'Turned on. Bans and allowlist are under Reverse proxy, CrowdSec.',
  'Der Ordner für CrowdSec ist nicht eingebunden.': 'The CrowdSec folder is not mounted.',

  // Meldungen der Routen
  'Bitte eine Adresse oder ein Netz angeben, etwa 203.0.113.7 oder 198.51.100.0/24.':
    'Please enter an address or a network, for example 203.0.113.7 or 198.51.100.0/24.',
  'Diese Dauer gibt es nicht.': 'This duration does not exist.',
  'Diese Sperre gibt es nicht.': 'This ban does not exist.',
  '{value} ist schon freigegeben.': '{value} is already allowed.',
  '{value} steht nicht in der Freigabeliste.': '{value} is not on the allowlist.',
  'Das Ziel {id} gibt es nicht.': 'The target {id} does not exist.',
  'Diese Regelsammlung lässt sich hier nicht schalten.': 'This rule collection cannot be switched here.',
  'Was soll sich ändern? Erwartet wird crs, app oder name mit installed, oder upgrade.':
    'What should change? Expected crs, app or name with installed, or upgrade.',
  'Für diese Anwendung gibt es hier keine Regeln.': 'There are no rules for this application here.',
  'CrowdSec ist nicht erreichbar: {detail}': 'CrowdSec is not reachable: {detail}',
  'CrowdSec ist nicht erreichbar. Läuft der Container {name}?': 'CrowdSec is not reachable. Is the container {name} running?',
  'CrowdSec lehnt ab: {detail}': 'CrowdSec refuses: {detail}',
  'CrowdSec prüft Anfragen an ein Backend mit Zielen. Eine Weiterleitung hat keine.':
    'CrowdSec checks requests to a backend with servers. A redirect has none.',
  'In {file} war keine Stelle für CrowdSec zu finden: gesucht wird die letzte bind-Zeile des Frontends mit "{marker}".':
    'No place for CrowdSec found in {file}: looking for the last bind line of the frontend with "{marker}".',
  'Erkannte Angriffe stehen unter CrowdSec, Ereignisse.': 'Detected attacks are under CrowdSec, Events.',
  'Der normale Betrieb mancher Anwendungen sieht für CrowdSec wie ein Angriff aus, etwa viele Antworten mit 404 in kurzer Zeit. Dann sperrt es die eigenen Nutzer. Die Ausnahmen nehmen diese bekannten Fälle aus der Prüfung. Für WordPress kommen virtuelle Patches gegen bekannte Lücken dazu.': 'The normal operation of some applications looks like an attack to CrowdSec, for example many 404 responses in a short time. It then bans your own users. The exclusions exempt these known cases from the check. For WordPress, virtual patches against known vulnerabilities are added.',
  'CrowdSec leeren?': 'Clear CrowdSec?',
  'Entfernt alle Ereignisse und hebt die Sperren auf, die CrowdSec daraus verhängt hat. Statistik und Zähler beginnen bei null. Sperren von Hand, Freigaben, Regeln und die Gemeinschaftsliste bleiben. Das dauert bis zu einer Minute.': 'Removes all events and lifts the bans CrowdSec imposed from them. Statistics and counters start at zero. Manual bans, the allowlist, rules and the community blocklist stay. This takes up to a minute.',
  'Leeren': 'Clear',
  'Leeren fehlgeschlagen': 'Clearing failed',
  'CrowdSec ist geleert': 'CrowdSec is cleared',
  'Diese Sperren von Hand ließen sich nicht wieder setzen: {values}': 'These manual bans could not be set again: {values}',
  '{alerts} Ereignisse entfernt, {bans} Sperren aufgehoben.': '{alerts} events removed, {bans} bans lifted.',
  '{count} Sperre von Hand gilt weiter.': '{count} manual ban stays in place.',
  '{count} Sperren von Hand gelten weiter.': '{count} manual bans stay in place.',
  'CrowdSec leeren': 'Clear CrowdSec',
  'CrowdSec wird gerade geleert.': 'CrowdSec is being cleared right now.',
  'Die Sperren sind aufgehoben, aber der Bouncer hat sie noch nicht abgeholt. Die Ereignisse stehen noch da. Bitte gleich noch einmal versuchen.': 'The bans are lifted, but the bouncer has not fetched them yet. The events are still there. Please try again in a moment.',
  'Anfragen gehen ungeprüft durch.': 'Requests pass unchecked.',
  'Prüft das eine Ziel.': 'Checks the one target.',
  'Prüft alle {count} Ziele.': 'Checks all {count} targets.',
  'Prüft {count} von {total} Zielen.': 'Checks {count} of {total} targets.',
  'Eingebunden über einen eigenen Block in haproxy.cfg.': 'Included through a custom block in haproxy.cfg.',
  'Prüft nichts': 'Checks nothing',
  'Läuft, aber kein Ziel ist eingeschaltet.': 'Running, but no target is switched on.',
  'CrowdSec prüft jede Anfrage an ein geschütztes Ziel auf bekannte Angriffe und lehnt sie mit 403 ab (WAF). Es liest das Log von HAProxy und sperrt Adressen, die scannen oder raten. Dazu sperrt es Adressen, die anderen CrowdSec-Installationen aufgefallen sind (Gemeinschaftsliste).': 'CrowdSec checks every request to a protected target for known attacks and rejects it with 403 (WAF). It reads the HAProxy log and bans addresses that scan or guess. It also bans addresses that other CrowdSec installations have noticed (community blocklist).',
  'Verlauf': 'History',
  'WAF-Treffer (24 h)': 'WAF hits (24 h)',
  'Ereignisse (24 h)': 'Events (24 h)',
  'Geschützte Ziele': 'Protected targets',
  'Die Ziele, deren Anfragen CrowdSec prüft.': 'The targets whose requests CrowdSec checks.',
  'Der Block „# CrowdSec“ in haproxy.cfg ist von Hand geändert. Der Schalter ist deshalb gesperrt.': 'The block "# CrowdSec" in haproxy.cfg was edited by hand. The switch is therefore locked.',
  'Wird übernommen. HAProxy wird neu geladen.': 'Being applied. HAProxy is reloading.',
  '„Alle Ziele prüfen“ ist an: CrowdSec prüft jedes Ziel, auch jedes neue.': '"Check all targets" is on: CrowdSec checks every target, including every new one.',
  'Am Ziel selbst eingeschaltet. Bleibt geprüft, auch wenn der Schalter für alle aus ist.': 'Switched on at the target itself. Stays checked even when the switch for all is off.',
  'Ereignisse von {target}': 'Events of {target}',
  'Noch kein Ziel': 'No target yet',
  'Sobald es Ziele gibt, stehen hier die, die CrowdSec prüft.': 'Once there are targets, the ones CrowdSec checks are listed here.',
  'Kein Ziel wird geschützt': 'No target is protected',
  'Oben „Alle Ziele prüfen“ einschalten, oder CrowdSec im Dialog eines Ziels.': 'Switch on "Check all targets" above, or CrowdSec in the dialog of a target.',
  '{count} weiteres Ziel prüft CrowdSec nicht.': 'CrowdSec does not check {count} other target.',
  '{count} weitere Ziele prüft CrowdSec nicht.': 'CrowdSec does not check {count} other targets.',
  'Adressen, die bei vielen CrowdSec-Installationen aufgefallen sind. CrowdSec bezieht sie von seiner Zentrale und sperrt sie vorab. Eine neue Installation bekommt die Liste erst nach einiger Zeit: 0 ist am Anfang normal.':
    'Addresses that many CrowdSec installations have noticed. CrowdSec gets them from its central service and bans them in advance. A new installation only receives the list after some time: 0 is normal at the start.',

  // Gründe von Ereignissen und Sperren in Worten (lib/crowdsec/describe.ts)
  'Bei CrowdSec: {name}': 'In CrowdSec: {name}',
  'Zugriff auf Dateien des Servers': 'Access to server files',
  'Die Anfrage nennt einen Pfad zu Dateien auf dem Server, etwa ../, /etc/passwd oder .env. So suchen Angreifer nach Passwörtern und Schlüsseln. Fachbegriff: Local File Inclusion (LFI).':
    'The request names a path to files on the server, such as ../, /etc/passwd or .env. Attackers use this to look for passwords and keys. Technical term: Local File Inclusion (LFI).',
  'Eingeschleuste Datenbankabfrage': 'Injected database query',
  "Die Anfrage enthält SQL, etwa ' OR 1=1 oder UNION SELECT. Ziel ist, Daten aus der Datenbank der Anwendung zu lesen oder zu ändern. Fachbegriff: SQL-Injection.":
    "The request contains SQL, such as ' OR 1=1 or UNION SELECT. The goal is to read or change data in the application's database. Technical term: SQL injection.",
  'Eingeschleustes Skript': 'Injected script',
  'Die Anfrage enthält JavaScript oder HTML, etwa <script>. Eine verwundbare Seite würde es anderen Besuchern ausliefern. Fachbegriff: Cross-Site-Scripting (XSS).':
    'The request contains JavaScript or HTML, such as <script>. A vulnerable page would serve it to other visitors. Technical term: cross-site scripting (XSS).',
  'Angriff auf eine bekannte Lücke': 'Attack on a known vulnerability',
  'Die Anfrage passt zu einem veröffentlichten Angriff auf eine bestimmte Software. Steht im Namen der Regel eine CVE-Nummer, ist das die Kennung der Lücke.':
    'The request matches a published attack on a specific piece of software. If the rule name contains a CVE number, that is the ID of the vulnerability.',
  'Einbinden fremder Dateien': 'Inclusion of remote files',
  'Die Anfrage übergibt eine Adresse im Internet als Parameter. Eine verwundbare Anwendung würde Code von dort laden und ausführen. Fachbegriff: Remote File Inclusion (RFI).':
    'The request passes an internet address as a parameter. A vulnerable application would load code from there and run it. Technical term: Remote File Inclusion (RFI).',
  'Eingeschleuste Befehle': 'Injected commands',
  'Die Anfrage enthält Befehle für die Kommandozeile des Servers, etwa ; cat oder | sh. Ziel ist, auf dem Server Programme auszuführen. Fachbegriff: Remote Code Execution (RCE). Bei Anwendungen, die Abfragen oder Code als Text schicken (GraphQL, Editoren), oft ein Fehlalarm.':
    "The request contains commands for the server's command line, such as ; cat or | sh. The goal is to run programs on the server. Technical term: Remote Code Execution (RCE). Often a false positive for applications that send queries or code as text (GraphQL, editors).",
  'Eingeschleuster PHP-Code': 'Injected PHP code',
  'Die Anfrage enthält PHP-Code oder Aufrufe wie eval( oder system(. Ziel ist, ihn auf dem Server auszuführen.':
    'The request contains PHP code or calls such as eval( or system(. The goal is to run it on the server.',
  'Fehlerhafte Anfrage': 'Malformed request',
  'Die Anfrage verstößt gegen die Regeln von HTTP, etwa mit doppelten oder widersprüchlichen Kopfzeilen. Damit versuchen Angreifer, Prüfungen zu umgehen.':
    'The request breaks the rules of HTTP, for example with duplicate or contradictory headers. Attackers use this to get around checks.',
  'Untergeschobene Sitzung': 'Planted session',
  'Die Anfrage setzt eine Sitzungskennung von außen. Ziel ist, später die Anmeldung eines anderen Nutzers zu übernehmen.':
    "The request sets a session ID from outside. The goal is to take over another user's sign-in later.",
  'Auffällige Anfrage': 'Suspicious request',
  'Eine allgemeine Regel des OWASP-Regelwerks hat angeschlagen, etwa für eine gesperrte Dateiendung (.asax, .ini, .bak), eine unübliche HTTP-Version oder fehlende Kopfzeilen.':
    'A general rule of the OWASP rule set matched, for example a blocked file extension (.asax, .ini, .bak), an unusual HTTP version or missing headers.',
  'Nur gemeldet, die Anfrage ging durch. Schickt eine Adresse mehrere solcher Anfragen, sperrt CrowdSec sie.':
    'Only reported, the request went through. If an address sends several such requests, CrowdSec bans it.',
  'Viele Abrufe von Seiten, die es nicht gibt': 'Many requests for pages that do not exist',
  'Die Adresse hat in kurzer Zeit viele Seiten abgerufen, die mit 404 antworteten. So suchen Scanner nach bekannten Dateien und Programmen.':
    'The address requested many pages in a short time that answered with 404. Scanners do this to look for known files and programs.',
  'Suche nach vertraulichen Dateien': 'Search for confidential files',
  'Die Adresse hat Dateien abgerufen, die nicht öffentlich sein sollten, etwa Sicherungen, Konfiguration oder .env.':
    'The address requested files that should not be public, such as backups, configuration or .env.',
  'Sehr viele Seitenabrufe': 'Very many page requests',
  'Die Adresse hat in kurzer Zeit sehr viele Seiten abgerufen, die keine Bilder, Skripte oder Stylesheets sind. Typisch für Scanner und aggressive Crawler.':
    'The address requested a very large number of pages in a short time that are not images, scripts or stylesheets. Typical for scanners and aggressive crawlers.',
  'Suche nach Verwaltungsoberflächen': 'Search for admin interfaces',
  'Die Adresse hat Anmeldeseiten und Verwaltungen bekannter Programme abgerufen, etwa /wp-admin oder /phpmyadmin.':
    'The address requested sign-in pages and admin areas of well-known programs, such as /wp-admin or /phpmyadmin.',
  'Erkundung der eingesetzten Software': 'Probing for the software in use',
  'Die Adresse hat Dateien abgerufen, an denen man erkennt, welche Software ein Server einsetzt. Das geht einem gezielten Angriff oft voraus.':
    'The address requested files that reveal which software a server runs. This often comes before a targeted attack.',
  'Bekanntes Angriffswerkzeug': 'Known attack tool',
  'Die Anfragen tragen die Kennung eines Scanners oder Angriffswerkzeugs (User-Agent).':
    'The requests carry the identifier of a scanner or attack tool (user agent).',
  'Suche nach Hintertüren': 'Search for backdoors',
  'Die Adresse hat Dateien abgerufen, die Angreifer auf übernommenen Servern hinterlassen (Web-Shells).':
    'The address requested files that attackers leave behind on compromised servers (web shells).',
  'Missbrauch als Proxy': 'Abuse as a proxy',
  'Die Adresse hat versucht, über den Server fremde Seiten abzurufen.': 'The address tried to fetch other websites through the server.',
  'Abruf einer .env-Datei': 'Request for a .env file',
  'In einer .env-Datei stehen oft Passwörter und Schlüssel für Datenbanken und andere Dienste.':
    'A .env file often holds passwords and keys for databases and other services.',
  'Abruf von Git-Daten': 'Request for Git data',
  'Im Ordner .git liegt der Quelltext einer Website samt Verlauf. Ist er erreichbar, lässt sich der ganze Code herunterladen.':
    "The .git folder holds a website's source code and its history. If it is reachable, the whole code can be downloaded.",
  'Wiederholte Angriffe auf bekannte Lücken': 'Repeated attacks on known vulnerabilities',
  'Die Adresse hat mehrere Anfragen geschickt, die eine Regel gegen bekannte Lücken erkannt hat.':
    'The address sent several requests that a rule against known vulnerabilities detected.',
  'Wiederholt auffällige Anfragen': 'Repeated suspicious requests',
  'Die Adresse hat in kurzer Zeit mehrere Anfragen geschickt, die gegen das OWASP-Regelwerk verstoßen. Einzeln gehen solche Anfragen durch, gehäuft führen sie zu einer Sperre.':
    'The address sent several requests in a short time that break the OWASP rule set. Individually such requests go through, but many of them lead to a ban.',
  'Passwörter durchprobiert': 'Password guessing',
  'Die Adresse hat sich in kurzer Zeit oft mit falschem Passwort angemeldet.':
    'The address tried to sign in with a wrong password many times in a short period.',
  'Angriff auf WordPress': 'Attack on WordPress',
  'Die Adresse hat WordPress nach Nutzern, Konfiguration oder bekannten Lücken abgesucht.':
    'The address probed WordPress for users, configuration or known vulnerabilities.',
  'Überlastungsversuch': 'Overload attempt',
  'Die Adresse hat so viele oder so ungewöhnliche Anfragen geschickt, dass sie den Dienst lahmlegen könnten.':
    'The address sent so many or such unusual requests that they could take the service down.',

  // OWASP an oder aus (RulesPanel, Übersicht, Warteschlange)
  'An': 'On',
  'Erkennt auch Angriffe, für die es noch keinen Patch gibt.': 'Also detects attacks that have no patch yet.',
  'Prüft auf SQL-Injection, XSS, eingeschleuste Befehle und Zugriffe auf Dateien.':
    'Checks for SQL injection, XSS, injected commands and file access.',
  'Ein Angriff wird abgewiesen, bevor er die Anwendung erreicht.':
    'An attack is rejected before it reaches the application.',
  'Weist auch harmlose Anfragen ab, etwa aus Editoren, Formularen mit Code oder GraphQL.':
    'Also rejects harmless requests, for example from editors, forms with code or GraphQL.',
  'Wen das trifft, sieht nur eine Fehlerseite (403) und kann die Anwendung nicht benutzen.':
    'Anyone affected only sees an error page (403) and cannot use the application.',
  'Fehltreffer zeigen erst die Ereignisse. Abhilfe: Ausnahmen für Anwendungen oder Freigaben.':
    'False positives only show up under Events. Remedy: exclusions for applications or the allowlist.',
  'OWASP-Regeln einschalten?': 'Turn on the OWASP rules?',
  'Ab dann weist HAProxy jede Anfrage mit einem Treffer sofort ab, auch harmlose. Danach unter Ereignisse nachsehen, ob eigene Anwendungen betroffen sind.':
    'From then on HAProxy rejects every request with a hit right away, harmless ones too. Afterwards check under Events whether your own applications are affected.',
  'Eine freie Regelsammlung für Web Application Firewalls, gepflegt vom OWASP-Projekt. Sie prüft jede Anfrage auf typische Angriffsmuster. Die virtuellen Patches, die immer an sind, fangen nur bekannte Lücken bestimmter Programme ab. Die OWASP-Regeln erkennen auch Unbekanntes, treffen dafür aber manchmal harmlose Anfragen. Deshalb sind sie aus, bis Sie sie einschalten.':
    'A free rule set for web application firewalls, maintained by the OWASP project. It checks every request for typical attack patterns. The virtual patches, which are always on, only catch known vulnerabilities of specific programs. The OWASP rules also detect the unknown, but sometimes hit harmless requests. That is why they are off until you turn them on.',
  'An. Eine Anfrage mit Treffer weist HAProxy sofort mit 403 ab.':
    'On. HAProxy rejects a request with a hit right away with 403.',
  'Aus. Es gelten nur die virtuellen Patches und die allgemeinen Regeln.':
    'Off. Only the virtual patches and the generic rules apply.',
  'Vorteile': 'Advantages',
  'Nachteile': 'Disadvantages',
  'Erwartet wird crs: off oder block.': 'Expected crs: off or block.',
  'OWASP-Regeln: an': 'OWASP rules: on',
  'Die Anfrage wurde mit 403 abgewiesen.': 'The request was rejected with 403.',
};
