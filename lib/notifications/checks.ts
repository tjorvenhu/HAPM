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
import { probeProxy, readCertificates } from '../haproxy/provision';
import { HAPROXY_CERT_DIR, serviceHealth, type BackendServerState, type HaproxyRoute } from '../haproxy/config';
import { pemFileName } from '../haproxy/certs';
import { CERT_WARN_DAYS, certificateDue, pemExpiry } from '../system/certificates';
import { notify } from './index';
import { pruneStates, resolveState } from './state';
import { advanceStreaks, type Observed, type Streak } from './streaks';
import type { ExpiringCertificate, TargetKind } from './events';

/** Der Takt der Prüfung von HAProxy und seinen Zielen. Gemeldet wird nach zwei Runden. */
export const HEALTH_CHECK_INTERVAL_MS = 2 * 60 * 1000;

interface CheckState {
  running: boolean;
  haproxy: Map<string, Streak>;
  targets: Map<string, Streak>;
}

const globalState = globalThis as unknown as { __hapmNotifyChecks?: CheckState };

function state(): CheckState {
  return (globalState.__hapmNotifyChecks ??= { running: false, haproxy: new Map(), targets: new Map() });
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

/** Alle zwei Minuten: läuft HAProxy, antworten die Ziele. */
export async function runHealthChecks(): Promise<void> {
  const s = state();
  if (s.running) return;
  s.running = true;
  try {
    const now = new Date().toISOString();
    if (await checkHaproxy(now)) await checkTargets(now);
    else s.targets = new Map();
  } catch (err) {
    log('Prüfung von HAProxy und Zielen gescheitert', err);
  } finally {
    s.running = false;
  }
}

async function expiringCertificates(now: number): Promise<ExpiringCertificate[]> {
  const out: ExpiringCertificate[] = [];
  for (const cert of await readCertificates(localServer())) {
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

/** Einmal am Tag, nach der Erneuerung der Zertifikate: ihr Ergebnis melden und nach dem Ablauf sehen. */
export async function runDailyChecks(renewal: { ok: boolean; output: string }): Promise<void> {
  try {
    if (!renewal.ok) await notify({ type: 'certificate_renewal_failed', output: renewal.output });

    const certificates = await expiringCertificates(Date.now());
    if (certificates.length > 0) await notify({ type: 'certificate_expiring', certificates });

    await pruneStates();
  } catch (err) {
    log('Tägliche Prüfung der Benachrichtigungen gescheitert', err);
  }
}
