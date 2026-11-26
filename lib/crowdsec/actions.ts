/**
 * Was die Seite „CrowdSec", die interne API (`/api/internal/crowdsec`) und der
 * MCP-Server gemeinsam tun: Zustand lesen, Sperren setzen und aufheben,
 * Adressen freigeben, Ereignisse und Statistik lesen, Regeln schalten.
 *
 * Jede Änderung schreibt ihr Audit hier und nicht in der Route
 * (docs/mcp.md, „Keine eigene Logik in den Werkzeugen").
 *
 * Ob CrowdSec eine Anfrage prüft, steht nicht hier, sondern in `haproxy.cfg`:
 * global über die Einstellungen (`GlobalSettingsInput.crowdsec`), je Ziel über
 * dessen Formular (`CreateServiceInput.crowdsec`). Beides läuft als Vorgang
 * wie jede andere Änderung an der Konfiguration.
 */

import fs from 'node:fs';
import { ApiError } from '../api';
import { msg } from '../i18n';
import { logAudit, type AuditAction } from '../audit';
import { containerInfo, engine, type ContainerInfo } from '../docker';
import {
  HAPROXY_CFG,
  HaproxyConfigError,
  parseCrowdsecGlobal,
  parseHaproxyConfig,
  usesCrowdsec,
  type HaproxyService,
} from '../haproxy/config';
import { cscli, cscliJson, cscliOk, CrowdsecUnavailable } from './cscli';
import {
  BASE_COLLECTIONS,
  CRS_COLLECTIONS,
  CRS_MODES,
  OPTIONAL_COLLECTIONS,
  type CrsMode,
} from './files';
import {
  ALLOWLIST_NAME,
  bouncerContainerName,
  crowdsecContainerName,
  crowdsecDisabled,
  crowdsecInStack,
  crowdsecInstalled,
  crowdsecPresent,
  crowdsecSwitchingOff,
  setCrowdsecSwitchingOff,
  BOUNCER_NAME,
} from './paths';
import { precheckSettings } from '../haproxy/provision';
import { addressInNetwork } from '../geoip/networks';
import {
  ALLOW_DURATIONS,
  BAN_DURATIONS,
  alertTargetId,
  bansToRestore,
  cleanNote,
  crowdsecStats,
  isManualBan,
  parseAddress,
  parseAlerts,
  parseAllowlist,
  parseDecisions,
  type AlertTarget,
  type CrowdsecAlert,
} from './data';
import {
  appWhitelistPresent,
  currentCrsMode,
  ensureAllowlist,
  reloadCrowdsec,
  setAppWhitelist,
  setDisabledMarker,
  writeCrowdsecFiles,
} from './setup';
import { localServer } from '../helpers';
import { startHaproxyRun, waitForRun } from '../haproxy/runner';
import { APP_RULES } from './apps';
import { syncAllowFile } from './allow-file';

export interface CrowdsecActor {
  userId: string;
  userEmail: string;
  ip?: string;
}

async function audit(actor: CrowdsecActor, action: AuditAction, resourceId: string, details: string) {
  await logAudit({ ...actor, action, resource: 'crowdsec', resourceId, details });
}

/* ── Ziele aus haproxy.cfg ── */

function readConfig(): string | null {
  try {
    return fs.readFileSync(HAPROXY_CFG, 'utf8');
  } catch {
    return null;
  }
}

function targetsOf(services: HaproxyService[]): AlertTarget[] {
  return services.map((service) => ({
    id: service.id,
    domains: service.domains,
    backends: [service.id, ...service.routes.map((route) => route.backend)],
  }));
}

/** Welche Ziele CrowdSec prüft: global alle, sonst die mit eigenem Schalter. */
export function protection(text: string | null = readConfig()) {
  if (text === null) {
    return {
      readable: false,
      global: null,
      inUse: false,
      services: [] as { id: string; domains: string[]; own: boolean }[],
      total: 0,
      targets: [] as { id: string; label: string }[],
    };
  }
  const services = parseHaproxyConfig(text);
  const global = parseCrowdsecGlobal(text);
  return {
    readable: true,
    global,
    /** Ob die Datei den Bouncer irgendwo fragt, auch in einem von Hand geänderten Block. */
    inUse: usesCrowdsec(text),
    services: services
      .filter((service) => global === true || service.crowdsec)
      .map((service) => ({ id: service.id, domains: service.domains, own: service.crowdsec })),
    total: services.length,
    /** Alle Ziele für die Auswahl der Ereignisse. */
    targets: services.map((service) => ({ id: service.id, label: service.domains[0] ?? service.id })),
  };
}

/* ── Zustand ── */

export interface CrowdsecStatus {
  /** Ob CrowdSec auf dieser Installation da ist (`crowdsecInstalled`). */
  inStack: boolean;
  /** Warum nicht: bei der Installation abgewählt, die Installation stammt von
   *  vor CrowdSec und hat weder Ordner noch Container, oder in der Oberfläche
   *  abgeschaltet. */
  missing: 'off' | 'not-installed' | 'disabled' | null;
  crowdsec: ContainerInfo | null;
  bouncer: ContainerInfo | null;
  /** `cscli version`, oder `null`, wenn nicht zu erfahren. */
  version: string | null;
  /** Ob die lokale API antwortet. `null`: nicht gefragt (Container läuft nicht). */
  lapi: boolean | null;
  /** Wann der Bouncer zuletzt Sperren geholt hat. `null`: nicht angemeldet oder unbekannt. */
  bouncerLastPull: string | null;
  bouncerRegistered: boolean | null;
  /** Ein Lauf nimmt CrowdSec gerade aus `haproxy.cfg`, danach halten die Container an. */
  switching: boolean;
  error: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Ausgabe von cscli */
export async function crowdsecStatus(): Promise<CrowdsecStatus> {
  const status: CrowdsecStatus = {
    inStack: crowdsecInstalled(),
    missing: !crowdsecInStack() ? 'off' : !crowdsecPresent() ? 'not-installed' : crowdsecDisabled() ? 'disabled' : null,
    crowdsec: null,
    bouncer: null,
    version: null,
    lapi: null,
    bouncerLastPull: null,
    bouncerRegistered: null,
    switching: crowdsecSwitchingOff(),
    error: null,
  };
  try {
    [status.crowdsec, status.bouncer] = await Promise.all([
      containerInfo(crowdsecContainerName()),
      containerInfo(bouncerContainerName()),
    ]);
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
    return status;
  }
  if (!status.crowdsec?.running) return status;

  try {
    const [version, lapi, bouncers] = await Promise.all([
      cscli(['version']),
      cscli(['lapi', 'status']),
      cscliJson<any[]>(['bouncers', 'list']).catch(() => null),
    ]);
    status.version = /version:\s*v?([^\s-]+)/.exec(`${version.stdout}${version.stderr}`)?.[1] ?? null;
    status.lapi = lapi.code === 0;
    if (Array.isArray(bouncers)) {
      const own = bouncers.find((b) => b?.name === BOUNCER_NAME);
      status.bouncerRegistered = Boolean(own);
      const pull = own?.last_pull ?? own?.last_pull_at ?? null;
      status.bouncerLastPull = typeof pull === 'string' && !pull.startsWith('0001') ? pull : null;
    }
  } catch (err) {
    status.error = err instanceof Error ? err.message : String(err);
  }
  return status;
}

/* ── Sperren ── */

export async function listDecisions() {
  const json = await cscliJson(['decisions', 'list', '--limit', '1000']);
  return parseDecisions(json, Date.now());
}

/** Wie viele Adressen die Gemeinschaftsliste von CrowdSec gerade sperrt. `null`: unbekannt. */
export async function communityBlocklistSize(): Promise<number | null> {
  const metrics = await cscliJson<any>(['metrics', 'show', 'decisions']).catch(() => null);
  const table = metrics?.decisions;
  if (!table || typeof table !== 'object') return null;
  let total = 0;
  let seen = false;
  for (const reasons of Object.values(table) as any[]) {
    for (const [origin, actions] of Object.entries(reasons ?? {}) as [string, any][]) {
      if (origin !== 'CAPI' && origin !== 'lists') continue;
      for (const count of Object.values(actions ?? {})) {
        total += Number(count) || 0;
        seen = true;
      }
    }
  }
  return seen ? total : 0;
}

/**
 * Ein Netz, das einen großen Teil des Internets trifft, ist fast immer ein
 * Tippfehler: als Sperre legt es die Ziele lahm, als Freigabe schaltet es die
 * WAF für alle ab. Kleiner als /8 (IPv4) oder /16 (IPv6) geht deshalb nicht.
 */
function assertNotTooWide(value: string): void {
  const [base, prefix] = value.split('/');
  if (prefix === undefined) return;
  const min = base.includes(':') ? 16 : 8;
  if (Number(prefix) < min) {
    throw new ApiError(msg('Das Netz {value} ist zu groß. Das größte erlaubte ist /{min}.', { value, min: String(min) }));
  }
}

export async function addDecision(body: unknown, actor: CrowdsecActor) {
  const raw = (body ?? {}) as Record<string, unknown>;
  const address = parseAddress(String(raw.value ?? ''));
  if (!address) throw new ApiError(msg('Bitte eine Adresse oder ein Netz angeben, etwa 203.0.113.7 oder 198.51.100.0/24.'));
  assertNotTooWide(address.value);
  // Wer sich selbst sperrt, kommt bei geprüfter Oberfläche nicht mehr herein, um es zurückzunehmen.
  if (actor.ip && addressInNetwork(actor.ip, address.value)) {
    throw new ApiError(
      msg('{value} trifft Ihre eigene Adresse ({ip}). Sie sperrten sich damit selbst aus.', { value: address.value, ip: actor.ip }),
      409
    );
  }
  const duration = String(raw.duration ?? '4h');
  if (!(BAN_DURATIONS as readonly string[]).includes(duration)) throw new ApiError(msg('Diese Dauer gibt es nicht.'));
  const reason = cleanNote(raw.reason) || 'Gesperrt in HAPM';

  await cscliOk([
    'decisions',
    'add',
    address.scope === 'ip' ? '--ip' : '--range',
    address.value,
    '--duration',
    duration,
    '--type',
    'ban',
    '--reason',
    reason,
  ]);
  await audit(actor, 'crowdsec_decision_added', address.value, `${address.value} für ${duration}: ${reason}`);
  return { value: address.value, duration };
}

export async function removeDecision(body: unknown, actor: CrowdsecActor) {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (raw.id !== undefined) {
    const id = Number(raw.id);
    if (!Number.isInteger(id) || id <= 0) throw new ApiError(msg('Diese Sperre gibt es nicht.'), 404);
    const result = await cscliOk(['decisions', 'delete', '--id', String(id)]);
    await audit(actor, 'crowdsec_decision_removed', String(id), `Sperre ${id} aufgehoben. ${result.stderr.trim()}`.trim());
    return { removed: id };
  }
  const address = parseAddress(String(raw.value ?? ''));
  if (!address) throw new ApiError(msg('Bitte eine Adresse oder ein Netz angeben, etwa 203.0.113.7 oder 198.51.100.0/24.'));
  await cscliOk(['decisions', 'delete', address.scope === 'ip' ? '--ip' : '--range', address.value]);
  await audit(actor, 'crowdsec_decision_removed', address.value, `Alle Sperren für ${address.value} aufgehoben.`);
  return { removed: address.value };
}

/* ── Freigaben ── */

export async function listAllowlist() {
  await ensureAllowlist();
  const json = await cscliJson(['allowlists', 'inspect', ALLOWLIST_NAME]);
  return parseAllowlist(json);
}

/** Freigeben. CrowdSec hebt dabei bestehende Sperren der Adresse auf. */
export async function addAllowlist(body: unknown, actor: CrowdsecActor) {
  const raw = (body ?? {}) as Record<string, unknown>;
  const address = parseAddress(String(raw.value ?? ''));
  if (!address) throw new ApiError(msg('Bitte eine Adresse oder ein Netz angeben, etwa 203.0.113.7 oder 198.51.100.0/24.'));
  assertNotTooWide(address.value);
  const duration = raw.duration === null || raw.duration === undefined || raw.duration === '' ? null : String(raw.duration);
  if (duration !== null && !(ALLOW_DURATIONS as readonly string[]).includes(duration)) {
    throw new ApiError(msg('Diese Dauer gibt es nicht.'));
  }
  const description = cleanNote(raw.description) || 'HAPM';

  await ensureAllowlist();
  const current = parseAllowlist(await cscliJson(['allowlists', 'inspect', ALLOWLIST_NAME]));
  if (current.some((entry) => entry.value === address.value)) {
    throw new ApiError(msg('{value} ist schon freigegeben.', { value: address.value }), 409);
  }
  await cscliOk([
    'allowlists',
    'add',
    ALLOWLIST_NAME,
    address.value,
    '-d',
    description,
    ...(duration ? ['-e', duration] : []),
  ]);
  await syncAllowFile(await listAllowlist());
  await audit(
    actor,
    'crowdsec_allowlist_added',
    address.value,
    `${address.value} freigegeben${duration ? ` für ${duration}` : ''}: ${description}`
  );
  return { value: address.value };
}

export async function removeAllowlist(body: unknown, actor: CrowdsecActor) {
  const raw = (body ?? {}) as Record<string, unknown>;
  const address = parseAddress(String(raw.value ?? ''));
  if (!address) throw new ApiError(msg('Bitte eine Adresse oder ein Netz angeben, etwa 203.0.113.7 oder 198.51.100.0/24.'));
  const current = await listAllowlist();
  if (!current.some((entry) => entry.value === address.value)) {
    throw new ApiError(msg('{value} steht nicht in der Freigabeliste.', { value: address.value }), 404);
  }
  await cscliOk(['allowlists', 'remove', ALLOWLIST_NAME, address.value]);
  await syncAllowFile(await listAllowlist());
  await audit(actor, 'crowdsec_allowlist_removed', address.value, `Freigabe für ${address.value} entfernt.`);
  return { value: address.value };
}

/* ── Ereignisse ── */

const ALERT_WINDOWS: Record<string, number> = { '24h': 24, '7d': 168, '30d': 720 };

export function readWindow(value: unknown): { key: string; hours: number } {
  const key = typeof value === 'string' && value in ALERT_WINDOWS ? value : '24h';
  return { key, hours: ALERT_WINDOWS[key] };
}

async function readAlerts(hours: number, limit: number): Promise<CrowdsecAlert[]> {
  const json = await cscliJson(['alerts', 'list', '--since', `${hours}h`, '--limit', String(limit)], 60_000);
  return parseAlerts(json);
}

export type CrowdsecAlertRow = CrowdsecAlert & { targetId: string | null };

/**
 * Die Ereignisse eines Zeitraums, auf Wunsch nur die eines Ziels. Jedes trägt
 * das Ziel, zu dem es gehört (über Domain oder Backend), soweit es eines gibt.
 */
export async function listAlerts(options: { window?: unknown; service?: unknown; limit?: number } = {}) {
  const { key, hours } = readWindow(options.window);
  const services = parseHaproxyConfig(readConfig() ?? '');
  const targets = targetsOf(services);
  const service = typeof options.service === 'string' && options.service ? options.service : null;
  if (service && !targets.some((target) => target.id === service)) {
    throw new ApiError(msg('Das Ziel {id} gibt es nicht.', { id: service }), 404);
  }
  // Gefiltert wird nach dem Lesen: für ein einzelnes Ziel deshalb tiefer lesen,
  // sonst zeigte es nur seinen Anteil an den neuesten 500.
  const limit = options.limit ?? (service ? 5000 : 500);
  const read = await readAlerts(hours, limit);
  const alerts: CrowdsecAlertRow[] = read.map((alert) => ({
    ...alert,
    targetId: alertTargetId(alert, targets),
  }));
  return {
    window: key,
    service,
    alerts: service ? alerts.filter((alert) => alert.targetId === service) : alerts,
    /** Es gibt im Zeitraum mehr, als gelesen wurde: die Liste zeigt nur die neuesten. */
    truncated: read.length >= limit,
  };
}

const STATS_ALERT_LIMIT = 5000;

export async function crowdsecStatistics(window: unknown) {
  const { key, hours } = readWindow(window);
  const targets = targetsOf(parseHaproxyConfig(readConfig() ?? ''));
  const alerts = await readAlerts(hours, STATS_ALERT_LIMIT);
  const to = Date.now();
  const [decisions, community] = await Promise.all([
    listDecisions().catch(() => null),
    communityBlocklistSize(),
  ]);
  return {
    window: key,
    stats: crowdsecStats(alerts, targets, to - hours * 3_600_000, to),
    /** Im Zeitraum gab es mehr Ereignisse, als gelesen wurden: die Zahlen sind eine Untergrenze. */
    truncated: alerts.length >= STATS_ALERT_LIMIT,
    activeDecisions: decisions?.length ?? null,
    communityBlocklist: community,
  };
}

/* ── Leeren ── */

/** So lange wartet das Leeren darauf, dass die Bouncer aufgehobene Sperren abholen (sie fragen alle 10 s). */
const PULL_WAIT_MS = 25_000;
/** Ein Bouncer, der länger nicht gefragt hat, läuft nicht und liest beim Start ohnehin alles neu. */
const BOUNCER_ACTIVE_MS = 90_000;
/**
 * Quellen eines Ereignisses und Herkünfte einer Sperre, die nie geleert werden:
 * die Listen, die CrowdSec von außen bezieht. Das Ereignis, an dem die
 * Gemeinschaftsliste hängt, trägt als Quelle `crowdsecurity/community-blocklist`,
 * ihre Sperren die Herkunft `CAPI`, eine abonnierte Liste `lists:<Name>`.
 */
const KEPT_SCOPES = /^(capi|lists|crowdsecurity\/community-blocklist)(:|$)/i;

const clearState = globalThis as unknown as { __hapmCrowdsecClearing?: boolean; __hapmCrowdsecUnpulled?: boolean };

function countIn(result: { stdout: string; stderr: string }, what: 'alert' | 'decision'): number {
  const pattern = what === 'alert' ? /(\d+) alert\(s\) deleted/ : /(\d+) decision\(s\) deleted/;
  const found = pattern.exec(`${result.stderr}\n${result.stdout}`);
  return found ? Number(found[1]) : 0;
}

/** Wann jeder Bouncer zuletzt Sperren abgeholt hat. `null`: nicht zu erfahren. */
async function bouncerPulls(): Promise<Map<string, string> | null> {
  const list = await cscliJson<any[]>(['bouncers', 'list']).catch(() => null);
  if (!Array.isArray(list)) return null;
  return new Map(list.map((b) => [String(b?.name ?? ''), String(b?.last_pull ?? '')]));
}

/**
 * Wartet, bis jeder laufende Bouncer einmal Sperren abgeholt hat.
 *
 * Ein Bouncer erfährt von einer aufgehobenen Sperre nur, solange sie noch in
 * der Datenbank steht. `cscli alerts delete` nimmt sie mit dem Ereignis ganz
 * weg: wer vorher nicht abgeholt hat, sperrt die Adresse weiter, obwohl die
 * Sperrliste leer ist (nachgestellt mit CrowdSec 1.8.2).
 */
async function bouncersPulled(): Promise<boolean> {
  const before = await bouncerPulls();
  if (!before) return false;
  const active = [...before]
    .filter(([, at]) => Date.now() - Date.parse(at) < BOUNCER_ACTIVE_MS)
    .map(([name]) => name);
  if (active.length === 0) return true;
  const deadline = Date.now() + PULL_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const now = await bouncerPulls();
    if (now && active.every((name) => now.get(name) !== before.get(name))) return true;
  }
  return false;
}

/** Hebt alle Sperren auf, die nicht von Hand gesetzt sind und nicht aus einer bezogenen Liste stammen. */
async function liftAutomaticBans(): Promise<number> {
  const origins = new Set((await listDecisions()).filter((d) => !isManualBan(d)).map((d) => d.origin));
  let lifted = 0;
  for (const origin of origins) {
    if (!origin || KEPT_SCOPES.test(origin)) continue;
    lifted += countIn(await cscliOk(['decisions', 'delete', '--origin', origin]), 'decision');
  }
  return lifted;
}

/**
 * CrowdSec leeren: alle Ereignisse und die Sperren, die CrowdSec daraus
 * verhängt hat. Statistik und Zähler beginnen damit bei null. Es bleiben die
 * Sperren von Hand, die Freigaben, die Regeln und die Gemeinschaftsliste.
 *
 * Reihenfolge: Sperren aufheben, auf die Bouncer warten (`bouncersPulled`),
 * Ereignisse entfernen, Sperren von Hand neu setzen. `cscli alerts delete`
 * kennt keinen Filter nach Herkunft, nur nach der Art der Quelle (`--scope`):
 * das trifft auch die Sperren von Hand, lässt aber die Gemeinschaftsliste
 * stehen (Quelle `CAPI`, `lists`). Ein `--all` nähme sie mit, und CrowdSec
 * holt sie erst nach einem Neustart wieder vollständig.
 */
export async function clearCrowdsec(actor: CrowdsecActor) {
  if (clearState.__hapmCrowdsecClearing) throw new ApiError(msg('CrowdSec wird gerade geleert.'), 409);
  clearState.__hapmCrowdsecClearing = true;
  try {
    let lifted = 0;
    // Zwei Durchgänge: was CrowdSec während des Wartens neu sperrt, soll auch abgeholt sein.
    for (let round = 0; round < 2; round++) {
      const now = await liftAutomaticBans();
      lifted += now;
      if (now > 0) clearState.__hapmCrowdsecUnpulled = true;
      if (!clearState.__hapmCrowdsecUnpulled) break;
      if (!(await bouncersPulled())) {
        throw new ApiError(
          msg('Die Sperren sind aufgehoben, aber der Bouncer hat sie noch nicht abgeholt. Die Ereignisse stehen noch da. Bitte gleich noch einmal versuchen.'),
          409
        );
      }
      clearState.__hapmCrowdsecUnpulled = false;
    }

    const manual = bansToRestore(await listDecisions(), Date.now());
    let alerts = 0;
    for (let round = 0; round < 5; round++) {
      const left = await cscliJson<any[]>(['alerts', 'list', '--limit', '200'], 60_000);
      const scopes = new Set(
        (Array.isArray(left) ? left : [])
          .map((alert) => (typeof alert?.source?.scope === 'string' ? alert.source.scope : ''))
          .filter((scope) => scope !== '' && !KEPT_SCOPES.test(scope))
      );
      if (scopes.size === 0) break;
      for (const scope of scopes) {
        alerts += countIn(await cscliOk(['alerts', 'delete', '--scope', scope], 120_000), 'alert');
      }
    }

    const lost: string[] = [];
    for (const ban of manual) {
      const result = await cscli([
        'decisions',
        'add',
        ban.scope === 'ip' ? '--ip' : '--range',
        ban.value,
        '--duration',
        ban.duration,
        '--type',
        'ban',
        '--reason',
        ban.reason,
      ]).catch(() => null);
      if (!result || result.code !== 0) lost.push(ban.value);
    }
    forgetCrowdsecSummary();
    const kept = manual.length - lost.length;
    // Eine Sperre von Hand ist selbst ein Ereignis: es wurde entfernt und steht neu da, zählt also nicht.
    const removed = Math.max(0, alerts - kept);
    await audit(
      actor,
      'crowdsec_cleared',
      'crowdsec',
      `${removed} Ereignisse entfernt, ${lifted} Sperren aufgehoben, ${kept} Sperren von Hand behalten.` +
        (lost.length ? ` Nicht wieder gesetzt: ${lost.join(', ')}.` : '')
    );
    return { alerts: removed, lifted, kept, lost };
  } finally {
    clearState.__hapmCrowdsecClearing = false;
  }
}

/* ── Übersicht für Dashboard und Seite ── */

export interface CrowdsecSummary {
  inStack: boolean;
  running: boolean;
  bouncerRunning: boolean;
  /** `null`: CrowdSec läuft nicht, also unbekannt. */
  activeDecisions: number | null;
  alerts24h: number | null;
  waf24h: number | null;
  communityBlocklist: number | null;
  global: boolean | null;
  protectedServices: number;
  totalServices: number;
  topScenarios: { key: string; count: number }[];
  /** Die Fassungen laut `cscli`: die Abbilder tragen keine Versionsangabe. */
  version: string | null;
  bouncerVersion: string | null;
}

const summaryCache = globalThis as unknown as { __hapmCrowdsecSummary?: { at: number; value: CrowdsecSummary } };

/** Was CrowdSec schützt, aus `haproxy.cfg`: bei jedem Aufruf frisch, das ist nur eine Datei. */
function protectionSummary(): Pick<CrowdsecSummary, 'global' | 'protectedServices' | 'totalServices'> {
  const prot = protection();
  return { global: prot.global, protectedServices: prot.services.length, totalServices: prot.total };
}

/**
 * Kurz zwischengespeichert: das Dashboard fragt alle paar Sekunden, `cscli` ist
 * ein `exec`. Nicht im Speicher steht, welche Ziele geschützt sind: das ändert
 * ein Lauf am Reverse-Proxy, und die Übersicht soll es sofort zeigen, nicht
 * nach bis zu 30 Sekunden.
 */
export async function crowdsecSummary(): Promise<CrowdsecSummary> {
  const cached = summaryCache.__hapmCrowdsecSummary;
  if (cached && Date.now() - cached.at < 30_000) return { ...cached.value, ...protectionSummary() };

  const value: CrowdsecSummary = {
    inStack: crowdsecInstalled(),
    running: false,
    bouncerRunning: false,
    activeDecisions: null,
    alerts24h: null,
    waf24h: null,
    communityBlocklist: null,
    ...protectionSummary(),
    topScenarios: [],
    version: null,
    bouncerVersion: null,
  };
  if (value.inStack) {
    const [crowdsec, bouncer] = await Promise.all([
      containerInfo(crowdsecContainerName()).catch(() => null),
      containerInfo(bouncerContainerName()).catch(() => null),
    ]);
    value.running = Boolean(crowdsec?.running);
    value.bouncerRunning = Boolean(bouncer?.running);
    if (value.running) {
      try {
        const [alerts, decisions, community, version, bouncers] = await Promise.all([
          readAlerts(24, 2000),
          listDecisions(),
          communityBlocklistSize(),
          cscli(['version']).catch(() => null),
          cscliJson<any[]>(['bouncers', 'list']).catch(() => null),
        ]);
        value.version = version ? (/version:\s*v?([^\s-]+)/.exec(`${version.stdout}${version.stderr}`)?.[1] ?? null) : null;
        const own = Array.isArray(bouncers) ? bouncers.find((b) => b?.name === BOUNCER_NAME) : null;
        value.bouncerVersion = typeof own?.version === 'string' ? (/^v?([^-]+)/.exec(own.version)?.[1] ?? null) : null;
        const to = Date.now();
        const stats = crowdsecStats(alerts, [], to - 24 * 3_600_000, to);
        value.alerts24h = stats.totals.alerts;
        value.waf24h = stats.totals.waf;
        value.activeDecisions = decisions.length;
        value.communityBlocklist = community;
        value.topScenarios = stats.scenarios.slice(0, 3);
      } catch {
        // Bleibt unbekannt.
      }
    }
  }
  summaryCache.__hapmCrowdsecSummary = { at: Date.now(), value };
  return value;
}

export function forgetCrowdsecSummary(): void {
  summaryCache.__hapmCrowdsecSummary = undefined;
}

/* ── Regeln ── */

export async function crowdsecRules() {
  // Ohne `-a` nennt `hub list` nur, was installiert ist, aus allen Arten.
  const json = await cscliJson<any>(['hub', 'list']);
  const items = (type: string): any[] => (Array.isArray(json?.[type]) ? json[type] : []);
  const enabled = (type: string) =>
    new Set<string>(
      items(type)
        .filter((c: any) => String(c?.status ?? '').includes('enabled'))
        .map((c: any) => String(c.name))
    );
  const installed = enabled('collections');
  const parsers = enabled('parsers');
  const versions = new Map<string, string>(items('collections').map((c: any) => [String(c.name), String(c.local_version ?? '')]));
  const apps = APP_RULES.map((app) => {
    const parts = [
      ...app.hub.map((item) => (item.type === 'parsers' ? parsers : installed).has(item.name)),
      ...(app.local ? [appWhitelistPresent(app)] : []),
    ];
    const count = parts.filter(Boolean).length;
    return {
      id: app.id,
      label: app.label,
      hint: app.hint,
      kinds: app.kinds,
      items: [...app.hub.map((item) => item.name), ...(app.local ? [`hapm/${app.id}-allowlist`] : [])],
      installed: count === parts.length,
      partial: count > 0 && count < parts.length,
    };
  });
  return {
    apps,
    crs: currentCrsMode(),
    base: BASE_COLLECTIONS.map((name) => ({ name, installed: installed.has(name), version: versions.get(name) || null })),
    optional: OPTIONAL_COLLECTIONS.map((entry) => ({
      ...entry,
      installed: installed.has(entry.name),
      version: versions.get(entry.name) || null,
    })),
  };
}

/**
 * Die OWASP-Regeln schalten: Sammlung holen, Quellen umschreiben, CrowdSec neu
 * laden. Die Sammlung des anderen Modus bleibt liegen: sie wirkt nur, wenn die
 * Quellen sie nennen.
 */
export async function setCrsMode(body: unknown, actor: CrowdsecActor) {
  const mode = (body as Record<string, unknown> | null)?.crs;
  if (typeof mode !== 'string' || !CRS_MODES.includes(mode as CrsMode)) {
    throw new ApiError(msg('Diesen Modus gibt es nicht.'));
  }
  const crs = mode as CrsMode;
  if (crs !== 'off') {
    await cscliOk(['collections', 'install', CRS_COLLECTIONS[crs]], 180_000);
  }
  const files = writeCrowdsecFiles(crs);
  if (!files.mounted) throw new CrowdsecUnavailable();
  await reloadCrowdsec();
  forgetCrowdsecSummary();
  await audit(actor, 'crowdsec_rules_updated', 'crs', `OWASP-Regeln: ${crs}`);
  return { crs };
}

export async function setCollection(body: unknown, actor: CrowdsecActor) {
  const raw = (body ?? {}) as Record<string, unknown>;
  const entry = OPTIONAL_COLLECTIONS.find((c) => c.name === raw.name);
  if (!entry) throw new ApiError(msg('Diese Regelsammlung lässt sich hier nicht schalten.'), 404);
  // Fehlte das Feld, hieße das sonst „entfernen".
  if (typeof raw.installed !== 'boolean') throw new ApiError(msg('Erwartet wird installed: true oder false.'));
  const on = raw.installed;
  await cscliOk(['collections', on ? 'install' : 'remove', entry.name], 180_000);
  await reloadCrowdsec();
  await audit(actor, 'crowdsec_rules_updated', entry.name, `${entry.name}: ${on ? 'an' : 'aus'}`);
  return { name: entry.name, installed: on };
}

/**
 * Die Regeln einer Anwendung schalten: alles aus dem Hub installieren oder
 * entfernen, die eigene Whitelist schreiben oder löschen, CrowdSec neu starten.
 * Beim Entfernen bleibt, was noch eine andere Sammlung braucht (das regelt
 * `cscli`).
 */
export async function setApp(body: unknown, actor: CrowdsecActor) {
  const raw = (body ?? {}) as Record<string, unknown>;
  const app = APP_RULES.find((entry) => entry.id === raw.app);
  if (!app) throw new ApiError(msg('Für diese Anwendung gibt es hier keine Regeln.'), 404);
  if (typeof raw.installed !== 'boolean') throw new ApiError(msg('Erwartet wird installed: true oder false.'));
  const on = raw.installed;
  if (!crowdsecInstalled()) throw new CrowdsecUnavailable();
  try {
    for (const item of app.hub) {
      await cscliOk([item.type, on ? 'install' : 'remove', item.name], 180_000);
    }
    if (app.local) setAppWhitelist(app, on);
  } finally {
    // Auch nach einem Fehler mittendrin: was schon installiert oder entfernt
    // ist, soll geladen sein und nicht erst beim nächsten Neustart wirken.
    await reloadCrowdsec().catch(() => undefined);
  }
  await audit(actor, 'crowdsec_rules_updated', `app:${app.id}`, `${app.label}: ${on ? 'an' : 'aus'}`);
  return { app: app.id, installed: on };
}

/** Hub und Sammlungen auf den neuesten Stand bringen (`cscli hub update`, `hub upgrade`). */
export async function upgradeHub(actor: CrowdsecActor) {
  await cscliOk(['hub', 'update'], 120_000);
  const result = await cscliOk(['hub', 'upgrade'], 300_000);
  await reloadCrowdsec();
  await audit(actor, 'crowdsec_rules_updated', 'hub', 'Regeln aktualisiert.');
  return { output: `${result.stdout}${result.stderr}`.trim().slice(-2000) };
}

/* ── Log der Container ── */

export async function crowdsecLog(which: unknown, tail: unknown) {
  const name = which === 'bouncer' ? bouncerContainerName() : crowdsecContainerName();
  const lines = Math.min(2000, Math.max(50, Number(tail) || 300));
  const container = await engine.findContainer(name).catch(() => null);
  if (!container) return { container: name, exists: false, lines: [] as string[] };
  const text = await engine.logs(name, { tail: lines });
  return {
    container: name,
    exists: true,
    lines: text
      .split('\n')
      .map((line: string) => line.trimEnd())
      .filter(Boolean)
      .reverse(),
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/* ── Für Route, API und MCP gebündelt ── */

/** Die Kopfdaten der Seite: Container, welche Ziele CrowdSec prüft, Zahlen. */
export async function crowdsecOverview() {
  const [status, summary] = await Promise.all([crowdsecStatus(), crowdsecSummary()]);
  const prot = protection();
  return {
    status,
    summary,
    protection: prot,
    crs: currentCrsMode(),
  };
}

/* ── Ganz ein- und ausschalten ── */

/** So lange wartet der Schalter auf den Lauf am Reverse-Proxy: er kann hinter einem Zertifikat anstehen. */
const SWITCH_WAIT_MS = 30 * 60_000;

/** Was `haproxy.cfg` zu CrowdSec sagt. `missing`: es gibt die Datei nicht, also auch nichts zu entfernen. */
function configState(): 'missing' | 'unreadable' | 'in-use' | 'clean' {
  if (!fs.existsSync(HAPROXY_CFG)) return 'missing';
  const text = readConfig();
  if (text === null) return 'unreadable';
  return usesCrowdsec(text) ? 'in-use' : 'clean';
}

/**
 * Der Lauf, der CrowdSec aus `haproxy.cfg` nimmt, global und aus jedem Ziel.
 * `fromFile`: alles andere bleibt, wie es beim Lauf in der Datei steht.
 */
async function startRemovalRun(actor: CrowdsecActor): Promise<string> {
  const server = localServer();
  const settings = { httpsLines: [], adminIps: [], fromFile: true, crowdsec: false, crowdsecRemoveAll: true };
  try {
    await precheckSettings(server, settings);
  } catch (err) {
    if (err instanceof HaproxyConfigError) throw new ApiError(err, 409);
    throw err;
  }
  const run = await startHaproxyRun({
    server,
    action: 'settings',
    serviceId: 'globale-einstellungen',
    settings,
    actor: { userId: actor.userId, email: actor.userEmail, ip: actor.ip ?? null },
  });
  return run.$id;
}

const stopState = globalThis as unknown as { __hapmCrowdsecStopping?: Promise<void> | null };

/**
 * Beide Container anhalten. Das dauert bis zu einer halben Minute je Container
 * und läuft deshalb oft im Hintergrund weiter. Solange es läuft, lässt sich
 * nicht wieder einschalten (`stopState`): ein Start mitten im Anhalten scheitert.
 */
function stopCrowdsecContainers(): Promise<void> {
  const run = (async () => {
    for (const name of [bouncerContainerName(), crowdsecContainerName()]) {
      await engine.stop(name).catch(() => undefined);
    }
  })();
  const tracked = run.finally(() => {
    if (stopState.__hapmCrowdsecStopping === tracked) stopState.__hapmCrowdsecStopping = null;
  });
  stopState.__hapmCrowdsecStopping = tracked;
  return tracked;
}

/**
 * Das Abschalten zu Ende bringen, wenn der Lauf fertig ist. Was zählt, steht
 * in der Datei und nicht im Status des Laufs: nur wenn `haproxy.cfg` CrowdSec
 * nicht mehr nennt, halten die Container an. Sonst bleibt alles an.
 */
async function finishSwitchOff(runId: string, actor: CrowdsecActor, stop: boolean): Promise<void> {
  try {
    const deadline = Date.now() + SWITCH_WAIT_MS;
    let run = await waitForRun(runId, 60_000);
    while (run.status === 'running' && Date.now() < deadline) run = await waitForRun(runId, 60_000);
    if (configState() !== 'clean') return;
    if (stop) {
      setDisabledMarker(true);
      await stopCrowdsecContainers();
    }
    forgetCrowdsecSummary();
    await audit(actor, 'crowdsec_switched', 'crowdsec', stop ? 'CrowdSec: aus' : 'CrowdSec aus haproxy.cfg entfernt');
  } catch (err) {
    console.error(`[crowdsec] Abschalten nicht abgeschlossen: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    setCrowdsecSwitchingOff(false);
  }
}

/**
 * CrowdSec ganz abschalten oder wieder einschalten.
 *
 * Aus: ein Lauf am Reverse-Proxy nimmt CrowdSec aus `haproxy.cfg` (global und
 * aus jedem Ziel, mit Prüfung und Reload). Die Antwort kommt sofort mit
 * `pending: true` und der Kennung des Laufs: er kann hinter einem anderen
 * anstehen, und eine Anfrage, die so lange wartet, schnitte HAProxy ab. Ist er
 * durch, hält HAPM beide Container an und setzt die Marke (`finishSwitchOff`).
 * Scheitert er, bleibt alles, wie es war: eine Konfiguration, die einen
 * angehaltenen Bouncer fragt, bremste jede Anfrage, ohne dass es jemand sieht.
 * Solange das läuft, nimmt kein Ziel CrowdSec neu auf (`crowdsecUsable`).
 *
 * Auch wo CrowdSec gar nicht im Stack ist, lässt es sich so aus der Datei
 * nehmen (nach `install.sh --no-crowdsec` auf einer Installation, die es benutzt hat).
 *
 * An: Marke weg, Dateien schreiben, beide Container starten. Startet einer
 * nicht, bleibt CrowdSec abgeschaltet. Welche Ziele geprüft werden, bleibt aus.
 */
export async function setCrowdsecEnabled(body: unknown, actor: CrowdsecActor) {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (typeof raw.enabled !== 'boolean') throw new ApiError(msg('Erwartet wird enabled: true oder false.'));
  if (crowdsecSwitchingOff()) {
    throw new ApiError(msg('CrowdSec wird gerade abgeschaltet. Bitte warten, bis der Vorgang fertig ist.'), 409);
  }
  const present = crowdsecPresent();
  const absent = () => new ApiError(msg('CrowdSec ist auf dieser Installation nicht vorhanden.'), 409);

  if (raw.enabled) {
    if (!present) throw absent();
    // Eben erst abgeschaltet: die Container halten noch an, ein Start mittendrin
    // scheiterte. Darauf zu warten dauerte länger, als HAProxy eine Anfrage hält.
    if (stopState.__hapmCrowdsecStopping) {
      throw new ApiError(msg('CrowdSec hält gerade noch an. Bitte in einer Minute noch einmal einschalten.'), 409);
    }
    setDisabledMarker(false);
    writeCrowdsecFiles();
    const failed: string[] = [];
    for (const name of [crowdsecContainerName(), bouncerContainerName()]) {
      await engine.start(name).catch(() => {
        failed.push(name);
      });
    }
    if (failed.length > 0) {
      setDisabledMarker(true);
      // Im Hintergrund: die Antwort mit dem Grund soll nicht auf das Anhalten warten.
      void stopCrowdsecContainers();
      throw new ApiError(
        msg('{names} ließ sich nicht starten, CrowdSec bleibt abgeschaltet. Auf dem Server legt docker compose up -d im Ordner der Installation die Container an.', {
          names: failed.join(', '),
        }),
        409
      );
    }
    forgetCrowdsecSummary();
    await audit(actor, 'crowdsec_switched', 'crowdsec', 'CrowdSec: an');
    return { enabled: true, runId: null, pending: false };
  }

  const state = configState();
  if (state === 'unreadable') {
    throw new ApiError(msg('{file} ist nicht lesbar. CrowdSec bleibt an.', { file: HAPROXY_CFG }), 409);
  }
  if (state === 'in-use') {
    setCrowdsecSwitchingOff(true);
    let runId: string;
    try {
      runId = await startRemovalRun(actor);
    } catch (err) {
      setCrowdsecSwitchingOff(false);
      throw err;
    }
    void finishSwitchOff(runId, actor, present);
    return { enabled: false, runId, pending: true };
  }
  if (!present) throw absent();
  setDisabledMarker(true);
  // Das Anhalten wartet bis zu einer halben Minute je Container: nicht in der Anfrage.
  void stopCrowdsecContainers();
  forgetCrowdsecSummary();
  await audit(actor, 'crowdsec_switched', 'crowdsec', 'CrowdSec: aus');
  return { enabled: false, runId: null, pending: false };
}

const orphanAttempt = globalThis as unknown as { __hapmCrowdsecOrphanAt?: number };

/**
 * CrowdSec ist nicht eingeschaltet (abgewählt oder abgeschaltet), `haproxy.cfg`
 * fragt den Bouncer aber noch: nach `install.sh --no-crowdsec` ohne vorheriges
 * Ausschalten, oder nach dem Zurückspielen einer älteren Sicherung. HAProxy
 * wartete dann bei jeder Anfrage auf eine Antwort, die nie kommt. Der Abgleich
 * im Scheduler nimmt es deshalb selbst heraus. Höchstens alle sechs Stunden ein
 * Versuch, damit ein Lauf, der scheitert, nicht die Historie füllt.
 */
export async function dropOrphanedCrowdsec(actor: CrowdsecActor): Promise<string | null> {
  if (crowdsecInstalled() || crowdsecSwitchingOff() || configState() !== 'in-use') return null;
  const last = orphanAttempt.__hapmCrowdsecOrphanAt ?? 0;
  if (Date.now() - last < 6 * 3_600_000) return null;
  orphanAttempt.__hapmCrowdsecOrphanAt = Date.now();
  setCrowdsecSwitchingOff(true);
  try {
    const runId = await startRemovalRun(actor);
    void finishSwitchOff(runId, actor, false);
    return `CrowdSec ist nicht eingeschaltet, steht aber in haproxy.cfg. Lauf ${runId} nimmt es heraus.`;
  } catch (err) {
    setCrowdsecSwitchingOff(false);
    throw err;
  }
}

/** Eine Änderung an den Regeln: OWASP-Modus, eine Sammlung oder der Hub. */
export async function changeRules(body: unknown, actor: CrowdsecActor) {
  const raw = (body ?? {}) as Record<string, unknown>;
  if ('crs' in raw) return setCrsMode(raw, actor);
  if (raw.upgrade === true) return upgradeHub(actor);
  if (typeof raw.app === 'string') return setApp(raw, actor);
  if (typeof raw.name === 'string') return setCollection(raw, actor);
  throw new ApiError(msg('Was soll sich ändern? Erwartet wird crs, app oder name mit installed, oder upgrade.'));
}
