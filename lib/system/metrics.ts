/**
 * Der Zustand der Installation im Textformat von Prometheus (Fassung 0.0.4).
 *
 * Rein: `renderMetrics` rechnet aus einer Übersicht, dem Urteil darüber und
 * dem Stand der Sicherung. `tests/system/metrics.test.ts` rechnet nach.
 *
 * ── Unbekannt fehlt, statt 0 zu sein ──
 *
 * Eine Zeile steht nur da, wenn der Wert bekannt ist. `hapm_haproxy_up 0`
 * hieße „HAProxy steht", und das stimmt nicht, wenn nur der Docker-Socket
 * fehlt. Eine Regel, die den Ausfall der Messung bemerken soll, fragt
 * `absent(hapm_haproxy_up)` oder `hapm_check_status{status="unknown"}`.
 *
 * ── Namen bleiben ──
 *
 * Auf diesen Namen und Labels stehen fremde Regeln und Tafeln. Was hier einmal
 * hinausging, wird nicht umbenannt. Namen und Hilfetexte sind englisch, wie
 * bei jedem Exporter: gelesen werden sie in Prometheus, nicht in HAPM.
 *
 * Die Zahlen des Verkehrs (Anfragen, Statuscodes, Antwortzeiten) stehen hier
 * nicht: die liefert HAProxy selbst genauer, und HAPM führt davon nur
 * Minutenwerte (`GET /api/internal/haproxy/stats`).
 */

import type { CertificateDue } from './certificates';
import type { BackupHealthInput, CheckStatus, ForwardHealthInput, HealthReport } from './health';
import type { SystemContainer, SystemOverview } from './overview';

type Labels = Readonly<Record<string, string>>;

interface Sample {
  labels?: Labels;
  value: number;
}

interface Family {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  samples: Sample[];
}

/** Backslash, Anführungszeichen und Zeilenumbruch, wie das Format es verlangt. */
export function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function line(name: string, sample: Sample): string {
  const labels = Object.entries(sample.labels ?? {});
  const text = labels.length ? `{${labels.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}` : '';
  return `${name}${text} ${Number.isFinite(sample.value) ? sample.value : 'NaN'}`;
}

function render(families: Family[]): string {
  const out: string[] = [];
  for (const family of families) {
    if (family.samples.length === 0) continue;
    out.push(`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} ${family.type}`);
    for (const sample of family.samples) out.push(line(family.name, sample));
  }
  return `${out.join('\n')}\n`;
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

function seconds(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isNaN(at) ? null : Math.floor(at / 1000);
}

const STATUS_VALUE: Record<HealthReport['status'], number> = { ok: 0, warn: 1, fail: 2 };
const CHECK_STATES: CheckStatus[] = ['ok', 'warn', 'fail', 'unknown'];

export interface MetricsInput {
  overview: SystemOverview;
  health: HealthReport;
  /** Alle Zertifikate mit Ablaufdatum. `null`: nicht zu lesen. */
  certificates: CertificateDue[] | null;
  backup: BackupHealthInput | null;
  /** Die Ziele der Weiterleitung des Protokolls. `null` oder fehlend: nicht zu lesen. */
  forwarding?: ForwardHealthInput[] | null;
}

export function renderMetrics({ overview, health, certificates, backup, forwarding }: MetricsInput): string {
  const forwards = (forwarding ?? []).filter((target) => target.enabled);
  const containers: { role: string; container: SystemContainer }[] = [
    { role: 'haproxy', container: overview.haproxy },
  ];
  if (overview.crowdsec.summary?.inStack) {
    containers.push(
      { role: 'crowdsec', container: overview.crowdsec.crowdsec },
      { role: 'crowdsec-bouncer', container: overview.crowdsec.bouncer }
    );
  }

  const proxy = overview.proxy;
  const targetCounts: Sample[] = [];
  if (proxy.services !== null) targetCounts.push({ labels: { kind: 'service' }, value: proxy.services });
  if (proxy.streams !== null) targetCounts.push({ labels: { kind: 'stream' }, value: proxy.streams });

  const targetStates: Sample[] = [];
  if (proxy.down !== null) targetStates.push({ labels: { state: 'down' }, value: proxy.down });
  if (proxy.partial !== null) targetStates.push({ labels: { state: 'partial' }, value: proxy.partial });

  const expiries: Sample[] = [];
  for (const cert of certificates ?? []) {
    const at = seconds(cert.expiresAt);
    if (at === null) continue;
    expiries.push({ labels: { domain: cert.mainDomain, source: cert.uploaded ? 'uploaded' : 'acme' }, value: at });
  }

  const single = (value: number | null | undefined): Sample[] =>
    value === null || value === undefined ? [] : [{ value }];

  const families: Family[] = [
    {
      name: 'hapm_info',
      help: 'Constant 1, labelled with the running HAPM version.',
      type: 'gauge',
      samples: [{ labels: { version: overview.hapm.version }, value: 1 }],
    },
    {
      name: 'hapm_health_status',
      help: 'Overall verdict of GET /api/internal/health: 0 ok, 1 warn, 2 fail.',
      type: 'gauge',
      samples: [{ value: STATUS_VALUE[health.status] }],
    },
    {
      name: 'hapm_check_status',
      help: 'One series per health check and state, 1 for the state the check is in.',
      type: 'gauge',
      samples: health.checks.flatMap((entry) =>
        CHECK_STATES.map((status) => ({ labels: { check: entry.id, status }, value: bool(entry.status === status) }))
      ),
    },
    {
      name: 'hapm_docker_up',
      help: 'Whether HAPM reaches the Docker engine.',
      type: 'gauge',
      samples: [{ value: bool(overview.docker.available) }],
    },
    {
      name: 'hapm_haproxy_up',
      help: 'Whether the HAProxy container is running. Absent when unknown.',
      type: 'gauge',
      samples: single(overview.haproxy.running === null ? null : bool(overview.haproxy.running)),
    },
    {
      name: 'hapm_container_running',
      help: 'Whether a container of the stack is running. Absent when unknown.',
      type: 'gauge',
      samples: containers.flatMap(({ role, container }) =>
        container.running === null ? [] : [{ labels: { container: role }, value: bool(container.running) }]
      ),
    },
    {
      name: 'hapm_container_restarts',
      help: 'Restart count of a container as reported by Docker. Resets when the container is replaced.',
      type: 'gauge',
      samples: containers.flatMap(({ role, container }) =>
        container.restartCount === null ? [] : [{ labels: { container: role }, value: container.restartCount }]
      ),
    },
    {
      name: 'hapm_container_start_time_seconds',
      help: 'Start time of a container as Unix time.',
      type: 'gauge',
      samples: containers.flatMap(({ role, container }) => {
        const at = seconds(container.startedAt);
        return at === null || !container.running ? [] : [{ labels: { container: role }, value: at }];
      }),
    },
    {
      name: 'hapm_targets',
      help: 'Configured targets (kind="service") and TCP forwards (kind="stream").',
      type: 'gauge',
      samples: targetCounts,
    },
    {
      name: 'hapm_targets_checked',
      help: 'Targets and forwards whose backends HAProxy health-checks.',
      type: 'gauge',
      samples: single(proxy.checked),
    },
    {
      name: 'hapm_targets_unhealthy',
      help: 'Checked targets without any reachable backend (state="down") or with only some (state="partial").',
      type: 'gauge',
      samples: targetStates,
    },
    {
      name: 'hapm_target_unhealthy',
      help: 'One series per target that is down or partially down. Absent for healthy targets.',
      type: 'gauge',
      samples: proxy.unhealthy.map((target) => ({
        labels: { target: target.id, kind: target.kind, state: target.health },
        value: 1,
      })),
    },
    {
      name: 'hapm_certificates',
      help: 'Certificates HAPM knows: issued through ACME or uploaded.',
      type: 'gauge',
      samples: single(overview.certificates.total),
    },
    {
      name: 'hapm_certificates_due',
      help: 'Certificates that expire soon or whose renewal is overdue.',
      type: 'gauge',
      samples: overview.certificates.total === null ? [] : [{ value: overview.certificates.due.length }],
    },
    {
      name: 'hapm_certificate_expiry_timestamp_seconds',
      help: 'Expiration of a certificate as Unix time, read from the file HAProxy loads.',
      type: 'gauge',
      samples: expiries,
    },
    {
      name: 'hapm_certificate_renewal_ok',
      help: 'Whether the last daily renewal run succeeded. Absent until it has run once since the start of HAPM.',
      type: 'gauge',
      samples: single(overview.scheduler.lastRenewal ? bool(overview.scheduler.lastRenewal.ok) : null),
    },
    {
      name: 'hapm_runs_failed',
      help: 'Failed runs that nobody acknowledged and that no later run for the same entry replaced.',
      type: 'gauge',
      samples: single(overview.runs.failed),
    },
    {
      name: 'hapm_runs_running',
      help: 'Runs in progress.',
      type: 'gauge',
      samples: single(overview.runs.running),
    },
    {
      name: 'hapm_update_available',
      help: 'Whether a newer image or version exists for a component. Absent when the registry could not be asked.',
      type: 'gauge',
      samples: (overview.updates ?? []).flatMap((state) =>
        state.updateAvailable === null
          ? []
          : [{ labels: { component: state.component }, value: bool(state.updateAvailable) }]
      ),
    },
    {
      name: 'hapm_scheduler_up',
      help: 'Whether the scheduler of HAPM is running.',
      type: 'gauge',
      samples: [{ value: bool(overview.scheduler.started) }],
    },
    {
      name: 'hapm_stats_last_run_timestamp_seconds',
      help: 'Last time HAPM read the counters of HAProxy, as Unix time.',
      type: 'gauge',
      samples: single(seconds(overview.scheduler.lastStatsRun)),
    },
    {
      name: 'hapm_log_follower_connected',
      help: 'Whether HAPM is following the log of the HAProxy container.',
      type: 'gauge',
      samples: [{ value: bool(overview.logFollower.connected) }],
    },
    {
      name: 'hapm_backup_enabled',
      help: 'Whether the daily backup is switched on.',
      type: 'gauge',
      samples: single(backup ? bool(backup.enabled) : null),
    },
    {
      name: 'hapm_backup_last_success_timestamp_seconds',
      help: 'Last successful backup as Unix time. Absent when there is none.',
      type: 'gauge',
      samples: single(backup ? seconds(backup.lastSuccessAt) : null),
    },
    {
      name: 'hapm_backup_last_run_ok',
      help: 'Whether the most recent finished backup run succeeded.',
      type: 'gauge',
      samples: single(
        backup?.lastRun && backup.lastRun.status !== 'running' ? bool(backup.lastRun.status !== 'error') : null
      ),
    },
    {
      name: 'hapm_audit_forward_failing',
      help: 'Whether forwarding the audit log to a destination (syslog, http) currently fails. Only for enabled destinations.',
      type: 'gauge',
      samples: forwards.map((target) => ({
        labels: { destination: target.destination },
        value: bool(target.failingSince !== null),
      })),
    },
    {
      name: 'hapm_audit_forward_backlog',
      help: 'Audit entries not yet delivered to a destination, counted up to 5000.',
      type: 'gauge',
      samples: forwards.flatMap((target) =>
        target.backlog === null ? [] : [{ labels: { destination: target.destination }, value: target.backlog }]
      ),
    },
    {
      name: 'hapm_crowdsec_active_decisions',
      help: 'Addresses CrowdSec currently blocks. Absent when CrowdSec is not running.',
      type: 'gauge',
      samples: single(overview.crowdsec.summary?.inStack ? overview.crowdsec.summary.activeDecisions : null),
    },
    {
      name: 'hapm_crowdsec_protected_targets',
      help: 'Targets CrowdSec checks.',
      type: 'gauge',
      samples: single(overview.crowdsec.summary?.inStack ? overview.crowdsec.summary.protectedServices : null),
    },
  ];

  return render(families);
}
