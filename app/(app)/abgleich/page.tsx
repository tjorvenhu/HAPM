'use client';

import { Fragment, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowLeftRight,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  Copy,
  History,
  KeyRound,
  ListChecks,
  Loader2,
  Plus,
  Server,
  Trash2,
  Waypoints,
  X,
} from 'lucide-react';
import ErrorNote from '@/components/ErrorNote';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { useConfirm } from '@/components/ConfirmDialog';
import { errorText } from '@/components/errorText';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import { SkeletonDetail, SkeletonRows } from '@/components/Skeleton';
import AreaTabs, { useArea, type Area } from '@/components/AreaTabs';
import { RUN_STATUS_CLASS, RUN_STATUS_LABELS, formatClock } from '@/components/system/format';
import RunStepList from '@/components/runs/RunStepList';
import { startRun, subscribeRunFinished } from '@/components/runs/runs';
import { MISSING, formatDateTime, msgid, type Translator } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';
import { SYNC_ROLE_LABELS, SYNC_TRIGGER_LABELS, type SyncRole, type SyncWarning } from '@/lib/sync/types';
// Nur Typen: die Dateien dahinter erreichen `lib/db` und `lib/haproxy`.
import type { SyncOverview, SyncPeerView, SyncRunView } from '@/app/api/sync/route';

/**
 * Der Abgleich zwischen Knoten (docs/hochverfuegbarkeit.md). Je Reiter ein
 * Thema: wie es um die Knoten steht, welche Rolle dieser hat, und die Läufe.
 * Der gewählte steht als `?bereich=` in der Adresse. Ein laufender Abgleich
 * steht im Fenster der Läufe (`components/runs/`), nicht auf der Seite.
 */
type SyncArea = 'zustand' | 'rolle' | 'historie';

const AREAS: Area<SyncArea>[] = [
  { key: 'zustand', label: msgid('Zustand'), icon: Waypoints },
  { key: 'rolle', label: msgid('Rolle'), icon: Server },
  { key: 'historie', label: msgid('Historie'), icon: History },
];

const POLL_IDLE_MS = 30_000;
const POLL_RUNNING_MS = 2000;

const ROLE_CHOICES: { value: SyncRole; text: string; icon: typeof Server }[] = [
  { value: 'single', text: msgid('Kein Abgleich. HAPM verwaltet nur diesen Knoten.'), icon: Server },
  { value: 'primary', text: msgid('Hier wird geändert. Der Stand geht an die Folgeknoten.'), icon: ArrowUpFromLine },
  { value: 'replica', text: msgid('Übernimmt den Stand des Hauptknotens. Hier wird nichts geändert.'), icon: ArrowDownToLine },
];

const EXPOSURE_LABELS: Record<string, string> = {
  internal: msgid('Nur im eigenen Netz'),
  public: msgid('Aus dem Internet erreichbar'),
};

type Plural = Translator['plural'];

function warningText(warning: SyncWarning, t: Translator['t'], plural: Plural): string {
  switch (warning.code) {
    case 'hapm_version':
      return t('HAPM: hier {here}, dort {there}.', { here: warning.here, there: warning.there });
    case 'haproxy_version':
      return t('HAProxy: hier {here}, dort {there}.', { here: warning.here, there: warning.there });
    case 'exposure':
      return t('Art der Installation: hier „{here}“, dort „{there}“.', {
        here: t(EXPOSURE_LABELS[warning.here] ?? warning.here),
        there: t(EXPOSURE_LABELS[warning.there] ?? warning.there),
      });
    case 'crowdsec_off':
      return t('CrowdSec ist dort nicht eingeschaltet. Die Ziele laufen dort ohne WAF.');
    case 'skipped':
      return plural(warning.count, {
        one: '{count} Verweis oder Sonderdatei wird nicht übertragen.',
        other: '{count} Verweise oder Sonderdateien werden nicht übertragen.',
      });
  }
}

/** Der Zustand eines Folgeknotens als Marke: Klasse und Text. */
function peerState(peer: SyncPeerView): { className: string; label: string } {
  if (peer.reachable === false) return { className: 'badge-danger', label: msgid('Nicht erreichbar') };
  if (peer.lastError) return { className: 'badge-danger', label: msgid('Fehler') };
  if (peer.inSync === true) return { className: 'badge-success', label: msgid('Stand gleich') };
  if (peer.inSync === false) return { className: 'badge-warning', label: msgid('Weicht ab') };
  return { className: 'badge-neutral', label: msgid('Noch nicht geprüft') };
}

function triggeredByLabel(run: SyncRunView, t: Translator['t']): string {
  if (run.direction === 'receive') return run.triggeredBy ?? MISSING;
  if (run.trigger !== 'manual') return t(SYNC_TRIGGER_LABELS[run.trigger]);
  return run.triggeredBy ?? MISSING;
}

function runDuration(run: SyncRunView, now: number): string {
  const start = Date.parse(run.startedAt);
  const end = run.completedAt ? Date.parse(run.completedAt) : now;
  if (Number.isNaN(start) || Number.isNaN(end)) return MISSING;
  return formatClock(end - start);
}

export default function SyncPage() {
  return (
    <Suspense fallback={<SkeletonDetail />}>
      <Sync />
    </Suspense>
  );
}

function Sync() {
  const { apiFetch, reload: reloadSession } = useApp();
  const [area, selectArea] = useArea(AREAS, '/abgleich');
  const { notify } = useToast();
  const confirm = useConfirm();
  const { t, plural, rich, locale } = useT();
  const now = useNow(1000);

  const [data, setData] = useState<SyncOverview | null>(null);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [creatingKey, setCreatingKey] = useState(false);
  /** Der Klartext, genau einmal. Nach dem Schließen ist er unwiederbringlich weg. */
  const [issuedKey, setIssuedKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [peerForm, setPeerForm] = useState<{ url: string; key: string; name: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  const load = useCallback(async () => {
    try {
      const res = await apiFetch('/api/sync', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error);
      setData(body.data as SyncOverview);
      setError('');
    } catch (err: unknown) {
      setError(errorText(err, t('Der Stand des Abgleichs konnte nicht geladen werden.')));
    }
  }, [apiFetch, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const busy = Boolean(data?.running) || starting;
  usePolling(load, busy ? POLL_RUNNING_MS : POLL_IDLE_MS);

  // Das Fenster des Laufs hat sein Ende gesehen: Zustand und Historie gleich nachziehen.
  useEffect(
    () =>
      subscribeRunFinished((run) => {
        if (run.kind === 'sync') void load();
      }),
    [load]
  );

  async function start() {
    setStarting(true);
    try {
      const res = await apiFetch('/api/sync', { method: 'POST' });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error);
      startRun({ kind: 'sync', id: body.data.runId as string });
      await load();
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Abgleich fehlgeschlagen'),
        message: errorText(err, t('Der Abgleich ließ sich nicht starten.')),
      });
    } finally {
      setStarting(false);
    }
  }

  async function changeRole(next: SyncRole) {
    if (!data || next === data.role) return;
    const from = data.role;
    const confirmed = await confirm(
      next === 'replica'
        ? {
            title: t('Zum Folgeknoten machen?'),
            message: t(
              'Der erste Abgleich ersetzt Konfiguration und Zertifikate dieses Knotens durch die des Hauptknotens. Ziele, Zertifikate und Einstellungen des Proxys lassen sich hier danach nicht mehr ändern, und Zertifikate werden hier nicht mehr erneuert. Legen Sie vorher eine Sicherung an.'
            ),
            confirmLabel: t('Zum Folgeknoten machen'),
            variant: 'warning',
          }
        : next === 'primary'
          ? {
              title: t('Zum Hauptknoten machen?'),
              message:
                from === 'replica'
                  ? t(
                      'Ab dann wird hier geändert und erneuert, und es kommt kein Stand mehr an. Läuft der bisherige Hauptknoten noch oder kommt er zurück, muss er zuerst Folgeknoten werden: zwei Hauptknoten gleichen nicht ab.'
                    )
                  : t(
                      'Nach jeder Änderung geht der Stand an die eingetragenen Folgeknoten. Solange keiner eingetragen ist, ändert sich nichts.'
                    ),
              confirmLabel: t('Zum Hauptknoten machen'),
              variant: 'warning',
            }
          : {
              title: t('Abgleich abschalten?'),
              message:
                from === 'replica'
                  ? t(
                      'Dieser Knoten nimmt keinen Stand mehr an und lässt sich wieder selbst ändern. Zertifikate werden wieder hier erneuert.'
                    )
                  : t('Es geht kein Stand mehr an die Folgeknoten. Sie behalten ihren letzten Stand.'),
              confirmLabel: t('Abschalten'),
              variant: 'warning',
            }
    );
    if (!confirmed) return;

    setSwitching(true);
    try {
      const res = await apiFetch('/api/sync', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: next }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error);
      setData(body.data as SyncOverview);
      notify({ variant: 'success', message: t('Dieser Knoten ist jetzt: {role}.', { role: t(SYNC_ROLE_LABELS[next]) }) });
      // Der Hinweis über den Seiten des Proxys hängt an der Sitzung.
      void reloadSession();
      selectArea('zustand');
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Umstellen fehlgeschlagen'),
        message: errorText(err, t('Die Rolle ließ sich nicht umstellen.')),
      });
    } finally {
      setSwitching(false);
    }
  }

  async function createKey() {
    if (!data) return;
    if (data.replica.keySet) {
      const confirmed = await confirm({
        title: t('Neuen Kopplungsschlüssel erzeugen?'),
        message: t(
          'Der bisherige Schlüssel gilt danach nicht mehr, und die Bindung an den bisherigen Hauptknoten ist gelöst. Bis ein Hauptknoten den neuen Schlüssel eingetragen hat, kommt hier kein Stand mehr an.'
        ),
        confirmLabel: t('Neuen Schlüssel erzeugen'),
        variant: 'warning',
      });
      if (!confirmed) return;
    }
    setCreatingKey(true);
    try {
      const res = await apiFetch('/api/sync/key', { method: 'POST' });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error);
      setData(body.data.overview as SyncOverview);
      setIssuedKey(body.data.key as string);
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Erzeugen fehlgeschlagen'),
        message: errorText(err, t('Der Kopplungsschlüssel ließ sich nicht erzeugen.')),
      });
    } finally {
      setCreatingKey(false);
    }
  }

  async function copy(text: string) {
    // Ohne HTTPS gibt es `navigator.clipboard` nicht: dann wirft schon der Zugriff.
    try {
      await navigator.clipboard.writeText(text);
      notify({ message: t('Kopiert'), variant: 'success' });
    } catch {
      notify({ message: t('Kopieren nicht möglich. Bitte von Hand markieren.'), variant: 'error' });
    }
  }

  async function addPeer(event: FormEvent) {
    event.preventDefault();
    if (!peerForm) return;
    setAdding(true);
    try {
      const res = await apiFetch('/api/sync/peers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: peerForm.url.trim(), key: peerForm.key.trim(), name: peerForm.name.trim() }),
      });
      const body = await res.json();
      if (!res.ok || !body.success) throw new Error(body.error);
      setData(body.data as SyncOverview);
      setPeerForm(null);
      notify({ variant: 'success', message: t('Der Folgeknoten ist eingetragen. Der erste Abgleich beginnt gleich.') });
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Hinzufügen fehlgeschlagen'),
        message: errorText(err, t('Der Folgeknoten ließ sich nicht eintragen.')),
      });
    } finally {
      setAdding(false);
    }
  }

  async function removePeer(peer: SyncPeerView) {
    await confirm({
      title: t('Folgeknoten „{name}“ entfernen?', { name: peer.name }),
      message: t('Er behält seinen letzten Stand, es kommt nur keiner mehr nach. Seine Rolle ändert sich dadurch nicht.'),
      confirmLabel: t('Entfernen'),
      variant: 'danger',
      failedTitle: t('Entfernen fehlgeschlagen'),
      onConfirm: async () => {
        const res = await apiFetch(`/api/sync/peers/${encodeURIComponent(peer.$id)}`, { method: 'DELETE' });
        const body = await res.json();
        if (!res.ok || !body.success) throw new Error(body.error || t('Der Folgeknoten ließ sich nicht entfernen.'));
        setData(body.data as SyncOverview);
        notify({ variant: 'success', message: t('Der Folgeknoten ist entfernt.') });
      },
    });
  }

  function toggleRun(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const canStart = data?.role === 'primary' && data.peers.length > 0 && !busy;

  const header = (
    <div className="page-header">
      <div>
        <h1 className="page-title">
          {t('Abgleich')}
          <InfoHint
            text={t(
              'Für Hochverfügbarkeit laufen zwei oder mehr vollständige Installationen. Der Hauptknoten überträgt nach jeder Änderung, was HAProxy zum Ausliefern braucht. Welcher Knoten die gemeinsame Adresse hält, regelt keepalived oder ein Load Balancer davor.'
            )}
          />
        </h1>
        <p className="page-subtitle">{t('Konfiguration und Zertifikate auf weitere Knoten übertragen.')}</p>
      </div>
      {data?.role === 'primary' && (
        <div className="page-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void start()}
            disabled={!canStart}
            data-tooltip={data.peers.length === 0 ? t('Erst einen Folgeknoten eintragen.') : undefined}
            data-tooltip-pos="left"
          >
            {busy ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <ArrowLeftRight size={16} strokeWidth={1.5} />}
            {t('Jetzt abgleichen')}
          </button>
        </div>
      )}
    </div>
  );

  if (!data) {
    return (
      <>
        {header}
        {error ? (
          <div className="alert alert-danger sys-block">
            <ErrorNote text={error} />
          </div>
        ) : (
          <>
            <div className="sys-block">
              <SkeletonDetail />
            </div>
            <SkeletonRows count={3} />
          </>
        )}
      </>
    );
  }

  const { replica } = data;
  const rejected = replica.rejected;

  const nodeCard = (
    <div className="card">
      <div className="card-header">
        <h2 className="card-title">
          <Server size={17} strokeWidth={1.5} />
          {t('Dieser Knoten')}
        </h2>
      </div>
      <div className="card-body">
        <dl className="detail-grid">
          <dt>{t('Rolle')}</dt>
          <dd>{t(SYNC_ROLE_LABELS[data.role])}</dd>
          <dt>{t('Name')}</dt>
          <dd>{data.node.name}</dd>
          <dt>HAPM</dt>
          <dd>{data.node.hapmVersion}</dd>
        </dl>
      </div>
    </div>
  );

  return (
    <>
      {header}

      {error && (
        <div className="alert alert-danger sys-block">
          <ErrorNote text={error} />
        </div>
      )}

      {rejected && (
        <div className="alert alert-warning sys-block">
          <AlertTriangle size={16} strokeWidth={1.5} />
          <span>
            {rejected.code === 'other_primary'
              ? t(
                  'Der Knoten {name} wollte am {when} hierher abgleichen und wurde abgelehnt: dieser Knoten ist an einen anderen Hauptknoten gebunden. Ein neuer Kopplungsschlüssel löst die Bindung.',
                  { name: rejected.name, when: formatDateTime(locale, rejected.at) }
                )
              : t(
                  'Der Knoten {name} hält sich für den Hauptknoten und wollte am {when} hierher abgleichen. Es wurde nichts übernommen. Einer der beiden Knoten muss Folgeknoten werden.',
                  { name: rejected.name, when: formatDateTime(locale, rejected.at) }
                )}
          </span>
        </div>
      )}

      <AreaTabs areas={AREAS} value={area} onChange={selectArea} />

      {area === 'zustand' && data.role === 'single' && (
        <div className="empty-state">
          <ArrowLeftRight size={32} strokeWidth={1.5} />
          <h3>{t('Dieser Knoten arbeitet einzeln')}</h3>
          <p>{t('Für Hochverfügbarkeit bekommt ein Knoten die Rolle Hauptknoten und ein zweiter die Rolle Folgeknoten.')}</p>
          <button type="button" className="btn btn-secondary" onClick={() => selectArea('rolle')}>
            {t('Rolle festlegen')}
          </button>
        </div>
      )}

      {area === 'zustand' && data.role === 'primary' && (
        <div className="hapm-fit">
          <div className="hapm-main-side">
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">
                  <Waypoints size={17} strokeWidth={1.5} />
                  {t('Folgeknoten')}
                </h2>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={() => setPeerForm({ url: '', key: '', name: '' })}
                >
                  <Plus size={14} strokeWidth={1.5} />
                  {t('Folgeknoten hinzufügen')}
                </button>
              </div>

              {data.peers.length === 0 ? (
                <div className="empty-state">
                  <Waypoints size={32} strokeWidth={1.5} />
                  <h3>{t('Noch kein Folgeknoten')}</h3>
                  <p>
                    {t(
                      'Auf dem zweiten Knoten die Rolle Folgeknoten wählen, dort einen Kopplungsschlüssel erzeugen und ihn hier eintragen.'
                    )}
                  </p>
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table table-cards">
                    <thead>
                      <tr>
                        <th>{t('Knoten')}</th>
                        <th>{t('Stand')}</th>
                        <th>{t('Letzter Abgleich')}</th>
                        <th>{t('Fassungen')}</th>
                        <th aria-label={t('Aktionen')} />
                      </tr>
                    </thead>
                    <tbody>
                      {data.peers.map((peer) => {
                        const state = peerState(peer);
                        return (
                          <tr key={peer.$id}>
                            <td data-label="primary">
                              <strong>{peer.name}</strong>
                              <div className="detail-sub">{peer.url}</div>
                            </td>
                            <td data-label={t('Stand')}>
                              <span className={`badge-status ${state.className}`}>{t(state.label)}</span>
                              {peer.lastError && <div className="detail-error">{peer.lastError}</div>}
                              {peer.warnings.map((warning) => (
                                <div className="detail-sub" key={warning.code}>
                                  {warningText(warning, t, plural)}
                                </div>
                              ))}
                            </td>
                            <td data-label={t('Letzter Abgleich')}>
                              {peer.lastSyncAt ? formatDateTime(locale, peer.lastSyncAt) : t('noch nie')}
                              {peer.lastCheckAt && (
                                <div className="detail-sub">
                                  {t('Geprüft: {when}', { when: formatDateTime(locale, peer.lastCheckAt) })}
                                </div>
                              )}
                            </td>
                            <td data-label={t('Fassungen')}>
                              <span className="sys-num">HAPM {peer.hapmVersion ?? MISSING}</span>
                              <div className="detail-sub">HAProxy {peer.haproxyVersion ?? MISSING}</div>
                            </td>
                            <td data-label="actions">
                              <div className="actions hapm-actions-end">
                                <button
                                  type="button"
                                  className="btn btn-ghost btn-icon btn-sm"
                                  data-tooltip={t('Entfernen')}
                                  data-tooltip-pos="left"
                                  aria-label={t('Folgeknoten „{name}“ entfernen', { name: peer.name })}
                                  onClick={() => void removePeer(peer)}
                                >
                                  <Trash2 size={16} strokeWidth={1.5} />
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="hapm-side">{nodeCard}</div>
          </div>
        </div>
      )}

      {area === 'zustand' && data.role === 'replica' && (
        <div className="hapm-fit">
          <div className="hapm-main-side">
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">
                  <ArrowDownToLine size={17} strokeWidth={1.5} />
                  {t('Stand vom Hauptknoten')}
                </h2>
              </div>
              <div className="card-body">
                {!replica.keySet && (
                  <div className="alert alert-warning">
                    <AlertTriangle size={16} strokeWidth={1.5} />
                    <span>{t('Es gibt noch keinen Kopplungsschlüssel. Ohne ihn kann kein Hauptknoten hierher abgleichen.')}</span>
                  </div>
                )}
                {replica.keySet && !replica.applied && (
                  <div className="alert alert-info">
                    <span>
                      {t(
                        'Es ist noch kein Stand angekommen. Tragen Sie auf dem Hauptknoten unter „Abgleich“ die Adresse dieses Knotens und den Kopplungsschlüssel ein.'
                      )}
                    </span>
                  </div>
                )}
                <dl className="detail-grid">
                  <dt>{t('Hauptknoten')}</dt>
                  <dd>{replica.primary?.name ?? t('Noch keiner')}</dd>
                  <dt>{t('Letzter Abgleich')}</dt>
                  <dd>{replica.applied ? formatDateTime(locale, replica.applied.at) : t('noch nie')}</dd>
                  <dt>{t('Dateien')}</dt>
                  <dd>
                    {replica.intact === true
                      ? t('Unverändert seit dem Abgleich')
                      : replica.intact === false
                        ? t('Hier geändert seit dem Abgleich')
                        : t('Unbekannt')}
                  </dd>
                </dl>
                {replica.intact === false && (
                  <div className="alert alert-warning">
                    <AlertTriangle size={16} strokeWidth={1.5} />
                    <span>
                      {t(
                        'Auf diesem Knoten wurden Dateien des Proxys geändert. Der Hauptknoten bemerkt das bei seiner nächsten Prüfung und überträgt seinen Stand erneut.'
                      )}
                    </span>
                  </div>
                )}
                {replica.applied?.crowdsec === 'removed' && (
                  <div className="alert alert-warning">
                    <AlertTriangle size={16} strokeWidth={1.5} />
                    <span>
                      {t(
                        'CrowdSec ist auf diesem Knoten nicht eingeschaltet und wurde aus der Konfiguration genommen. Die Ziele laufen hier ohne WAF.'
                      )}
                    </span>
                  </div>
                )}
                {replica.applied?.crowdsec === 'stuck' && (
                  <div className="alert alert-warning">
                    <AlertTriangle size={16} strokeWidth={1.5} />
                    <span>
                      {t(
                        'CrowdSec ist auf diesem Knoten nicht eingeschaltet, ließ sich aber nicht aus der Konfiguration nehmen. HAProxy wartet hier bei jeder Anfrage auf den Bouncer.'
                      )}
                    </span>
                  </div>
                )}
                {replica.adaptationChanged && (
                  <div className="alert alert-info">
                    <span>
                      {t(
                        'CrowdSec wurde auf diesem Knoten umgestellt. Der Hauptknoten überträgt seinen Stand bei der nächsten Prüfung erneut.'
                      )}
                    </span>
                  </div>
                )}
              </div>
            </div>

            <div className="hapm-side">
              {nodeCard}
              <div className="card">
                <div className="card-header">
                  <h2 className="card-title">
                    <KeyRound size={17} strokeWidth={1.5} />
                    {t('Kopplungsschlüssel')}
                    <InfoHint
                      text={t(
                        'Mit ihm ist jede Übertragung verschlüsselt, auch über http. Er wird hier erzeugt, einmal gezeigt und auf dem Hauptknoten eingetragen.'
                      )}
                    />
                  </h2>
                </div>
                <div className="card-body">
                  <dl className="detail-grid">
                    <dt>{t('Erzeugt')}</dt>
                    <dd>{replica.keyCreatedAt ? formatDateTime(locale, replica.keyCreatedAt) : t('Noch keiner')}</dd>
                  </dl>
                  <div className="hapm-form-actions">
                    <button type="button" className="btn btn-secondary" disabled={creatingKey} onClick={() => void createKey()}>
                      {creatingKey ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <KeyRound size={16} strokeWidth={1.5} />}
                      {replica.keySet ? t('Neuen Schlüssel erzeugen') : t('Schlüssel erzeugen')}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {area === 'rolle' && (
        <>
          <div className="card sys-block">
            <div className="card-header">
              <div>
                <h2 className="card-title">
                  <Server size={17} strokeWidth={1.5} />
                  {t('Rolle dieses Knotens')}
                </h2>
                <p className="card-subtitle">{t('Sie bestimmt, ob hier geändert oder nur übernommen wird.')}</p>
              </div>
            </div>
            <div className="card-body">
              <div className="hapm-choices">
                {ROLE_CHOICES.map((option) => {
                  const Icon = option.icon;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={`hapm-choice${data.role === option.value ? ' is-selected' : ''}`}
                      aria-pressed={data.role === option.value}
                      disabled={switching || busy}
                      onClick={() => void changeRole(option.value)}
                    >
                      <Icon size={18} strokeWidth={1.5} />
                      <span className="hapm-choice-text">
                        <strong>{t(SYNC_ROLE_LABELS[option.value])}</strong>
                        <span>{t(option.text)}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
              <div className="alert alert-info">
                <span>
                  {t(
                    'Welcher Knoten die gemeinsame Adresse hält, entscheidet nicht HAPM, sondern keepalived oder ein Load Balancer davor.'
                  )}
                </span>
              </div>
            </div>
          </div>

          <div className="card sys-block">
            <div className="card-header">
              <h2 className="card-title">
                <ListChecks size={17} strokeWidth={1.5} />
                {t('Was übertragen wird')}
              </h2>
            </div>
            <div className="card-body">
              <dl className="detail-grid">
                <dt>HAProxy</dt>
                <dd>
                  {rich('{path}: Konfiguration, Zertifikate, Fehlerseiten, Sperrlisten.', { path: <code>/etc/haproxy</code> })}
                </dd>
                <dt>acme.sh</dt>
                <dd>{t('Konto, Zertifikate und Erneuerungseinträge. Erneuert wird nur auf dem Hauptknoten.')}</dd>
                <dt>{t('Nicht übertragen')}</dt>
                <dd className="muted">
                  {t(
                    'Die Datenbank: Konten, Einstellungen, DNS-Zonen, API-Keys, Statistik und Protokoll. Dazu Sperren und Regeln von CrowdSec.'
                  )}
                </dd>
              </dl>
            </div>
          </div>
        </>
      )}

      {area === 'historie' && (
        <>
          <div className="section-header">
            <h2 className="section-title">
              {t('Historie')}
              <span className="section-count">{data.runs.length}</span>
            </h2>
            <span className="section-hint">{t('Die letzten Läufe, der neueste zuerst.')}</span>
          </div>

          {data.runs.length === 0 ? (
            <div className="empty-state">
              <ArrowLeftRight size={32} strokeWidth={1.5} />
              <h3>{t('Noch kein Lauf')}</h3>
              <p>{t('Hier steht jeder Abgleich, bei dem ein Stand übertragen wurde oder ein Folgeknoten ausfiel.')}</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table table-cards">
                <thead>
                  <tr>
                    <th>{t('Beginn')}</th>
                    <th>{t('Ergebnis')}</th>
                    <th>{t('Richtung')}</th>
                    <th>{t('Gegenstelle')}</th>
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
                          <td data-label="primary">
                            <strong>{formatDateTime(locale, run.startedAt)}</strong>
                          </td>
                          <td data-label={t('Ergebnis')}>
                            <span className={`badge-status ${RUN_STATUS_CLASS[run.status] ?? 'badge-neutral'}`}>
                              {run.status === 'running' && <Loader2 size={12} strokeWidth={1.5} className="spin" />}
                              {RUN_STATUS_LABELS[run.status] ? t(RUN_STATUS_LABELS[run.status]) : run.status}
                            </span>
                            {run.error && <div className="detail-error">{t(run.error)}</div>}
                          </td>
                          <td data-label={t('Richtung')}>{run.direction === 'receive' ? t('Empfangen') : t('Gesendet')}</td>
                          <td data-label={t('Gegenstelle')}>{run.peers || MISSING}</td>
                          <td data-label={t('Dauer')}>
                            <span className="sys-num">{runDuration(run, now)}</span>
                          </td>
                          <td data-label={t('Ausgelöst von')}>{triggeredByLabel(run, t)}</td>
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
                                {open ? <ChevronDown size={16} strokeWidth={1.5} /> : <ChevronRight size={16} strokeWidth={1.5} />}
                              </button>
                            </div>
                          </td>
                        </tr>
                        {open && (
                          <tr className="hapm-run-detail">
                            <td colSpan={7} data-label="primary">
                              <RunStepList steps={run.steps} pending={[]} />
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
      )}

      {peerForm && (
        <div className="modal-overlay" onClick={(event) => event.target === event.currentTarget && !adding && setPeerForm(null)}>
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">{t('Folgeknoten hinzufügen')}</h2>
              <button
                type="button"
                className="modal-close"
                aria-label={t('Dialog schließen')}
                disabled={adding}
                onClick={() => setPeerForm(null)}
              >
                <X size={16} strokeWidth={1.5} />
              </button>
            </div>
            <form onSubmit={addPeer}>
              <div className="modal-body">
                <div className="alert alert-warning sys-block">
                  <AlertTriangle size={16} strokeWidth={1.5} />
                  <span>
                    {t('Der erste Abgleich ersetzt Konfiguration und Zertifikate des Folgeknotens durch die von hier.')}
                  </span>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="sync-peer-url">
                    {t('Adresse des Folgeknotens')}
                    <InfoHint
                      text={t(
                        'Die Adresse seiner Oberfläche, mit Port. Auch ohne HTTPS: jede Übertragung ist mit dem Kopplungsschlüssel verschlüsselt.'
                      )}
                    />
                  </label>
                  <input
                    id="sync-peer-url"
                    className="form-input"
                    type="text"
                    required
                    placeholder="http://10.0.0.2:7080"
                    value={peerForm.url}
                    disabled={adding}
                    onChange={(event) => setPeerForm({ ...peerForm, url: event.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="sync-peer-key">
                    {t('Kopplungsschlüssel')}
                  </label>
                  <input
                    id="sync-peer-key"
                    className="form-input"
                    type="password"
                    required
                    placeholder="hapmsync_…"
                    value={peerForm.key}
                    disabled={adding}
                    onChange={(event) => setPeerForm({ ...peerForm, key: event.target.value })}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <span className="form-hint">{t('Wird auf dem Folgeknoten unter „Abgleich“ erzeugt.')}</span>
                </div>
                <div className="form-group">
                  <label className="form-label" htmlFor="sync-peer-name">
                    {t('Name')}
                  </label>
                  <input
                    id="sync-peer-name"
                    className="form-input"
                    type="text"
                    maxLength={60}
                    value={peerForm.name}
                    disabled={adding}
                    onChange={(event) => setPeerForm({ ...peerForm, name: event.target.value })}
                    autoComplete="off"
                  />
                  <span className="form-hint">{t('Leer: der Name, den der Knoten selbst nennt.')}</span>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn btn-secondary" disabled={adding} onClick={() => setPeerForm(null)}>
                  {t('Abbrechen')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={adding}>
                  {adding ? <Loader2 size={16} strokeWidth={1.5} className="spin" /> : <Plus size={16} strokeWidth={1.5} />}
                  {t('Hinzufügen')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {issuedKey && (
        // Kein Klick-daneben-zum-Schließen: der Klartext existiert genau einmal,
        // und ein versehentlicher Klick neben das Fenster wäre unwiederbringlich.
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">{t('Kopplungsschlüssel')}</h2>
            </div>
            <div className="modal-body">
              <div className="alert alert-warning sys-block">
                {t(
                  'Jetzt kopieren und auf dem Hauptknoten unter „Abgleich“ eintragen. Nach dem Schließen zeigt HAPM ihn nicht wieder, es bleibt nur, einen neuen zu erzeugen.'
                )}
              </div>
              <div className="form-group">
                <label className="form-label" htmlFor="sync-issued-key">
                  {t('Kopplungsschlüssel')}
                </label>
                <div className="form-list-row">
                  <input
                    id="sync-issued-key"
                    className="form-input"
                    value={issuedKey}
                    readOnly
                    onFocus={(event) => event.target.select()}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-icon"
                    data-tooltip={t('Kopieren')}
                    aria-label={t('Kopieren')}
                    onClick={() => void copy(issuedKey)}
                  >
                    <Copy size={16} />
                  </button>
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn btn-primary" onClick={() => setIssuedKey(null)}>
                <X size={16} />
                {t('Kopiert, schließen')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
