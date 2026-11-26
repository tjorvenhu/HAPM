/**
 * Regeln für einzelne Anwendungen hinter HAPM: Ausnahmen gegen bekannte
 * Fehlsperren und, bei WordPress, virtuelle Patches. Eine Zeile je Anwendung,
 * ein Schalter installiert oder entfernt alles, was dazugehört.
 *
 * Drei Arten:
 * - `parsers`/`collections` aus dem Hub von CrowdSec. Die Whitelists im Log
 *   (`…-whitelist`, `…-allowlist`) prüfen nur Felder, die auch das Log von
 *   HAProxy liefert (`http_path` samt Anfrage, `http_status`, `http_verb`).
 *   Die Ausnahmen für die OWASP-Regeln (`appsec-crs-exclusion-plugin-…`) holen
 *   nur Dateien, die die CRS-Regel selbst einbindet: ohne OWASP-Regeln tun sie
 *   nichts.
 * - `local`: eigene Ausnahmen von HAPM, wo der Hub nichts oder zu wenig hat.
 *   Nur, was in einem Ticket oder im Forum von CrowdSec als Fehlsperre mit
 *   Pfad und Status belegt ist; die Quelle steht am Eintrag und in der Datei.
 *   HAPM schreibt sie als Whitelist nach `parsers/s02-enrich/hapm-app-<id>.yaml`.
 *
 * Bei HAProxy ist `evt.Meta.http_path` die ganze Anfrage samt `?…`: ein Muster,
 * das mit `$` endet, braucht davor `(\?.*)?`. Jedes Muster ist am Anfang
 * verankert und, wo der Pfad dort endet, auch am Ende: ein Muster, das irgendwo
 * passen darf, passte auch auf die Parameter, und ein Scanner hängte es einfach
 * an (`/index.php?id=1'…&x=/apps/deck/…`). `..` im Pfad nimmt keine Ausnahme. Eine Whitelist in `s02-enrich`
 * nimmt die Zeile aus jedem Szenario, auch aus `http-crawl-non_statics`, das
 * für eine Whitelist nach dem Überlauf zu wenig Ereignisse behält.
 *
 * Eine feste Liste: die Namen gehen als Argument an `cscli`.
 */

import { msgid } from '../i18n/translate';

export type AppRuleKind = 'log' | 'waf' | 'owasp';

export interface AppRules {
  id: string;
  label: string;
  hint: string;
  kinds: readonly AppRuleKind[];
  hub: readonly { type: 'parsers' | 'collections'; name: string }[];
  /** Eigene Ausnahmen im Log, jede für sich. */
  local?: readonly LocalRule[];
}

/** Eine Ausnahme: Methode, Status und Pfad (RE2, gegen die ganze Anfrage). */
export interface LocalRule {
  verbs: readonly string[];
  statuses: readonly string[];
  path: string;
  /** Wo die Fehlsperre beschrieben ist. */
  source: string;
}

/** Gilt für jede Zeile aus dem Log von HAProxy (und jedem anderen HTTP-Log). */
const HTTP_FILTER = "evt.Meta.service == 'http' && evt.Meta.log_type in ['http_access-log', 'http_error-log']";

/** Ein String der Ausdruckssprache von CrowdSec (expr) in einfachen Anführungszeichen. */
function exprString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function localRuleExpression(rule: LocalRule): string {
  const list = (values: readonly string[]) => `[${values.map(exprString).join(', ')}]`;
  // `..` nie: sonst hängte ein Scanner `/../../.env` an einen ausgenommenen
  // Anfang und bliebe mit seinen 404 unerkannt.
  return `evt.Meta.http_verb in ${list(rule.verbs)} && evt.Meta.http_status in ${list(rule.statuses)} && !(evt.Meta.http_path contains '..') && evt.Meta.http_path matches ${exprString(rule.path)}`;
}

const GET = ['GET', 'HEAD'] as const;
const HUB = 'https://github.com/crowdsecurity/hub';
const FORUM = 'https://discourse.crowdsec.net/t';

export const APP_RULES: readonly AppRules[] = [
  {
    id: 'nextcloud',
    label: 'Nextcloud',
    kinds: ['log', 'owasp'],
    hint: msgid(
      'Nextcloud lädt Vorschaubilder, Avatare und Dateien über WebDAV in schneller Folge und antwortet dabei oft mit 403 oder 404, etwa für fehlende Vorschauen oder beim Hochladen. CrowdSec hält das für einen Scanner und sperrt die eigenen Nutzer. Die Ausnahmen aus dem Hub nehmen WebDAV, Vorschauen, Fotos, Memories, Mail, Text und Lesezeichen aus. HAPM ergänzt Fälle, die dort noch fehlen: den Abgleich der Mobil-App (HEAD auf WebDAV), Kalender und Kontakte mit 403, abgelaufene Sitzungen im Text-Editor, Karten in Deck, die Anmeldung neuer Geräte und Talk. Dazu kommen Ausnahmen für die OWASP-Regeln, die sonst Dateinamen, Kalender und Kontakte als Angriff lesen. Die wirken nur, wenn die OWASP-Regeln an sind.'
    ),
    hub: [
      { type: 'parsers', name: 'crowdsecurity/nextcloud-whitelist' },
      { type: 'collections', name: 'crowdsecurity/appsec-crs-exclusion-plugin-nextcloud' },
    ],
    local: [
      { verbs: ['HEAD'], statuses: ['403', '404'], path: String.raw`^/remote\.php/(web)?dav/files/`, source: `${HUB}/issues/1102` },
      { verbs: ['PROPFIND'], statuses: ['403'], path: String.raw`^/remote\.php/dav/(calendars|addressbooks)/`, source: `${FORUM}/1472` },
      { verbs: ['POST'], statuses: ['403'], path: String.raw`^(/[^/?.]+)?(/index\.php)?/apps/text/session/\d+/sync(\?.*)?$`, source: `${HUB}/issues/1092` },
      {
        verbs: GET,
        statuses: ['200', '304'],
        path: String.raw`^(/[^/?.]+)?(/index\.php)?/apps/deck/api/v\d+(\.\d+)?/boards/\d+/stacks/\d+/cards/\d+(\?.*)?$`,
        source: `${HUB}/issues/991`,
      },
      {
        verbs: GET,
        statuses: ['200'],
        path: String.raw`^(/index\.php)?/ocs/v[12]\.php/cloud/(capabilities|user)(\?.*)?$`,
        source: `${HUB}/issues/1785`,
      },
      { verbs: ['POST'], statuses: ['404'], path: String.raw`^(/index\.php)?/login/v2/poll(\?.*)?$`, source: `${FORUM}/1253` },
      { verbs: ['GET'], statuses: ['404'], path: String.raw`^/push/ws(\?.*)?$`, source: `${FORUM}/1253` },
      { verbs: ['HEAD'], statuses: ['404'], path: String.raw`^/ocs/v2\.php/apps/spreed/api/v\d+/(chat|room)(/[A-Za-z0-9]+)*(\?.*)?$`, source: `${FORUM}/1253` },
      {
        verbs: ['PROPFIND'],
        statuses: ['404'],
        path: String.raw`^/public\.php/webdav/(.*/)?\.no(index|media|memories)(\?.*)?$`,
        source: `${FORUM}/1253`,
      },
    ],
  },
  {
    id: 'wordpress',
    label: 'WordPress',
    kinds: ['waf', 'owasp'],
    hint: msgid(
      'Zwei Teile. Virtuelle Patches: die WAF lehnt Anfragen auf bekannte Lücken in WordPress und verbreiteten Plugins ab, auch wenn das Update noch fehlt. Ausnahmen für die OWASP-Regeln: Block-Editor, REST-API und Verwaltung schicken HTML, Skripte und Shortcodes im Text, die die OWASP-Regeln sonst als XSS oder Injection sperren. Die Ausnahmen wirken nur, wenn die OWASP-Regeln an sind.'
    ),
    hub: [
      { type: 'collections', name: 'crowdsecurity/appsec-wordpress' },
      { type: 'collections', name: 'crowdsecurity/appsec-crs-exclusion-plugin-wordpress' },
    ],
  },
  {
    id: 'drupal',
    label: 'Drupal',
    kinds: ['owasp'],
    hint: msgid(
      'Drupal schickt beim Bearbeiten von Inhalten und in der Verwaltung HTML und Formulardaten, die die OWASP-Regeln als Angriff lesen, etwa aus dem Text-Editor oder den Ansichten (Views). Die Ausnahmen des OWASP-Projekts nehmen diese Felder aus. Wirkt nur, wenn die OWASP-Regeln an sind.'
    ),
    hub: [{ type: 'collections', name: 'crowdsecurity/appsec-crs-exclusion-plugin-drupal' }],
  },
  {
    id: 'phpmyadmin',
    label: 'phpMyAdmin',
    kinds: ['owasp'],
    hint: msgid(
      'phpMyAdmin schickt SQL im Klartext, das ist seine Aufgabe. Ohne Ausnahmen sperren die OWASP-Regeln jede Abfrage als SQL-Injection. Die Ausnahmen nehmen die Felder für SQL und Import aus. Wirkt nur, wenn die OWASP-Regeln an sind. Besser ist, phpMyAdmin gar nicht öffentlich erreichbar zu machen (Passwortschutz oder Sperre nach Adresse am Ziel).'
    ),
    hub: [{ type: 'collections', name: 'crowdsecurity/appsec-crs-exclusion-plugin-phpmyadmin' }],
  },
  {
    id: 'dokuwiki',
    label: 'DokuWiki',
    kinds: ['owasp'],
    hint: msgid(
      'DokuWiki speichert Seiten als Wiki-Text mit Code-Blöcken, Links und HTML. Beim Speichern und in der Vorschau lesen die OWASP-Regeln das als XSS oder Injection. Die Ausnahmen nehmen den Editor und die Verwaltung aus. Wirkt nur, wenn die OWASP-Regeln an sind.'
    ),
    hub: [{ type: 'collections', name: 'crowdsecurity/appsec-crs-exclusion-plugin-dokuwiki' }],
  },
  {
    id: 'phpbb',
    label: 'phpBB',
    kinds: ['owasp'],
    hint: msgid(
      'Beiträge mit BBCode, Code-Schnipseln oder Links lösen die OWASP-Regeln aus, ebenso Teile der Verwaltung. Die Ausnahmen nehmen Beitragstext, Vorschau und Verwaltung aus. Wirkt nur, wenn die OWASP-Regeln an sind.'
    ),
    hub: [{ type: 'collections', name: 'crowdsecurity/appsec-crs-exclusion-plugin-phpbb' }],
  },
  {
    id: 'xenforo',
    label: 'XenForo',
    kinds: ['owasp'],
    hint: msgid(
      'Beiträge mit BBCode, Code-Schnipseln oder Links lösen die OWASP-Regeln aus, ebenso Teile der Verwaltung. Die Ausnahmen nehmen Beitragstext, Vorschau und Verwaltung aus. Wirkt nur, wenn die OWASP-Regeln an sind.'
    ),
    hub: [{ type: 'collections', name: 'crowdsecurity/appsec-crs-exclusion-plugin-xenforo' }],
  },
  {
    id: 'cpanel',
    label: 'cPanel',
    kinds: ['owasp'],
    hint: msgid(
      'Dateimanager, Editor und Einstellungen von cPanel und WHM schicken Pfade, Code und Befehle, die die OWASP-Regeln sperren. Die Ausnahmen nehmen diese Bereiche aus. Wirkt nur, wenn die OWASP-Regeln an sind.'
    ),
    hub: [{ type: 'collections', name: 'crowdsecurity/appsec-crs-exclusion-plugin-cpanel' }],
  },
  {
    id: 'jellyfin',
    label: 'Jellyfin',
    kinds: ['log'],
    hint: msgid(
      'Die Apps von Jellyfin melden beim Abspielen laufend den Fortschritt, und viele Clients fragen beim Blättern Bilder ab, die es nicht gibt (Roku, Swiftfin, Infuse). Die Antworten 403 und 404 sehen für CrowdSec wie ein Scanner aus. Der Hub nimmt den Fortschritt und die Vorschaubilder aus. HAPM ergänzt Hintergrundbilder, Untertitel (Swiftfin und VLC mit „Immer abspielen“) und den Startbildschirm von Swiftfin auf dem Apple TV.'
    ),
    hub: [{ type: 'parsers', name: 'crowdsecurity/jellyfin-whitelist' }],
    local: [
      { verbs: GET, statuses: ['404'], path: String.raw`(?i)^/items/[^/?]+/images/backdrop(/\d+)?(\?.*)?$`, source: `${HUB}/pull/2008` },
      {
        verbs: GET,
        statuses: ['404'],
        path: String.raw`(?i)^/videos/[^/?]+/[^/?]+/subtitles/\d+/\d+/stream(\.[a-z0-9]+)?(\?.*)?$`,
        source: 'https://github.com/jellyfin/Swiftfin/issues/1418',
      },
      { verbs: GET, statuses: ['404'], path: String.raw`(?i)^/branding/splashscreen(\?.*)?$`, source: 'https://github.com/jellyfin/Swiftfin/issues/690' },
    ],
  },
  {
    id: 'plex',
    label: 'Plex',
    kinds: ['log'],
    hint: msgid(
      'Plex holt beim Abspielen und Blättern viele Segmente, Untertitel, Vorschaubilder und Metadaten, teils mit 403 oder 404 als Antwort. Das sieht für CrowdSec wie ein Scanner aus. Der Hub nimmt Transcoder, Timeline, Metadaten und Wiedergabelisten aus. Neuere Apps (etwa auf dem Apple TV) laden beim Stöbern zusätzlich Dutzende Übersichten in wenigen Sekunden, das gilt als Crawler. HAPM nimmt diese Abfragen (/hubs, /library, /playlists und andere) bei Antwort 200 aus.'
    ),
    hub: [{ type: 'parsers', name: 'crowdsecurity/plex-allowlist' }],
    local: [
      {
        verbs: GET,
        statuses: ['200'],
        path: String.raw`^/(hubs/|activities|library/(sections/|all|search)|playlists/|media/providers)`,
        source: `${HUB}/pull/1661`,
      },
    ],
  },
  {
    id: 'seerr',
    label: msgid('Overseerr und Jellyseerr'),
    kinds: ['log'],
    hint: msgid(
      'Beim Blättern fragen Overseerr und Jellyseerr für jeden Film und jede Serie eine eigene Adresse ab (/api/v1/movie/123). Viele verschiedene Adressen ohne Dateiendung in kurzer Zeit hält CrowdSec für einen Crawler. Die Ausnahmen nehmen diese Abfragen aus.'
    ),
    hub: [
      { type: 'parsers', name: 'crowdsecurity/overseerr-whitelist' },
      { type: 'parsers', name: 'crowdsecurity/jellyseerr-whitelist' },
    ],
  },
  {
    id: 'matrix',
    label: msgid('Matrix (Synapse, Element)'),
    kinds: ['log'],
    hint: msgid(
      'Element und andere Matrix-Clients fragen beim Öffnen von Räumen nach Zuständen, Ereignissen und Geräten, die es oft nicht gibt, und bekommen 404. Vorschaubilder und Linkvorschauen kommen als viele einzelne Adressen. CrowdSec sperrt deshalb aktive Nutzer als Scanner oder Crawler. Der Hub hat dafür nichts. HAPM nimmt die belegten Fälle aus: Verschlüsselung und Ereignisse von Räumen, Geräte, Föderation, Relationen, Vorschaubilder, Linkvorschau, Anmeldedaten, TURN-Server und /.well-known/matrix.'
    ),
    hub: [],
    local: [
      {
        verbs: GET,
        statuses: ['404'],
        path: String.raw`^/_matrix/client/(r0|v3)/rooms/[^/?]+/(state/m\.room\.encryption/?|event/[^/?]+)(\?.*)?$`,
        source: `${HUB}/pull/1726`,
      },
      {
        verbs: GET,
        statuses: ['404'],
        path: String.raw`^/_matrix/client/unstable/org\.matrix\.msc3814\.v1/dehydrated_device(/[^/?]+)?(\?.*)?$`,
        source: `${HUB}/pull/1726`,
      },
      { verbs: GET, statuses: ['404'], path: String.raw`^/_matrix/federation/v1/event/[^/?]+(\?.*)?$`, source: `${HUB}/pull/1726` },
      { verbs: GET, statuses: ['403'], path: String.raw`^/_matrix/client/v1/rooms/[^/?]+/relations/[^/?]+(/[^/?]+){0,2}(\?.*)?$`, source: `${HUB}/pull/1726` },
      { verbs: GET, statuses: ['200', '304'], path: String.raw`^/_matrix/client/v1/media/thumbnail/[^/?]+/[^/?]+(\?.*)?$`, source: `${HUB}/pull/1726` },
      {
        verbs: GET,
        statuses: ['404'],
        path: String.raw`^/_matrix/client/unstable/org\.matrix\.msc2965/auth_(metadata|issuer)(\?.*)?$`,
        source: `${HUB}/issues/1546`,
      },
      { verbs: GET, statuses: ['404'], path: String.raw`^/_matrix/(media/(r0|v3)|client/v1/media)/preview_url(\?.*)?$`, source: `${HUB}/issues/547` },
      { verbs: GET, statuses: ['404'], path: String.raw`^(/\.well-known/matrix/(client|server|support)|/_matrix/client/v3/voip/turnServer)(\?.*)?$`, source: `${FORUM}/1472` },
    ],
  },
  {
    id: 'immich',
    label: 'Immich',
    kinds: ['log'],
    hint: msgid(
      'Immich lädt in der Zeitleiste jedes Vorschaubild über eine eigene Adresse (/api/assets/…/thumbnail). Beim Scrollen durch eine große Bibliothek sind das Hunderte Abrufe ohne Dateiendung, die CrowdSec für einen Crawler hält. Der Hub hat dafür nichts. HAPM nimmt die Vorschaubilder aus.'
    ),
    hub: [],
    local: [
      {
        verbs: GET,
        statuses: ['200', '304', '404'],
        path: String.raw`^/api/assets/[0-9a-fA-F-]+/thumbnail(\?.*)?$`,
        source: 'https://gist.github.com/MikMik1011/536656958903f90bc3a771ea7f393538',
      },
    ],
  },
  {
    id: 'seafile',
    label: 'Seafile',
    kinds: ['log'],
    hint: msgid(
      'Der Sync-Client von Seafile holt Dateien in Blöcken, jeden Block über eine eigene Adresse ohne Dateiendung. Schon ein einziger Abgleich sieht für CrowdSec deshalb wie ein Crawler aus. Der Hub hat dafür nichts. HAPM nimmt die Blöcke aus.'
    ),
    hub: [],
    local: [{ verbs: GET, statuses: ['200'], path: String.raw`^/seafhttp/repo/[0-9a-f-]+/block/[0-9a-f]+(\?.*)?$`, source: `${HUB}/issues/1793` }],
  },
  {
    id: 'onlyoffice',
    label: 'ONLYOFFICE',
    kinds: ['log'],
    hint: msgid(
      'Der Document Server von ONLYOFFICE lädt Schriften als Dateien ohne Endung, für ein einziges Dokument oft über achtzig. Dazu kommt die Verbindung des Editors (WebSocket). CrowdSec hält das für einen Crawler. Der Hub hat dafür nichts. HAPM nimmt Schriften und Editor-Verbindung aus, auch unter einem Unterpfad wie /onlyoffice.'
    ),
    hub: [],
    local: [
      {
        verbs: GET,
        statuses: ['200', '304'],
        path: String.raw`^(/[^/?]+)?/[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{20,}/fonts/\d+(\?.*)?$`,
        source: `${HUB}/issues/2007`,
      },
      {
        verbs: ['GET'],
        statuses: ['101'],
        path: String.raw`^(/[^/?]+)?/[0-9]+\.[0-9]+\.[0-9]+-[0-9a-f]{20,}/doc/[^/?]+/c/`,
        source: `${HUB}/issues/2007`,
      },
    ],
  },
  {
    id: 'synology',
    label: 'Synology DSM',
    kinds: ['log'],
    hint: msgid(
      'Audio Station und File Station holen Cover und Vorschaubilder über dieselbe Adresse mit wechselnden Parametern. Fehlt ein Bild, antwortet DSM mit 404. Weil sich die Parameter unterscheiden, zählt CrowdSec jede Anfrage als eigenen Versuch eines Scanners. Der Hub hat dafür nichts. HAPM nimmt diese beiden Abrufe aus.'
    ),
    hub: [],
    local: [
      { verbs: GET, statuses: ['404'], path: String.raw`^/webapi/AudioStation/cover\.cgi(\?.*)?$`, source: `${HUB}/issues/1163` },
      { verbs: GET, statuses: ['404'], path: String.raw`^/webapi/entry\.cgi\?.*api=SYNO\.FileStation\.Thumb`, source: `${HUB}/issues/1163` },
    ],
  },
  {
    id: 'audiobookshelf',
    label: 'Audiobookshelf',
    kinds: ['log'],
    hint: msgid(
      'Die App von Audiobookshelf lädt nach der Einrichtung die Bilder aller Autoren. Fehlt eins auf dem Server, antwortet er mit 404, und viele davon hintereinander sehen für CrowdSec wie ein Scanner aus. Der Hub hat dafür nichts. HAPM nimmt die Autorenbilder aus.'
    ),
    hub: [],
    local: [
      {
        verbs: GET,
        statuses: ['404'],
        path: String.raw`^/api/authors/[0-9a-f-]+/image(\?.*)?$`,
        source: 'https://github.com/advplyr/audiobookshelf/issues/4387',
      },
    ],
  },
  {
    id: 'navidrome',
    label: 'Navidrome',
    kinds: ['log'],
    hint: msgid(
      'Clients wie Substreamer fragen Bilder von Künstlern ab, die es nicht gibt. Navidrome antwortet mit 404, und viele davon hintereinander sehen für CrowdSec wie ein Scanner aus. Der Hub hat dafür nichts. HAPM nimmt diese Bildabrufe aus.'
    ),
    hub: [],
    local: [{ verbs: GET, statuses: ['404'], path: String.raw`^/share/img/[^/?]+(\?.*)?$`, source: 'https://github.com/navidrome/navidrome/issues/5112' }],
  },
  {
    id: 'git',
    label: msgid('Git-Server (GitLab, Gitea, Forgejo)'),
    kinds: ['log'],
    hint: msgid(
      'Wer ein Repository über HTTPS holt, etwa als Submodul, ruft Adressen auf, die auf .git enden. Genau diese Endung sucht CrowdSec bei Scannern, die nach versehentlich veröffentlichten Repositories suchen, und sperrt nach wenigen Abrufen. Belegt ist das für GitLab, bei Gitea und Forgejo sehen die Adressen gleich aus. HAPM nimmt Abrufe der Form /gruppe/projekt.git aus, wenn der Server sie beantwortet (200, Weiterleitung oder Anmeldung). Eine Anfrage auf /.git, wie Scanner sie stellen, bleibt erkannt.'
    ),
    hub: [],
    local: [
      {
        verbs: GET,
        statuses: ['200', '301', '302', '401'],
        path: String.raw`^/[^./?][^?]*/[^/?]+\.git(\?.*)?$`,
        source: `${HUB}/issues/1774`,
      },
    ],
  },
  {
    id: 'rocketchat',
    label: 'Rocket.Chat',
    kinds: ['log'],
    hint: msgid(
      'Rocket.Chat lädt die Avatare aller Mitglieder eines Raums einzeln. Die vielen Abrufe unter /avatar/ hält CrowdSec für einen Crawler. Die Ausnahme nimmt sie aus.'
    ),
    hub: [{ type: 'parsers', name: 'crowdsecurity/rocketchat-whitelist' }],
  },
  {
    id: 'zammad',
    label: 'Zammad',
    kinds: ['log'],
    hint: msgid(
      'Zammad lädt Anhänge von Tickets über je eine eigene Adresse, und die Vorschau eines Anhangs ohne Recht antwortet mit 403. Beides kann für CrowdSec wie ein Crawler oder Scanner aussehen. Die Ausnahmen nehmen die Anhänge aus.'
    ),
    hub: [{ type: 'parsers', name: 'crowdsecurity/zammad-whitelist' }],
  },
  {
    id: 'calibre-web',
    label: 'Calibre-Web',
    kinds: ['log'],
    hint: msgid(
      'Calibre-Web lädt jedes Buchcover über eine eigene Adresse. Eine Bibliothek mit vielen Büchern sieht für CrowdSec deshalb wie ein Crawler aus. Die Ausnahme nimmt die Cover aus.'
    ),
    hub: [{ type: 'parsers', name: 'crowdsecurity/calibre-web-whitelist' }],
  },
  {
    id: 'actual-budget',
    label: 'Actual Budget',
    kinds: ['log'],
    hint: msgid(
      'Actual Budget lädt beim Start die Migrationen seiner Datenbank als einzelne .sql-Dateien. Viele solche Abrufe in kurzer Zeit sehen für CrowdSec wie ein Crawler aus. Die Ausnahme nimmt diese Pfade aus.'
    ),
    hub: [{ type: 'parsers', name: 'crowdsecurity/actual-budget-whitelist' }],
  },
  {
    id: 'music-assistant',
    label: 'Music Assistant',
    kinds: ['log'],
    hint: msgid(
      'Music Assistant lädt Cover über /imageproxy/ mit einer langen Kennung je Bild, fehlende Bilder antworten mit 404. Das sieht für CrowdSec wie ein Crawler oder Scanner aus. Die Ausnahme nimmt diese Abrufe aus.'
    ),
    hub: [{ type: 'parsers', name: 'crowdsecurity/music-assistant-allowlist' }],
  },
];

/** Relativ zum Ordner von CrowdSec in HAPM (`crowdsecDir()`). */
export function appWhitelistFile(id: string): string {
  return `config/parsers/s02-enrich/hapm-app-${id}.yaml`;
}

/**
 * Die Whitelist einer Anwendung im Format eines Parsers. Jeder Ausdruck steht
 * als JSON-String: das ist gültiges YAML und maskiert Anführungszeichen und
 * Backslashes der Ausdrücke richtig.
 */
export function renderAppWhitelist(app: AppRules): string {
  return [
    '# Geschrieben von HAPM (Reverse-Proxy, CrowdSec, Regeln, Anwendungen). Änderungen gehen verloren.',
    `name: hapm/${app.id}-allowlist`,
    `description: ${JSON.stringify(`HAPM: ${app.id}`)}`,
    `filter: ${JSON.stringify(HTTP_FILTER)}`,
    'whitelist:',
    `  reason: ${JSON.stringify(`HAPM: ${app.id}`)}`,
    '  expression:',
    ...(app.local ?? []).flatMap((rule) => [`    # ${rule.source}`, `    - ${JSON.stringify(localRuleExpression(rule))}`]),
    '',
  ].join('\n');
}
