/**
 * Was hinter dem Namen eines CrowdSec-Ereignisses steckt, in Worten für die
 * Seite. CrowdSec meldet Regelnamen (`crowdsecurity/http-probing`) oder bei
 * OWASP die Punkte je Kategorie (`anomaly score out-of-band: lfi: 5,
 * anomaly: 5, `). Damit kann niemand etwas anfangen, der nicht weiß, was LFI
 * heißt.
 *
 * Rein, nur `msgid`: die Seite übersetzt mit `t()`. Ein unbekannter Name
 * liefert `null`, die Seite zeigt dann den Namen selbst. Lieber der rohe Name
 * als eine geratene Erklärung.
 */

import { msgid } from '../i18n/translate';

export interface ReasonDescription {
  /** Kurz, für die Zeile. Mehrere bei OWASP mit mehreren Kategorien. */
  labels: string[];
  /** Was dahintersteckt, für das „i". */
  hints: string[];
}

interface Entry {
  label: string;
  hint: string;
}

const FILES: Entry = {
  label: msgid('Zugriff auf Dateien des Servers'),
  hint: msgid(
    'Die Anfrage nennt einen Pfad zu Dateien auf dem Server, etwa ../, /etc/passwd oder .env. So suchen Angreifer nach Passwörtern und Schlüsseln. Fachbegriff: Local File Inclusion (LFI).'
  ),
};
const SQL: Entry = {
  label: msgid('Eingeschleuste Datenbankabfrage'),
  hint: msgid(
    "Die Anfrage enthält SQL, etwa ' OR 1=1 oder UNION SELECT. Ziel ist, Daten aus der Datenbank der Anwendung zu lesen oder zu ändern. Fachbegriff: SQL-Injection."
  ),
};
const SCRIPT: Entry = {
  label: msgid('Eingeschleustes Skript'),
  hint: msgid(
    'Die Anfrage enthält JavaScript oder HTML, etwa <script>. Eine verwundbare Seite würde es anderen Besuchern ausliefern. Fachbegriff: Cross-Site-Scripting (XSS).'
  ),
};
const KNOWN_FLAW: Entry = {
  label: msgid('Angriff auf eine bekannte Lücke'),
  hint: msgid(
    'Die Anfrage passt zu einem veröffentlichten Angriff auf eine bestimmte Software. Steht im Namen der Regel eine CVE-Nummer, ist das die Kennung der Lücke.'
  ),
};

/** Die Kategorien des OWASP-Regelwerks, wie CrowdSec sie im Namen nennt. */
const CRS_CATEGORIES: Record<string, Entry> = {
  lfi: FILES,
  rfi: {
    label: msgid('Einbinden fremder Dateien'),
    hint: msgid(
      'Die Anfrage übergibt eine Adresse im Internet als Parameter. Eine verwundbare Anwendung würde Code von dort laden und ausführen. Fachbegriff: Remote File Inclusion (RFI).'
    ),
  },
  rce: {
    label: msgid('Eingeschleuste Befehle'),
    hint: msgid(
      'Die Anfrage enthält Befehle für die Kommandozeile des Servers, etwa ; cat oder | sh. Ziel ist, auf dem Server Programme auszuführen. Fachbegriff: Remote Code Execution (RCE). Bei Anwendungen, die Abfragen oder Code als Text schicken (GraphQL, Editoren), oft ein Fehlalarm.'
    ),
  },
  sql_injection: SQL,
  sqli: SQL,
  xss: SCRIPT,
  php_injection: {
    label: msgid('Eingeschleuster PHP-Code'),
    hint: msgid('Die Anfrage enthält PHP-Code oder Aufrufe wie eval( oder system(. Ziel ist, ihn auf dem Server auszuführen.'),
  },
  http_violation: {
    label: msgid('Fehlerhafte Anfrage'),
    hint: msgid(
      'Die Anfrage verstößt gegen die Regeln von HTTP, etwa mit doppelten oder widersprüchlichen Kopfzeilen. Damit versuchen Angreifer, Prüfungen zu umgehen.'
    ),
  },
  session_fixation: {
    label: msgid('Untergeschobene Sitzung'),
    hint: msgid('Die Anfrage setzt eine Sitzungskennung von außen. Ziel ist, später die Anmeldung eines anderen Nutzers zu übernehmen.'),
  },
};
CRS_CATEGORIES.php = CRS_CATEGORIES.php_injection;

/** Nur die Gesamtpunkte, keine Kategorie: eine allgemeine Regel hat angeschlagen. */
const CRS_GENERIC: Entry = {
  label: msgid('Auffällige Anfrage'),
  hint: msgid(
    'Eine allgemeine Regel des OWASP-Regelwerks hat angeschlagen, etwa für eine gesperrte Dateiendung (.asax, .ini, .bak), eine unübliche HTTP-Version oder fehlende Kopfzeilen.'
  ),
};

const OUT_OF_BAND = msgid(
  'Nur gemeldet, die Anfrage ging durch. Schickt eine Adresse mehrere solcher Anfragen, sperrt CrowdSec sie.'
);
const BLOCKED = msgid('Die Anfrage wurde mit 403 abgewiesen.');

/** Regeln und Szenarien nach Namen, ohne den Autor davor (`crowdsecurity/`). */
const NAMED: Record<string, Entry> = {
  'http-probing': {
    label: msgid('Viele Abrufe von Seiten, die es nicht gibt'),
    hint: msgid(
      'Die Adresse hat in kurzer Zeit viele Seiten abgerufen, die mit 404 antworteten. So suchen Scanner nach bekannten Dateien und Programmen.'
    ),
  },
  'http-sensitive-files': {
    label: msgid('Suche nach vertraulichen Dateien'),
    hint: msgid('Die Adresse hat Dateien abgerufen, die nicht öffentlich sein sollten, etwa Sicherungen, Konfiguration oder .env.'),
  },
  'http-crawl-non_statics': {
    label: msgid('Sehr viele Seitenabrufe'),
    hint: msgid(
      'Die Adresse hat in kurzer Zeit sehr viele Seiten abgerufen, die keine Bilder, Skripte oder Stylesheets sind. Typisch für Scanner und aggressive Crawler.'
    ),
  },
  'http-admin-interface-probing': {
    label: msgid('Suche nach Verwaltungsoberflächen'),
    hint: msgid('Die Adresse hat Anmeldeseiten und Verwaltungen bekannter Programme abgerufen, etwa /wp-admin oder /phpmyadmin.'),
  },
  'http-technology-probing': {
    label: msgid('Erkundung der eingesetzten Software'),
    hint: msgid(
      'Die Adresse hat Dateien abgerufen, an denen man erkennt, welche Software ein Server einsetzt. Das geht einem gezielten Angriff oft voraus.'
    ),
  },
  'http-bad-user-agent': {
    label: msgid('Bekanntes Angriffswerkzeug'),
    hint: msgid('Die Anfragen tragen die Kennung eines Scanners oder Angriffswerkzeugs (User-Agent).'),
  },
  'http-backdoors-attempts': {
    label: msgid('Suche nach Hintertüren'),
    hint: msgid('Die Adresse hat Dateien abgerufen, die Angreifer auf übernommenen Servern hinterlassen (Web-Shells).'),
  },
  'http-path-traversal-probing': FILES,
  'http-sqli-probing': SQL,
  'http-xss-probing': SCRIPT,
  'http-open-proxy': {
    label: msgid('Missbrauch als Proxy'),
    hint: msgid('Die Adresse hat versucht, über den Server fremde Seiten abzurufen.'),
  },
  'vpatch-env-access': {
    label: msgid('Abruf einer .env-Datei'),
    hint: msgid('In einer .env-Datei stehen oft Passwörter und Schlüssel für Datenbanken und andere Dienste.'),
  },
  'vpatch-git-config': {
    label: msgid('Abruf von Git-Daten'),
    hint: msgid('Im Ordner .git liegt der Quelltext einer Website samt Verlauf. Ist er erreichbar, lässt sich der ganze Code herunterladen.'),
  },
  'appsec-vpatch': {
    label: msgid('Wiederholte Angriffe auf bekannte Lücken'),
    hint: msgid('Die Adresse hat mehrere Anfragen geschickt, die eine Regel gegen bekannte Lücken erkannt hat.'),
  },
  'crowdsec-appsec-outofband': {
    label: msgid('Wiederholt auffällige Anfragen'),
    hint: msgid(
      'Die Adresse hat in kurzer Zeit mehrere Anfragen geschickt, die gegen das OWASP-Regelwerk verstoßen. Einzeln gehen solche Anfragen durch, gehäuft führen sie zu einer Sperre.'
    ),
  },
};

const BRUTE_FORCE: Entry = {
  label: msgid('Passwörter durchprobiert'),
  hint: msgid('Die Adresse hat sich in kurzer Zeit oft mit falschem Passwort angemeldet.'),
};
const WORDPRESS: Entry = {
  label: msgid('Angriff auf WordPress'),
  hint: msgid('Die Adresse hat WordPress nach Nutzern, Konfiguration oder bekannten Lücken abgesucht.'),
};
const DOS: Entry = {
  label: msgid('Überlastungsversuch'),
  hint: msgid('Die Adresse hat so viele oder so ungewöhnliche Anfragen geschickt, dass sie den Dienst lahmlegen könnten.'),
};

function one(entry: Entry): ReasonDescription {
  return { labels: [entry.label], hints: [entry.hint] };
}

/**
 * `anomaly score out-of-band: lfi: 5, anomaly: 10, ` (das frühere „Nur
 * melden") oder `anomaly score block: …` (OWASP an, geprüft mit CrowdSec 1.8.2).
 */
function describeAnomaly(name: string): ReasonDescription | null {
  const match = /^anomaly score(?: (out-of-band|in-band|block))?:(.*)$/i.exec(name.trim());
  if (!match) return null;
  const entries: Entry[] = [];
  for (const part of match[2].split(',')) {
    const pair = /^\s*([a-z_]+)\s*:\s*\d+\s*$/i.exec(part);
    if (!pair) continue;
    const entry = CRS_CATEGORIES[pair[1].toLowerCase()];
    if (entry && !entries.includes(entry)) entries.push(entry);
  }
  // Eine Kategorie, die hier fehlt, ist trotzdem ein Treffer: dann wenigstens „auffällig".
  if (entries.length === 0) entries.push(CRS_GENERIC);
  const how = match[1]?.toLowerCase();
  const outcome = how === 'out-of-band' ? [OUT_OF_BAND] : how === 'block' ? [BLOCKED] : [];
  return {
    labels: entries.map((entry) => entry.label),
    hints: [...entries.map((entry) => entry.hint), ...outcome],
  };
}

export function describeReason(name: string): ReasonDescription | null {
  const anomaly = describeAnomaly(name);
  if (anomaly) return anomaly;

  const short = name.trim().replace(/^[\w.-]+\//, '').toLowerCase();
  if (!short) return null;
  const named = NAMED[short];
  if (named) return one(named);
  if (/cve/.test(short) || short.startsWith('vpatch-')) return one(KNOWN_FLAW);
  if (/(^|[-_])bf([-_]|$)|bruteforce/.test(short)) return one(BRUTE_FORCE);
  if (short.includes('wordpress')) return one(WORDPRESS);
  if (short.startsWith('http-dos')) return one(DOS);
  return null;
}
