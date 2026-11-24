/**
 * Alles, was die Übersicht zeigt, in einer Antwort.
 *
 * Jeder Teil wird einzeln gefragt und einzeln abgesichert: ist der Docker-Socket
 * weg, stehen Ziele und Zertifikate trotzdem da, und umgekehrt. Was nicht zu
 * erfahren war, ist `null` und wird als „unbekannt" gezeigt. Eine Null steht
 * nur dort, wo wirklich gezählt wurde.
 */

import fs from 'node:fs';
import pkg from '../../package.json';
import { listDocuments, Query } from '../db';
import { COLLECTIONS, type HaproxyAction, type HaproxyRun, type RunStatus, type UpdateState } from '../types';
import { localServer } from '../helpers';
import { containerInfo, dockerAvailable, haproxyContainerName, ownContainer } from '../docker';
import { acmeStatus } from '../acme';
import { bootstrapState, type BootstrapState } from '../bootstrap';
import { schedulerStatus } from '../scheduler';
import { logFollowerStatus } from '../haproxy-log';
import { probeProxy, readCertificates, type ProxyProbe } from '../haproxy/provision';
import { HAPROXY_CERT_DIR, parseScopes, scopeSlug, serviceHealth, type ServiceHealth } from '../haproxy/config';
import { pemFileName, type AcmeCertificate } from '../haproxy/certs';
import { CERT_WARN_DAYS, certificateDue, pemExpiry, type CertificateDue } from './certificates';
import { readUpdateStates } from '../updates/check';
import { msgid } from '../i18n';

export type { CertificateDue } from './certificates';

export interface SystemDocker {
  available: boolean;
  version: string | null;
  error: string | null;
}

export interface SystemContainer {
  name: string;
  /** `null` heißt: die Engine war nicht zu fragen. */
  exists: boolean | null;
  running: boolean | null;
  status: string | null;
  health: string | null;
  version: string | null;
  image: string | null;
  startedAt: string | null;
  restartCount: number | null;
  error: string | null;
}

export interface SystemHapm {
  version: string;
  /** `false` auf einem Entwicklungsrechner: dann gibt es kein Abbild und kein Update. */
  containerized: boolean;
  image: string | null;
  startedAt: string | null;
  nodeName: string;
}

export interface SystemAcme {
  /** `null` heißt: acme.sh war nicht zu fragen. */
  installed: boolean | null;
  version: string | null;
  accountEmail: string | null;
  error: string | null;
}

export interface SystemScheduler {
  started: boolean;
  lastStatsRun: string | null;
  lastStatsError: string | null;
  lastDailyRun: string | null;
  /** Die Ausgabe steht nur bei einem Fehlschlag dabei. */
  lastRenewal: { at: string; ok: boolean; output: string | null } | null;
}

export interface SystemLogFollower {
  connected: boolean;
  lines: number;
  last: string | null;
}

export interface UnhealthyTarget {
  id: string;
  kind: 'service' | 'stream';
  health: Extract<ServiceHealth, 'down' | 'partial'>;
  /** Adressteil der Gruppe. `null` bei einem von Hand gepflegten Eintrag. */
  slug: string | null;
}

export interface SystemProxy {
  /** `null` heißt: die Konfiguration war nicht zu lesen. */
  services: number | null;
  scopes: number | null;
  streams: number | null;
  /** Ziele und Weiterleitungen, über deren Backends HAProxy etwas weiß. */
  checked: number | null;
  /** Davon ohne ein einziges erreichbares Backend. `null`, wenn nichts geprüft wird. */
  down: number | null;
  /** Davon mit einem Teil der Backends. */
  partial: number | null;
  unhealthy: UnhealthyTarget[];
  error: string | null;
}

export interface SystemCertificates {
  /** `null` heißt: acme.sh war nicht zu fragen. */
  total: number | null;
  /** Unter `CERT_WARN_DAYS` Tagen. `null`, wenn kein Ablaufdatum lesbar war. */
  expiring: number | null;
  /** Zertifikate, deren Ablaufdatum nicht lesbar war. */
  unreadable: number;
  /** Was Aufmerksamkeit braucht: läuft bald ab oder die Erneuerung ist überfällig. */
  due: CertificateDue[];
  warnDays: number;
  error: string | null;
}

export interface SystemRun {
  $id: string;
  serviceId: string;
  action: HaproxyAction;
  status: RunStatus;
  startedAt: string;
  duration: number | null;
  triggeredBy: string | null;
  error: string | null;
}

export interface SystemRuns {
  /** `null` heißt: die Historie war nicht zu lesen. */
  recent: SystemRun[] | null;
  running: number | null;
  /** Fehlgeschlagen, nicht abgehakt, und seither kein neuer Lauf für denselben Eintrag. */
  failed: number | null;
}

export interface SystemOverview {
  generatedAt: string;
  docker: SystemDocker;
  haproxy: SystemContainer;
  hapm: SystemHapm;
  acme: SystemAcme;
  bootstrap: BootstrapState;
  scheduler: SystemScheduler;
  logFollower: SystemLogFollower;
  proxy: SystemProxy;
  certificates: SystemCertificates;
  runs: SystemRuns;
  /** `null` heißt: der Stand der Updates war nicht zu lesen. */
  updates: UpdateState[] | null;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readDocker(): Promise<SystemDocker> {
  const result = await dockerAvailable();
  return result.ok
    ? { available: true, version: result.version, error: null }
    : { available: false, version: null, error: result.error };
}

async function readHaproxy(): Promise<SystemContainer> {
  const name = haproxyContainerName();
  const unknown: SystemContainer = {
    name,
    exists: null,
    running: null,
    status: null,
    health: null,
    version: null,
    image: null,
    startedAt: null,
    restartCount: null,
    error: null,
  };
  try {
    const info = await containerInfo(name);
    if (!info) return { ...unknown, exists: false, running: false };
    return {
      name: info.name,
      exists: true,
      running: info.running,
      status: info.status,
      health: info.health,
      version: info.version,
      image: info.reference || null,
      startedAt: info.startedAt,
      restartCount: info.restartCount,
      error: null,
    };
  } catch (err) {
    return { ...unknown, error: message(err) };
  }
}

async function readHapm(): Promise<SystemHapm> {
  const base: SystemHapm = {
    version: pkg.version,
    containerized: false,
    image: null,
    startedAt: null,
    nodeName: localServer().name,
  };
  try {
    const own = ownContainer();
    if (!own) return base;
    const info = await containerInfo(own);
    if (!info) return { ...base, containerized: true };
    return {
      ...base,
      version: info.version ?? pkg.version,
      containerized: true,
      image: info.reference || null,
      startedAt: info.startedAt,
    };
  } catch {
    return base;
  }
}

async function readAcme(): Promise<SystemAcme> {
  try {
    const status = await acmeStatus();
    return { installed: status.installed, version: status.version, accountEmail: status.accountEmail, error: null };
  } catch (err) {
    return { installed: null, version: null, accountEmail: null, error: message(err) };
  }
}

function readScheduler(): SystemScheduler {
  const status = schedulerStatus();
  return {
    started: status.started,
    lastStatsRun: status.lastStatsRun,
    lastStatsError: status.lastStatsError,
    lastDailyRun: status.lastDailyRun,
    lastRenewal: status.lastRenewal
      ? {
          at: status.lastRenewal.at,
          ok: status.lastRenewal.ok,
          output: status.lastRenewal.ok ? null : status.lastRenewal.output.trim().slice(-1500),
        }
      : null,
  };
}

const PROXY_UNKNOWN: Omit<SystemProxy, 'error'> = {
  services: null,
  scopes: null,
  streams: null,
  checked: null,
  down: null,
  partial: null,
  unhealthy: [],
};

function summarizeProxy(probe: ProxyProbe): SystemProxy {
  if (!probe.configReadable) {
    return { ...PROXY_UNKNOWN, error: msgid('Die HAProxy-Konfiguration ist nicht lesbar.') };
  }

  const targets = [
    ...probe.services.map((service) => ({
      id: service.id,
      kind: 'service' as const,
      scope: service.scope,
      health: serviceHealth(service, probe.serverStates),
    })),
    ...probe.streams.map((stream) => ({
      id: stream.id,
      kind: 'stream' as const,
      scope: stream.scope,
      health: serviceHealth({ id: stream.id, routes: [] }, probe.serverStates),
    })),
  ];
  const checked = targets.filter((target) => target.health !== 'unknown');
  const unhealthy: UnhealthyTarget[] = [];
  for (const target of checked) {
    if (target.health === 'down' || target.health === 'partial') {
      unhealthy.push({
        id: target.id,
        kind: target.kind,
        health: target.health,
        slug: target.scope ? scopeSlug(target.scope) : null,
      });
    }
  }

  // Ohne ein geprüftes Backend ist über den Zustand nichts bekannt. Das ist nicht „keins tot".
  const known = checked.length > 0 || targets.length === 0;
  return {
    services: probe.services.length,
    scopes: parseScopes(probe.raw).length,
    streams: probe.streams.length,
    checked: checked.length,
    down: known ? unhealthy.filter((target) => target.health === 'down').length : null,
    partial: known ? unhealthy.filter((target) => target.health === 'partial').length : null,
    unhealthy,
    error: null,
  };
}

function readExpiry(mainDomain: string): Date | null {
  try {
    return pemExpiry(fs.readFileSync(`${HAPROXY_CERT_DIR}/${pemFileName(mainDomain)}`, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * `acme.sh --list` läuft über jedes Domainverzeichnis, und die Übersicht fragt
 * alle paar Sekunden. Die Liste gilt deshalb zwei Minuten.
 */
const CERT_CACHE_MS = 2 * 60 * 1000;
const certCache = globalThis as unknown as { __hapmCertList?: { at: number; list: AcmeCertificate[] } };

async function cachedCertificates(): Promise<AcmeCertificate[]> {
  const cached = certCache.__hapmCertList;
  if (cached && Date.now() - cached.at < CERT_CACHE_MS) return cached.list;
  const list = await readCertificates(localServer());
  // Eine leere Liste kann auch ein gescheiterter Aufruf sein. Sie wird nicht aufgehoben.
  if (list.length > 0) certCache.__hapmCertList = { at: Date.now(), list };
  return list;
}

async function readCertificateSummary(probe: Promise<ProxyProbe>): Promise<SystemCertificates> {
  const unknown: SystemCertificates = {
    total: null,
    expiring: null,
    unreadable: 0,
    due: [],
    warnDays: CERT_WARN_DAYS,
    error: null,
  };
  try {
    // Ohne acme.sh ist die Liste leer, weil nicht gefragt werden konnte.
    if (!(await probe).acmeReady) {
      return { ...unknown, error: msgid('acme.sh oder das Zertifikatsverzeichnis fehlt.') };
    }
    const now = Date.now();
    const all = (await cachedCertificates()).map((cert) => certificateDue(cert, readExpiry(cert.mainDomain), now));
    const readable = all.filter((cert) => cert.daysLeft !== null);
    return {
      total: all.length,
      expiring:
        all.length > 0 && readable.length === 0
          ? null
          : readable.filter((cert) => (cert.daysLeft as number) < CERT_WARN_DAYS).length,
      unreadable: all.length - readable.length,
      due: all
        .filter((cert) => cert.renewalOverdue || (cert.daysLeft !== null && cert.daysLeft < CERT_WARN_DAYS))
        .sort((a, b) => (a.daysLeft ?? Number.MAX_SAFE_INTEGER) - (b.daysLeft ?? Number.MAX_SAFE_INTEGER)),
      warnDays: CERT_WARN_DAYS,
      error: null,
    };
  } catch (err) {
    return { ...unknown, error: message(err) };
  }
}

/** So viele Läufe zurück wird nach offenen Fehlschlägen gesehen. */
const RUN_WINDOW = 25;

async function readRuns(): Promise<SystemRuns> {
  try {
    const runs = await listDocuments<HaproxyRun>(COLLECTIONS.HAPROXY_RUNS, [
      Query.orderDesc('startedAt'),
      Query.limit(RUN_WINDOW),
    ]);

    // Ein Fehlschlag zählt nur, solange er der letzte Lauf für seinen Eintrag ist.
    const latest = new Map<string, HaproxyRun>();
    for (const run of runs) {
      if (!latest.has(run.serviceId)) latest.set(run.serviceId, run);
    }

    return {
      recent: runs.slice(0, 5).map((run) => ({
        $id: run.$id,
        serviceId: run.serviceId,
        action: run.action,
        status: run.status,
        startedAt: run.startedAt,
        duration: run.duration,
        triggeredBy: run.triggeredBy,
        error: run.error?.split('\n')[0] ?? null,
      })),
      running: runs.filter((run) => run.status === 'running').length,
      failed: [...latest.values()].filter((run) => run.status === 'error' && !run.acknowledged).length,
    };
  } catch {
    return { recent: null, running: null, failed: null };
  }
}

export async function systemOverview(): Promise<SystemOverview> {
  const probe = probeProxy(localServer());
  // Zwei Teile hängen an derselben Probe. Ihr Fehler wird je Teil gemeldet, nicht hier.
  probe.catch(() => undefined);

  const [docker, haproxy, hapm, acme, proxy, certificates, runs, updates] = await Promise.all([
    readDocker(),
    readHaproxy(),
    readHapm(),
    readAcme(),
    probe.then(summarizeProxy).catch((err): SystemProxy => ({ ...PROXY_UNKNOWN, error: message(err) })),
    readCertificateSummary(probe),
    readRuns(),
    readUpdateStates().catch(() => null),
  ]);

  return {
    generatedAt: new Date().toISOString(),
    docker,
    haproxy,
    hapm,
    acme,
    bootstrap: bootstrapState(),
    scheduler: readScheduler(),
    logFollower: logFollowerStatus(),
    proxy,
    certificates,
    runs,
    updates,
  };
}
