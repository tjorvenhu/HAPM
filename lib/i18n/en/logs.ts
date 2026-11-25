import type { Dictionary } from './index';

/** Reverse-Proxy → Logs: die Reiter und das HAProxy-Log (`app/(app)/reverse-proxy/logs`, `app/api/haproxy/log`). */
export const logs: Dictionary = {
  // Reiter
  "Vorgänge": "Tasks",
  "HAProxy-Log": "HAProxy log",
  "Was HAProxy selbst schreibt: jede Anfrage und jede Meldung des Prozesses, die neueste oben.": "What HAProxy itself writes: every request and every message of the process, newest first.",

  // Vorgänge
  "{count} weitere": "{count} more",

  // Werkzeugleiste
  "Im Log suchen…": "Search the log…",
  "Im Log suchen": "Search the log",
  "Anzeigen": "Show",
  "Zeilen": "Lines",
  "Die letzten {count}": "Last {count}",
  "Mitlaufen": "Follow",
  "Mehr laden": "Load more",

  // Filter
  "Alle Zeilen": "All lines",
  "Alle Anfragen": "All requests",
  "2xx: erfolgreich": "2xx: success",
  "3xx: Weiterleitung": "3xx: redirect",
  "4xx: Fehler des Clients": "4xx: client error",
  "5xx: Fehler des Servers": "5xx: server error",
  "Meldungen von HAProxy": "Messages from HAProxy",
  "Nur Warnungen und Fehler": "Warnings and errors only",

  // Stufen
  "Hinweis": "Notice",
  "Warnung": "Warning",
  "Meldung": "Message",

  // Tabelle
  "Zeit": "Time",
  "Client": "Client",
  "Frontend und Backend": "Frontend and backend",

  // Zustand von Datei und Mitschnitt
  "Das HAProxy-Log konnte nicht gelesen werden.": "The HAProxy log could not be read.",
  "Kein HAProxy-Log": "No HAProxy log",
  "Der Mitschnitt des Logs läuft nicht, und die Datei {file} gibt es nicht. HAPM startet den Mitschnitt mit dem Server und liest das Log über die Docker-Engine aus dem HAProxy-Container.": "The log capture is not running, and the file {file} does not exist. HAPM starts the capture with the server and reads the log from the HAProxy container through the Docker Engine.",
  "Der Mitschnitt ist nicht mit dem HAProxy-Container verbunden, und die Datei {file} gibt es noch nicht. Läuft HAProxy, und ist die Docker-Engine erreichbar?": "The log capture is not connected to the HAProxy container, and the file {file} does not exist yet. Is HAProxy running, and can the Docker Engine be reached?",
  "Der Mitschnitt ist verbunden, HAProxy hat aber noch keine Zeile geschrieben. Die Datei {file} entsteht mit der ersten Zeile.": "The log capture is connected, but HAProxy has not written a line yet. The file {file} is created with the first line.",
  "Der Mitschnitt ist gerade nicht mit dem HAProxy-Container verbunden. Die Zeilen unten sind der letzte Stand der Datei. Neue kommen erst wieder an, wenn er sich verbunden hat.": "The log capture is currently not connected to the HAProxy container. The lines below are the last state of the file. New lines arrive once it has reconnected.",
  "Der Mitschnitt läuft nicht. Die Zeilen unten sind der letzte Stand der Datei, neue kommen nicht hinzu.": "The log capture is not running. The lines below are the last state of the file, no new lines are added.",
  "Mitschnitt verbunden": "Capture connected",
  "Mitschnitt getrennt": "Capture disconnected",
  "Ein Treffer in den letzten {scanned} Zeilen": "One match in the last {scanned} lines",
  "{count} Treffer in den letzten {scanned} Zeilen": "{count} matches in the last {scanned} lines",
  "Die letzte Zeile": "The last line",
  "Die letzten {count} Zeilen": "The last {count} lines",
  "Zuletzt geschrieben: {time}": "Last written: {time}",
  "Das Log ist leer": "The log is empty",
  "Die Datei {file} ist da, enthält aber noch keine Zeile.": "The file {file} exists but does not contain a line yet.",
  "Keine passende Zeile": "No matching line",
  "In den letzten {scanned} Zeilen passt keine zu Suche und Filter.": "None of the last {scanned} lines matches the search and filter.",
};
