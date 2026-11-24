'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import {
  Network, Globe, Loader2, RefreshCw, ScrollText, ChevronRight, FolderPlus, Info, X, ShieldCheck,
  FileInput,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { useToast } from '@/components/Toast';
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
import { shortVersion, validateScopeName, scopeLabel } from '@/lib/haproxy/config';
import { SkeletonCards } from '@/components/Skeleton';

/**
 * Die Übersicht des Reverse-Proxys: in welche Gruppen die Einträge zerfallen
 * und was HAProxy über sich sagt.
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
        if (data.success) setProxies(data.data);
        setError('');
      } catch {
        setError('Die Reverse-Proxy-Ziele konnten nicht geladen werden.');
      } finally {
        setLoading(false);
      }
    },
    [apiFetch]
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
   */
  useEffect(() => {
    if (!pendingScope) return;
    let cancelled = false;

    const poll = async () => {
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

      setPendingScope(null);
      const failed = states.filter((s) => s?.success && s.data.status !== 'success').length;
      const done = pendingScope.action === 'add' ? 'angelegt' : 'entfernt';
      await load(true);
      if (cancelled) return;
      notify({
        variant: failed === 0 ? 'success' : 'error',
        title: `Gruppe „${scopeLabel(pendingScope.name)}"`,
        message:
          failed === 0
            ? `Die Gruppe ist ${done}.`
            : 'Der Vorgang ist fehlgeschlagen. Die Schritte stehen in den Logs.',
      });
    };

    const interval = setInterval(poll, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pendingScope, apiFetch, load, notify]);

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
      setFormError(invalid);
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
      if (!res.ok) throw new Error(data.error || 'Die Gruppe konnte nicht angelegt werden.');

      const runIds: string[] = data.data.runs.map((r: { runId: string }) => r.runId);
      setNewScope(null);
      setPendingScope({ name, runIds, action: 'add' });
      notify({
        variant: 'info',
        title: `Gruppe „${scopeLabel(name)}" wird angelegt`,
        message: 'Prüfen, Backup, einsetzen, neu laden. Der Fortschritt steht unten rechts.',
      });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unbekannter Fehler.');
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
          <h1 className="page-title">Reverse-Proxy</h1>
          <p className="page-subtitle">
            Welche Domain auf welches Ziel zeigt. Gelesen wird direkt aus der HAProxy-Konfiguration,
            nicht aus einer Kopie.
          </p>
        </div>
        <div className="page-actions">
          {proxies.length > 0 && (
            <button className="btn btn-secondary" onClick={() => setNewScope('')}>
              <FolderPlus size={16} />
              Gruppe anlegen
            </button>
          )}
          {proxies.length > 0 && (
            <Link className="btn btn-secondary" href="/reverse-proxy/import">
              <FileInput size={16} />
              Konfiguration importieren
            </Link>
          )}
          <Link className="btn btn-secondary" href="/reverse-proxy/logs">
            <ScrollText size={16} />
            Logs
          </Link>
          <button className="btn btn-secondary" onClick={refresh} disabled={refreshing}>
            {refreshing ? <Loader2 size={16} className="spin" /> : <RefreshCw size={16} />}
            Aktualisieren
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {loading ? (
        <SkeletonCards />
      ) : proxies.length === 0 ? (
        <div className="empty-state">
          <Network size={40} />
          <h3>HAProxy nicht gefunden</h3>
          <p>
            Diese Seite liest die Konfiguration unter <code>/etc/haproxy/haproxy.cfg</code>. Ob
            HAProxy läuft, steht in der <Link href="/dashboard">Übersicht</Link>.
          </p>
        </div>
      ) : (
        <>
          <div className="sys-block">
            {noGroups ? (
              <div className="empty-state">
                <FolderPlus size={40} />
                <h3>Noch keine Gruppe</h3>
                <p>
                  Eine Gruppe fasst Ziele zusammen, etwa „Websites“ oder „Intern“. Jedes Ziel gehört
                  in eine Gruppe. Legen Sie deshalb zuerst eine Gruppe an.
                </p>
                <button className="btn btn-primary" onClick={() => setNewScope('')}>
                  <FolderPlus size={16} />
                  Gruppe anlegen
                </button>
              </div>
            ) : (
              <>
                <div className="section-header">
                  <h2 className="section-title">
                    Gruppen
                    <span className="section-count">{total} Ziele</span>
                  </h2>
                  <span className="section-hint">Die Marker-Blöcke der Konfiguration</span>
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
                      subtitle="Gruppe"
                      tone={pendingScope.action === 'remove' ? 'danger' : undefined}
                    >
                      <EntityField label="Status">
                        {pendingScope.action === 'add' ? 'Wird angelegt…' : 'Wird entfernt…'}
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
                    return (
                      <Link key={page.slug} href={`/reverse-proxy/${page.slug}`} className="entity-link">
                        <EntityCard
                          icon={<Globe size={17} />}
                          name={page.title}
                          subtitle="Gruppe"
                          badge={<ChevronRight size={16} className="entity-card-chevron" />}
                        >
                          <EntityField label="Einträge">
                            {count === 0
                              ? 'noch keiner'
                              : [
                                  services > 0 && (services === 1 ? '1 Dienst' : `${services} Dienste`),
                                  streams > 0 &&
                                    (streams === 1 ? '1 TCP-Port' : `${streams} TCP-Ports`),
                                ]
                                  .filter(Boolean)
                                  .join(', ')}
                          </EntityField>
                          {page.surface && (
                            <EntityTags>
                              <EntityTag
                                icon={<ShieldCheck size={13} />}
                                tooltip={`HAPM ist über ein Ziel dieser Gruppe erreichbar (${page.surface.url}). Sie lässt sich nicht entfernen.`}
                              >
                                <span>Oberfläche von HAPM</span>
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
                  {unmanaged === 1
                    ? 'Ein Eintrag steht außerhalb der verwalteten Blöcke'
                    : `${unmanaged} Einträge stehen außerhalb der verwalteten Blöcke`}{' '}
                  und gehört damit zu keiner Gruppe. Sie werden hier nicht angezeigt und nicht
                  angefasst. Wichtig ist nur, dass es sie gibt: ihre Domains sind vergeben.
                </span>
              </div>
            )}
          </div>

          <div className="sys-block">
            <div className="section-header">
              <h2 className="section-title">HAProxy</h2>
              <span className="section-hint">Was die laufende Instanz über sich sagt</span>
            </div>
            <EntityGrid>
              {proxies.map((proxy) => (
                <EntityCard
                  key={proxy.$id}
                  icon={<Network size={17} />}
                  name={proxy.name}
                  subtitle="Dieser Server"
                  badge={
                    <span
                      className={`badge-status ${proxy.error ? 'badge-danger' : 'badge-success'}`}
                      data-tooltip={proxy.version ? `HAProxy ${proxy.version}` : undefined}
                    >
                      {proxy.error
                        ? 'Fehler'
                        : proxy.version
                          ? `HAProxy ${shortVersion(proxy.version)}`
                          : 'HAProxy'}
                    </span>
                  }
                >
                  <EntityTags>
                    <EntityTag tooltip="Weichen in der HAProxy-Konfiguration">
                      <span>{proxy.services.length} Ziele</span>
                    </EntityTag>
                    {/* Nur, wenn es welche gibt: „0 TCP-Ports" auf jeder Karte
                        wäre eine Zeile, die nichts beantwortet. */}
                    {proxy.streams.length > 0 && (
                      <EntityTag tooltip="Durchgereichte Ports dieses Servers">
                        <span>{proxy.streams.length} TCP-Ports</span>
                      </EntityTag>
                    )}
                    {!proxy.error && !proxy.acmeReady && (
                      <EntityTag
                        tooltip="Ohne acme.sh und Zertifikatsverzeichnis lässt sich kein Ziel mit Domain anlegen. HAPM richtet beides beim Start selbst ein."
                        danger
                      >
                        <span>acme.sh fehlt</span>
                      </EntityTag>
                    )}
                  </EntityTags>
                  {proxy.error && (
                    <EntityField label="Fehler">
                      {proxy.error} Der Zustand von HAProxy steht in der{' '}
                      <Link href="/dashboard">Übersicht</Link>.
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
              <h2 className="modal-title">Gruppe anlegen</h2>
              <button
                type="button"
                className="modal-close"
                onClick={() => setNewScope(null)}
                disabled={creating}
                aria-label="Dialog schließen"
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
                {formError && <div className="alert alert-danger">{formError}</div>}

                <div className="form-group">
                  <label className="form-label">Name</label>
                  <input
                    className="form-input"
                    value={newScope}
                    onChange={(e) => setNewScope(e.target.value)}
                    placeholder="websites"
                    autoComplete="off"
                    autoFocus
                    required
                  />
                  <span className="form-hint">
                    Nur a-z, 0-9, _ und -. Der Name steht danach im Marker und lässt sich nicht
                    umbenennen: dafür gibt es Anlegen und Entfernen.
                  </span>
                </div>

                <div className="form-note">
                  <Info size={14} />
                  <span>
                    Angelegt werden zwei Marker-Paare in der Konfiguration (
                    <code>{`# BEGIN AUTO ${(newScope || 'name').toUpperCase()} SERVICES`}</code> und
                    dasselbe für <code>BACKENDS</code>). Bestehende Einträge werden dabei nicht
                    angefasst.
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
                  Abbrechen
                </button>
                <button type="submit" className="btn btn-primary" disabled={creating}>
                  {creating ? <Loader2 size={16} className="spin" /> : <FolderPlus size={16} />}
                  Anlegen
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
