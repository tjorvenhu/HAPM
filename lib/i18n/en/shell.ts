import type { Dictionary } from './index';

/** Der Rahmen: Seitenleiste, Suche, Bausteine aus `ui/`, Fehlerseiten der Oberfläche. */
export const shell: Dictionary = {
  // Seitenleiste (`components/Sidebar.tsx`), auch Titel im Browser und Seiten der Suche
  'Übersicht': 'Overview',
  'Reverse-Proxy': 'Reverse proxy',
  'Ziele': 'Targets',
  'Statistik': 'Statistics',
  'Zertifikate': 'Certificates',
  'Logs': 'Logs',
  'DNS': 'DNS',
  'API': 'API',
  'Fehlerseiten': 'Error pages',
  'Einstellungen': 'Settings',
  'System': 'System',
  'Updates': 'Updates',
  'Sicherung': 'Backup',
  'Benachrichtigungen': 'Notifications',
  'Allgemein': 'General',
  'Benutzer': 'Users',
  'Konto': 'Account',
  'Seitenleiste': 'Sidebar',
  'Navigation öffnen': 'Open navigation',
  'Navigation schließen': 'Close navigation',
  'Seiten im Bereich {area}': 'Pages in {area}',
  '{count} offen': '{count} pending',
  'Abmelden': 'Sign out',
  'Zum Inhalt springen': 'Skip to content',
  'Wird geladen': 'Loading',

  // Globale Suche
  'Suchen': 'Search',
  'Suche öffnen': 'Open search',
  'Strg K': 'Ctrl K',
  'Strg': 'Ctrl',
  'Globale Suche': 'Global search',
  'Seiten': 'Pages',
  'Seiten, Domains, Dienste, Backend-Adressen': 'Pages, domains, services, backend addresses',
  'TCP-Weiterleitungen': 'TCP forwards',
  'Mindestens {count} Zeichen eingeben.': 'Type at least {count} characters.',
  'Suche läuft …': 'Searching …',
  'Keine Treffer für „{query}“.': 'No results for “{query}”.',
  '{keys} zum Öffnen': '{keys} to open',
  '{key} zum Schließen': '{key} to close',

  // Laufende Vorgänge (`components/ActivityIndicator.tsx`)
  '{count} Vorgang': '{count} task',
  '{count} Vorgänge': '{count} tasks',
  'Laufende Vorgänge': 'Running tasks',
  'Laufende Vorgänge anzeigen': 'Show running tasks',

  // Bausteine aus `ui/tool/`
  'Zum Bestätigen abtippen:': 'Type to confirm:',
  'Kennung kopieren': 'Copy identifier',
  'Bitte auswählen...': 'Please select...',
  'Keine Einträge vorhanden': 'No entries',
  'Meldungen': 'Notifications',
  'Meldung schließen': 'Dismiss notification',

  // Diagramme (`ui/charts/`)
  'Keine Daten.': 'No data.',
  'Noch keine Daten.': 'No data yet.',
  'Anteil': 'Share',
  'Summe': 'Total',
  'Für diesen Zeitraum liegen keine Messwerte vor.': 'There are no measurements for this period.',

  // Fehlerseiten der Oberfläche und Kopf des Dokuments
  'Weboberfläche für HAProxy mit automatischen Zertifikaten': 'Web interface for HAProxy with automatic certificates',
  'Seite nicht gefunden': 'Page not found',
  'Unter dieser Adresse gibt es in HAPM nichts. Vielleicht ist der Link veraltet oder falsch geschrieben.':
    'There is nothing in HAPM at this address. The link may be outdated or mistyped.',
  'Zur Übersicht': 'Go to overview',
  'Das hat nicht geklappt': 'That did not work',
  'Beim Laden der Seite ist ein Fehler aufgetreten. Was geschehen ist, steht im Log des Containers hapm.':
    'An error occurred while loading the page. The log of the hapm container says what happened.',
  'Sprache': 'Language',
};
