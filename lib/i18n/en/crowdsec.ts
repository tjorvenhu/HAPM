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
  'Treffer sperren': 'Block hits',
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
  'Solange CrowdSec oder der Bouncer fehlt, gehen alle Anfragen ungeprüft durch. Mehr sagt der Reiter „CrowdSec“ unter Reverse-Proxy, Logs.':
    'While CrowdSec or the bouncer is missing, all requests pass unchecked. More in the "CrowdSec" tab under Reverse proxy, Logs.',
  'Welche Ziele CrowdSec prüft': 'Which targets CrowdSec checks',
  'Alle Ziele, über den Schalter für alle.': 'All targets, through the switch for all.',
  '{count} Ziel mit eigenem Schalter.': '{count} target with its own switch.',
  '{count} Ziele mit eigenem Schalter.': '{count} targets with their own switch.',
  'Alle Ziele prüfen': 'Check all targets',
  'Steht im HTTPS-Frontend von HAProxy und gilt damit auch für Ziele, die später dazukommen. Ohne den Schalter prüft CrowdSec nur Ziele, bei denen es im Dialog des Ziels eingeschaltet ist.':
    'Lives in the HTTPS frontend of HAProxy and so also applies to targets added later. Without the switch, CrowdSec only checks targets where it is turned on in the target dialog.',
  'Der Block „# CrowdSec“ in haproxy.cfg ist von Hand geändert und wird nicht angefasst.':
    'The "# CrowdSec" block in haproxy.cfg was edited by hand and is left alone.',
  'Wird übernommen.': 'Being applied.',
  'An. Jede Anfrage geht durch CrowdSec.': 'On. Every request goes through CrowdSec.',
  'Aus.': 'Off.',
  'HAProxy wird neu geladen.': 'HAProxy is reloading.',
  'Geprüft über': 'Checked through',
  'Eigener Schalter': 'Own switch',
  'Schalter für alle': 'Switch for all',
  'Noch kein Ziel. Einschalten lässt es sich hier für alle oder im Dialog eines Ziels unter „CrowdSec (WAF)“.':
    'No target yet. Turn it on here for all, or in the dialog of a target under "CrowdSec (WAF)".',
  'Lokale API': 'Local API',
  Antwortet: 'Responding',
  'Antwortet nicht': 'Not responding',
  'Bouncer angemeldet': 'Bouncer registered',
  'Ja, zuletzt {ago}': 'Yes, last {ago}',
  'Nein. HAPM holt das in den nächsten Minuten nach.': 'No. HAPM catches up within the next minutes.',
  'OWASP-Regeln': 'OWASP rules',
  'Was CrowdSec hier tut': 'What CrowdSec does here',
  'Prüft jede Anfrage auf bekannte Angriffe und lehnt sie mit 403 ab.': 'Checks every request for known attacks and rejects them with 403.',
  'Erkennung im Log': 'Log detection',
  'Liest das Log von HAProxy und sperrt Adressen, die scannen oder raten.': 'Reads the HAProxy log and bans addresses that scan or guess.',
  'Sperrt Adressen, die anderen CrowdSec-Installationen aufgefallen sind.': 'Bans addresses that other CrowdSec installations have reported.',
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
  '{count} Sperre aktiv.': '{count} ban active.',
  '{count} Sperren aktiv.': '{count} bans active.',
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
  'Freigegebene Adressen sperrt CrowdSec nicht, und die WAF prüft sie nicht.': 'CrowdSec does not ban allowed addresses, and the WAF does not check them.',
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
  'Nur melden': 'Report only',
  'Nur virtuelle Patches und allgemeine Regeln.': 'Only virtual patches and generic rules.',
  'Treffer erscheinen als Ereignis, die Anfrage geht durch.': 'Hits show up as events, the request goes through.',
  'Treffer werden mit 403 abgelehnt.': 'Hits are rejected with 403.',
  'Log von HAProxy: Scanner, Raten von Passwörtern, bekannte Lücken': 'HAProxy log: scanners, password guessing, known vulnerabilities',
  'WAF: virtuelle Patches für bekannte Lücken': 'WAF: virtual patches for known vulnerabilities',
  'WAF: allgemeine Angriffsmuster': 'WAF: generic attack patterns',
  'OWASP-Regeln sperren lassen?': 'Let the OWASP rules block?',
  'Das OWASP Core Rule Set ist streng und sperrt auch harmlose Anfragen, etwa Formulare mit Code oder SQL im Text. Besser erst einige Tage „Nur melden“ und die Ereignisse ansehen.':
    'The OWASP Core Rule Set is strict and also blocks harmless requests, such as forms with code or SQL in the text. Better run "Report only" for a few days first and look at the events.',
  'Sperren lassen': 'Let it block',
  'Die OWASP-Regeln sperren jetzt.': 'The OWASP rules now block.',
  'Gespeichert. CrowdSec lädt die Regeln neu.': 'Saved. CrowdSec reloads the rules.',
  'OWASP Core Rule Set': 'OWASP Core Rule Set',
  'Allgemeine Regeln gegen SQL-Injection, XSS und ähnliche Angriffe.': 'Generic rules against SQL injection, XSS and similar attacks.',
  Modus: 'Mode',
  Regelsammlungen: 'Rule collections',
  'Aus dem Hub von CrowdSec.': 'From the CrowdSec hub.',
  'Die Regeln sind auf dem neuesten Stand.': 'The rules are up to date.',
  'Regeln aktualisieren': 'Update rules',
  Sammlung: 'Collection',
  'Immer an': 'Always on',
  '{name} ist an.': '{name} is on.',
  '{name} ist aus.': '{name} is off.',
  'HTTP-Flut': 'HTTP flood',
  'Erkennt Adressen, die in kurzer Zeit sehr viele Anfragen schicken, und sperrt sie. Vorsicht bei Diensten, die viele Anfragen von einer Adresse bekommen, etwa Apps zum Abgleich hinter einem gemeinsamen Ausgang (Firmennetz, Mobilfunk). Solche Adressen gehören in die Freigaben.':
    'Detects addresses that send very many requests in a short time and bans them. Take care with services that get many requests from one address, such as sync apps behind a shared exit (company network, mobile carrier). Such addresses belong in the allowlist.',

  // Regeln, Anwendungen
  Anwendungen: 'Applications',
  Anwendung: 'Application',
  'Ausnahmen gegen bekannte Fehlsperren einzelner Anwendungen, für WordPress auch virtuelle Patches.':
    'Exclusions against known false bans of individual applications, for WordPress also virtual patches.',
  'Wirkt auf': 'Applies to',
  Log: 'Log',
  OWASP: 'OWASP',
  'Ausnahmen für die Erkennung im Log von HAProxy': 'Exclusions for detection in the HAProxy log',
  'Virtuelle Patches in der WAF': 'Virtual patches in the WAF',
  'Ausnahmen für die OWASP-Regeln': 'Exclusions for the OWASP rules',
  'Wirkt erst, wenn die OWASP-Regeln an sind.': 'Only takes effect when the OWASP rules are on.',
  'Die Regeln für {name} sind an.': 'The rules for {name} are on.',
  'Die Regeln für {name} sind aus.': 'The rules for {name} are off.',
  'Nur ein Teil ist installiert. Einschalten holt den Rest.': 'Only part is installed. Switching on fetches the rest.',
  Teilweise: 'Partial',
  'Overseerr und Jellyseerr': 'Overseerr and Jellyseerr',
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
  'Was CrowdSec und sein Bouncer melden, die neueste Zeile oben. Erkannte Angriffe stehen unter CrowdSec, Ereignisse.':
    'What CrowdSec and its bouncer report, newest line first. Detected attacks are under CrowdSec, Events.',
  Verkehr: 'Traffic',
  'Was CrowdSec erkannt und abgelehnt hat: WAF-Treffer, Szenarien und Sperren.': 'What CrowdSec detected and rejected: WAF hits, scenarios and bans.',
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
  'Gilt schon für alle Ziele. Der eigene Schalter dieses Ziels lässt sich ausschalten.':
    "Already applies to all targets. This target's own switch can be turned off.",
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
  'Diesen Modus gibt es nicht.': 'This mode does not exist.',
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
};
