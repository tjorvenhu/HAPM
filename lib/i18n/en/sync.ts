/** Abgleich zwischen Knoten (Hochverfügbarkeit): Seite, Läufe, Meldungen, Mail. */
export const sync: Readonly<Record<string, string>> = {
  // Rollen und Auslöser
  Einzeln: 'Standalone',
  Hauptknoten: 'Primary node',
  Folgeknoten: 'Replica',
  'Nach einer Änderung': 'After a change',
  'Regelmäßige Prüfung': 'Periodic check',
  'Vom Hauptknoten': 'From the primary node',

  // Seite: Kopf und Reiter
  Abgleich: 'Sync',
  Rolle: 'Role',
  'Konfiguration, Zertifikate, Konten und Einstellungen für weitere Knoten.': 'Configuration, certificates, accounts and settings for further nodes.',
  'Für Hochverfügbarkeit laufen zwei oder mehr vollständige Installationen. Der Hauptknoten überträgt nach jeder Änderung, was HAProxy zum Ausliefern braucht. Welcher Knoten die gemeinsame Adresse hält, regelt keepalived oder ein Load Balancer davor.':
    'For high availability, two or more complete installations run side by side. After every change the primary node transfers what HAProxy needs to serve traffic. Which node holds the shared address is decided by keepalived or a load balancer in front.',
  'Jetzt abgleichen': 'Sync now',
  'Erst einen Folgeknoten eintragen.': 'Add a replica first.',
  'Der Stand des Abgleichs konnte nicht geladen werden.': 'The sync status could not be loaded.',
  'Der Abgleich ließ sich nicht starten.': 'The sync could not be started.',
  'Abgleich fehlgeschlagen': 'Sync failed',
  'Abgleich läuft': 'Sync running',
  'Abgleich abgeschlossen': 'Sync finished',
  'Der Stand von {name} ist übernommen.': 'The state of {name} has been applied.',
  'Übernommen von: {names}': 'Applied by: {names}',

  // Hinweis auf einem Folgeknoten
  'Dieser Knoten ist ein Folgeknoten': 'This node is a replica',
  'Ziele, Zertifikate und Einstellungen des Proxys kommen vom Hauptknoten und werden dort geändert.':
    'Targets, certificates and proxy settings come from the primary node and are changed there.',
  'Dieser Knoten ist ein Folgeknoten. Ziele, Zertifikate, Fehlerseiten und Einstellungen des Proxys kommen vom Hauptknoten und werden dort geändert.':
    'This node is a replica. Targets, certificates, error pages and proxy settings come from the primary node and are changed there.',
  'Dieser Knoten ist ein Folgeknoten. Freigaben kommen vom Hauptknoten und werden dort geändert.':
    'This node is a replica. The allowlist comes from the primary node and is changed there.',
  'Dieser Knoten ist ein Folgeknoten. Konten, Passwörter, Passkeys und zweite Faktoren kommen vom Hauptknoten und werden dort geändert.':
    'This node is a replica. Accounts, passwords, passkeys and second factors come from the primary node and are changed there.',
  'Dieser Knoten ist ein Folgeknoten. Diese Einstellungen kommen vom Hauptknoten und werden dort geändert.':
    'This node is a replica. These settings come from the primary node and are changed there.',
  'Dieser Knoten ist ein Folgeknoten. DNS-Zonen kommen vom Hauptknoten und werden dort geändert.':
    'This node is a replica. DNS zones come from the primary node and are changed there.',
  'Dieser Knoten ist ein Folgeknoten. API-Keys kommen vom Hauptknoten und werden dort geändert.':
    'This node is a replica. API keys come from the primary node and are changed there.',
  'Dieser Knoten ist ein Folgeknoten. Sperren von Hand und Regeln von CrowdSec kommen vom Hauptknoten und werden dort geändert.':
    'This node is a replica. Manual bans and CrowdSec rules come from the primary node and are changed there.',
  'Sperren von Hand, Freigaben und Regeln kommen vom Hauptknoten. Was CrowdSec hier selbst sperrt, lässt sich hier aufheben.':
    'Manual bans, the allowlist and rules come from the primary node. What CrowdSec bans by itself here can be lifted here.',
  'API-Keys kommen vom Hauptknoten und werden dort angelegt und zurückgezogen.': 'API keys come from the primary node and are created and revoked there.',
  'DNS-Zonen und ihre Zugänge kommen vom Hauptknoten und werden dort geändert.': 'DNS zones and their credentials come from the primary node and are changed there.',
  'Konten kommen vom Hauptknoten und werden dort angelegt und entfernt.': 'Accounts come from the primary node and are created and removed there.',
  'Passwort, zweiter Faktor und Passkeys kommen vom Hauptknoten und werden dort geändert.':
    'Password, second factor and passkeys come from the primary node and are changed there.',
  'Diese Einstellungen kommen vom Hauptknoten und werden dort geändert.': 'These settings come from the primary node and are changed there.',
  'SMTP-Konto, Empfänger und Ereignisse kommen vom Hauptknoten und werden dort geändert.':
    'SMTP account, recipients and events come from the primary node and are changed there.',

  // Abgelehnter Abgleich
  'Der Knoten {name} wollte am {when} hierher abgleichen und wurde abgelehnt: dieser Knoten ist an einen anderen Hauptknoten gebunden. Ein neuer Kopplungsschlüssel löst die Bindung.':
    'The node {name} tried to sync to this node on {when} and was refused: this node is bound to another primary node. A new pairing key removes the binding.',
  'Der Knoten {name} hält sich für den Hauptknoten und wollte am {when} hierher abgleichen. Es wurde nichts übernommen. Einer der beiden Knoten muss Folgeknoten werden.':
    'The node {name} considers itself the primary node and tried to sync to this node on {when}. Nothing was applied. One of the two nodes has to become a replica.',

  // Reiter Zustand
  'Dieser Knoten': 'This node',
  'Dieser Knoten arbeitet einzeln': 'This node works standalone',
  'Für Hochverfügbarkeit bekommt ein Knoten die Rolle Hauptknoten und ein zweiter die Rolle Folgeknoten.':
    'For high availability one node gets the role primary node and a second one the role replica.',
  'Rolle festlegen': 'Set role',
  'Folgeknoten hinzufügen': 'Add replica',
  'Noch kein Folgeknoten': 'No replica yet',
  'Auf dem zweiten Knoten die Rolle Folgeknoten wählen, dort einen Kopplungsschlüssel erzeugen und ihn hier eintragen.':
    'Choose the role replica on the second node, create a pairing key there and enter it here.',
  Knoten: 'Node',
  'Letzter Abgleich': 'Last sync',
  Fassungen: 'Versions',
  'Geprüft: {when}': 'Checked: {when}',
  'Stand gleich': 'In sync',
  'Weicht ab': 'Differs',
  'Folgeknoten „{name}“ entfernen': 'Remove replica “{name}”',
  'Folgeknoten „{name}“ entfernen?': 'Remove replica “{name}”?',
  'Er behält seinen letzten Stand, es kommt nur keiner mehr nach. Seine Rolle ändert sich dadurch nicht.':
    'It keeps its last state, it just receives no further ones. Its role does not change.',
  'Der Folgeknoten ließ sich nicht entfernen.': 'The replica could not be removed.',
  'Der Folgeknoten ist entfernt.': 'The replica has been removed.',
  'HAPM: hier {here}, dort {there}.': 'HAPM: {here} here, {there} there.',
  'HAProxy: hier {here}, dort {there}.': 'HAProxy: {here} here, {there} there.',
  'CrowdSec ist dort nicht eingeschaltet. Die Ziele laufen dort ohne WAF.':
    'CrowdSec is not switched on there. The targets run without a WAF there.',
  '{count} Verweis oder Sonderdatei wird nicht übertragen.': '{count} symlink or special file is not transferred.',
  '{count} Verweise oder Sonderdateien werden nicht übertragen.': '{count} symlinks or special files are not transferred.',

  // Zustand eines Folgeknotens
  'Stand vom Hauptknoten': 'State from the primary node',
  'Es gibt noch keinen Kopplungsschlüssel. Ohne ihn kann kein Hauptknoten hierher abgleichen.':
    'There is no pairing key yet. Without it no primary node can sync to this node.',
  'Es ist noch kein Stand angekommen. Tragen Sie auf dem Hauptknoten unter „Abgleich“ die Adresse dieses Knotens und den Kopplungsschlüssel ein.':
    'No state has arrived yet. On the primary node, enter the address of this node and the pairing key under “Sync”.',
  Dateien: 'Files',
  'Unverändert seit dem Abgleich': 'Unchanged since the sync',
  'Hier geändert seit dem Abgleich': 'Changed here since the sync',
  'Konten und Einstellungen': 'Accounts and settings',
  'Auf diesem Knoten wurden Konten, Einstellungen, DNS-Zonen oder API-Keys geändert. Der Hauptknoten bemerkt das bei seiner nächsten Prüfung und überträgt seinen Stand erneut.':
    'Accounts, settings, DNS zones or API keys were changed on this node. The primary node notices this at its next check and transfers its state again.',
  'Auf diesem Knoten wurden Dateien des Proxys geändert. Der Hauptknoten bemerkt das bei seiner nächsten Prüfung und überträgt seinen Stand erneut.':
    'Proxy files were changed on this node. The primary node notices this at its next check and transfers its state again.',
  'CrowdSec ist auf diesem Knoten nicht eingeschaltet und wurde aus der Konfiguration genommen. Die Ziele laufen hier ohne WAF.':
    'CrowdSec is not switched on on this node and was taken out of the configuration. The targets run without a WAF here.',
  'CrowdSec ist auf diesem Knoten nicht eingeschaltet, ließ sich aber nicht aus der Konfiguration nehmen. HAProxy wartet hier bei jeder Anfrage auf den Bouncer.':
    'CrowdSec is not switched on on this node but could not be taken out of the configuration. HAProxy waits for the bouncer on every request here.',
  'CrowdSec wurde auf diesem Knoten umgestellt. Der Hauptknoten überträgt seinen Stand bei der nächsten Prüfung erneut.':
    'CrowdSec was switched on this node. The primary node transfers its state again at the next check.',
  Kopplungsschlüssel: 'Pairing key',
  'Mit ihm ist jede Übertragung verschlüsselt, auch über http. Er wird hier erzeugt, einmal gezeigt und auf dem Hauptknoten eingetragen.':
    'Every transfer is encrypted with it, even over http. It is created here, shown once and entered on the primary node.',
  'Schlüssel erzeugen': 'Create key',
  'Neuen Schlüssel erzeugen': 'Create new key',
  'Neuen Kopplungsschlüssel erzeugen?': 'Create a new pairing key?',
  'Der bisherige Schlüssel gilt danach nicht mehr, und die Bindung an den bisherigen Hauptknoten ist gelöst. Bis ein Hauptknoten den neuen Schlüssel eingetragen hat, kommt hier kein Stand mehr an.':
    'The previous key is no longer valid afterwards, and the binding to the previous primary node is removed. Until a primary node has entered the new key, no state arrives here.',
  'Der Kopplungsschlüssel ließ sich nicht erzeugen.': 'The pairing key could not be created.',
  'Jetzt kopieren und auf dem Hauptknoten unter „Abgleich“ eintragen. Nach dem Schließen zeigt HAPM ihn nicht wieder, es bleibt nur, einen neuen zu erzeugen.':
    'Copy it now and enter it on the primary node under “Sync”. After closing, HAPM does not show it again, the only way left is to create a new one.',

  // Reiter Rolle
  'Rolle dieses Knotens': 'Role of this node',
  'Sie bestimmt, ob hier geändert oder nur übernommen wird.': 'It decides whether changes are made here or only applied.',
  'Kein Abgleich. HAPM verwaltet nur diesen Knoten.': 'No sync. HAPM manages only this node.',
  'Hier wird geändert. Der Stand geht an die Folgeknoten.': 'Changes are made here. The state goes to the replicas.',
  'Übernimmt den Stand des Hauptknotens. Hier wird nichts geändert.': 'Applies the state of the primary node. Nothing is changed here.',
  'Welcher Knoten die gemeinsame Adresse hält, entscheidet nicht HAPM, sondern keepalived oder ein Load Balancer davor.':
    'Which node holds the shared address is not decided by HAPM but by keepalived or a load balancer in front.',
  'Was übertragen wird': 'What is transferred',
  '{path}: Konfiguration, Zertifikate, Fehlerseiten, Sperrlisten.': '{path}: configuration, certificates, error pages, block lists.',
  'Konto, Zertifikate und Erneuerungseinträge. Erneuert wird nur auf dem Hauptknoten.':
    'Account, certificates and renewal entries. Renewal happens only on the primary node.',
  'Nicht übertragen': 'Not transferred',
  'Benutzer, Passwörter, zweite Faktoren und Passkeys. Sitzungen nicht: nach dem ersten Abgleich melden Sie sich auf dem Folgeknoten neu an.':
    'Users, passwords, second factors and passkeys. Not sessions: after the first sync you sign in again on the replica.',
  '„Allgemein“ und „Benachrichtigungen“ samt SMTP-Konto, dazu DNS-Zonen und API-Keys. Selbsttätige Updates stellt jeder Knoten für sich ein.':
    '“General” and “Notifications” including the SMTP account, plus DNS zones and API keys. Automatic updates are set on each node separately.',
  'Sperren von Hand, Freigaben, der Schalter der OWASP-Regeln und zugeschaltete Sammlungen. Was CrowdSec selbst sperrt, sperrt jeder Knoten für sich.':
    'Manual bans, the allowlist, the OWASP rules switch and enabled collections. What CrowdSec bans by itself, each node bans separately.',
  'Statistik, Logs, Protokoll und Historie. Dazu Sicherung, Updates, Darstellung und hinterlegte Backend-Server.':
    'Statistics, logs, audit log and history. Also backup, updates, appearance and saved backend servers.',
  'Zum Folgeknoten machen?': 'Make this node a replica?',
  'Zum Folgeknoten machen': 'Make replica',
  'Der erste Abgleich ersetzt Konfiguration, Zertifikate, Konten, Einstellungen, DNS-Zonen und API-Keys dieses Knotens durch die des Hauptknotens. Sie melden sich danach hier mit einem Konto des Hauptknotens an. Ändern lässt sich das alles nur noch dort, und Zertifikate werden hier nicht mehr erneuert. Legen Sie vorher eine Sicherung an.':
    'The first sync replaces the configuration, certificates, accounts, settings, DNS zones and API keys of this node with those of the primary node. Afterwards you sign in here with an account of the primary node. All of this can only be changed there from then on, and certificates are no longer renewed here. Create a backup first.',
  'Zum Hauptknoten machen?': 'Make this node the primary node?',
  'Zum Hauptknoten machen': 'Make primary node',
  'Ab dann wird hier geändert und erneuert, und es kommt kein Stand mehr an. Läuft der bisherige Hauptknoten noch oder kommt er zurück, muss er zuerst Folgeknoten werden: zwei Hauptknoten gleichen nicht ab.':
    'From then on, changes and renewals happen here, and no state arrives anymore. If the previous primary node is still running or comes back, it has to become a replica first: two primary nodes do not sync.',
  'Nach jeder Änderung geht der Stand an die eingetragenen Folgeknoten. Solange keiner eingetragen ist, ändert sich nichts.':
    'After every change the state goes to the replicas that have been added. As long as none has been added, nothing changes.',
  'Abgleich abschalten?': 'Switch off sync?',
  'Dieser Knoten nimmt keinen Stand mehr an und lässt sich wieder selbst ändern. Zertifikate werden wieder hier erneuert.':
    'This node no longer accepts a state and can be changed itself again. Certificates are renewed here again.',
  'Es geht kein Stand mehr an die Folgeknoten. Sie behalten ihren letzten Stand.':
    'No state goes to the replicas anymore. They keep their last state.',
  'Dieser Knoten ist jetzt: {role}.': 'This node is now: {role}.',
  'Umstellen fehlgeschlagen': 'Switching failed',
  'Die Rolle ließ sich nicht umstellen.': 'The role could not be switched.',

  // Folgeknoten hinzufügen
  'Der erste Abgleich ersetzt Konfiguration, Zertifikate, Konten und Einstellungen des Folgeknotens durch die von hier.':
    'The first sync replaces the configuration, certificates, accounts and settings of the replica with those from here.',
  'Adresse des Folgeknotens': 'Address of the replica',
  'Die Adresse seiner Oberfläche, mit Port. Auch ohne HTTPS: jede Übertragung ist mit dem Kopplungsschlüssel verschlüsselt.':
    'The address of its web interface, with port. Works without HTTPS too: every transfer is encrypted with the pairing key.',
  'Wird auf dem Folgeknoten unter „Abgleich“ erzeugt.': 'Created on the replica under “Sync”.',
  'Leer: der Name, den der Knoten selbst nennt.': 'Empty: the name the node gives itself.',
  'Der Folgeknoten ist eingetragen. Der erste Abgleich beginnt gleich.': 'The replica has been added. The first sync starts shortly.',
  'Hinzufügen fehlgeschlagen': 'Adding failed',
  'Der Folgeknoten ließ sich nicht eintragen.': 'The replica could not be added.',

  // Historie
  'Hier steht jeder Abgleich, bei dem ein Stand übertragen wurde oder ein Folgeknoten ausfiel.':
    'Every sync in which a state was transferred or a replica failed is listed here.',
  Richtung: 'Direction',
  Gegenstelle: 'Peer',
  Empfangen: 'Received',
  Gesendet: 'Sent',

  // Schritte eines Laufs
  'Abgleich mit dem Folgeknoten': 'Sync with the replica',
  'Folgeknoten erreicht': 'Replica reached',
  'Stand übertragen': 'State transferred',
  'Abgebrochenen Abgleich zurückgenommen': 'Interrupted sync rolled back',
  'Einstellungen übernommen': 'Settings applied',
  'Einstellungen übernehmen': 'Apply settings',
  'Konten übernommen': 'Accounts applied',
  'Konten übernehmen': 'Apply accounts',
  'DNS-Zonen übernommen': 'DNS zones applied',
  'DNS-Zonen übernehmen': 'Apply DNS zones',
  'API-Keys übernommen': 'API keys applied',
  'API-Keys übernehmen': 'Apply API keys',
  'CrowdSec übernommen': 'CrowdSec applied',
  'CrowdSec übernehmen': 'Apply CrowdSec',
  'CrowdSec ausgelassen': 'CrowdSec skipped',
  'CrowdSec ist auf diesem Knoten nicht eingeschaltet. Sperren, Freigaben und Regeln wurden nicht übernommen.':
    'CrowdSec is not switched on on this node. Bans, the allowlist and rules were not applied.',
  'Abgebrochenen Abgleich zurücknehmen': 'Roll back interrupted sync',
  'Paket lesen': 'Read bundle',
  'Paket geprüft': 'Bundle verified',
  'Konfiguration an diesen Knoten angepasst': 'Configuration adapted to this node',
  'Der Stand liegt schon so vor': 'The state is already in place',
  'Es wurde nichts getauscht, HAProxy läuft weiter wie bisher.': 'Nothing was swapped, HAProxy keeps running as before.',
  'Dateien bereitlegen': 'Stage files',
  'Dateien bereitgelegt': 'Files staged',
  'Dateien getauscht': 'Files swapped',
  'Bisherigen Stand wiederherstellen': 'Restore previous state',
  'Bisheriger Stand wiederhergestellt': 'Previous state restored',
  'HAProxy nennt keinen Grund.': 'HAProxy gives no reason.',
  'HAProxy mit dem bisherigen Stand neu geladen': 'HAProxy reloaded with the previous state',
  'Der Abgleich nennt keinen Grund.': 'The sync gives no reason.',
  'Es gibt keinen Folgeknoten mehr, an den abgeglichen würde.': 'There is no replica left to sync to.',
  'HAPM wurde während des Abgleichs neu gestartet.': 'HAPM was restarted during the sync.',

  // Meldungen der Routen
  'Erwartet wird role: single, primary oder replica.': 'Expected role: single, primary or replica.',
  'Es läuft gerade ein Abgleich. Die Rolle lässt sich danach umstellen.': 'A sync is running. The role can be switched afterwards.',
  'Einen Kopplungsschlüssel erzeugt nur ein Folgeknoten. Bitte zuerst die Rolle umstellen.':
    'Only a replica creates a pairing key. Please switch the role first.',
  'Es läuft gerade ein Abgleich. Ein neuer Schlüssel lässt sich danach erzeugen.': 'A sync is running. A new key can be created afterwards.',
  'Die Adresse beginnt mit http:// oder https://, zum Beispiel http://10.0.0.2:7080.':
    'The address starts with http:// or https://, for example http://10.0.0.2:7080.',
  'Das ist keine gültige Adresse.': 'This is not a valid address.',
  'Die Adresse darf keine Zugangsdaten enthalten.': 'The address must not contain credentials.',
  'Die Adresse besteht nur aus Schema, Name und Port, ohne Pfad dahinter.': 'The address consists only of scheme, name and port, without a path.',
  'Folgeknoten trägt nur ein Hauptknoten ein. Bitte zuerst die Rolle umstellen.': 'Only a primary node adds replicas. Please switch the role first.',
  'Das ist kein Kopplungsschlüssel. Er beginnt mit hapmsync_ und wird auf dem Folgeknoten erzeugt.':
    'This is not a pairing key. It starts with hapmsync_ and is created on the replica.',
  'Unter {url} ist schon ein Folgeknoten eingetragen.': 'A replica has already been added under {url}.',
  'Die Kopplung ist nicht zustande gekommen: {detail}': 'Pairing failed: {detail}',
  '{name} ist schon als Folgeknoten eingetragen.': '{name} has already been added as a replica.',
  'Diesen Folgeknoten gibt es nicht.': 'This replica does not exist.',
  'Diesen Lauf des Abgleichs gibt es nicht.': 'This sync run does not exist.',
  'Abgeglichen wird vom Hauptknoten aus. Dieser Knoten ist keiner.': 'Syncing starts from the primary node. This node is not one.',
  'Es ist noch kein Folgeknoten eingetragen.': 'No replica has been added yet.',
  'Es läuft schon ein Abgleich.': 'A sync is already running.',
  '{file} fehlt auf diesem Knoten. Es gibt nichts abzugleichen.': '{file} is missing on this node. There is nothing to sync.',
  'Der Stand ist gepackt {size} MB groß. Der Abgleich überträgt höchstens {max} MB.':
    'The packed state is {size} MB. The sync transfers at most {max} MB.',

  // Der Endpunkt für andere Knoten
  'Abgleich: Die Anmeldung ist ungültig.': 'Sync: the authentication is invalid.',
  'Abgleich: Der Rumpf ist länger als angekündigt.': 'Sync: the body is longer than announced.',
  'Zu viele Fehlversuche.': 'Too many failed attempts.',
  'Abgleich: Die Uhren der beiden Knoten liegen mehr als fünf Minuten auseinander.':
    'Sync: the clocks of the two nodes are more than five minutes apart.',
  'Abgleich: Das Paket ist größer, als dieser Knoten annimmt.': 'Sync: the bundle is larger than this node accepts.',
  'Abgleich: Diese Anfrage wurde schon einmal gestellt.': 'Sync: this request has been made before.',

  // Benachrichtigung
  'Abgleich gescheitert': 'Sync failed',
  'Ein Folgeknoten antwortet nicht oder übernimmt den Stand nicht.': 'A replica does not answer or does not apply the state.',
  'Abgleich mit {peer} gescheitert': 'Sync with {peer} failed',
  'Der Folgeknoten {peer} hat am {when} den Stand von {node} nicht übernommen. Er trägt weiter seinen letzten Stand.':
    'The replica {peer} did not apply the state of {node} on {when}. It keeps carrying its last state.',
  'Was zu tun ist: Unter „Abgleich“ steht der Zustand jedes Folgeknotens und der letzte Lauf mit seinen Schritten.':
    'What to do: under “Sync” you find the state of every replica and the last run with its steps.',
  'Abgleich ansehen': 'View sync',
};
