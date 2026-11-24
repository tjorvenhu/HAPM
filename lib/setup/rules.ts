/**
 * Die Regeln des Assistenten der Einrichtung, ohne Datenbank und ohne Netz.
 *
 * Der Assistent fragt nach dem ersten Konto vier Dinge ab (Erreichbarkeit,
 * DNS-Anbieter, Adresse der Oberfläche) und führt sie aus. Was er weiß, steht
 * in einer Zeile (`SetupState`), und welcher Schritt als Nächstes kommt, wird
 * daraus abgeleitet und nicht daneben gespeichert: ein gemerkter Schritt wäre
 * nach einem Abbruch genau dann falsch, wenn sich dazwischen etwas geändert
 * hat, etwa entfernte DNS-Zugangsdaten.
 *
 * Rein, damit Seite und Routen dieselben Regeln benutzen und
 * `tests/setup/rules.test.ts` sie nachrechnen kann.
 */

import { isValidDomain, isWildcardDomain, type CreateServiceInput } from '../haproxy/config';
import { certCovers } from '../haproxy/certs';
import { needsDnsChallenge } from '../haproxy/challenge';
import type {
  Exposure,
  SetupExecution,
  SetupStage,
  SetupStageKey,
  SetupState,
} from '../types';

/** Die Gruppe und das Ziel, die der Assistent anlegt. */
export const SETUP_SCOPE = 'HAPM';
export const SETUP_SERVICE_ID = 'hapm';
export const DEFAULT_LISTEN_PORT = 7080;

export type SetupChoices = Pick<
  SetupState,
  'exposure' | 'dns' | 'dnsHook' | 'address' | 'domain' | 'wildcard' | 'wildcardBase' | 'execution'
>;

export const EMPTY_SETUP: SetupChoices = {
  exposure: null,
  dns: 'pending',
  dnsHook: null,
  address: 'pending',
  domain: null,
  wildcard: false,
  wildcardBase: null,
  execution: null,
};

/* ── Welcher Schritt als Nächstes ── */

export type SetupStep = 'account' | 'exposure' | 'dns' | 'address' | 'run' | 'done';

/** Die Schritte in der Reihenfolge der Anzeige („Schritt 2 von 5"). */
export const SETUP_STEPS: readonly Exclude<SetupStep, 'done'>[] = [
  'account',
  'exposure',
  'dns',
  'address',
  'run',
];

export interface SetupFacts {
  hasAccount: boolean;
  /** Die bei acme.sh eingerichteten DNS-Hooks. `null` heißt unbekannt (HAProxy antwortet nicht). */
  dnsHooks: string[] | null;
}

/**
 * Der erste Schritt, der noch nicht beantwortet ist.
 *
 * Eine Antwort zählt nur, solange sie zur Lage passt: „übersprungen" gilt beim
 * DNS-Anbieter und bei der Adresse nur für eine öffentliche Installation, und
 * ein gewählter Anbieter nur, solange sein Hook bei acme.sh noch eingerichtet
 * ist. Sind die Hooks unbekannt, wird die gespeicherte Antwort geglaubt: das
 * Ausführen prüft sie ohnehin noch einmal.
 */
export function resumeStep(state: SetupChoices, facts: SetupFacts): SetupStep {
  if (!facts.hasAccount) return 'account';
  if (!state.exposure) return 'exposure';

  const hookPresent =
    state.dnsHook !== null && (facts.dnsHooks === null || facts.dnsHooks.includes(state.dnsHook));
  const dnsAnswered =
    (state.dns === 'configured' && hookPresent) ||
    (state.dns === 'skipped' && state.exposure === 'public');
  if (!dnsAnswered) return 'dns';

  if (state.address === 'skipped' && state.exposure === 'public') return 'done';
  if (state.address !== 'set' || !state.domain || validateSetupDomain(state.domain)) return 'address';
  // Eine Wildcard ohne DNS-Anbieter lässt sich nicht ausstellen.
  if (state.wildcard && state.dns !== 'configured') return 'address';

  return 'run';
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

/** Die Meldung für den Benutzer oder `null`. Erwartet die normalisierte Form. */
export function validateSetupDomain(domain: string): string | null {
  if (!domain) return 'Bitte geben Sie die Domain ein, unter der HAPM erreichbar sein soll.';
  if (isWildcardDomain(domain)) return 'Die Oberfläche braucht eine einzelne Domain, keine Wildcard.';
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain) || domain.includes(':')) {
    return 'Für eine IP-Adresse gibt es kein Zertifikat. Bitte geben Sie einen Domainnamen ein.';
  }
  if (!isValidDomain(domain) || !domain.includes('.')) {
    return `"${domain}" ist kein gültiger Domainname. Erwartet wird etwas wie hapm.example.org.`;
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
export function validateWildcardBase(domain: string, base: string): string | null {
  if (!base) return 'Bitte geben Sie die Basis der Wildcard ein, zum Beispiel example.org.';
  if (isWildcardDomain(base) || !isValidDomain(base) || !base.includes('.')) {
    return `"${base}" ist keine gültige Basis. Erwartet wird etwas wie example.org, ohne Stern davor.`;
  }
  if (!certCovers(`*.${base}`, domain)) {
    return `*.${base} deckt ${domain} nicht ab. Eine Wildcard gilt für genau eine Ebene unter ihrer Basis.`;
  }
  return null;
}

/** Die Domains des Zertifikats: die Basis samt Wildcard, oder nur die eine Domain. */
export function certificateDomains(state: Pick<SetupChoices, 'domain' | 'wildcard' | 'wildcardBase'>): string[] {
  if (!state.domain) return [];
  if (state.wildcard && state.wildcardBase) return [state.wildcardBase, `*.${state.wildcardBase}`];
  return [state.domain];
}

/** Das Ziel, unter dem die Oberfläche hinter dem eigenen HAProxy steht. */
export function hapmServiceInput(domain: string, listenPort: number): CreateServiceInput {
  return {
    scope: SETUP_SCOPE,
    id: SETUP_SERVICE_ID,
    domains: [domain],
    servers: [{ name: '', target: `127.0.0.1:${listenPort}`, weight: null }],
    redirect: null,
    routes: [],
    balance: null,
    sticky: false,
    lockedDomains: [],
    passwordLock: null,
    preset: 'default',
    // Der Check ruft `GET /` mit dem Host der Domain auf und erwartet 200 bis
    // 399. HAPM antwortet dort mit einer Weiterleitung auf die Übersicht.
    healthcheck: true,
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

export const STAGE_LABELS: Record<SetupStageKey, string> = {
  dns: 'DNS-Zugangsdaten prüfen',
  scope: `Gruppe ${SETUP_SCOPE} anlegen`,
  certificate: 'Zertifikat ausstellen',
  service: 'Ziel für die Oberfläche anlegen',
  publicUrl: 'Adresse von HAPM eintragen',
};

/** Die Schritte des Ausführens. Die DNS-Zugangsdaten nur, wenn das Zertifikat über DNS-01 geht. */
export function executionPlan(
  state: Pick<SetupChoices, 'exposure' | 'domain' | 'wildcard' | 'wildcardBase'>
): SetupStageKey[] {
  const exposure: Exposure = state.exposure ?? 'public';
  const overDns = needsDnsChallenge(certificateDomains(state), exposure);
  return [...(overDns ? (['dns'] as const) : []), 'scope', 'certificate', 'service', 'publicUrl'];
}

export function newExecution(stages: SetupStageKey[], startedAt: string): SetupExecution {
  return {
    startedAt,
    running: true,
    stages: stages.map((key) => ({ key, status: 'pending', detail: null, runId: null })),
  };
}

export const INTERRUPTED =
  'HAPM wurde neu gestartet, während die Einrichtung lief. Bitte führen Sie sie erneut aus. ' +
  'Was schon eingerichtet ist, wird dabei nicht wiederholt.';

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
