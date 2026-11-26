/**
 * Der Zugang zu einem Anbieter, der mehr braucht als einen Token: RFC 2136
 * (Nameserver und TSIG-Schlüssel) und Infoblox (Appliance, Konto, View).
 *
 * Für `lib/dns` bleibt der Zugang ein Text, wie der Token von Cloudflare und
 * Hetzner: `connect.ts` und `store.ts` verschlüsseln und entschlüsseln ihn,
 * ohne hineinzusehen. Hier steht, was in dem Text steht (JSON) und was als
 * Eingabe durchgeht.
 *
 * ── Warum die Prüfung so eng ist ──
 *
 * Dieselben Werte gehen an acme.sh (`lib/haproxy/dns-credentials.ts`), und das
 * legt sie als `KEY='wert'` in `account.conf` ab und liest die Datei als
 * Shell-Skript. Ein Apostroph oder ein Zeilenumbruch darin nähme beim nächsten
 * Lauf jede andere Zugangsdatum mit. Der Nameserver steht zudem in einem
 * Heredoc für `nsupdate`, der Name der Appliance in einer URL für `curl`.
 * Erlaubt ist deshalb je Feld nur, woraus ein solcher Wert besteht.
 *
 * Rein (nur `lib/i18n`): das Formular im Browser und die Route prüfen mit
 * derselben Funktion.
 */

import { msg, type Message } from '../i18n/translate';

/**
 * Die TSIG-Verfahren, die HAPM anbietet. HMAC-MD5 und HMAC-SHA1 fehlen mit
 * Absicht: RFC 8945 führt beide nur noch aus Rücksicht auf alte Installationen.
 */
export const TSIG_ALGORITHMS = ['hmac-sha256', 'hmac-sha384', 'hmac-sha512'] as const;
export type TsigAlgorithm = (typeof TSIG_ALGORITHMS)[number];
export const DEFAULT_TSIG_ALGORITHM: TsigAlgorithm = 'hmac-sha256';

export function isTsigAlgorithm(value: unknown): value is TsigAlgorithm {
  return (TSIG_ALGORITHMS as readonly unknown[]).includes(value);
}

export const DEFAULT_DNS_PORT = 53;
export const DEFAULT_INFOBLOX_VIEW = 'default';

/**
 * Die Fassung der WAPI, mit der HAPM die Appliance anspricht, wenn keine
 * genannt ist. Dieselbe, die der acme.sh-Hook `dns_infoblox` fest benutzt:
 * eine Appliance, an der der Hook arbeitet, kennt sie.
 */
export const DEFAULT_WAPI_VERSION = '2.2.2';

export interface Rfc2136Access {
  server: string;
  port: number;
  keyName: string;
  algorithm: TsigAlgorithm;
  /** Base64, wie `tsig-keygen` es ausgibt. */
  secret: string;
}

export interface InfobloxAccess {
  /** Name oder Adresse der Appliance, wahlweise mit Port. */
  server: string;
  username: string;
  password: string;
  view: string;
  wapiVersion: string;
  /** PEM. `null`: es gelten die Zertifizierungsstellen, denen Node vertraut. */
  ca: string | null;
}

/* ── RFC 2136 ── */

/** Ein Rechnername, eine IPv4- oder eine IPv6-Adresse. */
const HOST = /^(?=.{1,253}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const IPV6 = /^(?=.{2,45}$)[0-9A-Fa-f:]+(\.\d{1,3}){0,3}$/;
const KEY_NAME = /^(?=.{1,253}$)[A-Za-z0-9_]([A-Za-z0-9._-]*[A-Za-z0-9_])?$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface Rfc2136Input {
  server: string;
  /** Leer heißt 53. */
  port: string;
  keyName: string;
  /** Leer heißt HMAC-SHA256. */
  algorithm: string;
  secret: string;
}

function portOf(value: string, fallback: number): number | null {
  const text = value.trim();
  if (text === '') return fallback;
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

/** Wie viele Bytes ein Base64-Text ergibt, ohne ihn zu entschlüsseln. */
function base64Length(value: string): number {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

export function validateRfc2136(input: Rfc2136Input): Message | null {
  const server = input.server.trim();
  if (!server) return msg('Bitte den Nameserver angeben.');
  if (!HOST.test(server) && !(server.includes(':') && IPV6.test(server))) {
    return msg('Der Nameserver ist ein Rechnername oder eine IP-Adresse, ohne Port und ohne Leerzeichen.');
  }
  if (portOf(input.port, DEFAULT_DNS_PORT) === null) {
    return msg('Der Port des Nameservers ist eine Zahl zwischen 1 und 65535.');
  }
  const keyName = input.keyName.trim();
  if (!keyName) return msg('Bitte den Namen des TSIG-Schlüssels angeben.');
  if (!KEY_NAME.test(keyName)) {
    return msg('Der Name des TSIG-Schlüssels besteht aus Buchstaben, Ziffern und . _ -');
  }
  const algorithm = input.algorithm.trim();
  if (algorithm !== '' && !isTsigAlgorithm(algorithm)) {
    return msg('Das Verfahren ist {algorithms}.', { algorithms: TSIG_ALGORITHMS.join(', ') });
  }
  const secret = input.secret.trim();
  if (!secret) return msg('Bitte das Geheimnis des TSIG-Schlüssels angeben.');
  if (!BASE64.test(secret) || secret.length % 4 !== 0) {
    return msg('Das Geheimnis ist Base64-Text, wie tsig-keygen ihn ausgibt.');
  }
  if (base64Length(secret) < 16) return msg('Das Geheimnis ist zu kurz: es braucht mindestens 16 Bytes.');
  if (secret.length > 200) return msg('Das Geheimnis ist zu lang.');
  return null;
}

/** Erwartet eine geprüfte Eingabe (`validateRfc2136`). */
export function rfc2136Access(input: Rfc2136Input): Rfc2136Access {
  const algorithm = input.algorithm.trim();
  return {
    server: input.server.trim().toLowerCase(),
    port: portOf(input.port, DEFAULT_DNS_PORT) ?? DEFAULT_DNS_PORT,
    keyName: input.keyName.trim().toLowerCase().replace(/\.$/, ''),
    algorithm: isTsigAlgorithm(algorithm) ? algorithm : DEFAULT_TSIG_ALGORITHM,
    secret: input.secret.trim(),
  };
}

/**
 * Die Schlüsseldatei, wie `nsupdate -k` sie liest (Form von `tsig-keygen`).
 * Name und Geheimnis sind geprüft: kein Anführungszeichen, kein Zeilenumbruch.
 */
export function tsigKeyFile(access: Pick<Rfc2136Access, 'keyName' | 'algorithm' | 'secret'>): string {
  return `key "${access.keyName}" {\n\talgorithm ${access.algorithm};\n\tsecret "${access.secret}";\n};\n`;
}

/* ── Infoblox ── */

const INFOBLOX_SERVER = /^(?=.{1,260}$)[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$/;
const INFOBLOX_USER = /^[A-Za-z0-9._@-]{1,64}$/;
/** Druckbares ASCII ohne Leerzeichen, Apostroph und Backslash. */
const INFOBLOX_PASSWORD = /^[\x21-\x26\x28-\x5B\x5D-\x7E]{1,128}$/;
const INFOBLOX_VIEW = /^[A-Za-z0-9._-]([A-Za-z0-9._ -]{0,62}[A-Za-z0-9._-])?$/;
const WAPI_VERSION = /^\d{1,2}(\.\d{1,2}){1,2}$/;

/** So groß wird keine Kette von Zertifizierungsstellen. */
const MAX_PEM = 64 * 1024;
const PEM_BLOCK = /-----BEGIN CERTIFICATE-----[A-Za-z0-9+/=\s]+?-----END CERTIFICATE-----/g;

export interface InfobloxInput {
  server: string;
  username: string;
  password: string;
  /** Leer heißt `default`. */
  view: string;
  /** Leer heißt `DEFAULT_WAPI_VERSION`. */
  wapiVersion: string;
  /** PEM oder leer. */
  ca: string;
}

/**
 * Die Zertifikate aus einem eingefügten Text, einheitlich umbrochen. `null`,
 * wenn außer Zertifikaten etwas darin steht (ein privater Schlüssel etwa) oder
 * gar keins.
 */
export function normalizePem(value: string): string | null {
  const text = value.replace(/\r\n?/g, '\n').trim();
  if (text === '' || text.length > MAX_PEM) return null;
  const blocks = text.match(PEM_BLOCK);
  if (!blocks) return null;
  if (text.replace(PEM_BLOCK, '').trim() !== '') return null;
  return `${blocks.map((block) => block.trim()).join('\n')}\n`;
}

export function validateInfoblox(input: InfobloxInput): Message | null {
  const server = input.server.trim();
  if (!server) return msg('Bitte die Adresse der Infoblox-Appliance angeben.');
  if (!INFOBLOX_SERVER.test(server)) {
    return msg('Die Adresse der Appliance ist ein Rechnername oder eine IPv4-Adresse, ohne https:// und ohne Pfad.');
  }
  const port = /:(\d+)$/.exec(server);
  if (port && (Number(port[1]) < 1 || Number(port[1]) > 65535)) {
    return msg('Der Port der Appliance ist eine Zahl zwischen 1 und 65535.');
  }
  const username = input.username.trim();
  if (!username) return msg('Bitte den Benutzer der Appliance angeben.');
  if (!INFOBLOX_USER.test(username)) {
    return msg('Der Benutzer besteht aus Buchstaben, Ziffern und . _ @ -');
  }
  if (!input.password) return msg('Bitte das Passwort des Benutzers angeben.');
  if (!INFOBLOX_PASSWORD.test(input.password)) {
    return msg(
      'Das Passwort enthält ein Zeichen, das acme.sh nicht ablegen kann. Erlaubt sind Buchstaben, Ziffern und Sonderzeichen ohne Leerzeichen, Apostroph, Backslash und Umlaute.'
    );
  }
  const view = input.view.trim();
  if (view !== '' && !INFOBLOX_VIEW.test(view)) {
    return msg('Die DNS-View besteht aus Buchstaben, Ziffern, Leerzeichen und . _ -');
  }
  const version = input.wapiVersion.trim().replace(/^v/i, '');
  if (version !== '' && !WAPI_VERSION.test(version)) {
    return msg('Die Fassung der WAPI hat die Form 2.2.2.');
  }
  if (input.ca.trim() !== '' && normalizePem(input.ca) === null) {
    return msg('Das CA-Zertifikat ist kein PEM: erwartet werden ein oder mehrere Blöcke BEGIN CERTIFICATE.');
  }
  return null;
}

/** Erwartet eine geprüfte Eingabe (`validateInfoblox`). */
export function infobloxAccess(input: InfobloxInput): InfobloxAccess {
  return {
    server: input.server.trim().toLowerCase(),
    username: input.username.trim(),
    password: input.password,
    view: input.view.trim() || DEFAULT_INFOBLOX_VIEW,
    wapiVersion: input.wapiVersion.trim().replace(/^v/i, '') || DEFAULT_WAPI_VERSION,
    ca: input.ca.trim() === '' ? null : normalizePem(input.ca),
  };
}

/* ── Der Zugang als Text ── */

export function packAccess(access: Rfc2136Access | InfobloxAccess): string {
  return JSON.stringify(access);
}

function unpack(token: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(token);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** Der gespeicherte Zugang, noch einmal geprüft. `null`, wenn er keiner ist. */
export function readRfc2136Access(token: string): Rfc2136Access | null {
  const raw = unpack(token);
  if (!raw) return null;
  const input: Rfc2136Input = {
    server: text(raw.server),
    port: typeof raw.port === 'number' ? String(raw.port) : text(raw.port),
    keyName: text(raw.keyName),
    algorithm: text(raw.algorithm),
    secret: text(raw.secret),
  };
  return validateRfc2136(input) ? null : rfc2136Access(input);
}

export function readInfobloxAccess(token: string): InfobloxAccess | null {
  const raw = unpack(token);
  if (!raw) return null;
  const input: InfobloxInput = {
    server: text(raw.server),
    username: text(raw.username),
    password: text(raw.password),
    view: text(raw.view),
    wapiVersion: text(raw.wapiVersion),
    ca: text(raw.ca),
  };
  return validateInfoblox(input) ? null : infobloxAccess(input);
}
