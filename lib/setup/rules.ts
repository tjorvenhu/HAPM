/**
 * Die Regeln des Assistenten der Einrichtung, ohne Datenbank und ohne Netz.
 *
 * Der Assistent fragt nach dem ersten Konto fünf Dinge ab (Erreichbarkeit,
 * DNS-Anbieter, Zertifikate, SMTP-Konto, Adresse der Oberfläche) und führt sie aus. Was er weiß, steht
 * in einer Zeile (`SetupState`), und welcher Schritt als Nächstes kommt, wird
 * daraus abgeleitet und nicht daneben gespeichert: ein gemerkter Schritt wäre
 * nach einem Abbruch genau dann falsch, wenn sich dazwischen etwas geändert
 * hat, etwa entfernte DNS-Zugangsdaten.
 *
 * Rein, damit Seite und Routen dieselben Regeln benutzen und
 * `tests/setup/rules.test.ts` sie nachrechnen kann.
 */

import { isValidDomain, isValidSourceAddress, isWildcardDomain, type CreateServiceInput } from '../haproxy/config';
import { certCovers } from '../haproxy/certs';
import { needsDnsChallenge } from '../haproxy/challenge';
import { msg, msgid, type Message } from '../i18n/translate';
import type {
  CertificateSource,
  Exposure,
  SetupExecution,
  SetupStage,
  SetupStageKey,
  SetupState,
  Settings,
} from '../types';

/** Die Gruppe und das Ziel, die der Assistent anlegt. */
export const SETUP_SCOPE = 'HAPM';
export const SETUP_SERVICE_ID = 'hapm';
export const DEFAULT_LISTEN_PORT = 7080;

export type SetupChoices = Pick<
  SetupState,
  | 'exposure'
  | 'dns'
  | 'dnsHook'
  | 'certificates'
  | 'mail'
  | 'address'
  | 'domain'
  | 'wildcard'
  | 'wildcardBase'
  | 'crowdsec'
  | 'execution'
> & { surfaceIps: string[] };

export const EMPTY_SETUP: SetupChoices = {
  exposure: null,
  dns: 'pending',
  dnsHook: null,
  certificates: 'pending',
  mail: 'pending',
  address: 'pending',
  domain: null,
  wildcard: false,
  wildcardBase: null,
  crowdsec: null,
  surfaceIps: [],
  execution: null,
};

/* ── Welcher Schritt als Nächstes ── */

export type SetupStep = 'account' | 'exposure' | 'dns' | 'certificates' | 'mail' | 'address' | 'run' | 'done';

/**
 * Die Schritte in der Reihenfolge der Anzeige („Schritt 2 von 7").
 *
 * Das SMTP-Konto steht vor der Adresse und nicht dahinter: eine öffentliche
 * Installation ohne Adresse endet mit der Adresse (`/api/setup/address`,
 * `skip`), ein Schritt danach käme dort nie dran. Adresse und Ausführen
 * gehören ohnehin zusammen, das Ausführen richtet genau die Adresse ein.
 */
export const SETUP_STEPS: readonly Exclude<SetupStep, 'done'>[] = [
  'account',
  'exposure',
  'dns',
  'certificates',
  'mail',
  'address',
  'run',
];

export interface SetupFacts {
  hasAccount: boolean;
  /** Die bei acme.sh eingerichteten DNS-Hooks. `null` heißt unbekannt (HAProxy antwortet nicht). */
  dnsHooks: string[] | null;
  /** Was in den Einstellungen zu den Zertifikaten steht. Fehlt es, die Vorgabe: Let's Encrypt. */
  certificates?: CertificateFacts;
}

/** Die Zertifikatsfrage, wie sie in den Einstellungen steht (`certificateSource`, `acmeDirectory`, `acmeHttpReachable`). */
export interface CertificateFacts {
  source: CertificateSource;
  /** Ein eigener ACME-Server statt Let's Encrypt. */
  customServer: boolean;
  /** Der eigene Server erreicht HAPM über Port 80. Ohne eigenen Server immer `false`. */
  httpReachable: boolean;
}

export const DEFAULT_CERTIFICATE_FACTS: CertificateFacts = { source: 'acme', customServer: false, httpReachable: false };

export function certificateFactsOf(
  settings: Pick<Settings, 'certificateSource' | 'acmeDirectory' | 'acmeHttpReachable'>
): CertificateFacts {
  const customServer = settings.acmeDirectory !== null;
  return {
    source: settings.certificateSource,
    customServer,
    httpReachable: customServer && settings.acmeHttpReachable,
  };
}

/**
 * Ob mit dieser Wahl ein Zertifikat für die Oberfläche entstehen kann.
 *
 * Hochladen geht immer. Über ACME geht es öffentlich (HTTP-01), mit einem
 * DNS-Anbieter (DNS-01) oder mit einem eigenen ACME-Server, der HAPM über Port
 * 80 erreicht. Eine interne Installation mit eigenem DNS-Server und
 * Let's Encrypt hat keinen dieser Wege: Let's Encrypt erreicht sie weder über
 * HTTP noch über DNS.
 */
export function certificatePathOpen(
  state: Pick<SetupChoices, 'exposure' | 'dns'>,
  facts: CertificateFacts
): boolean {
  if (facts.source === 'upload') return true;
  return state.exposure === 'public' || state.dns === 'configured' || facts.httpReachable;
}

/** Eine Wildcard stellt nur acme.sh über einen DNS-Anbieter aus. Hochgeladen wird, was das Zertifikat abdeckt. */
export function wildcardPossible(state: Pick<SetupChoices, 'dns'>, facts: CertificateFacts): boolean {
  return state.dns === 'configured' && facts.source === 'acme';
}

/**
 * Der erste Schritt, der noch nicht beantwortet ist.
 *
 * Eine Antwort zählt nur, solange sie zur Lage passt: „übersprungen" gilt beim
 * DNS-Anbieter und bei der Adresse nur für eine öffentliche Installation, ein
 * gewählter Anbieter nur, solange sein Hook bei acme.sh noch eingerichtet ist,
 * und die Zertifikatsfrage nur, solange es mit ihr einen Weg zum Zertifikat
 * gibt (`certificatePathOpen`). „Eigener DNS-Server" ist eine Antwort, intern
 * wie öffentlich: was dann intern fehlt, fragt der Schritt danach. Sind die Hooks unbekannt, wird die gespeicherte Antwort geglaubt: das
 * Ausführen prüft sie ohnehin noch einmal.
 */
export function resumeStep(state: SetupChoices, facts: SetupFacts): SetupStep {
  if (!facts.hasAccount) return 'account';
  if (!state.exposure) return 'exposure';

  const hookPresent =
    state.dnsHook !== null && (facts.dnsHooks === null || facts.dnsHooks.includes(state.dnsHook));
  const dnsAnswered =
    (state.dns === 'configured' && hookPresent) ||
    (state.dns === 'skipped' && state.exposure === 'public') ||
    state.dns === 'manual';
  if (!dnsAnswered) return 'dns';

  const certificates = facts.certificates ?? DEFAULT_CERTIFICATE_FACTS;
  if (state.certificates !== 'set' || !certificatePathOpen(state, certificates)) return 'certificates';

  // Übersprungen ist eine Antwort: das SMTP-Konto hält die Einrichtung nicht auf.
  if (state.mail !== 'set' && state.mail !== 'skipped') return 'mail';

  if (state.address === 'skipped' && state.exposure === 'public') return 'done';
  if (state.address !== 'set' || !state.domain || validateSetupDomain(state.domain)) return 'address';
  // Eine Wildcard ohne DNS-Anbieter lässt sich nicht ausstellen.
  if (state.wildcard && !wildcardPossible(state, certificates)) return 'address';

  return 'run';
}

/**
 * Die Antwort zum SMTP-Konto aus einer gespeicherten Zeile.
 *
 * Zeilen von vor diesem Schritt kennen das Feld nicht. Wer dort die Adresse
 * schon beantwortet oder das Ausführen begonnen hat, ist am Platz des Schritts
 * vorbei und wird nicht zurückgeschickt, auch nicht mitten aus einem laufenden
 * Ausführen: der Schritt gilt dann als übersprungen, das SMTP-Konto steht
 * weiter unter „Benachrichtigungen". Alle anderen bekommen ihn noch.
 */
export function mailAnswerOf(row: {
  mail?: unknown;
  address?: unknown;
  execution?: unknown;
}): SetupChoices['mail'] {
  if (row.mail === 'pending' || row.mail === 'set' || row.mail === 'skipped') return row.mail;
  const passed = row.address === 'set' || row.address === 'skipped' || Boolean(row.execution);
  return passed ? 'skipped' : 'pending';
}

/** Ob `step` schon erreicht ist, also angezeigt werden darf. */
export function stepReached(step: SetupStep, resume: SetupStep): boolean {
  const order: SetupStep[] = [...SETUP_STEPS, 'done'];
  return order.indexOf(step) <= order.indexOf(resume);
}

/* ── Die Domain der Oberfläche ── */

/** `https://HAPM.Example.org/` wird zu `hapm.example.org`. */
export function normalizeSetupDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/+$/, '')
    .replace(/\.$/, '');
}

/**
 * Die Meldung für den Benutzer oder `null`. Erwartet die normalisierte Form.
 * Eine `Message`: die Seite übersetzt sie mit `t()`, die Route wirft sie als `ApiError`.
 */
export function validateSetupDomain(domain: string): Message | null {
  if (!domain) return msg('Bitte geben Sie die Domain ein, unter der HAPM erreichbar sein soll.');
  if (isWildcardDomain(domain)) return msg('Die Oberfläche braucht eine einzelne Domain, keine Wildcard.');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain) || domain.includes(':')) {
    return msg('Für eine IP-Adresse gibt es kein Zertifikat. Bitte geben Sie einen Domainnamen ein.');
  }
  if (!isValidDomain(domain) || !domain.includes('.')) {
    return msg('"{domain}" ist kein gültiger Domainname. Erwartet wird etwas wie hapm.example.org.', { domain });
  }
  return null;
}

/**
 * Die vorgeschlagene Basis der Wildcard: die Domain ohne ihr erstes Label.
 *
 * `hapm.example.org` ergibt `example.org`, und `*.example.org` deckt die Domain
 * dann ab. `null`, wenn dabei nur noch eine Endung übrig bliebe
 * (`example.org` ergäbe `org`): dafür stellt niemand eine Wildcard aus.
 */
export function wildcardBaseOf(domain: string): string | null {
  const rest = domain.split('.').slice(1);
  return rest.length >= 2 ? rest.join('.') : null;
}

/**
 * Ob die Wildcard `*.<base>` taugt. Sie muss die Domain der Oberfläche
 * abdecken, also genau eine Ebene darüber liegen: sonst entstünde neben der
 * Wildcard noch ein zweites Zertifikat für die Oberfläche.
 */
export function validateWildcardBase(domain: string, base: string): Message | null {
  if (!base) return msg('Bitte geben Sie die Basis der Wildcard ein, zum Beispiel example.org.');
  if (isWildcardDomain(base) || !isValidDomain(base) || !base.includes('.')) {
    return msg('"{base}" ist keine gültige Basis. Erwartet wird etwas wie example.org, ohne Stern davor.', { base });
  }
  if (!certCovers(`*.${base}`, domain)) {
    return msg('*.{base} deckt {domain} nicht ab. Eine Wildcard gilt für genau eine Ebene unter ihrer Basis.', {
      base,
      domain,
    });
  }
  return null;
}

/** Die Domains des Zertifikats: die Basis samt Wildcard, oder nur die eine Domain. */
export function certificateDomains(state: Pick<SetupChoices, 'domain' | 'wildcard' | 'wildcardBase'>): string[] {
  if (!state.domain) return [];
  if (state.wildcard && state.wildcardBase) return [state.wildcardBase, `*.${state.wildcardBase}`];
  return [state.domain];
}

/**
 * Das Ziel, unter dem die Oberfläche hinter dem eigenen HAProxy steht.
 * `adminOnly`: nur von den Admin-IPs aufrufbar (`lockedDomains`, ohne Passwort).
 */
export function hapmServiceInput(domain: string, listenPort: number, adminOnly = false): CreateServiceInput {
  return {
    scope: SETUP_SCOPE,
    id: SETUP_SERVICE_ID,
    domains: [domain],
    servers: [{ name: '', target: `127.0.0.1:${listenPort}`, weight: null }],
    redirect: null,
    routes: [],
    balance: null,
    sticky: false,
    lockedDomains: adminOnly ? [domain] : [],
    passwordLock: null,
    responseHeaders: [],
    requestHeaders: [],
    tunnel: false,
    crowdsec: false,
    // Der Check ruft `GET /` mit dem Host der Domain auf und erwartet 200 bis
    // 399. HAPM antwortet dort mit einer Weiterleitung auf die Übersicht.
    healthcheck: true,
    // HAPM selbst spricht HTTP auf seinem Port.
    backendTls: 'off',
  };
}

export function listenPort(env: string | undefined): number {
  const port = Number.parseInt(env ?? '', 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_LISTEN_PORT;
}

/* ── Die Adressen des Servers und der DNS-Eintrag ── */

interface InterfaceAddress {
  address: string;
  family: string | number;
  internal: boolean;
}

/**
 * Die Adressen aus `os.networkInterfaces()`, auf die ein DNS-Eintrag zeigen
 * kann: ohne Loopback und ohne link-lokale. IPv4 zuerst.
 */
export function pickServerAddresses(
  interfaces: Record<string, InterfaceAddress[] | undefined>
): string[] {
  const v4: string[] = [];
  const v6: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.internal) continue;
      const isV4 = entry.family === 'IPv4' || entry.family === 4;
      if (isV4) {
        if (entry.address.startsWith('169.254.')) continue;
        if (!v4.includes(entry.address)) v4.push(entry.address);
      } else {
        if (/^fe[89ab]/i.test(entry.address)) continue;
        if (!v6.includes(entry.address)) v6.push(entry.address);
      }
    }
  }
  return [...v4, ...v6];
}

/**
 * Ob eine Adresse aus dem Internet erreichbar sein kann: keine private (RFC
 * 1918, fc00::/7), keine des eigenen Rechners, keine link-lokale und keine aus
 * dem Bereich der Anbieter für geteilte Adressen (100.64.0.0/10).
 */
export function isPublicAddress(address: string): boolean {
  const text = address.trim().toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((part) => part > 255)) return false;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    return true;
  }
  if (!text.includes(':') || !/^[0-9a-f:.]+$/.test(text)) return false;
  if (text === '::' || text === '::1') return false;
  if (text.startsWith('::ffff:')) return isPublicAddress(text.slice(7));
  return !/^f[cd]/.test(text) && !/^fe[89ab]/.test(text);
}

/**
 * Die Adressen, die der Assistent für den DNS-Eintrag vorschlägt, die beste
 * zuerst. Ein Server im Internet steht oft hinter einer Adressumsetzung und
 * trägt nur eine private Adresse an der Schnittstelle: dort gehört die
 * öffentliche in den Eintrag, die private erreicht von außen niemand.
 *
 * `outside` ist die Adresse, unter der der Server von außen gesehen wird
 * (`lookupPublicAddress`), `null`, wenn nicht gefragt oder nicht zu erfahren.
 * Intern bleibt die Reihenfolge der Schnittstellen.
 *
 * IPv4 vor IPv6, auch wenn nur die IPv6-Adresse an der Schnittstelle steht
 * (privates IPv4 hinter einer Adressumsetzung, dazu ein öffentliches IPv6 ist
 * der übliche Fall): ein Eintrag nur für IPv6 ließe jeden ohne IPv6 draußen.
 */
export function orderRecordAddresses(own: string[], exposure: Exposure | null, outside: string | null): string[] {
  if (exposure !== 'public') return own;
  const open = own.filter(isPublicAddress);
  const seen = new Set<string>();
  return [
    ...open.filter((entry) => !entry.includes(':')),
    ...(outside ? [outside] : []),
    ...open.filter((entry) => entry.includes(':')),
    ...own.filter((entry) => !isPublicAddress(entry)),
  ].filter((entry) => !seen.has(entry) && seen.add(entry));
}

/** Ob die Schnittstellen schon eine öffentliche IPv4-Adresse tragen. Sonst lohnt die Frage nach außen. */
export function hasPublicIpv4(own: string[]): boolean {
  return own.some((entry) => !entry.includes(':') && isPublicAddress(entry));
}

/** Die Liste aus dem Formular: ohne Leerzeilen, ohne Doppelte. */
export function normalizeSurfaceIps(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry).trim()).filter(Boolean))];
}

/**
 * Die Adressen, von denen die Oberfläche aufrufbar sein soll. Leer heißt: von
 * überall. Jede muss eine Adresse oder ein Netz sein, wie bei den Admin-IPs.
 */
export function validateSurfaceIps(list: string[]): Message | null {
  if (list.length > 50) return msg('Mehr als 50 Adressen sind hier nicht möglich.');
  for (const address of list) {
    if (!isValidSourceAddress(address)) {
      return msg('Keine gültige Adresse: {address}. Erwartet wird eine IP oder ein Netz wie 10.0.0.0/8.', { address });
    }
  }
  return null;
}

/**
 * Was die DNS-Abfrage über die Domain sagt.
 *
 * `unknown` heißt: die Abfrage selbst ist gescheitert. Das ist nicht „löst
 * nicht auf". `elsewhere` ist kein Urteil über den Eintrag: hinter einer
 * Adressumsetzung trägt der Server seine öffentliche Adresse nicht selbst.
 */
export type AddressVerdict = 'matches' | 'elsewhere' | 'unresolved' | 'unknown';

export function judgeAddresses(resolved: string[] | null, own: string[]): AddressVerdict {
  if (resolved === null) return 'unknown';
  if (resolved.length === 0) return 'unresolved';
  const mine = new Set(own.map((address) => address.toLowerCase()));
  return resolved.some((address) => mine.has(address.toLowerCase())) ? 'matches' : 'elsewhere';
}

/* ── Das Ausführen ── */

/** Deutsche Schlüssel (`msgid`), die Seite übersetzt sie beim Zeigen. */
export const STAGE_LABELS: Record<SetupStageKey, string> = {
  dns: msgid('DNS-Zugangsdaten prüfen'),
  scope: msgid('Gruppe {scope} anlegen'),
  certificate: msgid('Zertifikat ausstellen'),
  access: msgid('Erlaubte Adressen für die Oberfläche eintragen'),
  service: msgid('Ziel für die Oberfläche anlegen'),
  crowdsec: msgid('CrowdSec für alle Ziele einschalten'),
  publicUrl: msgid('Adresse von HAPM eintragen'),
};

/**
 * Die Schritte des Ausführens. Die DNS-Zugangsdaten nur, wenn das Zertifikat
 * über DNS-01 beantragt wird: nicht bei „nur hochladen" und nicht, wenn ein
 * eigener ACME-Server HAPM über Port 80 erreicht.
 */
export function executionPlan(
  state: Pick<SetupChoices, 'exposure' | 'domain' | 'wildcard' | 'wildcardBase'> &
    Partial<Pick<SetupChoices, 'crowdsec' | 'surfaceIps'>>,
  certificates: CertificateFacts = DEFAULT_CERTIFICATE_FACTS
): SetupStageKey[] {
  const exposure: Exposure = state.exposure ?? 'public';
  const overDns =
    certificates.source === 'acme' &&
    needsDnsChallenge(certificateDomains(state), exposure, certificates.httpReachable);
  // CrowdSec nach dem Ziel der Oberfläche: dann prüft es von Anfang an auch sie,
  // und ein Fehler hier lässt die Oberfläche trotzdem erreichbar zurück.
  const crowdsec = exposure === 'public' && state.crowdsec === true;
  // Die Adressen vor dem Ziel: es wird gleich gesperrt angelegt, und eine
  // Sperre ohne Admin-IPs lehnt die Prüfung ab.
  const access = surfaceRestricted(state);
  return [
    ...(overDns ? (['dns'] as const) : []),
    'scope',
    'certificate',
    ...(access ? (['access'] as const) : []),
    'service',
    ...(crowdsec ? (['crowdsec'] as const) : []),
    'publicUrl',
  ];
}

/** Ob die Oberfläche nur von bestimmten Adressen aufrufbar sein soll. Nur öffentlich gefragt. */
export function surfaceRestricted(state: Pick<SetupChoices, 'exposure'> & Partial<Pick<SetupChoices, 'surfaceIps'>>): boolean {
  return state.exposure === 'public' && (state.surfaceIps?.length ?? 0) > 0;
}

export function newExecution(stages: SetupStageKey[], startedAt: string): SetupExecution {
  return {
    startedAt,
    running: true,
    stages: stages.map((key) => ({ key, status: 'pending', detail: null, runId: null })),
  };
}

/** Gespeichert als deutscher Schlüssel, die Seite übersetzt ihn beim Zeigen. */
export const INTERRUPTED = msgid(
  'HAPM wurde neu gestartet, während die Einrichtung lief. Bitte führen Sie sie erneut aus. Was schon eingerichtet ist, wird dabei nicht wiederholt.'
);

/**
 * Ein gespeichertes Ausführen so lesen, wie es wirklich steht.
 *
 * Das Ausführen läuft im Prozess von HAPM. Stirbt der Prozess, steht in der
 * Zeile weiter `running`, und niemand arbeitet mehr daran. `alive` sagt, ob
 * dieser Prozess es gerade ausführt.
 */
export function settleExecution(
  execution: SetupExecution | null,
  alive: boolean
): SetupExecution | null {
  if (!execution || !execution.running || alive) return execution;
  return {
    ...execution,
    running: false,
    stages: execution.stages.map(
      (stage): SetupStage =>
        stage.status === 'running' ? { ...stage, status: 'error', detail: INTERRUPTED } : stage
    ),
  };
}

export type ExecutionOutcome = 'idle' | 'running' | 'failed' | 'succeeded';

export function executionOutcome(execution: SetupExecution | null): ExecutionOutcome {
  if (!execution) return 'idle';
  if (execution.running) return 'running';
  if (execution.stages.some((stage) => stage.status === 'error')) return 'failed';
  return execution.stages.every((stage) => stage.status === 'ok') ? 'succeeded' : 'idle';
}
