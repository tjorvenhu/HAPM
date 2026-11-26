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
  Ban,
  ShieldAlert,
  LayoutList,
} from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import Skeleton, { SkeletonRows } from '@/components/Skeleton';
import GeoipReminder from '@/components/GeoipReminder';
import LiveTraffic from '@/components/reverse-proxy/LiveTraffic';
import SetupReminder from '@/components/SetupReminder';
import BrandLogo, { BrandName } from '@/components/BrandLogo';
import { DashSection, LayoutDialog, useDashboardLayout } from '@/components/dashboard/DashboardLayout';
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
import { formatNumber, formatTime, msgid, type Translator } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import type { HaproxyAction, UpdateComponent, UpdateState } from '@/lib/types';
import type { BootstrapState } from '@/lib/bootstrap';
import type {
  CertificateDue,
  SystemCertificates,
  SystemContainer,
  SystemOverview,
  SystemProxy,
  SystemCrowdsec,
} from '@/lib/system/overview';

const POLL_MS = 25_000;

/** Dieselben Wörter wie im Protokoll unter /reverse-proxy/logs. */
const ACTION_LABELS: Record<HaproxyAction, string> = {
  create: msgid('Angelegt'),
  update: msgid('Geändert'),
  delete: msgid('Gelöscht'),
  settings: msgid('Einstellungen'),
  'scope-add': msgid('Gruppe angelegt'),
  'scope-remove': msgid('Gruppe entfernt'),
  'stream-create': msgid('TCP angelegt'),
  'stream-update': msgid('TCP geändert'),
  'stream-delete': msgid('TCP gelöscht'),
  certificate: msgid('Zertifikat'),
  import: msgid('Import'),
};

const BOOTSTRAP_LABELS: Record<BootstrapState['status'], string> = {
  pending: msgid('Steht noch aus'),
  running: msgid('Läuft'),
  ok: msgid('Abgeschlossen'),
  error: msgid('Mit Fehlern'),
  skipped: msgid('Übersprungen'),
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
  const { t, locale } = useT();
  return (
    <Link href={href} className={`kpi${tone && value !== null ? ` is-${tone}` : ''}`}>
      <span className="kpi-icon">{icon}</span>
      <span className="kpi-body">
        <span className="kpi-value">
          {value === null ? <small>{t('Unbekannt')}</small> : formatNumber(locale, value)}
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
  const { t } = useT();
  return (
    <ul className="hapm-steps hapm-flag-detail">
      {steps.map((step, index) => (
        <li key={`${index}-${step.label}`} className={`hapm-step ${step.ok ? 'is-ok' : 'is-failed'}`}>
          {step.ok ? <Check size={14} strokeWidth={1.5} /> : <X size={14} strokeWidth={1.5} />}
          <span className="hapm-step-text">
            <span className="hapm-step-label">{t(step.label)}</span>
            {step.detail && <span className="hapm-step-detail">{t(step.detail)}</span>}
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
  const { t } = useT();
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
        setLogError(body.error || t('Die Ausgabe ließ sich nicht lesen.'));
      }
    } catch {
      setLogError(t('Die Ausgabe ließ sich nicht lesen.'));
    }
  }, [apiFetch, t]);

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
          <strong>{t('Der Container von HAProxy fehlt.')}</strong>
          <span>
            {t(
              'Docker kennt keinen Container mit dem Namen „{name}“. HAPM legt ihn nicht an, er gehört zum Compose-Stack.',
              { name: haproxy.name }
            )}
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
        <strong>{looping ? t('HAProxy startet immer wieder neu.') : t('HAProxy läuft nicht.')}</strong>
        <span>
          {looping
            ? t('Der Container beendet sich kurz nach dem Start. Die Ausgabe nennt den Grund.')
            : t('Zustand des Containers: {status}. Solange er steht, ist kein Ziel erreichbar.', {
                status: haproxy.status ?? t('unbekannt'),
              })}
        </span>
      </div>
      <div className="hapm-flag-actions">
        <button type="button" className="btn btn-secondary btn-sm" onClick={toggle} aria-expanded={open}>
          {open ? <ChevronDown size={14} strokeWidth={1.5} /> : <ChevronRight size={14} strokeWidth={1.5} />}
          {t('Ausgabe')}
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={start} disabled={busy}>
          {busy ? (
            <Loader2 size={14} strokeWidth={1.5} className="spin" />
          ) : looping ? (
            <RotateCw size={14} strokeWidth={1.5} />
          ) : (
            <Play size={14} strokeWidth={1.5} />
          )}
          {looping ? t('Neu starten') : t('Starten')}
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
            {logs.trim() || t('Der Container hat nichts ausgegeben.')}
          </pre>
        ))}
    </div>
  );
}

function RenewalFailed({ at, output }: { at: string; output: string | null }) {
  const { t, locale } = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className="alert alert-warning sys-block hapm-flag">
      <AlertTriangle size={16} strokeWidth={1.5} />
      <div className="hapm-flag-body">
        <strong>{t('Die letzte Erneuerung der Zertifikate meldet einen Fehler.')}</strong>
        <span>
          {t('Lauf vom {date}. acme.sh versucht es beim nächsten täglichen Lauf erneut.', {
            date: formatDateTime(at, locale),
          })}
        </span>
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
            {t('Ausgabe')}
          </button>
        </div>
      )}
      {open && output && <pre className="run-log hapm-flag-detail">{output}</pre>}
    </div>
  );
}

function UnhealthyTargets({ proxy }: { proxy: SystemProxy }) {
  const { t, plural } = useT();
  if (proxy.unhealthy.length === 0) return null;
  const shown = proxy.unhealthy.slice(0, 6);
  const rest = proxy.unhealthy.length - shown.length;
  const allDown = proxy.unhealthy.every((target) => target.health === 'down');
  return (
    <div className={`alert ${allDown ? 'alert-danger' : 'alert-warning'} sys-block hapm-flag`}>
      <Unplug size={16} strokeWidth={1.5} />
      <div className="hapm-flag-body">
        <strong>
          {plural(proxy.unhealthy.length, {
            one: 'Ein Ziel erreicht sein Backend nicht.',
            other: '{count} Ziele erreichen ihr Backend nicht.',
          })}
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
              {target.health === 'partial' && ` ${t('(teilweise)')}`}
            </span>
          ))}
          {rest > 0 && ` ${t('und {count} weitere', { count: rest })}`}
        </span>
      </div>
    </div>
  );
}

function UpdatesAvailable({ states }: { states: UpdateState[] }) {
  const { t } = useT();
  const pending = states.filter((state) => state.updateAvailable === true);
  if (pending.length === 0) return null;
  return (
    <div className="alert alert-info sys-block hapm-flag">
      <Download size={16} strokeWidth={1.5} />
      <div className="hapm-flag-body">
        <strong>{pending.length === 1 ? t('Update verfügbar') : t('Updates verfügbar')}</strong>
        <span>
          {pending
            .map((state) => {
              const step = versionStep(state);
              return `${COMPONENT_LABELS[state.component]} ${step ?? t('(neues Abbild)')}`;
            })
            .join(', ')}
        </span>
      </div>
      <div className="hapm-flag-actions">
        <Link className="btn btn-primary btn-sm" href="/updates">
          {t('Zu den Updates')}
          <ArrowRight size={14} strokeWidth={1.5} />
        </Link>
      </div>
    </div>
  );
}

/** Beschriftung und Tooltip sind Schlüssel, die Seite zeigt sie mit `t()`. */
function containerBadge(container: SystemContainer): { label: string; cls: string; tooltip?: string } {
  if (container.exists === null) {
    return {
      label: msgid('Unbekannt'),
      cls: 'badge-neutral',
      tooltip: container.error ?? msgid('Docker ist nicht erreichbar.'),
    };
  }
  if (container.exists === false) return { label: msgid('Fehlt'), cls: 'badge-danger' };
  if (container.status === 'restarting') return { label: msgid('Startet neu'), cls: 'badge-danger' };
  if (!container.running) return { label: msgid('Gestoppt'), cls: 'badge-danger' };
  if (container.health === 'unhealthy') return { label: msgid('Läuft, Prüfung schlägt fehl'), cls: 'badge-warning' };
  return { label: msgid('Läuft'), cls: 'badge-success' };
}

function UpdateBadge({ state }: { state: UpdateState | undefined }) {
  const { t } = useT();
  if (!state) {
    return (
      <span className="badge-status badge-neutral">
        <span className="dot" />
        {t('Noch nicht geprüft')}
      </span>
    );
  }
  if (state.updateAvailable === true) {
    return (
      <Link href="/updates" className="badge-status badge-warning">
        <span className="dot" />
        {t('Update verfügbar')}
      </Link>
    );
  }
  if (state.updateAvailable === false) {
    return (
      <span className="badge-status badge-success">
        <span className="dot" />
        {t('Aktuell')}
      </span>
    );
  }
  return (
    <span className="badge-status badge-neutral" data-tooltip={state.error ?? undefined} data-tooltip-pos="left">
      <span className="dot" />
      {t('Unbekannt')}
    </span>
  );
}

function certBadge(cert: CertificateDue, t: Translator['t']): { label: string; cls: string } {
  if (cert.daysLeft === null) return { label: t('Erneuerung überfällig'), cls: 'badge-warning' };
  if (cert.daysLeft < 0) return { label: t('Abgelaufen'), cls: 'badge-danger' };
  if (cert.daysLeft === 0) return { label: t('Läuft heute ab'), cls: 'badge-danger' };
  if (cert.daysLeft === 1) return { label: t('Läuft morgen ab'), cls: 'badge-danger' };
  if (cert.renewalOverdue && cert.daysLeft >= 14) return { label: t('Erneuerung überfällig'), cls: 'badge-warning' };
  return { label: t('Läuft in {days} Tagen ab', { days: cert.daysLeft }), cls: 'badge-warning' };
}

function CertificatesCard({ certificates }: { certificates: SystemCertificates }) {
  const { t, plural, locale } = useT();
  const days = certificates.warnDays;
  let summary: string;
  if (certificates.total === null) {
    summary = t('Unbekannt. {reason}', {
      reason: certificates.error ? t(certificates.error) : t('acme.sh war nicht zu fragen.'),
    });
  } else if (certificates.total === 0) {
    summary = t('Noch kein Zertifikat. Das erste entsteht mit dem ersten Ziel.');
  } else if (certificates.due.length === 0 && certificates.expiring === 0) {
    summary = plural(
      certificates.total,
      {
        one: 'Ein Zertifikat. Es läuft in den nächsten {days} Tagen nicht ab.',
        other: '{count} Zertifikate. Keines läuft in den nächsten {days} Tagen ab.',
      },
      { days }
    );
  } else {
    summary = plural(certificates.total, { one: 'Ein Zertifikat.', other: '{count} Zertifikate.' });
  }

  return (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">
          {t('Zertifikate')}
          <InfoHint
            text={t(
              'Hier steht, was in den nächsten {days} Tagen abläuft oder was acme.sh schon hätte erneuern sollen. Das Ablaufdatum stammt aus der Datei, die HAProxy lädt.',
              { days }
            )}
          />
        </h2>
        <Link className="btn btn-ghost btn-sm" href="/reverse-proxy/zertifikate">
          {t('Alle')}
        </Link>
      </div>
      <div className="card-body">
        <p className="form-hint">{summary}</p>
        {certificates.due.length > 0 && (
          <div className="hapm-list">
            {certificates.due.map((cert) => {
              const badge = certBadge(cert, t);
              return (
                <div key={cert.mainDomain} className="activity-row">
                  <div className="activity-row-text">
                    <span className="activity-row-name">{cert.mainDomain}</span>
                    <span className="activity-row-sub">
                      {cert.expiresAt
                        ? t('Gültig bis {date}', { date: formatDate(cert.expiresAt, locale) })
                        : t('Ablaufdatum nicht lesbar')}
                      {cert.uploaded && `, ${t('hochgeladen')}`}
                      {cert.domains.length > 1 &&
                        `, ${plural(cert.domains.length - 1, {
                          one: '{count} weitere Domain',
                          other: '{count} weitere Domains',
                        })}`}
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
            {plural(certificates.unreadable, {
              one: 'Bei einem Zertifikat ist das Ablaufdatum nicht lesbar.',
              other: 'Bei {count} Zertifikaten ist das Ablaufdatum nicht lesbar.',
            })}
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

/** Die Bereiche der Übersicht, in der Reihenfolge der Vorgabe. */
const DASH_SECTIONS = ['live', 'proxy', 'security', 'certs', 'ops', 'quick', 'parts', 'recent'] as const;
type DashKey = (typeof DASH_SECTIONS)[number];

const SECTION_LABELS: Record<DashKey, string> = {
  live: msgid('Live-Verkehr'),
  proxy: msgid('Reverse-Proxy'),
  security: msgid('Sicherheit (CrowdSec)'),
  certs: msgid('Zertifikate'),
  ops: msgid('Betrieb'),
  quick: msgid('Schnellzugriffe'),
  parts: msgid('Bestandteile und Betrieb'),
  recent: msgid('Letzte Vorgänge und Zertifikate'),
};

/** Die Kennzahlen von CrowdSec. Ohne laufenden Container stehen Striche da, keine Nullen. */
function CrowdsecKpis({ crowdsec }: { crowdsec: SystemCrowdsec }) {
  const { t, locale } = useT();
  const summary = crowdsec.summary;
  if (!summary) return null;
  const down = !summary.running || !summary.bouncerRunning;
  return (
    <div className="kpi-grid">
      <Kpi
        href="/reverse-proxy/crowdsec"
        icon={<ShieldAlert size={16} strokeWidth={1.5} />}
        label={t('Geprüfte Ziele')}
        value={summary.global === true ? summary.totalServices : summary.protectedServices}
        sub={
          down
            ? t('CrowdSec läuft nicht')
            : summary.global === true
              ? t('alle, über den Schalter für alle')
              : t('von {count}', { count: formatNumber(locale, summary.totalServices) })
        }
        tone={down ? 'danger' : undefined}
      />
      <Kpi
        href="/reverse-proxy/crowdsec?bereich=sperren"
        icon={<Ban size={16} strokeWidth={1.5} />}
        label={t('Aktive Sperren')}
        value={summary.activeDecisions}
      />
      <Kpi
        href="/reverse-proxy/crowdsec?bereich=ereignisse"
        icon={<ShieldCheck size={16} strokeWidth={1.5} />}
        label={t('WAF-Treffer in 24 Stunden')}
        value={summary.waf24h}
        tone={summary.waf24h ? 'warning' : undefined}
      />
      <Kpi
        href="/reverse-proxy/statistiken?ansicht=crowdsec"
        icon={<AlertTriangle size={16} strokeWidth={1.5} />}
        label={t('Ereignisse in 24 Stunden')}
        value={summary.alerts24h}
      />
    </div>
  );
}

/** Eine Zeile der Tabelle „Bestandteile" für CrowdSec oder seinen Bouncer. */
function CrowdsecPartRow({
  name,
  container,
  state,
  now,
}: {
  name: string;
  container: SystemContainer;
  state: UpdateState | undefined;
  now: number;
}) {
  const { t, locale } = useT();
  const badge = containerBadge(container);
  return (
    <tr>
      <td data-label="primary">
        <div className="hapm-part">
          <span className="kpi-icon">
            <BrandLogo brand="crowdsec" size={16} />
          </span>
          <div>
            <strong>{name}</strong>
            <div className="detail-sub mono">{container.image ?? container.name}</div>
          </div>
        </div>
      </td>
      <td data-label={t('Version')}>{container.version ?? t('Unbekannt')}</td>
      <td data-label={t('Zustand')}>
        <span className={`badge-status ${badge.cls}`} data-tooltip={badge.tooltip ? t(badge.tooltip) : undefined}>
          <span className="dot" />
          {t(badge.label)}
        </span>
      </td>
      <td data-label={t('Läuft seit')}>
        {container.startedAt ? (
          <span data-tooltip={formatDateTime(container.startedAt, locale)}>{formatUptime(now, container.startedAt, locale)}</span>
        ) : container.exists === null ? (
          t('Unbekannt')
        ) : (
          t('Läuft nicht')
        )}
      </td>
      <td data-label={t('Update')}>
        <UpdateBadge state={state} />
      </td>
      <td data-label="actions" />
    </tr>
  );
}

export default function DashboardPage() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const now = useNow(10_000);
  const { t, plural, locale } = useT();

  const [data, setData] = useState<SystemOverview | null>(null);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const { layout, setLayout, toggleCollapsed, reset: resetLayout } = useDashboardLayout(DASH_SECTIONS);
  const [layoutOpen, setLayoutOpen] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/system');
      const body = await res.json();
      if (body.success) {
        setData(body.data as SystemOverview);
        setError('');
      } else {
        setError(body.error || t('Die Übersicht konnte nicht geladen werden.'));
      }
    } catch {
      setError(t('Die Übersicht konnte nicht geladen werden.'));
    }
  }, [apiFetch, t]);

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
        notify({ variant: 'error', title: 'HAProxy', message: body.error || t('Der Start ist fehlgeschlagen.') });
        return null;
      }
      const running = Boolean(body.data.container?.running);
      if (running) {
        notify({ variant: 'success', message: t('HAProxy läuft.') });
      } else {
        notify({
          variant: 'error',
          title: t('HAProxy läuft nicht'),
          message: t('Der Container hat sich nach dem Start wieder beendet. Die Ausgabe nennt den Grund.'),
        });
      }
      await load();
      return running;
    } catch {
      // Läuft die Oberfläche über HAProxy, reißt der Neustart die eigene Anfrage mit.
      notify({
        variant: 'info',
        title: t('Verbindung unterbrochen'),
        message: t('Die Antwort kam nicht an. Der Zustand wird gleich neu gelesen.'),
      });
      setTimeout(() => void load(), 4000);
      return null;
    }
  }, [apiFetch, load, notify, t]);

  function confirmRestart() {
    void confirm({
      title: t('HAProxy neu starten?'),
      message: t(
        'Alle offenen Verbindungen werden getrennt. HAProxy ist für wenige Sekunden nicht erreichbar. Läuft diese Oberfläche über HAProxy, bricht auch sie kurz ab.'
      ),
      confirmLabel: t('Neu starten'),
      variant: 'default',
      onConfirm: async () => {
        await restartHaproxy();
      },
    });
  }

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">{t('Übersicht')}</h1>
        <p className="page-subtitle">
          {data
            ? t('HAProxy auf {node}. Stand {time}.', {
                node: data.hapm.nodeName,
                time: formatTime(locale, data.generatedAt, true),
              })
            : t('Zustand von HAProxy, HAPM und acme.sh.')}
        </p>
      </div>
      <div className="page-actions">
        <button type="button" className="btn btn-ghost" onClick={() => setLayoutOpen(true)}>
          <LayoutList size={16} strokeWidth={1.5} />
          {t('Anpassen')}
        </button>
        <button type="button" className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
          {refreshing ? (
            <Loader2 size={16} strokeWidth={1.5} className="spin" />
          ) : (
            <RefreshCw size={16} strokeWidth={1.5} />
          )}
          {t('Aktualisieren')}
        </button>
        <Link className="btn btn-primary" href="/reverse-proxy">
          <Plus size={16} strokeWidth={1.5} />
          {t('Ziel anlegen')}
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

  const { docker, haproxy, hapm, acme, bootstrap, scheduler, logFollower, proxy, certificates, runs, crowdsec } = data;
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
          <span>{t('Die Angaben sind nicht aktuell: {error}', { error })}</span>
        </div>
      )}

      <SetupReminder />

      {!docker.available && (
        <div className="alert alert-danger sys-block hapm-flag">
          <AlertTriangle size={16} strokeWidth={1.5} />
          <div className="hapm-flag-body">
            <strong>{t('Der Docker-Socket ist nicht erreichbar.')}</strong>
            <span>
              {t(
                'Ohne ihn kann HAPM den Zustand von HAProxy nicht lesen, die Konfiguration nicht prüfen und keine Updates einspielen.'
              )}
            </span>
            {docker.error && <span className="hapm-flag-reason">{t(docker.error)}</span>}
          </div>
        </div>
      )}

      {haproxyDown && <HaproxyDown haproxy={haproxy} onRestart={restartHaproxy} />}

      {bootstrap.status === 'error' && (
        <div className="alert alert-danger sys-block hapm-flag">
          <AlertTriangle size={16} strokeWidth={1.5} />
          <div className="hapm-flag-body">
            <strong>{t('Die Ersteinrichtung ist mit Fehlern beendet.')}</strong>
            <span>{t('Sie läuft bei jedem Start von HAPM erneut und holt nach, was fehlt.')}</span>
          </div>
          <StepList steps={bootstrap.steps} />
        </div>
      )}

      {proxy.error && (
        <div className="alert alert-warning sys-block hapm-flag">
          <AlertTriangle size={16} strokeWidth={1.5} />
          <div className="hapm-flag-body">
            <strong>{t('Die Konfiguration von HAProxy war nicht zu lesen.')}</strong>
            <span>{t('Ziele, Gruppen und Weiterleitungen sind deshalb unbekannt.')}</span>
            <span className="hapm-flag-reason">{t(proxy.error)}</span>
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
          <h3>{t('Zuerst eine Gruppe anlegen')}</h3>
          <p>
            {t(
              'Eine Gruppe fasst Ziele zusammen, etwa „Websites“ oder „Intern“. Jedes Ziel gehört in eine Gruppe. Die erste legen Sie unter „Reverse-Proxy“ an, danach das erste Ziel.'
            )}
          </p>
          <Link className="btn btn-primary" href="/reverse-proxy">
            {t('Zum Reverse-Proxy')}
            <ArrowRight size={16} strokeWidth={1.5} />
          </Link>
        </div>
      )}

      {empty && proxy.scopes !== 0 && (
        <div className="empty-state sys-block">
          <Network size={40} strokeWidth={1.5} />
          <h3>{t('Noch kein Ziel angelegt')}</h3>
          <p>
            {t(
              'Unter „Reverse-Proxy“ eine Gruppe öffnen und dort „Ziel anlegen“ wählen. Das Zertifikat für die Domain stellt HAPM dabei selbst aus.'
            )}
          </p>
          <Link className="btn btn-primary" href="/reverse-proxy">
            <Plus size={16} strokeWidth={1.5} />
            {t('Zum Reverse-Proxy')}
          </Link>
        </div>
      )}

      {(() => {
        const sections: Record<DashKey, ReactNode> = {
          live: empty ? null : <LiveTraffic href="/reverse-proxy/statistiken" />,
          proxy: (
            <div className="kpi-grid">
              <Kpi
                href="/reverse-proxy"
                icon={<Network size={16} strokeWidth={1.5} />}
                label={t('Ziele')}
                value={proxy.services}
              />
              <Kpi
                href="/reverse-proxy"
                icon={<Layers size={16} strokeWidth={1.5} />}
                label={t('Gruppen')}
                value={proxy.scopes}
              />
              <Kpi
                href="/reverse-proxy"
                icon={<Cable size={16} strokeWidth={1.5} />}
                label={t('TCP-Weiterleitungen')}
                value={proxy.streams}
              />
              <Kpi
                href="/reverse-proxy"
                icon={<Unplug size={16} strokeWidth={1.5} />}
                label={t('Backend nicht erreichbar')}
                value={unhealthyCount}
                sub={proxy.checked ? t('von {count} geprüften', { count: formatNumber(locale, proxy.checked) }) : undefined}
                tone={proxy.down ? 'danger' : proxy.partial ? 'warning' : proxy.checked ? 'ok' : undefined}
              />
            </div>
          ),
          certs: (
            <div className="kpi-grid">
              <Kpi
                href="/reverse-proxy/zertifikate"
                icon={<ShieldCheck size={16} strokeWidth={1.5} />}
                label={t('Zertifikate')}
                value={certificates.total}
              />
              <Kpi
                href="/reverse-proxy/zertifikate"
                icon={<CalendarClock size={16} strokeWidth={1.5} />}
                label={t('Laufen in {days} Tagen ab', { days: certificates.warnDays })}
                value={certificates.expiring}
                tone={expired ? 'danger' : certificates.expiring ? 'warning' : undefined}
              />
            </div>
          ),
          security: <CrowdsecKpis crowdsec={crowdsec} />,
          ops: (
            <div className="kpi-grid">
              <Kpi
                href="/reverse-proxy/logs"
                icon={<AlertTriangle size={16} strokeWidth={1.5} />}
                label={t('Vorgänge fehlgeschlagen')}
                value={runs.failed}
                tone={runs.failed ? 'danger' : undefined}
              />
              <Kpi
                href="/updates"
                icon={<Download size={16} strokeWidth={1.5} />}
                label={t('Updates verfügbar')}
                value={pendingUpdates}
                tone={pendingUpdates ? 'warning' : undefined}
              />
            </div>
          ),
          quick: (
                  <div className="card">
                    <div className="kind-grid">
                      <Link className="kind-card" href="/reverse-proxy">
                        <span className="kind-card-icon">
                          <Plus size={17} strokeWidth={1.5} />
                        </span>
                        <span className="kind-card-text">
                          <span className="kind-card-title">{t('Ziel anlegen')}</span>
                          <span className="kind-card-sub">{t('Domain, Backend und Zertifikat in einem Vorgang.')}</span>
                        </span>
                      </Link>
                      <Link className="kind-card" href="/reverse-proxy/statistiken">
                        <span className="kind-card-icon">
                          <BarChart3 size={17} strokeWidth={1.5} />
                        </span>
                        <span className="kind-card-text">
                          <span className="kind-card-title">{t('Statistik')}</span>
                          <span className="kind-card-sub">{t('Anfragen, Statuscodes, Antwortzeiten und wer zugreift.')}</span>
                        </span>
                      </Link>
                      <Link className="kind-card" href="/reverse-proxy/logs">
                        <span className="kind-card-icon">
                          <ScrollText size={17} strokeWidth={1.5} />
                        </span>
                        <span className="kind-card-text">
                          <span className="kind-card-title">{t('Protokoll')}</span>
                          <span className="kind-card-sub">{t('Jeder Vorgang am Reverse-Proxy mit seinen Schritten.')}</span>
                        </span>
                      </Link>
                      <Link className="kind-card" href="/reverse-proxy/einstellungen">
                        <span className="kind-card-icon">
                          <Settings2 size={17} strokeWidth={1.5} />
                        </span>
                        <span className="kind-card-text">
                          <span className="kind-card-title">{t('Einstellungen')}</span>
                          <span className="kind-card-sub">{t('Was für alle Ziele gilt.')}</span>
                        </span>
                      </Link>
                      <Link className="kind-card" href="/updates">
                        <span className="kind-card-icon">
                          <Container size={17} strokeWidth={1.5} />
                        </span>
                        <span className="kind-card-text">
                          <span className="kind-card-title">{t('Updates')}</span>
                          <span className="kind-card-sub">{t('Neue Abbilder prüfen und einspielen.')}</span>
                        </span>
                      </Link>
                    </div>
                  </div>
          ),
          parts: (
                  <div className="hapm-cols">
                    <div className="card">
                      <div className="card-header">
                        <h2 className="card-title">{t('Bestandteile')}</h2>
                        <Link className="btn btn-ghost btn-sm" href="/updates">
                          {t('Updates')}
                        </Link>
                      </div>
                      <div className="table-wrap">
                        <table className="table">
                          <thead>
                            <tr>
                              <th>{t('Bestandteil')}</th>
                              <th>{t('Version')}</th>
                              <th>{t('Zustand')}</th>
                              <th>{t('Läuft seit')}</th>
                              <th>{t('Update')}</th>
                              <th aria-label={t('Aktionen')} />
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
                                    <strong>
                                      <BrandName brand="haproxy">HAProxy</BrandName>
                                    </strong>
                                    <div className="detail-sub mono">{haproxy.image ?? haproxy.name}</div>
                                  </div>
                                </div>
                              </td>
                              <td data-label={t('Version')}>{haproxy.version ?? t('Unbekannt')}</td>
                              <td data-label={t('Zustand')}>
                                <span
                                  className={`badge-status ${haproxyBadge.cls}`}
                                  data-tooltip={haproxyBadge.tooltip ? t(haproxyBadge.tooltip) : undefined}
                                >
                                  <span className="dot" />
                                  {t(haproxyBadge.label)}
                                </span>
                              </td>
                              <td data-label={t('Läuft seit')}>
                                {haproxy.startedAt ? (
                                  <span data-tooltip={formatDateTime(haproxy.startedAt, locale)}>
                                    {formatUptime(now, haproxy.startedAt, locale)}
                                  </span>
                                ) : haproxy.exists === null ? (
                                  t('Unbekannt')
                                ) : (
                                  t('Läuft nicht')
                                )}
                                {haproxy.restartCount !== null && haproxy.restartCount > 0 && (
                                  <div className="detail-sub">
                                    {plural(haproxy.restartCount, {
                                      one: 'Ein Neustart durch Docker',
                                      other: '{count} Neustarts durch Docker',
                                    })}
                                  </div>
                                )}
                              </td>
                              <td data-label={t('Update')}>
                                <UpdateBadge state={stateOf('haproxy')} />
                              </td>
                              <td data-label="actions">
                                {haproxy.running && (
                                  <div className="actions hapm-actions-end">
                                    <button
                                      type="button"
                                      className="btn btn-ghost btn-icon btn-sm"
                                      data-tooltip={t('HAProxy neu starten')}
                                      data-tooltip-pos="left"
                                      aria-label={t('HAProxy neu starten')}
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
                                      {hapm.image ?? (hapm.containerized ? t('Abbild unbekannt') : t('Läuft ohne Container'))}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td data-label={t('Version')}>{hapm.version}</td>
                              <td data-label={t('Zustand')}>
                                <span className="badge-status badge-success">
                                  <span className="dot" />
                                  {t('Läuft')}
                                </span>
                              </td>
                              <td data-label={t('Läuft seit')}>
                                {hapm.startedAt ? (
                                  <span data-tooltip={formatDateTime(hapm.startedAt, locale)}>
                                    {formatUptime(now, hapm.startedAt, locale)}
                                  </span>
                                ) : (
                                  t('Unbekannt')
                                )}
                              </td>
                              <td data-label={t('Update')}>
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
                                      {acme.accountEmail
                                        ? t('Konto: {email}', { email: acme.accountEmail })
                                        : t('Keine Adresse für das Konto hinterlegt')}
                                    </div>
                                  </div>
                                </div>
                              </td>
                              <td data-label={t('Version')}>{acme.version ?? t('Unbekannt')}</td>
                              <td data-label={t('Zustand')}>
                                {acme.installed === null ? (
                                  <span className="badge-status badge-neutral" data-tooltip={acme.error ?? undefined}>
                                    <span className="dot" />
                                    {t('Unbekannt')}
                                  </span>
                                ) : acme.installed ? (
                                  <span className="badge-status badge-success">
                                    <span className="dot" />
                                    {t('Eingerichtet')}
                                  </span>
                                ) : (
                                  <span className="badge-status badge-danger">
                                    <span className="dot" />
                                    {t('Nicht installiert')}
                                  </span>
                                )}
                              </td>
                              <td data-label={t('Läuft seit')}>
                                <span className="hapm-muted">{t('Läuft bei Bedarf')}</span>
                              </td>
                              <td data-label={t('Update')}>
                                <UpdateBadge state={stateOf('acme')} />
                              </td>
                              <td data-label="actions" />
                            </tr>
                            {crowdsec.summary?.inStack && (
                              <>
                                <CrowdsecPartRow
                                  name="CrowdSec"
                                  container={crowdsec.crowdsec}
                                  state={stateOf('crowdsec')}
                                  now={now}
                                />
                                <CrowdsecPartRow
                                  name={t('CrowdSec-Bouncer')}
                                  container={crowdsec.bouncer}
                                  state={stateOf('crowdsec-bouncer')}
                                  now={now}
                                />
                              </>
                            )}
                          </tbody>
                        </table>
                      </div>
                    </div>

                    <div className="card">
                      <div className="card-header">
                        <h2 className="card-title">{t('Betrieb')}</h2>
                      </div>
                      <div className="dash-kv">
                        <KvRow
                          label="Docker"
                          value={docker.available ? t('Version {version}', { version: docker.version ?? '' }) : t('Nicht erreichbar')}
                          tone={docker.available ? undefined : 'danger'}
                        />
                        <KvRow
                          label={t('Ersteinrichtung')}
                          value={t(BOOTSTRAP_LABELS[bootstrap.status])}
                          tone={bootstrap.status === 'error' ? 'danger' : bootstrap.status === 'ok' ? undefined : 'muted'}
                          tooltip={bootstrap.finishedAt ? formatDateTime(bootstrap.finishedAt, locale) : undefined}
                        />
                        <KvRow
                          label={t('Statistik')}
                          hint={t(
                            'HAPM sammelt die Zähler von HAProxy im Minutentakt ein. Die Angabe gilt seit dem letzten Start von HAPM.'
                          )}
                          value={
                            scheduler.lastStatsError
                              ? t('Fehler')
                              : scheduler.lastStatsRun
                                ? formatAgo(now, scheduler.lastStatsRun, locale)
                                : t('Noch keine Runde')
                          }
                          tone={scheduler.lastStatsError ? 'warning' : scheduler.lastStatsRun ? undefined : 'muted'}
                          tooltip={scheduler.lastStatsError ?? undefined}
                        />
                        <KvRow
                          label={t('Erneuerung')}
                          hint={t(
                            'acme.sh erneuert fällige Zertifikate einmal am Tag um 03:17 Uhr. Die Angabe gilt seit dem letzten Start von HAPM.'
                          )}
                          value={
                            scheduler.lastRenewal
                              ? t(scheduler.lastRenewal.ok ? '{ago}, ohne Fehler' : '{ago}, mit Fehler', {
                                  ago: formatAgo(now, scheduler.lastRenewal.at, locale),
                                })
                              : t('Noch kein Lauf')
                          }
                          tone={scheduler.lastRenewal ? (scheduler.lastRenewal.ok ? undefined : 'danger') : 'muted'}
                          tooltip={scheduler.lastRenewal ? formatDateTime(scheduler.lastRenewal.at, locale) : undefined}
                        />
                        <KvRow
                          label={t('Log-Mitschnitt')}
                          hint={t(
                            'HAPM schreibt die Ausgabe von HAProxy in eine Datei mit. Daraus liest die Statistik, wer zugreift: Adressen, Länder und Pfade.'
                          )}
                          value={
                            logFollower.connected
                              ? plural(logFollower.lines, { one: 'Verbunden, {count} Zeile', other: 'Verbunden, {count} Zeilen' })
                              : t('Getrennt')
                          }
                          tone={logFollower.connected ? undefined : 'warning'}
                          tooltip={
                            logFollower.last ? t('Letzte Zeile {time}', { time: formatDateTime(logFollower.last, locale) }) : undefined
                          }
                        />
                        <KvRow
                          label={t('Zeitgesteuerte Aufgaben')}
                          value={scheduler.started ? t('Aktiv') : t('Nicht gestartet')}
                          tone={scheduler.started ? undefined : 'warning'}
                        />
                      </div>
                    </div>
                  </div>
          ),
          recent: (
                  <div className="hapm-cols">
                    <div className="card">
                      <div className="card-header">
                        <h2 className="card-title">
                          {t('Letzte Vorgänge')}
                          {runs.running ? (
                            <span className="section-count">
                              {plural(runs.running, { one: '{count} läuft', other: '{count} laufen' })}
                            </span>
                          ) : null}
                        </h2>
                        <Link className="btn btn-ghost btn-sm" href="/reverse-proxy/logs">
                          {t('Protokoll')}
                        </Link>
                      </div>
                      {runs.recent === null ? (
                        <p className="form-hint">{t('Die Historie war nicht zu lesen.')}</p>
                      ) : runs.recent.length === 0 ? (
                        <p className="form-hint">{t('Noch kein Vorgang am Reverse-Proxy.')}</p>
                      ) : (
                        <div className="table-wrap">
                          <table className="table">
                            <thead>
                              <tr>
                                <th>{t('Eintrag')}</th>
                                <th>{t('Vorgang')}</th>
                                <th>{t('Status')}</th>
                                <th>{t('Dauer')}</th>
                                <th>{t('Zeitpunkt')}</th>
                                <th>{t('Ausgelöst von')}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {runs.recent.map((run) => (
                                <tr key={run.$id}>
                                  <td data-label="primary">
                                    <strong>{run.serviceId}</strong>
                                    {run.error && <div className="detail-error">{t(run.error)}</div>}
                                  </td>
                                  <td data-label={t('Vorgang')}>
                                    {ACTION_LABELS[run.action] ? t(ACTION_LABELS[run.action]) : run.action}
                                  </td>
                                  <td data-label={t('Status')}>
                                    <span className={`badge-status ${RUN_STATUS_CLASS[run.status] ?? 'badge-neutral'}`}>
                                      {run.status === 'running' && <Loader2 size={12} strokeWidth={1.5} className="spin" />}
                                      {RUN_STATUS_LABELS[run.status] ? t(RUN_STATUS_LABELS[run.status]) : run.status}
                                    </span>
                                  </td>
                                  <td data-label={t('Dauer')}>{run.duration !== null ? `${run.duration} s` : ''}</td>
                                  <td data-label={t('Zeitpunkt')}>
                                    <span data-tooltip={formatDateTime(run.startedAt, locale)}>
                                      {formatAgo(now, run.startedAt, locale)}
                                    </span>
                                  </td>
                                  <td data-label={t('Ausgelöst von')}>{run.triggeredBy ?? ''}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>

                    <CertificatesCard certificates={certificates} />
                  </div>
          ),
        };
        return layout.order
          .filter((key) => !layout.hidden.includes(key) && sections[key] !== null)
          .filter((key) => key !== 'security' || crowdsec.summary?.inStack)
          .map((key) => (
            <DashSection
              key={key}
              title={t(SECTION_LABELS[key])}
              icon={key === 'security' ? <BrandLogo brand="crowdsec" size={14} /> : undefined}
              collapsed={layout.collapsed.includes(key)}
              onToggle={() => toggleCollapsed(key)}
            >
              {sections[key]}
            </DashSection>
          ));
      })()}

      {layoutOpen && (
        <LayoutDialog
          layout={layout}
          labels={SECTION_LABELS}
          onChange={setLayout}
          onReset={resetLayout}
          onClose={() => setLayoutOpen(false)}
        />
      )}
    </>
  );
}
