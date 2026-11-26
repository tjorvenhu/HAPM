'use client';

import { useEffect, useState, useCallback } from 'react';
import ErrorNote from '@/components/ErrorNote';
import Link from 'next/link';
import {
  Network, Globe, Loader2, RefreshCw, ScrollText, ChevronRight, FolderPlus, Info, X, ShieldCheck,
  FileInput,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import { usePolling } from '@/components/usePolling';
import EntityCard, { EntityGrid, EntityTags, EntityTag, EntityField } from '@/components/EntityCard';
import {
  scopePages,
  servicesInScope,
  streamsInScope,
  unmanagedCount,
  type ProxyRow,
} from '@/components/reverse-proxy/types';
import { takeScopeRun, type ScopeRunHandover } from '@/components/reverse-proxy/scopeHandover';
import { openRun } from '@/components/runs/runs';
import SavedTargetsPanel from '@/components/reverse-proxy/SavedTargetsPanel';
import { shortVersion, validateScopeName, scopeLabel } from '@/lib/haproxy/config';
import { SkeletonCards } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { useT } from '@/lib/i18n/react';

/**
 * Die Seite „Ziele“: in welche Gruppen die Einträge zerfallen und was HAProxy
 * über sich sagt.
 *
 * Die Einträge selbst stehen je Gruppe auf einer eigenen Seite: alle Gruppen
 * untereinander auf dieser einen würden mit jedem Eintrag länger. Diese Seite
 * beantwortet die Frage davor: läuft überhaupt ein Proxy, ist acme.sh da, und
 * wo will ich hin.
 *
 * Eine frische Installation hat keine Gruppe. Dann steht hier statt der Liste
 * der Weg zur ersten, denn ohne Gruppe lässt sich kein Ziel anlegen.
 *
 * Gelesen wird bei jedem Aufruf direkt aus `/etc/haproxy/haproxy.cfg`; es gibt
 * keine Collection dahinter, siehe docs/reverse-proxy.md.
 */

export default function ReverseProxyPage() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const { t, plural, rich } = useT();

  const [proxies, setProxies] = useState<ProxyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  /** Der Dialog für eine neue Gruppe. `null` heißt: zu. */
  const [newScope, setNewScope] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');

  /**
   * Die Gruppe, die gerade entsteht.
   *
   * Sie steht als Karte mit Spinner in der Liste, sobald der Vorgang läuft —
   * wie ein neues Ziel auf der Gruppenseite. Ohne das rührte sich die Übersicht
   * nach dem Klick auf „Anlegen" bis zum nächsten 60-Sekunden-Takt nicht, und
   * das ist von „nichts passiert" nicht zu unterscheiden.
   *
   * `runIds` ist eine Liste, weil die Route eine liefert (mit genau einem
   * Lauf). Fertig ist die Gruppe, wenn KEINER der Läufe mehr läuft.
   */
  const [pendingScope, setPendingScope] = useState<ScopeRunHandover | null>(null);

  // Stille Variante, sonst blitzt bei jedem Poll-Takt der Ladebildschirm auf.
  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await apiFetch('/api/haproxy/services');
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error);
        setProxies(data.data);
        setError('');
      } catch {
        setError(t('Die Reverse-Proxy-Ziele konnten nicht geladen werden.'));
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, t]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Ein Vorgang, der auf der Gruppenseite gestartet wurde und dort keine Seite
  // mehr hat: das Entfernen. Einmal abholen, danach ist die Übergabe leer.
  useEffect(() => {
    const handed = takeScopeRun();
    if (handed) setPendingScope(handed);
  }, []);

  // Langsamer als die üblichen 30 Sekunden: jeder Takt liest die Datei und
  // fragt HAProxy, und eine haproxy.cfg ändert sich nicht im Minutentakt.
  usePolling(() => load(true), 60_000);

  /**
   * Den eigenen Vorgang verfolgen, bis er durch ist, und dann EINMAL nachladen.
   *
   * Ein eigenes Intervall statt `usePolling`: es geht nicht um einen Takt,
   * sondern um ein Ende — der Effekt räumt sich selbst ab. Erst nachladen, dann
   * melden, sonst steht die Erfolgsmeldung neben einer Liste ohne die Gruppe.
   *
   * `pendingScope` wird erst nach dem Nachladen geleert: der Effekt hängt daran,
   * und sein Aufräumen setzt `cancelled`. Vorher geleert, kam die Meldung nie.
   */
  useEffect(() => {
    if (!pendingScope) return;
    let cancelled = false;
    // Ein Takt mit Nachladen dauert länger als drei Sekunden. Der nächste
    // wartet, sonst meldete er dasselbe Ende ein zweites Mal.
    let busy = false;

    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const states = await Promise.all(
          pendingScope.runIds.map((id) =>
            apiFetch(`/api/haproxy/runs/${id}`)
              .then((r) => r.json())
              .catch(() => null)
          )
        );
        if (cancelled) return;
        // Ein Lauf, der sich nicht abfragen lässt, gilt als fertig: sonst bliebe
        // die Karte für immer stehen, weil eine Antwort ausbleibt.
        if (states.some((s) => s?.success && s.data.status === 'running')) return;

        const failed = states.filter((s) => s?.success && s.data.status !== 'success').length;
        await load(true);
        if (cancelled) return;
        // Das Ende ist behandelt: kein weiterer Takt, bis der Effekt abgeräumt ist.
        clearInterval(interval);
        setPendingScope(null);
        notify({
          variant: failed === 0 ? 'success' : 'error',
          title: t('Gruppe „{name}“', { name: scopeLabel(pendingScope.name) }),
          message:
            failed !== 0
              ? t('Der Vorgang ist fehlgeschlagen. Die Schritte stehen in den Logs.')
              : pendingScope.action === 'add'
                ? t('Die Gruppe ist angelegt.')
                : t('Die Gruppe ist entfernt.'),
        });
      } finally {
        busy = false;
      }
    };

    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pendingScope, apiFetch, load, notify, t]);

  /** Eigener Zustand statt `loading`: die Liste soll stehen bleiben, der Knopf
   *  trotzdem antworten. Die Mindestdauer verhindert ein Spinner-Flackern. */
  async function refresh() {
    setRefreshing(true);
    try {
      await Promise.all([load(true), new Promise((resolve) => setTimeout(resolve, 400))]);
    } finally {
      setRefreshing(false);
    }
  }

  /** Ein neu geöffneter Dialog beginnt ohne die Meldung des vorigen Versuchs. */
  function openNewScope() {
    setFormError('');
    setNewScope('');
  }

  /**
   * Eine Gruppe anlegen.
   *
   * Die Route startet den Lauf und antwortet mit dessen ID (als Liste `runs`).
   * Verfolgt wird er über `pendingScope`, die Pille unten rechts zeigt ihn
   * ohnehin.
   */
  async function createScope() {
    const name = (newScope ?? '').trim();
    const invalid = validateScopeName(name);
    if (invalid) {
      setFormError(t(invalid));
      return;
    }
    setCreating(true);
    setFormError('');
    try {
      const res = await apiFetch('/api/haproxy/scopes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Die Gruppe konnte nicht angelegt werden.'));

      const runIds: string[] = data.data.runs.map((r: { runId: string }) => r.runId);
      setNewScope(null);
      setPendingScope({ name, runIds, action: 'add' });
      if (runIds[0]) openRun({ kind: 'haproxy', id: runIds[0] });
    } catch (err) {
      notify({
        variant: 'error',
        title: t('Anlegen fehlgeschlagen'),
        message: errorText(err, t('HAPM hat nicht geantwortet. Bitte versuchen Sie es erneut.')),
      });
    } finally {
      setCreating(false);
    }
  }

  const total = proxies.reduce((sum, proxy) => sum + proxy.services.length, 0);
  const pages = scopePages(proxies);
  const unmanaged = unmanagedCount(proxies);
  /** Die Karte, an deren Stelle der laufende Vorgang steht. Beim Anlegen gibt
   *  es sie noch nicht — dann trägt die Platzhalter-Karte den Namen selbst. */
  const pendingPage = pendingScope
    ? pages.find((p) => p.scope.toUpperCase() === pendingScope.name.toUpperCase())
    : undefined;
  /** Null Gruppen ist nur eine Aussage, wenn die Datei gelesen wurde: nach einem
   *  Fehler ist die Liste leer, weil sie unbekannt ist. Läuft gerade ein Vorgang,
   *  steht dessen Karte in der Liste. */
  const noGroups =
    pages.length === 0 && !pendingScope && !error && proxies.every((proxy) => !proxy.error);

  return (
    <>
      <div className="page-header">
        <div>
          <h1 className="page-title">
            {t('Ziele')}
            <InfoHint text={t('Gelesen wird direkt aus der HAProxy-Konfiguration, nicht aus einer Kopie.')} />
          </h1>
          <p className="page-subtitle">{t('Welche Domain auf welches Ziel zeigt.')}</p>
        </div>
        <div className="page-actions">
          {proxies.length > 0 && (
            <button className="btn btn-secondary" onClick={openNewScope}>
              <FolderPlus size={16} />
              {t('Gruppe anlegen')}
            </button>
          )}
          {proxies.length > 0 && (
            <Link className="btn btn-secondary" href="/reverse-proxy/import">
              <FileInput size={16} />
              {t('Konfiguration importieren')}
            </Link>
          )}
          <Link className="btn btn-secondary" href="/reverse-proxy/logs">
            <ScrollText size={16} />
            {t('Logs')}
          </Link>
          <button className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            {t('Aktualisieren')}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block"><ErrorNote text={error} /></div>}

      {loading ? (
        <SkeletonCards />
      ) : proxies.length === 0 ? (
        // Nach einem Ladefehler ist die Liste leer, weil sie unbekannt ist: dann steht nur die Meldung oben.
        !error && (
          <div className="empty-state">
            <Network size={40} />
            <h3>{t('HAProxy nicht gefunden')}</h3>
            <p>
              {rich('Diese Seite liest die Konfiguration unter {path}. Ob HAProxy läuft, steht in der {overview}.', {
                path: <code>/etc/haproxy/haproxy.cfg</code>,
                overview: <Link href="/dashboard">{t('Übersicht')}</Link>,
              })}
            </p>
          </div>
        )
      ) : (
        <>
          <div className="sys-block">
            {noGroups ? (
              <div className="empty-state">
                <FolderPlus size={40} />
                <h3>{t('Noch keine Gruppe')}</h3>
                <p>
                  {t('Eine Gruppe fasst Ziele zusammen, etwa „Websites“ oder „Intern“. Jedes Ziel gehört in eine Gruppe. Legen Sie deshalb zuerst eine Gruppe an.')}
                </p>
                <button className="btn btn-primary" onClick={openNewScope}>
                  <FolderPlus size={16} />
                  {t('Gruppe anlegen')}
                </button>
              </div>
            ) : (
              <>
                <div className="section-header">
                  <h2 className="section-title">
                    {t('Gruppen')}
                    <span className="section-count">
                      {plural(total, { one: '{count} Ziel', other: '{count} Ziele' })}
                    </span>
                  </h2>
                  <span className="section-hint">{t('Die Marker-Blöcke der Konfiguration')}</span>
                </div>
                <EntityGrid>
                  {/* Die Gruppe, an der gerade gearbeitet wird: dieselbe Stelle, an
                      der sie steht oder stand, nur ohne Link und mit Spinner. Beim
                      Anlegen ist sie noch nicht in `pages`, beim Entfernen noch —
                      dort tritt sie deshalb an die Stelle der echten Karte. */}
                  {pendingScope && (pendingScope.action === 'remove' || !pendingPage) && (
                    <EntityCard
                      icon={<Loader2 size={17} className="spin" />}
                      name={pendingPage?.title ?? scopeLabel(pendingScope.name)}
                      subtitle={t('Gruppe')}
                      tone={pendingScope.action === 'remove' ? 'danger' : undefined}
                    >
                      <EntityField label={t('Status')}>
                        {pendingScope.action === 'add' ? t('Wird angelegt…') : t('Wird entfernt…')}
                      </EntityField>
                    </EntityCard>
                  )}
                  {pages.map((page) => {
                    // Beim Entfernen steht oben schon die rote Karte an ihrer Stelle.
                    if (pendingScope?.action === 'remove' && page.scope === pendingScope.name) {
                      return null;
                    }
                    /* Beide Sorten. Eine Gruppe, in der ein Port offen steht und
                       auf deren Karte „noch keiner" stünde, wäre genau die stille
                       Auskunft, gegen die `unmanagedCount` gebaut ist — und der
                       Knopf „Gruppe entfernen" richtet sich nach derselben Zahl. */
                    const services = servicesInScope(proxies, page.scope).length;
                    const streams = streamsInScope(proxies, page.scope).length;
                    const count = services + streams;
                    // Die Gruppe, über die HAPM selbst erreichbar ist. Erkannt an `publicUrl`
                    // (`surface`) und nicht am Namen, wie der Schutz in `protected.ts`.
                    const system = !!page.surface;
                    return (
                      <Link key={page.slug} href={`/reverse-proxy/${page.slug}`} className="entity-link">
                        <EntityCard
                          icon={system ? <ShieldCheck size={17} /> : <Globe size={17} />}
                          name={page.title}
                          subtitle={system ? t('Gruppe von HAPM') : t('Gruppe')}
                          tone={system ? 'system' : undefined}
                          badge={<ChevronRight size={16} className="entity-card-chevron" />}
                        >
                          <EntityField label={t('Einträge')}>
                            {count === 0
                              ? t('noch keiner')
                              : [
                                  services > 0 &&
                                    plural(services, { one: '{count} Dienst', other: '{count} Dienste' }),
                                  streams > 0 &&
                                    plural(streams, { one: '{count} TCP-Port', other: '{count} TCP-Ports' }),
                                ]
                                  .filter(Boolean)
                                  .join(', ')}
                          </EntityField>
                          {page.surface && (
                            <EntityTags>
                              <EntityTag
                                icon={<ShieldCheck size={13} />}
                                tooltip={t(
                                  'HAPM ist über ein Ziel dieser Gruppe erreichbar ({url}). Sie lässt sich nicht entfernen.',
                                  { url: page.surface.url }
                                )}
                              >
                                <span>{t('Oberfläche von HAPM')}</span>
                              </EntityTag>
                            </EntityTags>
                          )}
                        </EntityCard>
                      </Link>
                    );
                  })}
                </EntityGrid>
              </>
            )}

            {unmanaged > 0 && (
              <div className="form-note" style={{ marginTop: 12 }}>
                <Info size={14} />
                <span>
                  {plural(unmanaged, {
                    one: 'Ein Eintrag steht außerhalb der verwalteten Blöcke und gehört damit zu keiner Gruppe. Er wird hier nicht angezeigt und nicht angefasst. Wichtig ist nur, dass es ihn gibt: seine Domains sind vergeben.',
                    other: '{count} Einträge stehen außerhalb der verwalteten Blöcke und gehören damit zu keiner Gruppe. Sie werden hier nicht angezeigt und nicht angefasst. Wichtig ist nur, dass es sie gibt: ihre Domains sind vergeben.',
                  })}
                </span>
              </div>
            )}
          </div>

          {/* Zwischen Gruppen und HAProxy: Server im Backend, auf die Ziele aller Gruppen zeigen. */}
          <SavedTargetsPanel />

          <div className="sys-block">
            <div className="section-header">
              <h2 className="section-title">HAProxy</h2>
              <span className="section-hint">{t('Was die laufende Instanz über sich sagt')}</span>
            </div>
            <EntityGrid>
              {proxies.map((proxy) => (
                <EntityCard
                  key={proxy.$id}
                  icon={<Network size={17} />}
                  name={proxy.name}
                  subtitle={t('Dieser Server')}
                  badge={
                    <span
                      className={`badge-status ${proxy.error ? 'badge-danger' : 'badge-success'}`}
                      data-tooltip={proxy.version ? `HAProxy ${proxy.version}` : undefined}
                    >
                      {proxy.error
                        ? t('Fehler')
                        : proxy.version
                          ? `HAProxy ${shortVersion(proxy.version)}`
                          : 'HAProxy'}
                    </span>
                  }
                >
                  <EntityTags>
                    <EntityTag tooltip={t('Weichen in der HAProxy-Konfiguration')}>
                      <span>{plural(proxy.services.length, { one: '{count} Ziel', other: '{count} Ziele' })}</span>
                    </EntityTag>
                    {/* Nur, wenn es welche gibt: „0 TCP-Ports" auf jeder Karte
                        wäre eine Zeile, die nichts beantwortet. */}
                    {proxy.streams.length > 0 && (
                      <EntityTag tooltip={t('Durchgereichte Ports dieses Servers')}>
                        <span>
                          {plural(proxy.streams.length, { one: '{count} TCP-Port', other: '{count} TCP-Ports' })}
                        </span>
                      </EntityTag>
                    )}
                    {!proxy.error && !proxy.acmeReady && (
                      <EntityTag
                        tooltip={t(
                          'Ohne acme.sh und Zertifikatsverzeichnis lässt sich kein Ziel mit Domain anlegen. HAPM richtet beides beim Start selbst ein.'
                        )}
                        danger
                      >
                        <span>{t('acme.sh fehlt')}</span>
                      </EntityTag>
                    )}
                    {!proxy.error && (proxy.baseConfigMissing ?? 0) > 0 && (
                      <EntityTag
                        tooltip={t(
                          'In haproxy.cfg fehlen Zeilen, die HAPM heute in die Grundkonfiguration schreibt. Unter Einstellungen lassen sie sich einzeln übernehmen.'
                        )}
                      >
                        <Link href="/reverse-proxy/einstellungen?bereich=grundkonfiguration">
                          {plural(proxy.baseConfigMissing ?? 0, {
                            one: '{count} neue Vorgabe',
                            other: '{count} neue Vorgaben',
                          })}
                        </Link>
                      </EntityTag>
                    )}
                  </EntityTags>
                  {proxy.error && (
                    <EntityField label={t('Fehler')}>
                      {proxy.error}{' '}
                      {rich('Der Zustand von HAProxy steht in der {overview}.', {
                        overview: <Link href="/dashboard">{t('Übersicht')}</Link>,
                      })}
                    </EntityField>
                  )}
                </EntityCard>
              ))}
            </EntityGrid>
          </div>
        </>
      )}

      {newScope !== null && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && !creating && setNewScope(null)}
        >
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">{t('Gruppe anlegen')}</h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setNewScope(null)}
                disabled={creating}
                aria-label={t('Dialog schließen')}
              >
                <X size={18} />
              </button>
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                createScope();
              }}
            >
              <div className="modal-body">
                {formError && <div className="alert alert-danger"><ErrorNote text={formError} /></div>}

                <div className="form-group">
                  <div className="form-label-row">
                    <label className="form-label" htmlFor="newScopeName">
                      {t('Name')}
                    </label>
                    <InfoHint
                      text={t(
                        'Der Name steht im Marker der Konfiguration. Zum Umbenennen eine neue Gruppe anlegen und die alte entfernen.'
                      )}
                    />
                  </div>
                  <input
                    id="newScopeName"
                    className="form-input"
                    value={newScope}
                    onChange={(e) => setNewScope(e.target.value)}
                    placeholder="websites"
                    autoComplete="off"
                    autoFocus
                    required
                  />
                  <span className="form-hint">
                    {t('Nur a-z, 0-9, _ und -. Lässt sich danach nicht umbenennen.')}
                  </span>
                </div>

                <div className="form-note">
                  <Info size={14} />
                  <span>
                    {rich(
                      'Angelegt werden zwei Marker-Paare in der Konfiguration ({services} und dasselbe für {backends}). Bestehende Einträge werden dabei nicht angefasst.',
                      {
                        services: <code>{`# BEGIN AUTO ${(newScope || 'name').toUpperCase()} SERVICES`}</code>,
                        backends: <code>BACKENDS</code>,
                      }
                    )}
                  </span>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setNewScope(null)}
                  disabled={creating}
                >
                  {t('Abbrechen')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? <Loader2 size={16} className="spin" /> : <FolderPlus size={16} />}
                  {t('Anlegen')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
