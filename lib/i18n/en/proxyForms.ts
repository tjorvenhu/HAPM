import type { Dictionary } from './index';

/** Reverse-Proxy, Dialoge und Bausteine (`components/reverse-proxy/`, `components/IpAllowList.tsx`). */
export const proxyForms: Dictionary = {
  // Von mehreren Dialogen gebraucht, womöglich auch außerhalb
  'Zurücksetzen': 'Reset',
  'Bitte wählen': 'Please select',
  'Adresse': 'Address',
  'Zeile entfernen': 'Remove row',
  'Unbekannter Fehler.': 'Unknown error.',
  'Das hat nicht geklappt.': 'That did not work.',
  'Einstellungen öffnen': 'Open settings',
  'Wird entfernt · {phase}': 'Removing · {phase}',
  'Nicht abgebildet: {extras}': 'Not represented: {extras}',
  'Nicht änderbar. {reason}.': 'Cannot be changed. {reason}.',
  'Nur lesbar': 'Read-only',
  'Port {port}': 'Port {port}',
  'Gewicht': 'Weight',
  'Gewicht von Ziel {number}': 'Weight of target {number}',
  'Ziel hinzufügen': 'Add target',
  'Verteilverfahren': 'Balancing algorithm',
  'Vorgabe der Konfiguration': 'Configuration default',
  'Verbindungsprüfung': 'Connection check',
  'Healthcheck': 'Healthcheck',
  'Sitzungsbindung': 'Session persistence',
  'Weiterleitung': 'Redirect',
  'Backend': 'Backend',
  'Nur Admin-IPs': 'Admin IPs only',
  'Sperren': 'Lock',
  'HAProxy erreicht einen Teil der Ziele nicht': 'HAProxy cannot reach some of the targets',

  // Arten eines Ziels (`TargetKindDialog.tsx`)
  'Lastverteilung': 'Load balancer',
  'HTTP-Weiterleitung': 'HTTP redirect',
  'TCP-Weiterleitung': 'TCP forward',
  'Was soll angelegt werden?': 'What do you want to create?',
  'Eine Domain auf ein Ziel, mit Zertifikat. Der Normalfall.':
    'One domain to one target, with certificate. The usual case.',
  'Eine Domain auf mehrere Ziele: Verfahren, Gewicht, Sitzungsbindung.':
    'One domain to several targets: algorithm, weight, session persistence.',
  'Eine Domain antwortet mit 301 oder 302 und zeigt woanders hin.':
    'A domain answers with 301 or 302 and points elsewhere.',
  'Ein Port dieses Servers an ein Ziel dahinter: Datenbank, SSH, SMTP.':
    'A port of this server to a target behind it: database, SSH, SMTP.',

  // Adressliste (`components/IpAllowList.tsx`)
  'Erlaubte Adressen': 'Allowed addresses',
  'Von welchen Adressen dieses Token gelten darf.':
    'The addresses this token is valid from.',
  '203.0.113.7 oder 10.0.0.0/8': '203.0.113.7 or 10.0.0.0/8',
  'Adresse hinzufügen': 'Add address',
  'Ohne Eintrag gilt das Token von jeder Adresse aus.':
    'Without an entry, the token is valid from any address.',

  // Sperre (`LockDialog.tsx`)
  'Wie soll gesperrt werden?': 'How do you want to lock it?',
  'Mit Passwort sperren': 'Lock with password',
  'Nur erreichbar von {addresses}. Alle anderen bekommen 403.': 'Only reachable from {addresses}. Everyone else gets 403.',
  'Es sind keine Admin-IPs gesetzt. Sie stehen unter Reverse-Proxy, Einstellungen.':
    'No admin IPs are set. They are under Reverse proxy, Settings.',
  'Mit Passwort': 'With password',
  'Besucher geben ein Passwort ein und kommen danach 30 Tage lang durch.':
    'Visitors enter a password and then get through for 30 days.',
  'Braucht HAProxy 2.4 oder neuer. Hier läuft {version}.': 'Needs HAProxy 2.4 or newer. This server runs {version}.',
  'Das sperrt alle {count} Domains. Einzelne sperrt man beim Bearbeiten.':
    'This locks all {count} domains. Lock single domains when editing.',
  'Mindestens {min} Zeichen. Jetzt kopieren: gespeichert wird nur ein Hash.':
    'At least {min} characters. Copy it now: only a hash is stored.',

  // Karte eines Ziels (`ServiceCard.tsx`)
  'Wird eingerichtet': 'Setting up',
  'Zertifikat, Prüfung und Reload laufen. Der Eintrag erscheint vollständig, sobald HAProxy die neue Konfiguration übernommen hat.':
    'Certificate, check and reload are running. The entry appears in full once HAProxy has taken over the new configuration.',
  'Ein anderer Vorgang an HAProxy läuft noch. Dieser beginnt, sobald er fertig ist.':
    'Another HAProxy task is still running. This one starts as soon as it has finished.',
  'HAProxy erreicht alle Ziele dieses Eintrags': 'HAProxy reaches all targets of this entry',
  'HAProxy erreicht kein Ziel dieses Eintrags': 'HAProxy reaches no target of this entry',
  'HAProxy prüft die Ziele. Ihr Zustand ist hier nicht bekannt: kein stats socket in der Konfiguration, kein socat oder kein check auf der server-Zeile.':
    'HAProxy checks the targets. Their state is not known here: no stats socket in the configuration, no socat, or no check on the server line.',
  'ACL, Weiche oder Backend folgen nicht dem erwarteten Schema': 'ACL, use_backend rule or backend do not follow the expected pattern',
  'Antwort: {name}': 'Response: {name}',
  'Anfrage: {name}': 'Request: {name}',
  'Lange Verbindungen': 'Long connections',
  'Gesperrt mit Passwort: {domains}. Hier alle Domains öffnen.': 'Locked with password: {domains}. Open all domains here.',
  'Gesperrt auf {addresses}: {domains}. Hier alle Domains öffnen.': 'Locked to {addresses}: {domains}. Open all domains here.',
  'Gesperrt mit Passwort. Hier lösen.': 'Locked with password. Unlock here.',
  'Gesperrt auf {addresses}. Hier lösen.': 'Locked to {addresses}. Unlock here.',
  'Offen für alle. Hier sperren: auf Admin-IPs oder mit Passwort.': 'Open to everyone. Lock here: to admin IPs or with a password.',
  'Oberfläche von HAPM': 'HAPM interface',
  'HAPM ist über dieses Ziel erreichbar ({url}). Es lässt sich nicht entfernen.':
    'HAPM is reachable through this target ({url}). It cannot be removed.',
  '{locked} von {total} gesperrt': '{locked} of {total} locked',
  'Besucher sehen eine Passwortabfrage': 'Visitors see a password prompt',
  'Passwortabfrage für: {domains}': 'Password prompt for: {domains}',
  'Nur erreichbar von {addresses}': 'Only reachable from {addresses}',
  'Nur von {addresses} erreichbar: {domains}': 'Only reachable from {addresses}: {domains}',
  'Verdeckt': 'Shadowed',
  'Die Weiche von „{other}“ steht weiter oben und passt auch für diese Domains. HAProxy nimmt die erste, dieser Eintrag wird nie erreicht.':
    'The use_backend rule of “{other}” comes earlier and also matches these domains. HAProxy takes the first one, so this entry is never reached.',
  'Ein Besucher bleibt über einen Cookie bei dem Ziel, auf dem er gelandet ist. HAProxy setzt ihn selbst und nimmt ihn aus der Anfrage, bevor sie hinten ankommt.':
    'A cookie keeps a visitor on the target they landed on. HAProxy sets it itself and removes it from the request before it reaches the target.',
  'Header': 'Headers',
  'Weitere Domain: {domain}': 'Additional domain: {domain}',
  '{domains} · Dienst-ID {id}': '{domains} · Service ID {id}',
  'Der Vorgang läuft. Der Fortschritt steht unten rechts.': 'The task is running. Progress is shown at the bottom right.',
  'Die Domains werden nicht bedient, sondern weitergeschickt': 'The domains are not served but redirected',
  'Pfad geht mit: /pfad → {to}/pfad': 'Path is kept: /path → {to}/path',
  'Alles geht auf {to}': 'Everything goes to {to}',
  'mit Pfad': 'with path',
  'ohne Pfad': 'without path',
  'Wohin alles geht, was auf keine Pfad-Regel passt': 'Where everything goes that matches no path rule',
  'kein Backend-Server eingetragen': 'no backend server configured',
  'Pfad-Regeln zuklappen': 'Collapse path rules',
  'Pfade, die auf einen anderen Port gehen: {paths}': 'Paths that go to another port: {paths}',
  'Routen': 'Routes',
  'Alle Domains öffnen': 'Open all domains',
  'Statistik dieses Dienstes': 'Statistics of this service',
  'Nicht entfernbar: Oberfläche von HAPM. Die Adresse steht unter Allgemein.':
    'Cannot be removed: HAPM interface. The address is under General.',
  'Nicht über HAPM angelegt: ACL, Weiche oder Backend folgen nicht dem erwarteten Schema':
    'Not created by HAPM: ACL, use_backend rule or backend do not follow the expected pattern',

  // Karte einer TCP-Weiterleitung (`StreamCard.tsx`)
  'HAProxy erreicht alle Ziele dieser Weiterleitung': 'HAProxy reaches all targets of this forward',
  'HAProxy erreicht kein Ziel dieser Weiterleitung': 'HAProxy reaches no target of this forward',
  'Der Zustand ist hier nicht bekannt: kein stats socket in der Konfiguration, kein socat oder kein check auf der server-Zeile.':
    'The state is not known here: no stats socket in the configuration, no socat, or no check on the server line.',
  'Der Abschnitt folgt nicht dem erwarteten Schema': 'The section does not follow the expected pattern',
  'Von überall': 'From anywhere',
  'Keine Absenderliste: der Port nimmt Verbindungen von jeder Adresse an. Was dahinter liegt, ist die einzige Prüfung, die noch stattfindet.':
    'No source list: the port accepts connections from any address. Whatever is behind it is the only check left.',
  '{count} Absender': '{count} sources',
  'Nur erreichbar von {addresses}. Alles andere wird abgewiesen, bevor ein Byte gelesen wird.':
    'Only reachable from {addresses}. Everything else is rejected before a single byte is read.',
  'Wie die Verbindungen auf die Ziele verteilt werden': 'How connections are distributed across the targets',
  'TCP-Weiterleitung {id} · Port {port} · Erreichbar von außen nur, wenn der Port auch in der Firewall freigegeben ist':
    'TCP forward {id} · Port {port} · Reachable from outside only if the port is also open in the firewall',
  'Port unbekannt': 'Port unknown',
  'Wohin die Verbindungen gehen': 'Where the connections go',
  'kein Ziel eingetragen': 'no target configured',
  'Steht außerhalb der Marker-Blöcke. Wo der Abschnitt anfängt, wäre geraten.':
    'Outside the marker blocks. Where the section starts would be a guess.',

  // TCP-Weiterleitung anlegen und bearbeiten (`StreamFormModal.tsx`)
  'TCP-Weiterleitung „{id}“ ändern': 'Change TCP forward “{id}”',
  'TCP-Weiterleitung „{id}“ anlegen': 'Create TCP forward “{id}”',
  'TCP-Weiterleitung bearbeiten': 'Edit TCP forward',
  'TCP-Weiterleitung anlegen': 'Create TCP forward',
  'Ein Port dieses Servers, durchgereicht an ein Ziel dahinter.':
    'A port of this server, passed through to a target behind it.',
  'Port auf diesem Server': 'Port on this server',
  'Die Kennung des listen-Abschnitts bleibt, auch wenn sich der Port ändert.':
    'The identifier of the listen section stays the same, even if the port changes.',
  'Aus dem Port ergibt sich die Kennung des listen-Abschnitts, zum Beispiel tcp_5432.':
    'The identifier of the listen section is derived from the port, for example tcp_5432.',
  'Wird auf dem Server geprüft…': 'Checking on the server…',
  '{min} bis {max}. HAProxy lauscht danach auf allen Adressen des Servers.':
    '{min} to {max}. HAProxy then listens on all addresses of this server.',
  'Frei.': 'Free.',
  'Weder in der Konfiguration noch auf dem Server belegt.': 'Not in use in the configuration or on the server.',
  'Belegt: {reason}': 'In use: {reason}',
  'Belegt.': 'In use.',
  'Die TCP-Weiterleitung ließ sich nicht anlegen.': 'The TCP forward could not be created.',
  'Die TCP-Weiterleitung ließ sich nicht speichern.': 'The TCP forward could not be saved.',
  'Das Ziel ließ sich nicht anlegen.': 'The target could not be created.',
  'Das Ziel ließ sich nicht speichern.': 'The target could not be saved.',
  'Der Server ließ sich nicht speichern.': 'The server could not be saved.',
  'Kennung: {id}': 'Identifier: {id}',
  'Die Firewall macht dieser Vorgang nicht auf.': 'This task does not open the firewall.',
  'Er ändert nur die HAProxy-Konfiguration. Damit der Port von außen erreichbar ist, muss er zusätzlich freigegeben sein: auf diesem Server selbst (nftables, ufw, firewalld) und, falls davor eine liegt, in der Firewall des Anbieters oder der Cloud. Ohne das läuft der Eintrag hier durch und die Verbindung von außen bleibt trotzdem hängen.':
    'It only changes the HAProxy configuration. For the port to be reachable from outside, it must also be opened: on this server itself (nftables, ufw, firewalld) and, if there is one in front, in the firewall of the hosting provider or cloud. Without that, the entry goes through here and connections from outside still hang.',
  'Port {port} ist belegt.': 'Port {port} is in use.',
  'Ein zweiter Abschnitt auf demselben Port kommt durch die Konfigurationsprüfung und scheitert erst beim Neuladen: sie liest die Datei, sie bindet keine Sockets. Der Vorgang wird deshalb hier abgelehnt.':
    'A second section on the same port passes the configuration check and only fails on reload: the check reads the file, it does not bind sockets. That is why the task is refused here.',
  'Erreichbar von': 'Reachable from',
  'Leer heißt: von jeder Adresse im Internet.':
    'Empty means: from every address on the internet.',
  'Adresse oder CIDR-Bereich, IPv4 und IPv6. Eine Zeile pro Absender.':
    'Address or CIDR range, IPv4 and IPv6. One line per source.',
  'Der Port ist danach von überall erreichbar. Für einen Dienst, der selbst keine Anmeldung verlangt, ist das die Sorte Entscheidung, die man trifft, ohne sie zu treffen.':
    'The port is then reachable from anywhere. For a service that does not ask for a sign-in itself, this is the kind of decision you make without making it.',
  'Abgewiesen wird die Verbindung, bevor ein einziges Byte gelesen wird ({rule}). Für den Absender sieht das aus, als wäre nichts da.':
    'The connection is rejected before a single byte is read ({rule}). To the sender it looks as if nothing is there.',
  'Wohin die Verbindungen gehen. Mehr als eines heißt Lastverteilung.':
    'Where the connections go. More than one means load balancing.',
  'Wie HAProxy das Ziel erreicht. Der Port darf ein anderer sein als hier.':
    'How HAProxy reaches the target. The port may differ from the one here.',
  'Das Gewicht ist der Anteil eines Ziels im Verhältnis zu den anderen. Leer heißt, dass keine {weight}-Angabe geschrieben wird und HAProxys Vorgabe gilt. {zero} nimmt ein Ziel aus der Verteilung, ohne bestehende Verbindungen zu trennen.':
    'The weight is the share of a target relative to the others. Empty means no {weight} setting is written and the HAProxy default applies. {zero} takes a target out of the rotation without closing existing connections.',
  'Es wird keine balance-Zeile geschrieben. Dann gilt, was im defaults-Block der Konfiguration steht. URI Hash steht hier nicht zur Wahl: es liest den angefragten Pfad, und den gibt es ohne HTTP nicht.':
    'No balance line is written. Then whatever is in the defaults block of the configuration applies. URI hash is not offered here: it reads the requested path, and there is none without HTTP.',
  'Aus heißt: über den Zustand der Ziele ist nichts bekannt, und die Karte zeigt keine Farbe. HAProxy schickt Verbindungen auch an ein Ziel, das nicht antwortet.':
    'Off means: nothing is known about the state of the targets, and the card shows no color. HAProxy also sends connections to a target that does not respond.',
  'Der Abschnitt landet im BACKENDS-Block der Gruppe. Geprüft wird die neue Konfiguration mit {command}, bevor sie eingesetzt wird; scheitert der Reload, kommt das Backup zurück.':
    'The section goes into the BACKENDS block of the group. The new configuration is checked with {command} before it is put in place; if the reload fails, the backup is restored.',

  // Ziel anlegen und bearbeiten (`ServiceFormModal.tsx`)
  'Reverse-Proxy anlegen': 'Create reverse proxy',
  'Reverse-Proxy bearbeiten': 'Edit reverse proxy',
  'Lastverteilung anlegen': 'Create load balancer',
  'Lastverteilung bearbeiten': 'Edit load balancer',
  'HTTP-Weiterleitung anlegen': 'Create HTTP redirect',
  'HTTP-Weiterleitung bearbeiten': 'Edit HTTP redirect',
  'Ziel „{id}“ ändern': 'Change target “{id}”',
  'Ziel „{id}“ anlegen': 'Create target “{id}”',
  'Offen': 'Open',
  'Mit Passwort gesperrt, siehe Zugriff': 'Locked with password, see Access',
  'Nur für Admin-IPs, siehe Zugriff': 'Admin IPs only, see Access',
  'Die globalen Einstellungen setzen {header} schon. Für dieses Ziel gilt der Wert hier.':
    'The global settings already set {header}. For this target, the value here applies.',
  'Die globalen Einstellungen setzen {header} für alle Ziele und überschreiben den Wert hier. Er kommt beim Besucher nicht an.':
    'The global settings set {header} for all targets and override the value here. It does not reach the visitor.',
  'Für die Sperre ist keine Domain ausgewählt.': 'No domain is selected for the lock.',
  'Für die Passwortsperre fehlt das Passwort.': 'The password lock has no password.',
  'Eine Wildcard-Domain lässt Let’s Encrypt nur über DNS-01 ausstellen, und es ist kein DNS-Hook von acme.sh eingerichtet. Die Zugangsdaten stehen unter Reverse-Proxy, Einstellungen.':
    'Let’s Encrypt issues a wildcard domain only via DNS-01, and no acme.sh DNS hook is set up. The credentials are under Reverse proxy, Settings.',
  'In dieser internen Installation wird jedes Zertifikat über DNS-01 ausgestellt, und es ist kein DNS-Hook von acme.sh eingerichtet. Die Zugangsdaten stehen unter Reverse-Proxy, Einstellungen.':
    'In this internal installation every certificate is issued via DNS-01, and no acme.sh DNS hook is set up. The credentials are under Reverse proxy, Settings.',
  'Bitte wählen Sie den DNS-Hook, der die Challenge setzt.': 'Please select the DNS hook that sets the challenge.',
  'Die Domains ändern sich. Dafür wird ein neues Zertifikat beantragt.':
    'The domains change. A new certificate will be requested for this.',
  'Die Adressen des Eintrags und seine Gruppe.': 'The addresses of the entry and its group.',
  'Noch keine Gruppe. Gruppen legt man in der Übersicht an.':
    'No group yet. Groups are created in the overview.',
  'Hauptdomain': 'Primary domain',
  'Nach ihr heißt das Zertifikat, und sie steht im Host-Header des Healthchecks. Die Dienst-ID bleibt, auch wenn sich die Hauptdomain ändert.':
    'The certificate is named after it, and it is the Host header of the healthcheck. The service ID stays the same, even if the primary domain changes.',
  'Nach ihr heißt das Zertifikat, sie steht im Host-Header des Healthchecks, und aus ihr ergibt sich die Dienst-ID, die ACL und Backend benennt.':
    'The certificate is named after it, it is the Host header of the healthcheck, and the service ID that names ACL and backend is derived from it.',
  'Dienst-ID: {id}': 'Service ID: {id}',
  'Weitere Domains': 'Additional domains',
  'Über dieses Ziel ist die Oberfläche von HAPM erreichbar ({url}). Die Domain {host} bleibt deshalb in der Liste. Die Adresse lässt sich unter Allgemein ändern.':
    'The HAPM interface is reachable through this target ({url}). The domain {host} therefore stays in the list. The address can be changed under General.',
  'DNS-Hook für die Wildcard': 'DNS hook for the wildcard',
  'Zertifikat über DNS': 'Certificate via DNS',
  'Es ist kein DNS-Hook von acme.sh eingerichtet. Eine Wildcard lässt Let’s Encrypt nur über DNS-01 ausstellen.':
    'No acme.sh DNS hook is set up. Let’s Encrypt issues a wildcard only via DNS-01.',
  'Es ist kein DNS-Hook von acme.sh eingerichtet. In dieser internen Installation wird jedes Zertifikat über DNS-01 ausgestellt.':
    'No acme.sh DNS hook is set up. In this internal installation every certificate is issued via DNS-01.',
  'Die Zugangsdaten der Zone werden unter Reverse-Proxy, Einstellungen hinterlegt: einmal dort eingetragen, merkt acme.sh sie sich für jede Erneuerung.':
    'The credentials of the zone are added under Reverse proxy, Settings: once entered there, acme.sh remembers them for every renewal.',
  'Interne Installation: das Zertifikat wird über DNS ausgestellt.': 'Internal installation: the certificate is issued via DNS.',
  'Interne Installation: ausgestellt wird über {hook}.': 'Internal installation: issued via {hook}.',
  'DNS-Einträge': 'DNS records',
  'Der Eintrag zeigt auf die Domain der Zone selbst, deren A-Eintrag auf diesen Server zeigt. Beim Entfernen des Ziels wird angeboten, ihn mitzunehmen.':
    'The record points to the domain of the zone itself, whose A record points to this server. When the target is removed, you are offered to remove it too.',
  'DNS-Zone {zone}: {fqdn} ist bereits als CNAME auf {zone} eingerichtet.':
    'DNS zone {zone}: {fqdn} is already set up as a CNAME to {zone}.',
  'Dort steht ein {type}-Eintrag auf {content}. Er wird nicht angefasst.':
    'There is a {type} record pointing to {content}. It is left alone.',
  'Die Zone {zone} ist gerade nicht lesbar: {error}': 'The zone {zone} cannot be read right now: {error}',
  'Legt {fqdn} als CNAME auf {zone} an, ohne Cloudflare-Proxy.': 'Creates {fqdn} as a CNAME to {zone}, without the Cloudflare proxy.',
  'Legt {fqdn} als CNAME auf {zone} an.': 'Creates {fqdn} as a CNAME to {zone}.',
  'DNS-Eintrag für {domain}': 'DNS record for {domain}',
  'Zeigt auf {addresses}, diesen Server.': 'Points to {addresses}, this server.',
  'Zeigt auf {addresses}. Das ist keine Adresse dieses Servers.': 'Points to {addresses}. That is not an address of this server.',
  'Löst noch nicht auf. Der DNS-Eintrag fehlt.': 'Does not resolve yet. The DNS record is missing.',
  'Die DNS-Abfrage ist gescheitert.': 'The DNS lookup failed.',
  'DNS wird abgefragt…': 'Looking up DNS…',
  'Löst schon auf ({addresses}), aber nicht über {zone}. Mit dem Eintrag ist die Domain im ganzen Internet auflösbar.':
    'Already resolves ({addresses}), but not via {zone}. With the record, the domain resolves on the whole internet.',
  'Löst schon auf ({addresses}), aber nicht über {zone}, etwa über den DNS-Server Ihres Netzes. Eingeschaltet wird sie im ganzen Internet auflösbar.':
    'Already resolves ({addresses}), but not via {zone}, for example via your network’s DNS server. Switched on, it resolves on the whole internet.',
  'Gilt schon für alle Ziele: „timeout tunnel {value}“ im defaults-Block.':
    'Already applies to all targets: “timeout tunnel {value}” in the defaults block.',
  'Gilt schon für alle Ziele. Die eigene Zeile ist überflüssig.':
    'Already applies to all targets. This target’s own line is redundant.',
  'Backend-Server legen Sie auf der Seite Ziele an.': 'Add backend servers on the Targets page.',
  '{host}, Port frei': '{host}, any port',
  'Der Server {name} ist hinterlegt.': 'The server {name} has been added.',
  'Der Server {name} ist geändert.': 'The server {name} has been changed.',
  'Server {name} entfernen?': 'Remove server {name}?',
  'Ziele, die diese Adresse benutzen, bleiben unverändert. Der Server steht danach nur nicht mehr zur Auswahl.':
    'Targets that use this address stay as they are. The server is just no longer offered.',
  'Der Server {name} ist entfernt.': 'The server {name} is removed.',
  'Name, z. B. NAS': 'Name, e.g. NAS',
  'IP-Adresse oder Hostname': 'IP address or host name',
  'Port (frei)': 'Port (optional)',
  'Backend-Server': 'Backend servers',
  'Ein Server, auf dem mehrere Dienste laufen, wird hier einmal mit Namen hinterlegt. Im Dialog eines Ziels wählen Sie ihn dann neben dem Adressfeld aus, statt IP und Port zu tippen. Ohne Port bleibt der Port im Dialog frei. In der HAProxy-Konfiguration steht weiter die Adresse selbst, eine Änderung hier ändert also kein bestehendes Ziel.':
    'A server that runs several services is stored here once with a name. In a target dialog you then pick it next to the address field instead of typing IP and port. Without a port, the port stays open in the dialog. The HAProxy configuration still contains the address itself, so a change here does not change any existing target.',
  'Einmal hinterlegt, in jedem Ziel auswählbar': 'Stored once, available in every target',
  'Die Backend-Server konnten nicht geladen werden.': 'The backend servers could not be loaded.',
  'Noch keine Backend-Server hinterlegt.': 'No backend servers yet.',
  'Ein Ziel namens „{name}" gibt es schon.': 'A target named “{name}” already exists.',
  'Bitte einen Namen angeben.': 'Please enter a name.',
  'Der Name ist zu lang.': 'The name is too long.',
  'Bitte eine IP-Adresse oder einen Hostnamen angeben.': 'Please enter an IP address or a host name.',
  'Erlaubt sind für den Host a-z, 0-9, Bindestrich und Punkt.': 'The host may contain a-z, 0-9, hyphen and dot.',
  'Der Port liegt zwischen 1 und 65535.': 'The port must be between 1 and 65535.',
  'Eine Wildcard deckt genau eine Ebene ab: {one} ja, {two} nein, {apex} selbst auch nicht: die gehört als eigene Zeile dazu.':
    'A wildcard covers exactly one level: {one} yes, {two} no, and not {apex} itself: add it as a separate row.',
  'Die Domains werden nicht bedient, sondern woanders hingeschickt.': 'The domains are not served but sent elsewhere.',
  'Die Anfragen werden auf mehrere Ziele verteilt.': 'Requests are distributed across several targets.',
  'Wohin alles geht, was auf keine Pfad-Regel passt.': 'Where everything goes that matches no path rule.',
  'Zieladresse': 'Target address',
  'Ein Zertifikat wird trotzdem ausgestellt: die Weiterleitung antwortet über HTTPS, und der Browser prüft das Zertifikat, bevor er die Antwort liest.':
    'A certificate is still issued: the redirect answers over HTTPS, and the browser checks the certificate before it reads the response.',
  'Mit Schema.': 'Including the scheme.',
  'Pfad übernehmen': 'Keep path',
  'Aus, und der Aufruf landet immer auf der Zieladresse selbst.': 'When off, every request lands on the target address itself.',
  '{from} geht auf {to}. Für eine Domain, die umgezogen ist.': '{from} goes to {to}. For a domain that has moved.',
  '{from} geht auf {to}. Für eine Domain, die nur auf eine andere zeigen soll.':
    '{from} goes to {to}. For a domain that should only point to another one.',
  'Dauerhaft (301)': 'Permanent (301)',
  'Aus heißt 302: vorübergehend, und jederzeit zurücknehmbar.': 'Off means 302: temporary, and can be reverted at any time.',
  'Ein Browser merkt sich eine 301 und ruft die alte Adresse nicht mehr auf. Wer sie später ändert, erreicht damit niemanden mehr, der schon einmal hier war, bis dessen Cache abläuft.':
    'A browser remembers a 301 and no longer requests the old address. If you change it later, you will not reach anyone who has been here before until their cache expires.',
  'Adresse und Port, wie HAProxy sie erreicht, meist im privaten Netz.':
    'Address and port as HAProxy reaches them, usually in the private network.',
  'Zweites Ziel: auf Lastverteilung umstellen': 'Second target: switch to load balancer',
  'Öffnet dasselbe Ziel im Lastverteilungs-Formular, mit Verfahren, Gewichtung und Sitzungsbindung.':
    'Opens the same target in the load balancer form, with algorithm, weights and session persistence.',
  'Das Gewicht ist der Anteil eines Ziels im Verhältnis zu den anderen: 2 gegen 1 heißt doppelt so viele Anfragen. Leer heißt, dass keine {weight}-Angabe geschrieben wird und HAProxys Vorgabe gilt (alle gleich). {zero} nimmt ein Ziel aus der Verteilung, ohne seine gebundenen Sitzungen abzuwerfen: der Weg, einen Server in Ruhe herauszunehmen.':
    'The weight is the share of a target relative to the others: 2 to 1 means twice as many requests. Empty means no {weight} setting is written and the HAProxy default applies (all equal). {zero} takes a target out of the rotation without dropping its persistent sessions: the way to take a server out calmly.',
  'Es wird keine balance-Zeile geschrieben. Dann gilt, was im defaults-Block der Konfiguration steht, üblicherweise Round Robin. Was dort wirklich steht, weiß dieses Formular nicht, deshalb wird nichts hingeschrieben.':
    'No balance line is written. Then whatever is in the defaults block of the configuration applies, usually round robin. This form does not know what is really there, so nothing is written.',
  'HAProxy setzt einen eigenen Cookie und nimmt ihn aus der Anfrage, bevor sie beim Ziel ankommt. Nötig für Anwendungen, die Sitzungen im Arbeitsspeicher halten. Teilen die Ziele ihre Sitzungen (gemeinsame Datenbank, Redis), braucht es sie nicht. In der Konfiguration: „{line}“ im Backend und „cookie <Servername>“ an jeder server-Zeile.':
    'HAProxy sets its own cookie and removes it from the request before it reaches the target. Needed for applications that keep sessions in memory. If the targets share their sessions (shared database, Redis), it is not needed. In the configuration: “{line}” in the backend and “cookie <server name>” on every server line.',
  'Ein Besucher bleibt bei dem Ziel, auf dem er gelandet ist.': 'A visitor stays on the target they landed on.',
  'Jede Anfrage kann bei einem anderen Ziel landen.': 'Each request may land on a different target.',
  'HAProxy prüft die Ziele und nimmt ein totes aus dem Betrieb.': 'HAProxy checks the targets and takes a dead one out of service.',
  'Aus, weil die Hauptdomain eine Wildcard ist: der Check schickt sie als Host-Header, und {domain} ist kein Hostname. Das Ziel antwortete mit 404, und HAProxy nähme es aus dem Betrieb. Mit einer echten Domain an erster Stelle geht der Schalter wieder.':
    'Off because the primary domain is a wildcard: the check sends it as the Host header, and {domain} is not a host name. The target would answer with 404, and HAProxy would take it out of service. With a real domain in first place, the switch works again.',
  'GET auf {path}, erwartet wird 200-399, Host-Header {host}. Antwortet ein Ziel anders, nimmt HAProxy es aus dem Betrieb.':
    'GET on {path}, expecting 200-399, Host header {host}. If a target answers differently, HAProxy takes it out of service.',
  'Zugriff': 'Access',
  'Jede Adresse kommt durch.': 'Every address gets through.',
  'Nur die Admin-IPs kommen durch, alle anderen bekommen 403.': 'Only the admin IPs get through, everyone else gets 403.',
  'Besucher sehen eine Passwortabfrage.': 'Visitors see a password prompt.',
  'Es sind keine Admin-IPs hinterlegt. Ohne Adressen kommt niemand hinein.': 'No admin IPs are configured. Without addresses nobody gets in.',
  'Für „Nur Admin-IPs“ sind keine Adressen hinterlegt.': 'No addresses are configured for “Admin IPs only”.',
  'Die Passwortsperre braucht HAProxy 2.4 oder neuer. Hier läuft {version}.':
    'The password lock needs HAProxy 2.4 or newer. This server runs {version}.',
  'Eine Adresse ist hinterlegt': 'One address is configured',
  '{count} Adressen sind hinterlegt': '{count} addresses are configured',
  'Die Liste gilt für alle Ziele.': 'The list applies to all targets.',
  'Leer lassen: das bisherige bleibt': 'Leave empty to keep the current one',
  'Vorschlag erzeugen': 'Generate suggestion',
  'Ein neues Passwort meldet alle ab, die schon durchgelassen sind.': 'A new password signs out everyone who was already let through.',
  'Mindestens {min} Zeichen. Jetzt notieren: gespeichert wird nur ein Hash.':
    'At least {min} characters. Write it down now: only a hash is stored.',
  'Für welche Domains': 'For which domains',
  'Alle Domains': 'All domains',
  'Nur einzelne': 'Selected only',
  '{domain} sperren': 'Lock {domain}',
  'Eine Weiterleitung hat kein Backend, also weder Pfad-Regeln noch Header.':
    'A redirect has no backend, so neither path rules nor headers.',
  'Pfad-Regeln': 'Path rules',
  'Alles geht an das Standard-Backend. Das ist der Normalfall.': 'Everything goes to the default backend. This is the usual case.',
  'Einzelne Pfade auf einen anderen Port desselben Ziels.': 'Single paths to another port of the same target.',
  'Keine Pfad-Regeln': 'No path rules',
  'Nötig, wenn ein Pfad auf einen anderen Port desselben Ziels gehört.':
    'Needed when a path belongs on another port of the same target.',
  'Backend und ACL: {name}': 'Backend and ACL: {name}',
  'Nur a-z, 0-9 und _. Er wird Teil des Backend-Namens.': 'Only a-z, 0-9 and _. It becomes part of the backend name.',
  'Regel entfernen': 'Remove rule',
  'Pfade': 'Paths',
  'Pfad hinzufügen': 'Add path',
  'Ziele dieser Regel': 'Targets of this rule',
  'Nur `check` auf der server-Zeile, kein HTTP-Check.': 'Only `check` on the server line, no HTTP check.',
  'Pfad-Regel hinzufügen': 'Add path rule',
  'Verglichen wird der Anfang des Pfads: /app trifft auch /app/socket.':
    'The start of the path is compared: /app also matches /app/socket.',
  'Header und Verbindung': 'Headers and connection',
  'Nichts gesetzt. Das ist der Normalfall.': 'Nothing set. This is the usual case.',
  'Feste Header und lange Verbindungen für dieses Ziel.': 'Fixed headers and long connections for this target.',
  'Header der {direction}': '{direction} headers',
  'Gehen mit jeder Antwort dieses Ziels an den Besucher. Der Wert kommt wörtlich an: Ausdrücke wie %[src] werden nicht ausgewertet.':
    'Sent to the visitor with every response of this target. The value arrives literally: expressions like %[src] are not evaluated.',
  'Gehen mit jeder Anfrage an das Ziel. Der Wert kommt wörtlich an: Ausdrücke wie %[src] werden nicht ausgewertet.':
    'Sent to the target with every request. The value arrives literally: expressions like %[src] are not evaluated.',
  'Name von Header {number}': 'Name of header {number}',
  'Wert von Header {number}': 'Value of header {number}',
  'Header hinzufügen': 'Add header',
  'Für WebSocket, Terminal und Live-Ansicht. Ohne den Schalter beendet HAProxy eine offene Verbindung nach der Zeit aus dem defaults-Block, üblicherweise nach einer Minute ohne Daten. In der Konfiguration: „{line}“ in jedem Backend des Eintrags, auch in denen der Pfad-Regeln.':
    'For WebSocket, terminal and live view. Without the switch, HAProxy closes an open connection after the time from the defaults block, usually after one minute without data. In the configuration: “{line}” in every backend of the entry, including those of the path rules.',
  'Eine offene Verbindung bleibt bis zu einer Stunde bestehen.': 'An open connection stays up for up to one hour.',
  'Es gilt die Zeit aus der Grundkonfiguration.': 'The time from the base configuration applies.',

  // Länder-Tabelle (`GeoipPanel.tsx`)
  'Von db-ip.com geholt': 'Fetched from db-ip.com',
  'Von Hand hochgeladen': 'Uploaded manually',
  'Mit HAPM mitgeliefert': 'Bundled with HAPM',
  'Wird jeden Monat selbsttätig erneuert.': 'Renewed automatically every month.',
  'Das selbsttätige Erneuern ist abgeschaltet.': 'Automatic renewal is turned off.',
  'Keine Tabelle vorhanden. {renewal}': 'No table available. {renewal}',
  'Stand {version}. {renewal}': 'Version {version}. {renewal}',
  '{v4} IPv4 · {v6} IPv6': '{v4} IPv4 · {v6} IPv6',
  'Länder-Tabelle auf Stand {version}': 'Country table at version {version}',
  '{v4} IPv4- und {v6} IPv6-Bereiche von db-ip.com geholt.': 'Fetched {v4} IPv4 and {v6} IPv6 ranges from db-ip.com.',
  'Von db-ip.com geholt.': 'Fetched from db-ip.com.',
  'Länder-Tabelle ist aktuell': 'Country table is up to date',
  'Stand {version}. Eine neuere Datei gibt es bei DB-IP noch nicht.': 'Version {version}. DB-IP does not have a newer file yet.',
  'Erneuern fehlgeschlagen': 'Renewal failed',
  'HAPM erneuert die Länder-Tabelle wieder selbst.': 'HAPM renews the country table automatically again.',
  'HAPM lädt die Länder-Tabelle nicht mehr selbst.': 'HAPM no longer downloads the country table automatically.',
  'Umschalten fehlgeschlagen': 'Switching failed',
  '„{file}“ nennt keinen Stand. Erwartet wird der Monat im Dateinamen, so wie DB-IP ihn ausliefert: dbip-country-lite-2026-08.csv.gz':
    '“{file}” does not state a version. The month is expected in the file name, the way DB-IP delivers it: dbip-country-lite-2026-08.csv.gz',
  '{v4} IPv4- und {v6} IPv6-Bereiche übernommen.': 'Imported {v4} IPv4 and {v6} IPv6 ranges.',
  'Die Datei konnte nicht gelesen werden.': 'The file could not be read.',
  'Auf die mitgelieferte Tabelle zurück?': 'Go back to the bundled table?',
  'Danach gilt die mitgelieferte Fassung. Sie ist in der Regel älter. Beim nächsten selbsttätigen Abruf holt HAPM wieder die aktuelle.':
    'The bundled version then applies. It is usually older. On the next automatic download, HAPM fetches the current one again.',
  'Danach gilt wieder die mitgelieferte Fassung. Sie ist in der Regel älter, die Länder in der Statistik werden dadurch ungenauer. Sonst ändert sich nichts.':
    'The bundled version then applies again. It is usually older, so the countries in the statistics become less accurate. Nothing else changes.',
  'Es gilt wieder die mitgelieferte Tabelle.': 'The bundled table applies again.',
  'Länder-Tabelle': 'Country table',
  'Aus ihr macht die Statistik aus einer Adresse ein Land. Nachgeschlagen wird in HAPM selbst: keine Besucheradresse geht an einen fremden Dienst.':
    'The statistics use it to turn an address into a country. The lookup happens in HAPM itself: no visitor address is sent to a third-party service.',
  'Jetzt erneuern': 'Renew now',
  'Der Zustand der Länder-Tabelle konnte nicht geladen werden.': 'The state of the country table could not be loaded.',
  'Der letzte Abruf am {time} ist gescheitert.': 'The last download on {time} failed.',
  'Der letzte Abruf ist gescheitert.': 'The last download failed.',
  'HAPM versucht es einmal am Tag wieder.': 'HAPM tries again once a day.',
  'Die Tabelle ist veraltet.': 'The table is outdated.',
  'Adressbereiche werden laufend neu vergeben, die Länder in der Statistik stimmen mit der Zeit seltener.':
    'Address ranges are reassigned all the time, so the countries in the statistics become less accurate over time.',
  'Stand': 'Version',
  'Herkunft': 'Source',
  'Alter': 'Age',
  '{count} Tag, veraltet': '{count} day, outdated',
  '{count} Tage, veraltet': '{count} days, outdated',
  'Bereiche': 'Ranges',
  'Letzter Versuch': 'Last attempt',
  'Noch keiner': 'None yet',
  '{time}, gescheitert': '{time}, failed',
  '{time}, ohne Fehler': '{time}, no errors',
  'Geholt': 'Fetched',
  'Hochgeladen': 'Uploaded',
  '{time} von {user}': '{time} by {user}',
  '{time}, selbsttätig': '{time}, automatically',
  'Selbsttätig erneuern': 'Renew automatically',
  'Solange die Tabelle nicht vom laufenden Monat ist, fragt HAPM einmal am Tag bei db-ip.com nach der neuen Datei. DB-IP stellt sie am Monatsanfang ein. Besucheradressen verlassen den Server dabei nicht. Abgeschaltet bleibt die Tabelle auf ihrem Stand, bis sie von Hand erneuert wird.':
    'As long as the table is not from the current month, HAPM asks db-ip.com for the new file once a day. DB-IP publishes it at the start of the month. Visitor addresses do not leave the server. When turned off, the table stays at its version until it is renewed manually.',
  'HAPM lädt einmal im Monat eine Datei von db-ip.com.':
    'HAPM downloads a file from db-ip.com once a month.',
  'Von Hand hochladen': 'Upload manually',
  'Der Datensatz „IP to Country Lite“ von DB-IP, monatlich und kostenlos. Die Datei wird genommen, wie sie kommt: gepackt (.csv.gz) oder ausgepackt. Der Monat muss im Dateinamen stehen, nur dort ist der Stand des Datensatzes vermerkt.':
    'The “IP to Country Lite” dataset from DB-IP, monthly and free. The file is taken as it comes: compressed (.csv.gz) or uncompressed. The month must be in the file name, it is the only place where the version of the dataset is recorded.',
  'Für Server ohne Zugang nach außen.': 'For servers without outbound access.',
  'Datei wählen': 'Choose file',
  'Datensatz bei DB-IP': 'Dataset at DB-IP',
  'Auf mitgelieferte zurück': 'Back to bundled table',
  'Länderdaten: {link}, Lizenz CC BY 4.0.': 'Country data: {link}, license CC BY 4.0.',
  // Zertifikate: hochladen, eigener ACME-Server, eigener DNS-Server
  "Diese Installation stellt keine Zertifikate selbst aus. Laden Sie zuerst unter Reverse-Proxy, Zertifikate eins hoch, das die Domains abdeckt.": "This installation does not issue certificates itself. First upload one under Reverse proxy, Certificates that covers the domains.",
  "Diese Installation stellt keine Zertifikate selbst aus, und für diese Domains liegt keins vor. Laden Sie es zuerst unter {page} hoch.": "This installation does not issue certificates itself, and there is none for these domains. Upload it first under {page}.",
  "Ein Zertifikat für diese Domains liegt vor. Es wird keins beantragt.": "A certificate for these domains exists. None will be requested.",
  // HTTPS zum Ziel (BackendTlsPick, ServiceCard)
  'HTTP': 'HTTP',
  'HTTPS': 'HTTPS',
  'HTTPS, Zertifikat prüfen': 'HTTPS, verify certificate',
  'HAProxy spricht unverschlüsselt mit dem Ziel.': 'HAProxy talks to the target unencrypted.',
  'Verschlüsselt. Das Zertifikat des Ziels wird nicht geprüft.': 'Encrypted. The target certificate is not verified.',
  'Verschlüsselt. Das Zertifikat muss von einer bekannten CA stammen.': 'Encrypted. The certificate must come from a known CA.',
  'Für Ziele, die selbst verschlüsseln, etwa Proxmox auf 8006 oder TrueNAS. Ohne Prüfung passt das für selbst signierte Zertifikate. Mit Prüfung muss das Zertifikat von einer CA stammen, der das System vertraut, und für die aufgerufene Domain gelten. HAProxy schickt die Domain der Anfrage als SNI. In der Konfiguration: „{insecure}“ oder „{verify}“ an jeder server-Zeile.':
    'For targets that encrypt themselves, such as Proxmox on 8006 or TrueNAS. Without verification this works for self-signed certificates. With verification the certificate must come from a CA the system trusts and be valid for the requested domain. HAProxy sends the domain of the request as SNI. In the configuration: "{insecure}" or "{verify}" on every server line.',
  'Die Prüfung braucht HAProxy 2.6 oder neuer. Hier läuft {version}.':
    'Verification needs HAProxy 2.6 or newer. This one runs {version}.',
  'Auf Port {port} spricht ein Ziel meist HTTPS.': 'A target on port {port} usually speaks HTTPS.',
  'HAProxy spricht HTTPS mit dem Ziel, ohne das Zertifikat zu prüfen':
    'HAProxy talks HTTPS to the target without verifying the certificate',
  'HAProxy spricht HTTPS mit dem Ziel und prüft das Zertifikat': 'HAProxy talks HTTPS to the target and verifies the certificate',
  'Ziel spricht': 'Target speaks',
  'Ziele sprechen': 'Targets speak',
  'Ziele dieser Regel sprechen': 'Targets of this rule speak',
  'Gilt für {domains}. Ziele mit eigenem Zertifikat behalten es.':
    'Applies to {domains}. Targets with their own certificate keep it.',
  'DNS-Hook': 'DNS hook',
  'Beantragen': 'Request',
  'Einzelne Adresse oder CIDR-Bereich, IPv4 und IPv6. Leer heißt: von überall.': 'A single address or CIDR range, IPv4 and IPv6. Empty means: from anywhere.',
  'Für ein Skript auf einem festen Server ist eine Zeile hier der Unterschied zwischen „gestohlen und nutzbar“ und „gestohlen und wertlos“.': 'For a script on a fixed server, one line here is the difference between “stolen and usable” and “stolen and worthless”.',
  'Pfad-Regeln, Header, Healthcheck und Verteilverfahren gehören zu einem Eintrag mit Zielen. Wer sie braucht, legt einen Reverse-Proxy oder eine Lastverteilung an.': 'Path rules, headers, healthcheck and balancing algorithm belong to an entry with targets. If you need them, create a reverse proxy or a load balancer.',
  'Nicht gespeicherte Eingaben gehen dabei verloren.': 'Unsaved input is lost.',
  'Eine WebSocket-Strecke antwortet auf ein GET auf / nicht mit 200. Deshalb hier kein HTTP-Check, sonst nähme HAProxy sie dauerhaft aus dem Betrieb.': 'A WebSocket endpoint does not answer a GET on / with 200. That is why there is no HTTP check here, otherwise HAProxy would take it out of service for good.',
  'Kein HTTP, kein Zertifikat: was durchgeht, sieht HAProxy nicht an.': 'No HTTP, no certificate: HAProxy does not look at what passes through.',
  'Eine eigene Liste je Eintrag und nicht die Admin-IPs. Wer an eine Datenbank darf, ist eine andere Frage als wer eine Verwaltungsoberfläche sehen darf.': 'A separate list per entry, not the admin IPs. Who may access a database is a different question from who may see an admin interface.',
  'Vorschläge aus Ihren DNS-Zonen': 'Suggestions from your DNS zones',
  'Eine Domain auf ein Ziel, mit Zertifikat.': 'One domain to one target, with a certificate.',
  'Eine Domain auf mehrere Ziele verteilt.': 'One domain spread across several targets.',
  'Eine Domain antwortet mit einer Weiterleitung.': 'A domain answers with a redirect.',
  'Weiter zu den Domains': 'Continue to domains',
  'Weiter zum Ziel': 'Continue to target',
  'Weiter zu Zugriff und Schutz': 'Continue to access and protection',
  'Weiter zu Erweitert': 'Continue to advanced',
  'Weiter zum Port': 'Continue to port',
  'Weiter zum Zugriff': 'Continue to access',
  'Löst noch nicht auf.': 'Does not resolve yet.',
  'Weitere Domain': 'Additional domain',
  'Worauf jede Domain zeigt, und ob HAPM den Eintrag setzt.': 'Where each domain points, and whether HAPM sets the record.',
  'Der Eintrag steht schon in {zone}.': 'The record already exists in {zone}.',
  'Dort steht ein {type}-Eintrag, er bleibt.': 'There is a {type} record there, it stays.',
  'Die Zone {zone} ist nicht lesbar.': 'The zone {zone} cannot be read.',
  'Hier ist kein Eintrag möglich.': 'No record is possible here.',
  'Wird als CNAME in {zone} angelegt.': 'Will be created as a CNAME in {zone}.',
  'Es wird kein Eintrag angelegt.': 'No record will be created.',
  'Ein Port dieses Servers an ein Ziel dahinter.': 'A port of this server to a target behind it.',
};
