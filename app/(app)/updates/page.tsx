'use client';

import { Fragment, useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Download,
  Info,
  LayoutDashboard,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import BrandLogo from '@/components/BrandLogo';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import EntityCard, { EntityField, EntityGrid } from '@/components/EntityCard';
import RunStepList from '@/components/runs/RunStepList';
import { startRun, subscribeRunFinished } from '@/components/runs/runs';
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
import { needsCheckAfterRun, remainingSteps } from '@/lib/updates/plan';
import { msgid, type Translator } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import type { HaproxyStep, UpdateComponent, UpdateRun, UpdateState } from '@/lib/types';

type RunView = Omit<UpdateRun, 'steps'> & { steps: HaproxyStep[] };

interface UpdateSettings {
  autoUpdate: UpdateComponent[];
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

const COMPONENTS: UpdateComponent[] = ['haproxy', 'hapm', 'acme', 'crowdsec', 'crowdsec-bouncer'];

/** CrowdSec steht nur da, wenn der Stack es mitbringt: dann gibt es einen Stand dafür. */
const OPTIONAL: UpdateComponent[] = ['crowdsec', 'crowdsec-bouncer'];

const COMPONENT_ICONS: Record<UpdateComponent, ReactNode> = {
  haproxy: <BrandLogo brand="haproxy" size={17} />,
  hapm: <LayoutDashboard size={17} strokeWidth={1.5} />,
  acme: <BrandLogo brand="acme" size={17} />,
  crowdsec: <BrandLogo brand="crowdsec" size={17} />,
  'crowdsec-bouncer': <BrandLogo brand="crowdsec" size={17} />,
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
  crowdsec: msgid(
    'Der Container von CrowdSec wird durch das neue Abbild ersetzt. Sperren, Freigaben und Regeln bleiben, sie liegen im Ordner der Daten. Während des Tauschs gehen Anfragen ungeprüft durch.'
  ),
  'crowdsec-bouncer': msgid(
    'Der Bouncer wird durch das neue Abbild ersetzt. Während des Tauschs gehen Anfragen ungeprüft durch.'
  ),
};

/** Was beim selbsttätigen Update geschieht, je Bestandteil in einem Satz. */
const AUTO_HINTS: Record<UpdateComponent, string> = {
  haproxy: msgid('Das neue Abbild prüft vorher die Konfiguration. HAProxy ist beim Tausch wenige Sekunden nicht erreichbar.'),
  acme: msgid('acme.sh aktualisiert sich selbst. Nichts wird unterbrochen.'),
  crowdsec: msgid('Während des Tauschs gehen Anfragen ungeprüft durch.'),
  'crowdsec-bouncer': msgid('Während des Tauschs gehen Anfragen ungeprüft durch.'),
  hapm: msgid('HAPM ersetzt sich selbst, die Oberfläche ist etwa eine Minute weg. Vorgabe: nur auf Klick.'),
};

const POLL_IDLE_MS = 30_000;
const POLL_RUNNING_MS = 2000;

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
  const pending = run.status === 'running' ? remainingSteps(run.component, run.steps) : [];
  return <RunStepList steps={run.steps} pending={pending} />;
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
      setOffline(true);
    }
  }, [apiFetch, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Das Fenster des Laufs hat sein Ende gesehen: den Stand gleich nachziehen.
  useEffect(
    () =>
      subscribeRunFinished((run) => {
        if (run.kind === 'update') void load();
      }),
    [load]
  );

  const activeRun = data?.runs.find((run) => run.status === 'running') ?? null;
  const locked = Boolean(data?.running) || starting !== null;

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

  /*
   * Der Lauf selbst steht im Fenster der Läufe (`components/runs/`), nicht auf
   * dieser Seite: es geht beim Start auf, die Pille unten rechts öffnet es
   * wieder. Dort stehen auch die Meldung am Ende und das Neuladen nach dem
   * Tausch von HAPM.
   */

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
      } else {
        startRun({ kind: 'update', id: body.data.runId as string });
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
              settings: { autoUpdate: saved.autoUpdate, autoUpdateTime: saved.autoUpdateTime },
            }
          : current
      );
      setTimeDraft(null);
      notify({
        variant: 'success',
        message:
          saved.autoUpdate.length > 0
            ? t('Selbsttätig aktualisiert wird täglich um {time} Uhr: {components}.', {
                time: saved.autoUpdateTime,
                components: saved.autoUpdate.map((component) => COMPONENT_LABELS[component]).join(', '),
              })
            : t('Nichts wird selbsttätig aktualisiert.'),
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

  const timeValue = timeDraft ?? data.settings.autoUpdateTime;
  const autoComponents = COMPONENTS.filter(
    (component) => !OPTIONAL.includes(component) || data.states.some((state) => state.component === component)
  );

  return (
    <>
      {header}

      {offline && (
        <div className="alert alert-warning sys-block">
          <AlertTriangle size={16} strokeWidth={1.5} />
          <span>
            {t('HAPM antwortet gerade nicht. Die Seite versucht es weiter.')}
            {activeRun?.component === 'haproxy' &&
              ` ${t('Läuft die Oberfläche über HAProxy, ist das beim Tausch zu erwarten.')}`}
            {activeRun?.component === 'hapm' && ` ${t('Beim Update von HAPM ist das zu erwarten.')}`}
          </span>
        </div>
      )}

      {error && !offline && <div className="alert alert-danger sys-block">{error}</div>}

      <div className="sys-block">
        <EntityGrid>
          {COMPONENTS.filter(
            (component) => !OPTIONAL.includes(component) || data.states.some((state) => state.component === component)
          ).map((component) => {
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
          <div className="hapm-auto-list">
            <p className="form-hint">
              {t(
                'Zur eingestellten Uhrzeit prüft HAPM, ob es Neues gibt, und spielt es für die gewählten Bestandteile nacheinander ein, HAPM selbst zuletzt.'
              )}
            </p>
            {autoComponents.map((component) => (
              <label key={component} className="form-subsection hapm-auto-switch">
                <div className="form-subsection-head">
                  <div>
                    <div className="form-section-title">
                      <span className="hapm-auto-icon">{COMPONENT_ICONS[component]}</span>
                      {COMPONENT_LABELS[component]}
                    </div>
                    <div className="form-section-sub">{t(AUTO_HINTS[component])}</div>
                  </div>
                  <span className="toggle-switch">
                    <input
                      type="checkbox"
                      checked={data.settings.autoUpdate.includes(component)}
                      disabled={savingSettings}
                      aria-label={COMPONENT_LABELS[component]}
                      onChange={(event) =>
                        void saveSettings({
                          autoUpdate: event.target.checked
                            ? [...data.settings.autoUpdate, component]
                            : data.settings.autoUpdate.filter((entry) => entry !== component),
                        })
                      }
                    />
                    <span className="toggle-slider" />
                  </span>
                </div>
              </label>
            ))}
          </div>
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
              disabled={savingSettings || data.settings.autoUpdate.length === 0}
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
