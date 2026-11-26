/**
 * Die Prüfungen, die selbst nach etwas sehen: läuft HAProxy, antworten die
 * Ziele, läuft ein Zertifikat ab. Der Scheduler ruft sie auf, alles Weitere
 * (Schalter, Empfänger, Dämpfung) entscheidet `notify`.
 *
 * Keine der beiden Funktionen wirft. Was nicht zu erfahren war, ist unbekannt
 * und löst nichts aus: ein Docker-Socket, der nicht antwortet, ist kein
 * HAProxy, das nicht läuft.
 */

import fs from 'node:fs';
import { localServer } from '../helpers';
import { containerInfo, haproxyContainerName } from '../docker';
import { probeProxy, readBackendCas, readCertificateInventory } from '../haproxy/provision';
import { CA_WARN_DAYS, caDaysLeft, caUsers } from '../haproxy/backend-ca';
import { HAPROXY_CERT_DIR, serviceHealth, type BackendServerState, type HaproxyRoute } from '../haproxy/config';
import { pemFileName } from '../haproxy/certs';
import { CERT_WARN_DAYS, UPLOAD_WARN_DAYS, certificateDue, pemExpiry, uploadedDue } from '../system/certificates';
import { crowdsecStatistics, protection } from '../crowdsec/actions';
import { bouncerContainerName, crowdsecContainerName, crowdsecInstalled } from '../crowdsec/paths';
import { notify } from './index';
import { pruneStates, resolveState } from './state';
import { advanceStreaks, type Observed, type Streak } from './streaks';
import type { ExpiringAuthority, ExpiringCertificate, TargetKind } from './events';

/** Der Takt der Prüfung von HAProxy und seinen Zielen. Gemeldet wird nach zwei Runden. */
export const HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000;

interface CheckState {
  running: boolean;
  haproxy: Map<string, Streak>;
  targets: Map<string, Streak>;
  crowdsec: Map<string, Streak>;
}

const globalState = globalThis as unknown as { __hapmNotifyChecks?: CheckState };

function state(): CheckState {
  const s = (globalState.__hapmNotifyChecks ??= { running: false, haproxy: new Map(), targets: new Map(), crowdsec: new Map() });
  // Ein Zustand aus der Zeit vor CrowdSec (Neuladen im Betrieb) kennt das Feld nicht.
  s.crowdsec ??= new Map();
  return s;
}

function log(text: string, err: unknown): void {
  console.error(`[notify] ${text}: ${err instanceof Error ? err.message : String(err)}`);
}

/** `false` heißt: HAProxy läuft nicht oder sein Zustand ist unbekannt. Dann sagen auch die Ziele nichts. */
async function checkHaproxy(now: string): Promise<boolean> {
  const s = state();
  const name = haproxyContainerName();

  let info;
  try {
    info = await containerInfo(name);
  } catch {
    s.haproxy = new Map();
    return false;
  }

  const running = Boolean(info?.running);
  const step = advanceStreaks(s.haproxy, new Map<string, Observed>([[name, running ? 'up' : 'down']]), now);
  s.haproxy = step.streaks;
  for (const entry of step.down) {
    await notify({
      type: 'haproxy_down',
      container: name,
      exists: info !== null,
      status: info?.status ?? null,
      since: entry.since,
    });
  }
  return running;
}

interface Target {
  kind: TargetKind;
  id: string;
  addresses: string[];
  targets: string[];
  up: number;
  total: number;
}

function counts(backends: string[], states: BackendServerState[]): { up: number; total: number } {
  const own = new Set(backends);
  const relevant = states.filter((entry) => own.has(entry.backend) && entry.status !== 'no check');
  return { up: relevant.filter((entry) => entry.status.startsWith('UP')).length, total: relevant.length };
}

async function checkTargets(now: string): Promise<void> {
  const s = state();
  const probe = await probeProxy(localServer());
  if (!probe.configReadable) {
    s.targets = new Map();
    return;
  }

  const known = new Map<string, Target>();
  const observations = new Map<string, Observed>();
  const observe = (target: Omit<Target, 'up' | 'total'>, backends: string[], routes: HaproxyRoute[]) => {
    const health = serviceHealth({ id: target.id, routes }, probe.serverStates);
    if (health === 'unknown') return;
    const key = `${target.kind}:${target.id}`;
    known.set(key, { ...target, ...counts(backends, probe.serverStates) });
    observations.set(key, health === 'down' ? 'down' : 'up');
  };

  for (const service of probe.services) {
    observe(
      {
        kind: 'service',
        id: service.id,
        addresses: service.domains,
        targets: [
          ...service.servers.map((server) => server.target),
          ...service.routes.flatMap((route) => route.servers.map((server) => server.target)),
        ],
      },
      [service.id, ...service.routes.map((route) => route.backend)],
      service.routes
    );
  }
  for (const stream of probe.streams) {
    observe(
      {
        kind: 'stream',
        id: stream.id,
        addresses: stream.port === null ? [] : [`Port ${stream.port}`],
        targets: stream.servers.map((server) => server.target),
      },
      [stream.id],
      []
    );
  }

  const step = advanceStreaks(s.targets, observations, now);
  s.targets = step.streaks;

  for (const entry of step.down) {
    const target = known.get(entry.id);
    if (!target) continue;
    await notify({
      type: 'backend_down',
      kind: target.kind,
      id: target.id,
      addresses: target.addresses,
      targets: target.targets,
      since: entry.since,
    });
  }

  for (const key of step.recovered) {
    const target = known.get(key);
    if (!target) continue;
    // Entwarnung nur, wenn der Ausfall auch gemeldet wurde.
    const announced = await resolveState('backend_down', key, now);
    if (!announced) continue;
    await notify({
      type: 'backend_recovered',
      kind: target.kind,
      id: target.id,
      addresses: target.addresses,
      up: target.up,
      total: target.total,
      downSince: announced.lastSentAt,
    });
  }
}

/**
 * Laufen CrowdSec und der Bouncer, solange ein Ziel geschützt sein soll. Prüft
 * niemand, lässt HAProxy die Anfragen durch: genau das soll nicht unbemerkt
 * bleiben. Schützt CrowdSec nichts, ist ein gestoppter Container kein Ereignis.
 */
async function checkCrowdsec(now: string): Promise<void> {
  const s = state();
  const scope = protection();
  // `inUse` und nicht die gelesenen Schalter: auch ein von Hand geänderter Block fragt den Bouncer.
  if (!crowdsecInstalled() || !scope.readable || !scope.inUse) {
    s.crowdsec = new Map();
    return;
  }

  const containers = [
    { role: 'crowdsec' as const, name: crowdsecContainerName() },
    { role: 'bouncer' as const, name: bouncerContainerName() },
  ];
  let infos;
  try {
    infos = await Promise.all(containers.map((container) => containerInfo(container.name)));
  } catch {
    s.crowdsec = new Map();
    return;
  }

  const observations = new Map<string, Observed>(
    containers.map((container, index) => [container.name, infos[index]?.running ? 'up' : 'down'])
  );
  const step = advanceStreaks(s.crowdsec, observations, now);
  s.crowdsec = step.streaks;
  for (const entry of step.down) {
    const index = containers.findIndex((container) => container.name === entry.id);
    if (index < 0) continue;
    await notify({
      type: 'crowdsec_down',
      role: containers[index].role,
      container: entry.id,
      exists: infos[index] !== null,
      status: infos[index]?.status ?? null,
      since: entry.since,
      global: scope.global === true,
      protectedServices: scope.services.length,
    });
  }
}

/** Was CrowdSec in den letzten 24 Stunden gemeldet hat, als eine Mail. Nichts gemeldet: keine Mail. */
async function crowdsecReport(): Promise<void> {
  if (!crowdsecInstalled()) return;
  const result = await crowdsecStatistics('24h');
  const { stats } = result;
  if (stats.totals.alerts === 0) return;
  await notify({
    type: 'crowdsec_report',
    from: stats.from,
    to: stats.to,
    totals: stats.totals,
    activeDecisions: result.activeDecisions,
    scenarios: stats.scenarios,
    sources: stats.sources,
    targets: stats.targets,
  });
}

/** Alle zwei Minuten: läuft HAProxy, antworten die Ziele, prüft CrowdSec. */
export async function runHealthChecks(): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    const now = new Date().toISOString();
    if (await checkHaproxy(now)) await checkTargets(now);
    else s.targets = new Map();
    await checkCrowdsec(now);
  } catch (err) {
    log('Prüfung von HAProxy und Zielen gescheitert', err);
  } finally {
    s.running = false;
  }
}

async function expiringCertificates(now: number): Promise<ExpiringCertificate[]> {
  const out: ExpiringCertificate[] = [];
  const inventory = await readCertificateInventory(localServer());
  // Hochgeladene erneuert niemand: die Erinnerung ist alles, was es für sie gibt.
  for (const cert of inventory.uploaded) {
    const due = uploadedDue(cert, now);
    if (due.expiresAt !== null && due.daysLeft !== null && due.daysLeft < UPLOAD_WARN_DAYS) {
      out.push({ mainDomain: due.mainDomain, expiresAt: due.expiresAt, daysLeft: due.daysLeft, uploaded: true });
    }
  }
  for (const cert of inventory.acme) {
    let expiry: Date | null = null;
    try {
      expiry = pemExpiry(fs.readFileSync(`${HAPROXY_CERT_DIR}/${pemFileName(cert.mainDomain)}`, 'utf8'));
    } catch {
      // Nicht lesbar heißt unbekannt, nicht abgelaufen.
    }
    const due = certificateDue(cert, expiry, now);
    if (due.expiresAt !== null && due.daysLeft !== null && due.daysLeft < CERT_WARN_DAYS) {
      out.push({ mainDomain: due.mainDomain, expiresAt: due.expiresAt, daysLeft: due.daysLeft });
    }
  }
  return out;
}

/**
 * Die hinterlegten Zertifizierungsstellen, die bald ablaufen. Nur, was ein
 * Ziel benutzt: eine Datei, gegen die niemand prüft, lässt nichts ausfallen.
 */
async function expiringAuthorities(now: number): Promise<ExpiringAuthority[]> {
  const server = localServer();
  const authorities = await readBackendCas(server);
  if (!authorities || authorities.length === 0) return [];
  const { services } = await probeProxy(server);
  const out: ExpiringAuthority[] = [];
  for (const ca of authorities) {
    const daysLeft = caDaysLeft(ca, now);
    // Nicht lesbar heißt unbekannt, nicht abgelaufen.
    if (ca.notAfter === null || daysLeft === null || daysLeft >= CA_WARN_DAYS) continue;
    const usedBy = caUsers(ca.name, services).map((service) => service.id);
    if (usedBy.length > 0) out.push({ name: ca.name, expiresAt: ca.notAfter, daysLeft, usedBy });
  }
  return out;
}

/** Einmal am Tag, nach der Erneuerung der Zertifikate: ihr Ergebnis melden und nach dem Ablauf sehen. */
export async function runDailyChecks(renewal: { ok: boolean; output: string }): Promise<void> {
  try {
    if (!renewal.ok) await notify({ type: 'certificate_renewal_failed', output: renewal.output });

    const certificates = await expiringCertificates(Date.now());
    if (certificates.length > 0) await notify({ type: 'certificate_expiring', certificates });

    const authorities = await expiringAuthorities(Date.now()).catch((err) => {
      log('Prüfung der Zertifizierungsstellen gescheitert', err);
      return [];
    });
    if (authorities.length > 0) await notify({ type: 'backend_ca_expiring', authorities });

    // CrowdSec antwortet nicht: dann gibt es heute keinen Bericht, die Prüfung oben meldet den Ausfall.
    await crowdsecReport().catch((err) => log('Tagesbericht von CrowdSec gescheitert', err));

    await pruneStates();
  } catch (err) {
    log('Tägliche Prüfung der Benachrichtigungen gescheitert', err);
  }
}
