/**
 * Was ein DNS-Eintrag ist und was als Eingabe durchgeht.
 *
 * Ohne Importe (bis auf einen Typ), wie `zones.ts`: der Dialog prüft mit
 * derselben Funktion wie die Route. Zwei Regelwerke wären ein Formular, das
 * etwas annimmt, das der Anbieter danach mit einer englischen Fehlermeldung
 * ablehnt.
 *
 * ── Was je Anbieter anders ist ──
 *
 * Steht in `PROVIDER_RULES` und sonst nirgends: ob es einen Proxy gibt, was
 * „keine eigene TTL" heißt und wo ihre Grenzen liegen. Prüfung, Formular und
 * Tabelle fragen dort, statt den Anbieter beim Namen zu kennen.
 *
 * ── Warum die Liste der Arten kurz ist ──
 *
 * `EDITABLE_TYPES` ist eine Allow-Liste, aus demselben Grund wie die
 * DNS-Anbieter in `haproxy/`: die Art
 * bestimmt, welche Felder mitgeschickt werden, und was nicht in der Liste steht,
 * hat Felder, die dieses Formular gar nicht kennt (SRV trägt Priorität, Gewicht
 * und Port in einem `data`-Objekt, CAA Flag und Tag).
 *
 * **Was nicht darin steht, wird angezeigt und nicht angefasst** — dieselbe Regel
 * wie bei einem HAProxy-Eintrag, der nicht dem Namensschema folgt. Ein Werkzeug,
 * das einen SRV-Eintrag beim Speichern auf seine drei bekannten Felder
 * zusammenstreicht, ist schlimmer als eines, das ihn nur zeigt.
 */

import type { DnsProviderId } from './zones';

export const EDITABLE_TYPES = ['A', 'AAAA', 'CNAME', 'TXT', 'MX', 'NS'] as const;
export type EditableRecordType = (typeof EDITABLE_TYPES)[number];

/** Nur diese drei kann Cloudflare über seine Server schicken. */
export const PROXYABLE_TYPES: readonly string[] = ['A', 'AAAA', 'CNAME'];

/** Cloudflare: 1 heißt „automatisch", sonst mindestens 60 Sekunden. */
export const TTL_AUTO = 1;

export interface ProviderRules {
  /** Ob der Anbieter Verkehr über eigene Server leiten kann. Nur Cloudflare. */
  proxy: boolean;
  /**
   * Was „keine eigene TTL" heißt. Cloudflare: 1, der Anbieter entscheidet.
   * Hetzner: `null`, es gilt die Vorgabe der Zone.
   */
  defaultTtl: number | null;
  ttlMin: number;
  ttlMax: number;
  /**
   * Die TTL gehört dem Namen samt Art und nicht dem einzelnen Wert. Bei Hetzner
   * teilen sich zwei A-Einträge desselben Namens eine TTL (ein RRSet).
   */
  ttlPerName: boolean;
}

export const PROVIDER_RULES: Record<DnsProviderId, ProviderRules> = {
  cloudflare: { proxy: true, defaultTtl: TTL_AUTO, ttlMin: 60, ttlMax: 86400, ttlPerName: false },
  hetzner: { proxy: false, defaultTtl: null, ttlMin: 60, ttlMax: 2147483647, ttlPerName: true },
};

/** Ein Eintrag, wie die Oberfläche ihn führt, bei jedem Anbieter gleich. */
export interface DnsRecord {
  /**
   * Die Kennung beim Anbieter. Bei Cloudflare seine eigene, bei Hetzner aus
   * Name, Art und Wert gebildet (`hetzner-rrsets.ts`): dort gibt es keine.
   */
  id: string;
  type: string;
  /** Der volle Name. */
  name: string;
  content: string;
  /** `null`: keine eigene TTL, es gilt die Vorgabe der Zone (Hetzner). */
  ttl: number | null;
  /** Nur bei Cloudflare je wahr. */
  proxied: boolean;
  priority: number | null;
  comment: string | null;
  /** Vom Anbieter gepflegt oder dort geschützt (z. B. der SOA): nicht änderbar. */
  locked: boolean;
}

/** Was aus dem Formular kommt. `name` ist relativ zur Zone, `@` ist die Zone. */
export interface RecordInput {
  type: EditableRecordType;
  name: string;
  content: string;
  ttl: number | null;
  proxied: boolean;
  priority: number | null;
  comment: string | null;
}

export function isEditableType(type: string): type is EditableRecordType {
  return (EDITABLE_TYPES as readonly string[]).includes(type);
}

/** Ob dieser Eintrag über die Oberfläche geändert werden darf. */
export function isEditableRecord(record: Pick<DnsRecord, 'type' | 'locked'>): boolean {
  return !record.locked && isEditableType(record.type);
}

const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
/** Grob und mit Absicht: die genaue Form prüft der Anbieter, hier geht es um Tippfehler. */
const IPV6 = /^[0-9a-f:]+$/i;
/** Ein Hostname als Ziel. Der Unterstrich ist erlaubt: `_acme-challenge` gibt es wirklich. */
const HOSTNAME = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*\.?$/i;
/** Ein Eintragsname innerhalb der Zone. `@` ist die Zone, `*` die Wildcard. */
const RECORD_NAME = /^(@|\*|(\*\.)?[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?(\.[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?)*)$/i;

/**
 * Prüft eine Eingabe. Zurück kommt die Meldung oder `null`.
 *
 * Deutsch und mit dem Grund daneben, wo es einen gibt: „Ungültig" schickt jemanden
 * in die Suche, „Ein CNAME zeigt auf einen Namen, nicht auf eine IP" nicht.
 */
export function validateRecordInput(
  input: RecordInput,
  zoneName: string,
  provider: DnsProviderId = 'cloudflare'
): string | null {
  const rules = PROVIDER_RULES[provider];
  if (!isEditableType(input.type)) {
    return `Einträge vom Typ ${input.type} lassen sich hier nicht anlegen.`;
  }

  const name = input.name.trim().toLowerCase();
  if (name === '') return 'Bitte einen Namen angeben. `@` steht für die Domain selbst.';
  if (!RECORD_NAME.test(name)) {
    return 'Der Name enthält Zeichen, die in keinem DNS-Namen vorkommen.';
  }
  if (name.length > 253) return 'Der Name ist zu lang.';

  const content = input.content.trim();
  if (content === '') return 'Bitte einen Wert angeben.';

  switch (input.type) {
    case 'A':
      if (!IPV4.test(content)) return 'Ein A-Eintrag zeigt auf eine IPv4-Adresse, z. B. 203.0.113.10.';
      break;
    case 'AAAA':
      if (!IPV6.test(content) || !content.includes(':')) {
        return 'Ein AAAA-Eintrag zeigt auf eine IPv6-Adresse, z. B. 2001:db8::1.';
      }
      break;
    case 'CNAME':
    case 'NS':
    case 'MX': {
      if (IPV4.test(content)) {
        return `Ein ${input.type}-Eintrag zeigt auf einen Namen, nicht auf eine IP-Adresse.`;
      }
      if (!HOSTNAME.test(content)) return 'Das ist kein gültiger Hostname.';
      break;
    }
    case 'TXT':
      if (content.length > 2048) return 'Der Text ist länger, als ein TXT-Eintrag fassen kann.';
      break;
  }

  // Ein CNAME auf der Zone selbst verdeckt deren NS- und MX-Einträge; Cloudflare
  // baut daraus stillschweigend einen „CNAME flattening"-Fall. Das ist eine
  // Entscheidung, die niemand nebenbei im Dialog treffen sollte.
  if (input.type === 'CNAME' && (name === '@' || name === zoneName.toLowerCase())) {
    return 'Ein CNAME auf der Domain selbst verdeckt ihre NS- und MX-Einträge. Dort gehört ein A-Eintrag hin.';
  }

  if (input.ttl !== rules.defaultTtl) {
    const ttl = input.ttl;
    if (ttl === null || !Number.isInteger(ttl) || ttl < rules.ttlMin || ttl > rules.ttlMax) {
      return (
        `Die TTL liegt zwischen ${rules.ttlMin} und ${rules.ttlMax} Sekunden ` +
        (rules.defaultTtl === null ? 'oder folgt der Vorgabe der Zone.' : 'oder auf „automatisch".')
      );
    }
  }

  if (input.type === 'MX') {
    if (input.priority === null) return 'Ein MX-Eintrag braucht eine Priorität.';
    if (!Number.isInteger(input.priority) || input.priority < 0 || input.priority > 65535) {
      return 'Die Priorität ist eine ganze Zahl zwischen 0 und 65535.';
    }
  }

  if (input.proxied && !rules.proxy) {
    return 'Über die Server des Anbieters leiten lässt sich ein Eintrag nur bei Cloudflare.';
  }
  if (input.proxied && !PROXYABLE_TYPES.includes(input.type)) {
    return `Einträge vom Typ ${input.type} kann Cloudflare nicht über seine Server schicken.`;
  }

  if (input.comment && input.comment.length > 100) {
    return 'Die Notiz fasst 100 Zeichen.';
  }

  return null;
}

/**
 * Was aus einem Formular oder einem Request-Rumpf an Eingabe herauskommt.
 *
 * Dieselbe Funktion für beide Seiten, aus demselben Grund wie
 * `readServiceInput` beim Reverse-Proxy: der Dialog prüft, was er schickt, und
 * die Route prüft, was sie bekommt — mit einem zweiten Leser wären das zwei
 * Normalisierungen, die sich in genau einem Randfall unterscheiden.
 */
export function readRecordInput(
  raw: Record<string, unknown>,
  provider: DnsProviderId = 'cloudflare'
): RecordInput {
  const rules = PROVIDER_RULES[provider];
  const type = String(raw.type ?? '').toUpperCase();
  const priority = Number(raw.priority);
  const ownTtl = raw.ttl !== null && raw.ttl !== undefined && raw.ttl !== '' && Number.isFinite(Number(raw.ttl));
  return {
    // Unbekannte Art bleibt stehen und wird nicht auf `A` zurechtgebogen:
    // `validateRecordInput` soll sie mit ihrem Namen ablehnen können.
    type: type as EditableRecordType,
    name: String(raw.name ?? '').trim().toLowerCase(),
    content: String(raw.content ?? '').trim(),
    ttl: ownTtl ? Number(raw.ttl) : rules.defaultTtl,
    // Ein `proxied` an einem TXT-Eintrag ist keine Einstellung, sondern ein
    // Fehler — hier fällt es weg, statt später von Cloudflare abgelehnt zu werden.
    proxied: rules.proxy && raw.proxied === true && PROXYABLE_TYPES.includes(type),
    priority: type === 'MX' && Number.isFinite(priority) ? priority : null,
    comment: String(raw.comment ?? '').trim() || null,
  };
}

/** Eine IPv6-Adresse in ihren acht Gruppen ohne führende Nullen, oder `null`. */
function ipv6Groups(address: string): string | null {
  let value = address;
  const mapped = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(value);
  if (mapped) {
    const [, head, a, b, c, d] = mapped;
    const high = ((Number(a) << 8) | Number(b)).toString(16);
    const low = ((Number(c) << 8) | Number(d)).toString(16);
    value = `${head}${high}:${low}`;
  }
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves[1] ? halves[1].split(':') : [];
  const gap = 8 - head.length - tail.length;
  if (halves.length === 1 ? gap !== 0 : gap < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? gap : 0).fill('0'), ...tail];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.map((group) => parseInt(group, 16).toString(16)).join(':');
}

/**
 * Ob zwei Schreibweisen dieselbe Adresse meinen.
 *
 * `2001:db8::1` und `2001:0db8:0:0:0:0:0:1` sind dieselbe, und ein Anbieter
 * gibt nicht unbedingt die Form zurück, in der geschrieben wurde. Ohne diesen
 * Vergleich sähe ein Eintrag, der längst stimmt, bei jedem Lauf wie ein
 * falscher aus.
 */
export function sameAddress(a: string, b: string): boolean {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  if (left === right) return true;
  const groups = ipv6Groups(left);
  return groups !== null && groups === ipv6Groups(right);
}

/**
 * Die TTL als Text. `1` ist bei Cloudflare „automatisch" und keine Sekunde,
 * `null` bei Hetzner die Vorgabe der Zone.
 */
export function formatTtl(ttl: number | null): string {
  if (ttl === null) return 'Vorgabe';
  if (ttl === TTL_AUTO) return 'auto';
  if (ttl % 86400 === 0) return ttl === 86400 ? '1 Tag' : `${ttl / 86400} Tage`;
  if (ttl % 3600 === 0) return `${ttl / 3600} h`;
  if (ttl % 60 === 0) return `${ttl / 60} min`;
  return `${ttl} s`;
}
