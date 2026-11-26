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
import { HAPROXY_CFG, parseHaproxyConfig, parseCrowdsecGlobal, type HaproxyService } from '../haproxy/config';
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
  crowdsecInStack,
  BOUNCER_NAME,
} from './paths';
import {
  ALLOW_DURATIONS,
  BAN_DURATIONS,
  alertTargetId,
  cleanNote,
  crowdsecStats,
  parseAddress,
  parseAlerts,
  parseAllowlist,
  parseDecisions,
  type AlertTarget,
  type CrowdsecAlert,
} from './data';
import { currentCrsMode, ensureAllowlist, reloadCrowdsec, writeCrowdsecFiles } from './setup';
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
  /** Ob der Stack CrowdSec mitbringt (nicht `HAPM_CROWDSEC_OFF`). */
  inStack: boolean;
  crowdsec: ContainerInfo | null;
  bouncer: ContainerInfo | null;
  /** `cscli version`, oder `null`, wenn nicht zu erfahren. */
  version: string | null;
  /** Ob die lokale API antwortet. `null`: nicht gefragt (Container läuft nicht). */
  lapi: boolean | null;
  /** Wann der Bouncer zuletzt Sperren geholt hat. `null`: nicht angemeldet oder unbekannt. */
  bouncerLastPull: string | null;
  bouncerRegistered: boolean | null;
  error: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- Ausgabe von cscli */
export async function crowdsecStatus(): Promise<CrowdsecStatus> {
  const status: CrowdsecStatus = {
    inStack: crowdsecInStack(),
    crowdsec: null,
    bouncer: null,
    version: null,
    lapi: null,
    bouncerLastPull: null,
    bouncerRegistered: null,
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

export async function addDecision(body: unknown, actor: CrowdsecActor) {
  const raw = (body ?? {}) as Record<string, unknown>;
  const address = parseAddress(String(raw.value ?? ''));
  if (!address) throw new ApiError(msg('Bitte eine Adresse oder ein Netz angeben, etwa 203.0.113.7 oder 198.51.100.0/24.'));
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
  const alerts: CrowdsecAlertRow[] = (await readAlerts(hours, options.limit ?? 500)).map((alert) => ({
    ...alert,
    targetId: alertTargetId(alert, targets),
  }));
  return {
    window: key,
    service,
    alerts: service ? alerts.filter((alert) => alert.targetId === service) : alerts,
  };
}

export async function crowdsecStatistics(window: unknown) {
  const { key, hours } = readWindow(window);
  const targets = targetsOf(parseHaproxyConfig(readConfig() ?? ''));
  const alerts = await readAlerts(hours, 5000);
  const to = Date.now();
  const [decisions, community] = await Promise.all([
    listDecisions().catch(() => null),
    communityBlocklistSize(),
  ]);
  return {
    window: key,
    stats: crowdsecStats(alerts, targets, to - hours * 3_600_000, to),
    activeDecisions: decisions?.length ?? null,
    communityBlocklist: community,
  };
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

/** Kurz zwischengespeichert: das Dashboard fragt alle paar Sekunden, `cscli` ist ein `exec`. */
export async function crowdsecSummary(): Promise<CrowdsecSummary> {
  const cached = summaryCache.__hapmCrowdsecSummary;
  if (cached && Date.now() - cached.at < 30_000) return cached.value;

  const prot = protection();
  const value: CrowdsecSummary = {
    inStack: crowdsecInStack(),
    running: false,
    bouncerRunning: false,
    activeDecisions: null,
    alerts24h: null,
    waf24h: null,
    communityBlocklist: null,
    global: prot.global,
    protectedServices: prot.services.length,
    totalServices: prot.total,
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
  const json = await cscliJson<any>(['collections', 'list']);
  const installed = new Set<string>(
    (Array.isArray(json?.collections) ? json.collections : [])
      .filter((c: any) => String(c?.status ?? '').includes('enabled'))
      .map((c: any) => String(c.name))
  );
  const versions = new Map<string, string>(
    (Array.isArray(json?.collections) ? json.collections : []).map((c: any) => [String(c.name), String(c.local_version ?? '')])
  );
  return {
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
  const on = raw.installed === true;
  await cscliOk(['collections', on ? 'install' : 'remove', entry.name], 180_000);
  await reloadCrowdsec();
  await audit(actor, 'crowdsec_rules_updated', entry.name, `${entry.name}: ${on ? 'an' : 'aus'}`);
  return { name: entry.name, installed: on };
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

/** Eine Änderung an den Regeln: OWASP-Modus, eine Sammlung oder der Hub. */
export async function changeRules(body: unknown, actor: CrowdsecActor) {
  const raw = (body ?? {}) as Record<string, unknown>;
  if ('crs' in raw) return setCrsMode(raw, actor);
  if (raw.upgrade === true) return upgradeHub(actor);
  if (typeof raw.name === 'string') return setCollection(raw, actor);
  throw new ApiError(msg('Was soll sich ändern? Erwartet wird crs, name mit installed oder upgrade.'));
}
