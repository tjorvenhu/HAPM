'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  Cable,
  CalendarClock,
  Check,
  ChevronDown,
  ChevronRight,
  Container,
  Download,
  Layers,
  LayoutDashboard,
  Loader2,
  Network,
  Play,
  Plus,
  RefreshCw,
  RotateCw,
  ScrollText,
  Settings2,
  ShieldCheck,
  Unplug,
  X,
} from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import Skeleton, { SkeletonRows } from '@/components/Skeleton';
import GeoipReminder from '@/components/GeoipReminder';
import {
  COMPONENT_LABELS,
  RUN_STATUS_CLASS,
  RUN_STATUS_LABELS,
  formatAgo,
  formatDate,
  formatDateTime,
  formatUptime,
  versionStep,
} from '@/components/system/format';
import type { HaproxyAction, UpdateComponent, UpdateState } from '@/lib/types';
import type { BootstrapState } from '@/lib/bootstrap';
import type {
  CertificateDue,
  SystemCertificates,
  SystemContainer,
  SystemOverview,
  SystemProxy,
} from '@/lib/system/overview';

const POLL_MS = 25_000;

/** Dieselben Wörter wie im Protokoll unter /reverse-proxy/logs. */
const ACTION_LABELS: Record<HaproxyAction, string> = {
  create: 'Angelegt',
  update: 'Geändert',
  delete: 'Gelöscht',
  settings: 'Einstellungen',
  'scope-add': 'Gruppe angelegt',
  'scope-remove': 'Gruppe entfernt',
  'stream-create': 'TCP angelegt',
  'stream-update': 'TCP geändert',
  'stream-delete': 'TCP gelöscht',
};

const BOOTSTRAP_LABELS: Record<BootstrapState['status'], string> = {
  pending: 'Steht noch aus',
  running: 'Läuft',
  ok: 'Abgeschlossen',
  error: 'Mit Fehlern',
  skipped: 'Übersprungen',
};

type Tone = 'danger' | 'warning' | 'ok';

function Kpi({
  href,
  icon,
  label,
  value,
  sub,
  tone,
}: {
  href: string;
  icon: ReactNode;
  label: string;
  /** `null` heißt unbekannt und steht auch so da. */
  value: number | null;
  sub?: string;
  tone?: Tone;
}) {
  return (
    <Link href={href} className={`kpi${tone && value !== null ? ` is-${tone}` : ''}`}>
      <span className="kpi-icon">{icon}</span>
      <span className="kpi-body">
        <span className="kpi-value">
          {value === null ? <small>Unbekannt</small> : value.toLocaleString('de-DE')}
          {value !== null && sub && <small> {sub}</small>}
        </span>
        <span className="kpi-label">{label}</span>
      </span>
    </Link>
  );
}

function KvRow({
  label,
  hint,
  value,
  tone,
  tooltip,
}: {
  label: string;
  hint?: string;
  value: ReactNode;
  tone?: 'danger' | 'warning' | 'muted';
  tooltip?: string;
}) {
  return (
    <div className="dash-kv-row">
      <span className="dash-kv-label">
        <span>
          {label}
          {hint && <InfoHint text={hint} />}
        </span>
      </span>
      <span
        className={`dash-kv-value${tone ? (tone === 'muted' ? ' muted' : ` is-${tone}`) : ''}`}
        data-tooltip={tooltip}
        data-tooltip-pos={tooltip ? 'left' : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function StepList({ steps }: { steps: BootstrapState['steps'] }) {
  return (
    <ul className="hapm-steps hapm-flag-detail">
      {steps.map((step, index) => (
        <li key={`${index}-${step.label}`} className={`hapm-step ${step.ok ? 'is-ok' : 'is-failed'}`}>
          {step.ok ? <Check size={14} strokeWidth={1.5} /> : <X size={14} strokeWidth={1.5} />}
          <span className="hapm-step-text">
            <span className="hapm-step-label">{step.label}</span>
            {step.detail && <span className="hapm-step-detail">{step.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * „HAProxy läuft nicht": die eine Fläche, die eine Handlung trägt. Die Ausgabe
 * des Containers steht darunter, denn ein HAProxy, der nicht startet, sagt dort,
 * an welcher Zeile der Konfiguration es liegt.
 */
function HaproxyDown({
  haproxy,
  onRestart,
}: {
  haproxy: SystemContainer;
  onRestart: () => Promise<boolean | null>;
}) {
  const { apiFetch } = useApp();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const [logs, setLogs] = useState<string | null>(null);
  const [logError, setLogError] = useState('');

  const loadLogs = useCallback(async () => {
    try {
      const res = await apiFetch('/api/system/haproxy?logs=1');
      const body = await res.json();
      if (body.success) {
        setLogs(body.data.logs as string);
        setLogError('');
      } else {
        setLogError(body.error || 'Die Ausgabe ließ sich nicht lesen.');
      }
    } catch {
      setLogError('Die Ausgabe ließ sich nicht lesen.');
    }
  }, [apiFetch]);

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next) void loadLogs();
  }

  async function start() {
    setBusy(true);
    try {
      const running = await onRestart();
      if (running === false) {
        setOpen(true);
        await loadLogs();
      }
    } finally {
      setBusy(false);
    }
  }

  if (haproxy.exists === false) {
    return (
      <div className="alert alert-danger sys-block hapm-flag">
        <AlertTriangle size={16} strokeWidth={1.5} />
        <div className="hapm-flag-body">
          <strong>Der Container von HAProxy fehlt.</strong>
          <span>
            Docker kennt keinen Container mit dem Namen „{haproxy.name}“. HAPM legt ihn nicht an, er gehört zum
            Compose-Stack.
          </span>
        </div>
      </div>
    );
  }

  const looping = haproxy.status === 'restarting';
  return (
    <div className="alert alert-danger sys-block hapm-flag">
      <AlertTriangle size={16} strokeWidth={1.5} />
      <div className="hapm-flag-body">
        <strong>{looping ? 'HAProxy startet immer wieder neu.' : 'HAProxy läuft nicht.'}</strong>
        <span>
          {looping
            ? 'Der Container beendet sich kurz nach dem Start. Die Ausgabe nennt den Grund.'
            : `Zustand des Containers: ${haproxy.status ?? 'unbekannt'}. Solange er steht, ist kein Ziel erreichbar.`}
        </span>
      </div>
      <div className="hapm-flag-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={toggle} aria-expanded={open}>
          {open ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}
          Ausgabe
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={start} disabled={busy}>
          {busy ? (
            <Loader2 size={14} strokeWidth={1.5} className="spin" />
          ) : looping ? (
            <RotateCw size={14} strokeWidth={1.5} />
          ) : (
            <Play size={14} strokeWidth={1.5} />
          )}
          {looping ? 'Neu starten' : 'Starten'}
        </button>
      </div>
      {open &&
        (logError ? (
          <span className="hapm-flag-detail">{logError}</span>
        ) : logs === null ? (
          <div className="hapm-flag-detail">
            <Skeleton height={96} radius="var(--radius)" />
          </div>
        ) : (
          <pre className="run-log hapm-flag-detail">
            {logs.trim() || 'Der Container hat nichts ausgegeben.'}
          </pre>
        ))}
    </div>
  );
}

function RenewalFailed({ at, output }: { at: string; output: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="alert alert-warning sys-block hapm-flag">
      <AlertTriangle size={16} strokeWidth={1.5} />
      <div className="hapm-flag-body">
        <strong>Die letzte Erneuerung der Zertifikate meldet einen Fehler.</strong>
        <span>Lauf vom {formatDateTime(at)}. acme.sh versucht es beim nächsten täglichen Lauf erneut.</span>
      </div>
      {output && (
        <div className="hapm-flag-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
          >
            {open ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}
            Ausgabe
          </button>
        </div>
      )}
      {open && output && <pre className="run-log hapm-flag-detail">{output}</pre>}
    </div>
  );
}

function UnhealthyTargets({ proxy }: { proxy: SystemProxy }) {
  if (proxy.unhealthy.length === 0) return null;
  const shown = proxy.unhealthy.slice(0, 6);
  const rest = proxy.unhealthy.length - shown.length;
  const allDown = proxy.unhealthy.every((target) => target.health === 'down');
  return (
    <div className={`alert ${allDown ? 'alert-danger' : 'alert-warning'} sys-block hapm-flag`}>
      <Unplug size={16} strokeWidth={1.5} />
      <div className="hapm-flag-body">
        <strong>
          {proxy.unhealthy.length === 1
            ? 'Ein Ziel erreicht sein Backend nicht.'
            : `${proxy.unhealthy.length} Ziele erreichen ihr Backend nicht.`}
        </strong>
        <span>
          {shown.map((target, index) => (
            <span key={`${target.kind}-${target.id}`}>
              {index > 0 && ', '}
              {target.slug ? (
                <Link
                  href={
                    target.kind === 'service'
                      ? `/reverse-proxy/${target.slug}?dienst=${encodeURIComponent(target.id)}`
                      : `/reverse-proxy/${target.slug}`
                  }
                >
                  {target.id}
                </Link>
              ) : (
                target.id
              )}
              {target.health === 'partial' && ' (teilweise)'}
            </span>
          ))}
          {rest > 0 && ` und ${rest} weitere`}
        </span>
      </div>
    </div>
  );
}

function UpdatesAvailable({ states }: { states: UpdateState[] }) {
  const pending = states.filter((state) => state.updateAvailable === true);
  if (pending.length === 0) return null;
  return (
    <div className="alert alert-info sys-block hapm-flag">
      <Download size={16} strokeWidth={1.5} />
      <div className="hapm-flag-body">
        <strong>{pending.length === 1 ? 'Update verfügbar' : 'Updates verfügbar'}</strong>
        <span>
          {pending
            .map((state) => {
              const step = versionStep(state);
              return `${COMPONENT_LABELS[state.component]} ${step ?? '(neues Abbild)'}`;
            })
            .join(', ')}
        </span>
      </div>
      <div className="hapm-flag-actions">
        <Link className="btn btn-primary btn-sm" href="/updates">
          Zu den Updates
          <ArrowRight size={14} strokeWidth={1.5} />
        </Link>
      </div>
    </div>
  );
}

function containerBadge(container: SystemContainer): { label: string; cls: string; tooltip?: string } {
  if (container.exists === null) {
    return { label: 'Unbekannt', cls: 'badge-neutral', tooltip: container.error ?? 'Docker ist nicht erreichbar.' };
  }
  if (container.exists === false) return { label: 'Fehlt', cls: 'badge-danger' };
  if (container.status === 'restarting') return { label: 'Startet neu', cls: 'badge-danger' };
  if (!container.running) return { label: 'Gestoppt', cls: 'badge-danger' };
  if (container.health === 'unhealthy') return { label: 'Läuft, Prüfung schlägt fehl', cls: 'badge-warning' };
  return { label: 'Läuft', cls: 'badge-success' };
}

function UpdateBadge({ state }: { state: UpdateState | undefined }) {
  if (!state) {
    return (
      <span className="badge-status badge-neutral">
        <span className="dot" />
        Noch nicht geprüft
      </span>
    );
  }
  if (state.updateAvailable === true) {
    return (
      <Link href="/updates" className="badge-status badge-warning">
        <span className="dot" />
        Update verfügbar
      </Link>
    );
  }
  if (state.updateAvailable === false) {
    return (
      <span className="badge-status badge-success">
        <span className="dot" />
        Aktuell
      </span>
    );
  }
  return (
    <span className="badge-status badge-neutral" data-tooltip={state.error ?? undefined} data-tooltip-pos="left">
      <span className="dot" />
      Unbekannt
    </span>
  );
}

function certBadge(cert: CertificateDue): { label: string; cls: string } {
  if (cert.daysLeft === null) return { label: 'Erneuerung überfällig', cls: 'badge-warning' };
  if (cert.daysLeft < 0) return { label: 'Abgelaufen', cls: 'badge-danger' };
  if (cert.daysLeft === 0) return { label: 'Läuft heute ab', cls: 'badge-danger' };
  if (cert.daysLeft === 1) return { label: 'Läuft morgen ab', cls: 'badge-danger' };
  if (cert.renewalOverdue && cert.daysLeft >= 14) return { label: 'Erneuerung überfällig', cls: 'badge-warning' };
  return { label: `Läuft in ${cert.daysLeft} Tagen ab`, cls: 'badge-warning' };
}

function CertificatesCard({ certificates }: { certificates: SystemCertificates }) {
  let summary: string;
  if (certificates.total === null) {
    summary = `Unbekannt. ${certificates.error ?? 'acme.sh war nicht zu fragen.'}`;
  } else if (certificates.total === 0) {
    summary = 'Noch kein Zertifikat. Das erste entsteht mit dem ersten Ziel.';
  } else if (certificates.due.length === 0 && certificates.expiring === 0) {
    summary =
      certificates.total === 1
        ? `Ein Zertifikat. Es läuft in den nächsten ${certificates.warnDays} Tagen nicht ab.`
        : `${certificates.total} Zertifikate. Keines läuft in den nächsten ${certificates.warnDays} Tagen ab.`;
  } else {
    summary = certificates.total === 1 ? 'Ein Zertifikat.' : `${certificates.total} Zertifikate.`;
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">
          Zertifikate
          <InfoHint
            text={`Hier steht, was in den nächsten ${certificates.warnDays} Tagen abläuft oder was acme.sh schon hätte erneuern sollen. Das Ablaufdatum stammt aus der Datei, die HAProxy lädt.`}
          />
        </h2>
        <Link className="btn btn-ghost btn-sm" href="/reverse-proxy/zertifikate">
          Alle
        </Link>
      </div>
      <div className="card-body">
        <p className="form-hint">{summary}</p>
        {certificates.due.length > 0 && (
          <div className="hapm-list">
            {certificates.due.map((cert) => {
              const badge = certBadge(cert);
              return (
                <div key={cert.mainDomain} className="activity-row">
                  <div className="activity-row-text">
                    <span className="activity-row-name">{cert.mainDomain}</span>
                    <span className="activity-row-sub">
                      {cert.expiresAt ? `Gültig bis ${formatDate(cert.expiresAt)}` : 'Ablaufdatum nicht lesbar'}
                      {cert.domains.length > 1 &&
                        `, ${cert.domains.length - 1} weitere ${cert.domains.length === 2 ? 'Domain' : 'Domains'}`}
                    </span>
                  </div>
                  <span className={`badge-status ${badge.cls}`}>{badge.label}</span>
                </div>
              );
            })}
          </div>
        )}
        {certificates.unreadable > 0 && (
          <p className="form-hint">
            {certificates.unreadable === 1
              ? 'Bei einem Zertifikat ist das Ablaufdatum nicht lesbar.'
              : `Bei ${certificates.unreadable} Zertifikaten ist das Ablaufdatum nicht lesbar.`}
          </p>
        )}
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <>
      <div className="kpi-grid sys-block">
        {Array.from({ length: 8 }, (_, index) => (
          <div key={index} className="kpi">
            <Skeleton width={30} height={30} radius="50%" />
            <div className="kpi-body">
              <Skeleton width={48} height={18} radius={4} />
              <Skeleton width={96} height={11} radius={4} />
            </div>
          </div>
        ))}
      </div>
      <SkeletonRows count={4} />
    </>
  );
}

export default function DashboardPage() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const now = useNow(10_000);

  const [data, setData] = useState<SystemOverview | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/system');
      const body = await res.json();
      if (body.success) {
        setData(body.data as SystemOverview);
        setError('');
      } else {
        setError(body.error || 'Die Übersicht konnte nicht geladen werden.');
      }
    } catch {
      setError('Die Übersicht konnte nicht geladen werden.');
    }
  }, [apiFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  usePolling(load, POLL_MS);

  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([load(), new Promise((resolve) => setTimeout(resolve, 400))]);
    } finally {
      setRefreshing(false);
    }
  }

  /** `true`: läuft danach. `false`: gestartet und wieder beendet. `null`: nicht zu erfahren. */
  const restartHaproxy = useCallback(async (): Promise<boolean | null> => {
    try {
      const res = await apiFetch('/api/system/haproxy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restart' }),
      });
      const body = await res.json();
      if (!body.success) {
        notify({ variant: 'error', title: 'HAProxy', message: body.error || 'Der Start ist fehlgeschlagen.' });
        return null;
      }
      const running = Boolean(body.data.container?.running);
      if (running) {
        notify({ variant: 'success', message: 'HAProxy läuft.' });
      } else {
        notify({
          variant: 'error',
          title: 'HAProxy läuft nicht',
          message: 'Der Container hat sich nach dem Start wieder beendet. Die Ausgabe nennt den Grund.',
        });
      }
      await load();
      return running;
    } catch {
      // Läuft die Oberfläche über HAProxy, reißt der Neustart die eigene Anfrage mit.
      notify({
        variant: 'info',
        title: 'Verbindung unterbrochen',
        message: 'Die Antwort kam nicht an. Der Zustand wird gleich neu gelesen.',
      });
      setTimeout(() => void load(), 4000);
      return null;
    }
  }, [apiFetch, load, notify]);

  function confirmRestart() {
    void confirm({
      title: 'HAProxy neu starten?',
      message:
        'Alle offenen Verbindungen werden getrennt. HAProxy ist für wenige Sekunden nicht erreichbar. Läuft diese Oberfläche über HAProxy, bricht auch sie kurz ab.',
      confirmLabel: 'Neu starten',
      variant: 'default',
      onConfirm: async () => {
        await restartHaproxy();
      },
    });
  }

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">Übersicht</h1>
        <p className="page-subtitle">
          {data
            ? `HAProxy auf ${data.hapm.nodeName}. Stand ${new Date(data.generatedAt).toLocaleTimeString('de-DE')}.`
            : 'Zustand von HAProxy, HAPM und acme.sh.'}
        </p>
      </div>
      <div className="page-actions">
        <button type="button" className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
          {refreshing ? (
            <Loader2 size={16} strokeWidth={1.5} className="spin" />
          ) : (
            <RefreshCw size={16} strokeWidth={1.5} />
          )}
          Aktualisieren
        </button>
        <Link className="btn btn-primary" href="/reverse-proxy">
          <Plus size={16} strokeWidth={1.5} />
          Ziel anlegen
        </Link>
      </div>
    </div>
  );

  if (!data) {
    return (
      <>
        {header}
        {error ? <div className="alert alert-danger sys-block">{error}</div> : <DashboardSkeleton />}
      </>
    );
  }

  const { docker, haproxy, hapm, acme, bootstrap, scheduler, logFollower, proxy, certificates, runs } = data;
  const updates = data.updates ?? [];
  const stateOf = (component: UpdateComponent) => updates.find((state) => state.component === component);

  const haproxyDown = docker.available && (haproxy.running === false || haproxy.status === 'restarting');
  const empty = proxy.services === 0 && proxy.streams === 0;
  const unhealthyCount = proxy.down === null || proxy.partial === null ? null : proxy.down + proxy.partial;
  const pendingUpdates =
    data.updates === null || data.updates.length === 0
      ? null
      : data.updates.filter((state) => state.updateAvailable === true).length;
  const expired = certificates.due.some((cert) => cert.daysLeft !== null && cert.daysLeft < 0);
  const haproxyBadge = containerBadge(haproxy);

  return (
    <>
      {header}

      {error && (
        <div className="alert alert-danger sys-block">
          <AlertTriangle size={16} strokeWidth={1.5} />
          <span>Die Angaben sind nicht aktuell: {error}</span>
        </div>
      )}

      {!docker.available && (
        <div className="alert alert-danger sys-block hapm-flag">
          <AlertTriangle size={16} strokeWidth={1.5} />
          <div className="hapm-flag-body">
            <strong>Der Docker-Socket ist nicht erreichbar.</strong>
            <span>
              Ohne ihn kann HAPM den Zustand von HAProxy nicht lesen, die Konfiguration nicht prüfen und keine
              Updates einspielen.
            </span>
            {docker.error && <span className="hapm-flag-reason">{docker.error}</span>}
          </div>
        </div>
      )}

      {haproxyDown && <HaproxyDown haproxy={haproxy} onRestart={restartHaproxy} />}

      {bootstrap.status === 'error' && (
        <div className="alert alert-danger sys-block hapm-flag">
          <AlertTriangle size={16} strokeWidth={1.5} />
          <div className="hapm-flag-body">
            <strong>Die Ersteinrichtung ist mit Fehlern beendet.</strong>
            <span>Sie läuft bei jedem Start von HAPM erneut und holt nach, was fehlt.</span>
          </div>
          <StepList steps={bootstrap.steps} />
        </div>
      )}

      {proxy.error && (
        <div className="alert alert-warning sys-block hapm-flag">
          <AlertTriangle size={16} strokeWidth={1.5} />
          <div className="hapm-flag-body">
            <strong>Die Konfiguration von HAProxy war nicht zu lesen.</strong>
            <span>Ziele, Gruppen und Weiterleitungen sind deshalb unbekannt.</span>
            <span className="hapm-flag-reason">{proxy.error}</span>
          </div>
        </div>
      )}

      <UnhealthyTargets proxy={proxy} />

      {scheduler.lastRenewal && !scheduler.lastRenewal.ok && (
        <RenewalFailed at={scheduler.lastRenewal.at} output={scheduler.lastRenewal.output} />
      )}

      <UpdatesAvailable states={updates} />

      <GeoipReminder />

      {/* Ohne Gruppe lässt sich kein Ziel anlegen: dann steht der Schritt davor da. */}
      {empty && proxy.scopes === 0 && (
        <div className="empty-state sys-block">
          <Layers size={40} strokeWidth={1.5} />
          <h3>Zuerst eine Gruppe anlegen</h3>
          <p>
            Eine Gruppe fasst Ziele zusammen, etwa „Websites“ oder „Intern“. Jedes Ziel gehört in eine Gruppe.
            Die erste legen Sie unter „Reverse-Proxy“ an, danach das erste Ziel.
          </p>
          <Link className="btn btn-primary" href="/reverse-proxy">
            Zum Reverse-Proxy
            <ArrowRight size={16} strokeWidth={1.5} />
          </Link>
        </div>
      )}

      {empty && proxy.scopes !== 0 && (
        <div className="empty-state sys-block">
          <Network size={40} strokeWidth={1.5} />
          <h3>Noch kein Ziel angelegt</h3>
          <p>
            Unter „Reverse-Proxy“ eine Gruppe öffnen und dort „Ziel anlegen“ wählen. Das Zertifikat für die Domain
            stellt HAPM dabei selbst aus.
          </p>
          <Link className="btn btn-primary" href="/reverse-proxy">
            <Plus size={16} strokeWidth={1.5} />
            Zum Reverse-Proxy
          </Link>
        </div>
      )}

      <div className="kpi-grid sys-block">
        <Kpi
          href="/reverse-proxy"
          icon={<Network size={16} strokeWidth={1.5} />}
          label="Ziele"
          value={proxy.services}
        />
        <Kpi
          href="/reverse-proxy"
          icon={<Layers size={16} strokeWidth={1.5} />}
          label="Gruppen"
          value={proxy.scopes}
        />
        <Kpi
          href="/reverse-proxy"
          icon={<Cable size={16} strokeWidth={1.5} />}
          label="TCP-Weiterleitungen"
          value={proxy.streams}
        />
        <Kpi
          href="/reverse-proxy"
          icon={<Unplug size={16} strokeWidth={1.5} />}
          label="Backend nicht erreichbar"
          value={unhealthyCount}
          sub={proxy.checked ? `von ${proxy.checked} geprüften` : undefined}
          tone={proxy.down ? 'danger' : proxy.partial ? 'warning' : proxy.checked ? 'ok' : undefined}
        />
        <Kpi
          href="/reverse-proxy/zertifikate"
          icon={<ShieldCheck size={16} strokeWidth={1.5} />}
          label="Zertifikate"
          value={certificates.total}
        />
        <Kpi
          href="/reverse-proxy/zertifikate"
          icon={<CalendarClock size={16} strokeWidth={1.5} />}
          label={`Laufen in ${certificates.warnDays} Tagen ab`}
          value={certificates.expiring}
          tone={expired ? 'danger' : certificates.expiring ? 'warning' : undefined}
        />
        <Kpi
          href="/reverse-proxy/logs"
          icon={<AlertTriangle size={16} strokeWidth={1.5} />}
          label="Vorgänge fehlgeschlagen"
          value={runs.failed}
          tone={runs.failed ? 'danger' : undefined}
        />
        <Kpi
          href="/updates"
          icon={<Download size={16} strokeWidth={1.5} />}
          label="Updates verfügbar"
          value={pendingUpdates}
          tone={pendingUpdates ? 'warning' : undefined}
        />
      </div>

      <div className="hapm-cols sys-block">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Bestandteile</h2>
            <Link className="btn btn-ghost btn-sm" href="/updates">
              Updates
            </Link>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Bestandteil</th>
                  <th>Version</th>
                  <th>Zustand</th>
                  <th>Läuft seit</th>
                  <th>Update</th>
                  <th aria-label="Aktionen" />
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td data-label="primary">
                    <div className="hapm-part">
                      <span className="kpi-icon">
                        <Network size={16} strokeWidth={1.5} />
                      </span>
                      <div>
                        <strong>HAProxy</strong>
                        <div className="detail-sub mono">{haproxy.image ?? haproxy.name}</div>
                      </div>
                    </div>
                  </td>
                  <td data-label="Version">{haproxy.version ?? 'Unbekannt'}</td>
                  <td data-label="Zustand">
                    <span
                      className={`badge-status ${haproxyBadge.cls}`}
                      data-tooltip={haproxyBadge.tooltip}
                    >
                      <span className="dot" />
                      {haproxyBadge.label}
                    </span>
                  </td>
                  <td data-label="Läuft seit">
                    {haproxy.startedAt ? (
                      <span data-tooltip={formatDateTime(haproxy.startedAt)}>{formatUptime(now, haproxy.startedAt)}</span>
                    ) : haproxy.exists === null ? (
                      'Unbekannt'
                    ) : (
                      'Läuft nicht'
                    )}
                    {haproxy.restartCount !== null && haproxy.restartCount > 0 && (
                      <div className="detail-sub">
                        {haproxy.restartCount === 1
                          ? 'Ein Neustart durch Docker'
                          : `${haproxy.restartCount} Neustarts durch Docker`}
                      </div>
                    )}
                  </td>
                  <td data-label="Update">
                    <UpdateBadge state={stateOf('haproxy')} />
                  </td>
                  <td data-label="actions">
                    {haproxy.running && (
                      <div className="actions hapm-actions-end">
                        <button
                          type="button"
                          className="btn btn-ghost btn-icon btn-sm"
                          data-tooltip="HAProxy neu starten"
                          data-tooltip-pos="left"
                          aria-label="HAProxy neu starten"
                          onClick={confirmRestart}
                        >
                          <RotateCw size={16} strokeWidth={1.5} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
                <tr>
                  <td data-label="primary">
                    <div className="hapm-part">
                      <span className="kpi-icon">
                        <LayoutDashboard size={16} strokeWidth={1.5} />
                      </span>
                      <div>
                        <strong>HAPM</strong>
                        <div className="detail-sub mono">
                          {hapm.image ?? (hapm.containerized ? 'Abbild unbekannt' : 'Läuft ohne Container')}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td data-label="Version">{hapm.version}</td>
                  <td data-label="Zustand">
                    <span className="badge-status badge-success">
                      <span className="dot" />
                      Läuft
                    </span>
                  </td>
                  <td data-label="Läuft seit">
                    {hapm.startedAt ? (
                      <span data-tooltip={formatDateTime(hapm.startedAt)}>{formatUptime(now, hapm.startedAt)}</span>
                    ) : (
                      'Unbekannt'
                    )}
                  </td>
                  <td data-label="Update">
                    <UpdateBadge state={stateOf('hapm')} />
                  </td>
                  <td data-label="actions" />
                </tr>
                <tr>
                  <td data-label="primary">
                    <div className="hapm-part">
                      <span className="kpi-icon">
                        <ShieldCheck size={16} strokeWidth={1.5} />
                      </span>
                      <div>
                        <strong>acme.sh</strong>
                        <div className="detail-sub">
                          {acme.accountEmail ? `Konto: ${acme.accountEmail}` : 'Keine Adresse für das Konto hinterlegt'}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td data-label="Version">{acme.version ?? 'Unbekannt'}</td>
                  <td data-label="Zustand">
                    {acme.installed === null ? (
                      <span className="badge-status badge-neutral" data-tooltip={acme.error ?? undefined}>
                        <span className="dot" />
                        Unbekannt
                      </span>
                    ) : acme.installed ? (
                      <span className="badge-status badge-success">
                        <span className="dot" />
                        Eingerichtet
                      </span>
                    ) : (
                      <span className="badge-status badge-danger">
                        <span className="dot" />
                        Nicht installiert
                      </span>
                    )}
                  </td>
                  <td data-label="Läuft seit">
                    <span className="hapm-muted">Läuft bei Bedarf</span>
                  </td>
                  <td data-label="Update">
                    <UpdateBadge state={stateOf('acme')} />
                  </td>
                  <td data-label="actions" />
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <h2 className="card-title">Betrieb</h2>
          </div>
          <div className="dash-kv">
            <KvRow
              label="Docker"
              value={docker.available ? `Version ${docker.version}` : 'Nicht erreichbar'}
              tone={docker.available ? undefined : 'danger'}
            />
            <KvRow
              label="Ersteinrichtung"
              value={BOOTSTRAP_LABELS[bootstrap.status]}
              tone={bootstrap.status === 'error' ? 'danger' : bootstrap.status === 'ok' ? undefined : 'muted'}
              tooltip={bootstrap.finishedAt ? formatDateTime(bootstrap.finishedAt) : undefined}
            />
            <KvRow
              label="Statistik"
              hint="HAPM sammelt die Zähler von HAProxy im Minutentakt ein. Die Angabe gilt seit dem letzten Start von HAPM."
              value={
                scheduler.lastStatsError
                  ? 'Fehler'
                  : scheduler.lastStatsRun
                    ? formatAgo(now, scheduler.lastStatsRun)
                    : 'Noch keine Runde'
              }
              tone={scheduler.lastStatsError ? 'warning' : scheduler.lastStatsRun ? undefined : 'muted'}
              tooltip={scheduler.lastStatsError ?? undefined}
            />
            <KvRow
              label="Erneuerung"
              hint="acme.sh erneuert fällige Zertifikate einmal am Tag um 03:17 Uhr. Die Angabe gilt seit dem letzten Start von HAPM."
              value={
                scheduler.lastRenewal
                  ? `${formatAgo(now, scheduler.lastRenewal.at)}, ${scheduler.lastRenewal.ok ? 'ohne Fehler' : 'mit Fehler'}`
                  : 'Noch kein Lauf'
              }
              tone={scheduler.lastRenewal ? (scheduler.lastRenewal.ok ? undefined : 'danger') : 'muted'}
              tooltip={scheduler.lastRenewal ? formatDateTime(scheduler.lastRenewal.at) : undefined}
            />
            <KvRow
              label="Log-Mitschnitt"
              hint="HAPM schreibt die Ausgabe von HAProxy in eine Datei mit. Daraus liest die Statistik, wer zugreift: Adressen, Länder und Pfade."
              value={
                logFollower.connected
                  ? `Verbunden, ${logFollower.lines.toLocaleString('de-DE')} Zeilen`
                  : 'Getrennt'
              }
              tone={logFollower.connected ? undefined : 'warning'}
              tooltip={logFollower.last ? `Letzte Zeile ${formatDateTime(logFollower.last)}` : undefined}
            />
            <KvRow
              label="Zeitgesteuerte Aufgaben"
              value={scheduler.started ? 'Aktiv' : 'Nicht gestartet'}
              tone={scheduler.started ? undefined : 'warning'}
            />
          </div>
        </div>
      </div>

      <div className="hapm-cols sys-block">
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">
              Letzte Vorgänge
              {runs.running ? <span className="section-count">{runs.running} laufen</span> : null}
            </h2>
            <Link className="btn btn-ghost btn-sm" href="/reverse-proxy/logs">
              Protokoll
            </Link>
          </div>
          {runs.recent === null ? (
            <p className="form-hint">Die Historie war nicht zu lesen.</p>
          ) : runs.recent.length === 0 ? (
            <p className="form-hint">Noch kein Vorgang am Reverse-Proxy.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Eintrag</th>
                    <th>Vorgang</th>
                    <th>Status</th>
                    <th>Dauer</th>
                    <th>Zeitpunkt</th>
                    <th>Ausgelöst von</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.recent.map((run) => (
                    <tr key={run.$id}>
                      <td data-label="primary">
                        <strong>{run.serviceId}</strong>
                        {run.error && <div className="detail-error">{run.error}</div>}
                      </td>
                      <td data-label="Vorgang">{ACTION_LABELS[run.action] ?? run.action}</td>
                      <td data-label="Status">
                        <span className={`badge-status ${RUN_STATUS_CLASS[run.status] ?? 'badge-neutral'}`}>
                          {run.status === 'running' && <Loader2 size={12} strokeWidth={1.5} className="spin" />}
                          {RUN_STATUS_LABELS[run.status] ?? run.status}
                        </span>
                      </td>
                      <td data-label="Dauer">{run.duration !== null ? `${run.duration} s` : ''}</td>
                      <td data-label="Zeitpunkt">
                        <span data-tooltip={formatDateTime(run.startedAt)}>{formatAgo(now, run.startedAt)}</span>
                      </td>
                      <td data-label="Ausgelöst von">{run.triggeredBy ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <CertificatesCard certificates={certificates} />
      </div>

      <div className="card">
        <div className="card-header">
          <h2 className="card-title">Schnellzugriffe</h2>
        </div>
        <div className="kind-grid">
          <Link className="kind-card" href="/reverse-proxy">
            <span className="kind-card-icon">
              <Plus size={17} strokeWidth={1.5} />
            </span>
            <span className="kind-card-text">
              <span className="kind-card-title">Ziel anlegen</span>
              <span className="kind-card-sub">Domain, Backend und Zertifikat in einem Vorgang.</span>
            </span>
          </Link>
          <Link className="kind-card" href="/reverse-proxy/statistiken">
            <span className="kind-card-icon">
              <BarChart3 size={17} strokeWidth={1.5} />
            </span>
            <span className="kind-card-text">
              <span className="kind-card-title">Statistik</span>
              <span className="kind-card-sub">Anfragen, Statuscodes, Antwortzeiten und wer zugreift.</span>
            </span>
          </Link>
          <Link className="kind-card" href="/reverse-proxy/logs">
            <span className="kind-card-icon">
              <ScrollText size={17} strokeWidth={1.5} />
            </span>
            <span className="kind-card-text">
              <span className="kind-card-title">Protokoll</span>
              <span className="kind-card-sub">Jeder Vorgang am Reverse-Proxy mit seinen Schritten.</span>
            </span>
          </Link>
          <Link className="kind-card" href="/reverse-proxy/einstellungen">
            <span className="kind-card-icon">
              <Settings2 size={17} strokeWidth={1.5} />
            </span>
            <span className="kind-card-text">
              <span className="kind-card-title">Einstellungen</span>
              <span className="kind-card-sub">Was für alle Ziele gilt.</span>
            </span>
          </Link>
          <Link className="kind-card" href="/updates">
            <span className="kind-card-icon">
              <Container size={17} strokeWidth={1.5} />
            </span>
            <span className="kind-card-text">
              <span className="kind-card-title">Updates</span>
              <span className="kind-card-sub">Neue Abbilder prüfen und einspielen.</span>
            </span>
          </Link>
        </div>
      </div>
    </>
  );
}
