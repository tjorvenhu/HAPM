import type { Dictionary } from './index';

/** Reverse-Proxy auf dem Server: Meldungen aus `lib/haproxy/`, Routen und Phasen der Läufe. */
export const proxyServer: Dictionary = {
  // lib/haproxy/streams.ts, lib/geoip, Routen der TCP-Weiterleitungen
  'balance roundrobin: jede Verbindung an das nächste Ziel, der Reihe nach. Der Normalfall.':
    'balance roundrobin: each connection goes to the next target in turn. The usual choice.',
  'balance leastconn: immer an das Ziel mit den wenigsten offenen Verbindungen. Bei TCP meistens die richtige Wahl, denn eine Verbindung bleibt hier lange offen: eine Datenbanksitzung dauert Minuten, keine Millisekunden.':
    'balance leastconn: always to the target with the fewest open connections. Usually the right choice for TCP, because a connection stays open for a long time here: a database session lasts minutes, not milliseconds.',
  'balance source: aus der Quell-IP wird ein Hash, und der bestimmt das Ziel. In mode tcp ist das der einzige Weg zu einer Bindung: einen Cookie gibt es ohne HTTP nicht. Sie bricht, sobald ein Ziel ausfällt oder dazukommt.':
    'balance source: a hash of the source IP determines the target. In mode tcp this is the only way to keep a client on one target: there is no cookie without HTTP. The binding breaks as soon as a target fails or is added.',
  'balance random: ein zufällig gewähltes Ziel.': 'balance random: a randomly chosen target.',
  'Port {port} ist auf einem Reverse-Proxy belegt: SSH. Darüber wird dieser Server verwaltet.':
    'Port {port} is in use on a reverse proxy: SSH. This server is managed through it.',
  'Port {port} ist auf einem Reverse-Proxy belegt: HTTP. Darüber läuft die Weiterleitung auf HTTPS.':
    'Port {port} is in use on a reverse proxy: HTTP. It carries the redirect to HTTPS.',
  'Port {port} ist auf einem Reverse-Proxy belegt: HTTPS. Das ist das Frontend, in dem die Dienste liegen.':
    'Port {port} is in use on a reverse proxy: HTTPS. This is the frontend that holds the services.',
  'Port {port} ist auf einem Reverse-Proxy belegt: Die ACME-Challenge von acme.sh. Ohne den Port lässt sich kein Zertifikat mehr erneuern.':
    'Port {port} is in use on a reverse proxy: the ACME challenge of acme.sh. Without this port, no certificate can be renewed.',
  'Es wurde keine Gruppe ausgewählt.': 'No group was selected.',
  'Die Kennung darf nur a-z, 0-9 und _ enthalten und muss mit einem Buchstaben oder einer Ziffer beginnen.':
    'The identifier may only contain a-z, 0-9 and _ and must start with a letter or a digit.',
  'Der Port muss eine ganze Zahl zwischen {min} und {max} sein.': 'The port must be a whole number between {min} and {max}.',
  'Unbekanntes Verteilverfahren.': 'Unknown balancing method.',
  'Mindestens ein Ziel wird benötigt.': 'At least one target is required.',
  'Ungültiger Zielname: {name}': 'Invalid target name: {name}',
  'Der Zielname {name} steht doppelt. HAProxy lehnt zwei gleich benannte Server in einem Abschnitt ab.':
    'The target name {name} appears twice. HAProxy rejects two servers with the same name in one section.',
  'Ungültiges Ziel: {target}. Erwartet wird host:port.': 'Invalid target: {target}. Expected host:port.',
  'Ungültige Gewichtung für {target}: {weight}. HAProxy nimmt eine ganze Zahl von {min} bis {max}.':
    'Invalid weight for {target}: {weight}. HAProxy accepts a whole number from {min} to {max}.',
  'Ungültige Absenderadresse: {source}. Erwartet wird eine IP oder ein CIDR-Block.':
    'Invalid source address: {source}. Expected an IP or a CIDR block.',
  'Die Adresse {address} steht doppelt in der Liste.': 'The address {address} appears twice in the list.',
  'ohne bind-Zeile': 'no bind line',
  'ohne mode-Zeile': 'no mode line',
  'ohne option tcplog': 'no option tcplog',
  'mehrere tcp-request-connection-Regeln': 'multiple tcp-request connection rules',
  'server-Zeilen mit unterschiedlichem check': 'server lines with differing check',
  'Der Name "{name}" ist in der Konfiguration bereits vergeben ({line}).':
    'The name "{name}" is already taken in the configuration ({line}).',
  'Port {port} wird in der Konfiguration bereits von "{section}" gebunden. Ein zweiter Abschnitt auf demselben Port kommt durch die Prüfung und scheitert erst beim Reload.':
    'Port {port} is already bound by "{section}" in the configuration. A second section on the same port passes the check and only fails on reload.',
  'In der Konfiguration gibt es keinen Marker "# END AUTO {scope} BACKENDS". Ohne ihn ist nicht bestimmbar, wo der Abschnitt hingehört.':
    'The configuration has no marker "# END AUTO {scope} BACKENDS". Without it, there is no way to tell where the section belongs.',
  'Die TCP-Weiterleitung "{id}" steht nicht in der Konfiguration.': 'The TCP forward "{id}" is not in the configuration.',
  '"{id}" lässt sich nicht bearbeiten: der Abschnitt enthält Einstellungen, die dieses Formular nicht abbildet.':
    '"{id}" cannot be edited: the section contains settings this form does not cover.',
  'port muss eine ganze Zahl zwischen {min} und {max} sein.': 'port must be a whole number between {min} and {max}.',
  'HAProxy ist nicht erreichbar.': 'HAProxy is not reachable.',
  'Die HAProxy-Konfiguration auf "{server}" ist nicht lesbar.': 'The HAProxy configuration on "{server}" cannot be read.',
  'Auf "{server}" gibt es keine TCP-Weiterleitung mit der Kennung "{id}".':
    'There is no TCP forward with the identifier "{id}" on "{server}".',
  'Die Datei bricht mitten in einer Zahl ab.': 'The file ends in the middle of a number.',
  'Die Datei nennt {count} Länder. Mehr als 256 kann diese Tabelle nicht führen.':
    'The file lists {count} countries. This table cannot hold more than 256.',
  'Das ist keine übersetzte Länder-Tabelle.': 'This is not a compiled country table.',
  'Der Kopf der Länder-Tabelle ist unlesbar.': 'The header of the country table is unreadable.',
  'Der Stand der Datei fehlt oder ist unlesbar. Erwartet wird ein Monat wie 2026-08. DB-IP schreibt ihn in den Dateinamen.':
    'The version of the file is missing or unreadable. Expected a month such as 2026-08. DB-IP puts it in the file name.',
  'Es wurde keine Datei übertragen.': 'No file was uploaded.',
  'Die Datei ist größer als {mb} MB.': 'The file is larger than {mb} MB.',
  'Aus der Datei wurden nur {v4} IPv4- und {v6} IPv6-Bereiche. Erwartet wird der Datensatz „IP to Country Lite" mit den Spalten Anfang, Ende, Ländercode.':
    'The file yielded only {v4} IPv4 and {v6} IPv6 ranges. Expected the "IP to Country Lite" dataset with the columns start, end, country code.',
  'Die Datei ließ sich nicht auspacken.': 'The file could not be unpacked.',
  'db-ip.com leitet zu oft weiter. Die Datei wurde nicht geladen.': 'db-ip.com redirects too often. The file was not downloaded.',

  // lib/haproxy/provision.ts und Nachbarn, acme.sh, bootstrap
  'Der Name "{id}" wird gerade von einem laufenden Vorgang angelegt. Die Dienst-ID ist vergeben.':
    'The name "{id}" is being created by a running task. The service ID is taken.',
  'Server "{name}" hat die Rolle "Reverse-Proxy" nicht.': 'Server "{name}" does not have the reverse proxy role.',
  'Auf diesem Server ("{server}") lauscht bereits ein anderer Dienst auf Port {port}. HAProxy könnte ihn beim Neuladen nicht binden, und das fällt der Konfigurationsprüfung nicht auf.':
    'Another service is already listening on port {port} on this server ("{server}"). HAProxy could not bind it on reload, and the configuration check does not notice that.',
  'Es gibt keine acme.sh-Konfiguration ({file}). HAPM richtet acme.sh beim Start ein. Ob das geklappt hat, steht in der Übersicht.':
    'There is no acme.sh configuration ({file}). HAPM sets up acme.sh at startup. The overview shows whether that worked.',
  'Die Zugangsdaten ließen sich nicht ablegen: {detail}': 'The credentials could not be stored: {detail}',
  'Die Passwortsperre braucht HAProxy 2.4 oder neuer. Hier läuft {version}. Die Sperre auf Admin-IPs geht dort weiterhin.':
    'The password lock requires HAProxy 2.4 or newer. This server runs {version}. The lock by admin IPs still works there.',
  'acme.sh ({acme}) oder das Zertifikatsverzeichnis ({dir}) fehlt. Ohne beides lässt sich kein Zertifikat ausstellen. HAPM legt beides beim Start an. Ob das geklappt hat, steht in der Übersicht.':
    'acme.sh ({acme}) or the certificate directory ({dir}) is missing. Without both, no certificate can be issued. HAPM creates both at startup. The overview shows whether that worked.',
  '{file} ist nicht lesbar. Ob die Ersteinrichtung durchgelaufen ist, steht in der Übersicht.':
    '{file} is not readable. The overview shows whether the initial setup completed.',
  '{file} ist nicht lesbar.': '{file} is not readable.',
  'Der Dienst "{id}" steht nicht in {file}.': 'The target "{id}" is not in {file}.',
  'Die TCP-Weiterleitung "{id}" steht nicht in {file}.': 'The TCP forward "{id}" is not in {file}.',
  '"{id}" wurde nicht über HAPM angelegt und lässt sich hier nicht entfernen. ACL, Weiche oder Backend folgen nicht dem erwarteten Schema.':
    '"{id}" was not created by HAPM and cannot be removed here. ACL, routing rule or backend do not follow the expected pattern.',
  '"{id}" lässt sich nicht bearbeiten. Der Backend-Block enthält Einstellungen, die dieses Formular nicht abbildet: {extras}. Sie gingen beim Speichern verloren.':
    '"{id}" cannot be edited. The backend block contains settings this form does not cover: {extras}. They would be lost on saving.',
  '"{id}" lässt sich nicht bearbeiten. ACL, Weiche oder Backend folgen nicht dem erwarteten Schema.':
    '"{id}" cannot be edited. ACL, routing rule or backend do not follow the expected pattern.',
  '"{id}" lässt sich nicht bearbeiten. Der Abschnitt enthält Einstellungen, die dieses Formular nicht abbildet: {extras}. Sie gingen beim Speichern verloren.':
    '"{id}" cannot be edited. The section contains settings this form does not cover: {extras}. They would be lost on saving.',
  '"{id}" lässt sich nicht bearbeiten. Der Abschnitt folgt nicht dem erwarteten Schema.':
    '"{id}" cannot be edited. The section does not follow the expected pattern.',
  '"{id}" steht außerhalb der Marker-Blöcke und lässt sich hier nicht entfernen. Wo der Abschnitt anfängt, wäre geraten, und geraten wird an einer Konfiguration nicht, die fremde Ports bedient.':
    '"{id}" is outside the marker blocks and cannot be removed here. Where the section starts would be a guess, and HAPM does not guess on a configuration that serves other ports.',
  'Mindestens eine Domain wird benötigt.': 'At least one domain is required.',
  '"{domain}" ist keine gültige Domain.': '"{domain}" is not a valid domain.',
  'In der Konfiguration gebunden von "{name}".': 'Bound in the configuration by "{name}".',
  'Ob auf diesem Server etwas darauf lauscht, ließ sich nicht feststellen.':
    'Whether anything listens on it on this server could not be determined.',
  'Auf diesem Server lauscht bereits ein anderer Dienst darauf.': 'Another service is already listening on it on this server.',
  'Das Entfernen einer Gruppe braucht die Adresse von HAPM.': 'Removing a group requires the HAPM address.',
  'Kein Reverse-Proxy mit der ID "{wanted}". HAPM verwaltet genau einen: "{id}". serverId kann weggelassen werden.':
    'No reverse proxy with the ID "{wanted}". HAPM manages exactly one: "{id}". serverId can be omitted.',
  'Es ist keine Log-Quelle bekannt.': 'No log source is known.',
  // Schritte eines Laufs
  'Konfiguration einsetzen': 'Install configuration',
  'Die Konfiguration hat sich geändert, seit sie gelesen wurde. Es wurde nichts überschrieben. Bitte erneut versuchen.':
    'The configuration changed after it was read. Nothing was overwritten. Please try again.',
  'Backup anlegen': 'Create backup',
  'Backup angelegt': 'Backup created',
  'HAProxy neu laden': 'Reload HAProxy',
  'HAProxy neu geladen': 'HAProxy reloaded',
  'Konfiguration eingesetzt und HAProxy neu geladen': 'Configuration installed and HAProxy reloaded',
  'Alte Konfigurations-Backups aufgeräumt': 'Old configuration backups cleaned up',
  'Zertifikat schon vorhanden': 'Certificate already present',
  'Zertifikat war noch gültig': 'Certificate was still valid',
  'Zertifikat ausgestellt': 'Certificate issued',
  'Zertifikat wird ausgestellt': 'Issuing certificate',
  'Zertifikat wird ausgerollt': 'Deploying certificate',
  'Zertifikat ausrollen': 'Deploy certificate',
  'Zertifikat ausgerollt': 'Certificate deployed',
  'Zertifikat aus der Erneuerung genommen': 'Certificate removed from renewal',
  'Zertifikat bleibt stehen': 'Certificate kept',
  'Altes Zertifikat bleibt stehen': 'Old certificate kept',
  'Zertifikat unverändert': 'Certificate unchanged',
  'Die Domains sind dieselben geblieben, es wurde keins beantragt.': 'The domains are unchanged, no certificate was requested.',
  'Neue Konfiguration prüfen': 'Check new configuration',
  'Neue Konfiguration geprüft': 'New configuration checked',
  'Konfiguration prüfen': 'Check configuration',
  'Konfiguration geprüft': 'Configuration checked',
  'Weder in der Konfiguration noch auf diesem Server hält ihn jemand.': 'Nothing holds it, neither in the configuration nor on this server.',
  'Keine Änderung': 'No change',
  'Die Konfiguration steht bereits so da. Es wurde nichts geschrieben.': 'The configuration is already in this state. Nothing was written.',
  'Nichts zu schreiben': 'Nothing to write',
  'Keine Fehlerdatei weicht von der Vorlage ab.': 'No error file differs from the template.',
  'HAPM wurde neu gestartet, während der Vorgang lief. Die Schritte unten sind die, die noch abgeschlossen wurden; ob der letzte begonnene durchkam, sagt die Konfiguration von HAProxy.':
    'HAPM was restarted while the task was running. The steps below are the ones that still completed; the HAProxy configuration shows whether the last one started went through.',
  // acme.sh und die Ersteinrichtung (`lib/bootstrap.ts`), gezeigt in der Übersicht
  'acme.sh ist eingerichtet.': 'acme.sh is set up.',
  'acme.sh wurde installiert.': 'acme.sh was installed.',
  'Platzhalter-Zertifikat': 'Placeholder certificate',
  'Es liegen schon Zertifikate vor.': 'Certificates are already present.',
  'Selbst signiertes Zertifikat angelegt.': 'Self-signed certificate created.',
  'Alle Fehlerseiten liegen vor.': 'All error pages are present.',
  'Konfiguration': 'Configuration',
  'Grundkonfiguration angelegt.': 'Base configuration created.',
  'Grundkonfiguration angelegt (ohne IPv6, die Maschine hat keins).': 'Base configuration created (without IPv6, the machine has none).',
  'läuft': 'running',
  'war gestoppt und wurde gestartet.': 'was stopped and has been started.',
  'Verzeichnisse': 'Directories',
  // lib/haproxy/import.ts, import-run.ts, Routen des Imports
  'Die Konfiguration ist größer als {size} MB.': 'The configuration is larger than {size} MB.',
  'Die HAProxy-Konfiguration ist nicht lesbar. Der Zustand steht in der Übersicht.':
    'The HAProxy configuration cannot be read. The overview shows its status.',
  'Es wurde kein Eintrag ausgewählt.': 'No entry was selected.',
  'Die Gruppe „{name}" gibt es nicht oder nicht vollständig.': 'The group "{name}" does not exist or is incomplete.',
  'Die Auswahl passt nicht zum Text. Lassen Sie die Vorschau neu berechnen.':
    'The selection does not match the text. Recalculate the preview.',
  '{entry} lässt sich nicht mehr übernehmen: {reason} Lassen Sie die Vorschau neu berechnen.':
    '{entry} can no longer be imported: {reason} Recalculate the preview.',
  '{entry} lässt sich nicht mehr übernehmen. Lassen Sie die Vorschau neu berechnen.':
    '{entry} can no longer be imported. Recalculate the preview.',
  '{domain} und {count} weitere': '{domain} and {count} more',
  'Import abgebrochen': 'Import canceled',
  'Die Gruppe ließ sich nicht anlegen. Ohne sie gibt es keine Stelle für die Einträge.':
    'The group could not be created. Without it, there is no place for the entries.',
  'Der Eintrag hat weder Domain noch Port.': 'The entry has neither a domain nor a port.',
  'Zusammenfassung': 'Summary',
  'Es wurde keine Konfiguration übergeben.': 'No configuration was provided.',
  'Das ist keine Textdatei.': 'This is not a text file.',
  'Ein Anführungszeichen ist nicht geschlossen.': 'A quotation mark is not closed.',
  'Ein \\ am Zeilenende setzt in HAProxy keine Zeile fort. So lädt HAProxy die Datei nicht.':
    'A \\ at the end of a line does not continue the line in HAProxy. HAProxy does not load the file like this.',
  'Steht vor dem ersten Abschnitt.': 'Appears before the first section.',
  'Leere Bedingung.': 'Empty condition.',
  'Die Werte stehen in einer Datei (-f), die hier nicht vorliegt.':
    'The values are in a file (-f) that is not available here.',
  'Den Schalter {flag} kennt HAPM an einer Bedingung nicht.': 'HAPM does not support the flag {flag} in a condition.',
  '{criterion} mit -m {method} lässt offen, welcher Vergleich gilt.':
    '{criterion} with -m {method} leaves open which match applies.',
  'Der Vergleich „{match}" auf den Hostnamen lässt sich nicht als Liste von Domains schreiben.':
    'The match "{match}" on the host name cannot be written as a list of domains.',
  'Die Umwandlung {converter} kennt HAPM nicht.': 'HAPM does not support the converter {converter}.',
  'Die Bedingung nennt keine Domain.': 'The condition names no domain.',
  '{value}: ein Stern ist in diesem Vergleich ein Zeichen und keine Wildcard.':
    '{value}: in this match, an asterisk is a literal character, not a wildcard.',
  '{criterion} {value} trifft den Namen auch als Teil eines längeren. Übernommen werden {domain} und *.{domain}.':
    '{criterion} {value} also matches the name as part of a longer one. Imported as {domain} and *.{domain}.',
  '{criterion} {value} ohne führenden Punkt trifft auch Namen wie x{domain}. Übernommen werden {domain} und *.{domain}.':
    '{criterion} {value} without a leading dot also matches names like x{domain}. Imported as {domain} and *.{domain}.',
  '{domain} ist keine Domain, die HAPM anlegen kann.': '{domain} is not a domain HAPM can create.',
  'Einen Pfadvergleich ohne Groß- und Kleinschreibung (-i) kennt HAPM nicht.':
    'HAPM does not support case-insensitive path matching (-i).',
  'Die Bedingung nennt keinen Pfad.': 'The condition names no path.',
  '{path} ist kein Pfad, wie HAPM ihn vergleicht.': '{path} is not a path HAPM can match.',
  '{value}: keine Adresse oder kein CIDR-Block.': '{value}: not an address or CIDR block.',
  'Die Bedingung {condition} lässt sich in HAPM nicht abbilden.':
    'The condition {condition} cannot be represented in HAPM.',
  'Die ACL mischt Bedingungen verschiedener Art.': 'The ACL mixes conditions of different kinds.',
  'Die ACL {acl} ist nicht definiert oder eine eingebaute, die HAPM nicht abbildet.':
    'The ACL {acl} is not defined or is a built-in one that HAPM does not represent.',
  '„{line}": server-Zeile ohne Name oder Adresse.': '"{line}": server line without a name or address.',
  'Der Servername {name} enthält Zeichen, die HAPM nicht schreibt.':
    'The server name {name} contains characters HAPM does not write.',
  'server {name}: die Adresse {address} ist kein host:port.': 'server {name}: the address {address} is not host:port.',
  'server {name}: IPv6-Ziele ({address}) kennt HAPM noch nicht.':
    'server {name}: HAPM does not support IPv6 targets ({address}) yet.',
  'server {name}: {address} hat keinen Port. HAProxy nähme dann den Port der Anfrage.':
    'server {name}: {address} has no port. HAProxy would then use the port of the request.',
  'server {name}: {address} ist kein Ziel, wie HAPM es schreibt (host:port).':
    'server {name}: {address} is not a target in the form HAPM writes (host:port).',
  'server {name}: die Gewichtung {weight} nimmt HAProxy nicht.':
    'server {name}: HAProxy does not accept the weight {weight}.',
  'server {name}: {options} bildet HAPM nicht ab.': 'server {name}: HAPM does not represent {options}.',
  'server {name}: {options} ohne ssl kennt HAPM nicht.': 'server {name}: HAPM does not support {options} without ssl.',
  'server {name}: ca-file mit verify none kennt HAPM nicht.': 'server {name}: HAPM does not support ca-file with verify none.',
  'server {name}: HAPM schickt dem Ziel die Domain der Anfrage als SNI.':
    'server {name}: HAPM sends the domain of the request to the target as SNI.',
  'server {name}: verify {verify} kennt HAProxy nicht.': 'server {name}: HAProxy does not know verify {verify}.',
  'server {name}: ssl prüft das Zertifikat, aber ohne ca-file. So lädt HAProxy die Zeile nicht.':
    'server {name}: ssl verifies the certificate, but there is no ca-file. HAProxy does not load the line like this.',
  'server {name}: Eine eigene CA-Datei ({file}) kennt HAPM nicht, nur die CAs des Systems (@system-ca).':
    'server {name}: HAPM does not support a custom CA file ({file}), only the system CAs (@system-ca).',
  'server {name}: HAPM prüft das Zertifikat gegen die Domain der Anfrage (sni req.hdr(host)). Hier wird es anders geprüft, das Ziel könnte danach durchfallen.':
    'server {name}: HAPM verifies the certificate against the domain of the request (sni req.hdr(host)). It is verified differently here, so the target could fail afterwards.',
  'Die Ziele sprechen teils HTTP, teils HTTPS. HAPM kennt eine Art je Backend.':
    'Some targets speak HTTP, others HTTPS. HAPM supports one kind per backend.',
  'HTTPS zum Ziel': 'HTTPS to the target',
  'HTTPS zum Ziel, Zertifikat geprüft': 'HTTPS to the target, certificate verified',
  'Pfad-Regel: {what}': 'Path rule: {what}',
  'ssl an einer server-Zeile kennt HAPM bei einer TCP-Weiterleitung nicht: sie reicht durch, was kommt.':
    'HAPM does not support ssl on a server line of a TCP forward: it passes through whatever arrives.',
  'Den Code {code} kennt HAPM nicht, nur 301 und 302.': 'HAPM does not support the code {code}, only 301 and 302.',
  'Die Angabe {option} an der Weiterleitung kennt HAPM nicht.':
    'HAPM does not support the option {option} on a redirect.',
  'Das Ziel {target} ist keine vollständige Adresse, wie HAPM sie verlangt (https://…).':
    'The target {target} is not a complete address as HAPM requires it (https://…).',
  'Zeile {line}: {reason}': 'Line {line}: {reason}',
  '„{line}" setzt eine Umgebungsvariable ein, deren Wert hier niemand kennt.':
    '"{line}" uses an environment variable whose value is unknown here.',
  'Der Servername {name} steht doppelt.': 'The server name {name} appears twice.',
  '„{line}": ein Verfahren mit Parameter oder ein zweites kennt HAPM nicht.':
    '"{line}": HAPM does not support an algorithm with a parameter or a second one.',
  'option forwardfor entfällt: HAPM setzt X-Forwarded-For in seinen globalen Einstellungen für alle Ziele.':
    'option forwardfor is dropped: HAPM sets X-Forwarded-For for all targets in its global settings.',
  'timeout tunnel {value}: HAPM kennt für lange Verbindungen genau eine Stunde.':
    'timeout tunnel {value}: for long connections, HAPM supports exactly one hour.',
  '„{line}": ein Header mit Ausdruck oder Bedingung lässt sich nur als fester Text übernehmen.':
    '"{line}": a header with an expression or condition can only be imported as fixed text.',
  '„{line}": nur eine Weiterleitung ohne Bedingung lässt sich übernehmen.':
    '"{line}": only a redirect without a condition can be imported.',
  '„{line}": HAPM kennt hier nur eine Liste erlaubter Absender.':
    '"{line}": here, HAPM only supports a list of allowed sources.',
  'Die Statistikseite von HAProxy übernimmt HAPM nicht. Es zeigt eigene Zahlen.':
    'HAPM does not import the HAProxy stats page. It shows its own figures.',
  '„{line}" bildet HAPM nicht ab.': 'HAPM does not represent "{line}".',
  'Mehrere Absenderlisten: HAPM kennt eine.': 'Several source lists: HAPM supports one.',
  'Lief bisher ohne TLS ({section}). In HAPM läuft es über HTTPS mit eigenem Zertifikat, Port 80 leitet um.':
    'Previously ran without TLS ({section}). In HAPM it runs over HTTPS with its own certificate, port 80 redirects.',
  'Ports, TLS, Timeouts und Protokoll eines Frontends übernimmt HAPM nicht: es bringt sein eigenes Frontend mit. Auch die Zertifikate hinter „crt" nicht, sie werden neu ausgestellt.':
    'HAPM does not import the ports, TLS, timeouts and protocol of a frontend: it brings its own frontend. The certificates behind "crt" are not imported either, they are issued anew.',
  'Ports, TLS, Timeouts und Protokoll eines Frontends übernimmt HAPM nicht: es bringt sein eigenes Frontend mit.':
    'HAPM does not import the ports, TLS, timeouts and protocol of a frontend: it brings its own frontend.',
  'Die Umleitung auf HTTPS macht HAPM selbst, auf Port 80.': 'HAPM handles the redirect to HTTPS itself, on port 80.',
  'Diese Art Weiterleitung kennt HAPM nicht.': 'HAPM does not support this kind of redirect.',
  'Die Zeile setzt eine Umgebungsvariable ein, deren Wert hier niemand kennt.':
    'The line uses an environment variable whose value is unknown here.',
  'Die Weiterleitung hängt an keiner Domain und gälte für alle. Das kennt HAPM nicht.':
    'The redirect is not tied to a domain and would apply to all. HAPM does not support that.',
  'Die Weiterleitung hat eine Bedingung über die Domain hinaus.': 'The redirect has a condition beyond the domain.',
  '{domain} wird schon in Zeile {line} weitergeleitet. Diese Regel kam nie zum Zug.':
    '{domain} is already redirected in line {line}. This rule never took effect.',
  'Die Weiche bestimmt ihr Backend erst zur Laufzeit (Ausdruck oder Map-Datei). Das kennt HAPM nicht.':
    'The use_backend rule picks its backend only at runtime (expression or map file). HAPM does not support that.',
  'Das Backend {backend} steht nicht in der Datei.': 'The backend {backend} is not in the file.',
  'Eine Weiche ohne Bedingung nimmt allen Domains darunter den Verkehr. Das kennt HAPM nicht.':
    'A use_backend rule without a condition takes the traffic of all domains below it. HAPM does not support that.',
  '{reason} Die Weiche kann damit jede Domain treffen.':
    '{reason} The use_backend rule can therefore match any domain.',
  'Die Weiche hängt an keiner Domain und gälte für alle. Das kennt HAPM nicht.':
    'The use_backend rule is not tied to a domain and would apply to all. HAPM does not support that.',
  'Eine Weiche mit „unless" kennt HAPM nicht.': 'HAPM does not support a use_backend rule with "unless".',
  'Die Weiche hängt außer an der Domain an {terms} ({reason}).':
    'Besides the domain, the use_backend rule depends on {terms} ({reason}).',
  'Die Weiche hängt außer an der Domain an {terms}.': 'Besides the domain, the use_backend rule depends on {terms}.',
  'Die Weiche verlangt zwei Domain-Bedingungen zugleich.':
    'The use_backend rule requires two domain conditions at once.',
  'Die Weiche verlangt zwei Pfad-Bedingungen zugleich.': 'The use_backend rule requires two path conditions at once.',
  'Zeile {line} steht davor und kann auch diese Domain treffen. HAPM übernimmt sie nicht, ohne sie ginge ein Teil des Verkehrs woanders hin als bisher.':
    'Line {line} comes first and can also match this domain. HAPM does not import it, and without it part of the traffic would go somewhere else than before.',
  'Zeile {line}: {domain} (Zeile {earlier}) greift vorher. In HAPM käme diese Domain zuerst zum Zug, das änderte, wohin ihr Verkehr geht.':
    'Line {line}: {domain} (line {earlier}) matches first. In HAPM this domain would be matched first, which would change where its traffic goes.',
  '{domain} wird schon in Zeile {line} weitergeleitet. Diese Weiche kam nie zum Zug.':
    '{domain} is already redirected in line {line}. This use_backend rule never took effect.',
  '{domain} geht schon in Zeile {line} an {backend}. Diese Weiche kam nie zum Zug.':
    '{domain} already goes to {backend} in line {line}. This use_backend rule never took effect.',
  'Die Pfade {paths} hat {domain} schon weiter oben. Diese Weiche kam nie zum Zug.':
    '{domain} already has the paths {paths} further up. This use_backend rule never took effect.',
  'Eine Lua-Aktion für diese Domain übernimmt HAPM nicht.': 'HAPM does not import a Lua action for this domain.',
  'Die Regel „{rule}" für diese Domain bildet HAPM nicht ab.':
    'HAPM does not represent the rule "{rule}" for this domain.',
  'Lua-Aktionen übernimmt HAPM nicht.': 'HAPM does not import Lua actions.',
  'Die Regel gilt für alle Domains des Frontends. Was für alle gelten soll, steht in HAPM unter Reverse-Proxy, Einstellungen.':
    'The rule applies to all domains of the frontend. In HAPM, what applies to all is under Reverse proxy, Settings.',
  'Bindungen und Tabellen im Frontend bildet HAPM nicht ab.':
    'HAPM does not represent server bindings and stick tables in the frontend.',
  'Was keine Weiche trifft, ging an {backend}. In HAPM antwortet an dieser Stelle die Seite für unbekannte Domains.':
    'Whatever matched no use_backend rule went to {backend}. In HAPM, the page for unknown domains answers there.',
  'Die Ziele dieses listen-Abschnitts bekommen alles, was keine Weiche trifft. Das kennt HAPM nicht.':
    'The targets of this listen section receive everything that matches no use_backend rule. HAPM does not support that.',
  '{domain} hat nur Pfad-Regeln und keine Weiche für den Rest. HAPM braucht für jede Domain ein Ziel.':
    '{domain} has only path rules and no use_backend rule for the rest. HAPM needs a target for every domain.',
  'Lief bisher auf Port {ports}. In HAPM läuft es auf 443.': 'Previously ran on port {ports}. In HAPM it runs on 443.',
  '{section} nennt keinen mode, auch nicht über defaults. Weil er HTTP benutzt, gilt er als mode http.':
    '{section} names no mode, not even through defaults. Because it uses HTTP, it is treated as mode http.',
  '{domain} geht in {sources} woanders hin als in {section}. HAPM kennt einen Weg je Domain.':
    '{domain} goes somewhere else in {sources} than in {section}. HAPM supports one route per domain.',
  'Nur ein Teil der Ziele wird geprüft. HAPM prüft alle oder keins.':
    'Only some of the targets are checked. HAPM checks all or none.',
  'Der Healthcheck braucht eine Domain ohne Stern. Ohne ihn verteilte HAProxy auch auf tote Ziele.':
    'The healthcheck needs a domain without an asterisk. Without it, HAProxy would also send traffic to dead targets.',
  'Der Healthcheck entfällt: er braucht eine Domain ohne Stern.':
    'The healthcheck is dropped: it needs a domain without an asterisk.',
  'Healthcheck an. Bisher: „{line}". HAPM prüft GET / mit dem Host-Header {domain} und erwartet 200 bis 399.':
    'Healthcheck on. Previously: "{line}". HAPM checks GET / with the Host header {domain} and expects 200 to 399.',
  'Die Ziele werden über die Verbindung geprüft (check ohne option httpchk). HAPM kennt am Hauptziel nur die HTTP-Prüfung.':
    'The targets are checked by connection (check without option httpchk). For the main target, HAPM only supports the HTTP check.',
  'Die Verbindungsprüfung entfällt. Bei einem einzigen Ziel ändert das nichts daran, wohin der Verkehr geht.':
    'The connection check is dropped. With a single target, this does not change where the traffic goes.',
  'Cookie-Marken auf den server-Zeilen ohne cookie-Zeile im Backend.':
    'Cookie values on the server lines without a cookie line in the backend.',
  'cookie {name} {options}: HAPM kennt nur einen Cookie, den HAProxy selbst setzt (insert).':
    'cookie {name} {options}: HAPM only supports a cookie that HAProxy sets itself (insert).',
  'Die Angaben {options} am Cookie kennt HAPM nicht.': 'HAPM does not support the options {options} on the cookie.',
  'Die Sitzungsbindung steht nicht auf jeder server-Zeile.': 'Session persistence is not set on every server line.',
  'Die Sitzungsbindung heißt in HAPM {cookie} und trägt den Servernamen. Bestehende Bindungen gehen beim ersten Aufruf einmal verloren.':
    'In HAPM, the session persistence cookie is called {cookie} and carries the server name. Existing sessions lose their binding once, on the first request.',
  'Das Backend {backend} läuft in mode {mode} hinter einem HTTP-Frontend.':
    'The backend {backend} runs in mode {mode} behind an HTTP frontend.',
  'Das Backend leitet weiter und hat zugleich Ziele.': 'The backend redirects and has targets at the same time.',
  'Das Backend leitet weiter und trägt daneben Einstellungen für Ziele.':
    'The backend redirects and also carries settings for targets.',
  'Das Backend {backend} hat kein Ziel.': 'The backend {backend} has no target.',
  'Das Verfahren balance {balance} kennt HAPM nicht.': 'HAPM does not support the algorithm balance {balance}.',
  'Pfad-Regel {paths} (backend {backend})': 'Path rule {paths} (backend {backend})',
  '{rule}: eine Weiterleitung als Pfad-Regel kennt HAPM nicht.':
    '{rule}: HAPM does not support a redirect as a path rule.',
  '{rule}: kein Ziel.': '{rule}: no target.',
  '{rule}: ein Verfahren an einer Pfad-Regel kennt HAPM nicht.':
    '{rule}: HAPM does not support an algorithm on a path rule.',
  '{rule}: eine Sitzungsbindung an einer Pfad-Regel kennt HAPM nicht.':
    '{rule}: HAPM does not support session persistence on a path rule.',
  '{rule}: eine HTTP-Prüfung an einer Pfad-Regel kennt HAPM nicht, nur check.':
    '{rule}: HAPM does not support an HTTP check on a path rule, only check.',
  '{rule}: eine Gewichtung an einer Pfad-Regel kennt HAPM nicht.':
    '{rule}: HAPM does not support a weight on a path rule.',
  '{rule}: nur ein Teil der Ziele wird geprüft.': '{rule}: only some of the targets are checked.',
  '{rule}: Header und lange Verbindungen stehen dort anders als am Hauptziel. HAPM setzt sie für alle gleich.':
    '{rule}: headers and long connections are set differently there than on the main target. HAPM sets them the same for all.',
  'Eine Weiterleitung mit Pfad-Regeln kennt HAPM nicht.': 'HAPM does not support a redirect with path rules.',
  '{target} (Gewicht {weight})': '{target} (weight {weight})',
  '{code}, mit Pfad': '{code}, with path',
  '{code}, ohne Pfad': '{code}, without path',
  'Header an das Ziel: {name}': 'Header to the target: {name}',
  'Header an den Besucher: {name}': 'Header to the visitor: {name}',
  'Der Abschnitt hat keine bind-Zeile.': 'The section has no bind line.',
  'Der Abschnitt bindet mehrere oder keine lesbaren Ports. HAPM kennt einen je Weiterleitung.':
    'The section binds several ports or none that can be read. HAPM supports one per TCP forward.',
  'TLS am Port (bind … ssl) kennt HAPM bei einer TCP-Weiterleitung nicht: es reicht durch.':
    'HAPM does not support TLS on the port (bind … ssl) for a TCP forward: it passes the traffic through.',
  'Der Port ist an eine bestimmte Adresse gebunden. HAPM bindet an alle, der Port stünde danach weiter offen als vorher.':
    'The port is bound to a specific address. HAPM binds to all, so the port would be more open than before.',
  'Die Angaben {options} an bind kennt HAPM nicht.': 'HAPM does not support the options {options} on bind.',
  'HAPM bindet den Port mit „bind :Port" wie jede TCP-Weiterleitung, ohne eigene IPv6-Zeile.':
    'HAPM binds the port with "bind :Port" like every TCP forward, without a separate IPv6 line.',
  'Die Weiterleitung hat kein Ziel.': 'The TCP forward has no target.',
  'Das Verfahren balance {balance} kennt HAPM in mode tcp nicht.':
    'HAPM does not support the algorithm balance {balance} in mode tcp.',
  'Eine Cookie-Marke gibt es in mode tcp nicht.': 'Cookie values do not exist in mode tcp.',
  'nur von {sources}': 'only from {sources}',
  'offen für alle': 'open to all',
  'Globale Einstellungen übernimmt HAPM nicht: es bringt eigene mit (Prozess, Log, Statistik, TLS-Vorgaben).':
    'HAPM does not import global settings: it brings its own (process, log, stats, TLS defaults).',
  'Die Vorgaben (Timeouts, Log, Fehlerseiten) übernimmt HAPM nicht: es bringt eigene mit.':
    'HAPM does not import the defaults (timeouts, log, error pages): it brings its own.',
  'Benutzerlisten für Basic-Auth kennt HAPM nicht. Für einen Zugang mit Passwort gibt es am Eintrag die Passwortsperre.':
    'HAPM does not support user lists for basic auth. For access with a password, each entry has the password lock.',
  '{line} (Zeile {from} bis {to})': '{line} (lines {from} to {to})',
  '{line} (Zeile {from})': '{line} (line {from})',
  'Lua-Skripte übernimmt HAPM nicht.': 'HAPM does not import Lua scripts.',
  'Abschnitte der Art {kind} kennt HAPM nicht.': 'HAPM does not support sections of type {kind}.',
  'mode {mode} kennt HAPM nicht.': 'HAPM does not support mode {mode}.',
  'Weichen in mode tcp (etwa nach SNI, TLS wird durchgereicht) kennt HAPM nicht.':
    'HAPM does not support use_backend rules in mode tcp (for example by SNI, with TLS passed through).',
  'Das Frontend hat kein default_backend.': 'The frontend has no default_backend.',
  'Das Backend {backend} läuft nicht in mode tcp.': 'The backend {backend} does not run in mode tcp.',
  'Das Frontend trägt eigene server-Zeilen.': 'The frontend has its own server lines.',
  'Die Absenderliste steht im Backend. HAPM erwartet sie am Port.':
    'The source list is in the backend. HAPM expects it on the port.',
  'Auf dieses Backend zeigt keine Weiche. Es wird nicht übernommen.':
    'No use_backend rule points to this backend. It is not imported.',
  'Port {port} steht schon in Zeile {line}.': 'Port {port} already appears in line {line}.',
  'Die Domain {domain} wird in HAPM schon von „{service}" bedient.':
    'In HAPM, the domain {domain} is already served by "{service}".',
  'acme.sh fehlt. Ohne lässt sich kein Zertifikat ausstellen. Der Zustand steht in der Übersicht.':
    'acme.sh is missing. Without it, no certificate can be issued. The overview shows its status.',
  'Port {port} ist in HAPM schon gebunden ({section}).': 'Port {port} is already bound in HAPM ({section}).',
  'Die Gruppe {name} gibt es schon. Wählen Sie sie oben aus.': 'The group {name} already exists. Select it above.',
  // lib/haproxy/config.ts, challenge.ts, protected.ts, dns-credentials.ts, runner.ts, Phasen, Routen
  'Unbekannter DNS-Anbieter.': 'Unknown DNS provider.',
  'Keine Einträge angegeben.': 'No entries given.',
  'Reverse-Proxy-Vorgang nicht gefunden.': 'Reverse proxy task not found.',
  'Es wurde keine Gruppe angegeben.': 'No group was given.',
  'Es wurde kein HAProxy-Log gefunden. HAPM schreibt das Log des HAProxy-Containers nach /var/log/haproxy/haproxy.log mit. Liegt dort nichts, hat HAProxy noch keine Anfrage protokolliert oder läuft nicht.': 'No HAProxy log was found. HAPM copies the log of the HAProxy container to /var/log/haproxy/haproxy.log. If nothing is there, HAProxy has not logged a request yet or is not running.',
  'Auf "{server}" gibt es kein Ziel mit der ID "{id}".': 'There is no target with the ID "{id}" on "{server}".',
  'Wartet': 'Waiting',
  'DNS-Eintrag': 'DNS record',
  'Konfiguration lesen': 'Read configuration',
  'Prüfung': 'Check',
  'Einsetzen und neu laden': 'Install and reload',
  'Aufräumen': 'Clean up',
  'Fertig': 'Done',
  'Der DNS-Hook "{hook}" ist nicht eingerichtet. Zur Auswahl stehen: {hooks}.': 'The DNS hook "{hook}" is not set up. Available: {hooks}.',
  'Für eine Wildcard-Domain muss der DNS-Hook gewählt werden, der die Challenge setzt. Eingerichtet: {hooks}.': 'A wildcard domain needs a chosen DNS hook to set the challenge. Set up: {hooks}.',
  'Das Zertifikat wird über DNS-01 ausgestellt. Dafür muss der DNS-Hook gewählt werden, der die Challenge setzt. Eingerichtet: {hooks}.': 'The certificate is issued over DNS-01. For that, choose the DNS hook that sets the challenge. Set up: {hooks}.',
  'Anfrage': 'Request',
  'Antwort': 'Response',
  'Ungültiger Header-Name: „{name}". Erlaubt sind Buchstaben, Ziffern und der Bindestrich.': 'Invalid header name: "{name}". Letters, digits and the hyphen are allowed.',
  'Der Header-Name {name} ist länger als {max} Zeichen.': 'The header name {name} is longer than {max} characters.',
  'Der Header {name} gehört zur Übertragung selbst und lässt sich nicht fest setzen.': 'The header {name} belongs to the transfer itself and cannot be set to a fixed value.',
  'Der Header {name} braucht einen Wert.': 'The header {name} needs a value.',
  'Der Wert von {name} ist länger als {max} Zeichen.': 'The value of {name} is longer than {max} characters.',
  'Der Wert von {name} enthält ein Zeichen, das hier nicht geht. Erlaubt sind druckbare ASCII-Zeichen, keine Umlaute und keine Zeilenumbrüche.': 'The value of {name} contains a character that is not allowed here. Printable ASCII characters are allowed, no umlauts and no line breaks.',
  'Der Wert von {name} beginnt oder endet mit einem Leerzeichen.': 'The value of {name} starts or ends with a space.',
  'In den Headern der Anfrage stehen mehr als {max} Einträge.': 'The request headers have more than {max} entries.',
  'In den Headern der Antwort stehen mehr als {max} Einträge.': 'The response headers have more than {max} entries.',
  'Der Header {name} steht doppelt in den Headern der Anfrage.': 'The header {name} appears twice in the request headers.',
  'Der Header {name} steht doppelt in den Headern der Antwort.': 'The header {name} appears twice in the response headers.',
  'Die beiden Header, die Nextcloud in seiner Sicherheitsprüfung erwartet.': 'The two headers Nextcloud expects in its security check.',
  'Die Seite lässt sich nicht in fremde Seiten einbetten.': 'The page cannot be embedded in other sites.',
  'Suchmaschinen nehmen die Seite nicht in ihren Index auf.': 'Search engines do not add the page to their index.',
  'Unbekanntes Preset.': 'Unknown preset.',
  'balance roundrobin: jede Anfrage an das nächste Ziel, der Reihe nach. Der Normalfall für Webserver, die untereinander nichts teilen müssen.': 'balance roundrobin: each request goes to the next target in turn. The usual case for web servers that do not need to share anything.',
  'balance leastconn: immer an das Ziel mit den wenigsten offenen Verbindungen. Passt, wenn Anfragen unterschiedlich lange dauern — etwa bei Downloads oder langen Abfragen.': 'balance leastconn: always to the target with the fewest open connections. Fits when requests take different amounts of time, for example downloads or long queries.',
  'balance source: aus der Quell-IP wird ein Hash, und der bestimmt das Ziel. Dieselbe Adresse landet damit immer beim selben Server, ohne Cookie. Die Bindung bricht allerdings, sobald ein Ziel ausfällt oder dazukommt — dann rechnet der Hash für alle neu.': 'balance source: the source IP is hashed, and the hash picks the target. The same address always lands on the same server, without a cookie. The binding breaks as soon as a target fails or is added, because the hash is then recalculated for everyone.',
  'balance uri: aus dem angefragten Pfad wird ein Hash. Derselbe Pfad landet immer beim selben Ziel; gedacht für Caches vor statischen Inhalten.': 'balance uri: the requested path is hashed. The same path always lands on the same target; meant for caches in front of static content.',
  'balance random: ein zufällig gewähltes Ziel. Verteilt auch dann gleichmäßig, wenn mehrere Proxys davorstehen und Round Robin bei jedem für sich läuft.': 'balance random: a randomly chosen target. Distributes evenly even when several proxies sit in front and each runs Round Robin on its own.',
  'Die Dienst-ID darf nur a-z, 0-9 und _ enthalten und muss mit einem Buchstaben oder einer Ziffer beginnen.': 'The service ID may only contain a-z, 0-9 and _ and must start with a letter or a digit.',
  'Eine Wildcard wird als *.beispiel.example geschrieben: {domain}': 'A wildcard is written as *.example.com: {domain}',
  'Ungültiger Domainname: {domain}': 'Invalid domain name: {domain}',
  'Die Domain {domain} steht doppelt in der Liste.': 'The domain {domain} appears twice in the list.',
  'Die Weiterleitung braucht ein Ziel.': 'The redirect needs a target.',
  'Ungültiges Weiterleitungsziel: {target}. Erwartet wird eine vollständige Adresse wie https://beispiel.example.': 'Invalid redirect target: {target}. Expected a full address like https://example.com.',
  'Eine Weiterleitung hat kein Backend-Ziel. Entweder die Domains gehen an einen Server, oder sie werden weitergeleitet.': 'A redirect has no backend target. Either the domains go to a server, or they are redirected.',
  'Eine Weiterleitung und Pfad-Regeln schließen sich aus: es gibt kein Backend, auf das eine Regel zeigen könnte.': 'A redirect and path rules exclude each other: there is no backend a rule could point to.',
  'Header und lange Verbindungen gehören zu einem Backend mit Zielen. Eine Weiterleitung hat keine.': 'Headers and long-lived connections belong to a backend with targets. A redirect has none.',
  'Ein Verteilverfahren gehört zu einem Backend mit Zielen. Eine Weiterleitung hat keine.': 'A balancing method belongs to a backend with targets. A redirect has none.',
  'Eine Sitzungsbindung gehört zu einem Backend mit Zielen. Eine Weiterleitung hat keine.': 'Session persistence belongs to a backend with targets. A redirect has none.',
  'Die Domain {domain} gehört nicht zu diesem Eintrag und lässt sich hier nicht sperren.': 'The domain {domain} does not belong to this entry and cannot be locked here.',
  'Die Domain {domain} steht doppelt in der Sperrliste.': 'The domain {domain} appears twice in the lock list.',
  'Eine Passwortsperre braucht mindestens eine gesperrte Domain.': 'A password lock needs at least one locked domain.',
  'Die Angaben der Passwortsperre haben nicht die erwartete Form.': 'The password lock data does not have the expected form.',
  'Ungültiger Name der Pfad-Regel: „{name}". Erlaubt sind a-z, 0-9 und _.': 'Invalid path rule name: "{name}". Allowed are a-z, 0-9 and _.',
  'Die Pfad-Regel „{name}" steht doppelt. Aus zwei gleichen Namen würde ein Backend-Name.': 'The path rule "{name}" appears twice. Two equal names would become one backend name.',
  'Die Pfad-Regel „{name}" hat keinen Pfad. Ohne Pfad greift sie nie.': 'The path rule "{name}" has no path. Without a path it never applies.',
  'Ungültiger Pfad in „{name}": {path}. Er muss mit / beginnen und darf kein Leerzeichen enthalten.': 'Invalid path in "{name}": {path}. It must start with / and must not contain a space.',
  'Der Pfad {path} steht in zwei Regeln.': 'The path {path} appears in two rules.',
  'Mindestens ein Backend-Ziel wird benötigt.': 'At least one backend target is required.',
  'Mindestens ein Ziel der Pfad-Regel „{route}" wird benötigt.': 'At least one target of the path rule "{route}" is required.',
  'Ungültiger Servername: {name}': 'Invalid server name: {name}',
  'Der Servername {name} steht doppelt. HAProxy lehnt zwei gleich benannte Server in einem Backend ab.': 'The server name {name} appears twice. HAProxy rejects two servers with the same name in one backend.',
  'Ungültiges Backend-Ziel: {target}. Erwartet wird host:port.': 'Invalid backend target: {target}. Expected host:port.',
  'Ungültiges Ziel der Pfad-Regel „{route}": {target}. Erwartet wird host:port.': 'Invalid target of the path rule "{route}": {target}. Expected host:port.',
  'Das Passwort der Sperre braucht mindestens {min} Zeichen.': 'The lock password needs at least {min} characters.',
  'Das Passwort der Sperre darf höchstens {max} Zeichen lang sein.': 'The lock password may be at most {max} characters long.',
  'Das Passwort der Sperre darf keine Steuerzeichen enthalten.': 'The lock password must not contain control characters.',
  'Für die Passwortsperre von "{id}" ist kein Passwort gesetzt.': 'No password is set for the password lock of "{id}".',
  'Eine Zeile darf keinen Zeilenumbruch enthalten.': 'A line must not contain a line break.',
  'Kommentarzeilen gehen hier nicht: "{line}". Der Block endet am ersten Kommentar, alles darunter stünde danach außerhalb.': 'Comment lines are not allowed here: "{line}". The block ends at the first comment, and everything below it would end up outside.',
  '"{line}" beginnt einen neuen Konfigurationsabschnitt und beendet damit den Block. Diese Zeile gehört an eine andere Stelle der Datei.': '"{line}" starts a new configuration section and so ends the block. This line belongs somewhere else in the file.',
  'Keine gültige Adresse: {address}. Erwartet wird eine IP oder ein Netz wie 10.0.0.0/8.': 'Not a valid address: {address}. Expected an IP or a network like 10.0.0.0/8.',
  'In {file} fehlt die Zeile "{marker}". Ohne sie ist nicht bestimmbar, wo die globalen Einstellungen stehen.': 'The line "{marker}" is missing in {file}. Without it, there is no way to tell where the global settings are.',
  '"acl {acl} src …" steht mehr als einmal in {file}. HAProxy verodert die Zeilen; sie zu einer zusammenzuschreiben wäre eine Änderung, die niemand angefordert hat.': '"acl {acl} src …" appears more than once in {file}. HAProxy combines the lines with OR; merging them into one would be a change nobody asked for.',
  'Die Admin-IPs lassen sich nicht leeren, solange {count} Eintrag/Einträge darauf gesperrt sind: {names}. Erst dort die Sperre lösen.': 'The admin IPs cannot be cleared while {count} entry/entries are locked to them: {names}. Remove the lock there first.',
  'In {file} war keine Stelle zu finden, an die "acl {acl}" gehört: gesucht wird die letzte bind-Zeile des Frontends, in dem die Dienste stehen.': 'No place for "acl {acl}" was found in {file}: it goes after the last bind line of the frontend that holds the services.',
  'In {file} fehlt der Marker "{marker}". Ohne ihn ist nicht bestimmbar, wo der Eintrag hingehört.': 'The marker "{marker}" is missing in {file}. Without it, there is no way to tell where the entry belongs.',
  'Der Name der Gruppe braucht mindestens zwei Zeichen.': 'The group name needs at least two characters.',
  'Der Name der Gruppe ist auf {max} Zeichen begrenzt.': 'The group name is limited to {max} characters.',
  'Der Name darf nur a-z, 0-9, _ und - enthalten und muss mit einem Buchstaben beginnen.': 'The name may only contain a-z, 0-9, _ and - and must start with a letter.',
  '„{name}“ ist der Name einer Seite unter Reverse-Proxy. Bitte einen anderen Namen wählen.': '"{name}" is the name of a page under Reverse proxy. Please choose another name.',
  'In {file} steht kein einziger Marker "# END AUTO … {kind}" und auch nicht die Zeile "{marker}". Ohne eines von beiden ist nicht bestimmbar, an welche Stelle der Datei eine neue Gruppe gehört.': '{file} contains no "# END AUTO … {kind}" marker and no "{marker}" line. Without one of them, there is no way to tell where in the file a new group belongs.',
  'Es gibt in {file} bereits eine Gruppe "{name}".': 'A group "{name}" already exists in {file}.',
  'Die Gruppe "{name}" steht nicht in {file}.': 'The group "{name}" is not in {file}.',
  'In der Gruppe "{name}" stehen noch {count} Einträge: {entries}. Erst dort aufräumen.': 'The group "{name}" still has {count} entries: {entries}. Clean them up first.',
  'Die Gruppe "{name}" lässt sich hier nicht entfernen. Dafür müssen BEGIN- und END-Marker beider Teile dastehen und nichts als Leerzeilen dazwischen — sonst ist nicht bestimmbar, was zu ihr gehört und was zum Block darüber.': 'The group "{name}" cannot be removed here. For that, the BEGIN and END markers of both parts must be present with nothing but blank lines between them. Otherwise there is no way to tell what belongs to it and what belongs to the block above.',
  'Die ACL "{acl}" gibt es bereits. Die Dienst-ID ist vergeben.': 'The ACL "{acl}" already exists. The service ID is taken.',
  'Der Name "{id}" ist in der Konfiguration bereits vergeben ({line}). Die Dienst-ID ist belegt.': 'The name "{id}" is already used in the configuration ({line}). The service ID is taken.',
  'Die ACL "{acl}" gibt es bereits. Der Name der Pfad-Regel „{route}" ist vergeben.': 'The ACL "{acl}" already exists. The path rule name "{route}" is taken.',
  'Das Backend "{backend}" gibt es bereits. Der Name der Pfad-Regel „{route}" ist vergeben.': 'The backend "{backend}" already exists. The path rule name "{route}" is taken.',
  'Die Domain {domain} wird bereits von "{id}" bedient.': 'The domain {domain} is already served by "{id}".',
  'Es sind keine Admin-IPs gesetzt. Ohne mindestens eine Adresse lässt sich kein Eintrag sperren — die Liste steht unter Reverse-Proxy → Einstellungen.': 'No admin IPs are set. Without at least one address no entry can be locked. The list is under Reverse proxy → Settings.',
  'In {file} gibt es keine vollständige Gruppe "{name}". Erwartet werden "{services}" und "{backends}", jeweils genau einmal.': 'There is no complete group "{name}" in {file}. Expected "{services}" and "{backends}", each exactly once.',
  'Für "{id}" ist noch kein Passwort gesetzt. Eine Passwortsperre braucht eins.': 'No password is set for "{id}" yet. A password lock needs one.',
  '"{id}" lässt sich nicht bearbeiten: der Eintrag enthält Einstellungen, die dieses Formular nicht abbildet.': '"{id}" cannot be edited: the entry contains settings this form does not cover.',
  'adminIps setzt die ganze Liste, addAdminIps/removeAdminIps ändern sie. Beides in einem Aufruf lässt offen, was gemeint ist.': 'adminIps sets the whole list, addAdminIps/removeAdminIps change it. Both in one call leaves open what is meant.',
  'Aus der Hetzner-Konsole: im Projekt der Zone unter Sicherheit, API-Tokens. Mit Lese- und Schreibrecht.': 'From the Hetzner console: in the project of the zone under Security, API tokens. With read and write access.',
  'Der Token gilt für alle Zonen seines Projekts.': 'The token applies to all zones of its project.',
  'Ein Token mit der Berechtigung „Zone · DNS · Bearbeiten" auf den betreffenden Zonen. Nicht der Global API Key.': 'A token with the permission "Zone · DNS · Edit" on the zones in question. Not the Global API Key.',
  'Account-ID': 'Account ID',
  'Nur nötig, wenn der Token für mehrere Konten gilt. Steht in der Cloudflare-Übersicht rechts.': 'Only needed if the token applies to several accounts. Shown on the right of the Cloudflare overview.',
  'Der Token wird für jede Zone in diesem Konto benutzt. Eine neue Domain braucht danach nichts mehr.': 'The token is used for every zone in this account. A new domain needs nothing more after that.',
  'Das Feld {name} gehört nicht zu {provider}.': 'The field {name} does not belong to {provider}.',
  'Der Wert für {name} enthält ein Zeichen, das acme.sh nicht ablegen kann. Erlaubt sind Buchstaben, Ziffern und . _ ~ + / = : @ -': 'The value for {name} contains a character acme.sh cannot store. Allowed are letters, digits and . _ ~ + / = : @ -',
  'API-Token wird benötigt.': 'API token is required.',
  '{field} wird benötigt.': '{field} is required.',
  'Über dieses Ziel ist die Oberfläche von HAPM erreichbar ({url}). Es lässt sich nicht entfernen. Wer die Adresse ändern will, ändert sie unter Allgemein. Danach lässt sich dieses Ziel entfernen.': 'The HAPM interface is reachable through this target ({url}). It cannot be removed. To change the address, change it under General. After that, this target can be removed.',
  'Über dieses Ziel ist die Oberfläche von HAPM erreichbar ({url}). Die Domain {host} muss deshalb bei diesem Ziel bleiben. Wer die Adresse ändern will, ändert sie unter Allgemein. Danach lässt sich die Domain ändern.': 'The HAPM interface is reachable through this target ({url}). The domain {host} must therefore stay with this target. To change the address, change it under General. After that, the domain can be changed.',
  'In dieser Gruppe liegt das Ziel, über das die Oberfläche von HAPM erreichbar ist ({url}). Sie lässt sich nicht entfernen. Wer die Adresse ändern will, ändert sie unter Allgemein. Danach lässt sich die Gruppe entfernen.': 'This group holds the target through which the HAPM interface is reachable ({url}). It cannot be removed. To change the address, change it under General. After that, the group can be removed.',
  'nichts gesetzt': 'nothing set',
  'DNS-Einträge entfernen': 'Remove DNS records',
  '[fehler]': '[error]',
  '[läuft]': '[running]',
  // app/api/geoip/**
  "Der Schalter für das selbsttätige Erneuern kennt nur an und aus.": "The automatic refresh switch only knows on and off.",
  "Der Abruf ist gescheitert.": "The download failed.",
  // Zertifikate: hochladen, eigener ACME-Server, eigener DNS-Server
  "Unbekannte Zertifikatsdatei.": "Unknown certificate file.",
  "Zertifikat und Schlüssel sind zusammen größer als 100 KB. Das ist keine Kette mehr.": "Certificate and key together are larger than 100 KB. That is no longer a chain.",
  "Im Feld für das Zertifikat steht kein PEM-Zertifikat. Erwartet wird ein Text, der mit -----BEGIN CERTIFICATE----- beginnt.": "The certificate field contains no PEM certificate. Expected is a text that starts with -----BEGIN CERTIFICATE-----.",
  "Es fehlt der private Schlüssel. Erwartet wird ein Text, der mit -----BEGIN PRIVATE KEY----- oder ähnlich beginnt.": "The private key is missing. Expected is a text that starts with -----BEGIN PRIVATE KEY----- or similar.",
  "Es steht mehr als ein privater Schlüssel da. Bitte nur den Schlüssel zu diesem Zertifikat.": "There is more than one private key. Please provide only the key for this certificate.",
  "Der private Schlüssel ist mit einem Passwort verschlüsselt. HAProxy kann ihn so nicht laden. Bitte laden Sie ihn unverschlüsselt hoch.": "The private key is encrypted with a password. HAProxy cannot load it like that. Please upload it unencrypted.",
  "Das Zertifikat lässt sich nicht lesen. Ist der Text vollständig kopiert?": "The certificate cannot be read. Was the text copied completely?",
  "Der private Schlüssel lässt sich nicht lesen. Ist der Text vollständig kopiert?": "The private key cannot be read. Was the text copied completely?",
  "Der private Schlüssel gehört zu keinem der Zertifikate.": "The private key belongs to none of the certificates.",
  "Die Kette passt nicht: das Zertifikat nach dem der Domain hat es nicht ausgestellt. Erwartet wird zuerst das Zertifikat, dann das Zwischenzertifikat, das es ausgestellt hat.": "The chain does not match: the certificate after the domain's certificate did not issue it. Expected is the certificate first, then the intermediate certificate that issued it.",
  "Das Zertifikat ist seit dem {date} abgelaufen.": "The certificate expired on {date}.",
  "Das Zertifikat gilt erst ab dem {date}.": "The certificate is only valid from {date}.",
  "Das Zertifikat nennt keinen Domainnamen. Für eine IP-Adresse allein taugt es hier nicht.": "The certificate names no domain. A certificate for an IP address alone does not work here.",
  "\"{domain}\" im Zertifikat ist kein Domainname, den HAPM einem Ziel zuordnen kann.": "\"{domain}\" in the certificate is not a domain name HAPM can assign to a target.",
  "Diese Installation stellt keine Zertifikate selbst aus, und für {domains} ist keins hochgeladen. Laden Sie es zuerst unter Reverse-Proxy, Zertifikate hoch.": "This installation does not issue certificates itself, and none is uploaded for {domains}. Upload it first under Reverse proxy, Certificates.",
  "Eine Wildcard-Domain lässt sich nur über DNS-01 ausstellen, und dafür sind noch keine DNS-Zugangsdaten hinterlegt. Sie werden unter Reverse-Proxy, Einstellungen eingetragen. Einmal hinterlegt, merkt acme.sh sie sich für jede Erneuerung. Ohne sie bleibt ein hochgeladenes Zertifikat (Reverse-Proxy, Zertifikate).": "A wildcard domain can only be issued over DNS-01, and no DNS credentials have been added for that yet. Enter them under Reverse proxy, Settings. Once added, acme.sh keeps them for every renewal. Without them, an uploaded certificate remains (Reverse proxy, Certificates).",
  "Diese Installation ist als intern eingerichtet: Let's Encrypt erreicht den Server nicht, jedes Zertifikat wird über DNS-01 ausgestellt. Dafür fehlen die DNS-Zugangsdaten. Sie werden unter Reverse-Proxy, Einstellungen eingetragen. Ohne sie geht es nur mit einem eigenen ACME-Server, der HAPM über Port 80 erreicht (Allgemein), oder mit einem hochgeladenen Zertifikat (Reverse-Proxy, Zertifikate).": "This installation is set up as internal: Let's Encrypt cannot reach the server, so every certificate is issued over DNS-01. The DNS credentials for that are missing. Enter them under Reverse proxy, Settings. Without them, the only ways are your own ACME server that reaches HAPM on port 80 (General) or an uploaded certificate (Reverse proxy, Certificates).",
  "Hochgeladenes Zertifikat bleibt stehen": "Uploaded certificate is kept",
  "HAProxy nimmt die Zertifikate so nicht an. Es wurde nichts geändert: {detail}": "HAProxy does not accept the certificates like this. Nothing was changed: {detail}",
  "HAProxy ließ sich nicht neu laden. Der vorherige Stand ist zurückgespielt: {detail}": "HAProxy could not be reloaded. The previous state is restored: {detail}",
  "Für {domain} führt acme.sh ein Zertifikat unter demselben Dateinamen. Ein hochgeladenes an seiner Stelle überschriebe die nächste Erneuerung.": "acme.sh keeps a certificate for {domain} under the same file name. The next renewal would overwrite an uploaded one in its place.",
  "Das Zertifikat {file} ist kein hochgeladenes. Ersetzt werden können nur hochgeladene.": "The certificate {file} is not an uploaded one. Only uploaded certificates can be replaced.",
  "Unter {file} liegt schon ein hochgeladenes Zertifikat. Ersetzen Sie es über seine Zeile.": "An uploaded certificate already exists as {file}. Replace it from its row.",
  "Das neue Zertifikat deckt nicht ab, was das bisherige für diese Ziele abgedeckt hat: {list}.": "The new certificate does not cover what the previous one covered for these targets: {list}.",
  "Das Zertifikat ließ sich nicht ablegen: {detail}": "The certificate could not be stored: {detail}",
  "Das Zertifikat ließ sich nicht einsetzen: {detail}": "The certificate could not be installed: {detail}",
  "{file} ist kein hochgeladenes Zertifikat. Zertifikate von acme.sh vergehen mit ihrem Ziel.": "{file} is not an uploaded certificate. Certificates from acme.sh are removed with their target.",
  "Das Zertifikat wird noch gebraucht: {list}. Entfernen Sie zuerst die Ziele oder laden Sie ein anderes Zertifikat für sie hoch.": "The certificate is still needed: {list}. Remove the targets first or upload another certificate for them.",
  "Das Zertifikat ließ sich nicht entfernen: {detail}": "The certificate could not be removed: {detail}",
  // Fehlerseiten: Art der Seiten, eigene HTML-Datei (app/(app)/reverse-proxy/fehlerseiten, lib/haproxy/page-design.ts, design-pages.ts)
  'Standard': 'Standard',
  'Die Fehlerseite von HAPM, hell oder dunkel nach dem Gerät des Besuchers.':
    "HAPM's error page, light or dark depending on the visitor's device.",
  'Selbst gestalten': 'Custom design',
  'Die Seite von HAPM mit eigenen Farben, Logo und Texten.': "HAPM's page with your own colors, logo and texts.",
  'Eigene HTML-Datei': 'Own HTML file',
  'Ihre Datei, unverändert für alle Fehlerseiten.': 'Your file, unchanged for all error pages.',
  'Vorlage einsetzen?': 'Insert template?',
  'Das HTML wird durch die Vorlage von HAPM ersetzt. Gespeichert ist damit noch nichts.':
    'The HTML is replaced by the template from HAPM. Nothing is saved yet.',
  'Einsetzen': 'Insert',
  'Art, Farben, Logo, Schriftzug, Fußzeile, Sprache, alle Texte und die eigene HTML-Datei gehen auf die Vorgabe zurück. Danach schreibt HAPM die Seiten neu und lädt HAProxy neu.':
    'Type, colors, logo, name, footer, language, all texts and your own HTML file return to the defaults. HAPM then rewrites the pages and reloads HAProxy.',
  'Art der Seiten': 'Page type',
  'Gilt für alle Fehlerseiten.': 'Applies to all error pages.',
  'Die Datei geht unverändert hinaus, für jeden Fehler dieselbe. HAPM setzt nichts ein und legt keinen Rahmen darum. CSS steht in einem <style> der Datei. Bilder und Schriften von anderen Adressen lädt der Browser des Besuchers nach.':
    "The file is delivered unchanged, the same one for every error. HAPM inserts nothing and adds no wrapper. CSS goes into a <style> in the file. The visitor's browser loads images and fonts from other addresses itself.",
  'Eine Datei für jeden Status, so wie sie hier steht.': 'One file for every status, exactly as it is here.',
  'Vorlage einsetzen': 'Insert template',
  'Die Passwortabfrage behält das Design von HAPM.': 'The password prompt keeps the design from HAPM.',
  'Als Fehlerseite hätte die Datei {bytes} Bytes, HAProxy lädt höchstens {max}. Kürzen Sie das HTML.':
    'As an error page, the file would have {bytes} bytes, HAProxy loads at most {max}. Shorten the HTML.',
  '{name} hat {bytes} Bytes. Eine ganze Seite darf höchstens {max} Bytes haben.':
    '{name} has {bytes} bytes. A whole page may have at most {max} bytes.',
  'Die eigene HTML-Datei ist ungültig.': 'The custom HTML file is invalid.',
  'Das HTML': 'The HTML',
  'Das HTML ist leer. Geben Sie die ganze Seite ein oder wählen Sie eine andere Art.':
    'The HTML is empty. Enter the whole page or choose another type.',
  'Die Eingabe ist zu groß. Jede Seite darf samt Logo oder eigenem HTML höchstens {max} Bytes haben.':
    'The input is too large. Each page, including the logo or your own HTML, may have at most {max} bytes.',
  'Die Art der Fehlerseiten ist unbekannt.': 'The type of error pages is unknown.',
  'Farbschema des Besuchers': "Visitor's color scheme",
  'Hell': 'Light',
  'Dunkel': 'Dark',
  'Die Gruppe {scope} gehört der Oberfläche von HAPM. Weitere Ziele und Weiterleitungen kommen in eine andere Gruppe.':
    'The group {scope} belongs to the HAPM web interface. Put other targets and forwards into another group.',
  // HTTPS zum Ziel
  'Unbekannte Angabe, wie das Ziel angesprochen wird. Erlaubt sind off, insecure und verify.':
    'Unknown setting for how the target is addressed. Allowed are off, insecure and verify.',
  'HTTPS zum Ziel gehört zu einem Backend mit Zielen. Eine Weiterleitung hat keine.':
    'HTTPS to the target belongs to a backend with targets. A redirect has none.',
  'Unbekannte Angabe, wie die Ziele der Pfad-Regel „{name}" angesprochen werden.':
    'Unknown setting for how the targets of the path rule "{name}" are addressed.',
  'Das Zertifikat des Ziels gegen die CAs des Systems zu prüfen braucht HAProxy 2.6 oder neuer. Hier läuft {version}. HTTPS ohne Prüfung geht dort.':
    'Verifying the target certificate against the system CAs needs HAProxy 2.6 or newer. This one runs {version}. HTTPS without verification works there.',

  // lib/haproxy/base-config-diff.ts, Route /api/haproxy/base-config
  'Schaltet HTTP/3 auch dann frei, wenn die TLS-Bibliothek von HAProxy keine QUIC-Schnittstelle hat. Ohne die Zeile bleiben die quic-Listener dann aus. Wo die Bibliothek QUIC kann, ist die Zeile wirkungslos.':
    'Enables HTTP/3 even when the TLS library of HAProxy has no QUIC interface. Without this line the quic listeners stay off in that case. Where the library supports QUIC, the line has no effect.',
  'Sperrt HAProxy nach dem Start in dieses Verzeichnis ein. Ein Fehler in HAProxy erreicht den Rest des Dateisystems dann nicht.':
    'Locks HAProxy into this directory after startup. A flaw in HAProxy then cannot reach the rest of the file system.',
  'Über diesen Socket liest HAPM, ob die Ziele antworten.': 'HAPM reads through this socket whether the targets respond.',
  'Wie lange eine Verbindung zum Socket ohne Befehl offen bleibt.': 'How long a connection to the socket stays open without a command.',
  'HAProxy gibt nach dem Start die Rechte von root ab und läuft als dieser Benutzer und diese Gruppe.':
    'After startup HAProxy drops root privileges and runs as this user and group.',
  'Verzeichnis für relative Pfade zu CAs und Zertifikaten.': 'Directory for relative paths to CAs and certificates.',
  'Verfahren für TLS 1.2: nur solche mit Forward Secrecy und AEAD.': 'Ciphers for TLS 1.2: only those with forward secrecy and AEAD.',
  'Verfahren für TLS 1.3.': 'Cipher suites for TLS 1.3.',
  'TLS ab Version 1.2. no-tls-tickets schaltet Sitzungstickets ab, deren Schlüssel sonst über viele Verbindungen gleich bliebe.':
    'TLS from version 1.2. no-tls-tickets turns off session tickets, whose key would otherwise stay the same across many connections.',
  'Die Abschnitte schreiben in das Log, das in global steht.': 'The sections write to the log defined in global.',
  'HAProxy liest HTTP. Ohne das gibt es keine Weichen nach Domain, keine Kopfzeilen und keine Sperren.':
    'HAProxy reads HTTP. Without it there is no routing by domain, no headers and no locks.',
  'Eine ausführliche Logzeile je Anfrage. Logs und Statistik in HAPM lesen dieses Format.':
    'A detailed log line per request. Logs and statistics in HAPM read this format.',
  'Verbindungen ohne Anfrage, etwa von Port-Scans, kommen nicht ins Log.': 'Connections without a request, such as port scans, are not logged.',
  'Wie lange HAProxy auf den Verbindungsaufbau zum Ziel wartet.': 'How long HAProxy waits for the connection to the target.',
  'Wie lange eine Verbindung offen bleibt, über die der Besucher nichts schickt.': 'How long a connection stays open while the visitor sends nothing.',
  'Wie lange HAProxy auf eine Antwort des Ziels wartet.': 'How long HAProxy waits for a response from the target.',
  'Bis dahin muss eine Anfrage vollständig angekommen sein. Schützt vor Anfragen, die absichtlich langsam tröpfeln.':
    'A request must arrive completely within this time. Protects against requests that trickle in slowly on purpose.',
  'Wie lange eine Verbindung zwischen zwei Anfragen offen bleibt.': 'How long a connection stays open between two requests.',
  'Wie lange eine Anfrage wartet, wenn alle Ziele ausgelastet sind.': 'How long a request waits when all targets are busy.',
  'Erkennt die Prüfanfragen von Let’s Encrypt (HTTP-01).': 'Detects the validation requests from Let’s Encrypt (HTTP-01).',
  'Leitet alles außer der ACME-Challenge auf HTTPS um.': 'Redirects everything except the ACME challenge to HTTPS.',
  'Gibt die ACME-Challenge an acme.sh weiter.': 'Passes the ACME challenge to acme.sh.',
  'Sagt dem Browser, dass HTTP/3 auf Port 443 bereitsteht.': 'Tells the browser that HTTP/3 is available on port 443.',
  'Unbekannte Domains bekommen die Fehlerseite 404.': 'Unknown domains get the 404 error page.',
  'HAProxy läuft im Container im Vordergrund. Das Abbild startet es mit -db, das hebt die Zeile auf. HAPM schreibt sie deshalb nicht.':
    'HAProxy runs in the foreground in the container. The image starts it with -db, which overrides this line. HAPM therefore does not write it.',
  'Die Fehlerseite von HAPM für diesen Status. Die Datei legt HAPM beim Start an.': 'The HAPM error page for this status. HAPM creates the file at startup.',
  'HTTP/3 über QUIC auf Port 443.': 'HTTP/3 over QUIC on port 443.',
  'Nimmt HTTP an, für die Umleitung auf HTTPS und die ACME-Challenge.': 'Accepts HTTP, for the redirect to HTTPS and the ACME challenge.',
  'HTTPS mit allen Zertifikaten aus dem Verzeichnis. strict-sni: ohne passendes Zertifikat kommt keine Verbindung zustande, statt dass ein fremder Name das Zertifikat einer anderen Domain sieht.':
    'HTTPS with all certificates from the directory. strict-sni: without a matching certificate no connection is made, instead of an unknown name seeing the certificate of another domain.',
  'Die Abweichung „{id}" gibt es in der Konfiguration nicht mehr. Bitte die Seite neu laden.':
    'The difference “{id}” no longer exists in the configuration. Please reload the page.',
  'Zeilen, die es nur in dieser Datei gibt, werden nicht angefasst: {line}': 'Lines that exist only in this file are left untouched: {line}',
  'Es wurde keine Abweichung ausgewählt.': 'No difference was selected.',
  'Es wurde kein Zertifikat angegeben.': 'No certificate was given.',
  'acme.sh führt kein Zertifikat für {domain}.': 'acme.sh has no certificate for {domain}.',
  'Das Zertifikat für {domain} ist ausgestellt. acme.sh erneuert es selbst.':
    'The certificate for {domain} is issued. acme.sh renews it by itself.',
};
