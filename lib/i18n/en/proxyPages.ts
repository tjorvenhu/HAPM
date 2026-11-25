import type { Dictionary } from './index';

/** Reverse-Proxy, Seiten (`app/(app)/reverse-proxy/`). */
export const proxyPages: Dictionary = {
  // Allgemein auf mehreren Seiten des Bereichs
  'Die Reverse-Proxy-Ziele konnten nicht geladen werden.': 'The reverse proxy targets could not be loaded.',
  'HAProxy antwortet nicht': 'HAProxy is not responding',
  'Der Zustand von HAProxy steht in der {overview}.': 'The {overview} shows the state of HAProxy.',
  'Durchgelaufen, HAProxy hat die neue Konfiguration übernommen.': 'Completed, HAProxy has applied the new configuration.',
  'Nicht durchgelaufen. Der erste fehlgeschlagene Schritt steht im Protokoll.': 'Did not complete. The log shows the first failed step.',
  '{label} läuft': '{label} is running',
  'Prüfen, Backup, einsetzen, neu laden. Der Fortschritt steht unten rechts.': 'Check, back up, apply, reload. Progress is shown at the bottom right.',
  'Schritte ansehen': 'View steps',
  'Ändern fehlgeschlagen': 'Change failed',
  'Löschen fehlgeschlagen': 'Delete failed',
  'Endgültig löschen': 'Delete permanently',
  'Gruppe anlegen': 'Create group',
  'Gruppe entfernen': 'Remove group',
  'Gruppe von HAPM': 'HAPM group',
  'Konfiguration importieren': 'Import configuration',
  'Dienst': 'Service',
  'Dienste': 'Services',
  '{count} Dienst': '{count} service',
  '{count} Dienste': '{count} services',
  '{count} Ziel': '{count} target',
  '{count} Ziele': '{count} targets',
  '{count} TCP-Port': '{count} TCP port',
  '{count} TCP-Ports': '{count} TCP ports',
  'acme.sh fehlt': 'acme.sh missing',
  'keine': 'none',

  // Übersicht (`page.tsx`)
  'Gruppe „{name}"': 'Group “{name}”',
  'Der Vorgang ist fehlgeschlagen. Die Schritte stehen in den Logs.': 'The task failed. The logs show the steps.',
  'Die Gruppe ist angelegt.': 'The group has been created.',
  'Die Gruppe ist entfernt.': 'The group has been removed.',
  'Die Gruppe konnte nicht angelegt werden.': 'The group could not be created.',
  'Gruppe „{name}" wird angelegt': 'Creating group “{name}”',
  'Welche Domain auf welches Ziel zeigt. Gelesen wird direkt aus der HAProxy-Konfiguration, nicht aus einer Kopie.':
    'Which domain points to which target. Read directly from the HAProxy configuration, not from a copy.',
  'HAProxy nicht gefunden': 'HAProxy not found',
  'Diese Seite liest die Konfiguration unter {path}. Ob HAProxy läuft, steht in der {overview}.':
    'This page reads the configuration at {path}. The {overview} shows whether HAProxy is running.',
  'Noch keine Gruppe': 'No group yet',
  'Eine Gruppe fasst Ziele zusammen, etwa „Websites“ oder „Intern“. Jedes Ziel gehört in eine Gruppe. Legen Sie deshalb zuerst eine Gruppe an.':
    'A group collects targets, such as “Websites” or “Internal”. Every target belongs to a group, so create a group first.',
  'Die Marker-Blöcke der Konfiguration': 'The marker blocks of the configuration',
  'Wird angelegt…': 'Creating…',
  'Wird entfernt…': 'Removing…',
  'noch keiner': 'none yet',
  'HAPM ist über ein Ziel dieser Gruppe erreichbar ({url}). Sie lässt sich nicht entfernen.':
    'HAPM is reachable through a target in this group ({url}). The group cannot be removed.',
  'Ein Eintrag steht außerhalb der verwalteten Blöcke und gehört damit zu keiner Gruppe. Er wird hier nicht angezeigt und nicht angefasst. Wichtig ist nur, dass es ihn gibt: seine Domains sind vergeben.':
    'One entry is outside the managed blocks and therefore belongs to no group. It is not shown or touched here. What matters is that it exists: its domains are taken.',
  '{count} Einträge stehen außerhalb der verwalteten Blöcke und gehören damit zu keiner Gruppe. Sie werden hier nicht angezeigt und nicht angefasst. Wichtig ist nur, dass es sie gibt: ihre Domains sind vergeben.':
    '{count} entries are outside the managed blocks and therefore belong to no group. They are not shown or touched here. What matters is that they exist: their domains are taken.',
  'Was die laufende Instanz über sich sagt': 'What the running instance reports about itself',
  'Dieser Server': 'This server',
  'Weichen in der HAProxy-Konfiguration': 'Routes in the HAProxy configuration',
  'Durchgereichte Ports dieses Servers': 'Ports passed through on this server',
  'Ohne acme.sh und Zertifikatsverzeichnis lässt sich kein Ziel mit Domain anlegen. HAPM richtet beides beim Start selbst ein.':
    'Without acme.sh and the certificate directory, no target with a domain can be created. HAPM sets up both itself at startup.',
  'Nur a-z, 0-9, _ und -. Der Name steht danach im Marker und lässt sich nicht umbenennen: dafür gibt es Anlegen und Entfernen.':
    'Only a-z, 0-9, _ and -. The name then appears in the marker and cannot be renamed: create and remove the group instead.',
  'Angelegt werden zwei Marker-Paare in der Konfiguration ({services} und dasselbe für {backends}). Bestehende Einträge werden dabei nicht angefasst.':
    'Two marker pairs are added to the configuration ({services} and the same for {backends}). Existing entries are not touched.',

  // Gruppenseite (`[scope]/page.tsx`)
  'Zertifikat, Prüfung und Reload dauern ein paar Minuten. Der Fortschritt steht unten rechts.':
    'Certificate, check, and reload take a few minutes. Progress is shown at the bottom right.',
  'Eintrag nicht gefunden': 'Entry not found',
  '„{id}" steht nicht (mehr) in dieser Gruppe.': '“{id}” is not (or no longer) in this group.',
  'Sperre von „{id}" lösen': 'Unlock “{id}”',
  '„{id}" mit Passwort sperren': 'Lock “{id}” with a password',
  '„{id}" auf Admin-IPs sperren': 'Lock “{id}” to admin IPs',
  'Reverse-Proxy-Ziel löschen': 'Delete reverse proxy target',
  'Das entfernt die Weiche für {domains} aus der HAProxy-Konfiguration, samt Backend, Zertifikat und dessen automatischer Erneuerung.':
    'This removes the route for {domains} from the HAProxy configuration, along with the backend, the certificate, and its automatic renewal.',
  'Die Pfad-Regel ({paths}) geht mit.': 'The path rule ({paths}) goes with it.',
  'Die {count} Pfad-Regeln ({paths}) gehen mit.': 'The {count} path rules ({paths}) go with it.',
  'Die Domains sind danach nicht mehr erreichbar.': 'The domains will no longer be reachable.',
  'DNS-Einträge ebenfalls entfernen': 'Also remove DNS records',
  'Zum Bestätigen die Dienst-ID abtippen:': 'Type the service ID to confirm:',
  'Ziel „{id}" löschen': 'Delete target “{id}”',
  'TCP-Weiterleitung löschen': 'Delete TCP forward',
  'Das nimmt den listen-Abschnitt „{id}" aus der HAProxy-Konfiguration. Port {port} nimmt danach keine Verbindungen mehr an, und was gerade darüber läuft, bricht ab.':
    'This removes the listen section “{id}” from the HAProxy configuration. Port {port} will no longer accept connections, and anything currently running over it is cut off.',
  'Zum Bestätigen die Kennung abtippen:': 'Type the identifier to confirm:',
  'TCP-Weiterleitung „{id}" löschen': 'Delete TCP forward “{id}”',
  'Gruppe „{name}" entfernen?': 'Remove group “{name}”?',
  'Die Marker-Paare werden aus der Konfiguration genommen. Es steht kein Eintrag darin, es geht also nichts offline. Danach lässt sich in dieser Gruppe nichts mehr anlegen.':
    'The marker pairs are taken out of the configuration. There is no entry in them, so nothing goes offline. Afterwards nothing more can be created in this group.',
  'Die Gruppe konnte nicht entfernt werden.': 'The group could not be removed.',
  'Öffentlich erreichbar': 'Publicly reachable',
  'Jede Adresse kommt durch': 'Every address gets through',
  'Auf Admin-IPs oder mit Passwort, ganz oder für einzelne Domains': 'To admin IPs or with a password, fully or for individual domains',
  'Gruppe nicht gefunden': 'Group not found',
  'Diese Gruppe gibt es nicht': 'This group does not exist',
  'In der Konfiguration steht kein Marker-Block {slug}. Entweder wurde die Gruppe entfernt, oder die Konfiguration ließ sich nicht lesen. Der Zustand von HAProxy steht in der {overview}.':
    'The configuration has no marker block {slug}. Either the group was removed or the configuration could not be read. The {overview} shows the state of HAProxy.',
  'HAPM ist über ein Ziel dieser Gruppe erreichbar ({url})': 'HAPM is reachable through a target in this group ({url})',
  'Ziele suchen…': 'Search targets…',
  'Ziele suchen': 'Search targets',
  'Suche leeren': 'Clear search',
  'Alle Typen': 'All types',
  'Nicht entfernbar: hier liegt das Ziel der Oberfläche von HAPM': 'Cannot be removed: the target of the HAPM interface is here',
  'Noch kein Eintrag': 'No entry yet',
  'Hier stehen die Dienste dieser Gruppe, sobald der erste angelegt ist.': 'The services of this group appear here once the first one is created.',
  'Kein Eintrag dieser Gruppe passt zur Suche und zum Typ „{kind}".': 'No entry in this group matches the search and the type “{kind}”.',
  'Kein Eintrag dieser Gruppe passt zur Suche.': 'No entry in this group matches the search.',
  'Ports dieses Servers, durchgereicht ohne HTTP und ohne Zertifikat': 'Ports on this server, passed through without HTTP and without a certificate',
  'acme.sh ist nicht eingerichtet': 'acme.sh is not set up',
  'Für einen Eintrag mit Domain braucht es ein Zertifikat. HAPM richtet acme.sh beim Start selbst ein, der Zustand steht in der Übersicht. Eine TCP-Weiterleitung geht trotzdem.':
    'An entry with a domain needs a certificate. HAPM sets up acme.sh itself at startup, and the overview shows its state. A TCP forward works anyway.',

  // Statistik (`statistiken/page.tsx`)
  'Letzte 6 Stunden': 'Last 6 hours',
  'Letzte 24 Stunden': 'Last 24 hours',
  'Letzte 3 Tage': 'Last 3 days',
  'Letzte 7 Tage': 'Last 7 days',
  'Letzte 30 Tage': 'Last 30 days',
  '2xx erfolgreich': '2xx successful',
  '3xx weitergeleitet': '3xx redirected',
  'Andere': 'Other',
  '4xx Anfragefehler': '4xx client errors',
  '5xx Serverfehler': '5xx server errors',
  'Ausgehend': 'Outgoing',
  'Eingehend': 'Incoming',
  'Antwort des Ziels': 'Target response',
  'Gesamt': 'Total',
  'Warteschlange': 'Queue',
  'Gleichzeitige Sitzungen': 'Concurrent sessions',
  'Abgewiesen': 'Denied',
  'Wiederholt': 'Retried',
  'Anfragen': 'Requests',
  'Die Zeitreihe konnte nicht geladen werden.': 'The time series could not be loaded.',
  'Die Zugriffe konnten nicht ausgewertet werden.': 'The requests could not be analyzed.',
  'Alle Dienste': 'All services',
  'Statistik: {scope}': 'Statistics: {scope}',
  'Reverse-Proxy-Statistik': 'Reverse proxy statistics',
  'Nur dieser Dienst. Die Zahlen kommen aus HAProxys eigener Statistik, die Zugriffe aus seinem Log.':
    'This service only. The numbers come from HAProxy’s own statistics, the requests from its log.',
  'Was über HAProxy läuft: Anfragen, Statuscodes, übertragene Menge, Antwortzeiten und wer zugreift.':
    'What runs through HAProxy: requests, status codes, transferred volume, response times, and who is accessing.',
  'Die Zeitreihe fängt gerade erst an.': 'The time series is just getting started.',
  'HAProxy liefert Zählerstände seit dem Start seines Prozesses, kein Fenster. Ein Balken ist immer die Differenz zweier Proben. Die gleichzeitigen Sitzungen stehen deshalb schon da, Anfragen, Statuscodes und übertragene Menge ab der zweiten Runde. Erfasst wird jede Minute.':
    'HAProxy reports counters since its process started, not a window. Each value is the difference between two samples. Concurrent sessions are therefore already shown, requests, status codes, and transferred volume from the second round on. Data is collected every minute.',
  'Erfolgsquote': 'Success rate',
  'Serverfehler (5xx)': 'Server errors (5xx)',
  'Ø Antwortzeit': 'Avg. response time',
  'IP-Adressen': 'IP addresses',
  'Länder': 'Countries',
  'Anfragen nach Statusklasse': 'Requests by status class',
  'Summe je {minutes} Minuten, je Klasse eine Linie. Das Gesamtaufkommen steht als Kennzahl oben.':
    'Total per {minutes} minutes, one line per class. The overall volume is shown as a figure above.',
  'Übertragene Menge': 'Transferred volume',
  'Aus Sicht des Proxys: ausgehend ist, was an die Besucher ging. Zwei Richtungen, deshalb zwei Linien und kein Stapel: ihre Summe bedeutet nichts.':
    'From the proxy’s point of view: outgoing is what went to visitors. Two directions, so two lines and no stack: their sum means nothing.',
  'Antwortzeiten': 'Response times',
  'Gleitende Mittel über die letzten 1024 Antworten, wie HAProxy sie führt, keine Summen.':
    'Moving averages over the last 1024 responses, as HAProxy keeps them, not totals.',
  'Aus den Backends: ein Frontend hat kein Ziel und misst deshalb keine Antwortzeit. Nach Anfragen gewichtet, damit ein Dienst mit drei Aufrufen die Kurve nicht so weit zieht wie einer mit zehntausend.':
    'From the backends: a frontend has no target and therefore measures no response time. Weighted by requests, so a service with three requests does not pull the curve as far as one with ten thousand.',
  'Momentanwert zum Zeitpunkt jeder Probe, nicht der Höchstwert dazwischen.': 'The value at the time of each sample, not the peak in between.',
  'Fehler, Abweisungen, Wiederholungen': 'Errors, denials, retries',
  'Abgewiesen heißt: von einer Regel gestoppt, etwa der Sperre auf Admin-Adressen. Wiederholt heißt: HAProxy hat es an einem anderen Ziel erneut versucht. Das kennt nur ein Backend. Fehler und Abweisungen sind die Eingangs- und die Zielseite zusammengezählt.':
    'Denied means stopped by a rule, such as the lock to admin addresses. Retried means HAProxy tried again at another target. Only a backend knows that. Errors and denials add up the frontend and the backend side.',
  'Zugriffe je Stunde': 'Requests per hour',
  'Aus dem Access-Log, {from} bis {to}.': 'From the access log, {from} to {to}.',
  'Aus dem Access-Log.': 'From the access log.',
  'Das Log wird ausgewertet …': 'Analyzing the log …',
  'Keine Daten': 'No data',
  'Zugriffe': 'Requests',
  'Aus dem Access-Log von HAProxy.': 'From the HAProxy access log.',
  '{parsed} von {lines} gelesenen Zeilen ausgewertet, zuletzt {time}.': '{parsed} of {lines} lines read were analyzed, last at {time}.',
  'Wird nicht im Hintergrund erfasst: jeder Lauf liest das Log neu.': 'Not collected in the background: each run reads the log again.',
  'Neu auswerten': 'Analyze again',
  'Es wurde kein HAProxy-Log gefunden. HAPM schreibt das Log des HAProxy-Containers mit. Liegt dort nichts, hat HAProxy noch keine Anfrage protokolliert. Die Zahlen oben (aus HAProxys eigener Statistik) stimmen trotzdem.':
    'No HAProxy log was found. HAPM records the log of the HAProxy container. If it is empty, HAProxy has not logged a request yet. The numbers above (from HAProxy’s own statistics) are still correct.',
  'Keine auswertbaren Zeilen': 'No lines to analyze',
  'Für diesen Dienst stand im gelesenen Fenster des Logs keine Anfrage.': 'The log window that was read contains no request for this service.',
  'Im gelesenen Fenster des Logs stand keine Anfrage, oder das Format ist keines, das sich lesen lässt.':
    'The log window that was read contains no request, or its format cannot be read.',
  'Es ist keine Länder-Tabelle hinterlegt.': 'No country table is installed.',
  'Aus {share} der Anfragen. Die Auswertung nimmt die häufigsten Adressen, nicht alle.':
    'From {share} of the requests. The analysis uses the most frequent addresses, not all of them.',
  '{count} Adresse im Fenster.': '{count} address in the window.',
  '{count} verschiedene im Fenster.': '{count} different ones in the window.',
  'Statuscodes': 'Status codes',
  'Der genaue Code, nicht die Klasse.': 'The exact code, not the class.',
  'Methoden': 'Methods',
  'Womit angefragt wurde.': 'How the requests were made.',
  'Ohne Abfrageteil, sonst wäre jede Suche ein eigener Pfad.': 'Without the query string, otherwise every search would be its own path.',
  'Dieser Dienst im Log': 'This service in the log',
  'Eine andere Zählung als die Zeitreihe oben: hier zählt jede Zeile im gelesenen Fenster, dort HAProxys eigener Zähler über den gewählten Zeitraum. Zwei verschiedene Zahlen sind hier normal und kein Widerspruch.':
    'A different count than the time series above: here every line in the window that was read counts, there HAProxy’s own counter over the selected period. Two different numbers are normal here and not a contradiction.',
  'Übertragen': 'Transferred',
  'Erfolgreich (2xx)': 'Successful (2xx)',
  'Weitergeleitet (3xx)': 'Redirected (3xx)',
  'Anfragefehler (4xx)': 'Client errors (4xx)',
  'Noch keine Messwerte': 'No measurements yet',
  'Die Zeitreihe wird jede Minute erfasst. Nach dem Start von HAPM steht der erste Punkt nach zwei Runden: eine einzelne Probe ist ein Zählerstand, kein Zeitraum.':
    'The time series is collected every minute. After HAPM starts, the first point appears after two rounds: a single sample is a counter reading, not a period.',
  'Anfragen der letzten Stunde, je Backend. Ein Klick öffnet die Auswertung dieses Dienstes.':
    'Requests in the last hour, per backend. A click opens the analysis of that service.',
  'Anfragen der letzten {count} Stunden, je Backend. Ein Klick öffnet die Auswertung dieses Dienstes.':
    'Requests in the last {count} hours, per backend. A click opens the analysis of that service.',

  // Zertifikate (`zertifikate/page.tsx`)
  'Die Zertifikate konnten nicht geladen werden.': 'The certificates could not be loaded.',
  'Ohne HAProxy gibt es hier nichts zu zeigen. Sein Zustand steht in der {overview}.':
    'Without HAProxy there is nothing to show here. The {overview} shows its state.',
  '{count} Zertifikat': '{count} certificate',
  '{count} Zertifikate': '{count} certificates',
  'DNS-Hooks: {hooks}': 'DNS hooks: {hooks}',
  'Kein DNS-Hook eingerichtet, keine Wildcard ausstellbar': 'No DNS hook set up, no wildcard can be issued',
  'acme.sh oder das Zertifikatsverzeichnis fehlt. HAPM richtet beides beim Start selbst ein, der Zustand steht in der {overview}. Solange das so ist, lässt sich kein Zertifikat ausstellen, und diese Liste ist leer, weil nicht gefragt werden konnte, nicht weil es keine gibt.':
    'acme.sh or the certificate directory is missing. HAPM sets up both itself at startup, and the {overview} shows the state. Until then, no certificate can be issued, and this list is empty because nothing could be queried, not because there are none.',
  'Noch kein Zertifikat': 'No certificate yet',
  'acme.sh führt keins.': 'acme.sh has none.',
  'Abgedeckte Domains': 'Covered domains',
  'Benutzt von': 'Used by',
  'Von keinem Eintrag benutzt': 'Not used by any entry',

  // Logs (`logs/page.tsx`)
  'Die Protokolle konnten nicht geladen werden.': 'The logs could not be loaded.',
  'Reverse-Proxy-Protokolle': 'Reverse proxy logs',
  'Jeder Vorgang mit seinen Schritten: angelegt, geändert, gelöscht. Domains und Ziele stehen mit in der Zeile, damit auch ein entferntes Ziel noch lesbar ist.':
    'Every task with its steps: created, changed, deleted. Domains and targets are part of the row, so a removed target stays readable.',
  'Alle Vorgänge': 'All tasks',
  'Alle Status': 'All statuses',
  'Keine Protokolle': 'No logs',
  'Für diesen Filter gibt es keine Einträge.': 'There are no entries for this filter.',
  'Sobald ein Ziel angelegt, geändert oder gelöscht wurde, steht der Vorgang hier.':
    'As soon as a target is created, changed, or deleted, the task appears here.',
  'Details': 'Details',
  'Seite {page}': 'Page {page}',

  // Einstellungen (`einstellungen/page.tsx`)
  'Die Einstellungen konnten nicht geladen werden.': 'The settings could not be loaded.',
  'Zugangsdaten abgelegt. Wildcard-Zertifikate lassen sich ab jetzt ausstellen, auch für neue Domains derselben Zone.':
    'Credentials stored. Wildcard certificates can be issued from now on, including for new domains in the same zone.',
  'Die Datei wurde geschrieben, acme.sh erkennt daraus aber keinen Hook. Steht der Token unter dem erwarteten Namen?':
    'The file was written, but acme.sh does not recognize a hook from it. Is the token stored under the expected name?',
  '{provider}-Zugangsdaten entfernen': 'Remove {provider} credentials',
  'Der Token wird aus der acme.sh-Konfiguration gestrichen. Bestehende Zertifikate bleiben, aber ihre automatische Erneuerung scheitert ab dann, und eine neue Wildcard lässt sich nicht mehr ausstellen.':
    'The token is deleted from the acme.sh configuration. Existing certificates stay, but their automatic renewal fails from then on, and no new wildcard can be issued.',
  'Zugangsdaten entfernt.': 'Credentials removed.',
  'Einstellungen speichern': 'Save settings',
  'Was für alle Dienste gilt': 'What applies to all services',
  'Ohne HAProxy gibt es hier nichts einzustellen. Sein Zustand steht in der {overview}.':
    'Without HAProxy there is nothing to configure here. The {overview} shows its state.',
  'In der Konfiguration steht keine Zeile {marker}. Ohne sie ist nicht bestimmbar, wo die globalen Einstellungen hingehören. Hier wird deshalb nichts angeboten.':
    'The configuration has no line {marker}. Without it, there is no way to tell where the global settings belong, so nothing is offered here.',
  'HTTPS-Einstellungen': 'HTTPS settings',
  'Die Zeilen unter {marker}, eine je Feld. Sie gelten für jeden Dienst und werden so übernommen, wie sie hier stehen.':
    'The lines below {marker}, one per field. They apply to every service and are applied exactly as they appear here.',
  'Zeile hinzufügen': 'Add line',
  'Jede Zeile geht unverändert in die Konfiguration. Geprüft wird sie von HAProxy selbst ({check}). Ist etwas daran falsch, wird nichts eingesetzt und der Fehler steht im Protokoll des Vorgangs. Kommentare und Zeilen wie {backend} gehen hier nicht: sie würden den Block beenden, und alles darunter stünde danach außerhalb.':
    'Each line goes into the configuration unchanged. HAProxy itself checks it ({check}). If something is wrong, nothing is applied and the error appears in the task log. Comments and lines like {backend} do not work here: they would end the block, and everything below would then be outside it.',
  'Admin-IPs': 'Admin IPs',
  'Die Adressen, die einen gesperrten Eintrag noch erreichen. Sie stehen einmal in der Konfiguration ({acl}) und gelten für jeden Eintrag, bei dem das Schloss zu ist.':
    'The addresses that can still reach a locked entry. They appear once in the configuration ({acl}) and apply to every entry whose lock is closed.',
  'Gesperrt sind gerade: {services}. Solange das so ist, lässt sich die Liste nicht leeren: eine Regel auf eine Adressliste, die es nicht mehr gibt, lässt HAProxy beim nächsten Start stehen.':
    'Currently locked: {services}. While that is the case, the list cannot be emptied: a rule pointing to an address list that no longer exists keeps HAProxy from starting next time.',
  'Kein Eintrag ist gesperrt. Das Schloss dafür sitzt auf der Karte des jeweiligen Ziels.':
    'No entry is locked. The lock is on the card of each target.',
  '{acl} steht mehr als einmal in der Konfiguration. HAProxy verodert die Zeilen; sie hier zu einer zusammenzuschreiben wäre eine Änderung, die niemand angefordert hat.':
    '{acl} appears more than once in the configuration. HAProxy combines the lines with OR; merging them into one here would be a change nobody asked for.',
  'DNS-Zugangsdaten für Wildcards': 'DNS credentials for wildcards',
  'Eine Wildcard lässt Let’s Encrypt nur über DNS-01 ausstellen. Der Token liegt in der Konfiguration von {acme} und wird dort für jede Erneuerung wiederverwendet. Anzeigen lässt er sich danach nicht mehr.':
    'Let’s Encrypt issues a wildcard only over DNS-01. The token is stored in the {acme} configuration and reused there for every renewal. It cannot be displayed afterwards.',
  'Kein Token hinterlegt.': 'No token stored.',
  'Token gesetzt': 'Token set',
  'Token entfernen': 'Remove token',
  'Token beim Anbieter anlegen': 'Create a token at the provider',

  // API (`api/page.tsx`)
  'dieser Server als Liste mit einem Eintrag: Gruppen, Admin-IPs, DNS-Hooks, acmeReady':
    'this server as a list with one entry: groups, admin IPs, DNS hooks, acmeReady',
  'Einträge, gefiltert über ?scope= ?domain=': 'entries, filtered by ?scope= ?domain=',
  'anlegen → { runId }': 'create → { runId }',
  'ein Eintrag, mit editable / removable / health': 'one entry, with editable / removable / health',
  'ändern, vollständiger Rumpf → { runId }': 'change, full body → { runId }',
  'entfernen → { runId }': 'remove → { runId }',
  'TCP-Weiterleitungen; mit ?port= stattdessen: ist der Port frei': 'TCP forwards; with ?port= instead: whether the port is free',
  'eine Weiterleitung, mit editable / removable': 'one forward, with editable / removable',
  'Historie, gefiltert über ?serviceId= ?mine=true': 'history, filtered by ?serviceId= ?mine=true',
  'Stand des Vorgangs: status, phase, steps': 'state of the task: status, phase, steps',
  'Gruppe anlegen → { runs }': 'create group → { runs }',
  'Gruppe entfernen, nur wenn sie leer ist': 'remove group, only if it is empty',
  'HTTPS-Zeilen und die Admin-Adressliste': 'HTTPS lines and the admin address list',
  'der einzige Teil-Patch der API': 'the only partial patch in the API',
  'was acme.sh führt, samt „benutzt von“': 'what acme.sh keeps, including “used by”',
  'Die Schlüssel konnten nicht geladen werden.': 'The keys could not be loaded.',
  'Die Adressliste gilt ab dem nächsten Aufruf.': 'The address list applies from the next request.',
  'Schlüssel zurückziehen': 'Revoke key',
  '"{name}" gilt danach sofort nicht mehr. Ein Dienst, der ihn benutzt, bekommt ab dem nächsten Aufruf 401. Das betrifft auch Skripte, die gerade laufen. Der Eintrag bleibt bestehen, damit das Aktivitätsprotokoll auflösbar bleibt.':
    '"{name}" stops working immediately. A service that uses it gets 401 from the next request on. This also affects scripts that are running right now. The entry is kept so the audit log stays resolvable.',
  'Zurückziehen': 'Revoke',
  'Zurückziehen fehlgeschlagen': 'Revoke failed',
  '"{name}" gilt nicht mehr.': '"{name}" is no longer valid.',
  'Womit ein anderer Dienst oder ein KI-Assistent Domains und Ziele in HAProxy anlegt, ändert und entfernt. Die Anleitungen stehen in {api} und {mcp}.':
    'How another service or an AI assistant creates, changes and removes domains and targets in HAProxy. The guides are in {api} and {mcp}.',
  'API-Key anlegen': 'Create API key',
  'Zugang': 'Access',
  'Die Basis-URL ist die Adresse, unter der HAPM erreichbar ist. Der Parameter {param} ist überall optional: ohne ihn gilt dieser Server.':
    'The base URL is the address where HAPM is reachable. The parameter {param} is optional everywhere: without it, this server applies.',
  'Basis-URL': 'Base URL',
  'Jeder Endpunkt der Tabelle unten hängt daran. Kein CSRF-Token: der schützt einen Browser mit Cookie, und hier gibt es weder das eine noch das andere.':
    'Every endpoint in the table below is appended to it. No CSRF token: that protects a browser with a cookie, and here there is neither.',
  'Kopfzeile': 'Header',
  'Ersatzweise {header}, falls ein Proxy dazwischen den Authorization-Header für sich beansprucht.':
    'Alternatively {header}, in case a proxy in between claims the Authorization header for itself.',
  'API-Keys': 'API keys',
  'Noch kein Key': 'No key yet',
  'Solange keiner existiert, erreicht kein anderer Dienst die Reverse-Proxy-API. Ein Deploy-Skript braucht einen, um Ziele anzulegen.':
    'Until one exists, no other service can reach the reverse proxy API. A deploy script needs one to create targets.',
  'Key': 'Key',
  'Adressen': 'Addresses',
  'von überall': 'from anywhere',
  'Zuletzt benutzt': 'Last used',
  'Endpunkte': 'Endpoints',
  'Schreibende Aufrufe antworten mit einer Lauf-ID, nicht mit dem Ergebnis: DNS, Zertifikat und Reload dauern Minuten. Der Aufrufer pollt {path}, bis {status} nicht mehr {running} ist.':
    'Write requests respond with a run ID, not with the result: DNS, certificate, and reload take minutes. The caller polls {path} until {status} is no longer {running}.',
  'Methode': 'Method',
  'Pfad': 'Path',
  'Was er tut': 'What it does',
  'Steht so im Aktivitätsprotokoll und in der Liste der Vorgänge oben. Der Name des Dienstes, nicht der des Menschen.':
    'Appears like this in the audit log and in the list of tasks at the top. The name of the service, not of the person.',
  'deploy-skript': 'deploy-script',
  'Optional: wofür wird er benutzt?': 'Optional: what is it used for?',
  'Adressen für „{name}“': 'Addresses for “{name}”',
  'Wirkt sofort. Der Key bleibt derselbe, er muss also nirgends neu eingetragen werden. Verglichen wird gegen die Adresse, die bei HAPM ankommt. Steht sie nicht auf der Liste, antwortet der Aufruf mit 403 und nennt sie.':
    'Takes effect immediately. The key stays the same, so it does not need to be entered again anywhere. The check uses the address that reaches HAPM. If it is not on the list, the request gets 403 and names the address.',
  'Key für „{name}“': 'Key for “{name}”',
  'Jetzt kopieren. Gespeichert wird nur ein Hash. Nach dem Schließen ist der Klartext weg, und es bleibt nur, einen neuen Key auszustellen.':
    'Copy it now. Only a hash is stored. After closing, the plain text is gone, and the only option is to issue a new key.',
  'Im aufrufenden Dienst als {header} mitschicken.': 'Send it from the calling service as {header}.',
  'Kopiert, schließen': 'Copied, close',

  // Import (`import/page.tsx`)
  'Übernehmbar': 'Importable',
  'Konflikt': 'Conflict',
  'Hier nicht möglich': 'Not possible here',
  'Nicht übernehmbar': 'Not importable',
  'Die Datei ist größer als {size} MB.': 'The file is larger than {size} MB.',
  'Die Vorschau ließ sich nicht berechnen.': 'The preview could not be computed.',
  'Ein Eintrag wird in der Gruppe „{scope}" angelegt, die dafür neu entsteht.':
    'One entry will be created in the group “{scope}”, which is created for it.',
  '{count} Einträge werden nacheinander in der Gruppe „{scope}" angelegt, die dafür neu entsteht.':
    '{count} entries will be created one after another in the group “{scope}”, which is created for them.',
  'Ein Eintrag wird in der Gruppe „{scope}" angelegt.': 'One entry will be created in the group “{scope}”.',
  '{count} Einträge werden nacheinander in der Gruppe „{scope}" angelegt.':
    '{count} entries will be created one after another in the group “{scope}”.',
  'Jeder geht durch dieselbe Prüfung wie im Dialog und lädt HAProxy einzeln neu.':
    'Each goes through the same check as in the dialog and reloads HAProxy on its own.',
  'Beantragt werden bis zu {count} Zertifikate, jedes kann einige Minuten dauern.':
    'Up to {count} certificates will be requested, each can take a few minutes.',
  'Zertifikate werden keine beantragt.': 'No certificates will be requested.',
  'Importieren': 'Import',
  'Der Import ließ sich nicht starten.': 'The import could not be started.',
  'Import läuft': 'Import running',
  'Die Einträge werden nacheinander angelegt. Der Fortschritt steht hier und unten rechts.':
    'The entries are created one after another. Progress is shown here and at the bottom right.',
  'Import nicht gestartet': 'Import not started',
  'Einträge aus einer bestehenden haproxy.cfg übernehmen, statt sie einzeln abzutippen.':
    'Take over entries from an existing haproxy.cfg instead of typing them one by one.',
  'Zur Historie': 'Go to history',
  '{phase}. Der Lauf geht auch weiter, wenn Sie die Seite verlassen.': '{phase}. The run continues even if you leave the page.',
  'Eine haproxy.cfg als Text, höchstens 1 MB. Sie wird nur gelesen und nirgends gespeichert. Übernommen wird erst, was Sie in der Vorschau auswählen und importieren.':
    'A haproxy.cfg as text, at most 1 MB. It is only read and stored nowhere. Only what you select in the preview and import is taken over.',
  'Oder den Text einfügen': 'Or paste the text',
  'Vorschau berechnen': 'Compute preview',
  'Der Text hat sich geändert. Die Vorschau gilt noch für den vorigen.': 'The text has changed. The preview still belongs to the previous one.',
  'Globale Abschnitte (global, defaults), TLS-Einstellungen und die bind-Zeilen der Frontends werden nicht übernommen: HAPM bringt eigene mit. Übernommen werden Domains, Ziele und TCP-Ports, und nur, wo sie sich in HAPM genauso verhalten wie bisher.':
    'Global sections (global, defaults), TLS settings, and the bind lines of the frontends are not taken over: HAPM brings its own. Domains, targets, and TCP ports are taken over, and only where they behave in HAPM exactly as before.',
  'acme.sh fehlt. Ohne lässt sich kein Zertifikat ausstellen, und kein Eintrag mit Domain ist übernehmbar. Der Zustand steht in der {overview}.':
    'acme.sh is missing. Without it, no certificate can be issued, and no entry with a domain can be imported. The {overview} shows the state.',
  'Bestehende Zertifikate werden nicht übernommen, sondern neu ausgestellt: jeder Eintrag mit Domain bekommt sein Zertifikat wie beim Anlegen im Dialog.':
    'Existing certificates are not taken over but issued again: every entry with a domain gets its certificate as when it is created in the dialog.',
  'Diese Installation ist intern, jedes Zertifikat geht über DNS-01.': 'This installation is internal, every certificate goes through DNS-01.',
  'Ausgestellt wird über HTTP-01, Wildcards über DNS-01. Die Domains müssen dafür schon auf diesen Server zeigen, sonst scheitert der Antrag. DNS-Einträge legt der Import nicht an.':
    'Certificates are issued over HTTP-01, wildcards over DNS-01. The domains must already point to this server, otherwise the request fails. The import does not create DNS records.',
  'Mit der Auswahl werden bis zu {count} Zertifikate beantragt.': 'With this selection, up to {count} certificates will be requested.',
  '{count} davon entfallen auf {domain}.': '{count} of them are for {domain}.',
  "Das ist mehr, als Let's Encrypt annimmt. Importieren Sie in Etappen.": "That is more than Let's Encrypt accepts. Import in stages.",
  "Das ist mehr als die Hälfte dessen, was Let's Encrypt in einer Woche annimmt.":
    "That is more than half of what Let's Encrypt accepts in a week.",
  "Let's Encrypt stellt je registrierter Domain höchstens {certs} Zertifikate in 7 Tagen aus, nimmt je Konto höchstens {orders} neue Bestellungen in 3 Stunden an und lässt je Name {failures} gescheiterte Prüfungen in einer Stunde zu (Stand August 2026). Deckt ein vorhandenes Zertifikat einen Eintrag schon ab, wird für ihn keins beantragt.":
    "Let's Encrypt issues at most {certs} certificates per registered domain in 7 days, accepts at most {orders} new orders per account in 3 hours, and allows {failures} failed validations per name in one hour (as of August 2026). If an existing certificate already covers an entry, none is requested for it.",
  'Ziel-Gruppe': 'Target group',
  'Neue Gruppe': 'New group',
  'Name der neuen Gruppe': 'Name of the new group',
  'DNS-Zugangsdaten für DNS-01': 'DNS credentials for DNS-01',
  'Mehrere DNS-Anbieter sind eingerichtet. Welcher die Zonen der importierten Domains führt, lässt sich nicht raten. Die Auswahl gilt für alle Einträge, die über DNS-01 ausgestellt werden.':
    'Several DNS providers are set up. Which one hosts the zones of the imported domains cannot be guessed. The choice applies to all entries issued over DNS-01.',
  'Vorschau': 'Preview',
  '{ready} von {total} übernehmbar': '{ready} of {total} importable',
  'Die Kennung vergibt der Server beim Anlegen': 'The server assigns the identifier on creation',
  'In dem Text steht kein Frontend mit Domains und kein TCP-Port, den HAPM übernehmen könnte.':
    'The text contains no frontend with domains and no TCP port that HAPM could take over.',
  'Alle übernehmbaren': 'All importable',
  'Alle übernehmbaren auswählen': 'Select all importable',
  'Art': 'Kind',
  'Domains bzw. Port': 'Domains or port',
  'Zusätze': 'Extras',
  'Einen Eintrag importieren': 'Import one entry',
  '{count} Einträge importieren': 'Import {count} entries',
  'Erst die Vorschau für den geänderten Text berechnen.': 'First compute the preview for the changed text.',
  'Aus dieser Vorschau wurde schon importiert. Für einen weiteren Durchgang die Vorschau neu berechnen.':
    'This preview has already been imported. Compute the preview again for another pass.',
  'Nicht übernommen ({count})': 'Not taken over ({count})',
  'Zeile': 'Line',
  'Inhalt': 'Content',
  'Grund': 'Reason',
  '{name} übernehmen': 'Import {name}',
  'Kennung {id}': 'Identifier {id}',
  'Zeile {line}, {source}': 'Line {line}, {source}',
  // Zertifikate: hochladen, eigener ACME-Server, eigener DNS-Server
  "Das Zertifikat ließ sich nicht hochladen.": "The certificate could not be uploaded.",
  "Das Zertifikat für {domains} ist ersetzt. HAProxy ist neu geladen.": "The certificate for {domains} is replaced. HAProxy is reloaded.",
  "Das Zertifikat für {domains} ist hochgeladen. HAProxy ist neu geladen.": "The certificate for {domains} is uploaded. HAProxy is reloaded.",
  "Zertifikat entfernen?": "Remove certificate?",
  "Die Datei {file} wird gelöscht und HAProxy neu geladen. Für {domains} liefert HAProxy danach ein anderes passendes Zertifikat oder den Platzhalter.": "The file {file} is deleted and HAProxy reloaded. For {domains}, HAProxy then serves another matching certificate or the placeholder.",
  "Das Zertifikat {file} ist entfernt.": "The certificate {file} is removed.",
  "Das Zertifikat ließ sich nicht entfernen.": "The certificate could not be removed.",
  // Zertifikate von acme.sh löschen, die niemand hält
  "acme.sh löscht den Antrag für {domains}. Ein Zertifikat gibt es dafür nicht, HAProxy bleibt unverändert.": "acme.sh deletes the request for {domains}. No certificate exists for it, HAProxy stays unchanged.",
  "acme.sh löscht das Zertifikat für {domains} samt Schlüssel. Ausgerollt ist es nicht, HAProxy bleibt unverändert.": "acme.sh deletes the certificate for {domains} along with its key. It is not deployed, HAProxy stays unchanged.",
  "acme.sh löscht das Zertifikat für {domains} samt Schlüssel und erneuert es nicht mehr. Die Datei im Zertifikatsverzeichnis wird entfernt und HAProxy neu geladen.": "acme.sh deletes the certificate for {domains} along with its key and stops renewing it. The file in the certificate directory is removed and HAProxy reloaded.",
  "Das Zertifikat ließ sich nicht löschen.": "The certificate could not be deleted.",
  "Antrag löschen?": "Delete request?",
  "Zertifikat löschen?": "Delete certificate?",
  "Das Zertifikat für {domain} ist gelöscht. HAProxy ist neu geladen.": "The certificate for {domain} is deleted. HAProxy is reloaded.",
  "Das Zertifikat für {domain} ist gelöscht.": "The certificate for {domain} is deleted.",
  "Unbenutzte Zertifikate löschen?": "Delete unused certificates?",
  "acme.sh löscht {count} Zertifikat samt Schlüssel: {list}. Für jede geladene Datei wird HAProxy neu geladen.": "acme.sh deletes {count} certificate along with its key: {list}. HAProxy is reloaded for every loaded file.",
  "acme.sh löscht {count} Zertifikate samt Schlüssel: {list}. Für jede geladene Datei wird HAProxy neu geladen.": "acme.sh deletes {count} certificates along with their keys: {list}. HAProxy is reloaded for every loaded file.",
  "Alle löschen": "Delete all",
  "{count} Zertifikat ist gelöscht.": "{count} certificate is deleted.",
  "{count} Zertifikate sind gelöscht.": "{count} certificates are deleted.",
  "Nicht gelöscht: {list}. {reason}": "Not deleted: {list}. {reason}",
  "Es deckt noch Domains dieser Ziele ab: {list}. Deshalb bleibt es stehen. Löschen lässt es sich, wenn kein Ziel mehr darunter liegt.": "It still covers domains of these targets: {list}. That is why it stays. It can be deleted once no target lies beneath it.",
  "Unbenutzte löschen ({count})": "Delete unused ({count})",
  "Abgelaufen am {date}": "Expired on {date}",
  "Läuft am {date} ab": "Expires on {date}",
  "Was acme.sh führt und was hochgeladen ist. Gelesen bei jedem Aufruf, nicht aus einer Kopie.": "What acme.sh keeps and what was uploaded. Read on every request, not from a copy.",
  "Hochladen": "Upload",
  "Diese Installation stellt keine Zertifikate selbst aus. Ein neues Ziel braucht ein hochgeladenes Zertifikat, das seine Domains abdeckt. Umstellen lässt sich das unter {general}.": "This installation does not issue certificates itself. A new target needs an uploaded certificate that covers its domains. You can change this under {general}.",
  "Zertifikate von acme.sh entstehen mit ihrem Ziel. Eins, das kein Ziel mehr braucht, löschen Sie in seiner Zeile. Hochgeladene ersetzen und entfernen Sie hier, acme.sh beantragt dann für ihre Domains keins.": "Certificates from acme.sh are created with their target. Delete one that no target needs anymore in its row. Uploaded ones you replace and remove here, and acme.sh then requests none for their domains.",
  "Erneuert niemand von selbst. HAPM erinnert vor dem Ablauf.": "Nobody renews these automatically. HAPM reminds you before they expire.",
  "Kein hochgeladenes Zertifikat": "No uploaded certificate",
  "Ein eigenes Zertifikat laden Sie mit dem Knopf oben hoch: PEM mit Kette und den privaten Schlüssel.": "Upload your own certificate with the button above: PEM with chain and the private key.",
  "Ausgestellt von": "Issued by",
  "Gültig bis": "Valid until",
  "Ersetzen": "Replace",
  "Von acme.sh": "From acme.sh",
  "Die Datei ist größer als 100 KB. Ein Zertifikat mit Kette ist kleiner.": "The file is larger than 100 KB. A certificate with chain is smaller.",
  "Bitte fügen Sie das Zertifikat ein.": "Please paste the certificate.",
  "Zertifikat ersetzen": "Replace certificate",
  "Es muss {domains} abdecken.": "It must cover {domains}.",
  "Bisher abgedeckt: {domains}. Was davon ein Ziel braucht, muss das neue auch abdecken.": "Covered so far: {domains}. Whatever a target needs from these, the new one must cover too.",
  "Zertifikat mit Kette (PEM)": "Certificate with chain (PEM)",
  "Zuerst das Zertifikat der Domain, danach die Zwischenzertifikate. Eine fertige PEM-Datei für HAProxy mit dem Schlüssel darin geht auch, dann bleibt das Feld darunter leer.": "First the certificate of the domain, then the intermediate certificates. A complete PEM file for HAProxy with the key inside works too; then leave the field below empty.",
  "Aus Datei laden": "Load from file",
  "Privater Schlüssel (PEM)": "Private key (PEM)",
  "Unverschlüsselt, HAProxy fragt beim Laden nach keinem Passwort. Er geht direkt in die Datei auf dem Server und wird in HAPM nicht gespeichert.": "Unencrypted, HAProxy asks for no password when loading. It goes straight into the file on the server and is not stored in HAPM.",

  // Grundkonfiguration (`components/reverse-proxy/BaseConfigPanel.tsx`)
  'Ausgewählte Zeilen übernehmen?': 'Apply the selected lines?',
  '{count} Zeile wird in haproxy.cfg geschrieben. HAProxy prüft die Datei vorher und lädt danach neu. Scheitert das, bleibt die bisherige Fassung stehen.':
    '{count} line will be written to haproxy.cfg. HAProxy checks the file first and reloads afterwards. If that fails, the previous version stays in place.',
  '{count} Zeilen werden in haproxy.cfg geschrieben. HAProxy prüft die Datei vorher und lädt danach neu. Scheitert das, bleibt die bisherige Fassung stehen.':
    '{count} lines will be written to haproxy.cfg. HAProxy checks the file first and reloads afterwards. If that fails, the previous version stays in place.',
  'Übernehmen': 'Apply',
  'Übernehmen fehlgeschlagen': 'Apply failed',
  'Grundkonfiguration': 'Base configuration',
  'Übernommen, geprüft und HAProxy neu geladen.': 'Applied, checked and HAProxy reloaded.',
  'HAPM schreibt die Grundkonfiguration nur, wenn haproxy.cfg fehlt. Neue Vorgaben kommen bei einer bestehenden Installation deshalb nicht von selbst an. Verglichen werden global, defaults und die beiden Frontends, ohne die Bereiche der Gruppen und ohne die Einstellungen auf dieser Seite.':
    'HAPM writes the base configuration only when haproxy.cfg is missing. New defaults therefore do not reach an existing installation on their own. Compared are global, defaults and the two frontends, without the group sections and without the settings on this page.',
  'Wo haproxy.cfg von den Vorgaben von HAPM abweicht.': 'Where haproxy.cfg differs from the HAPM defaults.',
  'Ausgewählte übernehmen': 'Apply selected',
  'Der Abgleich konnte nicht geladen werden.': 'The comparison could not be loaded.',
  'Nicht gefunden: {sections}. Diese Abschnitte werden nicht abgeglichen und nicht angelegt.':
    'Not found: {sections}. These sections are neither compared nor created.',
  'Die Datei entspricht der Grundkonfiguration von HAPM.': 'The file matches the HAPM base configuration.',
  'Vorschlag': 'Proposed',
  'In der Datei': 'In the file',
  'Auswählen': 'Select',
  'fehlt': 'missing',
  'Nur hier, bleibt stehen': 'Only here, stays',
  'In haproxy.cfg fehlen Zeilen, die HAPM heute in die Grundkonfiguration schreibt. Unter Einstellungen lassen sie sich einzeln übernehmen.':
    'haproxy.cfg lacks lines that HAPM now writes into the base configuration. They can be applied one by one under Settings.',
  '{count} neue Vorgabe': '{count} new default',
  '{count} neue Vorgaben': '{count} new defaults',
  'Erneut beantragen': 'Request again',
  'Nie ausgestellt': 'Never issued',
  'Nicht ausgerollt': 'Not deployed',
  'acme.sh führt den Antrag, aber er ist nie durchgekommen. Es gibt kein Zertifikat, HAProxy liefert keins dafür aus, und Ziele unter diesen Domains bekommen ein eigenes. Der Grund steht in der Historie beim gescheiterten Lauf.':
    'acme.sh keeps the order, but it never went through. There is no certificate, HAProxy serves none for it, and targets under these domains get their own. The reason is in the history, at the failed run.',
  'acme.sh hat es ausgestellt, im Zertifikatsverzeichnis von HAProxy liegt es aber nicht. Das nächste Ziel, das es braucht, rollt es aus.':
    'acme.sh issued it, but it is not in the HAProxy certificate directory. The next target that needs it deploys it.',
  'Die Ziele, denen HAProxy dieses Zertifikat ausliefert. Hat eine Domain ein eigenes Zertifikat, bekommt sie das, auch wenn eine Wildcard sie ebenfalls abdeckt.':
    'The targets HAProxy serves this certificate to. A domain with its own certificate gets that one, even if a wildcard covers it as well.',
  'Der Antrag für {domains} läuft. Den Fortschritt zeigt die Anzeige unten rechts.':
    'The request for {domains} is running. The indicator at the bottom right shows its progress.',
  'Der Antrag ließ sich nicht starten.': 'The request could not be started.',
  'Zugriffsschutz':
    'Access protection',
  '10 Sekunden':
    '10 seconds',
  '1 Minute':
    '1 minute',
  '10 Minuten':
    '10 minutes',
  'Der Block {marker} steht nicht so in der Konfiguration, wie HAPM ihn schreibt. Er wirkt weiter, wird hier aber nicht bearbeitet, damit keine Änderung von Hand verloren geht.':
    'The {marker} block in the configuration is not the way HAPM writes it. It stays in effect but is not edited here, so no manual change gets lost.',
  'Gesperrte Adressen':
    'Blocked addresses',
  'Einzelne IPs oder Netze, die keinen Dienst erreichen. Gilt auch für Admin-IPs.':
    'Single IPs or networks that reach no service. Applies to admin IPs as well.',
  'Gesperrte Länder':
    'Blocked countries',
  'Besucher aus diesen Ländern bekommen 403. Admin-IPs sind ausgenommen.':
    'Visitors from these countries get 403. Admin IPs are exempt.',
  'Besucher aus diesen Ländern bekommen 403. Mit Admin-IPs wären diese ausgenommen.':
    'Visitors from these countries get 403. Admin IPs, once set, are exempt.',
  'Kein Land gesperrt.':
    'No country blocked.',
  'Ohne GeoIP-Tabelle lässt sich kein Land sperren. Sie lässt sich oben auf dieser Seite holen.':
    'Without a GeoIP table no country can be blocked. You can fetch it at the top of this page.',
  'Land hinzufügen':
    'Add country',
  'Land suchen':
    'Search country',
  'Ratenbegrenzung':
    'Rate limit',
  'Zu viele Anfragen von einer Adresse bekommen 429, bis sie wieder unter der Grenze liegt.':
    'Too many requests from one address get 429 until it is below the limit again.',
  'Anfragen je Adresse':
    'Requests per address',
  '{min} bis {max}':
    '{min} to {max}',
  'Zeitraum':
    'Period',
  'Admin-IPs zählen nicht mit. Eine Seite lädt beim ersten Aufruf oft hundert Dateien und mehr, und mehrere Menschen hinter einem Anschluss teilen sich eine Adresse.':
    'Admin IPs are not counted. A page often loads a hundred files or more on first visit, and several people behind one connection share an address.',
  'Eine Seite lädt beim ersten Aufruf oft hundert Dateien und mehr, und mehrere Menschen hinter einem Anschluss teilen sich eine Adresse. Das gilt auch für diese Oberfläche.':
    'A page often loads a hundred files or more on first visit, and several people behind one connection share an address. This applies to this interface as well.',
  'Gilt im HTTPS-Frontend für jeden Dienst. Ihre Adresse ist {ip} ({country}). Eine Sperre, die Sie selbst träfe, wird abgelehnt.':
    'Applies to every service in the HTTPS frontend. Your address is {ip} ({country}). A block that would hit you is refused.',
  'Gilt im HTTPS-Frontend für jeden Dienst. Ihre Adresse ist {ip}. Eine Sperre, die Sie selbst träfe, wird abgelehnt.':
    'Applies to every service in the HTTPS frontend. Your address is {ip}. A block that would hit you is refused.',
  'Gilt im HTTPS-Frontend für jeden Dienst. Eine Sperre, die Sie selbst träfe, wird abgelehnt.':
    'Applies to every service in the HTTPS frontend. A block that would hit you is refused.',
  '{country} entfernen': 'Remove {country}',
  'Gesperrte Länder ({count})': 'Blocked countries ({count})',
  'DNS-Zugangsdaten': 'DNS credentials',
  'Änderungen speichern': 'Save changes',
  'Ungespeicherte Änderungen': 'Unsaved changes',
  'Gesperrte Adressen und Länder, Ratenbegrenzung. Gilt für jeden Dienst.':
    'Blocked addresses and countries, rate limit. Applies to every service.',
};
