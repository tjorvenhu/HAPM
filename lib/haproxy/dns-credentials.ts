/**
 * Die DNS-Zugangsdaten, mit denen acme.sh eine Wildcard ausstellt — im Formular
 * eingegeben, auf der Maschine abgelegt.
 *
 * ── HAPM ist Durchreiche, nicht Tresor ──
 *
 * Der Token wird **nicht** gespeichert. Er kommt aus dem Formular, geht in einem
 * Vorgang nach `/root/.acme.sh/account.conf` und ist danach hier weg. Das ist
 * kein Geiz, sondern die einzige Antwort, die stimmt: acme.sh schreibt die
 * Zugangsdaten beim ersten Antrag ohnehin dorthin und liest sie bei jeder
 * Erneuerung von dort. Sie zusätzlich hier zu halten wären zwei Quellen für ein
 * Geheimnis, von denen nur eine zählt — und die zweite wäre die, die niemand
 * anfasst, wenn der Token rotiert wird.
 *
 * Was HAPM dafür kann: ihn hinschreiben, ohne dass jemand eine Shell im
 * Container öffnet, und sagen, ob einer da ist. Eine neue Domain in derselben
 * Zone braucht danach gar nichts mehr.
 *
 * ── Warum eine Allow-Liste ──
 *
 * Der Wert landet in einer Datei, die als root gelesen und von einem
 * Shell-Skript ausgewertet wird. Ein frei getippter Variablenname wäre die
 * Einfallstelle, nicht der Wert. `dns_cf` und `CF_Token` stehen deshalb hier
 * und nicht im Formular.
 *
 * ── Anbieter mit mehr als einem Token ──
 *
 * RFC 2136 (`dns_nsupdate`) und Infoblox (`dns_infoblox`) passen nicht in „je
 * Feld eine `SAVED_`-Zeile": `nsupdate` will den TSIG-Schlüssel als Datei,
 * der Infoblox-Hook Benutzer und Passwort in einer Variablen und beides ohne
 * `SAVED_`. Solche Anbieter beschreiben selbst, was aus dem Formular wird
 * (`build`): Zeilen für `account.conf` und Dateien neben ihr. Die Dateien
 * liegen im Ordner von acme.sh, also im selben Volume und in jeder Sicherung.
 *
 * Rein (nur `lib/i18n` für die Meldungen und das ebenso reine
 * `lib/dns/access.ts`), damit `tests/haproxy/dns-credentials.test.ts` das
 * erzeugte Kommando gegen eine echte Bash laufen lassen kann.
 *
 * `label`, `hint` und `note` sind deutsche Schlüssel (`msgid`), die Seite
 * übersetzt sie beim Zeigen. `label` des Anbieters ist ein Eigenname.
 */

import { msg, msgid, type Message } from '../i18n/translate';
import {
  DEFAULT_DNS_PORT,
  DEFAULT_INFOBLOX_VIEW,
  DEFAULT_WAPI_VERSION,
  TSIG_ALGORITHMS,
  infobloxAccess,
  packAccess,
  rfc2136Access,
  tsigKeyFile,
  validateInfoblox,
  validateRfc2136,
  type InfobloxInput,
  type Rfc2136Input,
} from '../dns/access';

/** Wie ein Feld im Formular aussieht. */
export type DnsCredentialKind = 'secret' | 'text' | 'select' | 'pem';

export interface DnsCredentialField {
  /**
   * Der Name der Variablen, wie acme.sh sie liest — ohne `SAVED_`. Bei einem
   * Anbieter mit `build` der Name des Feldes im Formular: was daraus wird,
   * steht dort.
   */
  name: string;
  label: string;
  /** Ob ohne dieses Feld gar nicht gespeichert wird. */
  required: boolean;
  /** Ein Satz zu dem, was man sonst falsch macht. */
  hint?: string;
  /** Ohne Angabe ein Geheimnis: die Eingabe wird nicht angezeigt. */
  kind?: DnsCredentialKind;
  /** Nur `select`: die Werte, der erste ist die Vorgabe. Gezeigt werden sie, wie sie heißen. */
  options?: readonly string[];
  /** Was gilt, wenn das Feld leer bleibt. */
  placeholder?: string;
}

/** Eine Datei neben `account.conf`. `content: null` heißt: sie soll nicht (mehr) daliegen. */
export interface CredentialFile {
  path: string;
  content: string | null;
}

export interface CredentialPlan {
  /** Die Zeilen für `account.conf`, mit oder ohne `SAVED_`, wie der Hook sie liest. */
  lines: string[];
  files: CredentialFile[];
}

export interface DnsProvider {
  /** Der acme.sh-Hook, der mit diesen Variablen arbeitet. */
  hook: string;
  label: string;
  /**
   * Wo der Betreiber den Token herbekommt. Spart jedes Mal eine Suche. Fehlt
   * bei einem Anbieter, den man selbst betreibt.
   */
  consoleUrl?: string;
  /** Das Zeichen des Anbieters als Datei unter `public/providers/`. */
  logo?: string;
  /**
   * Das Feld, dessen Wert auch die API des Anbieters öffnet. Damit richtet die
   * Einrichtung die Zone unter „DNS" ein und setzt den Eintrag der Oberfläche.
   */
  apiTokenField?: string;
  fields: DnsCredentialField[];
  /**
   * Was der Hook beim ersten Antrag selbst daneben ablegt. Beim Entfernen geht
   * es mit: die Erkennung liest jede `SAVED_*`-Zeile, und mit einer übrig
   * gebliebenen gälte der Hook weiter als eingerichtet, obwohl der Token fehlt.
   */
  alsoSaved?: string[];
  note?: string;
  /**
   * Die Variablen des Hooks unter `SAVED_`, wenn sie nicht den Feldern
   * entsprechen. Ohne Angabe sind es die Namen der Felder.
   */
  savedNames?: string[];
  /**
   * Variablen, die der Hook OHNE `SAVED_` liest und schreibt (`_saveaccountconf`
   * statt `_saveaccountconf_mutable`). Beim Setzen und Entfernen gehen sie mit.
   */
  plainNames?: string[];
  /** Jede Datei, die `build` ablegen kann. Beim Entfernen gehen sie mit. */
  files?: string[];
  /** Die Prüfung der Eingabe, wenn die allgemeine (`CREDENTIAL_VALUE`) nicht passt. */
  validate?: (values: Record<string, string>) => Message | null;
  /** Was aus einer geprüften Eingabe auf der Maschine wird. Ohne Angabe: je Feld `SAVED_<name>`. */
  build?: (values: Record<string, string>) => CredentialPlan;
  /**
   * Der Zugang für den Bereich „DNS" als Text (`lib/dns/access.ts`), bei einem
   * Anbieter, dessen Zugang mehr ist als das eine Feld `apiTokenField`.
   */
  access?: (values: Record<string, string>) => string;
  /**
   * acme.sh wartet nach dem TXT-Eintrag eine feste Zeit (`--dnssleep`), statt
   * öffentliche Resolver zu fragen, ob er sichtbar ist: eine Zone im eigenen
   * Netz sieht dort niemand. Siehe `lib/haproxy/challenge.ts`.
   */
  fixedWait?: boolean;
  /**
   * `build` kann eine Zertifizierungsstelle ablegen (`TRUST_DIR`), der der
   * Container danach vertrauen soll. Nach dem Schreiben läuft `TRUST_SYNC`.
   */
  trust?: boolean;
}

/** Der Ordner von acme.sh: ein Volume, das jede Sicherung mitnimmt. */
const ACME_DIR = '/root/.acme.sh';

/** Der TSIG-Schlüssel für `nsupdate -k`. acme.sh merkt sich den Pfad (`SAVED_NSUPDATE_KEY`). */
export const NSUPDATE_KEY_FILE = `${ACME_DIR}/hapm-nsupdate.key`;

/** Zertifizierungsstellen, denen der Container zusätzlich vertraut, je Datei ein PEM. */
export const TRUST_DIR = `${ACME_DIR}/hapm-trust`;
export const INFOBLOX_CA_FILE = `${TRUST_DIR}/infoblox.pem`;

function rfc2136Input(values: Record<string, string>): Rfc2136Input {
  return {
    server: values.NSUPDATE_SERVER ?? '',
    port: values.NSUPDATE_SERVER_PORT ?? '',
    keyName: values.TSIG_NAME ?? '',
    algorithm: values.TSIG_ALGORITHM ?? '',
    secret: values.TSIG_SECRET ?? '',
  };
}

function infobloxInput(values: Record<string, string>): InfobloxInput {
  return {
    server: values.Infoblox_Server ?? '',
    username: values.Infoblox_User ?? '',
    password: values.Infoblox_Password ?? '',
    view: values.Infoblox_View ?? '',
    wapiVersion: values.Infoblox_WAPI ?? '',
    ca: values.Infoblox_CA ?? '',
  };
}

/**
 * Die Anbieter, die über dieses Formular einzurichten sind.
 *
 * Bewusst kurz. acme.sh kennt über
 * hundert Hooks, und die meisten brauchen andere Felder mit anderen Regeln — ein
 * Formular, das so tut, als wären es überall dieselben zwei Zeilen, erzeugte eine
 * Konfiguration, die nicht funktioniert. Ein weiterer Anbieter ist ein Eintrag
 * hier, kein Umbau.
 *
 * Hook und Variablennamen stehen so da, wie das mitgelieferte acme.sh sie führt
 * (`dnsapi/dns_*.sh`, gelesen über `_readaccountconf_mutable`). Die Schreibweise
 * zählt: `HETZNER_TOKEN` ist nicht `HETZNER_Token`, und ein Token unter dem
 * falschen Namen liest kein Hook.
 *
 * Wer einen Hook braucht, der nicht dasteht, richtet ihn von Hand in
 * `account.conf` ein — die Hook-Erkennung (`parseDnsHooks`) findet ihn trotzdem,
 * weil sie aus `account.conf` ableitet und nicht aus dieser Liste.
 */
export const DNS_PROVIDERS: readonly DnsProvider[] = [
  {
    // Die DNS-Konsole von Hetzner (dns.hetzner.com) ist in die Cloud-Konsole
    // umgezogen. acme.sh bringt dafür `dns_hetznercloud` mit, den früheren Hook
    // `dns_hetzner` gibt es dort nicht mehr.
    hook: 'dns_hetznercloud',
    label: 'Hetzner',
    consoleUrl: 'https://console.hetzner.com/',
    logo: '/providers/hetzner.svg',
    apiTokenField: 'HETZNER_TOKEN',
    fields: [
      {
        name: 'HETZNER_TOKEN',
        label: msgid('API-Token'),
        required: true,
        hint: msgid(
          'Aus der Hetzner-Konsole: im Projekt der Zone unter Sicherheit, API-Tokens. Mit Lese- und Schreibrecht.'
        ),
      },
    ],
    alsoSaved: ['HETZNER_API', 'HETZNER_TTL', 'HETZNER_MAX_ATTEMPTS'],
    note: msgid('Der Token gilt für alle Zonen seines Projekts.'),
  },
  {
    hook: 'dns_cf',
    label: 'Cloudflare',
    consoleUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    logo: '/providers/cloudflare.svg',
    apiTokenField: 'CF_Token',
    fields: [
      {
        name: 'CF_Token',
        label: msgid('API-Token'),
        required: true,
        hint: msgid(
          'Ein Token mit der Berechtigung „Zone · DNS · Bearbeiten" auf den betreffenden Zonen. Nicht der Global API Key.'
        ),
      },
      {
        name: 'CF_Account_ID',
        label: msgid('Account-ID'),
        required: false,
        hint: msgid('Nur nötig, wenn der Token für mehrere Konten gilt. Steht in der Cloudflare-Übersicht rechts.'),
      },
    ],
    note: msgid('Der Token wird für jede Zone in diesem Konto benutzt. Eine neue Domain braucht danach nichts mehr.'),
  },
  {
    /* Ein eigener Nameserver (BIND und andere) über RFC 2136. `dns_nsupdate`
     * ruft `nsupdate -k <Datei>` auf und liest Server, Port und den Pfad der
     * Schlüsseldatei aus `SAVED_NSUPDATE_*`. Name, Verfahren und Geheimnis
     * sind deshalb Felder des Formulars und keine Variablen: aus ihnen
     * entsteht die Datei (`tsigKeyFile`).
     *
     * `NSUPDATE_ZONE` bleibt leer und wird beim Setzen mit herausgenommen:
     * acme.sh kennt je Installation nur eine, und `nsupdate` findet die Zone
     * zu einem Namen selbst, indem es den genannten Nameserver fragt. So gilt
     * ein Schlüssel für jede Zone, die er ändern darf. */
    hook: 'dns_nsupdate',
    label: 'RFC 2136',
    fields: [
      {
        name: 'NSUPDATE_SERVER',
        label: msgid('Primärer Nameserver'),
        required: true,
        kind: 'text',
        placeholder: 'ns1.example.org',
        hint: msgid('Als Name oder IP-Adresse. Nur der primäre Nameserver einer Zone nimmt Änderungen an.'),
      },
      {
        name: 'NSUPDATE_SERVER_PORT',
        label: msgid('Port'),
        required: false,
        kind: 'text',
        placeholder: String(DEFAULT_DNS_PORT),
      },
      {
        name: 'TSIG_NAME',
        label: msgid('Name des TSIG-Schlüssels'),
        required: true,
        kind: 'text',
        placeholder: 'hapm',
        hint: msgid('Wie er in der Konfiguration des Nameservers steht, etwa in key "hapm" { … }.'),
      },
      {
        name: 'TSIG_ALGORITHM',
        label: msgid('Verfahren'),
        required: false,
        kind: 'select',
        options: TSIG_ALGORITHMS,
      },
      {
        name: 'TSIG_SECRET',
        label: msgid('Geheimnis'),
        required: true,
        hint: msgid('Der Wert hinter secret, als Base64. Schlüssel und Geheimnis erzeugt tsig-keygen auf dem Nameserver.'),
      },
    ],
    savedNames: ['NSUPDATE_SERVER', 'NSUPDATE_SERVER_PORT', 'NSUPDATE_KEY', 'NSUPDATE_ZONE', 'NSUPDATE_OPT'],
    files: [NSUPDATE_KEY_FILE],
    note: msgid('BIND und andere Nameserver, die Änderungen mit einem TSIG-Schlüssel annehmen.'),
    fixedWait: true,
    validate: (values) => validateRfc2136(rfc2136Input(values)),
    build: (values) => {
      const access = rfc2136Access(rfc2136Input(values));
      return {
        lines: [
          `SAVED_NSUPDATE_SERVER='${access.server}'`,
          `SAVED_NSUPDATE_SERVER_PORT='${access.port}'`,
          `SAVED_NSUPDATE_KEY='${NSUPDATE_KEY_FILE}'`,
        ],
        files: [{ path: NSUPDATE_KEY_FILE, content: tsigKeyFile(access) }],
      };
    },
    access: (values) => packAccess(rfc2136Access(rfc2136Input(values))),
  },
  {
    /* Infoblox über die WAPI. `dns_infoblox` liest `Infoblox_Creds`
     * (`benutzer:passwort`), `Infoblox_Server` und `Infoblox_View` OHNE
     * `SAVED_` (es benutzt `_saveaccountconf`): die Zeilen stehen deshalb so in
     * `account.conf`. Die Erkennung der Hooks liest nur `SAVED_*`, darum steht
     * der Name der Appliance (kein Geheimnis) zusätzlich als
     * `SAVED_Infoblox_Server` da. `Infoblox_View` wird immer geschrieben: beim
     * Entfernen des TXT-Eintrags setzt der Hook keine Vorgabe ein.
     *
     * Das Zertifikat der Appliance prüft acme.sh über `curl` gegen die
     * Zertifizierungsstellen des Containers. Eine eigene CA wird dort
     * dazugelegt (`trust`), nicht über `CA_BUNDLE`: das gälte auch für den
     * ACME-Server und nähme ihm die öffentlichen Stellen weg. */
    hook: 'dns_infoblox',
    label: 'Infoblox',
    fields: [
      {
        name: 'Infoblox_Server',
        label: msgid('Appliance'),
        required: true,
        kind: 'text',
        placeholder: 'infoblox.example.org',
        hint: msgid('Name des Grid Masters, ohne https://. Das Zertifikat der Appliance muss auf diesen Namen ausgestellt sein.'),
      },
      {
        name: 'Infoblox_User',
        label: msgid('Benutzername'),
        required: true,
        kind: 'text',
        hint: msgid('Ein Konto mit API-Zugang und Schreibrecht auf die Zonen.'),
      },
      { name: 'Infoblox_Password', label: msgid('Passwort'), required: true },
      {
        name: 'Infoblox_View',
        label: msgid('DNS-View'),
        required: false,
        kind: 'text',
        placeholder: DEFAULT_INFOBLOX_VIEW,
      },
      {
        name: 'Infoblox_WAPI',
        label: msgid('WAPI-Fassung'),
        required: false,
        kind: 'text',
        placeholder: DEFAULT_WAPI_VERSION,
        hint: msgid('Nur für die Einträge, die HAPM selbst setzt. acme.sh spricht immer mit 2.2.2.'),
      },
      {
        name: 'Infoblox_CA',
        label: msgid('CA-Zertifikat'),
        required: false,
        kind: 'pem',
        hint: msgid('Nur bei einer eigenen Zertifizierungsstelle: ihr Zertifikat als PEM. HAPM und acme.sh vertrauen ihr dann.'),
      },
    ],
    savedNames: ['Infoblox_Server'],
    alsoSaved: ['Infoblox_Creds', 'Infoblox_View'],
    plainNames: ['Infoblox_Creds', 'Infoblox_Server', 'Infoblox_View'],
    files: [INFOBLOX_CA_FILE],
    note: msgid('Über die WAPI der Appliance, mit einem Benutzer für alle Zonen seiner View.'),
    fixedWait: true,
    trust: true,
    validate: (values) => validateInfoblox(infobloxInput(values)),
    build: (values) => {
      const access = infobloxAccess(infobloxInput(values));
      return {
        lines: [
          `Infoblox_Creds='${access.username}:${access.password}'`,
          `Infoblox_Server='${access.server}'`,
          `Infoblox_View='${access.view}'`,
          `SAVED_Infoblox_Server='${access.server}'`,
        ],
        // Ohne eigene CA liegt keine Datei da, auch keine von einer früheren Eingabe.
        files: [{ path: INFOBLOX_CA_FILE, content: access.ca }],
      };
    },
    access: (values) => packAccess(infobloxAccess(infobloxInput(values))),
  },
];

export function findDnsProvider(hook: string): DnsProvider | null {
  return DNS_PROVIDERS.find((provider) => provider.hook === hook) ?? null;
}

/** Alle Variablennamen, die dieses Modul überhaupt schreibt. */
export function knownCredentialNames(): string[] {
  return DNS_PROVIDERS.flatMap((provider) => provider.fields.map((field) => field.name));
}

/**
 * Welche `SAVED_*`-Zeilen ein Vorgang aus `account.conf` nimmt, bevor er die
 * neuen anhängt.
 *
 * Beim Setzen nur die eigenen Felder: was der Hook daneben führt (bei Hetzner
 * etwa eine von Hand gesetzte TTL), bleibt. Beim Entfernen alles, was zum Hook
 * gehört, siehe `DnsProvider.alsoSaved`.
 */
export function credentialNamesToClear(provider: DnsProvider, remove: boolean): string[] {
  const own = provider.savedNames ?? provider.fields.map((field) => field.name);
  return remove ? [...own, ...(provider.alsoSaved ?? [])] : own;
}

/** Dasselbe für die Zeilen ohne `SAVED_` (`DnsProvider.plainNames`). */
export function plainNamesToClear(provider: DnsProvider): string[] {
  return provider.plainNames ?? [];
}

/**
 * Der Zugang, mit dem der Bereich „DNS" beim selben Anbieter arbeitet: der eine
 * Token, oder die Zugangsdaten als Text. Leer, wenn der Anbieter dort nicht
 * angebunden werden kann.
 */
export function zoneAccess(provider: DnsProvider, values: Record<string, string>): string {
  if (provider.access) return provider.access(values);
  return provider.apiTokenField ? (values[provider.apiTokenField] ?? '') : '';
}

/** Ob der Anbieter mit mehreren Angaben arbeitet statt mit einem Token. */
export function hasCredentialForm(provider: DnsProvider): boolean {
  return provider.access !== undefined;
}

/**
 * Was als Wert durchgeht.
 *
 * acme.sh legt seine Werte als `KEY='wert'` ab, also in einfachen
 * Anführungszeichen. Ein Wert mit einem Apostroph darin bräche die Datei, und
 * eine kaputte `account.conf` nimmt beim nächsten Lauf jede andere Zugangsdatum
 * mit — das ist der Fall, der nicht am Formular scheitern darf, sondern gar nicht
 * erst hineinkommt. Erlaubt ist deshalb, woraus API-Token bestehen, und sonst
 * nichts: keine Anführungszeichen, kein Backslash, kein Dollar, kein Leerraum.
 */
const CREDENTIAL_VALUE = /^[A-Za-z0-9._~+/=:@-]+$/;

/** Der Variablenname, wie acme.sh ihn führt. Nur aus der Allow-Liste, aber die
 *  Form wird trotzdem geprüft: der Name geht in einen regulären Ausdruck im
 *  Kommando, und das ist die Stelle, an der geraten nicht reicht. */
const CREDENTIAL_NAME = /^[A-Za-z0-9_]+$/;

export interface DnsCredentialInput {
  hook: string;
  /** Variablenname → Wert. Leer heißt: dieses Feld nicht setzen. */
  values: Record<string, string>;
  /**
   * Entfernen statt setzen. Dann sind leere Werte kein Fehler, sondern die
   * Absicht.
   *
   * Ein eigenes Feld und nicht „alle Werte leer": das Formular kann den Token
   * nicht anzeigen, dort heißt leer also „unverändert lassen". Die beiden
   * Bedeutungen auseinanderzuhalten ist der ganze Zweck.
   */
  remove: boolean;
}

/**
 * Die Eingabe prüfen. Gibt die Meldung zurück, die der Benutzer lesen soll,
 * oder `null` — wie `validateCreateInput`, und aus demselben Grund: dieselbe
 * Funktion läuft im Formular und in der Route.
 */
export function validateDnsCredentials(input: DnsCredentialInput): Message | null {
  const provider = findDnsProvider(input.hook);
  if (!provider) return msg('Unbekannter DNS-Anbieter.');

  for (const [name, value] of Object.entries(input.values)) {
    if (!provider.fields.some((field) => field.name === name)) {
      return msg('Das Feld {name} gehört nicht zu {provider}.', { name, provider: provider.label });
    }
    // Ein Anbieter mit eigener Prüfung kennt je Feld seine Regel (unten).
    if (!value || provider.validate) continue;
    if (!CREDENTIAL_VALUE.test(value)) {
      return msg(
        'Der Wert für {name} enthält ein Zeichen, das acme.sh nicht ablegen kann. Erlaubt sind Buchstaben, Ziffern und . _ ~ + / = : @ -',
        { name }
      );
    }
  }

  if (input.remove) return null;

  if (provider.validate) return provider.validate(input.values);

  for (const field of provider.fields) {
    if (field.required && !input.values[field.name]) {
      // Das Pflichtfeld aller Anbieter ist der Token, und er hat einen eigenen
      // Satz: eine eingesetzte Beschriftung bliebe im Englischen deutsch.
      return field.label === 'API-Token'
        ? msg('API-Token wird benötigt.')
        : msg('{field} wird benötigt.', { field: field.label });
    }
  }

  return null;
}

/**
 * Die Zeilen, wie sie in `account.conf` stehen.
 *
 * `SAVED_` davor, weil acme.sh sie so führt: die dnsapi-Hooks lesen ihre
 * Variable über `_readaccountconf_mutable`, und das schlägt unter genau diesem
 * Präfix nach. Ohne das stünde der Token in der Datei und würde nie benutzt.
 */
export function credentialLines(input: DnsCredentialInput): string[] {
  const provider = findDnsProvider(input.hook);
  if (!provider) return [];
  if (provider.build) return input.remove ? [] : provider.build(input.values).lines;
  return provider.fields
    .filter((field) => input.values[field.name])
    .map((field) => `SAVED_${field.name}='${input.values[field.name]}'`);
}

/**
 * Die Dateien, die neben `account.conf` zu diesem Vorgang gehören: beim Setzen,
 * was `build` nennt, beim Entfernen jede Datei des Anbieters mit `content: null`.
 */
export function credentialFiles(input: DnsCredentialInput): CredentialFile[] {
  const provider = findDnsProvider(input.hook);
  if (!provider) return [];
  if (input.remove) return (provider.files ?? []).map((path) => ({ path, content: null }));
  return provider.build ? provider.build(input.values).files : [];
}

/** Nur Dateien im Ordner von acme.sh, höchstens einen Ordner tief, ohne Leerraum und ohne `..`. */
const CREDENTIAL_FILE = /^\/root\/\.acme\.sh\/[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)?$/;

function assertCredentialFile(path: string): void {
  if (!CREDENTIAL_FILE.test(path)) throw new Error(`Ungültiger Pfad für Zugangsdaten: ${path}`);
}

/**
 * Das Kommando, das eine Datei mit Zugangsdaten ablegt. Der Inhalt kommt über
 * stdin (`withStdin`), nie als Argument. Geschrieben wird unter `umask 077`
 * neben das Ziel und dann umbenannt: die Datei ist von Anfang an nur für root
 * lesbar und nie halb geschrieben, während acme.sh sie liest.
 */
export function writeCredentialFileCommand(path: string): string {
  assertCredentialFile(path);
  return [
    'set -e',
    'umask 077',
    `file=${shellQuote(path)}`,
    'mkdir -p "$(dirname "$file")"',
    'cat > "$file.hapm-new"',
    'mv -f "$file.hapm-new" "$file"',
  ].join('\n');
}

export function removeCredentialFileCommand(path: string): string {
  assertCredentialFile(path);
  return `rm -f ${shellQuote(path)}`;
}

/**
 * Die Zertifizierungsstellen aus `TRUST_DIR` in den Bestand des Containers
 * legen, dem `curl` (und damit acme.sh) vertraut, und was dort von HAPM liegt
 * und keine Datei mehr hat, wieder herausnehmen.
 *
 * Läuft nach dem Schreiben der Zugangsdaten und bei jedem Start von HAPM
 * (`lib/bootstrap.ts`): der Bestand gehört zum Container, und ein neuer
 * Container (nach einem Update) kennt die eigene CA sonst nicht mehr. Die
 * Quelle liegt im Volume von acme.sh.
 *
 * Ohne `update-ca-certificates` (kein Debian, `pnpm dev`) geschieht nichts.
 * Ohne Dateien und ohne frühere Kopien auch nicht: der Start kostet dann nichts.
 */
export const TRUST_SYNC = [
  `src=${TRUST_DIR}; dst=/usr/local/share/ca-certificates`,
  'command -v update-ca-certificates >/dev/null 2>&1 || exit 0',
  '[ -d "$dst" ] || exit 0',
  'have=$(ls "$src"/*.pem 2>/dev/null | wc -l); had=$(ls "$dst"/hapm-trust-*.crt 2>/dev/null | wc -l)',
  '[ "$have" -gt 0 ] || [ "$had" -gt 0 ] || exit 0',
  'rm -f "$dst"/hapm-trust-*.crt',
  'for f in "$src"/*.pem; do [ -f "$f" ] || continue; cp "$f" "$dst/hapm-trust-$(basename "$f" .pem).crt"; done',
  'update-ca-certificates >/dev/null 2>&1',
].join('\n');

const ACCOUNT_CONF = '/root/.acme.sh/account.conf';

/**
 * Das Kommando, das die Zeilen in `account.conf` einsetzt.
 *
 * Drei Dinge daran sind nicht optional:
 *
 * **Der Wert geht über stdin, nie als Argument.** Ein `sed -i "s/…/$token/"`
 * stünde in `ps`, für jeden Benutzer sichtbar. Der Weg dafür ist `withStdin`
 * aus `lib/shell.ts`.
 *
 * **Gelesen und geschrieben wird in einem Kommando.** Die Alternative wäre,
 * die Datei zu lesen, im Prozess zu ändern und zurückzuschreiben — dazwischen
 * lägen zwei Kommandos, und in der Zeit schreibt acme.sh beim täglichen
 * Erneuern in dieselbe Datei. So ist das Fenster ein Prozess lang.
 *
 * **`cat >` und nicht `mv`.** Der Zielinode bleibt derselbe, also Besitzer,
 * Rechte und Kontext — dieselbe Überlegung wie beim `cp` auf `haproxy.cfg`.
 * `account.conf` steht auf 600, und ein `mv` einer frisch angelegten Datei
 * darüber machte daraus 644 mit einem API-Token darin.
 *
 * Die Zwischendatei liegt neben dem Ziel und nicht in `/tmp`: `/root/.acme.sh`
 * gehört root, ein vorhersagbarer Name dort ist kein Angriffsweg. In `/tmp` wäre
 * derselbe Name einer — und darin stünde der Token.
 *
 * Zurückgegeben wird das Skript, nicht der fertige Aufruf: der Aufrufer hängt es
 * über `withStdin(['sh', '-c', script], zeilen)` an seinen Heredoc. Damit steht
 * das Skript in argv und der Token in stdin, und genau so soll es sein.
 */
export function writeCredentialsCommand(names: string[], plainNames: string[] = []): string {
  for (const name of [...names, ...plainNames]) {
    if (!CREDENTIAL_NAME.test(name)) {
      throw new Error(`writeCredentialsCommand: ungültiger Variablenname ${name}`);
    }
  }
  if (names.length === 0 && plainNames.length === 0) {
    throw new Error('writeCredentialsCommand: keine Variable genannt');
  }

  // Die Namen kommen aus der Allow-Liste und sind auf `[A-Za-z0-9_]` geprüft —
  // in einem regulären Ausdruck ist daran nichts zu escapen. `plainNames` sind
  // die Variablen, die ein Hook ohne `SAVED_` führt (`DnsProvider.plainNames`).
  const saved = names.length > 0 ? `SAVED_(${names.join('|')})` : '';
  const plain = plainNames.length > 0 ? `(${plainNames.join('|')})` : '';
  const pattern = `^(${[saved, plain].filter(Boolean).join('|')})=`;

  return [
    'set -e',
    `conf=${ACCOUNT_CONF}`,
    'tmp="$conf.hapm-new"',
    // Ohne account.conf ist acme.sh nicht eingerichtet. Die Datei anzulegen wäre
    // eine halbe Installation: acme.sh richtet `lib/acme.ts` ein, nicht dieses Kommando.
    'test -f "$conf" || { echo "account.conf fehlt" >&2; exit 3; }',
    'umask 077',
    /* `grep -v` meldet 1, wenn KEINE Zeile übrig bleibt — bei einer Datei, die
     * nur aus den herausgefilterten Zeilen besteht, ist das der Normalfall und
     * kein Fehler. Unter `set -e` bräche der Vorgang dort ab; ein blindes
     * `|| true` verschluckte dafür den echten Fehler (2), und dann stünde eine
     * leere `account.conf` da, also jede andere Zugangsdatum weg. Deshalb wird
     * der Code angesehen statt weggeworfen. */
    'set +e',
    `grep -vE ${shellQuote(pattern)} "$conf" > "$tmp"`,
    'rc=$?',
    'set -e',
    '[ "$rc" -le 1 ] || { echo "account.conf ist nicht lesbar" >&2; exit 4; }',
    // stdin: die neuen Zeilen. Leerer stdin heißt entfernen — dann bleibt es
    // beim Herausfiltern oben.
    'cat >> "$tmp"',
    'cat "$tmp" > "$conf"',
    'rm -f "$tmp"',
  ].join('\n');
}

/** Nur für das Muster im Kommando. `lib/shell.ts` zu importieren hieße, diese
 *  Datei an eine zu hängen, die das Formular nicht laden soll — sie ist rein,
 *  damit Route und Dialog dieselbe Prüfung benutzen. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
