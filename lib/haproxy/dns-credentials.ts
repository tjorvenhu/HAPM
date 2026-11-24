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
 * Rein (nur `lib/i18n` für die Meldungen), damit
 * `tests/haproxy/dns-credentials.test.ts` das erzeugte Kommando gegen eine
 * echte Bash laufen lassen kann.
 *
 * `label`, `hint` und `note` sind deutsche Schlüssel (`msgid`), die Seite
 * übersetzt sie beim Zeigen. `label` des Anbieters ist ein Eigenname.
 */

import { msg, msgid, type Message } from '../i18n/translate';

export interface DnsCredentialField {
  /** Der Name der Variablen, wie acme.sh sie liest — ohne `SAVED_`. */
  name: string;
  label: string;
  /** Ob ohne dieses Feld gar nicht gespeichert wird. */
  required: boolean;
  /** Ein Satz zu dem, was man sonst falsch macht. */
  hint?: string;
}

export interface DnsProvider {
  /** Der acme.sh-Hook, der mit diesen Variablen arbeitet. */
  hook: string;
  label: string;
  /** Wo der Betreiber den Token herbekommt. Spart jedes Mal eine Suche. */
  consoleUrl: string;
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
  const own = provider.fields.map((field) => field.name);
  return remove ? [...own, ...(provider.alsoSaved ?? [])] : own;
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
    if (!value) continue;
    if (!CREDENTIAL_VALUE.test(value)) {
      return msg(
        'Der Wert für {name} enthält ein Zeichen, das acme.sh nicht ablegen kann. Erlaubt sind Buchstaben, Ziffern und . _ ~ + / = : @ -',
        { name }
      );
    }
  }

  if (input.remove) return null;

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
  return provider.fields
    .filter((field) => input.values[field.name])
    .map((field) => `SAVED_${field.name}='${input.values[field.name]}'`);
}

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
export function writeCredentialsCommand(names: string[]): string {
  for (const name of names) {
    if (!CREDENTIAL_NAME.test(name)) {
      throw new Error(`writeCredentialsCommand: ungültiger Variablenname ${name}`);
    }
  }

  // Die Namen kommen aus der Allow-Liste und sind auf `[A-Za-z0-9_]` geprüft —
  // in einem regulären Ausdruck ist daran nichts zu escapen.
  const pattern = `^SAVED_(${names.join('|')})=`;

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
