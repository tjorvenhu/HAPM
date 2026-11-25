'use client';

import { useEffect, useState, useCallback, type FormEvent } from 'react';
import Link from 'next/link';
import {
  ArrowLeft, KeyRound, Plus, Ban, Loader2, Copy, Check, X, Globe, Link2,
} from 'lucide-react';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import EntityCard, { EntityGrid, EntityField } from '@/components/EntityCard';
import IpAllowList from '@/components/IpAllowList';
import { SkeletonCards } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import McpAccess from '@/components/reverse-proxy/McpAccess';
import { formatDate, formatRelative, msgid, type Locale } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/**
 * Der Zugang zur Reverse-Proxy-API an einer Stelle: wohin, womit, von wo — und
 * ob es ankommt. Darunter derselbe Zugang über MCP (`McpAccess`): dieselben
 * Schlüssel, ein anderer Endpunkt.
 *
 * Die Schlüssel liegen in `service_tokens` und werden nur hier verwaltet. Unter
 * `/api/internal` gibt es nur den Reverse-Proxy, ein Schlüssel gilt deshalb für
 * die ganze Schnittstelle.
 */

interface TokenRow {
  $id: string;
  $createdAt: string;
  name: string;
  prefix: string;
  description: string | null;
  createdBy: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  allowedIps: string[];
}

/** Kurzreferenz. Die vollständige Anleitung steht in docs/reverse-proxy-api.md. */
const ENDPOINTS: { method: string; path: string; what: string }[] = [
  {
    method: 'GET',
    path: '/proxies',
    what: msgid('dieser Server als Liste mit einem Eintrag: Gruppen, Admin-IPs, DNS-Hooks, acmeReady'),
  },
  { method: 'GET', path: '/services', what: msgid('Einträge, gefiltert über ?scope= ?domain=') },
  { method: 'POST', path: '/services', what: msgid('anlegen → { runId }') },
  { method: 'GET', path: '/services/<id>', what: msgid('ein Eintrag, mit editable / removable / health') },
  { method: 'PATCH', path: '/services/<id>', what: msgid('ändern, vollständiger Rumpf → { runId }') },
  { method: 'DELETE', path: '/services/<id>', what: msgid('entfernen → { runId }') },
  {
    method: 'GET',
    path: '/streams',
    what: msgid('TCP-Weiterleitungen; mit ?port= stattdessen: ist der Port frei'),
  },
  { method: 'POST', path: '/streams', what: msgid('anlegen → { runId }') },
  { method: 'GET', path: '/streams/<id>', what: msgid('eine Weiterleitung, mit editable / removable') },
  { method: 'PATCH', path: '/streams/<id>', what: msgid('ändern, vollständiger Rumpf → { runId }') },
  { method: 'DELETE', path: '/streams/<id>', what: msgid('entfernen → { runId }') },
  { method: 'GET', path: '/runs', what: msgid('Historie, gefiltert über ?serviceId= ?mine=true') },
  { method: 'GET', path: '/runs/<id>', what: msgid('Stand des Vorgangs: status, phase, steps') },
  { method: 'GET', path: '/scopes', what: msgid('Gruppen') },
  { method: 'POST', path: '/scopes', what: msgid('Gruppe anlegen → { runs }') },
  { method: 'DELETE', path: '/scopes', what: msgid('Gruppe entfernen, nur wenn sie leer ist') },
  { method: 'GET', path: '/settings', what: msgid('HTTPS-Zeilen und die Admin-Adressliste') },
  { method: 'PATCH', path: '/settings', what: msgid('der einzige Teil-Patch der API') },
  { method: 'GET', path: '/certificates', what: msgid('was acme.sh führt, samt „benutzt von“') },
];

/** Wann ein Key zuletzt benutzt wurde. Älter als ein Tag: das Datum. `null` heißt nie. */
function lastUsed(locale: Locale, iso: string | null, now: number): string | null {
  if (!iso) return null;
  if (now - new Date(iso).getTime() >= 86_400_000) return formatDate(locale, iso);
  return formatRelative(locale, now, iso);
}

export default function ReverseProxyApiPage() {
  const { apiFetch } = useApp();
  const { notify } = useToast();
  const confirm = useConfirm();
  const now = useNow(30_000);
  const { t, rich, locale } = useT();

  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  /**
   * Die Basis-URL kommt aus dem Browser und nicht aus einer Env-Variablen.
   *
   * Sie ist die Adresse, unter der diese Seite gerade läuft — also genau die,
   * unter der auch die API antwortet. Eine konfigurierte Adresse wäre die
   * zweite Quelle für dieselbe Sache und stünde falsch da, sobald jemand die
   * Domain wechselt, ohne die Variable nachzuziehen. Erst nach dem Einhängen,
   * weil es beim Rendern auf dem Server kein `window` gibt.
   */
  const [baseUrl, setBaseUrl] = useState('');
  useEffect(() => {
    setBaseUrl(`${window.location.origin}/api/internal/haproxy`);
  }, []);

  const [copied, setCopied] = useState<string | null>(null);

  /** Die Adresse von HAPM aus den Einstellungen, für den MCP-Endpunkt. */
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/settings')
      .then((res) => res.json())
      .then((body) => {
        if (!cancelled && body.success) setPublicUrl(body.data.publicUrl ?? null);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setSettingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [apiFetch]);

  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [newIps, setNewIps] = useState<string[]>(['']);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  /** Das Token, dessen Adressliste gerade bearbeitet wird. */
  const [editing, setEditing] = useState<TokenRow | null>(null);
  const [editIps, setEditIps] = useState<string[]>(['']);

  /** Der Klartext, genau einmal. Nach dem Schließen ist er unwiederbringlich weg. */
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await apiFetch('/api/settings/service-tokens');
        const data = await res.json();
        if (data.success) setTokens(data.data as TokenRow[]);
        setError('');
      } catch {
        setError(t('Die Schlüssel konnten nicht geladen werden.'));
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, t]
  );

  useEffect(() => {
    load();
  }, [load]);

  usePolling(() => load(true), 30_000);

  async function copy(text: string, key: string) {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied((current) => (current === key ? null : current)), 1500);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError('');
    setSaving(true);
    try {
      const res = await apiFetch('/api/settings/service-tokens', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, description, allowedIps: newIps }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Anlegen fehlgeschlagen'));
      setModalOpen(false);
      setIssued({ name: data.data.name, token: data.data.token });
      setName('');
      setDescription('');
      setNewIps(['']);
      await load(true);
    } catch (err: unknown) {
      setFormError(err instanceof Error ? err.message : t('Anlegen fehlgeschlagen'));
    } finally {
      setSaving(false);
    }
  }

  async function saveIps() {
    if (!editing) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/settings/service-tokens/${editing.$id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowedIps: editIps }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Speichern fehlgeschlagen'));
      setEditing(null);
      // Erst nachladen, dann melden: sonst steht „gespeichert" neben einer
      // Karte, die noch die alte Liste zeigt.
      await load(true);
      notify({ message: t('Die Adressliste gilt ab dem nächsten Aufruf.'), variant: 'success' });
    } catch (err: unknown) {
      notify({
        title: t('Speichern fehlgeschlagen'),
        message: err instanceof Error ? err.message : t('Unbekannter Fehler.'),
        variant: 'error',
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleRevoke(token: TokenRow) {
    await confirm({
      title: t('Schlüssel zurückziehen'),
      message: t(
        '"{name}" gilt danach sofort nicht mehr. Ein Dienst, der ihn benutzt, bekommt ab dem nächsten Aufruf 401. Das betrifft auch Skripte, die gerade laufen. Der Eintrag bleibt bestehen, damit das Aktivitätsprotokoll auflösbar bleibt.',
        { name: token.name }
      ),
      confirmLabel: t('Zurückziehen'),
      variant: 'danger',
      onConfirm: async () => {
        const res = await apiFetch(`/api/settings/service-tokens/${token.$id}`, {
          method: 'DELETE',
        });
        const data = await res.json();
        if (!res.ok) {
          notify({ message: data.error || t('Zurückziehen fehlgeschlagen'), variant: 'error' });
          throw new Error(data.error);
        }
        await load(true);
        notify({ message: t('"{name}" gilt nicht mehr.', { name: token.name }), variant: 'success' });
      },
    });
  }

  const active = tokens.filter((token) => !token.revokedAt);

  return (
    <>
      <div className="page-header">
        <div>
          <Link
            href="/reverse-proxy"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8125rem' }}
          >
            <ArrowLeft size={14} />
            {t('Reverse-Proxy')}
          </Link>
          <h1 className="page-title">{t('API und MCP')}</h1>
          <p className="page-subtitle">
            {rich(
              'Womit ein anderer Dienst oder ein KI-Assistent Domains und Ziele in HAProxy anlegt, ändert und entfernt. Die Anleitungen stehen in {api} und {mcp}.',
              { api: <code>docs/reverse-proxy-api.md</code>, mcp: <code>docs/mcp.md</code> }
            )}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={() => setModalOpen(true)}>
            <Plus size={16} />
            {t('API-Key anlegen')}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      <div className="card sys-block">
        <div className="form-section-head">
          <span className="form-section-icon">
            <Link2 size={17} />
          </span>
          <div>
            <div className="form-section-title">{t('Zugang')}</div>
            <div className="form-section-sub">
              {rich(
                'Die Basis-URL ist die Adresse, unter der HAPM erreichbar ist. Der Parameter {param} ist überall freiwillig: ohne ihn gilt dieser Server.',
                { param: <code>serverId</code> }
              )}
            </div>
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">
            {t('Basis-URL')}
            <InfoHint
              text={t(
                'Jeder Endpunkt der Tabelle unten hängt daran. Kein CSRF-Token: der schützt einen Browser mit Cookie, und hier gibt es weder das eine noch das andere.'
              )}
            />
          </label>
          <div className="form-list-row">
            <input
              className="form-input"
              value={baseUrl}
              readOnly
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="btn btn-secondary btn-icon"
              data-tooltip={t('Kopieren')}
              disabled={!baseUrl}
              onClick={() => copy(baseUrl, 'base')}
            >
              {copied === 'base' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
        </div>

        <div className="form-group">
          <label className="form-label">{t('Kopfzeile')}</label>
          <div className="form-list-row">
            <input
              className="form-input"
              value="Authorization: Bearer hapm_…"
              readOnly
              onFocus={(e) => e.target.select()}
            />
            <button
              type="button"
              className="btn btn-secondary btn-icon"
              data-tooltip={t('Kopieren')}
              onClick={() => copy('Authorization: Bearer ', 'header')}
            >
              {copied === 'header' ? <Check size={16} /> : <Copy size={16} />}
            </button>
          </div>
          <span className="form-hint">
            {rich(
              'Ersatzweise {header}, falls ein Proxy dazwischen den Authorization-Header für sich beansprucht.',
              { header: <code>X-Service-Token: hapm_…</code> }
            )}
          </span>
        </div>
      </div>

      <McpAccess publicUrl={publicUrl} loading={settingsLoading} />

      <h2 className="section-title">
        {t('API-Keys')}
      </h2>

      {loading ? (
        <SkeletonCards />
      ) : active.length === 0 ? (
        <div className="empty-state">
          <KeyRound size={40} />
          <h3>{t('Noch kein Key')}</h3>
          <p>
            {t(
              'Solange keiner existiert, erreicht kein anderer Dienst die Reverse-Proxy-API. Ein Deploy-Skript braucht einen, um Ziele anzulegen.'
            )}
          </p>
        </div>
      ) : (
        <EntityGrid>
          {active.map((token) => (
            <EntityCard
              key={token.$id}
              icon={<KeyRound size={17} />}
              name={token.name}
              subtitle={token.description || undefined}
              badge={<span className="badge-status badge-success">{t('Aktiv')}</span>}
              actions={
                <>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    data-tooltip={t('Erlaubte Adressen')}
                    onClick={() => {
                      setEditing(token);
                      setEditIps(token.allowedIps.length > 0 ? [...token.allowedIps] : ['']);
                    }}
                  >
                    <Globe size={16} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    data-tooltip={t('Zurückziehen')}
                    onClick={() => handleRevoke(token)}
                  >
                    <Ban size={16} />
                  </button>
                </>
              }
            >
              <EntityField label={t('Key')} mono>{`${token.prefix}…`}</EntityField>
              <EntityField label={t('Adressen')}>
                {token.allowedIps.length > 0 ? token.allowedIps.join(', ') : t('von überall')}
              </EntityField>
              <EntityField label={t('Zuletzt benutzt')}>
                {lastUsed(locale, token.lastUsedAt, now) ?? t('nie')}
                {token.lastUsedIp ? ` · ${token.lastUsedIp}` : ''}
              </EntityField>
            </EntityCard>
          ))}
        </EntityGrid>
      )}

      <h2 className="section-title">
        {t('Endpunkte')}
      </h2>
      <p className="page-subtitle sys-block">
        {rich(
          'Schreibende Aufrufe antworten mit einer Lauf-ID, nicht mit dem Ergebnis: DNS, Zertifikat und Reload dauern Minuten. Der Aufrufer pollt {path}, bis {status} nicht mehr {running} ist.',
          { path: <code>/runs/&lt;id&gt;</code>, status: <code>status</code>, running: <code>running</code> }
        )}
      </p>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('Methode')}</th>
              <th>{t('Pfad')}</th>
              <th>{t('Was er tut')}</th>
            </tr>
          </thead>
          <tbody>
            {ENDPOINTS.map((endpoint) => (
              <tr key={`${endpoint.method} ${endpoint.path}`}>
                <td style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
                  <code>{endpoint.method}</code>
                </td>
                <td style={{ fontSize: '0.8125rem', whiteSpace: 'nowrap' }}>
                  <code>{endpoint.path}</code>
                </td>
                <td style={{ fontSize: '0.8125rem' }}>{t(endpoint.what)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modalOpen && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && !saving && setModalOpen(false)}
        >
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">{t('API-Key anlegen')}</h2>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <div className="alert alert-danger sys-block">{formError}</div>}
                <div className="form-group">
                  <label className="form-label">
                    {t('Name')}
                    <InfoHint
                      text={t(
                        'Steht so im Aktivitätsprotokoll und in der Liste der Vorgänge oben. Der Name des Dienstes, nicht der des Menschen.'
                      )}
                    />
                  </label>
                  <input
                    className="form-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t('deploy-skript')}
                    autoComplete="off"
                    required
                  />
                </div>
                <div className="form-group">
                  <label className="form-label">{t('Notiz')}</label>
                  <input
                    className="form-input"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t('Optional: wofür wird er benutzt?')}
                  />
                </div>
                <IpAllowList value={newIps} onChange={setNewIps} disabled={saving} />
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setModalOpen(false)}
                  disabled={saving}
                >
                  {t('Abbrechen')}
                </button>
                <button type="submit" className="btn btn-primary" disabled={saving}>
                  {saving && <Loader2 size={16} className="spin" />}
                  {t('Anlegen')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {editing && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && !saving && setEditing(null)}
        >
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">{t('Adressen für „{name}“', { name: editing.name })}</h2>
            </div>
            <div className="modal-body">
              <IpAllowList value={editIps} onChange={setEditIps} disabled={saving} />
              <span className="form-hint">
                {t(
                  'Wirkt sofort. Der Key bleibt derselbe, er muss also nirgends neu eingetragen werden. Verglichen wird gegen die Adresse, die bei HAPM ankommt. Steht sie nicht auf der Liste, antwortet der Aufruf mit 403 und nennt sie.'
                )}
              </span>
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setEditing(null)}
                disabled={saving}
              >
                {t('Abbrechen')}
              </button>
              <button type="button" className="btn btn-primary" onClick={saveIps} disabled={saving}>
                {saving && <Loader2 size={16} className="spin" />}
                {t('Speichern')}
              </button>
            </div>
          </div>
        </div>
      )}

      {issued && (
        // Kein Klick-daneben-zum-Schließen: der Klartext existiert genau einmal,
        // und ein versehentlicher Klick neben das Fenster wäre unwiederbringlich.
        <div className="modal-overlay">
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">{t('Key für „{name}“', { name: issued.name })}</h2>
            </div>
            <div className="modal-body">
              <div className="alert alert-warning sys-block">
                {t(
                  'Jetzt kopieren. Gespeichert wird nur ein Hash. Nach dem Schließen ist der Klartext weg, und es bleibt nur, einen neuen Key auszustellen.'
                )}
              </div>
              <div className="form-group">
                <label className="form-label">{t('Key')}</label>
                <div className="form-list-row">
                  <input
                    className="form-input"
                    value={issued.token}
                    readOnly
                    onFocus={(e) => e.target.select()}
                  />
                  <button
                    type="button"
                    className="btn btn-secondary btn-icon"
                    data-tooltip={t('Kopieren')}
                    onClick={() => copy(issued.token, 'issued')}
                  >
                    {copied === 'issued' ? <Check size={16} /> : <Copy size={16} />}
                  </button>
                </div>
                <span className="form-hint">
                  {rich('Im aufrufenden Dienst als {header} mitschicken.', {
                    header: <code>Authorization: Bearer …</code>,
                  })}
                </span>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn btn-primary" onClick={() => setIssued(null)}>
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
