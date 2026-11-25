'use client';

import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Download,
  Info,
  LayoutDashboard,
  Loader2,
  Network,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import EntityCard, { EntityField, EntityGrid } from '@/components/EntityCard';
import { SkeletonCards, SkeletonRows } from '@/components/Skeleton';
import {
  COMPONENT_LABELS,
  RUN_STATUS_CLASS,
  RUN_STATUS_LABELS,
  formatAgo,
  formatClock,
  formatDateTime,
  versionStep,
} from '@/components/system/format';
import { HANDOVER_STEP, needsCheckAfterRun, remainingSteps } from '@/lib/updates/plan';
import { msgid, type Translator } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import type { HaproxyStep, UpdateComponent, UpdateRun, UpdateState } from '@/lib/types';

type RunView = Omit<UpdateRun, 'steps'> & { steps: HaproxyStep[] };

interface UpdateSettings {
  autoUpdateHaproxy: boolean;
  autoUpdateTime: string;
}

interface UpdatesData {
  states: UpdateState[];
  runs: RunView[];
  settings: UpdateSettings;
  running: boolean;
  /** Der Server prüft gerade (nach einem Lauf, nach dem Start oder im Takt). */
  checking: boolean;
}

const COMPONENTS: UpdateComponent[] = ['haproxy', 'hapm', 'acme'];

const COMPONENT_ICONS: Record<UpdateComponent, ReactNode> = {
  haproxy: <Network size={17} strokeWidth={1.5} />,
  hapm: <LayoutDashboard size={17} strokeWidth={1.5} />,
  acme: <ShieldCheck size={17} strokeWidth={1.5} />,
};

/** Was der Dialog vor dem Klick sagt: die Folge, nicht der Vorgang. */
const CONSEQUENCES: Record<UpdateComponent, string> = {
  haproxy: msgid(
    'Vor dem Tausch prüft das neue Abbild die vorhandene Konfiguration. Lehnt es sie ab, bleibt alles unverändert. Beim Tausch ist HAProxy für wenige Sekunden nicht erreichbar. Startet der neue Container nicht, kommt der bisherige zurück.'
  ),
  hapm: msgid(
    'HAPM ersetzt den eigenen Container durch das neue Abbild. Die Oberfläche ist dabei kurz nicht erreichbar und lädt danach neu. HAProxy läuft währenddessen weiter. Startet der neue Container nicht, kommt der bisherige zurück.'
  ),
  acme: msgid(
    'acme.sh aktualisiert sich selbst auf die neueste Fassung. HAProxy und die vorhandenen Zertifikate bleiben unberührt.'
  ),
};

const POLL_IDLE_MS = 30_000;
const POLL_RUNNING_MS = 2000;

/** Ab hier sagt die Übergabe von HAPM, dass sie länger dauert als üblich. */
const HANDOVER_SLOW_MS = 3 * 60 * 1000;

function shortDigest(digest: string): string {
  const [algorithm, hash] = digest.includes(':') ? digest.split(':') : ['', digest];
  return `${algorithm ? `${algorithm}:` : ''}${hash.slice(0, 12)}`;
}

function Digest({ digest }: { digest: string | null }) {
  if (!digest) return null;
  return (
    <code className="hapm-digest" data-tooltip={digest}>
      {shortDigest(digest)}
    </code>
  );
}

function triggeredByLabel(value: string | null, t: Translator['t']): string {
  if (!value) return '';
  return value === 'scheduler' ? t('Zeitplan') : value;
}

/**
 * Die Schritte eines Laufs. Solange er läuft, stehen dahinter die Schritte, die
 * noch kommen: der erste davon ist der, an dem gerade gearbeitet wird.
 */
function RunSteps({ run }: { run: RunView }) {
  const { t } = useT();
  const pending = run.status === 'running' ? remainingSteps(run.component, run.steps) : [];
  if (run.steps.length === 0 && pending.length === 0) {
    return <p className="form-hint">{t('Zu diesem Lauf sind keine Schritte festgehalten.')}</p>;
  }
  return (
    <ul className="hapm-steps">
      {run.steps.map((step, index) => (
        <li key={`${index}-${step.label}`} className={`hapm-step ${step.ok ? 'is-ok' : 'is-failed'}`}>
          {step.ok ? <Check size={14} strokeWidth={1.5} /> : <X size={14} strokeWidth={1.5} />}
          <span className="hapm-step-text">
            <span className="hapm-step-label">{t(step.label)}</span>
            {step.detail && <span className="hapm-step-detail">{t(step.detail)}</span>}
          </span>
        </li>
      ))}
      {pending.map((label, index) => (
        <li key={`pending-${label}`} className={`hapm-step ${index === 0 ? 'is-running' : 'is-pending'}`}>
          {index === 0 ? (
            <Loader2 size={14} strokeWidth={1.5} className="spin" />
          ) : (
            <Circle size={14} strokeWidth={1.5} />
          )}
          <span className="hapm-step-text">
            <span className="hapm-step-label">{t(label)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function runDuration(run: RunView, now: number): string {
  const start = Date.parse(run.startedAt);
  const end = run.completedAt ? Date.parse(run.completedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return '';
  return formatClock(end - start);
}

function runVersions(run: RunView, t: Translator['t']): string {
  if (run.fromVersion && run.toVersion && run.fromVersion !== run.toVersion) {
    return `${run.fromVersion} → ${run.toVersion}`;
  }
  return run.toVersion ?? run.fromVersion ?? t('Unbekannt');
}

export default function UpdatesPage() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t, plural, locale } = useT();
  const now = useNow(1000);

  const [data, setData] = useState<UpdatesData | null>(null);
  const [error, setError] = useState('');
  /** Eine Abfrage ist gescheitert. Während eines Tauschs ist das zu erwarten. */
  const [offline, setOffline] = useState(false);
  /** Ob HAPM seit dem Laden schon einmal nicht geantwortet hat. Danach ist es ein anderer Prozess. */
  const sawDown = useRef(false);
  const [checking, setChecking] = useState(false);
  const [starting, setStarting] = useState<UpdateComponent | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [savingSettings, setSavingSettings] = useState(false);
  const [timeDraft, setTimeDraft] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/updates', { cache: 'no-store' });
      const body = await res.json();
      if (body.success) {
        setData(body.data as UpdatesData);
        setError('');
        setOffline(false);
      } else {
        setError(body.error || t('Die Updates konnten nicht geladen werden.'));
        setOffline(false);
      }
    } catch {
      sawDown.current = true;
      setOffline(true);
    }
  }, [apiFetch, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const activeRun = data?.runs.find((run) => run.status === 'running') ?? null;
  const locked = Boolean(data?.running) || starting !== null;
  // Zwischen dem Schritt „Übergabe" und dem Ende des alten Containers liegt oft
  // weniger als eine Abfrage. Antwortet HAPM mitten im eigenen Update nicht mehr,
  // ist es dieselbe Lage.
  const handover =
    activeRun?.component === 'hapm' && (offline || activeRun.steps.some((step) => step.label === HANDOVER_STEP));

  const lastRunOf = (component: UpdateComponent) => data?.runs.find((run) => run.component === component) ?? null;

  /**
   * Nach einem Lauf stammt der Stand noch von der Prüfung davor, bis die nächste
   * durch ist. So lange steht dort nicht „Update verfügbar" für etwas, das
   * gerade eingespielt wurde.
   */
  const isSettling = (component: UpdateComponent, state: UpdateState | undefined): boolean =>
    needsCheckAfterRun(lastRunOf(component), state);

  const settling = data
    ? COMPONENTS.some((component) =>
        isSettling(
          component,
          data.states.find((state) => state.component === component)
        )
      )
    : false;

  // Solange etwas läuft oder auf eine Prüfung wartet, im Takt eines Laufs: der
  // Wechsel auf „Aktuell" soll erscheinen, sobald die Prüfung durch ist.
  usePolling(load, locked || offline || settling || data?.checking ? POLL_RUNNING_MS : POLL_IDLE_MS);

  /* Das Ende eines Laufs melden, den diese Seite hat laufen sehen. */
  const watchedRun = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const watched = watchedRun.current;
    const active = data.runs.find((run) => run.status === 'running') ?? null;
    if (watched && watched !== active?.$id) {
      const finished = data.runs.find((run) => run.$id === watched);
      if (finished && finished.status !== 'running') {
        const label = COMPONENT_LABELS[finished.component];
        if (finished.status === 'error') {
          notify({
            variant: 'error',
            title: t('{component}: Update fehlgeschlagen', { component: label }),
            message: finished.error ? t(finished.error) : t('Die Schritte stehen in der Historie.'),
          });
        } else if (finished.steps.some((step) => step.label === HANDOVER_STEP)) {
          // Die Seite stammt noch aus dem alten Abbild.
          window.location.reload();
          return;
        } else if (finished.component !== 'acme' && finished.steps.length <= 1) {
          notify({
            variant: 'info',
            title: label,
            message: t('Das laufende Abbild ist schon das neueste. Es wurde nichts getauscht.'),
          });
        } else {
          notify({
            variant: 'success',
            title: t('{component} aktualisiert', { component: label }),
            message: finished.toVersion
              ? t('Es läuft jetzt {version}.', { version: finished.toVersion })
              : t('Das neue Abbild läuft.'),
          });
        }
      }
    }
    watchedRun.current = active?.$id ?? null;
  }, [data, notify, t]);

  /*
   * Die Übergabe von HAPM: der Container wird ersetzt, Anfragen scheitern. Die
   * Seite fragt weiter und lädt neu, sobald HAPM nach der Lücke wieder antwortet.
   */
  useEffect(() => {
    if (!handover) return;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const res = await apiFetch('/api/health', { cache: 'no-store' });
        if (!res.ok) sawDown.current = true;
        else if (sawDown.current) window.location.reload();
      } catch {
        sawDown.current = true;
      } finally {
        busy = false;
      }
    }, POLL_RUNNING_MS);
    return () => clearInterval(timer);
  }, [handover, apiFetch]);

  async function check() {
    setChecking(true);
    try {
      const res = await apiFetch('/api/updates', { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        notify({ variant: 'error', message: body.error || t('Die Prüfung ist fehlgeschlagen.') });
        return;
      }
      const next = body.data as UpdatesData;
      setData(next);
      const available = next.states.filter((state) => state.updateAvailable === true).length;
      const unknown = next.states.filter((state) => state.updateAvailable === null).length;
      if (available > 0) {
        notify({
          variant: 'info',
          title: t('Geprüft'),
          message: plural(available, { one: 'Ein Update ist verfügbar.', other: '{count} Updates sind verfügbar.' }),
        });
      } else if (unknown > 0) {
        notify({
          variant: 'warning',
          title: t('Geprüft'),
          message: plural(unknown, {
            one: 'Bei einem Bestandteil ist das Ergebnis unbekannt. Der Grund steht auf seiner Karte.',
            other: 'Bei {count} Bestandteilen ist das Ergebnis unbekannt. Der Grund steht auf der jeweiligen Karte.',
          }),
        });
      } else {
        notify({ variant: 'success', title: t('Geprüft'), message: t('Alle Bestandteile sind aktuell.') });
      }
    } catch {
      notify({ variant: 'error', message: t('Die Prüfung ist fehlgeschlagen.') });
    } finally {
      setChecking(false);
    }
  }

  async function update(component: UpdateComponent, state: UpdateState) {
    const label = COMPONENT_LABELS[component];
    const step = versionStep(state);
    const confirmed = await confirm({
      title: t('{component} aktualisieren?', { component: label }),
      message: `${step ? `${label} ${step}. ` : ''}${t(CONSEQUENCES[component])}`,
      confirmLabel: t('Jetzt aktualisieren'),
      variant: 'default',
    });
    if (!confirmed) return;

    setStarting(component);
    try {
      const res = await apiFetch(`/api/updates/${component}`, { method: 'POST' });
      const body = await res.json();
      if (!body.success) {
        notify({ variant: 'error', title: label, message: body.error || t('Das Update ließ sich nicht starten.') });
      }
      await load();
    } catch {
      notify({ variant: 'error', title: label, message: t('Das Update ließ sich nicht starten.') });
    } finally {
      setStarting(null);
    }
  }

  async function saveSettings(patch: Partial<UpdateSettings>) {
    setSavingSettings(true);
    try {
      const res = await apiFetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const body = await res.json();
      if (!body.success) {
        notify({ variant: 'error', message: body.error || t('Die Einstellung ließ sich nicht speichern.') });
        return;
      }
      const saved = body.data.settings as UpdateSettings;
      setData((current) =>
        current
          ? {
              ...current,
              settings: { autoUpdateHaproxy: saved.autoUpdateHaproxy, autoUpdateTime: saved.autoUpdateTime },
            }
          : current
      );
      setTimeDraft(null);
      notify({
        variant: 'success',
        message: saved.autoUpdateHaproxy
          ? t('HAProxy wird täglich um {time} Uhr selbsttätig aktualisiert.', { time: saved.autoUpdateTime })
          : t('HAProxy wird nicht selbsttätig aktualisiert.'),
      });
    } catch {
      notify({ variant: 'error', message: t('Die Einstellung ließ sich nicht speichern.') });
    } finally {
      setSavingSettings(false);
    }
  }

  function toggleRun(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">{t('Updates')}</h1>
        <p className="page-subtitle">{t('Neue Abbilder für HAProxy und HAPM, neue Fassungen von acme.sh.')}</p>
      </div>
      <div className="page-actions">
        <button type="button" className="btn btn-secondary" onClick={check} disabled={!data || checking || locked}>
          {checking ? (
            <Loader2 size={16} strokeWidth={1.5} className="spin" />
          ) : (
            <RefreshCw size={16} strokeWidth={1.5} />
          )}
          {t('Jetzt prüfen')}
        </button>
      </div>
    </div>
  );

  if (!data) {
    return (
      <>
        {header}
        {error ? (
          <div className="alert alert-danger sys-block">{error}</div>
        ) : offline ? (
          <div className="alert alert-warning sys-block">
            <AlertTriangle size={16} strokeWidth={1.5} />
            <span>{t('HAPM antwortet gerade nicht. Die Seite versucht es weiter.')}</span>
          </div>
        ) : (
          <>
            <div className="sys-block">
              <SkeletonCards count={3} actions={1} />
            </div>
            <SkeletonRows count={3} />
          </>
        )}
      </>
    );
  }

  const handoverElapsed = activeRun ? now - Date.parse(activeRun.startedAt) : 0;
  const timeValue = timeDraft ?? data.settings.autoUpdateTime;

  return (
    <>
      {header}

      {handover ? (
        <div className="alert alert-info sys-block hapm-flag">
          <Loader2 size={16} strokeWidth={1.5} className="spin" />
          <div className="hapm-flag-body">
            <strong>{t('HAPM wird ersetzt')}</strong>
            <span>
              {t(
                'Ein Helfer aus dem neuen Abbild tauscht gerade den Container. Die Oberfläche ist kurz nicht erreichbar. Diese Seite lädt neu, sobald HAPM wieder antwortet.'
              )}
            </span>
            {handoverElapsed > HANDOVER_SLOW_MS && (
              <span>
                {t('Das dauert länger als üblich. Die Ausgabe des Containers auf dem Server zeigt, woran es hängt.')}
              </span>
            )}
          </div>
        </div>
      ) : (
        offline && (
          <div className="alert alert-warning sys-block">
            <AlertTriangle size={16} strokeWidth={1.5} />
            <span>
              {t('HAPM antwortet gerade nicht. Die Seite versucht es weiter.')}
              {activeRun?.component === 'haproxy' &&
                ` ${t('Läuft die Oberfläche über HAProxy, ist das beim Tausch zu erwarten.')}`}
            </span>
          </div>
        )
      )}

      {error && !offline && <div className="alert alert-danger sys-block">{error}</div>}

      {activeRun && (
        <div className="card sys-block">
          <div className="card-header">
            <div>
              <h2 className="card-title">
                <Loader2 size={16} strokeWidth={1.5} className="spin" />
                {t('{component} wird aktualisiert', { component: COMPONENT_LABELS[activeRun.component] })}
              </h2>
              <p className="card-subtitle">{t('Der Lauf geht weiter, auch wenn diese Seite geschlossen wird.')}</p>
            </div>
            <span className="run-timer">{runDuration(activeRun, now)}</span>
          </div>
          <RunSteps run={activeRun} />
        </div>
      )}

      <div className="sys-block">
        <EntityGrid>
          {COMPONENTS.map((component) => {
            const state = data.states.find((entry) => entry.component === component);
            const updating = activeRun?.component === component || starting === component;
            const stale = isSettling(component, state);
            const available = state?.updateAvailable === true && !stale;

            let badge: ReactNode;
            if (updating) {
              badge = (
                <span className="badge-status badge-neutral">
                  <Loader2 size={12} strokeWidth={1.5} className="spin" />
                  {t('Wird aktualisiert')}
                </span>
              );
            } else if (!state) {
              badge = (
                <span className="badge-status badge-neutral">
                  <span className="dot" />
                  {t('Noch nicht geprüft')}
                </span>
              );
            } else if (stale) {
              badge = data.checking ? (
                <span className="badge-status badge-neutral">
                  <Loader2 size={12} strokeWidth={1.5} className="spin" />
                  {t('Wird geprüft')}
                </span>
              ) : (
                <span className="badge-status badge-neutral">
                  <span className="dot" />
                  {t('Prüfung steht aus')}
                </span>
              );
            } else if (state.updateAvailable === true) {
              badge = (
                <span className="badge-status badge-warning">
                  <span className="dot" />
                  {t('Update verfügbar')}
                </span>
              );
            } else if (state.updateAvailable === false) {
              badge = (
                <span className="badge-status badge-success">
                  <span className="dot" />
                  {t('Aktuell')}
                </span>
              );
            } else {
              badge = (
                <span className="badge-status badge-neutral">
                  <span className="dot" />
                  {t('Unbekannt')}
                </span>
              );
            }

            return (
              <EntityCard
                key={component}
                icon={COMPONENT_ICONS[component]}
                name={COMPONENT_LABELS[component]}
                subtitle={
                  component === 'acme' ? t('Stellt die Zertifikate aus') : (state?.reference ?? t('Abbild unbekannt'))
                }
                badge={badge}
                actions={
                  available && state ? (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      onClick={() => void update(component, state)}
                      disabled={locked || checking}
                    >
                      <Download size={14} strokeWidth={1.5} />
                      {t('Jetzt aktualisieren')}
                    </button>
                  ) : undefined
                }
              >
                <EntityField label={t('Läuft')}>
                  <span className="hapm-version">
                    {state?.currentVersion ?? t('Version unbekannt')}
                    <Digest digest={state?.currentDigest ?? null} />
                  </span>
                </EntityField>
                <EntityField label={t('Verfügbar')}>
                  {!state ? (
                    <span className="hapm-muted">{t('Noch nicht geprüft')}</span>
                  ) : stale ? (
                    <span className="hapm-muted">{t('Seit dem letzten Lauf nicht geprüft')}</span>
                  ) : state.updateAvailable === true ? (
                    <span className="hapm-version">
                      {state.latestVersion && state.latestVersion !== state.currentVersion
                        ? state.latestVersion
                        : t('Neues Abbild derselben Fassung')}
                      <Digest digest={state.latestDigest} />
                    </span>
                  ) : state.updateAvailable === false ? (
                    <span className="hapm-muted">{t('Keine neuere Fassung')}</span>
                  ) : (
                    <span className="hapm-muted">{t('Unbekannt')}</span>
                  )}
                </EntityField>
                <EntityField label={t('Zuletzt geprüft')}>
                  {state?.checkedAt ? (
                    <span data-tooltip={formatDateTime(state.checkedAt, locale)}>
                      {formatAgo(now, state.checkedAt, locale)}
                    </span>
                  ) : (
                    <span className="hapm-muted">{t('Noch nie. Die erste Prüfung läuft kurz nach dem Start.')}</span>
                  )}
                </EntityField>
                {state?.error && !stale && (
                  <div className="form-note">
                    <Info size={14} strokeWidth={1.5} />
                    <span>
                      {state.updateAvailable !== null &&
                        `${t('Die letzte Prüfung ist gescheitert. Die Angabe stammt aus der Prüfung davor.')} `}
                      {t(state.error)}
                    </span>
                  </div>
                )}
              </EntityCard>
            );
          })}
        </EntityGrid>
      </div>

      <div className="card sys-block">
        <div className="card-header">
          <h2 className="card-title">{t('Selbsttätig aktualisieren')}</h2>
        </div>
        <div className="hapm-auto">
          <label className="form-subsection hapm-auto-switch">
            <div className="form-subsection-head">
              <div>
                <div className="form-section-title">
                  {t('HAProxy selbsttätig aktualisieren')}
                  <InfoHint
                    text={t(
                      'Zur eingestellten Uhrzeit prüft HAPM, ob es ein neues Abbild gibt, und spielt es ein. Vorher prüft das neue Abbild die Konfiguration. Startet der neue Container nicht, kommt der bisherige zurück. HAPM selbst und acme.sh werden nur auf Klick aktualisiert.'
                    )}
                  />
                </div>
                <div className="form-section-sub">
                  {t('Beim Tausch ist HAProxy für wenige Sekunden nicht erreichbar.')}
                </div>
              </div>
              <span className="toggle-switch">
                <input
                  type="checkbox"
                  checked={data.settings.autoUpdateHaproxy}
                  disabled={savingSettings}
                  onChange={(event) => void saveSettings({ autoUpdateHaproxy: event.target.checked })}
                />
                <span className="toggle-slider" />
              </span>
            </div>
          </label>
          <div className="form-group hapm-auto-time">
            <label className="form-label" htmlFor="auto-update-time">
              {t('Uhrzeit')}
              <InfoHint
                text={t(
                  'Es gilt die Zeitzone des Containers, gesetzt über die Variable TZ. Geprüft wird einmal am Tag zu dieser Minute.'
                )}
              />
            </label>
            <input
              id="auto-update-time"
              type="time"
              className="form-input"
              value={timeValue}
              disabled={savingSettings || !data.settings.autoUpdateHaproxy}
              onChange={(event) => setTimeDraft(event.target.value)}
              onBlur={() => {
                if (timeDraft && timeDraft !== data.settings.autoUpdateTime) {
                  void saveSettings({ autoUpdateTime: timeDraft });
                } else {
                  setTimeDraft(null);
                }
              }}
            />
          </div>
        </div>
      </div>

      <div className="section-header">
        <h2 className="section-title">
          {t('Historie')}
          <span className="section-count">{data.runs.length}</span>
        </h2>
        <span className="section-hint">{t('Die letzten Läufe, der neueste zuerst.')}</span>
      </div>

      {data.runs.length === 0 ? (
        <div className="empty-state">
          <Download size={32} strokeWidth={1.5} />
          <h3>{t('Noch kein Update eingespielt')}</h3>
          <p>{t('Hier steht jeder Lauf mit seinen Schritten, auch die selbsttätigen.')}</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('Zeitpunkt')}</th>
                <th>{t('Bestandteil')}</th>
                <th>{t('Fassung')}</th>
                <th>{t('Status')}</th>
                <th>{t('Dauer')}</th>
                <th>{t('Ausgelöst von')}</th>
                <th aria-label={t('Schritte')} />
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => {
                const open = expanded.has(run.$id);
                return (
                  <Fragment key={run.$id}>
                    <tr>
                      <td data-label={t('Zeitpunkt')}>{formatDateTime(run.startedAt, locale)}</td>
                      <td data-label="primary">
                        <strong>{COMPONENT_LABELS[run.component] ?? run.component}</strong>
                      </td>
                      <td data-label={t('Fassung')}>{runVersions(run, t)}</td>
                      <td data-label={t('Status')}>
                        <span className={`badge-status ${RUN_STATUS_CLASS[run.status] ?? 'badge-neutral'}`}>
                          {run.status === 'running' && <Loader2 size={12} strokeWidth={1.5} className="spin" />}
                          {RUN_STATUS_LABELS[run.status] ? t(RUN_STATUS_LABELS[run.status]) : run.status}
                        </span>
                        {run.error && <div className="detail-error">{t(run.error)}</div>}
                      </td>
                      <td data-label={t('Dauer')}>
                        <span className="sys-num">{runDuration(run, now)}</span>
                      </td>
                      <td data-label={t('Ausgelöst von')}>{triggeredByLabel(run.triggeredBy, t)}</td>
                      <td data-label="actions">
                        <div className="actions hapm-actions-end">
                          <button
                            type="button"
                            className="btn btn-ghost btn-icon btn-sm"
                            data-tooltip={open ? t('Schritte ausblenden') : t('Schritte anzeigen')}
                            data-tooltip-pos="left"
                            aria-label={open ? t('Schritte ausblenden') : t('Schritte anzeigen')}
                            aria-expanded={open}
                            onClick={() => toggleRun(run.$id)}
                          >
                            {open ? (
                              <ChevronDown size={16} strokeWidth={1.5} />
                            ) : (
                              <ChevronRight size={16} strokeWidth={1.5} />
                            )}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="hapm-run-detail">
                        <td colSpan={7}>
                          <RunSteps run={run} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
