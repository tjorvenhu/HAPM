'use client';

import { useEffect, useState, useCallback, type FormEvent } from 'react';
import { Globe, Plus, Loader2, Trash2, KeyRound, Info, ExternalLink } from 'lucide-react';
import PageHeading from '@/components/PageHeading';
import { useApp } from '@/components/AppShell';
import { usePolling } from '@/components/usePolling';
import { useNow } from '@/components/useNow';
import { useConfirm } from '@/components/ConfirmDialog';
import { useToast } from '@/components/Toast';
import { errorText } from '@/components/errorText';
import EntityCard, { EntityGrid, EntityField } from '@/components/EntityCard';
import ProviderName, { ProviderLogo } from '@/components/dns/ProviderName';
import { validateZoneName, normalizeDomain, type DnsProviderId } from '@/lib/dns/zones';
import { DNS_PROVIDER_INFOS, dnsProviderInfo } from '@/lib/dns/provider-info';
import { SkeletonCards } from '@/components/Skeleton';
import { InfoHint } from '@/ui/primitives/InfoHint';
import { formatRelative } from '@/lib/i18n';
import { useT } from '@/lib/i18n/react';

/**
 * Die angebundenen Domains: der Zugang zum DNS-Anbieter, nicht ihre Einträge.
 *
 * HAPM schreibt nur, was es selbst braucht (den CNAME eines Ziels, den
 * Adress-Eintrag aus dem Assistenten). Alles andere verwaltet man beim
 * Anbieter, deshalb gibt es hier keine Liste der Einträge.
 *
 * Eine Karte je Zone: ein Dutzend Domains mit wenigen Angaben, genau dafür
 * gibt es `EntityCard`. Ob der Zugang funktioniert, prüft die Route bei jedem
 * Aufruf beim Anbieter.
 */

interface ZoneRow {
  $id: string;
  provider: DnsProviderId;
  name: string;
  zoneId: string;
  status: 'ok' | 'error';
  lastCheckedAt: string | null;
  lastError: string | null;
  /** Ob die Nameserver auf den Anbieter zeigen. `null` heißt unbekannt. */
  delegated: boolean | null;
}

export default function DnsZonesPage() {
  const { apiFetch } = useApp();
  const confirm = useConfirm();
  const { notify } = useToast();
  const now = useNow(30_000);
  const { t, rich, locale } = useT();

  const [zones, setZones] = useState<ZoneRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [modalOpen, setModalOpen] = useState(false);
  /** `null`, bis jemand wählt: eine Vorgabe hier wäre ein Token beim falschen Anbieter. */
  const [provider, setProvider] = useState<DnsProviderId | null>(null);
  const [name, setName] = useState('');
  const [apiToken, setApiToken] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  /** Die Zone, deren Token gerade ausgetauscht wird. */
  const [rotating, setRotating] = useState<ZoneRow | null>(null);
  const [newToken, setNewToken] = useState('');

  const load = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoading(true);
      try {
        const res = await apiFetch('/api/dns/zones');
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error);
        setZones(data.data as ZoneRow[]);
        setError('');
      } catch {
        setError(t('Die Domains konnten nicht geladen werden.'));
      } finally {
        setLoading(false);
      }
    },
    [apiFetch, t]
  );

  useEffect(() => {
    load();
  }, [load]);

  // Eine Abfrage beim Anbieter je Zone und Takt. Deshalb 60 Sekunden und nicht
  // 30, dieselbe Rechnung wie bei der Reverse-Proxy-Übersicht.
  usePolling(() => load(true), 60_000);

  const nameError = name.trim() === '' ? null : validateZoneName(name);
  const chosen = provider ? dnsProviderInfo(provider) : null;

  function openModal() {
    setProvider(null);
    setName('');
    setApiToken('');
    setFormError('');
    setModalOpen(true);
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!chosen) return;
    const invalid = validateZoneName(name);
    if (invalid) {
      setFormError(t(invalid));
      return;
    }
    setFormError('');
    setSaving(true);
    try {
      const res = await apiFetch('/api/dns/zones', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: chosen.id, name: normalizeDomain(name), apiToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Die Domain ließ sich nicht anbinden.'));
      const added = data.data as { name: string; created: boolean; delegated: boolean | null };
      setModalOpen(false);
      setApiToken('');
      notify({
        variant: 'success',
        message: added.created
          ? t('{name} ist angebunden.', { name: added.name })
          : t('{name} war schon angebunden. Der Zugang wurde ersetzt.', { name: added.name }),
      });
      // Nur bei einem klaren Nein: `null` heißt, der Anbieter hat es noch nicht geprüft.
      if (added.delegated === false) {
        notify({
          variant: 'warning',
          title: t('Noch nicht delegiert'),
          message: t(
            'Die Nameserver von {name} zeigen nicht auf {provider}. Einträge wirken erst, wenn die Domain dorthin delegiert ist.',
            { name: added.name, provider: chosen.label }
          ),
        });
      }
      await load(true);
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Anbinden fehlgeschlagen'),
        message: errorText(err, t('Die Domain ließ sich nicht anbinden.')),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleRotate(e: FormEvent) {
    e.preventDefault();
    if (!rotating) return;
    setSaving(true);
    try {
      const res = await apiFetch(`/api/dns/zones/${rotating.$id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiToken: newToken }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || t('Der Token ließ sich nicht austauschen.'));
      notify({ variant: 'success', message: t('Der Token für {name} ist ausgetauscht.', { name: rotating.name }) });
      setRotating(null);
      setNewToken('');
      await load(true);
    } catch (err: unknown) {
      notify({
        variant: 'error',
        title: t('Speichern fehlgeschlagen'),
        message: errorText(err, t('Der Token ließ sich nicht austauschen.')),
      });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(zone: ZoneRow) {
    await confirm({
      title: t('Anbindung entfernen'),
      message: t(
        'Bei {provider} ändert sich nichts: die Zone {zone} und ihre Einträge bleiben. HAPM legt danach für Ziele unter dieser Domain keinen DNS-Eintrag mehr an. Der API-Token wird gelöscht.',
        { provider: dnsProviderInfo(zone.provider).label, zone: zone.name }
      ),
      confirmLabel: t('Entfernen'),
      variant: 'danger',
      failedTitle: t('Entfernen fehlgeschlagen'),
      onConfirm: async () => {
        const res = await apiFetch(`/api/dns/zones/${zone.$id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || t('Die Anbindung ließ sich nicht entfernen.'));
        notify({ variant: 'success', message: t('{name} ist nicht mehr angebunden.', { name: zone.name }) });
        await load(true);
      },
    });
  }

  return (
    <>
      <div className="page-header">
        <div>
          <PageHeading icon={<Globe size={20} />} title={t('Domains')} back={{ label: t('Übersicht'), href: '/reverse-proxy' }} />
          <p className="page-subtitle">
            {t(
              'Der Zugang zu Hetzner oder Cloudflare. Damit legt HAPM den DNS-Eintrag eines Ziels an, und der Einrichtungsassistent den Eintrag der Oberfläche. Die übrigen Einträge verwalten Sie beim Anbieter.'
            )}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn btn-primary" onClick={openModal}>
            <Plus size={16} />
            {t('Domain anbinden')}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger sys-block">{error}</div>}

      {/* Nach einem gescheiterten Abruf ist nicht bekannt, ob es Domains gibt:
          dann steht nur die Meldung da, nicht „Noch keine Domain angebunden“. */}
      {loading ? (
        <SkeletonCards />
      ) : zones.length === 0 && error ? null : zones.length === 0 ? (
        <div className="empty-state">
          <Globe size={40} />
          <h3>{t('Noch keine Domain angebunden')}</h3>
          <p>
            {t(
              'Dafür braucht es die Domain und einen API-Token von Hetzner oder Cloudflare, der die Einträge der Zone bearbeiten darf.'
            )}
          </p>
        </div>
      ) : (
        <EntityGrid>
          {zones.map((zone) => (
            <EntityCard
              key={zone.$id}
              icon={<Globe size={17} />}
              name={zone.name}
              badge={
                <span
                  className={`badge-status ${zone.status === 'ok' ? 'badge-success' : 'badge-danger'}`}
                >
                  {zone.status === 'ok' ? t('Verbunden') : t('Fehler')}
                </span>
              }
              actions={
                <>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    data-tooltip={t('API-Token austauschen')}
                    aria-label={t('API-Token austauschen')}
                    onClick={() => {
                      setRotating(zone);
                      setNewToken('');
                    }}
                  >
                    <KeyRound size={16} />
                  </button>
                  <button
                    className="btn btn-ghost btn-icon btn-sm"
                    data-tooltip={t('Anbindung entfernen')}
                    aria-label={t('Anbindung entfernen')}
                    onClick={() => handleDelete(zone)}
                  >
                    <Trash2 size={16} />
                  </button>
                </>
              }
            >
              <EntityField label={t('Anbieter')}>
                <ProviderName provider={zone.provider} />
              </EntityField>
              <EntityField label={t('Nameserver')}>
                {zone.delegated === null
                  ? t('Unbekannt')
                  : zone.delegated
                    ? t('Zeigen auf {provider}', { provider: dnsProviderInfo(zone.provider).label })
                    : t('Zeigen nicht auf {provider}', { provider: dnsProviderInfo(zone.provider).label })}
              </EntityField>
              <EntityField label={t('Zone-ID')} mono>
                {zone.zoneId}
              </EntityField>
              <EntityField label={t('Zuletzt geprüft')}>
                {zone.lastCheckedAt ? formatRelative(locale, now, zone.lastCheckedAt) : t('nie')}
              </EntityField>
              {zone.lastError && <EntityField label={t('Fehler')}>{zone.lastError}</EntityField>}
            </EntityCard>
          ))}
        </EntityGrid>
      )}

      {modalOpen && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && !saving && setModalOpen(false)}
        >
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">{t('Domain anbinden')}</h2>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <div className="alert alert-danger sys-block">{formError}</div>}

                <div className="form-group">
                  <span className="form-label">{t('Anbieter')}</span>
                  <div className="hapm-choices hapm-choices-row">
                    {DNS_PROVIDER_INFOS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        className={`hapm-choice${provider === option.id ? ' is-selected' : ''}`}
                        aria-pressed={provider === option.id}
                        disabled={saving}
                        onClick={() => {
                          setProvider(option.id);
                          setFormError('');
                        }}
                      >
                        <ProviderLogo provider={option.id} size={28} />
                        <span className="hapm-choice-text">
                          <strong>{option.label}</strong>
                        </span>
                      </button>
                    ))}
                  </div>
                </div>

                {chosen && (
                  <>
                    <div className="form-group">
                      <label className="form-label">{t('Domain')}</label>
                      <input
                        className="form-input"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="example.org"
                        autoComplete="off"
                        required
                      />
                      <span className="form-hint">
                        {rich('Ohne {scheme}. Angebunden wird die Zone, in der sie liegt.', {
                          scheme: <code>https://</code>,
                        })}
                      </span>
                      {nameError && <div className="alert alert-warning">{t(nameError)}</div>}
                    </div>

                    <div className="form-group">
                      <label className="form-label">
                        {t('API-Token')}
                        <InfoHint
                          text={
                            (chosen.tokenHint ? `${t(chosen.tokenHint)} ` : '') +
                            t('Er wird verschlüsselt gespeichert und verlässt den Server nicht.')
                          }
                        />
                      </label>
                      <input
                        className="form-input"
                        type="password"
                        value={apiToken}
                        onChange={(e) => setApiToken(e.target.value)}
                        autoComplete="off"
                        required
                      />
                      {chosen.consoleUrl && (
                        <span className="form-hint">
                          <a href={chosen.consoleUrl} target="_blank" rel="noreferrer">
                            {t('Token bei {provider} anlegen', { provider: chosen.label })} <ExternalLink size={12} />
                          </a>
                        </span>
                      )}
                    </div>

                    <div className="form-note">
                      <Info size={14} />
                      <span>
                        {t(
                          'Der Token wird sofort ausprobiert: die Kennung der Zone kommt aus der Antwort von {provider}. Findet er die Domain nicht, sagt die Meldung, welche Zonen er stattdessen sieht.',
                          { provider: chosen.label }
                        )}
                      </span>
                    </div>
                  </>
                )}
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
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || !chosen || !!nameError || apiToken.trim() === ''}
                >
                  {saving && <Loader2 size={16} className="spin" />}
                  {t('Anbinden')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {rotating && (
        <div
          className="modal-overlay"
          onClick={(e) => e.target === e.currentTarget && !saving && setRotating(null)}
        >
          <div className="modal">
            <div className="modal-header">
              <h2 className="modal-title">{t('API-Token für „{name}“', { name: rotating.name })}</h2>
            </div>
            <form onSubmit={handleRotate}>
              <div className="modal-body">
                <div className="form-group">
                  <label className="form-label">
                    {t('Neuer Token von {provider}', { provider: dnsProviderInfo(rotating.provider).label })}
                  </label>
                  <input
                    className="form-input"
                    type="password"
                    value={newToken}
                    onChange={(e) => setNewToken(e.target.value)}
                    autoComplete="off"
                    required
                  />
                  <span className="form-hint">
                    {t(
                      'Der bisherige Token wird ersetzt. Der neue muss dieselbe Zone sehen, sonst wird er abgelehnt, und der alte bleibt stehen.'
                    )}
                  </span>
                </div>
              </div>
              <div className="modal-footer">
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setRotating(null)}
                  disabled={saving}
                >
                  {t('Abbrechen')}
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={saving || newToken.trim() === ''}
                >
                  {saving && <Loader2 size={16} className="spin" />}
                  {t('Speichern')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
